/**
 * InsiderDesk — Cloudflare Worker  (neon-proxy.js)
 *
 * Uses the ORIGINAL Neon connection approach that was working before:
 *   POST https://{host}/sql
 *   Authorization: Bearer {NEON_API_KEY}
 *   Neon-Connection-String: postgresql://{role}@{host}/{db}
 *
 * Secrets needed (wrangler secret put):
 *   NEON_CONNECTION_STRING   full postgresql:// URL (used to extract host/db/role)
 *   NEON_API_KEY             Neon API key (napi_xxxx...)
 *   ALPACA_KEY
 *   ALPACA_SECRET
 */

const ALLOWED_ORIGINS = new Set([
  'https://beastly585.github.io',
  'https://insiderdesk.app',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://localhost:3000',
  'http://localhost:5173',   // Vite dev server
  'http://127.0.0.1:5173',  // Vite dev server (IP form)
]);

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204, origin, env);
    }

    // Allow GET and POST
    if (request.method !== 'POST' && request.method !== 'GET') {
      return corsResponse({ error: 'Method not allowed' }, 405, origin, env);
    }

    // Origin check — only in prod (when secrets are set)
    const isProd = !!(env.NEON_API_KEY || env.NEON_CONNECTION_STRING);
    if (isProd && origin && !ALLOWED_ORIGINS.has(origin)) {
      return corsResponse({ error: 'Origin not allowed' }, 403, origin, env);
    }

    // Auth check — accepts either:
    //   Phase 1: X-API-Key header (current)
    //   Phase 2: Authorization: Bearer <Clerk JWT> (once CLERK_JWKS_URL secret is set)
    // Both work simultaneously during migration — no flag day needed.
    if (env.WORKER_API_KEY || env.CLERK_JWKS_URL) {
      const authHeader  = request.headers.get('Authorization') || '';
      const apiKey      = request.headers.get('X-API-Key') || '';

      // Try Clerk JWT first if configured
      if (env.CLERK_JWKS_URL && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const valid = await verifyClerkJWT(token, env.CLERK_JWKS_URL).catch(() => false);
        if (!valid) return corsResponse({ error: 'Invalid token' }, 401, origin, env);
        // JWT valid — proceed
      } else if (env.WORKER_API_KEY) {
        // Fall back to API key
        const expected = env.WORKER_API_KEY;
        let diff = apiKey.length !== expected.length ? 1 : 0;
        for (let i = 0; i < Math.max(apiKey.length, expected.length); i++) {
          diff |= (apiKey.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
        }
        if (diff !== 0) return corsResponse({ error: 'Unauthorized' }, 401, origin, env);
      } else {
        return corsResponse({ error: 'Unauthorized' }, 401, origin, env);
      }
    }

    const url = new URL(request.url);
    if (url.pathname === '/portfolio' || url.pathname.startsWith('/portfolio')) {
      return handlePortfolio(request, env, origin);
    }

    return handleQuery(request, env, origin);
  },
};

async function handleQuery(request, env, origin) {
  // Parse body — handle both GET (no body) and POST
  let query = '';
  if (request.method === 'POST') {
    let bodyText = '';
    try { bodyText = await request.text(); } catch (e) {
      return corsResponse({ error: 'Body read failed', detail: e.message }, 400, origin, env);
    }

    console.log('[Worker] bodyText length:', bodyText.length);

    if (!bodyText || bodyText.trim() === '') {
      return corsResponse({ error: 'Empty body', received_length: bodyText.length }, 400, origin, env);
    }

    let body;
    try { body = JSON.parse(bodyText); }
    catch (e) {
      return corsResponse({ error: 'Invalid JSON', received_length: bodyText.length, preview: bodyText.slice(0,100), parseError: e.message }, 400, origin, env);
    }

    query = body.query || '';
  }

  if (!query || typeof query !== 'string') {
    return corsResponse({ error: 'Missing query', queryType: typeof query, queryLength: query.length }, 400, origin, env);
  }

  // SELECT only guard
  if (!query.trim().toUpperCase().startsWith('SELECT')) {
    return corsResponse({ error: 'Only SELECT queries allowed' }, 403, origin, env);
  }

  // Parse connection string to get host, role, database
  const connStr = env.NEON_CONNECTION_STRING;
  if (!connStr) {
    return corsResponse({ error: 'NEON_CONNECTION_STRING not configured' }, 500, origin, env);
  }

  let host, role, database;
  try {
    const u = new URL(connStr);
    host     = u.hostname;                      // ep-xxx.us-east-1.aws.neon.tech
    role     = u.username;                      // neondb_owner
    database = u.pathname.replace(/^\//, '');   // neondb
  } catch {
    return corsResponse({ error: 'Invalid NEON_CONNECTION_STRING' }, 500, origin, env);
  }

  // Use full connection string including password in the header
  const headers = {
    'Content-Type':           'application/json',
    'Neon-Connection-String': connStr,  // full postgresql://role:password@host/db
  };

  let resp;
  try {
    resp = await fetch(`https://${host}/sql`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query }),
    });
  } catch (e) {
    return corsResponse({ error: `Neon fetch failed: ${e.message}` }, 502, origin, env);
  }

  const text = await resp.text();
  let result;
  try { result = JSON.parse(text); }
  catch { return corsResponse({ error: 'Invalid Neon response', raw: text.slice(0,200) }, 502, origin, env); }

  return corsResponse(result, resp.status, origin, env);
}

async function handlePortfolio(request, env, origin) {
  const alpacaKey    = env.ALPACA_KEY;
  const alpacaSecret = env.ALPACA_SECRET;

  if (!alpacaKey || !alpacaSecret) {
    return corsResponse({ positions: [], account: null, isPaper: true }, 200, origin, env);
  }

  const base    = env.ALPACA_LIVE ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
  const headers = { 'APCA-API-KEY-ID': alpacaKey, 'APCA-API-SECRET-KEY': alpacaSecret };

  try {
    const [posResp, acctResp] = await Promise.all([
      fetch(`${base}/v2/positions`, { headers }),
      fetch(`${base}/v2/account`,   { headers }),
    ]);
    const [positions, account] = await Promise.all([posResp.json(), acctResp.json()]);
    return corsResponse({ positions, account, isPaper: !env.ALPACA_LIVE }, 200, origin, env);
  } catch (e) {
    return corsResponse({ error: `Alpaca failed: ${e.message}` }, 502, origin, env);
  }
}

function corsHeaders(origin, env) {
  const isProd = !!(env.NEON_API_KEY || env.NEON_CONNECTION_STRING);
  const allowed = (!isProd || ALLOWED_ORIGINS.has(origin)) ? origin : '';
  return {
    'Access-Control-Allow-Origin':  allowed || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
    'Access-Control-Max-Age':       '86400',
  };
}

function corsResponse(body, status, origin, env) {
  return new Response(
    body !== null ? JSON.stringify(body) : null,
    { status, headers: { ...corsHeaders(origin, env), 'Content-Type': 'application/json' } }
  );
}

// ── Clerk JWT verification ────────────────────────────────────────────────────
// Verifies a Clerk-issued JWT against the JWKS endpoint.
// Called only when CLERK_JWKS_URL secret is set.
async function verifyClerkJWT(token, jwksUrl) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const b64 = s => atob(s.replace(/-/g,'+').replace(/_/g,'/'));
  const header  = JSON.parse(b64(parts[0]));
  const payload = JSON.parse(b64(parts[1]));

  // Check expiry first — fast fail
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error('JWT expired');

  // Fetch JWKS — cached by Cloudflare for 1 hour
  const jwksResp = await fetch(jwksUrl, {
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  const { keys } = await jwksResp.json();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('No matching key');

  // Verify signature
  const cryptoKey = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );
  const sigBytes  = Uint8Array.from(b64(parts[2]), c => c.charCodeAt(0));
  const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid     = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sigBytes, dataBytes);
  if (!valid) throw new Error('Invalid signature');

  return payload;
}
