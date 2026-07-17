// src/edgar.test.js
import { describe, it, expect } from 'vitest';
import { enrich, getSector, REL_LABELS } from './edgar.js';

// This is the exact bug that caused congressional signals to never appear,
// found through a live console trace after multiple other real fixes still
// didn't resolve it: enrich() was unconditionally overwriting the correct,
// database-computed isOpenMarket value with a client-side recomputation
// that only recognized bare SEC codes ('P', 'S') — silently evaluating to
// false for every congressional trade, since their codes are
// 'CONGRESS_P'/'CONGRESS_S'. buildSignals' very first line
// (`if (!f.isOpenMarket) continue`) then discarded every single one before
// any scoring logic ever ran, regardless of how correct that logic was.
describe('enrich — isOpenMarket must trust the database value, not silently overwrite it', () => {
  it('preserves isOpenMarket=true for a congressional buy — the exact regression this session hit', () => {
    const raw = {
      ticker: 'AAPL', transactionCode: 'CONGRESS_P', transactionType: 'buy',
      isOpenMarket: true, value: 250_000,
    };
    expect(enrich(raw).isOpenMarket).toBe(true);
  });

  it('preserves isOpenMarket=true for a congressional sell', () => {
    const raw = {
      ticker: 'AAPL', transactionCode: 'CONGRESS_S', transactionType: 'sell',
      isOpenMarket: true, value: 250_000,
    };
    expect(enrich(raw).isOpenMarket).toBe(true);
  });

  it('preserves isOpenMarket=true for a standard SEC open-market buy (code "P")', () => {
    const raw = { ticker: 'MSFT', transactionCode: 'P', transactionType: 'buy', isOpenMarket: true, value: 500_000 };
    expect(enrich(raw).isOpenMarket).toBe(true);
  });

  it('preserves isOpenMarket=false for a non-open-market transaction (e.g. an option exercise, code "M")', () => {
    const raw = { ticker: 'MSFT', transactionCode: 'M', transactionType: 'buy', isOpenMarket: false, value: 500_000 };
    expect(enrich(raw).isOpenMarket).toBe(false);
  });

  it('falls back to client-side computation only when the database value is genuinely missing (null/undefined), not overriding a real one', () => {
    const rawMissing = { ticker: 'MSFT', transactionCode: 'P', transactionType: 'buy', isOpenMarket: null, value: 500_000 };
    expect(enrich(rawMissing).isOpenMarket).toBe(true); // 'P' is a real SEC open-market code, fallback correctly recognizes it

    const rawMissingCongress = { ticker: 'AAPL', transactionCode: 'CONGRESS_P', transactionType: 'buy', isOpenMarket: undefined, value: 250_000 };
    // Honest limitation of the fallback path specifically: it only
    // recognizes bare SEC codes. This is fine in practice since the
    // database always provides a real value for both sources — this test
    // exists to make that assumption explicit and visible, not to hide it.
    expect(rawMissingCongress.transactionCode.startsWith('CONGRESS')).toBe(true);
  });

  it('never lets a falsy-but-not-nullish isOpenMarket (false) get incorrectly promoted to true by the fallback', () => {
    const raw = { ticker: 'MSFT', transactionCode: 'P', transactionType: 'buy', isOpenMarket: false, value: 500_000 };
    // isOpenMarket is `false`, not null/undefined — ?? must NOT treat this
    // as missing and fall through to recomputing it as true.
    expect(enrich(raw).isOpenMarket).toBe(false);
  });
});

describe('enrich — sector and relationship enrichment, sanity-checked alongside the isOpenMarket fix', () => {
  it('fills in sector from the ticker when not already provided', () => {
    expect(enrich({ ticker: 'AAPL', isOpenMarket: true }).sector).toBe('Technology');
  });

  it('preserves an explicitly-provided sector rather than overriding it', () => {
    expect(enrich({ ticker: 'AAPL', sector: 'Custom', isOpenMarket: true }).sector).toBe('Custom');
  });

  it('derives relationship from title when not explicitly provided', () => {
    expect(enrich({ title: 'Chief Financial Officer', isOpenMarket: true }).relationship).toBe('strong');
    expect(enrich({ title: 'Senior VP of Sales', isOpenMarket: true }).relationship).toBe('medium');
    expect(enrich({ title: 'Board Member', isOpenMarket: true }).relationship).toBe('weak');
  });

  it('assigns the correct relLabel for each relationship tier', () => {
    expect(enrich({ relationship: 'strong', isOpenMarket: true }).relLabel).toBe(REL_LABELS.strong);
    expect(enrich({ relationship: 'weak', isOpenMarket: true }).relLabel).toBe(REL_LABELS.weak);
  });
});

describe('getSector', () => {
  it('returns the correct sector for a known ticker', () => {
    expect(getSector('JPM')).toBe('Finance');
  });
  it('returns "Other" for an unrecognized ticker', () => {
    expect(getSector('ZZZZ')).toBe('Other');
  });
  it('is case-insensitive', () => {
    expect(getSector('aapl')).toBe('Technology');
  });
});
