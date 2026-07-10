// worker/lib/snaptrade-sign.test.js
import { describe, it, expect } from 'vitest';
import { sortedStringify, computeSignature } from './snaptrade-sign.js';

describe('computeSignature — verified against SnapTrade\'s own documented example', () => {
  it('matches the exact signature from SnapTrade\'s official docs test vector', async () => {
    // From https://github.com/passiv/snaptrade-api-docs — their own Python
    // example, reproduced independently and confirmed to match before this
    // was ever wired into a real request. If this test ever fails, the
    // signing algorithm has drifted from what SnapTrade actually expects —
    // treat that as a real, urgent problem, not a flaky test.
    const consumerKey = 'UxrFb4cHdRWlmJKNuJjA6hoaN8uVa6jPGFVUl2UKHuKmurCnaU';
    const content = { userId: 'api@passiv.com', userSecret: 'CHRIS.P.BACON' };
    const path = '/api/v1/snapTrade/mockSignature';
    const query = 'clientId=PASSIVTEST&timestamp=1635790389';

    const signature = await computeSignature(consumerKey, content, path, query);
    expect(signature).toBe('ZNUcaf2UIvd1QHV7X6Dn6AbJq+nLRWRrqcLyW3Nq5vw=');
  });
});

describe('sortedStringify — key ordering (the part that breaks silently if skipped)', () => {
  it('sorts top-level keys alphabetically regardless of insertion order', () => {
    const a = sortedStringify({ z: 1, a: 2, m: 3 });
    const b = sortedStringify({ a: 2, m: 3, z: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"m":3,"z":1}');
  });

  it('sorts nested object keys too, not just the top level', () => {
    const result = sortedStringify({ outer: { z: 1, a: 2 } });
    expect(result).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('produces no extra whitespace anywhere', () => {
    const result = sortedStringify({ a: 1, b: { c: 2 } });
    expect(result).not.toMatch(/\s/);
  });

  it('handles null content (no request body) correctly, matching SnapTrade GET requests', () => {
    expect(sortedStringify(null)).toBe('null');
  });

  it('preserves array order — only object keys are sorted, not array elements', () => {
    const result = sortedStringify({ list: [3, 1, 2] });
    expect(result).toBe('{"list":[3,1,2]}');
  });
});
