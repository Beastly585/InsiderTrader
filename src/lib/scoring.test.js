// src/lib/scoring.test.js
// Drop-in for your Vitest suite: npx vitest run src/lib/scoring.test.js
import { describe, it, expect } from 'vitest';
import { buildSignals, filterAndScoreSignals, processLeaderboardRows } from './scoring.js';

// ── Helpers ──────────────────────────────────────────────────────────────────
const today = new Date().toISOString().split('T')[0];
const daysAgoDate = (n) => {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
};

function makeFiling(overrides = {}) {
  return {
    ticker: 'TEST', company: 'Test Inc.', sector: 'Technology',
    insiderName: 'Doe John', title: 'Director', isOfficer: false,
    transactionType: 'buy', transactionCode: 'P', isOpenMarket: true,
    shares: 1000, price: 50, value: 50000,
    transactionDate: today, date: today,
    pctOwnedChange: 5, relationship: 'weak', isRoutine: false,
    ...overrides,
  };
}

// ── buildSignals: conviction is 0–100 ────────────────────────────────────────

describe('buildSignals v2 — conviction scale', () => {
  it('produces conviction in the 0–100 range, never exceeding 100', () => {
    // Volume monster: many trades, many insiders, huge value
    const filings = [];
    for (let i = 0; i < 40; i++) {
      filings.push(makeFiling({
        insiderName: `Insider ${i % 8}`,
        relationship: i < 3 ? 'strong' : 'weak',
        value: 1_000_000,
        transactionDate: daysAgoDate(Math.floor(i / 5)),
      }));
    }
    const signals = buildSignals(filings);
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      expect(s.conviction).toBeGreaterThanOrEqual(0);
      expect(s.conviction).toBeLessThanOrEqual(100);
    }
  });

  it('scores a weak routine director buy low (under 30)', () => {
    const filings = [makeFiling({ isRoutine: true, value: 25000, pctOwnedChange: 2 })];
    const [signal] = buildSignals(filings);
    expect(signal.conviction).toBeLessThan(30);
  });

  it('scores a C-suite opportunistic cluster buy high (above 55)', () => {
    const filings = [
      makeFiling({ insiderName: 'CEO', relationship: 'strong', value: 500000, pctOwnedChange: 30 }),
      makeFiling({ insiderName: 'CFO', relationship: 'strong', value: 300000, pctOwnedChange: 20 }),
      makeFiling({ insiderName: 'VP Sales', relationship: 'medium', value: 200000, pctOwnedChange: 15 }),
    ];
    const [signal] = buildSignals(filings);
    expect(signal.conviction).toBeGreaterThan(55);
  });
});

describe('buildSignals v2 — contra-signal penalty', () => {
  it('penalizes conviction when insiders are split (buys + sells)', () => {
    const buyOnly = [
      makeFiling({ insiderName: 'A', value: 500000 }),
      makeFiling({ insiderName: 'B', value: 300000 }),
    ];
    const mixed = [
      ...buyOnly,
      makeFiling({ insiderName: 'C', transactionType: 'sell', transactionCode: 'S', value: 400000 }),
      makeFiling({ insiderName: 'D', transactionType: 'sell', transactionCode: 'S', value: 300000 }),
    ];
    const [buySignal] = buildSignals(buyOnly).filter(s => s.direction === 'buy');
    const [mixedSignal] = buildSignals(mixed).filter(s => s.direction === 'buy');
    expect(mixedSignal.conviction).toBeLessThan(buySignal.conviction);
  });
});

describe('buildSignals v2 — recency decay', () => {
  it('scores a recent signal higher than an identical stale one', () => {
    const fresh = [makeFiling({ insiderName: 'A', transactionDate: daysAgoDate(1) })];
    const stale = [makeFiling({ insiderName: 'A', transactionDate: daysAgoDate(60) })];

    const [freshSig] = buildSignals(fresh);
    const [staleSig] = buildSignals(stale);
    expect(freshSig.conviction).toBeGreaterThan(staleSig.conviction);
  });
});

describe('buildSignals v2 — velocity', () => {
  it('scores concentrated trades higher than spread-out ones', () => {
    // 3 trades in 1 day
    const burst = [
      makeFiling({ insiderName: 'A', transactionDate: today }),
      makeFiling({ insiderName: 'B', transactionDate: today }),
      makeFiling({ insiderName: 'C', transactionDate: today }),
    ];
    // Same 3 trades spread over 30 days
    const slow = [
      makeFiling({ insiderName: 'A', transactionDate: daysAgoDate(0) }),
      makeFiling({ insiderName: 'B', transactionDate: daysAgoDate(15) }),
      makeFiling({ insiderName: 'C', transactionDate: daysAgoDate(30) }),
    ];
    const [burstSig] = buildSignals(burst);
    const [slowSig] = buildSignals(slow);
    expect(burstSig.conviction).toBeGreaterThan(slowSig.conviction);
  });
});

describe('buildSignals v2 — insider track record', () => {
  it('boosts conviction when buying insiders have high hit rates', () => {
    const filings = [
      makeFiling({ insiderName: 'Good Insider', relationship: 'strong', value: 500000 }),
    ];
    const withStats = buildSignals(filings, {
      insiderStats: new Map([['Good Insider', { hitRate: 85 }]]),
    });
    const without = buildSignals(filings);

    const [boosted] = withStats;
    const [baseline] = without;
    expect(boosted.conviction).toBeGreaterThan(baseline.conviction);
  });
});

describe('buildSignals v2 — _components breakdown', () => {
  it('exposes a _components object with per-dimension scores', () => {
    const filings = [makeFiling({ relationship: 'strong', value: 500000, pctOwnedChange: 25 })];
    const [signal] = buildSignals(filings);
    expect(signal._components).toBeDefined();
    expect(signal._components).toHaveProperty('opportunistic');
    expect(signal._components).toHaveProperty('cluster');
    expect(signal._components).toHaveProperty('cSuite');
    expect(signal._components).toHaveProperty('recency');
    expect(signal._components).toHaveProperty('contraPenalty');
  });
});

// ── filterAndScoreSignals ────────────────────────────────────────────────────

describe('filterAndScoreSignals — strength thresholds on 0-100 scale', () => {
  it('filters out signals below the threshold', () => {
    const filings = [
      makeFiling({ ticker: 'STRONG', insiderName: 'CEO', relationship: 'strong', value: 1_000_000, pctOwnedChange: 40 }),
      makeFiling({ ticker: 'STRONG', insiderName: 'CFO', relationship: 'strong', value: 500_000, pctOwnedChange: 20 }),
      makeFiling({ ticker: 'WEAK', insiderName: 'Dir', value: 20_000, isRoutine: true, pctOwnedChange: 1 }),
    ];
    const all = filterAndScoreSignals(filings, { strengthThreshold: 0 });
    const strong = filterAndScoreSignals(filings, { strengthThreshold: 50 });
    expect(all.length).toBeGreaterThanOrEqual(strong.length);
    for (const s of strong) {
      expect(s.conviction).toBeGreaterThanOrEqual(50);
    }
  });
});

// ── processLeaderboardRows — alpha and confidence ────────────────────────────

describe('processLeaderboardRows v2', () => {
  it('computes alpha as insider return minus SPY return', () => {
    const [row] = processLeaderboardRows([{
      priced: 20, wins: 14, avg_return_pct: 18.5, avg_spy_return_pct: 8.2,
      om_buys: 15, om_sells: 2, total_buys: 20, relationship: 'strong',
    }]);
    expect(row.alpha).toBeCloseTo(10.3, 0);
    expect(row.hit_rate).toBe(70);
    expect(row.hit_rate_confident).toBe(true);
  });

  it('marks hit rate as low-confidence with 5-9 priced trades', () => {
    const [row] = processLeaderboardRows([{
      priced: 7, wins: 5, avg_return_pct: 12, avg_spy_return_pct: 5,
      om_buys: 5, om_sells: 1, total_buys: 7, relationship: 'medium',
    }]);
    expect(row.hit_rate).toBe(71);
    expect(row.hit_rate_confident).toBe(false);
  });

  it('sorts by proxy_score descending, then alpha descending', () => {
    const rows = processLeaderboardRows([
      { priced: 20, wins: 16, avg_return_pct: 25, avg_spy_return_pct: 8, om_buys: 15, om_sells: 3, total_buys: 18, relationship: 'strong' },
      { priced: 20, wins: 16, avg_return_pct: 25, avg_spy_return_pct: 8, om_buys: 15, om_sells: 3, total_buys: 18, relationship: 'medium' },
    ]);
    // Same hit rate and return, but first has 'strong' relationship — higher score
    expect(rows[0].relationship).toBe('strong');
  });
});
