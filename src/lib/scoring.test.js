// src/lib/scoring.test.js
import { describe, it, expect } from 'vitest';
import {
  isPro, hasDataExport, buildSignals, tierFromPct,
  RISK_APPETITE_THRESHOLDS, processLeaderboardRows,
} from './scoring.js';

// ─────────────────────────────────────────────────────────────────────────────
describe('isPro / hasDataExport', () => {
  it('returns false for no user', () => {
    expect(isPro(null)).toBe(false);
    expect(isPro(undefined)).toBe(false);
    expect(hasDataExport(null)).toBe(false);
  });

  it('returns false when publicMetadata is missing entirely', () => {
    expect(isPro({})).toBe(false);
  });

  it('returns false for any plan value other than exactly "pro"', () => {
    expect(isPro({ publicMetadata: { plan: 'free' } })).toBe(false);
    expect(isPro({ publicMetadata: { plan: 'Pro' } })).toBe(false); // case-sensitive on purpose
    expect(isPro({ publicMetadata: { plan: '' } })).toBe(false);
  });

  it('returns true only for exactly plan: "pro"', () => {
    expect(isPro({ publicMetadata: { plan: 'pro' } })).toBe(true);
  });

  it('hasDataExport requires strictly boolean true, not truthy', () => {
    expect(hasDataExport({ publicMetadata: { hasDataExport: 'true' } })).toBe(false);
    expect(hasDataExport({ publicMetadata: { hasDataExport: 1 } })).toBe(false);
    expect(hasDataExport({ publicMetadata: { hasDataExport: true } })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildSignals — open-market filtering (regression test for tonight\'s bug)', () => {
  it('excludes grants/awards entirely, even when transactionType is "buy"', () => {
    // This is the exact failure mode found and fixed tonight: a stock grant
    // has transactionType 'buy' (per the ingestion fallback mapping) but
    // isOpenMarket false — it must never count toward conviction.
    const filings = [
      { ticker:'AAPL', company:'Apple', insiderName:'Jane CEO', relationship:'strong',
        transactionType:'buy', isOpenMarket:false, value:5_000_000, transactionDate:'2026-01-01' },
    ];
    const signals = buildSignals(filings);
    expect(signals).toHaveLength(0); // nothing qualifies — the only filing was non-open-market
  });

  it('counts genuine open-market buys correctly', () => {
    const filings = [
      { ticker:'AAPL', company:'Apple', insiderName:'Jane CEO', relationship:'strong',
        transactionType:'buy', isOpenMarket:true, value:1_000_000, transactionDate:'2026-01-01' },
    ];
    const signals = buildSignals(filings);
    expect(signals).toHaveLength(1);
    expect(signals[0].buys).toBe(1);
    expect(signals[0].buyValue).toBe(1_000_000);
    expect(signals[0].cSuiteBuys).toBe(1);
  });

  it('a mix of open-market and non-open-market filings only counts the open-market ones', () => {
    const filings = [
      { ticker:'AAPL', insiderName:'A', relationship:'strong', transactionType:'buy',
        isOpenMarket:true,  value:500_000, transactionDate:'2026-01-01' },
      { ticker:'AAPL', insiderName:'A', relationship:'strong', transactionType:'buy',
        isOpenMarket:false, value:9_000_000, transactionDate:'2026-01-02' }, // grant — must be excluded
    ];
    const signals = buildSignals(filings);
    expect(signals[0].buys).toBe(1);
    expect(signals[0].buyValue).toBe(500_000); // NOT 9.5M — the grant must not leak in
  });

  it('congressional trades count even though relationship is not "strong"', () => {
    const filings = [
      { ticker:'AAPL', insiderName:'Rep. Someone', relationship:'strong', transactionCode:'CONGRESS_P',
        transactionType:'buy', isOpenMarket:true, value:250_000, transactionDate:'2026-01-01' },
    ];
    const signals = buildSignals(filings);
    expect(signals).toHaveLength(1);
    expect(signals[0].isPolitical).toBe(true);
  });
});

describe('buildSignals — position swing bonus tiers', () => {
  function signalWithSwing(pctOwnedChange) {
    const filings = [
      { ticker:'AAPL', insiderName:'A', relationship:'weak', transactionType:'buy',
        isOpenMarket:true, value:100_000, transactionDate:'2026-01-01', pctOwnedChange },
    ];
    return buildSignals(filings)[0];
  }

  it('no bonus below 10%', () => {
    const base = signalWithSwing(5);
    const noSwing = signalWithSwing(null);
    expect(base.conviction).toBeCloseTo(noSwing.conviction, 5);
  });

  it('missing pct_owned_change is neutral, not penalized', () => {
    const s = signalWithSwing(null);
    expect(s.maxPositionSwing).toBe(0);
  });

  it('10-19% swing adds a modest bonus', () => {
    const withSwing = signalWithSwing(15);
    const without = signalWithSwing(5);
    expect(withSwing.conviction).toBeGreaterThan(without.conviction);
    expect(withSwing.conviction - without.conviction).toBeCloseTo(1, 5);
  });

  it('20-49% swing adds a bigger bonus than 10-19%', () => {
    const mid = signalWithSwing(25);
    const low = signalWithSwing(15);
    expect(mid.conviction - low.conviction).toBeCloseTo(1, 5); // 2 - 1
  });

  it('50%+ swing gets the maximum bonus', () => {
    const huge = signalWithSwing(75);
    const mid = signalWithSwing(25);
    expect(huge.conviction - mid.conviction).toBeCloseTo(2, 5); // 4 - 2
  });

  it('the largest qualifying swing wins when an insider has multiple buys', () => {
    const filings = [
      { ticker:'AAPL', insiderName:'A', relationship:'weak', transactionType:'buy',
        isOpenMarket:true, value:100_000, transactionDate:'2026-01-01', pctOwnedChange:8 },
      { ticker:'AAPL', insiderName:'A', relationship:'weak', transactionType:'buy',
        isOpenMarket:true, value:100_000, transactionDate:'2026-01-02', pctOwnedChange:60 },
    ];
    const s = buildSignals(filings)[0];
    expect(s.maxPositionSwing).toBe(60);
  });
});

describe('buildSignals — basic aggregation', () => {
  it('nets buys and sells correctly into netValue', () => {
    const filings = [
      { ticker:'AAPL', insiderName:'A', relationship:'weak', transactionType:'buy',
        isOpenMarket:true, value:300_000, transactionDate:'2026-01-01' },
      { ticker:'AAPL', insiderName:'B', relationship:'weak', transactionType:'sell',
        isOpenMarket:true, value:100_000, transactionDate:'2026-01-02' },
    ];
    const s = buildSignals(filings)[0];
    expect(s.netValue).toBe(200_000);
    expect(s.insiderCount).toBe(2);
  });

  it('groups by ticker independently', () => {
    const filings = [
      { ticker:'AAPL', insiderName:'A', relationship:'weak', transactionType:'buy', isOpenMarket:true, value:100_000, transactionDate:'2026-01-01' },
      { ticker:'MSFT', insiderName:'B', relationship:'weak', transactionType:'buy', isOpenMarket:true, value:200_000, transactionDate:'2026-01-01' },
    ];
    const signals = buildSignals(filings);
    expect(signals).toHaveLength(2);
    expect(signals.find(s=>s.ticker==='AAPL').buyValue).toBe(100_000);
    expect(signals.find(s=>s.ticker==='MSFT').buyValue).toBe(200_000);
  });

  it('filings with no ticker are silently skipped, not crashed on', () => {
    const filings = [
      { ticker:null, insiderName:'A', relationship:'weak', transactionType:'buy', isOpenMarket:true, value:100_000 },
    ];
    expect(() => buildSignals(filings)).not.toThrow();
    expect(buildSignals(filings)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('tierFromPct — appetite thresholds', () => {
  it('appetite 3 (default) matches the original hardcoded 66/33 thresholds exactly', () => {
    // Critical regression test: appetite 3 must behave identically to the
    // app's behavior before the slider existed, so nobody's current
    // experience silently changes unless they actually move the slider.
    expect(tierFromPct(67, 3)).toBe('high');
    expect(tierFromPct(66, 3)).toBe('medium');
    expect(tierFromPct(34, 3)).toBe('medium');
    expect(tierFromPct(33, 3)).toBe('low');
  });

  it('appetite 1 (very conservative) requires a much higher score for "high"', () => {
    expect(tierFromPct(70, 1)).toBe('medium'); // would be "high" at appetite 3
    expect(tierFromPct(86, 1)).toBe('high');
  });

  it('appetite 5 (very aggressive) reaches "high" much more easily', () => {
    expect(tierFromPct(41, 5)).toBe('high'); // would be "low"/"medium" at appetite 3
  });

  it('conservative appetites are strictly harder to reach "high" than aggressive ones, at every level', () => {
    for (let pct = 0; pct <= 100; pct += 5) {
      const tiers = [1,2,3,4,5].map(a => tierFromPct(pct, a));
      const rank = { low:0, medium:1, high:2 };
      for (let i=1; i<tiers.length; i++) {
        expect(rank[tiers[i]]).toBeGreaterThanOrEqual(rank[tiers[i-1]]);
      }
    }
  });

  it('an unrecognized appetite value falls back to the default (3) thresholds', () => {
    expect(tierFromPct(50, 99)).toBe(tierFromPct(50, 3));
    expect(tierFromPct(50, undefined)).toBe(tierFromPct(50, 3));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('processLeaderboardRows', () => {
  it('computes hit_rate as a percentage, rounded', () => {
    const rows = [{ insider_name:'A', wins:7, priced:10, om_buys:5, om_sells:0, total_buys:5, avg_return_pct:12.3 }];
    const [r] = processLeaderboardRows(rows);
    expect(r.hit_rate).toBe(70);
  });

  it('hit_rate is null when there is no priced data, not zero', () => {
    const rows = [{ insider_name:'A', wins:0, priced:0, om_buys:1, om_sells:0, total_buys:1, avg_return_pct:null }];
    const [r] = processLeaderboardRows(rows);
    expect(r.hit_rate).toBeNull();
  });

  it('hit_rate is null with too few priced trades, even a perfect or 50/50 record — a 1-2 trade sample is noise, not a track record', () => {
    const onePriced = processLeaderboardRows([{ insider_name:'A', wins:1, priced:1, om_buys:5, om_sells:0, total_buys:5, avg_return_pct:20 }])[0];
    const twoPriced = processLeaderboardRows([{ insider_name:'B', wins:1, priced:2, om_buys:5, om_sells:0, total_buys:5, avg_return_pct:0 }])[0];
    expect(onePriced.hit_rate).toBeNull();
    expect(twoPriced.hit_rate).toBeNull();
  });

  it('hit_rate is shown once there are enough priced trades to mean something', () => {
    const r = processLeaderboardRows([{ insider_name:'A', wins:4, priced:5, om_buys:5, om_sells:0, total_buys:5, avg_return_pct:10 }])[0];
    expect(r.hit_rate).toBe(80);
  });

  it('no longer rewards an unproven track record over a known-mediocre one — both should score the same from this component', () => {
    const unproven = processLeaderboardRows([{ insider_name:'A', wins:0, priced:0, om_buys:5, om_sells:0, total_buys:5, avg_return_pct:0 }])[0];
    const knownMediocre = processLeaderboardRows([{ insider_name:'B', wins:2, priced:5, om_buys:5, om_sells:0, total_buys:5, avg_return_pct:0 }])[0];
    // knownMediocre has a real (if unremarkable, <50%) hit rate; unproven has
    // none at all. Unproven should NOT outscore a known real record just for
    // lacking data — that was the actual bug.
    expect(unproven.proxy_score).toBeLessThanOrEqual(knownMediocre.proxy_score);
  });

  it('weighs relationship tier — a C-suite executive should outrank a director/10%-owner with an identical trading record otherwise', () => {
    const base = { wins:5, priced:10, om_buys:10, om_sells:0, total_buys:10, avg_return_pct:10 };
    const strong = processLeaderboardRows([{ ...base, insider_name:'CEO', relationship:'strong' }])[0];
    const weak   = processLeaderboardRows([{ ...base, insider_name:'TenPctOwner', relationship:'weak' }])[0];
    expect(strong.proxy_score).toBeGreaterThan(weak.proxy_score);
  });

  it('a strongly negative average return costs points rather than just failing to help', () => {
    const good = processLeaderboardRows([{ insider_name:'A', wins:5, priced:10, om_buys:10, om_sells:0, total_buys:10, avg_return_pct:0 }])[0];
    const bad  = processLeaderboardRows([{ insider_name:'B', wins:5, priced:10, om_buys:10, om_sells:0, total_buys:10, avg_return_pct:-15 }])[0];
    expect(bad.proxy_score).toBeLessThan(good.proxy_score);
  });

  it('proxy_score never exceeds the cap of 5', () => {
    const rows = [{ insider_name:'A', wins:20, priced:20, om_buys:50, om_sells:0, total_buys:50, avg_return_pct:200 }];
    const [r] = processLeaderboardRows(rows);
    expect(r.proxy_score).toBeLessThanOrEqual(5);
  });

  it('sorts by proxy_score descending, breaking ties by win count', () => {
    const rows = [
      { insider_name:'Low',  wins:1, priced:5, om_buys:5, om_sells:0, total_buys:5, avg_return_pct:0 },
      { insider_name:'High', wins:9, priced:10, om_buys:10, om_sells:0, total_buys:10, avg_return_pct:40 },
    ];
    const sorted = processLeaderboardRows(rows);
    expect(sorted[0].insider_name).toBe('High');
  });
});
