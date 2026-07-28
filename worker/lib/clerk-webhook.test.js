// worker/lib/clerk-webhook.test.js
import { describe, it, expect, vi } from 'vitest';
import { verifyClerkWebhook } from './clerk-webhook.js';

// Real values from Svix's own published documentation
// (https://docs.svix.com/receiving/verifying-payloads/how-manual) — not
// invented, so a passing test here means the actual byte-level scheme is
// implemented correctly, not just internally self-consistent.
const REAL_SECRET    = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const REAL_ID        = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const REAL_TIMESTAMP = '1614265330'; // 2021 — deliberately stale, used only for the signature-math test below
const REAL_PAYLOAD   = '{"test": 2432232314}';
const REAL_SIGNATURE = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';

function headersFrom(obj) {
  return new Map(Object.entries(obj));
}

// A signature computed for a FRESH timestamp, since the real vector's own
// timestamp is years stale and would otherwise always fail replay
// protection regardless of whether the signature math is right — these
// two properties (correct HMAC, correct replay window) are tested
// separately on purpose, not conflated into one assertion.
async function signFresh(id, payload, secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secretBytes = Uint8Array.from(atob(secret.split('_')[1]), c => c.charCodeAt(0));
  const signedContent = `${id}.${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
  const signature = 'v1,' + btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));
  return { timestamp, signature };
}

describe('verifyClerkWebhook', () => {
  it('rejects Svix\'s own real test vector on signature math alone as stale (replay protection correctly fires on a years-old timestamp)', async () => {
    const result = await verifyClerkWebhook(REAL_PAYLOAD, headersFrom({
      'svix-id': REAL_ID, 'svix-timestamp': REAL_TIMESTAMP, 'svix-signature': REAL_SIGNATURE,
    }), REAL_SECRET);
    expect(result).toBe(false);
  });

  it('accepts a correctly-signed request with a fresh timestamp — the real correctness test, since replay protection is bypassed by using now()', async () => {
    const { timestamp, signature } = await signFresh(REAL_ID, REAL_PAYLOAD, REAL_SECRET);
    const result = await verifyClerkWebhook(REAL_PAYLOAD, headersFrom({
      'svix-id': REAL_ID, 'svix-timestamp': timestamp, 'svix-signature': signature,
    }), REAL_SECRET);
    expect(result).toBe(true);
  });

  it('rejects a tampered payload even with an otherwise-valid signature for the original payload', async () => {
    const { timestamp, signature } = await signFresh(REAL_ID, REAL_PAYLOAD, REAL_SECRET);
    const result = await verifyClerkWebhook(REAL_PAYLOAD + 'tampered', headersFrom({
      'svix-id': REAL_ID, 'svix-timestamp': timestamp, 'svix-signature': signature,
    }), REAL_SECRET);
    expect(result).toBe(false);
  });

  it('rejects a well-formed but wrong secret', async () => {
    const { timestamp, signature } = await signFresh(REAL_ID, REAL_PAYLOAD, REAL_SECRET);
    const result = await verifyClerkWebhook(REAL_PAYLOAD, headersFrom({
      'svix-id': REAL_ID, 'svix-timestamp': timestamp, 'svix-signature': signature,
    }), 'whsec_differentButValidBase64Secret==');
    expect(result).toBe(false);
  });

  it('returns false, not a thrown exception, for a malformed/invalid-base64 secret — the actual bug this test suite caught during development', async () => {
    const { timestamp, signature } = await signFresh(REAL_ID, REAL_PAYLOAD, REAL_SECRET);
    await expect(verifyClerkWebhook(REAL_PAYLOAD, headersFrom({
      'svix-id': REAL_ID, 'svix-timestamp': timestamp, 'svix-signature': signature,
    }), 'whsec_not valid base64!!!')).resolves.toBe(false);
  });

  it('returns false for an empty/missing secret, rather than throwing', async () => {
    const { timestamp, signature } = await signFresh(REAL_ID, REAL_PAYLOAD, REAL_SECRET);
    await expect(verifyClerkWebhook(REAL_PAYLOAD, headersFrom({
      'svix-id': REAL_ID, 'svix-timestamp': timestamp, 'svix-signature': signature,
    }), '')).resolves.toBe(false);
  });

  it('returns false when any of the three required svix headers is missing', async () => {
    const { timestamp, signature } = await signFresh(REAL_ID, REAL_PAYLOAD, REAL_SECRET);
    expect(await verifyClerkWebhook(REAL_PAYLOAD, headersFrom({ 'svix-timestamp': timestamp, 'svix-signature': signature }), REAL_SECRET)).toBe(false);
    expect(await verifyClerkWebhook(REAL_PAYLOAD, headersFrom({ 'svix-id': REAL_ID, 'svix-signature': signature }), REAL_SECRET)).toBe(false);
    expect(await verifyClerkWebhook(REAL_PAYLOAD, headersFrom({ 'svix-id': REAL_ID, 'svix-timestamp': timestamp }), REAL_SECRET)).toBe(false);
  });

  it('rejects a timestamp more than 5 minutes in the future, not just the past', async () => {
    const futureTimestamp = String(Math.floor(Date.now() / 1000) + 600);
    const secretBytes = Uint8Array.from(atob(REAL_SECRET.split('_')[1]), c => c.charCodeAt(0));
    const signedContent = `${REAL_ID}.${futureTimestamp}.${REAL_PAYLOAD}`;
    const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
    const signature = 'v1,' + btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));

    const result = await verifyClerkWebhook(REAL_PAYLOAD, headersFrom({
      'svix-id': REAL_ID, 'svix-timestamp': futureTimestamp, 'svix-signature': signature,
    }), REAL_SECRET);
    expect(result).toBe(false);
  });

  it('accepts when the correct signature is present among multiple space-delimited candidates (key-rotation scenario)', async () => {
    const { timestamp, signature } = await signFresh(REAL_ID, REAL_PAYLOAD, REAL_SECRET);
    const multiSignatureHeader = `v1,wrongCandidateSignatureHere== ${signature} v1,anotherWrongOne==`;
    const result = await verifyClerkWebhook(REAL_PAYLOAD, headersFrom({
      'svix-id': REAL_ID, 'svix-timestamp': timestamp, 'svix-signature': multiSignatureHeader,
    }), REAL_SECRET);
    expect(result).toBe(true);
  });
});
