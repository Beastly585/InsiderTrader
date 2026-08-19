// src/lib/scoring.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure business logic extracted from app.jsx specifically so it's testable in
// isolation — no React, no DOM, no Clerk/Stripe imports. app.jsx imports these
// same functions rather than defining them inline; this file is the single
// source of truth for both the running app and the test suite.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Pro plan check ───────────────────────────────────────────────────────────
// plan and hasDataExport are written into Clerk publicMetadata by the Stripe
// webhook in neon-proxy.js — Neon is the real source of truth, this is just
// a fast client-side read of what the webhook already confirmed server-side.
export function isPro(user) {
  if (!user) return false;
  return user.publicMetadata?.plan === 'pro';
}
export function hasDataExport(user) {
  if (!user) return false;
  return user.publicMetadata?.hasDataExport === true;
}

// ─── Risk appetite thresholds ─────────────────────────────────────────────────
// 1 = very conservative (hardest to earn green) … 5 = very aggressive (easiest).
// 3 is neutral and matches the original hardcoded thresholds (66/33) exactly.
export const RISK_APPETITE_THRESHOLDS = {
  1: { high: 85, medium: 55 },
  2: { high: 75, medium: 45 },
  3: { high: 66, medium: 33 },
  4: { high: 55, medium: 22 },
  5: { high: 40, medium: 15 },
};
export const RISK_APPETITE_LABELS = {
  1: 'Very conservative', 2: 'Conservative', 3: 'Balanced', 4: 'Aggressive', 5: 'Very aggressive',
};

export function tierFromPct(pct, appetite) {
  const t = RISK_APPETITE_THRESHOLDS[appetite] || RISK_APPETITE_THRESHOLDS[3];
  return pct>t.high ? 'high' : pct>t.medium ? 'medium' : 'low';
}

// ─── Signal building ──────────────────────────────────────────────────────────
// Conviction formula grounded in empirical insider-trading research:
//
//   Cohen, Malloy & Pomorski (2012) — opportunistic vs routine trades
//   Lakonishok & Lee (2001) — buys predict returns, sells don't; clusters matter
//   Seyhun (1986) — purchases informative, sells are diversification noise
//   Ravina & Sapienza (2010) — executive purchases earn abnormal returns
//
export function buildSignals(filings) {
  const map = {};
  for (const f of filings) {
    if (!f.ticker) continue;
    if (!f.isOpenMarket) continue;
    const isPol = !!(f.transactionCode&&f.transactionCode.startsWith('CONGRESS'));
    if (!map[f.ticker]) map[f.ticker] = {
      ticker:f.ticker, company:f.company, sector:f.sector, isPolitical:isPol,
      buys:0, sells:0, buyValue:0, sellValue:0,
      cSuiteBuys:0, cSuiteSells:0, politicalBuys:0, politicalSells:0,
      opportunisticBuys:0, maxPositionSwing:0,
      buyInsiders:new Set(), sellInsiders:new Set(),
      lastTradeDate:'', trades:[],
    };
    const s = map[f.ticker];
    const tx = f.transactionDate||f.date||'';
    if (tx>s.lastTradeDate) s.lastTradeDate=tx;
    s.trades.push(f);
    if (f.transactionType==='buy') {
      s.buys++; s.buyValue+=f.value||0;
      s.buyInsiders.add(f.insiderName);
      if (f.relationship==='strong') s.cSuiteBuys++;
      if (isPol) s.politicalBuys++;
      if (f.isRoutine === false) s.opportunisticBuys++;
      if (f.pctOwnedChange!=null && f.pctOwnedChange>s.maxPositionSwing) {
        s.maxPositionSwing = f.pctOwnedChange;
      }
    } else if (f.transactionType==='sell') {
      s.sells++; s.sellValue+=f.value||0;
      s.sellInsiders.add(f.insiderName);
      if (f.relationship==='strong') s.cSuiteSells++;
      if (isPol) s.politicalSells++;
    }
  }
  const results = [];
  for (const s of Object.values(map)) {
    const buyCluster = s.buyInsiders.size >= 4 ? 3 : s.buyInsiders.size >= 2 ? 1 : 0;
    const swingBonus = s.maxPositionSwing>=50 ? 4 : s.maxPositionSwing>=20 ? 2 : s.maxPositionSwing>=10 ? 1 : 0;

    // ── Buy signal (existing logic, unchanged)
    if (s.buys > 0) {
      results.push({
        ...s,
        direction: 'buy',
        insiders: s.buyInsiders,
        insiderCount: s.buyInsiders.size,
        netValue: s.buyValue - s.sellValue,
        conviction:
          (s.opportunisticBuys * 5) +
          (s.cSuiteBuys * 2) +
          (s.politicalBuys * 4) +
          s.buys +
          Math.min(Math.log10(s.buyValue+1), 5) +
          swingBonus +
          buyCluster,
      });
    }

    // ── Sell signal — requires CLUSTER sells (2+ distinct insiders, not
    // just multiple moves by one person). Conviction scaled down vs buys
    // per Seyhun (1986): individual sells are mostly diversification noise,
    // but coordinated selling by multiple insiders is informative.
    const hasSellSignal = s.sellInsiders.size >= 2;
    if (s.sells > 0 && hasSellSignal) {
      const sellClusterBonus = s.sellInsiders.size >= 4 ? 3 : s.sellInsiders.size >= 3 ? 2 : 1;
      results.push({
        ...s,
        direction: 'sell',
        insiders: s.sellInsiders,
        insiderCount: s.sellInsiders.size,
        // netValue = buyValue - sellValue → negative for net-selling tickers,
        // so the display naturally shows red with a minus sign.
        netValue: s.buyValue - s.sellValue,
        conviction:
          (s.cSuiteSells * 2) +
          (s.politicalSells * 3) +
          sellClusterBonus * 2 +
          Math.min(Math.log10(s.sellValue+1), 4),
      });
    }
  }
  return results;
}

// ─── Full signal pipeline: date/source/sector filter → build → quality gate
// → strength threshold ───────────────────────────────────────────────────────
// Previously lived inline inside InsightsPage's own useMemo, untested. This
// is the exact chain responsible for the congressional-signals investigation
// this session — extracting it means a future regression here shows up as a
// failing test immediately, rather than requiring a live console trace to
// even locate which stage is silently dropping rows.
//
// options:
//   cutoff             — inclusive date-string floor, e.g. '2026-01-01'
//   sourceF            — '' | 'corporate' | 'political', matches the UI filter
//   sectorF            — '' | a specific sector string
//   strengthThreshold  — minimum conviction to survive
export function filterAndScoreSignals(filings, { cutoff = '', sourceF = '', sectorF = '', strengthThreshold = 0 } = {}) {
  const base = filings.filter(f => {
    const tx = f.transactionDate || f.date || '';
    if (tx < cutoff) return false;
    const isPol = !!(f.transactionCode && f.transactionCode.startsWith('CONGRESS'));
    if (sourceF === 'corporate' && isPol) return false;
    if (sourceF === 'political' && !isPol) return false;
    if (sectorF && f.sector !== sectorF) return false;
    return true;
  });
  const built = buildSignals(base);
  const afterGate = built.filter(s => {
    if (s.direction === 'sell') {
      // Sell signals already passed a quality bar in buildSignals (cluster/c-suite/political).
      // Only additional gate: require meaningful dollar volume.
      return s.sellValue >= 50_000;
    }
    // Buy signal gates (unchanged)
    return s.opportunisticBuys>=1 || s.cSuiteBuys>=1 || s.insiderCount>=2 || s.netValue>=100_000 || s.isPolitical;
  });
  const afterStrength = afterGate.filter(s => s.conviction >= strengthThreshold);
  return afterStrength;
}

// ─── Leaderboard row processing ───────────────────────────────────────────────
export function processLeaderboardRows(rows) {
  return rows.map(r=>{
    // Require a real sample before showing a hit rate at all — with only 1-2
    // priced trades, a single win or loss swings the percentage by 50-100
    // points. That's not a meaningful track record, it's noise dressed up as
    // a precise-looking number. An entity can still appear on the
    // leaderboard based on overall trade volume; it just won't show a hit
    // rate until there's actually enough priced data to trust one.
    const hitRate = r.priced>=5 ? Math.round((r.wins/r.priced)*100) : null;
    const avgReturn = r.avg_return_pct!=null ? Math.round(r.avg_return_pct*10)/10 : null;
    // Same treatment as avgReturn above — the multiplication forces a real
    // number even if Postgres/Neon's HTTP interface sent this as a string
    // (which it does for numeric/AVG results). avg_return_pct already went
    // through this coercion; avg_spy_return_pct was passing through the
    // spread below unprocessed, which is exactly what crashed in
    // production — a string has no .toFixed(), and the display code called
    // it directly on the raw field instead of this processed one.
    const avgSpyReturn = r.avg_spy_return_pct!=null ? Math.round(r.avg_spy_return_pct*10)/10 : null;
    const omTotal = (r.om_buys||0)+(r.om_sells||0);
    const omDiscipline = r.total_buys>0 ? (r.om_buys/r.total_buys) : 0;
    // Same scoring shape as trustScore() but using query-computable proxies.
    // hitRate alone only measures how OFTEN someone's right — two insiders
    // with identical hit rates can have very different track records if one
    // wins by a little each time and the other wins by a lot. avgReturn adds
    // that magnitude dimension, expectancy-style, on top of frequency.
    let s=0;
    // Previously: an entity with no priced trades at all got +0.5 — MORE
    // than a known, real hit rate below 50% (which got 0). That rewarded
    // being unproven over being proven-but-mediocre, backwards from what
    // this score should mean. Not enough data now means neutral (0), same
    // as a known-poor record — no thumb on the scale either way.
    if (hitRate!=null){if(hitRate>=70)s+=2;else if(hitRate>=50)s+=1;}
    if (avgReturn!=null){
      if (avgReturn>=30)s+=1.5;
      else if (avgReturn>=15)s+=1;
      else if (avgReturn>=5)s+=0.5;
      else if (avgReturn<0)s-=0.5; // a negative average should cost points, not just fail to add any
    }
    // Who's trading matters as much as their track record — a large 10%-owner
    // fund with big dollar volume isn't the same as a true C-suite executive
    // with genuine operational insider knowledge, but the volume-based terms
    // below can't tell them apart on their own. This is the same principle
    // already stated on the About page and used in buildSignals' own
    // cSuiteBuys weighting — applied here too, not just described elsewhere.
    if (r.relationship==='strong') s+=1.5;
    else if (r.relationship==='medium') s+=0.75;
    if (omTotal>=10)s+=1;else if(omTotal>=5)s+=0.5;
    if (omDiscipline>=0.7)s+=0.5;
    const proxyScore = Math.max(0,Math.min(Math.round(s*10)/10,5)); // raised cap to make room for the new magnitude term
    return {...r, hit_rate:hitRate, avg_return:avgReturn, avg_spy_return:avgSpyReturn, om_total:omTotal, proxy_score:proxyScore};
  }).sort((a,b)=>(b.proxy_score-a.proxy_score)||(b.wins-a.wins));
}
