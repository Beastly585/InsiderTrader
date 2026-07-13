/**
 * Seli — Cloudflare Worker  (neon-proxy.js)
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
 *   STRIPE_SECRET_KEY        sk_live_... / sk_test_...
 *   STRIPE_WEBHOOK_SECRET    whsec_... — from the Stripe Dashboard webhook endpoint
 *   STRIPE_PRICE_PRO         price_... for the $11.99/mo Pro plan (the only
 *                            recurring plan — the $9.99 data export is a
 *                            one-time PaymentIntent, no Price object needed)
 *   CLERK_SECRET_KEY         sk_live_... / sk_test_... — used to mirror plan
 *                            status into Clerk publicMetadata after webhook events
 *   CLERK_JWKS_URL           https://<your-clerk-domain>/.well-known/jwks.json
 *                            — from the PRODUCTION Clerk instance, not Dev
 *
 * Requires `npm install stripe` in this Worker's package.json — Stripe's SDK
 * runs on Workers via createFetchHttpClient()/createSubtleCryptoProvider(),
 * no Node-specific APIs needed.
 */

import { sqlVal } from './lib/sql.js';
import { encryptSecret, decryptSecret } from './lib/crypto.js';
import { computeSignature } from './lib/snaptrade-sign.js';

const ALLOWED_ORIGINS = new Set([
  'https://seli.app',
  'https://www.seli.app',
  'https://seli-dgu.pages.dev',
  'https://beastly585.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204, origin, env);
    }

    const url = new URL(request.url);

    // ── Stripe webhook — MUST run before origin/auth checks below.        ──
    // Stripe's requests have no Origin header we'd recognize and no
    // X-API-Key/Clerk JWT — its own signature (verified inside the handler
    // against the raw, unparsed body) IS the auth check for this route.
    if (url.pathname === '/stripe/webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
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

    // ── Billing routes ───────────────────────────────────────────────────
    if (url.pathname === '/billing/create-subscription') {
      return handleCreateSubscription(request, env, origin);
    }
    if (url.pathname === '/billing/create-data-purchase') {
      return handleCreateDataPurchase(request, env, origin);
    }
    if (url.pathname === '/billing/cancel') {
      return handleCancelSubscription(request, env, origin);
    }
    if (url.pathname === '/billing/reactivate') {
      return handleReactivateSubscription(request, env, origin);
    }
    if (url.pathname === '/billing/status') {
      return handleBillingStatus(request, env, origin);
    }

    // ── Watchlist routes ───────────────────────────────────────────────────
    if (url.pathname === '/watchlist') {
      return handleWatchlist(request, env, origin);
    }

    // ── Notification preferences ─────────────────────────────────────────
    if (url.pathname === '/prefs') {
      return handlePrefs(request, env, origin);
    }
    if (url.pathname === '/prefs/test-email') {
      return handleTestEmail(request, env, origin);
    }

    if (url.pathname === '/portfolio' || url.pathname.startsWith('/portfolio')) {
      return handlePortfolio(request, env, origin);
    }

    // ── SnapTrade — real per-user portfolio linking ──────────────────────
    // Distinct from the /portfolio route above, which is the older
    // single-shared-Alpaca-key implementation (same data for every user —
    // not real per-user linking). Once this is live and wired into the
    // frontend, /portfolio becomes dead code worth removing in a follow-up
    // pass — not deleted here, since that's a frontend-coordinated change,
    // not something to do silently as a side effect of adding this.
    if (url.pathname === '/snaptrade/connect') {
      return handleSnapTradeConnect(request, env, origin);
    }
    if (url.pathname === '/snaptrade/status') {
      return handleSnapTradeStatus(request, env, origin);
    }
    if (url.pathname === '/snaptrade/disconnect') {
      return handleSnapTradeDisconnect(request, env, origin);
    }
    if (url.pathname === '/snaptrade/positions') {
      return handleSnapTradePositions(request, env, origin);
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

  // ── Free-tier date floor enforcement ────────────────────────────────────
  // This can't live in edgar.js alone — the client builds the SQL string
  // itself and sends it here, so a free user could just edit the request in
  // dev tools and delete the date filter. This clamps it server-side instead:
  // if the caller isn't Pro, any date-floor literal this query contains gets
  // rewritten to no earlier than 1 year ago, regardless of what was sent.
  if (query.toLowerCase().includes('public.filings')) {
    const clerkUserId = await verifiedUserId(request, env);
    let isPro = false;
    if (clerkUserId) {
      try {
        const result = await neonFetch(env,
          `SELECT status FROM public.subscriptions WHERE clerk_user_id = ${sqlVal(clerkUserId)}`
        );
        isPro = result.rows?.[0]?.status === 'active' || result.rows?.[0]?.status === 'trialing';
      } catch (e) {
        console.error('[Worker] Plan check failed, defaulting to free-tier restrictions:', e.message);
      }
    }

    if (!isPro) {
      const freeFloor = new Date();
      freeFloor.setDate(freeFloor.getDate() - 365);
      const floorStr = freeFloor.toISOString().slice(0, 10);

      // Find any `>= 'YYYY-MM-DD'` date-floor literal in the query and clamp
      // it to no earlier than the free floor — never let the client's date
      // reach further back than this, whatever they sent.
      query = query.replace(/>=\s*'(\d{4}-\d{2}-\d{2})'/g, (match, dateStr) => {
        return dateStr < floorStr ? `>= '${floorStr}'` : match;
      });
    }
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


async function handlePrefs(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  // GET — load current prefs
  if (request.method === 'GET') {
    try {
      const result = await neonFetch(env, `
        SELECT daily_digest, weekly_digest,
               digest_top_signals, digest_congressional, digest_corporate,
               digest_watchlist_only, digest_min_conviction,
               digest_max_signals, digest_min_value,
               instant_watchlist_ticker, instant_followed_insider,
               instant_high_conviction, instant_reversal,
               instant_min_value, instant_high_conviction_threshold
        FROM public.user_preferences
        WHERE clerk_user_id = ${sqlVal(clerkUserId)}
      `);
      return corsResponse({ prefs: result.rows?.[0] || null }, 200, origin, env);
    } catch (e) {
      return corsResponse({ error: e.message }, 500, origin, env);
    }
  }

  // POST — save prefs
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return corsResponse({ error: 'Invalid JSON' }, 400, origin, env); }

    const b = (v) => v ? 'TRUE' : 'FALSE';
    const conviction = ['any','medium','high'].includes(body.digest_min_conviction) ? body.digest_min_conviction : 'any';
    // Numeric fields — clamp to sane non-negative values rather than trust the client outright.
    const n = (v, fallback=0) => { const num = Number(v); return Number.isFinite(num) && num >= 0 ? num : fallback; };
    const maxSignals   = n(body.digest_max_signals, 10);
    const digestMinVal = n(body.digest_min_value, 0);
    const instantMinVal = n(body.instant_min_value, 0);
    const hcThreshold  = n(body.instant_high_conviction_threshold, 1000000);

    // Pull the email from Clerk directly rather than trusting the client —
    // this is what alerts actually get sent to, so it shouldn't be spoofable
    // and shouldn't silently go stale if the user's email changes elsewhere.
    let email = null;
    if (env.CLERK_SECRET_KEY) {
      try {
        const r = await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
          headers: { 'Authorization': `Bearer ${env.CLERK_SECRET_KEY}` },
        });
        const u = await r.json();
        const primaryId = u.primary_email_address_id;
        email = u.email_addresses?.find(e => e.id === primaryId)?.email_address
             || u.email_addresses?.[0]?.email_address || null;
      } catch (e) {
        console.error('[Worker] Failed to fetch email from Clerk:', e.message);
      }
    }
    if (!email) return corsResponse({ error: 'Could not verify your account email — try again' }, 500, origin, env);

    try {
      await neonFetch(env, `
        INSERT INTO public.user_preferences
          (clerk_user_id, email, daily_digest, weekly_digest,
           digest_top_signals, digest_congressional, digest_corporate,
           digest_watchlist_only, digest_min_conviction, digest_max_signals, digest_min_value,
           instant_watchlist_ticker, instant_followed_insider,
           instant_high_conviction, instant_reversal,
           instant_min_value, instant_high_conviction_threshold, updated_at)
        VALUES (
          ${sqlVal(clerkUserId)}, ${sqlVal(email)}, ${b(body.daily_digest)}, ${b(body.weekly_digest)},
          ${b(body.digest_top_signals)}, ${b(body.digest_congressional)}, ${b(body.digest_corporate)},
          ${b(body.digest_watchlist_only)}, ${sqlVal(conviction)}, ${maxSignals}, ${digestMinVal},
          ${b(body.instant_watchlist_ticker)}, ${b(body.instant_followed_insider)},
          ${b(body.instant_high_conviction)}, ${b(body.instant_reversal)},
          ${instantMinVal}, ${hcThreshold}, now()
        )
        ON CONFLICT (clerk_user_id) DO UPDATE SET
          email                              = EXCLUDED.email,
          daily_digest                       = EXCLUDED.daily_digest,
          weekly_digest                      = EXCLUDED.weekly_digest,
          digest_top_signals                 = EXCLUDED.digest_top_signals,
          digest_congressional               = EXCLUDED.digest_congressional,
          digest_corporate                   = EXCLUDED.digest_corporate,
          digest_watchlist_only              = EXCLUDED.digest_watchlist_only,
          digest_min_conviction              = EXCLUDED.digest_min_conviction,
          digest_max_signals                 = EXCLUDED.digest_max_signals,
          digest_min_value                   = EXCLUDED.digest_min_value,
          instant_watchlist_ticker           = EXCLUDED.instant_watchlist_ticker,
          instant_followed_insider           = EXCLUDED.instant_followed_insider,
          instant_high_conviction            = EXCLUDED.instant_high_conviction,
          instant_reversal                   = EXCLUDED.instant_reversal,
          instant_min_value                  = EXCLUDED.instant_min_value,
          instant_high_conviction_threshold  = EXCLUDED.instant_high_conviction_threshold,
          updated_at                         = now()
      `);
      return corsResponse({ ok: true }, 200, origin, env);
    } catch (e) {
      return corsResponse({ error: e.message }, 500, origin, env);
    }
  }

  return corsResponse({ error: 'Method not allowed' }, 405, origin, env);
}

// ── Send a one-off test email — lets a user verify Resend delivery and their
// email address are actually working, without waiting for a real trigger.
// Pro-gated, same as the notification system itself.
async function handleTestEmail(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  try {
    const subResult = await neonFetch(env,
      `SELECT status FROM public.subscriptions WHERE clerk_user_id = ${sqlVal(clerkUserId)}`
    );
    const status = subResult.rows?.[0]?.status;
    if (status !== 'active' && status !== 'trialing') {
      return corsResponse({ error: 'Test emails are a Pro feature' }, 403, origin, env);
    }

    if (!env.RESEND_API_KEY) {
      return corsResponse({ error: 'Email sending is not configured on this Worker yet' }, 500, origin, env);
    }

    let email = null;
    if (env.CLERK_SECRET_KEY) {
      const r = await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
        headers: { 'Authorization': `Bearer ${env.CLERK_SECRET_KEY}` },
      });
      const u = await r.json();
      const primaryId = u.primary_email_address_id;
      email = u.email_addresses?.find(e => e.id === primaryId)?.email_address
           || u.email_addresses?.[0]?.email_address || null;
    }
    if (!email) return corsResponse({ error: 'Could not verify your account email' }, 500, origin, env);

    const fromEmail = env.ALERTS_FROM_EMAIL || 'alerts@mail.seli.app';
    const appUrl = env.APP_URL || 'https://seli.app';
    const html = `
      <div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
        <p style="font-size:14px;">This is a test email from Seli — if you're reading this, your notification delivery is working correctly.</p>
        <p style="font-size:13px;color:#8B95A5;">Real digests and instant alerts will look similar to this, populated with actual insider activity matching your Settings.</p>
        <p style="margin-top:20px;"><a href="${appUrl}" style="color:#7C6FFF;">Open Seli →</a></p>
      </div>`;

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromEmail, to: [email], subject: 'Seli — test email', html }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error('[Worker] Test email failed:', resp.status, errText.slice(0,200));
      return corsResponse({ error: 'Resend rejected the send — check Worker secrets' }, 502, origin, env);
    }

    return corsResponse({ ok: true, sentTo: email }, 200, origin, env);
  } catch (e) {
    console.error('[Worker] test-email failed:', e.message);
    return corsResponse({ error: e.message }, 500, origin, env);
  }
}

async function handleWatchlist(request, env, origin) {
  // Now uses the same verified-JWT check as billing/prefs — this previously
  // used a plain unverified decode, flagged early on but never fixed until now.
  const userId = await verifiedUserId(request, env);
  if (!userId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  // GET — load watchlist
  if (request.method === 'GET') {
    try {
      const result = await neonFetch(env,
        `SELECT item_type, item_value FROM public.user_watchlist WHERE clerk_user_id=${sqlVal(userId)} ORDER BY added_at DESC`
      );
      return corsResponse({ items: result.rows || [] }, 200, origin, env);
    } catch (e) {
      console.error('[Worker] watchlist GET failed:', e.message);
      return corsResponse({ error: e.message }, 500, origin, env);
    }
  }

  // POST — add or remove item
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return corsResponse({ error: 'Invalid JSON' }, 400, origin, env); }
    const { action, item_type, item_value } = body;
    if (!['add','remove'].includes(action))   return corsResponse({ error: 'Invalid action' }, 400, origin, env);
    if (!['ticker','insider'].includes(item_type)) return corsResponse({ error: 'Invalid item_type' }, 400, origin, env);
    if (!item_value || typeof item_value !== 'string') return corsResponse({ error: 'Missing item_value' }, 400, origin, env);

    const val = item_value.slice(0,200);

    try {
      if (action === 'add') {
        await neonFetch(env, `
          INSERT INTO public.user_watchlist (clerk_user_id, item_type, item_value)
          VALUES (${sqlVal(userId)}, ${sqlVal(item_type)}, ${sqlVal(val)})
          ON CONFLICT (clerk_user_id, item_type, item_value) DO NOTHING
        `);
      } else {
        await neonFetch(env, `
          DELETE FROM public.user_watchlist
          WHERE clerk_user_id=${sqlVal(userId)} AND item_type=${sqlVal(item_type)} AND item_value=${sqlVal(val)}
        `);
      }
      return corsResponse({ ok: true }, 200, origin, env);
    } catch (e) {
      console.error('[Worker] watchlist POST failed:', e.message);
      return corsResponse({ error: e.message }, 500, origin, env);
    }
  }

  return corsResponse({ error: 'Method not allowed' }, 405, origin, env);
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

// ── SnapTrade — real per-user portfolio linking ─────────────────────────────
//
// Security model, read this before touching any of these functions:
//
//   getSnapTradeConnection() is the ONLY function in this entire file
//   allowed to read secret_ciphertext/secret_iv and decrypt them. Every
//   other function that needs to make an authenticated SnapTrade API call
//   goes through it — never query those columns directly elsewhere, and
//   never inline decryptSecret() calls anywhere else. One audited path.
//
//   Every other read (status, anything that could end up in a response sent
//   to a browser) queries portfolio_connections_public — the view defined
//   in 007_portfolio_connections.sql that structurally excludes the secret
//   columns. This isn't just "remember not to SELECT that column" — the
//   view doesn't have it, so there's nothing to accidentally select.
//
//   The decrypted plaintext secret must never be logged, never placed in
//   any object returned via corsResponse, and should go out of scope
//   immediately after the one SnapTrade API call that needs it.
//
//   SNAPTRADE_ENCRYPTION_KEY (Worker secret, base64, 32 bytes) must be
//   distinct from every other secret in this Worker — CLERK_SECRET_KEY,
//   STRIPE_SECRET_KEY, etc. — so a leak of any one of them doesn't also
//   compromise this one.

// The one authorized function that ever reads+decrypts a stored secret.
async function getSnapTradeConnection(env, clerkUserId) {
  const result = await neonFetch(env, `
    SELECT snaptrade_user_id, secret_ciphertext, secret_iv
    FROM public.portfolio_connections
    WHERE clerk_user_id = ${sqlVal(clerkUserId)} AND status = 'active'
  `);
  const row = result.rows?.[0];
  if (!row) return null;
  const userSecret = await decryptSecret(env.SNAPTRADE_ENCRYPTION_KEY, row.secret_ciphertext, row.secret_iv);
  return { snapTradeUserId: row.snaptrade_user_id, userSecret };
}

// (sortedStringify / the signature algorithm now live in
// worker/lib/snaptrade-sign.js — imported above — verified against
// SnapTrade's own documented test vector, see that file's test suite.)

async function signSnapTradeRequest(env, method, path, { query = {}, body = null } = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const queryParams = new URLSearchParams({ ...query, clientId: env.SNAPTRADE_CLIENT_ID, timestamp: String(timestamp) });
  const queryString = queryParams.toString();

  const signature = await computeSignature(env.SNAPTRADE_CONSUMER_KEY, body, path, queryString);

  const url = `https://api.snaptrade.com${path}?${queryString}`;
  const resp = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'Signature': signature },
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) {
    throw new Error(`SnapTrade ${method} ${path} failed (${resp.status}): ${data.detail || data.raw || text}`);
  }
  return data;
}

async function handleSnapTradeConnect(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  if (!env.SNAPTRADE_ENCRYPTION_KEY) {
    return corsResponse({ error: 'Portfolio linking is not configured on this Worker yet' }, 500, origin, env);
  }

  try {
    // Reuse an existing SnapTrade registration if this user already has one
    // (e.g. they disconnected and are reconnecting) — otherwise register a
    // new SnapTrade user via signSnapTradeRequest(...) against the Register
    // User endpoint, which returns a fresh userSecret. Encrypt it
    // immediately — it should never be held in a variable longer than
    // necessary before being encrypted and written to storage.
    const existing = await neonFetch(env, `
      SELECT snaptrade_user_id FROM public.portfolio_connections
      WHERE clerk_user_id = ${sqlVal(clerkUserId)}
    `);

    let snapTradeUserId, userSecret;
    if (existing.rows?.[0]) {
      snapTradeUserId = existing.rows[0].snaptrade_user_id;
      // Existing user — re-fetch their secret via getSnapTradeConnection
      // rather than re-registering, which would orphan the old connection.
      const conn = await getSnapTradeConnection(env, clerkUserId);
      userSecret = conn?.userSecret;
    } else {
      snapTradeUserId = clerkUserId; // reuse Clerk's own user id — not sensitive alone
      const registerResp = await signSnapTradeRequest(env, 'POST', '/api/v1/snapTrade/registerUser', {
        body: { userId: snapTradeUserId },
      });
      userSecret = registerResp.userSecret;
    }

    const { ciphertext, iv } = await encryptSecret(env.SNAPTRADE_ENCRYPTION_KEY, userSecret);

    await neonFetch(env, `
      INSERT INTO public.portfolio_connections
        (clerk_user_id, snaptrade_user_id, secret_ciphertext, secret_iv, connection_type, status, updated_at)
      VALUES (${sqlVal(clerkUserId)}, ${sqlVal(snapTradeUserId)}, ${sqlVal(ciphertext)}, ${sqlVal(iv)}, 'read', 'active', now())
      ON CONFLICT (clerk_user_id) DO UPDATE SET
        snaptrade_user_id = EXCLUDED.snaptrade_user_id,
        secret_ciphertext = EXCLUDED.secret_ciphertext,
        secret_iv         = EXCLUDED.secret_iv,
        status             = 'active',
        updated_at         = now()
    `);

    // connectionType defaults to read-only on SnapTrade's side even if
    // omitted, per their docs — passed explicitly here anyway so the
    // intent is visible in the code, not just relying on their default.
    // customRedirect brings the user back to Settings afterward instead of
    // leaving them on SnapTrade's own generic confirmation page — built
    // from the request's own origin so this works correctly in both local
    // dev and production without hardcoding a domain.
    const portalResp = await signSnapTradeRequest(env, 'POST', '/api/v1/snapTrade/login', {
      body: {
        userId: snapTradeUserId,
        userSecret,
        connectionType: 'read',
        customRedirect: `${origin}/settings?snaptrade=connected`,
      },
    });
    return corsResponse({ redirectURI: portalResp.redirectURI }, 200, origin, env);
  } catch (e) {
    console.error('[Worker] SnapTrade connect failed:', e.message); // never log userSecret itself
    return corsResponse({ error: e.message }, 500, origin, env);
  }
}

async function handleSnapTradeStatus(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  try {
    // Queries the view — structurally cannot return the secret columns,
    // since they don't exist in what it's selecting from.
    const result = await neonFetch(env, `
      SELECT connection_type, status, broker, connected_at, last_synced_at
      FROM public.portfolio_connections_public
      WHERE clerk_user_id = ${sqlVal(clerkUserId)}
    `);
    return corsResponse({ connection: result.rows?.[0] || null }, 200, origin, env);
  } catch (e) {
    return corsResponse({ error: e.message }, 500, origin, env);
  }
}

async function handleSnapTradeDisconnect(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  try {
    // Full deletion, not a soft "disconnected" status flag — minimizing how
    // long a no-longer-wanted secret sits in storage at all, not just how
    // it's marked.
    await neonFetch(env, `
      DELETE FROM public.portfolio_connections WHERE clerk_user_id = ${sqlVal(clerkUserId)}
    `);
    return corsResponse({ ok: true }, 200, origin, env);
  } catch (e) {
    return corsResponse({ error: e.message }, 500, origin, env);
  }
}

async function handleSnapTradePositions(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  try {
    const conn = await getSnapTradeConnection(env, clerkUserId);
    if (!conn) return corsResponse({ error: 'No active connection' }, 404, origin, env);

    // Endpoint paths below are reconstructed from SnapTrade's documentation
    // prose, not verified against a known test vector the way the signing
    // algorithm above was — worth a real test call against your own test
    // account before trusting this in front of a user, since a wrong path
    // here just 404s rather than silently doing the wrong thing, but it
    // hasn't been proven correct the way the signature math has.
    const accounts = await signSnapTradeRequest(env, 'GET', '/api/v1/accounts', {
      query: { userId: conn.snapTradeUserId, userSecret: conn.userSecret },
    });

    const holdingsByAccount = await Promise.all(
      (accounts || []).map(acct =>
        signSnapTradeRequest(env, 'GET', `/api/v1/accounts/${acct.id}/holdings`, {
          query: { userId: conn.snapTradeUserId, userSecret: conn.userSecret },
        }).then(holdings => ({ account: acct.name || acct.id, holdings }))
      )
    );

    await neonFetch(env, `
      UPDATE public.portfolio_connections SET last_synced_at = now()
      WHERE clerk_user_id = ${sqlVal(clerkUserId)}
    `);

    return corsResponse({ accounts: holdingsByAccount }, 200, origin, env);
    // Note: conn.userSecret goes out of scope here regardless of outcome —
    // never stored, logged, or returned beyond this function.
  } catch (e) {
    console.error('[Worker] SnapTrade positions fetch failed:', e.message); // never logs conn.userSecret
    return corsResponse({ error: e.message }, 500, origin, env);
  }
}



function getUserIdFromAuthHeader(request) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.slice(7);
    const parts = token.split('.');
    const b64 = s => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(b64(parts[1]));
    return payload.sub || null;
  } catch {
    return null;
  }
}

// Unlike getUserIdFromAuthHeader, this actually VERIFIES the JWT signature
// against CLERK_JWKS_URL before trusting the sub claim. Use this — not the
// plain decode above — anywhere identity feeds a security decision: billing
// creation, the free-tier date-floor check, anything that grants access or
// spends money. Fails CLOSED: no CLERK_JWKS_URL configured, or verification
// fails for any reason, returns null rather than trusting the client.
async function verifiedUserId(request, env) {
  if (!env.CLERK_JWKS_URL) return null;
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  try {
    const payload = await verifyClerkJWT(authHeader.slice(7), env.CLERK_JWKS_URL);
    return payload.sub || null;
  } catch {
    return null;
  }
}

// (sqlVal now lives in worker/lib/sql.js — imported at the top of this file —
// so the exact escaping logic under test is the exact logic actually running.)

async function neonFetch(env, query) {
  const connStr = env.NEON_CONNECTION_STRING;
  const u = new URL(connStr);
  const resp = await fetch(`https://${u.hostname}/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': connStr },
    body: JSON.stringify({ query }),
  });
  const text = await resp.text();
  let result;
  try { result = JSON.parse(text); }
  catch { throw new Error(`Neon returned non-JSON response: ${text.slice(0, 200)}`); }
  // Neon's SQL-over-HTTP endpoint returns 200 even for a failed query, with
  // the error described in the body — a silent failure here previously let
  // a broken write (Neon) succeed alongside a correct one (Clerk metadata),
  // with nothing to ever catch the split. Throwing here means the caller's
  // try/catch surfaces it (webhook -> 500 -> Stripe retries; a route ->
  // a real error response instead of quietly pretending nothing happened.
  if (result.error) throw new Error(`Neon query failed: ${result.error}`);
  return result;
}

// Mirrors billing state into Clerk publicMetadata so the frontend can read
// isPro()/hasDataExport()-style checks instantly without an extra network
// round trip. Neon stays the source of truth — this is a read-optimization
// only. Clerk's metadata PATCH endpoint merges shallowly at the top level,
// so calling this with {plan} and later with {hasDataExport} won't clobber
// the other key.
async function syncClerkMetadata(env, clerkUserId, metadataPatch) {
  if (!env.CLERK_SECRET_KEY) return; // not fatal — Neon is still correct
  try {
    await fetch(`https://api.clerk.com/v1/users/${clerkUserId}/metadata`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${env.CLERK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ public_metadata: metadataPatch }),
    });
  } catch (e) {
    console.error('[Worker] Clerk metadata sync failed:', e.message);
    // Don't fail the webhook over this — Neon already has the correct state.
  }
}

function planFromPriceId(env, priceId) {
  return priceId === env.STRIPE_PRICE_PRO ? 'pro' : 'free';
}

// ── Stripe webhook ───────────────────────────────────────────────────────────
// Verifies Stripe's signature against the RAW body (never JSON.parse before
// verifying) and upserts subscription state. This is the ONLY writer of
// public.subscriptions — never trust plan/status from the client.
async function handleStripeWebhook(request, env) {
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
    apiVersion: '2024-06-20',
  });

  const sig = request.headers.get('Stripe-Signature') || '';
  const rawBody = await request.text(); // raw — must not be parsed before this

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody, sig, env.STRIPE_WEBHOOK_SECRET,
      undefined, Stripe.createSubtleCryptoProvider()
    );
  } catch (e) {
    console.error('[Worker] Stripe signature verification failed:', e.message);
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 400 });
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const priceId = sub.items?.data?.[0]?.price?.id;
        // current_period_end/start were removed from the top-level Subscription
        // object in Stripe's Basil API version (2025-03-31) and moved to the
        // subscription's line items. This account's webhook endpoint is on a
        // version past that change, so sub.current_period_end is undefined —
        // reading it directly here was producing `to_timestamp(undefined)`,
        // invalid SQL that Neon rejected. neonFetch() now throws on that
        // instead of swallowing it, but the real fix is reading the right field.
        const periodEnd = sub.items?.data?.[0]?.current_period_end || null;
        // Only 'active'/'trialing' actually grants Pro. Every other status —
        // 'incomplete' (checkout started but never paid), 'past_due' (card
        // failing on renewal), 'unpaid', 'incomplete_expired', 'canceled' —
        // maps to 'free'. An earlier version only checked for 'canceled',
        // which meant an abandoned checkout or a failing card kept Pro access.
        const plan = (sub.status === 'active' || sub.status === 'trialing')
          ? planFromPriceId(env, priceId)
          : 'free';
        const clerkUserId = sub.metadata?.clerk_user_id;
        if (!clerkUserId) break; // shouldn't happen — we always set this on creation

        await neonFetch(env, `
          INSERT INTO public.subscriptions
            (clerk_user_id, stripe_customer_id, stripe_subscription_id, plan, status,
             current_period_end, cancel_at_period_end, updated_at)
          VALUES (${sqlVal(clerkUserId)}, ${sqlVal(sub.customer)}, ${sqlVal(sub.id)},
                  ${sqlVal(plan)}, ${sqlVal(sub.status)},
                  ${periodEnd ? `to_timestamp(${periodEnd})` : 'NULL'}, ${sqlVal(sub.cancel_at_period_end)}, now())
          ON CONFLICT (clerk_user_id) DO UPDATE SET
            stripe_customer_id     = EXCLUDED.stripe_customer_id,
            stripe_subscription_id = EXCLUDED.stripe_subscription_id,
            plan                   = EXCLUDED.plan,
            status                 = EXCLUDED.status,
            current_period_end     = EXCLUDED.current_period_end,
            cancel_at_period_end    = EXCLUDED.cancel_at_period_end,
            updated_at              = now()
        `);

        await syncClerkMetadata(env, clerkUserId, { plan });
        break;
      }
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        if (pi.metadata?.product !== 'data_export') break; // not ours to handle
        const clerkUserId = pi.metadata?.clerk_user_id;
        if (!clerkUserId) break;

        await neonFetch(env, `
          INSERT INTO public.data_purchases
            (clerk_user_id, stripe_payment_intent_id, amount_cents, purchased_at)
          VALUES (${sqlVal(clerkUserId)}, ${sqlVal(pi.id)}, ${pi.amount}, now())
          ON CONFLICT (stripe_payment_intent_id) DO NOTHING
        `);
        await syncClerkMetadata(env, clerkUserId, { hasDataExport: true });
        break;
      }
      case 'charge.refunded':
      case 'charge.dispute.created': {
        // Someone got their money back (refund) or is trying to (dispute) —
        // either way, don't let them keep permanent access to the thing they
        // paid for. Dispute objects carry .payment_intent directly too.
        const obj = event.data.object;
        const paymentIntentId = obj.payment_intent;
        if (!paymentIntentId) break;

        const deleted = await neonFetch(env, `
          DELETE FROM public.data_purchases
          WHERE stripe_payment_intent_id = ${sqlVal(paymentIntentId)}
          RETURNING clerk_user_id
        `);
        const clerkUserId = deleted.rows?.[0]?.clerk_user_id;
        if (clerkUserId) {
          // Only clear the metadata flag if they have no OTHER purchases —
          // this is a repeatable product, so a refund on one purchase
          // shouldn't revoke access earned by a separate, legitimate one.
          const remaining = await neonFetch(env,
            `SELECT EXISTS (SELECT 1 FROM public.data_purchases WHERE clerk_user_id = ${sqlVal(clerkUserId)})`
          );
          if (!remaining.rows?.[0]?.exists) {
            await syncClerkMetadata(env, clerkUserId, { hasDataExport: false });
          }
        }
        break;
      }
      case 'charge.dispute.closed': {
        const dispute = event.data.object;
        if (dispute.status !== 'won') break; // 'lost' = stays revoked, matches a refund

        const paymentIntentId = dispute.payment_intent;
        if (!paymentIntentId) break;

        // The row was deleted when the dispute opened, so pull the original
        // clerk_user_id/amount back from Stripe rather than our own DB —
        // we no longer have a local record of it.
        const StripeD = (await import('stripe')).default;
        const stripeD = new StripeD(env.STRIPE_SECRET_KEY, { httpClient: StripeD.createFetchHttpClient(), apiVersion: '2024-06-20' });
        try {
          const pi = await stripeD.paymentIntents.retrieve(paymentIntentId);
          const clerkUserId = pi.metadata?.clerk_user_id;
          if (!clerkUserId || pi.metadata?.product !== 'data_export') break;

          await neonFetch(env, `
            INSERT INTO public.data_purchases
              (clerk_user_id, stripe_payment_intent_id, amount_cents, purchased_at)
            VALUES (${sqlVal(clerkUserId)}, ${sqlVal(pi.id)}, ${pi.amount}, now())
            ON CONFLICT (stripe_payment_intent_id) DO NOTHING
          `);
          await syncClerkMetadata(env, clerkUserId, { hasDataExport: true });
        } catch (e) {
          console.error('[Worker] Failed to restore access after won dispute:', e.message);
        }
        break;
      }
      case 'invoice.payment_failed': {
        // Stripe will retry automatically per its own retry schedule and fire
        // customer.subscription.updated (status -> past_due) separately —
        // nothing to write here, but useful to log for now.
        console.warn('[Worker] Payment failed for invoice', event.data.object.id);
        break;
      }
      default:
        break; // ignore event types we don't act on
    }
  } catch (e) {
    console.error('[Worker] Webhook handler error:', e.message);
    // Return 500 so Stripe retries — we want it to keep trying on our bugs,
    // not silently drop the event.
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
}

// ── Create subscription (Stripe Elements flow) ──────────────────────────────
// Frontend calls this to start checkout, then uses the returned client_secret
// with stripe.confirmPayment() via the PaymentElement.
async function handleCreateSubscription(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  let body;
  try { body = await request.json(); } catch { return corsResponse({ error: 'Invalid JSON' }, 400, origin, env); }
  const { email } = body; // only one recurring plan now — Pro
  const priceId = env.STRIPE_PRICE_PRO;

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient(), apiVersion: '2024-06-20' });

  try {
    // Reuse existing Stripe customer if we already have one on file.
    const existing = await neonFetch(env,
      `SELECT stripe_customer_id FROM public.subscriptions WHERE clerk_user_id = ${sqlVal(clerkUserId)}`
    );
    let customerId = existing.rows?.[0]?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { clerk_user_id: clerkUserId },
      });
      customerId = customer.id;
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
        payment_method_types: ['card'], // keeps the checkout form to just the card fields
      },
      expand: ['latest_invoice.payment_intent'],
      metadata: { clerk_user_id: clerkUserId },
    });

    // TEMP DEBUG — remove once the client_secret issue is diagnosed
    console.log('[Worker] DEBUG subscription.status:', subscription.status);
    console.log('[Worker] DEBUG latest_invoice:', JSON.stringify(subscription.latest_invoice));

    const clientSecret = subscription.latest_invoice.payment_intent.client_secret;
    return corsResponse({ clientSecret, subscriptionId: subscription.id }, 200, origin, env);
  } catch (e) {
    console.error('[Worker] create-subscription failed:', e.message);
    return corsResponse({ error: e.message }, 500, origin, env);
  }
}

// ── Create one-time data purchase ($9.99, not a subscription) ──────────────
// Repeatable — a user can buy this more than once. Uses a PaymentIntent,
// not a Subscription; the frontend uses the same PaymentElement UI either
// way, it just confirms a one-time payment instead of a recurring one.
async function handleCreateDataPurchase(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient(), apiVersion: '2024-06-20' });

  try {
    const existing = await neonFetch(env,
      `SELECT stripe_customer_id FROM public.subscriptions WHERE clerk_user_id = ${sqlVal(clerkUserId)}`
    );
    let customerId = existing.rows?.[0]?.stripe_customer_id;

    let body = {};
    try { body = await request.json(); } catch {}

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: body.email,
        metadata: { clerk_user_id: clerkUserId },
      });
      customerId = customer.id;
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: 999, // $9.99, in cents
      currency: 'usd',
      customer: customerId,
      payment_method_types: ['card'],
      metadata: { clerk_user_id: clerkUserId, product: 'data_export' },
    });

    return corsResponse({ clientSecret: paymentIntent.client_secret }, 200, origin, env);
  } catch (e) {
    console.error('[Worker] create-data-purchase failed:', e.message);
    return corsResponse({ error: e.message }, 500, origin, env);
  }
}

// ── Cancel subscription ──────────────────────────────────────────────────────
// Cancels at period end (not immediately) — user keeps access through what
// they already paid for. The webhook updates our DB when Stripe confirms it.
async function handleCancelSubscription(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  let body = {};
  try { body = await request.json(); } catch {} // feedback is optional — missing/invalid body is fine

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient(), apiVersion: '2024-06-20' });

  try {
    const row = await neonFetch(env,
      `SELECT stripe_subscription_id FROM public.subscriptions WHERE clerk_user_id = ${sqlVal(clerkUserId)}`
    );
    const subId = row.rows?.[0]?.stripe_subscription_id;
    if (!subId) return corsResponse({ error: 'No active subscription' }, 404, origin, env);

    await stripe.subscriptions.update(subId, { cancel_at_period_end: true });

    // Feedback is best-effort — never let a logging failure block the actual
    // cancellation, which is the part the user is actually waiting on.
    if (body.feedback && typeof body.feedback === 'string' && body.feedback.trim()) {
      try {
        await neonFetch(env, `
          INSERT INTO public.cancellation_feedback (clerk_user_id, feedback)
          VALUES (${sqlVal(clerkUserId)}, ${sqlVal(body.feedback.trim().slice(0, 2000))})
        `);
      } catch (e) {
        console.error('[Worker] Failed to store cancellation feedback (non-fatal):', e.message);
      }
    }

    return corsResponse({ ok: true }, 200, origin, env);
  } catch (e) {
    console.error('[Worker] cancel-subscription failed:', e.message);
    return corsResponse({ error: e.message }, 500, origin, env);
  }
}

// ── Reactivate a subscription that's set to cancel at period end ───────────
// Only works before the period actually ends — Stripe just flips
// cancel_at_period_end back off. The webhook's customer.subscription.updated
// handler already updates Neon/Clerk from this same change, so no separate
// write is needed here beyond the Stripe API call itself.
async function handleReactivateSubscription(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient(), apiVersion: '2024-06-20' });

  try {
    const row = await neonFetch(env,
      `SELECT stripe_subscription_id FROM public.subscriptions WHERE clerk_user_id = ${sqlVal(clerkUserId)}`
    );
    const subId = row.rows?.[0]?.stripe_subscription_id;
    if (!subId) return corsResponse({ error: 'No subscription found' }, 404, origin, env);

    await stripe.subscriptions.update(subId, { cancel_at_period_end: false });
    return corsResponse({ ok: true }, 200, origin, env);
  } catch (e) {
    console.error('[Worker] reactivate-subscription failed:', e.message);
    return corsResponse({ error: e.message }, 500, origin, env);
  }
}

// ── Billing status (for the Billing settings tab) ───────────────────────────
async function handleBillingStatus(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  try {
    const subResult = await neonFetch(env,
      `SELECT plan, status, current_period_end, cancel_at_period_end
       FROM public.subscriptions WHERE clerk_user_id = ${sqlVal(clerkUserId)}`
    );
    const subRow = subResult.rows?.[0];

    const purchaseResult = await neonFetch(env,
      `SELECT amount_cents, purchased_at
       FROM public.data_purchases
       WHERE clerk_user_id = ${sqlVal(clerkUserId)}
       ORDER BY purchased_at DESC`
    );
    const dataExports = purchaseResult.rows || [];
    const hasDataExport = dataExports.length > 0;

    if (!subRow) {
      return corsResponse({ plan: 'free', status: 'inactive', hasDataExport, dataExports }, 200, origin, env);
    }
    const { plan, status, current_period_end, cancel_at_period_end } = subRow;
    return corsResponse({ plan, status, current_period_end, cancel_at_period_end, hasDataExport, dataExports }, 200, origin, env);
  } catch (e) {
    console.error('[Worker] billing-status failed:', e.message);
    return corsResponse({ error: e.message }, 500, origin, env);
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
