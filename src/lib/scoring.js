// src/lib/scoring.js
// ─────────────────────────────────────────────────────────────────────────────
// v2 — Signal conviction rescaled to 0–100 with diminishing returns.
//
// The old formula was an unbounded additive sum displayed against a max of 15.
// Anything interesting (cluster buys, C-suite, high value) blew past 15 easily,
// making the conviction bar useless — everything looked identical at full green.
//
// This version:
//   • Scores each dimension independently (0–1 normalized)
//   • Weights them by empirical importance
//   • Compresses the total through 100*(1 - e^(-x/k)) so early signal matters,
//     but piling on more of the same gives diminishing returns
//   • Adds timing velocity, contra-signal penalty, recency decay, and optional
//     insider track-record feedback — none of which existed before
//
// Research basis (unchanged):
//   Cohen, Malloy & Pomorski (2012) — opportunistic vs routine
//   Lakonishok & Lee (2001) — clusters, buys > sells
//   Seyhun (1986) — purchases informative, sells noise
//   Ravina & Sapienza (2010) — exec purchases earn abnormal returns
//   Jeng, Metrick & Zeckhauser (2003) — value-weighted insider portfolios
// ─────────────────────────────────────────────────────────────────────────────

// ─── Pro plan check (unchanged) ──────────────────────────────────────────────
export function isPro(user) {
  if (!user) return false;
  return user.publicMetadata?.plan === 'pro';
}
export function hasDataExport(user) {
  if (!user) return false;
  return user.publicMetadata?.hasDataExport === true;
}

// ─── Risk appetite (unchanged) ───────────────────────────────────────────────
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
  return pct > t.high ? 'high' : pct > t.medium ? 'medium' : 'low';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Soft-cap: maps 0→0, ∞→1, with `k` controlling the steepness.
// At x=k the output is ~0.63; at x=2k it's ~0.86; at x=3k it's ~0.95.
const softcap = (x, k) => 1 - Math.exp(-x / k);

// Days between two date strings (positive = a is more recent)
function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a), db = new Date(b);
  if (isNaN(da) || isNaN(db)) return null;
  return (da - db) / 86400000;
}

// Days from a date string to right now
function daysAgo(d) {
  if (!d) return Infinity;
  const dt = new Date(d);
  if (isNaN(dt)) return Infinity;
  return (Date.now() - dt) / 86400000;
}

// ─── Signal building ─────────────────────────────────────────────────────────
//
// Options (all optional):
//   insiderStats  — Map<insiderName, { hitRate, avgReturn }> from leaderboard
//                   data. When provided, insider track records feed into
//                   conviction. When absent, that dimension is simply zero.
//
export function buildSignals(filings, { insiderStats = null } = {}) {
  const map = {};

  for (const f of filings) {
    if (!f.ticker) continue;
    if (!f.isOpenMarket) continue;

    const isPol = !!(f.transactionCode && f.transactionCode.startsWith('CONGRESS'));

    if (!map[f.ticker]) map[f.ticker] = {
      ticker: f.ticker, company: f.company, sector: f.sector, isPolitical: isPol,
      buys: 0, sells: 0, buyValue: 0, sellValue: 0,
      cSuiteBuys: 0, cSuiteSells: 0, politicalBuys: 0, politicalSells: 0,
      opportunisticBuys: 0, maxPositionSwing: 0,
      buyInsiders: new Set(), sellInsiders: new Set(),
      firstTradeDate: '', lastTradeDate: '', trades: [],
      // v2 additions
      insiderHitRates: [],       // hit rates of buying insiders (when available)
    };

    const s = map[f.ticker];
    const tx = f.transactionDate || f.date || '';
    if (tx > s.lastTradeDate || !s.lastTradeDate) s.lastTradeDate = tx;
    if (tx < s.firstTradeDate || !s.firstTradeDate) s.firstTradeDate = tx;
    s.trades.push(f);

    if (f.transactionType === 'buy') {
      s.buys++; s.buyValue += f.value || 0;
      s.buyInsiders.add(f.insiderName);
      if (f.relationship === 'strong') s.cSuiteBuys++;
      if (isPol) s.politicalBuys++;
      if (f.isRoutine === false) s.opportunisticBuys++;
      if (f.pctOwnedChange != null && f.pctOwnedChange > s.maxPositionSwing) {
        s.maxPositionSwing = f.pctOwnedChange;
      }
      // Collect insider track record if available
      if (insiderStats && f.insiderName && insiderStats.has(f.insiderName)) {
        const st = insiderStats.get(f.insiderName);
        if (st.hitRate != null) s.insiderHitRates.push(st.hitRate);
      }
    } else if (f.transactionType === 'sell') {
      s.sells++; s.sellValue += f.value || 0;
      s.sellInsiders.add(f.insiderName);
      if (f.relationship === 'strong') s.cSuiteSells++;
      if (isPol) s.politicalSells++;
    }
  }

  const results = [];

  for (const s of Object.values(map)) {

    // ── Shared dimension scores (each 0–1) ───────────────────────────────

    // 1. Cluster: how many distinct insiders are acting together?
    //    1 insider = 0. 2 = ~0.39. 4 = ~0.63. 8+ saturates toward 1.
    const buyCluster  = softcap(Math.max(0, s.buyInsiders.size - 1), 5);
    const sellCluster = softcap(Math.max(0, s.sellInsiders.size - 1), 5);

    // 2. Value: dollar volume, log-scaled and soft-capped.
    //    $10K = ~0.18. $100K = ~0.33. $1M = ~0.59. $10M = ~0.82.
    const buyValueScore  = softcap(Math.log10(s.buyValue + 1), 8);
    const sellValueScore = softcap(Math.log10(s.sellValue + 1), 8);

    // 3. C-suite involvement: at least one exec trade = meaningful.
    //    1 exec = ~0.63. 2+ saturates. 0 = 0.
    const cSuiteBuyScore  = softcap(s.cSuiteBuys, 1);
    const cSuiteSellScore = softcap(s.cSuiteSells, 1);

    // 4. Opportunistic (non-routine): the single strongest predictor.
    //    Cohen et al. found ~0% abnormal returns for routine trades.
    //    1 = ~0.39. 3 = ~0.78. 5+ saturates.
    const opportunisticScore = softcap(s.opportunisticBuys, 3);

    // 5. Position swing: how much of their own holdings are they betting?
    //    10% = ~0.33. 25% = ~0.63. 50% = ~0.86.
    const swingScore = softcap(s.maxPositionSwing, 25);

    // 6. Political: congressional trades get a flat bonus (informational
    //    advantage is structural, not volume-dependent).
    const politicalBuyScore  = s.politicalBuys > 0 ? 1 : 0;
    const politicalSellScore = s.politicalSells > 0 ? 1 : 0;

    // 7. Velocity: trades concentrated in a short burst vs spread out.
    //    5 trades in 2 days is more notable than 5 trades over 80 days.
    //    Expressed as trades-per-day, soft-capped.
    const spanDays = Math.max(1, daysBetween(s.lastTradeDate, s.firstTradeDate) || 1);
    const buyVelocity = softcap((s.buys / spanDays), 2);
    const sellVelocity = softcap((s.sells / spanDays), 2);

    // 8. Insider track record (when leaderboard stats are available):
    //    Average hit rate of the buying insiders. 50% = neutral (0.5 raw),
    //    but we shift so that <50% subtracts and >50% adds.
    //    A cluster where every insider has 80% hit rate → strong bonus.
    //    Unknown insiders contribute 0 (neutral), not a penalty.
    let insiderAccuracyScore = 0;
    if (s.insiderHitRates.length > 0) {
      const avgHitRate = s.insiderHitRates.reduce((a, b) => a + b, 0) / s.insiderHitRates.length;
      // Shift: 50% → 0, 75% → 0.5, 100% → 1, 25% → -0.5
      insiderAccuracyScore = (avgHitRate - 50) / 50;
    }

    // 9. Recency: how fresh is the last trade?
    //    Today = 1.0. 7 days ago = ~0.5. 30 days = ~0.14. 90 days = ~0.01.
    //    Exponential decay with 10-day half-life.
    const recency = Math.exp(-0.069 * daysAgo(s.lastTradeDate)); // ln(2)/10 ≈ 0.069

    // 10. Contra-signal penalty: if insiders are split on direction,
    //     the signal is weaker. Ratio of opposing value to same-direction value.
    //     All buys, no sells → penalty = 0. Equal buys and sells → penalty ≈ 0.5.
    const buyContraPenalty  = s.sellValue > 0 ? Math.min(s.sellValue / (s.buyValue + 1), 1) * 0.4 : 0;
    const sellContraPenalty = s.buyValue > 0 ? Math.min(s.buyValue / (s.sellValue + 1), 1) * 0.4 : 0;


    // ── Buy conviction ───────────────────────────────────────────────────
    if (s.buys > 0) {
      // Weighted sum of dimensions. Weights reflect empirical importance
      // from the literature and practical value to retail traders.
      const raw =
        (opportunisticScore   * 25) +  // strongest predictor (Cohen et al.)
        (buyCluster           * 18) +  // cluster buying (Lakonishok & Lee)
        (cSuiteBuyScore       * 15) +  // exec involvement (Ravina & Sapienza)
        (swingScore           * 12) +  // skin in the game
        (buyValueScore        * 10) +  // dollar magnitude
        (buyVelocity          *  8) +  // timing concentration
        (politicalBuyScore    *  8) +  // structural info advantage
        (insiderAccuracyScore *  6) +  // track record (can go negative)
        (recency              *  5);   // freshness

      // Compress through diminishing-returns curve → 0–100
      // k=40 means: raw=40 → ~63, raw=80 → ~86, raw=120 → ~95
      const compressed = 100 * softcap(Math.max(0, raw), 50);

      // Apply contra-signal penalty (reduces by up to 40% if sells offset buys)
      const conviction = Math.round(compressed * (1 - buyContraPenalty));

      results.push({
        ...s,
        direction: 'buy',
        insiders: s.buyInsiders,
        insiderCount: s.buyInsiders.size,
        netValue: s.buyValue - s.sellValue,
        conviction,
        // Expose raw components for the detail panel breakdown
        _components: {
          opportunistic: Math.round(opportunisticScore * 100),
          cluster: Math.round(buyCluster * 100),
          cSuite: Math.round(cSuiteBuyScore * 100),
          positionSwing: Math.round(swingScore * 100),
          value: Math.round(buyValueScore * 100),
          velocity: Math.round(buyVelocity * 100),
          political: Math.round(politicalBuyScore * 100),
          insiderAccuracy: Math.round(insiderAccuracyScore * 100),
          recency: Math.round(recency * 100),
          contraPenalty: Math.round(buyContraPenalty * 100),
        },
      });
    }

    // ── Sell conviction ──────────────────────────────────────────────────
    // Still requires cluster sells (2+ distinct insiders). Individual sells
    // are diversification noise (Seyhun 1986).
    if (s.sells > 0 && s.sellInsiders.size >= 2) {
      const raw =
        (sellCluster           * 22) +
        (cSuiteSellScore       * 18) +
        (sellValueScore        * 12) +
        (sellVelocity          * 10) +
        (politicalSellScore    * 10) +
        (recency               *  5);

      const compressed = 100 * softcap(Math.max(0, raw), 45);
      const conviction = Math.round(compressed * (1 - sellContraPenalty));

      results.push({
        ...s,
        direction: 'sell',
        insiders: s.sellInsiders,
        insiderCount: s.sellInsiders.size,
        netValue: s.buyValue - s.sellValue,
        conviction,
        _components: {
          cluster: Math.round(sellCluster * 100),
          cSuite: Math.round(cSuiteSellScore * 100),
          value: Math.round(sellValueScore * 100),
          velocity: Math.round(sellVelocity * 100),
          political: Math.round(politicalSellScore * 100),
          recency: Math.round(recency * 100),
          contraPenalty: Math.round(sellContraPenalty * 100),
        },
      });
    }
  }

  return results;
}


// ─── Full signal pipeline ────────────────────────────────────────────────────
export function filterAndScoreSignals(filings, { cutoff = '', sourceF = '', sectorF = '', strengthThreshold = 0, insiderStats = null } = {}) {
  const base = filings.filter(f => {
    const tx = f.transactionDate || f.date || '';
    if (tx < cutoff) return false;
    const isPol = !!(f.transactionCode && f.transactionCode.startsWith('CONGRESS'));
    if (sourceF === 'corporate' && isPol) return false;
    if (sourceF === 'political' && !isPol) return false;
    if (sectorF && f.sector !== sectorF) return false;
    return true;
  });

  const built = buildSignals(base, { insiderStats });

  const afterGate = built.filter(s => {
    if (s.direction === 'sell') {
      return s.sellValue >= 50_000;
    }
    return s.opportunisticBuys >= 1 || s.cSuiteBuys >= 1 || s.insiderCount >= 2 || s.netValue >= 100_000 || s.isPolitical;
  });

  const afterStrength = afterGate.filter(s => s.conviction >= strengthThreshold);
  return afterStrength;
}


// ─── Leaderboard row processing ──────────────────────────────────────────────
//
// v2: proxy_score replaced with a continuous 0–5 score based on:
//   • Expectancy (hit_rate × avg_win magnitude, penalized by losses)
//   • Alpha over SPY (not raw return)
//   • Role weight (exec > officer > director)
//   • Sample size confidence (more trades = more reliable)
//
export function processLeaderboardRows(rows) {
  return rows.map(r => {
    // ── Hit rate: require 10+ priced trades for a meaningful number ────
    const hitRate = r.priced >= 10 ? Math.round((r.wins / r.priced) * 100)
                  : r.priced >= 5  ? Math.round((r.wins / r.priced) * 100)
                  : null;
    // Flag for lower confidence (5-9 trades vs 10+)
    const hitRateConfident = r.priced >= 10;

    const avgReturn    = r.avg_return_pct != null ? Math.round(r.avg_return_pct * 10) / 10 : null;
    const avgSpyReturn = r.avg_spy_return_pct != null ? Math.round(r.avg_spy_return_pct * 10) / 10 : null;
    const omTotal      = (r.om_buys || 0) + (r.om_sells || 0);
    const omDiscipline = r.total_buys > 0 ? (r.om_buys / r.total_buys) : 0;

    // ── Alpha: insider return minus market return ─────────────────────
    // This is the actual value-add. +15% when SPY did +20% is -5% alpha.
    const alpha = (avgReturn != null && avgSpyReturn != null)
      ? Math.round((avgReturn - avgSpyReturn) * 10) / 10
      : null;

    // ── Composite score: 0–5 ─────────────────────────────────────────
    let s = 0;

    // Dimension 1: Hit rate (but only meaningful above coin-flip)
    // 50% = 0 (coin flip). 60% = +0.5. 70% = +1.0. 80%+ = +1.5.
    // Below 50% = negative (actively bad signal).
    if (hitRate != null) {
      const hrScore = (hitRate - 50) / 20; // 50→0, 70→1, 90→2
      s += Math.max(-1, Math.min(1.5, hrScore));
      // Discount if low sample
      if (!hitRateConfident) s *= 0.7;
    }

    // Dimension 2: Alpha over SPY (the real question: did they beat the market?)
    // Positive alpha is valuable. Negative alpha means you'd have been
    // better off buying SPY.
    if (alpha != null) {
      if (alpha >= 20) s += 1.5;
      else if (alpha >= 10) s += 1.0;
      else if (alpha >= 5) s += 0.5;
      else if (alpha >= 0) s += 0.2;
      else if (alpha < -5) s -= 0.5;
    }

    // Dimension 3: Role — execs have genuine operational knowledge,
    // 10% owners and fund directors less so
    if (r.relationship === 'strong') s += 1.0;
    else if (r.relationship === 'medium') s += 0.5;

    // Dimension 4: Volume and discipline — are they an active, disciplined
    // open-market trader, or do they occasionally dump restricted shares?
    const volumeScore = softcap(omTotal, 15) * 0.8; // max ~0.8
    const disciplineBonus = omDiscipline >= 0.7 ? 0.3 : 0;
    s += volumeScore + disciplineBonus;

    const proxyScore = Math.max(0, Math.min(Math.round(s * 10) / 10, 5));

    return {
      ...r,
      hit_rate: hitRate,
      hit_rate_confident: hitRateConfident,
      avg_return: avgReturn,
      avg_spy_return: avgSpyReturn,
      alpha,
      om_total: omTotal,
      proxy_score: proxyScore,
    };
  }).sort((a, b) => (b.proxy_score - a.proxy_score) || (b.alpha ?? -999) - (a.alpha ?? -999));
}
