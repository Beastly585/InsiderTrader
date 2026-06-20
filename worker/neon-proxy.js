// worker/neon-proxy.js
//
// Routes:
//   POST /              { query: "SELECT ..." }  → Neon SQL proxy
//   GET  /portfolio                              → Alpaca account + positions
//   GET  /portfolio/history                      → Alpaca equity curve (90d)
//   GET  /portfolio/orders                       → Alpaca last 50 orders
//
// Secrets (wrangler secret put):
//   NEON_CONNECTION_STRING
//   ALPACA_KEY
//   ALPACA_SECRET
//
// To switch paper → live, add to wrangler.toml [vars]:
//   ALPACA_BASE_URL = "https://api.alpaca.markets"

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsWrap(new Response(null, { status: 204 }), request);
    }

    // ── Alpaca routes (GET /portfolio/*) — MUST come before POST check ──────
    if (url.pathname.startsWith("/portfolio")) {
      return handleAlpaca(url.pathname, env, request);
    }

    // ── Neon SQL proxy (POST /) ───────────────────────────────────────────────
    if (request.method !== "POST") {
      return corsWrap(errResp("Method not allowed", 405), request);
    }

    let body;
    try { body = await request.json(); }
    catch { return corsWrap(errResp("Invalid JSON", 400), request); }

    const { query } = body;
    if (!query || typeof query !== "string") {
      return corsWrap(errResp("Missing query", 400), request);
    }
    if (!query.trim().toUpperCase().startsWith("SELECT")) {
      return corsWrap(errResp("Only SELECT queries allowed", 403), request);
    }

    const connString = env.NEON_CONNECTION_STRING;
    if (!connString) {
      return corsWrap(errResp("NEON_CONNECTION_STRING secret not set", 500), request);
    }

    let host;
    try { host = new URL(connString).hostname; }
    catch { return corsWrap(errResp("Invalid NEON_CONNECTION_STRING format", 500), request); }

    let resp;
    try {
      resp = await fetch(`https://${host}/sql`, {
        method: "POST",
        headers: {
          "Content-Type":           "application/json",
          "Neon-Connection-String": connString,
        },
        body: JSON.stringify({ query }),
      });
    } catch (e) {
      return corsWrap(errResp(`Neon fetch failed: ${e.message}`, 502), request);
    }

    return corsWrap(
      new Response(await resp.text(), {
        status: resp.status,
        headers: { "Content-Type": "application/json" },
      }),
      request
    );
  },
};

// ── Alpaca ────────────────────────────────────────────────────────────────────
async function handleAlpaca(pathname, env, request) {
  const key    = env.ALPACA_KEY;
  const secret = env.ALPACA_SECRET;

  if (!key || !secret) {
    return corsWrap(
      errResp("Alpaca credentials not set — run: wrangler secret put ALPACA_KEY and ALPACA_SECRET", 500),
      request
    );
  }

  const base = env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
  const h = {
    "APCA-API-KEY-ID":     key,
    "APCA-API-SECRET-KEY": secret,
    "Accept":              "application/json",
  };

  try {
    if (pathname === "/portfolio" || pathname === "/portfolio/") {
      const [acctR, posR] = await Promise.all([
        fetch(`${base}/v2/account`,   { headers: h }),
        fetch(`${base}/v2/positions`, { headers: h }),
      ]);
      const account   = await acctR.json();
      const positions = await posR.json();
      return corsWrap(jsonResp({ account, positions }), request);
    }

    if (pathname === "/portfolio/history") {
      const r = await fetch(
        `${base}/v2/account/portfolio/history?period=3M&timeframe=1D`,
        { headers: h }
      );
      return corsWrap(jsonResp(await r.json()), request);
    }

    if (pathname === "/portfolio/orders") {
      const r = await fetch(
        `${base}/v2/orders?status=all&limit=50&direction=desc`,
        { headers: h }
      );
      return corsWrap(jsonResp(await r.json()), request);
    }

    return corsWrap(errResp("Unknown portfolio route", 404), request);

  } catch (e) {
    return corsWrap(errResp(`Alpaca error: ${e.message}`, 502), request);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function corsWrap(response, request) {
  const origin = request.headers.get("Origin") || "*";
  const r = new Response(response.body, response);
  r.headers.set("Access-Control-Allow-Origin",  origin);
  r.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type");
  r.headers.set("Access-Control-Max-Age",       "86400");
  return r;
}

function errResp(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { "Content-Type": "application/json" },
  });
}

function jsonResp(data) {
  return new Response(JSON.stringify(data), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}
