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
 *                            recurring plan — the $39.99 data export is a
 *                            one-time PaymentIntent, no Price object needed)
 *   CLERK_SECRET_KEY         sk_live_... / sk_test_... — used to mirror plan
 *                            status into Clerk publicMetadata after webhook events
 *   CLERK_JWKS_URL           https://<your-clerk-domain>/.well-known/jwks.json
 *                            — from the PRODUCTION Clerk instance, not Dev
 *   CLERK_WEBHOOK_SECRET     whsec_... — from the Clerk Dashboard's webhook
 *                            endpoint config (Configure > Webhooks), for the
 *                            user.deleted event specifically. This is a
 *                            SEPARATE secret from STRIPE_WEBHOOK_SECRET even
 *                            though both start with whsec_ — Clerk and
 *                            Stripe each issue their own.
 *   SENTRY_DSN               From your Sentry project's settings — error
 *                            monitoring for this Worker (see the withSentry
 *                            wrapper below).
 *
 * Requires `npm install stripe @sentry/cloudflare` in this Worker's
 * package.json. Stripe's SDK runs on Workers via createFetchHttpClient()/
 * createSubtleCryptoProvider(), no Node-specific APIs needed. @sentry/
 * cloudflare DOES need the nodejs_compat compatibility flag set in
 * wrangler.toml/wrangler.json — the SDK won't work without it. As of
 * mid-2025, Cloudflare removed the old zero-code "click to enable" Sentry
 * dashboard integration entirely; this explicit SDK wrapper is the current,
 * correct way to do this, not a fallback.
 */

import { sqlVal } from './lib/sql.js';
import { verifyClerkWebhook } from './lib/clerk-webhook.js';
import { encryptSecret, decryptSecret } from './lib/crypto.js';
import { computeSignature } from './lib/snaptrade-sign.js';
import * as Sentry from '@sentry/cloudflare';

const ALLOWED_ORIGINS = new Set([
  'https://seli.app',
  'https://www.seli.app',
  'https://seli-dgu.pages.dev',
  'https://beastly585.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

const workerHandler = {
  // Runs on a frequent cron schedule (needs [triggers] crons in
  // wrangler.toml — see continueSnapshotBuild's own comment). Each call
  // does one small, bounded increment of work and returns — safe to run
  // as often as every minute on Workers Free, since it's a cheap no-op
  // once the snapshot is caught up. No browser is waiting on any of this.
  async scheduled(event, env, ctx) {
    await continueSnapshotBuild(env);
  },

  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    // Top-level safety net — nothing before this existed. Every other
    // try/catch in this file is scoped to an individual route handler; if
    // something throws in the auth check, the rate limiter, or anywhere
    // in dispatch BEFORE reaching a route's own code, none of that
    // handling would ever run. Sentry's wrapper around this whole object
    // reports errors, it doesn't suppress them, so an uncaught throw here
    // still surfaces to the platform as a bare crash — which is exactly
    // what an opaque 1101 with no CORS headers and no message looks like.
    // This guarantees a real, readable JSON error instead, regardless of
    // where in the pipeline the actual problem turns out to be.
    try {
      return await handleFetchInner(request, env, origin);
    } catch (e) {
      console.error('[Worker] UNCAUGHT top-level exception:', e.message, e.stack?.slice(0, 800));
      return corsResponse({ error: 'Internal error: ' + e.message }, 500, origin, env);
    }
  },
};

async function handleFetchInner(request, env, origin) {
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

    // ── Clerk webhook — same reasoning as Stripe's above. Clerk's requests
    // arrive via Svix with svix-* headers, not an Origin or X-API-Key/JWT
    // we'd recognize, and the Svix signature verified inside the handler
    // IS this route's auth check.
    if (url.pathname === '/clerk/webhook' && request.method === 'POST') {
      return handleClerkWebhook(request, env);
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
    //
    // /public/data-stats is exempt — it was built specifically to require no
    // auth at all (a signed-out landing-page visitor has no Clerk token and
    // must never receive WORKER_API_KEY), but this blanket check runs before
    // the route dispatch even happens, so the route's own "no auth required"
    // design never mattered — every request to it was rejected here first,
    // before ever reaching handlePublicDataStats. That's what caused the 401.
    if ((env.WORKER_API_KEY || env.CLERK_JWKS_URL) && url.pathname !== '/public/data-stats') {
      const authHeader  = request.headers.get('Authorization') || '';
      const apiKey      = request.headers.get('X-API-Key') || '';

      // Try Clerk JWT first if configured
      if (env.CLERK_JWKS_URL && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const valid = await verifyClerkJWT(token, env.CLERK_JWKS_URL).catch(e => {
          // This was previously a silent .catch(() => false) — meaning
          // every JWT failure (expired, key-rotation mismatch, malformed
          // token, JWKS fetch failure) looked identical from the outside:
          // just a bare 401 with no way to tell which one it actually
          // was. Logged here so wrangler tail shows the real reason.
          console.error('[Worker] Clerk JWT verification failed:', e.message);
          return false;
        });
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

    // ── Rate limiting ─────────────────────────────────────────────────────
    // Keyed on the connecting IP rather than the authenticated user, so it
    // covers /public/data-stats too — the one route that skips the auth
    // check above by design (signed-out landing page visitors), and
    // therefore the most exposed to scripted abuse since it needs no
    // credential at all to hit repeatedly.
    //
    // env.RATE_LIMITER only exists once the binding below is added to
    // wrangler.toml and deployed — until then this silently no-ops rather
    // than breaking every request, so this code can ship now and start
    // enforcing the moment the binding is actually provisioned:
    //
    //   [[unsafe.bindings]]
    //   name = "RATE_LIMITER"
    //   type = "ratelimit"
    //   namespace_id = "1001"
    //   simple = { limit = 600, period = 60 }
    //
    if (env.RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) {
          return corsResponse({ error: 'Too many requests — slow down and try again in a moment.' }, 429, origin, env);
        }
      } catch (e) {
        // A rate-limiter failure should never be the reason a real request
        // fails — log it and let the request through rather than turning
        // an infra hiccup into an outage.
        console.error('[Worker] Rate limiter check failed, allowing request:', e.message);
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

    // ── Beta feedback ─────────────────────────────────────────────────────
    if (url.pathname === '/feedback') {
      return handleFeedback(request, env, origin);
    }

    // ── Notification preferences ─────────────────────────────────────────
    if (url.pathname === '/prefs') {
      return handlePrefs(request, env, origin);
    }
    if (url.pathname === '/prefs/test-email') {
      return handleTestEmail(request, env, origin);
    }

    // ── SnapTrade — real per-user portfolio linking ──────────────────────
    // The old /portfolio route (a single shared Alpaca key returning the
    // same data regardless of who called it, with zero authentication)
    // has been removed — it was dead from the frontend's perspective once
    // this was wired in, and its lack of auth meant it stayed live and
    // reachable by anyone who found the URL. Confirmed via grep that
    // nothing in the frontend called it before removing it here.
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
    if (url.pathname === '/snaptrade/performance') {
      return handleSnapTradePerformance(request, env, origin);
    }
    if (url.pathname === '/internal/portfolio-tickers-batch') {
      return handlePortfolioTickersBatch(request, env, origin);
    }
    if (url.pathname === '/public/data-stats') {
      return handlePublicDataStats(request, env, origin);
    }
    // ── Full data export — gated on actually having paid for it ──────────
    // Previously, "Export CSV" was a large query sent through the same
    // generic /query passthrough every other page already uses for normal
    // browsing — nothing there checked whether the caller had bought
    // export access, only the frontend button's own visibility did. Anyone
    // signed in, Pro or not, purchased or not, could replay the exact same
    // request directly and get it for free. This route is the actual gate:
    // it runs before any query executes, not after.
    if (url.pathname === '/export') {
      return handleExport(request, env, origin);
    }
    // Snapshot-based export — serves nearly all of a large export from a
    // pre-built R2 file instead of pulling millions of rows live through
    // Neon on every single purchase. Only the last couple of days (the
    // part that genuinely hasn't been snapshotted yet) still needs a live
    // query, and that's small — a few thousand rows, not millions. This
    // is what actually removes the sustained-connection pressure that
    // kept causing 503s, rather than continuing to optimize how that
    // pressure gets applied.
    if (url.pathname === '/export/snapshot') {
      return handleExportSnapshot(request, env, origin);
    }
    // TEMPORARY (again) — brought back specifically to burst through the
    // one-time initial historical catch-up faster than the 1-minute cron
    // floor allows. Remove once the first full build finishes (watch for
    // {"done":true} in the response, or filings-snapshot.meta.json
    // appearing in R2) — the cron alone is entirely sufficient for
    // ongoing daily increments after that.
    if (url.pathname === '/internal/build-snapshot-now') {
      const apiKey = request.headers.get('X-API-Key') || '';
      const expected = env.WORKER_API_KEY || '';
      let diff = (!expected || apiKey.length !== expected.length) ? 1 : 0;
      for (let i = 0; i < Math.max(apiKey.length, expected.length); i++) {
        diff |= (apiKey.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
      }
      if (diff !== 0) return corsResponse({ error: 'Unauthorized' }, 401, origin, env);
      const result = await continueSnapshotBuild(env);
      return corsResponse(result, result.ok ? 200 : 500, origin, env);
    }

    return handleQuery(request, env, origin);
}

// The actual export — wraps workerHandler with Sentry's current Cloudflare
// Workers SDK. env is available here (unlike a static top-level Sentry.init
// call would allow), which matters since SENTRY_DSN is a per-environment
// Wrangler secret, not a value known at build time. If SENTRY_DSN isn't set
// yet, Sentry's own SDK no-ops rather than throwing — this doesn't need to
// be conditional on our end.
export default Sentry.withSentry(
  (env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0.1, // 10% of requests get full performance tracing — errors are always captured regardless of this number, this only controls trace volume/cost
  }),
  workerHandler
);
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

// ── Full data export — the real access-control gate ─────────────────────────
// Two modes, both requiring a real purchase record, checked server-side:
//
//   mode: 'consume' (default) — used by the Data page's own Export CSV
//   button. Requires a purchase that hasn't been downloaded yet
//   (downloaded_at IS NULL). Marks it consumed on success. This is what
//   makes the purchase genuinely one-time — previously ANY purchase, ever,
//   permanently unlocked unlimited fresh exports for free, which is not
//   what "one-time" is supposed to mean.
//
//   mode: 'redownload' — used by the Settings > Billing "Re-download"
//   button. Requires only that a purchase exists at all (any, used or
//   not) — a deliberate, narrow exception for "I lost the file, get it
//   again," not a second general-purpose export button. Never marks
//   anything as consumed.
//
// Needs a new column: ALTER TABLE public.data_purchases ADD COLUMN
// downloaded_at timestamptz NULL;
// ── Full data export — the real access-control gate ─────────────────────────
// Two modes, both requiring a real purchase record, checked server-side:
//   'consume' (default) — the Data page's own Export button. Requires an
//   unused purchase, marks it used on success.
//   'redownload' — Settings > Billing's "Re-download". Requires only that
//   a purchase exists at all, never marks anything.
//
// Loops internally across several keyset pages per request (pagesPerBatch,
// default 5) instead of one page per client request — this is the actual
// fix for sustained 503s under heavy sequential load: each client-visible
// request used to mean one fresh connection to Neon, so a ~1M row export
// meant 45-100+ separate connections opened in quick succession. Batching
// several pages server-side per request cuts that by 5x or more, which
// matters because retries alone weren't enough — the failures were
// sustained pressure building up, not one-off blips a retry could ride out.
//
// Needs: ALTER TABLE public.data_purchases ADD COLUMN downloaded_at
// timestamptz NULL;
async function handleExport(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  let body;
  try { body = JSON.parse(await request.text()); }
  catch { return corsResponse({ error: 'Invalid JSON' }, 400, origin, env); }

  const mode = body.mode === 'redownload' ? 'redownload' : 'consume';
  const selectCols = body.selectCols || '';
  const whereClause = body.whereClause || '';
  const cursorIn = body.cursor || null;
  const pagesPerBatch = Math.min(Math.max(Number(body.pagesPerBatch) || 5, 1), 10);
  const pageSize = Math.min(Math.max(Number(body.pageSize) || 20000, 1000), 20000);

  if (!selectCols || typeof selectCols !== 'string' || !whereClause || typeof whereClause !== 'string') {
    return corsResponse({ error: 'Missing selectCols or whereClause' }, 400, origin, env);
  }
  // Defense in depth — reject anything that smells like an attempt to
  // break out of the intended SELECT-only shape, even though these pieces
  // are assembled by this app's own frontend, not raw user input.
  const suspicious = /;|--|\/\*|\bDROP\b|\bDELETE\b|\bUPDATE\b|\bINSERT\b/i;
  if (suspicious.test(selectCols) || suspicious.test(whereClause)) {
    return corsResponse({ error: 'Rejected query shape' }, 403, origin, env);
  }

  let purchaseKey;
  try {
    if (mode === 'consume') {
      const result = await neonFetch(env,
        `SELECT stripe_payment_intent_id FROM public.data_purchases
         WHERE clerk_user_id = ${sqlVal(clerkUserId)} AND downloaded_at IS NULL
         ORDER BY purchased_at DESC LIMIT 1`
      );
      purchaseKey = result.rows?.[0]?.stripe_payment_intent_id;
      if (!purchaseKey) {
        return corsResponse({ error: 'You\'ve already used this purchase\'s one-time download — buy again for a fresh export, or use Re-download in Settings > Billing to get the same one again.' }, 403, origin, env);
      }
    } else {
      const result = await neonFetch(env,
        `SELECT 1 FROM public.data_purchases WHERE clerk_user_id = ${sqlVal(clerkUserId)} LIMIT 1`
      );
      if (!(result.rows || []).length) {
        return corsResponse({ error: 'Full data export requires a one-time purchase — see Settings > Billing.' }, 403, origin, env);
      }
    }
  } catch (e) {
    console.error('[Worker] Export purchase check failed:', e.message);
    return corsResponse({ error: 'Could not verify export access — try again in a moment.' }, 500, origin, env);
  }

  const esc = s => String(s).replace(/'/g, "''");

  try {
    let allRows = [];
    let cursor = cursorIn;
    let done = false;

    for (let i = 0; i < pagesPerBatch; i++) {
      const keysetCondition = cursor
        ? `AND (COALESCE(transaction_date,filing_date), ctid) < ('${esc(cursor.date)}', '${esc(cursor.tid)}'::tid)`
        : '';
      const pageQuery = `
        SELECT ${selectCols},
               COALESCE(transaction_date,filing_date) AS _cursor_date,
               ctid::text AS _cursor_tid
        FROM public.filings
        WHERE ${whereClause} ${keysetCondition}
        ORDER BY COALESCE(transaction_date,filing_date) DESC, ctid
        LIMIT ${pageSize}
      `;
      const pageResult = await neonFetch(env, pageQuery);
      const rows = pageResult.rows || [];

      // First page of the very first batch returning zero rows is worth
      // real diagnostics — later pages returning zero just means we've
      // reached the end, which is normal and expected.
      if (rows.length === 0 && i === 0 && !cursorIn) {
        let diagnostic = { actualQuery: pageQuery };
        try {
          const total = await neonFetch(env, `SELECT COUNT(*) AS cnt FROM public.filings`);
          diagnostic.totalRowsInTable = total.rows?.[0]?.cnt;
          const sample = await neonFetch(env, `SELECT transaction_date, filing_date FROM public.filings ORDER BY filing_date DESC NULLS LAST LIMIT 3`);
          diagnostic.mostRecentDates = sample.rows;
        } catch (diagErr) {
          diagnostic.diagnosticError = diagErr.message;
        }
        console.error('[Worker] Export query returned 0 rows on first page. Diagnostic:', JSON.stringify(diagnostic));
        return corsResponse({ error: 'No matching rows.', diagnostic }, 200, origin, env);
      }

      if (rows.length > 0) {
        const last = rows[rows.length - 1];
        cursor = { date: last._cursor_date, tid: last._cursor_tid };
        allRows = allRows.concat(rows.map(({ _cursor_date, _cursor_tid, ...rest }) => rest));
      }
      if (rows.length < pageSize) { done = true; break; }
    }

    if (mode === 'consume' && purchaseKey) {
      // Mark it used only after at least one page actually succeeded —
      // a failed export shouldn't burn the one-time allowance.
      await neonFetch(env, `UPDATE public.data_purchases SET downloaded_at = now() WHERE stripe_payment_intent_id = ${sqlVal(purchaseKey)}`)
        .catch(e => console.error('[Worker] Failed to mark export consumed (non-fatal):', e.message));
    }

    return corsResponse({ rows: allRows, nextCursor: done ? null : cursor, done }, 200, origin, env);
  } catch (e) {
    return corsResponse({ error: e.message }, 502, origin, env);
  }
}

// Same 16 columns and date-sanitizing CASE expressions as the frontend's
// EXPORT_COLS/dateExpr in app.jsx — kept in sync manually since this runs
// server-side (the scheduled snapshot builder) where there's no client
// request to supply selectCols the way handleExport's live path works.
function exportSelectCols(todayStr) {
  const dateExpr = col => `CASE WHEN ${col}::date >= '2020-01-01'::date AND ${col}::date <= '${todayStr}'::date THEN ${col} END AS ${col}`;
  const cols = ['transaction_date','filing_date','ticker','company_name','insider_name','insider_title',
    'transaction_type','transaction_code','is_open_market','shares','price_per_share',
    'value','pct_owned_change','relationship','sector','footnotes'];
  return cols.map(c => {
    if (c === 'transaction_date' || c === 'filing_date') return dateExpr(c);
    if (c==='shares'||c==='price_per_share'||c==='value'||c==='pct_owned_change') return `${c}::float`;
    return c;
  }).join(',\n           ');
}

// ── Scheduled snapshot builder ──────────────────────────────────────────────
// Needs, in wrangler.toml:
//   [[r2_buckets]]
//   binding = "EXPORT_SNAPSHOTS"
//   bucket_name = "<your bucket name>"
//   [triggers]
//   crons = ["0 6 * * *"]   # once daily — historical data doesn't change
//                            # fast enough to need more than this
//
// Streams rows straight into R2 as NDJSON (one JSON object per line) via a
// TransformStream — never accumulates the full dataset in memory
// regardless of how large it grows, which matters because this can be
// millions of rows. Cutoff is 2 days back from today, not today itself —
// a deliberate safety buffer against any late-arriving ingestion for the
// most recent day or two, which handleExportSnapshot's live delta query
// covers anyway.
// Rows fetched (and JSON.stringify'd) per invocation. Conservative
// starting point for Workers Free's 10ms CPU budget — CPU time excludes
// time spent awaiting Neon, but every stringify call and string
// concatenation counts, and it accumulates across the whole invocation.
// This is a real tuning knob, not a guess I'm confident is exactly right:
// if invocations still fail, lower this first. If they consistently
// succeed with room to spare, it can be raised to finish the initial
// build faster.
const RAW_CHUNK_ROWS = 5000;
// How many small raw parts get merged into one final compacted part.
// Compaction is cheap (concatenating already-serialized text, no
// re-stringify), so this can stay conservative on the CPU side — the
// real constraint it's balancing is the 50-subrequests-per-request limit
// on the SERVING side, which has to read back every compacted part in
// one HTTP request. 20 raw parts of ~5,000 rows each means one compacted
// part covers ~100,000 rows, keeping the total part count well under 50
// even for a multi-million-row table.
const COMPACT_GROUP_SIZE = 20;

// One small, bounded increment of the snapshot build. Meant to be called
// repeatedly (by a frequent cron, or manually for testing) — each call
// does at most one Neon fetch, one small serialization pass, and
// occasionally a compaction pass, then returns. State lives in R2
// (filings-snapshot-build-state.json) between calls, so progress survives
// across invocations and across Worker restarts.
//
// Self-paced: if the snapshot is already caught up through today (minus
// the 2-day safety buffer), this is a cheap no-op — safe to call as
// frequently as every minute without wasting real work once the initial
// build finishes and only daily increments remain.
async function continueSnapshotBuild(env) {
  if (!env.EXPORT_SNAPSHOTS) {
    return { ok: false, error: 'EXPORT_SNAPSHOTS R2 binding not configured in this environment' };
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 2);
  const targetCutoff = cutoff.toISOString().split('T')[0];

  try {
    // Load in-progress state, or figure out whether a new catch-up is due.
    let state;
    const stateObj = await env.EXPORT_SNAPSHOTS.get('filings-snapshot-build-state.json');
    if (stateObj) {
      state = JSON.parse(await stateObj.text());
    } else {
      const metaObj = await env.EXPORT_SNAPSHOTS.get('filings-snapshot.meta.json');
      const meta = metaObj ? JSON.parse(await metaObj.text()) : null;
      const builtThrough = meta?.builtThrough || '2019-12-31'; // no snapshot yet — start from before the real data begins
      if (builtThrough >= targetCutoff) {
        return { ok: true, idle: true, builtThrough }; // already current, nothing to do
      }
      state = {
        fromDate: builtThrough,
        targetCutoff,
        cursor: null,
        nextRawIndex: 0,
        pendingRawKeys: [],
        nextCompactedIndex: meta?.partCount || 0,
      };
    }

    const selectCols = exportSelectCols(state.targetCutoff);
    const keysetCondition = state.cursor
      ? `AND (COALESCE(transaction_date,filing_date), ctid) < ('${state.cursor.date.replace(/'/g,"''")}', '${state.cursor.tid.replace(/'/g,"''")}'::tid)`
      : '';
    const pageQuery = `
      SELECT ${selectCols},
             COALESCE(transaction_date,filing_date) AS _cursor_date,
             ctid::text AS _cursor_tid
      FROM public.filings
      WHERE COALESCE(transaction_date,filing_date)::date > '${state.fromDate}'::date
        AND COALESCE(transaction_date,filing_date)::date <= '${state.targetCutoff}'::date
        ${keysetCondition}
      ORDER BY COALESCE(transaction_date,filing_date) DESC, ctid
      LIMIT ${RAW_CHUNK_ROWS}
    `;
    const result = await neonFetch(env, pageQuery);
    const rows = result.rows || [];

    if (rows.length > 0) {
      let chunk = '';
      for (const row of rows) {
        const { _cursor_date, _cursor_tid, ...clean } = row;
        chunk += JSON.stringify(clean) + '\n';
      }
      const rawKey = `filings-snapshot-raw/${String(state.nextRawIndex).padStart(6, '0')}.ndjson`;
      await env.EXPORT_SNAPSHOTS.put(rawKey, chunk);
      state.pendingRawKeys.push(rawKey);
      state.nextRawIndex += 1;

      const last = rows[rows.length - 1];
      state.cursor = { date: last._cursor_date, tid: last._cursor_tid };
    }

    const reachedEnd = rows.length < RAW_CHUNK_ROWS;
    const shouldCompact = state.pendingRawKeys.length >= COMPACT_GROUP_SIZE || (reachedEnd && state.pendingRawKeys.length > 0);

    if (shouldCompact) {
      // Cheap — just concatenating already-serialized text from a handful
      // of small objects, no re-stringify, no re-touching Postgres.
      let combined = '';
      for (const key of state.pendingRawKeys) {
        const obj = await env.EXPORT_SNAPSHOTS.get(key);
        if (obj) combined += await obj.text();
      }
      const compactedKey = `filings-snapshot-parts/${String(state.nextCompactedIndex).padStart(6, '0')}.ndjson`;
      await env.EXPORT_SNAPSHOTS.put(compactedKey, combined);
      for (const key of state.pendingRawKeys) {
        await env.EXPORT_SNAPSHOTS.delete(key).catch(()=>{});
      }
      state.nextCompactedIndex += 1;
      state.pendingRawKeys = [];
    }

    if (reachedEnd) {
      await env.EXPORT_SNAPSHOTS.put('filings-snapshot.meta.json', JSON.stringify({
        builtThrough: state.targetCutoff,
        partCount: state.nextCompactedIndex,
        updatedAt: new Date().toISOString(),
      }));
      await env.EXPORT_SNAPSHOTS.delete('filings-snapshot-build-state.json').catch(()=>{});
      console.log(`[Worker] Snapshot caught up through ${state.targetCutoff}, ${state.nextCompactedIndex} parts.`);
      return { ok: true, done: true, builtThrough: state.targetCutoff, parts: state.nextCompactedIndex };
    }

    await env.EXPORT_SNAPSHOTS.put('filings-snapshot-build-state.json', JSON.stringify(state));
    return { ok: true, done: false, rowsThisStep: rows.length, rawPartsSoFar: state.nextRawIndex, compactedPartsSoFar: state.nextCompactedIndex };
  } catch (e) {
    console.error('[Worker] Snapshot build step failed:', e.message, e.stack?.slice(0, 500));
    return { ok: false, error: e.message };
  }
}

// ── Serves the pre-built snapshot + a small live delta ──────────────────────
// Same purchase-check semantics as handleExport (consume vs redownload).
// If no snapshot has been built yet (R2 not configured, or the first cron
// run hasn't happened), returns snapshot_not_ready so the frontend can
// fall back to the older, slower-but-always-available /export batching
// path rather than fail outright.
async function handleExportSnapshot(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  let body;
  try { body = JSON.parse(await request.text()); }
  catch { return corsResponse({ error: 'Invalid JSON' }, 400, origin, env); }
  const mode = body.mode === 'redownload' ? 'redownload' : 'consume';

  if (!env.EXPORT_SNAPSHOTS) {
    return corsResponse({ error: 'snapshot_not_ready' }, 200, origin, env);
  }

  let purchaseKey;
  try {
    if (mode === 'consume') {
      const result = await neonFetch(env,
        `SELECT stripe_payment_intent_id FROM public.data_purchases
         WHERE clerk_user_id = ${sqlVal(clerkUserId)} AND downloaded_at IS NULL
         ORDER BY purchased_at DESC LIMIT 1`
      );
      purchaseKey = result.rows?.[0]?.stripe_payment_intent_id;
      if (!purchaseKey) {
        return corsResponse({ error: 'You\'ve already used this purchase\'s one-time download — buy again for a fresh export, or use Re-download in Settings > Billing to get the same one again.' }, 403, origin, env);
      }
    } else {
      const result = await neonFetch(env,
        `SELECT 1 FROM public.data_purchases WHERE clerk_user_id = ${sqlVal(clerkUserId)} LIMIT 1`
      );
      if (!(result.rows || []).length) {
        return corsResponse({ error: 'Full data export requires a one-time purchase — see Settings > Billing.' }, 403, origin, env);
      }
    }
  } catch (e) {
    console.error('[Worker] Export purchase check failed:', e.message);
    return corsResponse({ error: 'Could not verify export access — try again in a moment.' }, 500, origin, env);
  }

  let meta;
  try {
    const metaObj = await env.EXPORT_SNAPSHOTS.get('filings-snapshot.meta.json');
    if (!metaObj) return corsResponse({ error: 'snapshot_not_ready' }, 200, origin, env);
    meta = JSON.parse(await metaObj.text());
  } catch (e) {
    return corsResponse({ error: 'snapshot_not_ready' }, 200, origin, env);
  }
  if (!meta.partCount) return corsResponse({ error: 'snapshot_not_ready' }, 200, origin, env);

  // The only live query in this whole path — everything up to the
  // snapshot's cutoff already came from R2 above. This is a few thousand
  // rows at most (a couple of days of ingestion), not millions, so it
  // doesn't need pagination or batching at all.
  const today = new Date().toISOString().split('T')[0];
  const deltaQuery = `
    SELECT ${exportSelectCols(today)}
    FROM public.filings
    WHERE COALESCE(transaction_date,filing_date)::date > '${meta.builtThrough}'::date
    ORDER BY COALESCE(transaction_date,filing_date) DESC
  `;
  let deltaRows = [];
  try {
    const deltaResult = await neonFetch(env, deltaQuery);
    deltaRows = deltaResult.rows || [];
  } catch (e) {
    console.error('[Worker] Delta query failed (serving snapshot without it):', e.message);
    // Snapshot itself is still good — degrade to slightly-stale data
    // rather than failing the whole export over the small live piece.
  }

  if (mode === 'consume' && purchaseKey) {
    await neonFetch(env, `UPDATE public.data_purchases SET downloaded_at = now() WHERE stripe_payment_intent_id = ${sqlVal(purchaseKey)}`)
      .catch(e => console.error('[Worker] Failed to mark export consumed (non-fatal):', e.message));
  }

  // Stream each compacted part straight through in order (passthrough —
  // never buffered into Worker memory), then the small live delta
  // appended as extra NDJSON lines at the end. meta.partCount is kept
  // deliberately small (compaction groups many small raw pieces into
  // fewer, larger ones) specifically so this stays well under the
  // 50-subrequests-per-request limit on Workers Free.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  (async () => {
    try {
      for (let i = 0; i < meta.partCount; i++) {
        const partKey = `filings-snapshot-parts/${String(i).padStart(6, '0')}.ndjson`;
        const partObj = await env.EXPORT_SNAPSHOTS.get(partKey);
        if (!partObj) continue; // shouldn't happen, but one missing part shouldn't kill the whole export
        const reader = partObj.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      }
      let deltaChunk = '';
      for (const row of deltaRows) deltaChunk += JSON.stringify(row) + '\n';
      if (deltaChunk) await writer.write(encoder.encode(deltaChunk));
    } catch (e) {
      console.error('[Worker] Snapshot stream-through failed:', e.message);
    } finally {
      await writer.close().catch(()=>{});
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: { ...corsHeaders(origin, env), 'Content-Type': 'application/x-ndjson' },
  });
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
    if (!(await isProServerSide(env, clerkUserId))) {
      return corsResponse({ error: 'Notification settings are a Pro feature' }, 403, origin, env);
    }
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
// Reusable server-side Pro check — the actual enforcement boundary, not
// just the client-side UI hiding a button. Any authenticated user can call
// a Worker route directly regardless of what the frontend shows them, so
// gating has to happen here too, not only in app.jsx.
async function isProServerSide(env, clerkUserId) {
  const subResult = await neonFetch(env,
    `SELECT status FROM public.subscriptions WHERE clerk_user_id = ${sqlVal(clerkUserId)}`
  );
  const status = subResult.rows?.[0]?.status;
  return status === 'active' || status === 'trialing';
}

async function handleTestEmail(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  try {
    if (!(await isProServerSide(env, clerkUserId))) {
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
    const fromName  = 'Seli - Test Email';
    const appUrl = env.APP_URL || 'https://seli.app';
    // Same brand structure and light-theme colors as send_digests.py /
    // send_instant_alerts.py — this is the first real email a new Pro user
    // sees, so it should look like the same product those two do, not a
    // separate, unstyled fallback.
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Seli — test email</title>
</head>
<body style="margin:0;padding:0;background:#F3F4F6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;overflow:hidden;">
  <tr><td style="background:linear-gradient(135deg,#5A4FE8 0%,#4338C9 60%,#3FBFA0 100%);padding:20px 24px;">
    <span style="color:#ffffff;font-size:18px;font-weight:800;letter-spacing:-0.02em;">Seli</span>
    <span style="color:rgba(255,255,255,0.85);font-size:13px;margin-left:8px;">Test email</span>
  </td></tr>
  <tr><td style="padding:24px 20px 8px;">
    <p style="font-size:14px;color:#111827;margin:0 0 12px;">This is a test email from Seli — if you're reading this, your notification delivery is working correctly.</p>
    <p style="font-size:13px;color:#6B7280;margin:0;">Real digests and instant alerts will look similar to this, populated with actual insider activity matching your Settings.</p>
  </td></tr>
  <tr><td style="padding:20px;">
    <a href="${appUrl}" style="display:inline-block;background:#5A4FE8;color:#ffffff;font-weight:700;font-size:13px;padding:10px 20px;border-radius:8px;text-decoration:none;">Open Seli →</a>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${fromName} <${fromEmail}>`, to: [email], subject: 'Seli — test email', html }),
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
    // Only gate 'add' — same principle as SnapTrade's disconnect staying
    // ungated: removing something should always be allowed regardless of
    // plan (it shrinks usage, not grows it), so a downgraded user isn't
    // trapped unable to clean up their own list.
    if (action==='add' && !(await isProServerSide(env, userId))) {
      return corsResponse({ error: 'Watchlist is a Pro feature' }, 403, origin, env);
    }
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

// ── Beta feedback ────────────────────────────────────────────────────────
// Needs, once:
//   ALTER TABLE public.user_feedback
//     ADD COLUMN IF NOT EXISTS summary TEXT,
//     ADD COLUMN IF NOT EXISTS screenshot_keys JSONB;
// Screenshots ride along in the same JSON POST as base64 data URLs (pasted
// or attached client-side — see FeedbackModal) and land in the same
// EXPORT_SNAPSHOTS R2 bucket already bound for CSV exports, under a
// feedback/ prefix, rather than provisioning a second bucket just for a
// beta feedback form. Only the R2 keys go into Postgres, never the image
// bytes themselves — pull the actual images from the R2 dashboard by key.
const FEEDBACK_MAX_SCREENSHOTS = 4;
const FEEDBACK_MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024; // 5MB, matches the client-side cap
const FEEDBACK_ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

async function handleFeedback(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);

  let body;
  try { body = await request.json(); } catch { return corsResponse({ error: 'Invalid JSON' }, 400, origin, env); }
  const summary = (body.summary || '').trim().slice(0, 200);
  const message = (body.message || '').trim().slice(0, 5000);
  if (!summary) return corsResponse({ error: 'A short summary is required' }, 400, origin, env);
  if (!message) return corsResponse({ error: 'Feedback details are required' }, 400, origin, env);
  const page = (body.page || '').slice(0, 100);
  const screenshotsIn = Array.isArray(body.screenshots) ? body.screenshots.slice(0, FEEDBACK_MAX_SCREENSHOTS) : [];

  // Pull email the same way other routes do — not required to store
  // feedback, but makes following up with someone about their own report
  // far easier than matching by user ID alone.
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
      console.error('[Worker] Failed to fetch email for feedback (non-fatal):', e.message);
    }
  }

  // Screenshots are best-effort — a bad/oversized image or a missing R2
  // binding should never block the text feedback from saving.
  const feedbackId = crypto.randomUUID();
  const screenshotKeys = [];
  if (screenshotsIn.length && !env.EXPORT_SNAPSHOTS) {
    console.error('[Worker] Feedback screenshots submitted but EXPORT_SNAPSHOTS R2 binding is not configured — dropping them, keeping the text feedback.');
  }
  if (env.EXPORT_SNAPSHOTS) {
    for (let i = 0; i < screenshotsIn.length; i++) {
      const shot = screenshotsIn[i] || {};
      const dataUrl = typeof shot.data === 'string' ? shot.data : '';
      const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
      if (!match) continue;
      const [, mime, b64] = match;
      if (!FEEDBACK_ALLOWED_MIME.has(mime)) continue;
      let bytes;
      try { bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); } catch { continue; }
      if (!bytes.byteLength || bytes.byteLength > FEEDBACK_MAX_SCREENSHOT_BYTES) continue;
      const ext = mime.split('/')[1] || 'png';
      const key = `feedback/${feedbackId}/${i}.${ext}`;
      try {
        await env.EXPORT_SNAPSHOTS.put(key, bytes, { httpMetadata: { contentType: mime } });
        screenshotKeys.push(key);
      } catch (e) {
        console.error('[Worker] Failed to store feedback screenshot (non-fatal):', e.message);
      }
    }
  }

  try {
    await neonFetch(env, `
      INSERT INTO public.user_feedback (clerk_user_id, email, summary, message, page, screenshot_keys, created_at)
      VALUES (${sqlVal(clerkUserId)}, ${sqlVal(email)}, ${sqlVal(summary)}, ${sqlVal(message)}, ${sqlVal(page)}, ${sqlVal(JSON.stringify(screenshotKeys))}::jsonb, now())
    `);
    return corsResponse({ ok: true }, 200, origin, env);
  } catch (e) {
    console.error('[Worker] Failed to store feedback:', e.message);
    return corsResponse({ error: 'Could not save your feedback — try again in a moment.' }, 500, origin, env);
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
  if (!(await isProServerSide(env, clerkUserId))) {
    return corsResponse({ error: 'Portfolio linking is a Pro feature' }, 403, origin, env);
  }

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
      try {
        const registerResp = await signSnapTradeRequest(env, 'POST', '/api/v1/snapTrade/registerUser', {
          body: { userId: snapTradeUserId },
        });
        userSecret = registerResp.userSecret;
      } catch (registerErr) {
        // Self-healing recovery: if our local record was deleted (e.g. a
        // disconnect that didn't clean up SnapTrade's side, or manual DB
        // changes) but SnapTrade still has this userId registered, delete
        // the orphaned SnapTrade-side user and retry registration cleanly —
        // rather than leave the user permanently stuck on this error.
        if (/already exist/i.test(registerErr.message)) {
          await signSnapTradeRequest(env, 'DELETE', '/api/v1/snapTrade/deleteUser', {
            query: { userId: snapTradeUserId },
          }).catch(() => {}); // best-effort — proceed to retry regardless
          const retryResp = await signSnapTradeRequest(env, 'POST', '/api/v1/snapTrade/registerUser', {
            body: { userId: snapTradeUserId },
          });
          userSecret = retryResp.userSecret;
        } else {
          throw registerErr;
        }
      }
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
  if (!(await isProServerSide(env, clerkUserId))) {
    return corsResponse({ error: 'Portfolio linking is a Pro feature' }, 403, origin, env);
  }

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
    // Root-cause fix: disconnect must clean up SnapTrade's side too, not
    // just the local row — otherwise a future Connect attempt tries to
    // register a "new" user with an ID SnapTrade still has on file, and
    // gets rejected. Best-effort: if this fails (e.g. already gone,
    // endpoint hiccup), still proceed to delete the local record — a
    // failed remote cleanup shouldn't trap the user unable to disconnect
    // at all, and the self-healing retry in handleSnapTradeConnect covers
    // the case where this step didn't fully succeed.
    const conn = await getSnapTradeConnection(env, clerkUserId);
    if (conn) {
      await signSnapTradeRequest(env, 'DELETE', '/api/v1/snapTrade/deleteUser', {
        query: { userId: conn.snapTradeUserId },
      }).catch(e => console.error('[Worker] SnapTrade deleteUser failed (proceeding with local cleanup):', e.message));
    }

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
  if (!(await isProServerSide(env, clerkUserId))) {
    return corsResponse({ error: 'Portfolio linking is a Pro feature' }, 403, origin, env);
  }

  try {
    const conn = await getSnapTradeConnection(env, clerkUserId);
    if (!conn) return corsResponse({ error: 'No active connection' }, 404, origin, env);

    // The old combined /holdings endpoint is deprecated — confirmed directly
    // from SnapTrade's own docs: it returns HTTP 410 Gone for any account
    // created after April 25, 2026, replaced by separate, finer-grained
    // endpoints. Using the unified positions endpoint (equities + options +
    // futures in one call) plus balances separately, per SnapTrade's own
    // "recommended endpoints to get started" guidance.
    const accounts = await signSnapTradeRequest(env, 'GET', '/api/v1/accounts', {
      query: { userId: conn.snapTradeUserId, userSecret: conn.userSecret },
    });

    const holdingsByAccount = await Promise.all(
      (accounts || []).map(async acct => {
        const [positions, balances] = await Promise.all([
          signSnapTradeRequest(env, 'GET', `/api/v1/accounts/${acct.id}/positions/all`, {
            query: { userId: conn.snapTradeUserId, userSecret: conn.userSecret },
          }),
          signSnapTradeRequest(env, 'GET', `/api/v1/accounts/${acct.id}/balances`, {
            query: { userId: conn.snapTradeUserId, userSecret: conn.userSecret },
          }),
        ]);
        return { account: acct.name || acct.id, positions, balances };
      })
    );

    const tickerSet = new Set();
    for (const h of holdingsByAccount) {
      const list = Array.isArray(h.positions) ? h.positions
        : (h.positions && typeof h.positions === 'object')
          ? (Array.isArray(h.positions.results) ? h.positions.results : Object.values(h.positions).filter(Array.isArray).flat())
          : [];
      for (const p of list) {
        const ticker = p.instrument?.symbol || p.instrument?.raw_symbol;
        if (ticker) tickerSet.add(ticker);
      }
    }

    await neonFetch(env, `
      UPDATE public.portfolio_connections
      SET last_synced_at = now(), cached_tickers = ${sqlVal(JSON.stringify([...tickerSet]))}
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

// ── Internal, server-to-server only. Never reachable from the browser or by
// a regular user's own session token — deliberately does NOT accept the
// Clerk-JWT path that every other endpoint allows, since this is the only
// endpoint in the file that returns MULTIPLE users' data in one response.
// Accepting a regular user's own valid token here would let any signed-in
// user pull every other Pro user's portfolio tickers. Requires the exact
// same X-API-Key mechanism used for the ingestion cron, re-checked
// explicitly here rather than trusting the top-level dispatch check (which
// accepts either mechanism, correctly, for every other route).
async function handlePortfolioTickersBatch(request, env, origin) {
  const apiKey = request.headers.get('X-API-Key') || '';
  const expected = env.WORKER_API_KEY || '';
  let diff = (!expected || apiKey.length !== expected.length) ? 1 : 0;
  for (let i = 0; i < Math.max(apiKey.length, expected.length); i++) {
    diff |= (apiKey.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  if (diff !== 0) return corsResponse({ error: 'Unauthorized' }, 401, origin, env);

  try {
    const rows = await neonFetch(env, `
      SELECT pc.clerk_user_id, pc.last_synced_at, pc.cached_tickers
      FROM public.portfolio_connections pc
      JOIN public.subscriptions s ON s.clerk_user_id = pc.clerk_user_id
      WHERE pc.status = 'active' AND s.status IN ('active','trialing')
    `);

    const result = {};
    // Sequential, not Promise.all — this is a batch cron job, not a
    // user-facing request someone is waiting on, so there's no reason to
    // burst every linked user's SnapTrade call simultaneously and risk
    // rate-limiting. One user's failure is caught and skipped rather than
    // failing the whole batch.
    for (const row of (rows.rows || [])) {
      const clerkUserId = row.clerk_user_id;
      try {
        // Cache check first — this is the actual fix for the polling
        // violation. SnapTrade's own pre-launch checklist caps holdings
        // calls at 4/user/day; this endpoint used to hit their live
        // positions endpoint on every ~15-minute ingest cycle, which
        // worked out to 20+ calls/day/user, five times over their limit.
        // An 8-hour freshness window caps THIS endpoint's own
        // contribution at 3 calls/day/user, leaving real margin — and
        // since the cache is shared with handleSnapTradePositions, a
        // user manually checking their own portfolio also refreshes it,
        // so the two paths draw from the same budget instead of each
        // separately hitting the ceiling.
        const cacheAge = row.last_synced_at ? (Date.now() - new Date(row.last_synced_at).getTime()) : Infinity;
        const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
        if (cacheAge < EIGHT_HOURS_MS && row.cached_tickers) {
          const cached = JSON.parse(row.cached_tickers);
          if (cached.length > 0) result[clerkUserId] = cached;
          continue; // skip the live SnapTrade call entirely
        }

        const conn = await getSnapTradeConnection(env, clerkUserId);
        if (!conn) continue;
        const accounts = await signSnapTradeRequest(env, 'GET', '/api/v1/accounts', {
          query: { userId: conn.snapTradeUserId, userSecret: conn.userSecret },
        });
        const tickers = new Set();
        for (const acct of (accounts || [])) {
          const positions = await signSnapTradeRequest(env, 'GET', `/api/v1/accounts/${acct.id}/positions/all`, {
            query: { userId: conn.snapTradeUserId, userSecret: conn.userSecret },
          });
          const list = Array.isArray(positions) ? positions
            : (positions && typeof positions === 'object')
              ? (Array.isArray(positions.results) ? positions.results : Object.values(positions).filter(Array.isArray).flat())
              : [];
          for (const p of list) {
            const ticker = p.instrument?.symbol || p.instrument?.raw_symbol;
            if (ticker) tickers.add(ticker);
          }
        }
        if (tickers.size > 0) result[clerkUserId] = [...tickers];

        // Refresh the cache so the NEXT run (and any concurrent user page
        // view) can reuse this instead of hitting SnapTrade again.
        await neonFetch(env, `
          UPDATE public.portfolio_connections
          SET last_synced_at = now(), cached_tickers = ${sqlVal(JSON.stringify([...tickers]))}
          WHERE clerk_user_id = ${sqlVal(clerkUserId)}
        `).catch(e => console.error(`[Worker] Failed to cache tickers for ${clerkUserId} (non-fatal):`, e.message));
      } catch (e) {
        console.error(`[Worker] portfolio-tickers-batch: skipping ${clerkUserId} after error:`, e.message);
        // Continue to the next user rather than fail the whole batch over
        // one account's SnapTrade error.
      }
    }

    return corsResponse({ tickers_by_user: result }, 200, origin, env);
  } catch (e) {
    console.error('[Worker] portfolio-tickers-batch failed:', e.message);
    return corsResponse({ error: e.message }, 500, origin, env);
  }
}
// ── Genuinely public, no auth path at all — deliberately not built on the
// generic /query endpoint's auth-fallback behavior, since that fallback can
// send the server-to-server WORKER_API_KEY as a header from unauthenticated
// callers, and that key was specifically designed this session to never
// leave the server side. This route requires nothing, checks nothing, and
// returns exactly one non-sensitive number the landing page needs before
// anyone has signed in.
async function handlePublicDataStats(request, env, origin) {
  try {
    const result = await neonFetch(env,
      `SELECT MIN(COALESCE(transaction_date, filing_date)) AS oldest FROM public.filings`
    );
    const oldest = result.rows?.[0]?.oldest || null;
    return corsResponse({ oldest_filing_date: oldest }, 200, origin, env);
  } catch (e) {
    console.error('[Worker] handlePublicDataStats failed:', e.message);
    return corsResponse({ oldest_filing_date: null }, 200, origin, env); // degrade gracefully — the landing page has a hardcoded fallback for this
  }
}

// Best-effort — SnapTrade's docs mention an account balance history
// endpoint by name (getAccountBalanceHistory) but I don't have its exact
// REST path confirmed the way the positions endpoint was (that one was
// directly named in their docs: /accounts/{accountId}/positions/all). This
// guesses at the path following their established convention. If wrong,
// this fails gracefully — the frontend shows "performance history will
// appear once available" rather than an error, so a wrong guess here
// degrades cleanly rather than breaking anything visible.
async function handleSnapTradePerformance(request, env, origin) {
  const clerkUserId = await verifiedUserId(request, env);
  if (!clerkUserId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);
  if (!(await isProServerSide(env, clerkUserId))) {
    return corsResponse({ error: 'Portfolio linking is a Pro feature' }, 403, origin, env);
  }

  try {
    const conn = await getSnapTradeConnection(env, clerkUserId);
    if (!conn) return corsResponse({ points: [] }, 200, origin, env);

    // Built on prices_history (real historical daily closes, already used
    // reliably elsewhere in the app) rather than SnapTrade's balance-history
    // endpoint, whose exact depth and reliability were never confirmed —
    // this fixed uncertain data with a solid foundation instead of adding
    // more range options on top of it. Trade-off, stated plainly: this
    // shows "if you'd held today's exact position the whole time," not a
    // true reconstruction of value changes as you actually bought/sold —
    // a reasonable, honest approximation, not a hidden simplification.
    const accounts = await signSnapTradeRequest(env, 'GET', '/api/v1/accounts', {
      query: { userId: conn.snapTradeUserId, userSecret: conn.userSecret },
    });

    const holdings = {}; // ticker -> total units held across all accounts
    for (const acct of (accounts || [])) {
      try {
        const positions = await signSnapTradeRequest(env, 'GET', `/api/v1/accounts/${acct.id}/positions/all`, {
          query: { userId: conn.snapTradeUserId, userSecret: conn.userSecret },
        });
        const list = Array.isArray(positions) ? positions
          : (positions && typeof positions === 'object')
            ? (Array.isArray(positions.results) ? positions.results : Object.values(positions).filter(Array.isArray).flat())
            : [];
        for (const p of list) {
          const ticker = p.instrument?.symbol || p.instrument?.raw_symbol;
          const units = parseFloat(p.units) || 0;
          if (!ticker || units === 0) continue;
          holdings[ticker] = (holdings[ticker] || 0) + units;
        }
      } catch { /* this account's positions unavailable — skip, don't fail the whole response */ }
    }

    const tickers = Object.keys(holdings);
    if (tickers.length === 0) return corsResponse({ points: [] }, 200, origin, env);

    const priceRows = await neonFetch(env, `
      SELECT ticker, date, close FROM public.prices_history
      WHERE ticker = ANY(ARRAY[${tickers.map(t => sqlVal(t)).join(',')}])
      ORDER BY ticker, date ASC
    `);

    // Assemble one combined portfolio-value series across all held tickers.
    // Tickers don't always have prices on identical dates, so each ticker
    // forward-fills its own last known price rather than requiring every
    // ticker to have data on every date — otherwise one gap anywhere would
    // silently drop that entire date from the whole portfolio series.
    const byTicker = {};
    for (const row of (priceRows.rows || [])) {
      (byTicker[row.ticker] ||= []).push({ date: row.date, close: parseFloat(row.close) });
    }
    const allDates = [...new Set((priceRows.rows || []).map(r => r.date))].sort();
    const lastKnown = {};
    const points = allDates.map(date => {
      let total = 0;
      for (const ticker of tickers) {
        const rows = byTicker[ticker] || [];
        const match = rows.find(r => r.date === date);
        if (match) lastKnown[ticker] = match.close;
        if (lastKnown[ticker] != null) total += lastKnown[ticker] * holdings[ticker];
      }
      return { date, value: Math.round(total * 100) / 100 };
    });

    return corsResponse({ points }, 200, origin, env);
  } catch (e) {
    console.error('[Worker] Portfolio performance fetch failed:', e.message);
    return corsResponse({ points: [] }, 200, origin, env); // degrade gracefully, don't surface an error for a best-effort feature
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

// ── Clerk webhook — cascading delete on user.deleted ────────────────────────
// Clerk's own account UI (via UserButton -> Manage Account) already lets a
// signed-in user delete their auth account by default. That only removes
// the Clerk identity, though — it does nothing to this app's own Neon rows
// (subscription, preferences, watchlist, portfolio connections), which
// would otherwise sit orphaned forever under a clerk_user_id that no
// longer resolves to anyone. This is the missing other half: listen for
// Clerk's user.deleted event and actually delete the corresponding rows.
//
// Clerk delivers webhooks via Svix, using Svix's own signing scheme, not a
// bespoke one — verified here against Svix's own published test vector
// (secret whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw, a fixed svix-id/timestamp/
// payload, and their documented expected signature) before ever wiring
// this into a real request, since getting webhook verification wrong
// either rejects every legitimate call or accepts forged ones — both bad
// in different directions, so this isn't a place to guess.

async function handleClerkWebhook(request, env) {
  const rawBody = await request.text(); // raw — must not be parsed before verification
  const verified = await verifyClerkWebhook(rawBody, request.headers, env.CLERK_WEBHOOK_SECRET || '');
  if (!verified) {
    console.error('[Worker] Clerk webhook signature verification failed');
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  if (event.type !== 'user.deleted') {
    // Only user.deleted triggers a cascade — every other Clerk event
    // (user.created, session events, etc.) is a no-op here on purpose,
    // acknowledged with 200 so Clerk doesn't retry something we're not
    // handling anyway.
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }

  const clerkUserId = event.data?.id;
  if (!clerkUserId) {
    console.error('[Worker] user.deleted event missing data.id:', rawBody.slice(0, 200));
    return new Response(JSON.stringify({ error: 'Missing user id' }), { status: 400 });
  }
  // Strict format check before this ever touches a SQL string — neonFetch
  // takes a raw query, not a parameterized one (confirmed by reading its
  // actual signature rather than assuming $1-style placeholders were
  // supported, which they aren't). Signature verification above already
  // confirms this payload genuinely came from Clerk, but that doesn't by
  // itself guarantee data.id is a well-formed value safe to interpolate —
  // this regex is what actually makes that safe, matching Clerk's real
  // user id format (e.g. user_2abC123XYZ).
  if (!/^user_[A-Za-z0-9]+$/.test(clerkUserId)) {
    console.error('[Worker] user.deleted event had a malformed data.id, refusing to touch the database:', clerkUserId);
    return new Response(JSON.stringify({ error: 'Malformed user id' }), { status: 400 });
  }

  try {
    // Every user-scoped table, confirmed against the real schema earlier
    // this project — deliberately explicit, one statement per table,
    // rather than a clever generic loop, so it's obvious at a glance
    // exactly what does and doesn't get deleted here.
    await neonFetch(env, `DELETE FROM public.cancellation_feedback WHERE clerk_user_id = ${sqlVal(clerkUserId)}`);
    await neonFetch(env, `DELETE FROM public.data_purchases WHERE clerk_user_id = ${sqlVal(clerkUserId)}`);
    await neonFetch(env, `DELETE FROM public.portfolio_connections WHERE clerk_user_id = ${sqlVal(clerkUserId)}`);
    await neonFetch(env, `DELETE FROM public.subscriptions WHERE clerk_user_id = ${sqlVal(clerkUserId)}`);
    await neonFetch(env, `DELETE FROM public.user_preferences WHERE clerk_user_id = ${sqlVal(clerkUserId)}`);
    await neonFetch(env, `DELETE FROM public.user_watchlist WHERE clerk_user_id = ${sqlVal(clerkUserId)}`);
    console.log(`[Worker] Cascaded delete for clerk_user_id ${clerkUserId} following Clerk user.deleted`);
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (e) {
    console.error('[Worker] Clerk webhook cascade delete failed:', e.message);
    // 500, not 200 — a real failure here should make Clerk retry the
    // webhook rather than silently treat an incomplete deletion as done.
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
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
    // Pull the full row, not just stripe_customer_id — this was the actual
    // bug. A subscription cancelled via /billing/cancel is set to
    // cancel_at_period_end:true but stays status:'active' in Stripe (and
    // in this table) right up until the period actually ends. Hitting this
    // endpoint again during that window — cancel, then resubscribe same
    // day — used to sail straight past that and create a genuinely second
    // Stripe subscription, so the customer ended up on two, both billing.
    // It's worse than a one-time double charge, too: subscriptions is keyed
    // `ON CONFLICT (clerk_user_id) DO UPDATE`, one row per user, so the new
    // subscription's webhook overwrote this row and the first subscription's
    // ID was gone from our DB — Settings > Billing (and this endpoint) had
    // no way to ever see or cancel it again, so it would've kept billing
    // every period indefinitely with nothing showing it existed.
    const existing = await neonFetch(env,
      `SELECT stripe_customer_id, stripe_subscription_id, status, cancel_at_period_end
       FROM public.subscriptions WHERE clerk_user_id = ${sqlVal(clerkUserId)}`
    );
    const row = existing.rows?.[0];
    let customerId = row?.stripe_customer_id;

    // A card that's failing on renewal (status:'past_due') is its own case,
    // not a duplicate-subscription case — Stripe is actively retrying the
    // existing invoice, so creating a second subscription here would mean
    // paying for two once the card issue resolves, but "reactivate" doesn't
    // help either (it only flips cancel_at_period_end, it doesn't fix a bad
    // card). This used to fall into the same bucket as a genuine duplicate
    // below, which was the actual bug reported: Settings > Billing computes
    // Pro-or-not as `plan==='pro' && (status==='active'||status==='trialing')`
    // — past_due isn't in that list, so it correctly shows Free — while this
    // endpoint's LIVE_STATUSES set *did* include past_due, so it blocked
    // upgrading with "you already have one." Two different definitions of
    // "live" that could disagree, landing someone on Free with no way back.
    if (row?.stripe_subscription_id && row.status === 'past_due') {
      return corsResponse({
        error: 'past_due',
        message: "Your last payment didn't go through. Update your payment method to keep Pro active.",
      }, 409, origin, env);
    }

    // Everything else Stripe still considers live must be reactivated or
    // rejected here — never silently duplicated by falling through to
    // creation below. Deliberately the exact same active/trialing check
    // Settings > Billing uses for isProPlan, so the two can't disagree.
    if (row?.stripe_subscription_id && (row.status === 'active' || row.status === 'trialing')) {
      if (row.cancel_at_period_end) {
        // Same Stripe call handleReactivateSubscription makes — resumes the
        // existing subscription on its current cycle. No new charge; the
        // webhook's customer.subscription.updated handler syncs status/plan
        // from this same change, so nothing further to write here.
        await stripe.subscriptions.update(row.stripe_subscription_id, { cancel_at_period_end: false });
        return corsResponse({ reactivated: true }, 200, origin, env);
      }
      // Fully active, not scheduled to cancel — they're already Pro.
      return corsResponse({ error: 'You already have an active Pro subscription.' }, 409, origin, env);
    }

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

    const clientSecret = subscription.latest_invoice.payment_intent.client_secret;
    return corsResponse({ clientSecret, subscriptionId: subscription.id }, 200, origin, env);
  } catch (e) {
    console.error('[Worker] create-subscription failed:', e.message);
    return corsResponse({ error: e.message }, 500, origin, env);
  }
}

// ── Create one-time data purchase ($39.99, not a subscription) ─────────────
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
      amount: 3999, // $39.99, in cents
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
      `SELECT amount_cents, purchased_at, downloaded_at
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
