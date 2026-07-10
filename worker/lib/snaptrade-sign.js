// worker/lib/snaptrade-sign.js
// Pure signing logic, separated from the actual network fetch so it's
// unit-testable. Verified against SnapTrade's own documented test vector
// (their GitHub docs repo, passiv/snaptrade-api-docs) before this was ever
// wired into a real request — see snaptrade-sign.test.js, which encodes
// that same verification as a permanent regression test rather than a
// one-off manual check.

// Recursively sorts object keys alphabetically before stringifying, with no
// whitespace — matches Python's json.dumps(obj, separators=(",",":"),
// sort_keys=True), which is what SnapTrade's own reference implementation
// uses. JS's JSON.stringify preserves insertion order, not alphabetical, so
// this can't be skipped — an unsorted payload produces a different (wrong)
// signature even though the data is identical.
export function sortedStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(sortedStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + sortedStringify(obj[k])).join(',') + '}';
}

// HMAC-SHA256(consumerKey, sortedStringify({content, path, query})), base64.
export async function computeSignature(consumerKey, content, path, query) {
  const sigContent = sortedStringify({ content, path, query });
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(consumerKey),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sigContent));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}
