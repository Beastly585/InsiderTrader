// worker/lib/crypto.test.js
import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from './crypto.js';

// A fixed 32-byte test key, base64-encoded — never use this in production,
// it exists only so tests are deterministic.
const TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

describe('encryptSecret / decryptSecret — round trip', () => {
  it('decrypts back to the exact original plaintext', async () => {
    const original = 'st-user-secret-abc123XYZ';
    const { ciphertext, iv } = await encryptSecret(TEST_KEY, original);
    const decrypted = await decryptSecret(TEST_KEY, ciphertext, iv);
    expect(decrypted).toBe(original);
  });

  it('handles empty string', async () => {
    const { ciphertext, iv } = await encryptSecret(TEST_KEY, '');
    expect(await decryptSecret(TEST_KEY, ciphertext, iv)).toBe('');
  });

  it('handles unicode content correctly', async () => {
    const original = 'sëcret-🔒-テスト';
    const { ciphertext, iv } = await encryptSecret(TEST_KEY, original);
    expect(await decryptSecret(TEST_KEY, ciphertext, iv)).toBe(original);
  });
});

describe('encryptSecret — IV uniqueness (reusing an IV breaks AES-GCM confidentiality)', () => {
  it('never reuses an IV across separate encryptions, even of the same plaintext', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => encryptSecret(TEST_KEY, 'same-value-every-time'))
    );
    const ivs = results.map(r => r.iv);
    expect(new Set(ivs).size).toBe(ivs.length); // all 20 IVs are distinct
  });

  it('the same plaintext produces different ciphertext each time (proves the IV is actually being used)', async () => {
    const a = await encryptSecret(TEST_KEY, 'identical-input');
    const b = await encryptSecret(TEST_KEY, 'identical-input');
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe('decryptSecret — tamper and key-mismatch detection', () => {
  it('throws rather than silently returning garbage if the ciphertext is tampered with', async () => {
    const { ciphertext, iv } = await encryptSecret(TEST_KEY, 'original-secret');
    // Flip the last character of the ciphertext to simulate corruption/tampering
    const tampered = ciphertext.slice(0, -1) + (ciphertext.slice(-1) === 'A' ? 'B' : 'A');
    await expect(decryptSecret(TEST_KEY, tampered, iv)).rejects.toThrow();
  });

  it('throws if decrypted with the wrong key entirely', async () => {
    const { ciphertext, iv } = await encryptSecret(TEST_KEY, 'original-secret');
    await expect(decryptSecret(OTHER_KEY, ciphertext, iv)).rejects.toThrow();
  });

  it('throws if the IV is wrong, even with the correct key and ciphertext', async () => {
    const { ciphertext } = await encryptSecret(TEST_KEY, 'original-secret');
    const { iv: unrelatedIv } = await encryptSecret(TEST_KEY, 'different-value');
    await expect(decryptSecret(TEST_KEY, ciphertext, unrelatedIv)).rejects.toThrow();
  });

  it('rejects a key that does not decode to exactly 32 bytes', async () => {
    const shortKey = btoa(String.fromCharCode(...new Uint8Array(16).fill(1))); // AES-128 length, not AES-256
    await expect(encryptSecret(shortKey, 'x')).rejects.toThrow(/32 bytes/);
  });
});
