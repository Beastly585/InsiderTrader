// src/lib/scoring.test.js
import { describe, it, expect } from 'vitest';
import { buildSignals, filterAndScoreSignals, processLeaderboardRows } from './scoring.js';

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

// ── Signal conviction (0–100) ────────────────────────────────────────────────

describe('buildSignals — conviction 0–100 scale', () => {
  it('never exceeds 100 even with extreme volume', () => {
    const filings = Array.from({length:40}, (_,i) => makeFiling({
      insiderName: `Insider ${i%8}`, relationship: i<3?'strong':'weak',
      value: 1_000_000, transactionDate: daysAgoDate(Math.floor(i/5)),
    }));
    for (const s of buildSignals(filings)) {
      expect(s.conviction).toBeGreaterThanOrEqual(0);
      expect(s.conviction).toBeLessThanOrEqual(100);
    }
  });

  it('scores a weak routine director buy under 30', () => {
    const [s] = buildSignals([makeFiling({isRoutine:true, value:25000, pctOwnedChange:2})]);
    expect(s.conviction).toBeLessThan(30);
  });

  it('scores a C-suite cluster buy above 55', () => {
    const [s] = buildSignals([
      makeFiling({insiderName:'CEO', relationship:'strong', value:500000, pctOwnedChange:30}),
      makeFiling({insiderName:'CFO', relationship:'strong', value:300000, pctOwnedChange:20}),
      makeFiling({insiderName:'VP',  relationship:'medium', value:200000, pctOwnedChange:15}),
    ]);
    expect(s.conviction).toBeGreaterThan(55);
  });

  it('penalizes mixed buy/sell activity', () => {
    const buyOnly = [makeFiling({insiderName:'A',value:500000}), makeFiling({insiderName:'B',value:300000})];
    const mixed = [...buyOnly,
      makeFiling({insiderName:'C',transactionType:'sell',transactionCode:'S',value:400000}),
      makeFiling({insiderName:'D',transactionType:'sell',transactionCode:'S',value:300000}),
    ];
    const [b] = buildSignals(buyOnly).filter(s=>s.direction==='buy');
    const [m] = buildSignals(mixed).filter(s=>s.direction==='buy');
    expect(m.conviction).toBeLessThan(b.conviction);
  });

  it('scores recent signals higher than stale ones', () => {
    const [fresh] = buildSignals([makeFiling({transactionDate:daysAgoDate(1)})]);
    const [stale] = buildSignals([makeFiling({transactionDate:daysAgoDate(60)})]);
    expect(fresh.conviction).toBeGreaterThan(stale.conviction);
  });

  it('rewards concentrated bursts over spread-out trades', () => {
    const burst = [makeFiling({insiderName:'A'}), makeFiling({insiderName:'B'}), makeFiling({insiderName:'C'})];
    const slow = [
      makeFiling({insiderName:'A',transactionDate:daysAgoDate(0)}),
      makeFiling({insiderName:'B',transactionDate:daysAgoDate(15)}),
      makeFiling({insiderName:'C',transactionDate:daysAgoDate(30)}),
    ];
    const [b] = buildSignals(burst);
    const [s] = buildSignals(slow);
    expect(b.conviction).toBeGreaterThan(s.conviction);
  });

  it('boosts conviction with insider track records', () => {
    const f = [makeFiling({insiderName:'Good',relationship:'strong',value:500000})];
    const [boosted] = buildSignals(f, {insiderStats:new Map([['Good',{hitRate:85}]])});
    const [base]    = buildSignals(f);
    expect(boosted.conviction).toBeGreaterThan(base.conviction);
  });

  it('exposes _components breakdown', () => {
    const [s] = buildSignals([makeFiling({relationship:'strong', value:500000})]);
    expect(s._components).toHaveProperty('opportunistic');
    expect(s._components).toHaveProperty('cluster');
    expect(s._components).toHaveProperty('contraPenalty');
  });
});

// ── Insider leaderboard scoring (0–100) ──────────────────────────────────────

describe('processLeaderboardRows — 0–100 insider score', () => {
  it('scores a strong C-suite insider with high alpha well above 50', () => {
    const [r] = processLeaderboardRows([{
      priced:20, wins:16, avg_return_pct:25, avg_spy_return_pct:8,
      om_buys:15, om_sells:3, total_buys:18, relationship:'strong',
    }]);
    expect(r.proxy_score).toBeGreaterThan(50);
    expect(r.alpha).toBeCloseTo(17, 0);
    expect(r.hit_rate_confident).toBe(true);
  });

  it('caps sell-only insiders at 25', () => {
    const [r] = processLeaderboardRows([{
      priced:15, wins:10, avg_return_pct:20, avg_spy_return_pct:5,
      om_buys:0, om_sells:20, total_buys:0, relationship:'strong',
    }]);
    expect(r.proxy_score).toBeLessThanOrEqual(25);
  });

  it('caps insiders with no priced data at 30', () => {
    const [r] = processLeaderboardRows([{
      priced:2, wins:2, avg_return_pct:null, avg_spy_return_pct:null,
      om_buys:10, om_sells:2, total_buys:12, relationship:'strong',
    }]);
    expect(r.proxy_score).toBeLessThanOrEqual(30);
  });

  it('discounts low-sample (5-9 priced trades) by 25%', () => {
    const base = {
      wins:7, avg_return_pct:20, avg_spy_return_pct:5,
      om_buys:10, om_sells:2, total_buys:12, relationship:'strong',
    };
    const [lo] = processLeaderboardRows([{...base, priced:7}]);
    const [hi] = processLeaderboardRows([{...base, priced:20}]);
    expect(lo.proxy_score).toBeLessThan(hi.proxy_score);
  });

  it('penalizes negative alpha', () => {
    const base = {
      priced:20, wins:12, om_buys:15, om_sells:3, total_buys:18, relationship:'strong',
    };
    const [pos] = processLeaderboardRows([{...base, avg_return_pct:15, avg_spy_return_pct:5}]);
    const [neg] = processLeaderboardRows([{...base, avg_return_pct:5, avg_spy_return_pct:15}]);
    expect(pos.proxy_score).toBeGreaterThan(neg.proxy_score);
  });

  it('differentiates the top — not everyone is the same score', () => {
    const rows = processLeaderboardRows([
      {priced:25, wins:22, avg_return_pct:35, avg_spy_return_pct:8, om_buys:20, om_sells:2, total_buys:22, relationship:'strong'},
      {priced:25, wins:18, avg_return_pct:15, avg_spy_return_pct:8, om_buys:20, om_sells:5, total_buys:25, relationship:'strong'},
      {priced:25, wins:14, avg_return_pct:8,  avg_spy_return_pct:8, om_buys:20, om_sells:5, total_buys:25, relationship:'medium'},
    ]);
    // All three should have different scores
    expect(rows[0].proxy_score).toBeGreaterThan(rows[1].proxy_score);
    expect(rows[1].proxy_score).toBeGreaterThan(rows[2].proxy_score);
  });

  it('never exceeds 100', () => {
    const [r] = processLeaderboardRows([{
      priced:100, wins:95, avg_return_pct:50, avg_spy_return_pct:5,
      om_buys:80, om_sells:5, total_buys:85, relationship:'strong',
    }]);
    expect(r.proxy_score).toBeLessThanOrEqual(100);
  });
});
