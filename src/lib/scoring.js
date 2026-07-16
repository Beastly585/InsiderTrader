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
export function buildSignals(filings) {
  const map = {};
  for (const f of filings) {
    if (!f.ticker) continue;
    // Structural fix: only genuine open-market personal-funds transactions
    // (SEC codes P/S, or congressional trades which are always open-market)
    // count toward a signal at all. This used to be the caller's job to
    // pre-filter before calling buildSignals — three call sites forgot to,
    // meaning grants, option exercises, gifts, and tax withholding could
    // silently inflate conviction identically to a real cash purchase.
    // Filtering here instead means no future caller can reintroduce that gap.
    if (!f.isOpenMarket) continue;
    const isPol = !!(f.transactionCode&&f.transactionCode.startsWith('CONGRESS'));
    if (!map[f.ticker]) map[f.ticker] = {
      ticker:f.ticker, company:f.company, sector:f.sector, isPolitical:isPol,
      buys:0, sells:0, buyValue:0, sellValue:0, cSuiteBuys:0, politicalBuys:0, maxPositionSwing:0,
      insiders:new Set(), lastTradeDate:'', trades:[],
    };
    const s = map[f.ticker];
    s.insiders.add(f.insiderName);
    const tx = f.transactionDate||f.date||'';
    if (tx>s.lastTradeDate) s.lastTradeDate=tx;
    s.trades.push(f);
    if (f.transactionType==='buy') {
      s.buys++; s.buyValue+=f.value||0;
      if (f.relationship==='strong') s.cSuiteBuys++;
      // A member of Congress buying carries its own kind of informational
      // edge — access to policy and regulatory information ahead of the
      // public — analogous to, not weaker than, a corporate executive's
      // operational knowledge. Without this, congressional-only signals
      // were structurally locked out of the cSuiteBuys term entirely
      // (relationship is never 'strong' for a member of Congress), capping
      // their conviction at buys-minus-sells plus a small log term — easily
      // pushed to zero or negative by any modest sell imbalance, even with
      // real dollar volume behind the activity.
      if (isPol) s.politicalBuys++;
      // Missing pct_owned_change (e.g. an insider's first-ever disclosed
      // holding, with no prior position to measure a % change from) is
      // treated as neutral — no bonus, not a penalty defaulting to 0-looks-bad.
      if (f.pctOwnedChange!=null && f.pctOwnedChange>s.maxPositionSwing) {
        s.maxPositionSwing = f.pctOwnedChange;
      }
    } else if (f.transactionType==='sell') {
      s.sells++; s.sellValue+=f.value||0;
    }
  }
  return Object.values(map).map(s => {
    // A single move that represents a large fraction of the insider's
    // existing stake is a materially stronger signal than the same dollar
    // amount as a routine top-up on a huge existing position — tiered
    // rather than continuous to keep it legible and avoid one enormous
    // outlier swing dominating the whole score.
    const swingBonus = s.maxPositionSwing>=50 ? 4 : s.maxPositionSwing>=20 ? 2 : s.maxPositionSwing>=10 ? 1 : 0;
    return {
      ...s, insiderCount:s.insiders.size,
      netValue: s.buyValue-s.sellValue,
      conviction: (s.cSuiteBuys*5)+(s.politicalBuys*5)+(s.buys-s.sells)+Math.min(Math.log10(s.buyValue+1),5)+swingBonus,
    };
  });
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
    return {...r, hit_rate:hitRate, avg_return:avgReturn, om_total:omTotal, proxy_score:proxyScore};
  }).sort((a,b)=>(b.proxy_score-a.proxy_score)||(b.wins-a.wins));
}
