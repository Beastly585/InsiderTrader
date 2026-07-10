// worker/lib/sql.test.js
import { describe, it, expect } from 'vitest';
import { sqlVal } from './sql.js';

describe('sqlVal — injection safety (this is the security boundary for every query in the Worker)', () => {
  it('escapes a single quote by doubling it', () => {
    expect(sqlVal("O'Brien")).toBe(`'O''Brien'`);
  });

  it('neutralizes a classic injection payload — the trailing quote never breaks out of the string literal', () => {
    const payload = "x'; DROP TABLE public.filings; --";
    const escaped = sqlVal(payload);
    // Every single quote in the input must be doubled, meaning there is no
    // unescaped ' anywhere that could close the string literal early.
    const withoutDoubled = escaped.slice(1, -1).replace(/''/g, '');
    expect(withoutDoubled.includes("'")).toBe(false);
  });

  it('wraps the escaped value in a single matched pair of quotes', () => {
    const escaped = sqlVal("test");
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
  });

  it('handles a value that is nothing but quote characters', () => {
    expect(sqlVal("'''")).toBe(`''''''''`); // 3 quotes -> 6 quotes, wrapped
  });

  it('null and undefined both become the SQL keyword NULL, unquoted', () => {
    expect(sqlVal(null)).toBe('NULL');
    expect(sqlVal(undefined)).toBe('NULL');
  });

  it('booleans become unquoted TRUE/FALSE, not the string "true"/"false"', () => {
    expect(sqlVal(true)).toBe('TRUE');
    expect(sqlVal(false)).toBe('FALSE');
  });

  it('numbers are emitted unquoted, not as escaped strings', () => {
    expect(sqlVal(42)).toBe('42');
    expect(sqlVal(0)).toBe('0');
    expect(sqlVal(-3.14)).toBe('-3.14');
  });

  it('a numeric-looking string is still quoted and escaped as a string, not treated as a number', () => {
    // Important distinction: sqlVal("42") must NOT equal sqlVal(42) — the
    // caller controls type intentionally (e.g. clerk_user_id is always a
    // string even though it might look numeric).
    expect(sqlVal('42')).toBe("'42'");
    expect(sqlVal('42')).not.toBe(sqlVal(42));
  });

  it('an empty string is quoted, not treated as NULL', () => {
    expect(sqlVal('')).toBe("''");
  });
});
