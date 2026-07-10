// worker/lib/crypto.js
// AES-256-GCM via the Web Crypto API — native to Cloudflare Workers, no
// external dependency to trust for something this sensitive. Also native to
// modern Node (18+), so this is directly unit-testable without a Workers
// runtime.
//
// This file should be the ONLY place SnapTrade secrets are encrypted or
// decrypted anywhere in the codebase. neon-proxy.js imports these functions
// rather than reimplementing crypto inline — one audited code path, not
// several places that could each get it subtly wrong.

async function importKey(base64Key) {
  const keyBytes = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
  if (keyBytes.length !== 32) {
    throw new Error('SNAPTRADE_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256)');
  }
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// Encrypts a plaintext secret. Returns { ciphertext, iv }, both base64 —
// store both columns; a stored ciphertext is meaningless without its IV.
// A fresh random IV is generated every call — reusing an IV with the same
// key is a real, well-known way to break AES-GCM's confidentiality
// guarantee, so this is never left to the caller to manage.
export async function encryptSecret(base64Key, plaintext) {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

// Decrypts back to plaintext. Throws if the ciphertext/IV/key don't match —
// AES-GCM includes an authentication tag, so tampering with the stored
// ciphertext causes this to fail loudly rather than silently return garbage.
export async function decryptSecret(base64Key, ciphertextB64, ivB64) {
  const key = await importKey(base64Key);
  const ciphertext = base64ToBytes(ciphertextB64);
  const iv = base64ToBytes(ivB64);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
