// src/lib/format.test.js
import { describe, it, expect } from 'vitest';
import { fmt } from './format.js';

describe('fmt.ago — the exact bug class that caused "Updated NaNy"', () => {
  it('handles a bare date string correctly', () => {
    const tenDaysAgo = new Date(Date.now() - 10*86400000).toISOString().split('T')[0];
    expect(fmt.ago(tenDaysAgo)).toBe('10d ago');
  });

  it('handles a full ISO timestamp correctly — this exact input broke the old implementation', () => {
    const fiveDaysAgo = new Date(Date.now() - 5*86400000).toISOString(); // full timestamp, like .toISOString() produces
    expect(fmt.ago(fiveDaysAgo)).toBe('5d ago');
    expect(fmt.ago(fiveDaysAgo)).not.toContain('NaN');
  });

  it('returns "today" and "yesterday" for very recent dates', () => {
    expect(fmt.ago(new Date().toISOString().split('T')[0])).toBe('today');
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    expect(fmt.ago(yesterday)).toBe('yesterday');
  });

  it('switches to months and years at the right thresholds', () => {
    const twoMonthsAgo = new Date(Date.now() - 65*86400000).toISOString().split('T')[0];
    expect(fmt.ago(twoMonthsAgo)).toMatch(/mo ago$/);
    const twoYearsAgo = new Date(Date.now() - 800*86400000).toISOString().split('T')[0];
    expect(fmt.ago(twoYearsAgo)).toMatch(/y ago$/);
  });

  it('returns — for null/undefined/empty rather than crashing or showing NaN', () => {
    expect(fmt.ago(null)).toBe('—');
    expect(fmt.ago(undefined)).toBe('—');
    expect(fmt.ago('')).toBe('—');
  });

  it('degrades to — for a genuinely malformed date rather than propagating NaN', () => {
    expect(fmt.ago('not-a-real-date')).toBe('—');
  });
});

describe('fmt.dateShort — same bug class, different call sites', () => {
  it('handles a bare date string', () => {
    expect(fmt.dateShort('2026-07-13')).toBe('Jul 13, 26');
  });

  it('handles a full ISO timestamp — this broke Settings\' "connected_at" display before the fix', () => {
    expect(fmt.dateShort('2026-07-13T20:15:32.123Z')).toBe('Jul 13, 26');
  });

  it('returns — for null rather than "Invalid Date"', () => {
    expect(fmt.dateShort(null)).toBe('—');
  });
});

describe('fmt.date — found and fixed during extraction, had the identical unfixed vulnerability', () => {
  it('handles a bare date string', () => {
    expect(fmt.date('2026-07-13')).toBe('Jul 13, 2026');
  });

  it('handles a full ISO timestamp without producing "Invalid Date"', () => {
    const result = fmt.date('2026-07-13T20:15:32.123Z');
    expect(result).toBe('Jul 13, 2026');
    expect(result).not.toMatch(/Invalid/i);
  });

  it('returns — for null', () => {
    expect(fmt.date(null)).toBe('—');
  });
});

describe('fmt.money', () => {
  it('formats billions, millions, and thousands with the right suffix', () => {
    expect(fmt.money(2_500_000_000)).toBe('$2.5B');
    expect(fmt.money(3_400_000)).toBe('$3.4M');
    expect(fmt.money(15_000)).toBe('$15K');
  });
  it('formats small amounts as plain dollars', () => {
    expect(fmt.money(450)).toBe('$450');
  });
  it('handles negative values with the sign before the dollar sign', () => {
    expect(fmt.money(-3_400_000)).toBe('-$3.4M');
  });
  it('returns — for null', () => {
    expect(fmt.money(null)).toBe('—');
  });
});

describe('fmt.price', () => {
  it('formats to exactly two decimal places', () => {
    expect(fmt.price(42.1)).toBe('$42.10');
    expect(fmt.price('7.5')).toBe('$7.50'); // accepts string input, matches real call sites
  });
  it('returns — for null', () => {
    expect(fmt.price(null)).toBe('—');
  });
});

describe('fmt.pct', () => {
  it('prefixes positive values with +, leaves negative values as-is', () => {
    expect(fmt.pct(4.567)).toBe('+4.6%');
    expect(fmt.pct(-2.1)).toBe('-2.1%');
  });
  it('returns — for null', () => {
    expect(fmt.pct(null)).toBe('—');
  });
});
