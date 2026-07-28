// worker/lib/clerk-webhook.js
// Clerk delivers webhooks via Svix, using Svix's own signing scheme — HMAC-
// SHA256 over "svix-id.svix-timestamp.body", keyed by the base64 portion of
// the whsec_-prefixed secret. Verified here against Svix's own published
// test vector before ever being wired into a real request (secret
// whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw, a fixed id/timestamp/payload, and
// Svix's documented expected signature — see the test file for the exact
// values). Getting this wrong either rejects every legitimate webhook or
// accepts forged ones, so this isn't a place to trust without a real test.
//
// Uses the Web Crypto API only — native to Cloudflare Workers and to modern
// Node (18+), so directly unit-testable without a Workers runtime, matching
// crypto.js's own reasoning for the same choice.
//
// neon-proxy.js should be the only caller of this — one audited
// verification path, not several places that could each get the byte-level
// details subtly wrong.

export async function verifyClerkWebhook(rawBody, headers, secret) {
  const svixId        = headers.get('svix-id') || '';
  const svixTimestamp = headers.get('svix-timestamp') || '';
  const svixSignature = headers.get('svix-signature') || '';
  if (!svixId || !svixTimestamp || !svixSignature || !secret) return false;

  // Replay protection — reject anything far outside a 5-minute window,
  // matching the tolerance Svix's own official libraries use.
  const ts = Number(svixTimestamp);
  if (!ts || Math.abs(Date.now()/1000 - ts) > 300) return false;

  // Everything below can throw on malformed input — an invalid secret
  // (wrong format, missing whsec_ prefix, not valid base64) or a
  // CLERK_WEBHOOK_SECRET that simply isn't configured yet. Caught here
  // deliberately, found by testing against exactly that scenario rather
  // than assumed safe: without this, a misconfigured secret would 500 the
  // request instead of cleanly rejecting it with an unverified signature.
  try {
    // whsec_ prefix stripped, remainder base64-decoded to get the raw HMAC
    // key bytes — this exact step, and only this step, is what the test
    // vector confirmed correct.
    const secretBytes = Uint8Array.from(atob(secret.split('_')[1]), c => c.charCodeAt(0));
    const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;

    const key = await crypto.subtle.importKey(
      'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
    const computed = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));

    // svix-signature is a space-delimited list of "v1,<base64>" candidates
    // (Svix sends more than one during key rotation) — verification passes
    // if ANY candidate matches, compared in constant time rather than with
    // a plain ===, matching the same care given to every other secret
    // comparison in this file.
    const candidates = svixSignature.split(' ').map(c => c.startsWith('v1,') ? c.slice(3) : c);
    for (const candidate of candidates) {
      if (candidate.length !== computed.length) continue;
      let diff = 0;
      for (let i = 0; i < computed.length; i++) diff |= candidate.charCodeAt(i) ^ computed.charCodeAt(i);
      if (diff === 0) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}
