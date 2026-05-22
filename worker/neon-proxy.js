// worker/neon-proxy.js
// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare Worker: proxies SQL queries to Neon with CORS headers.
// Your GitHub Pages site calls this worker instead of Neon directly.
// The Neon API key never touches the browser.
//
// Deploy:
//   1. npm install -g wrangler
//   2. wrangler login
//   3. cd worker
//   4. wrangler secret put NEON_API_KEY      ← paste your key when prompted
//   5. wrangler deploy
//   6. Copy the worker URL into src/config.js → NEON_PROXY_URL
//
// wrangler.toml (create this in the worker/ folder):
//   name = "neon-proxy"
//   main = "neon-proxy.js"
//   compatibility_date = "2024-01-01"
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGIN = "*"; // restrict to "https://beastly585.github.io" if you want

export default {
  async fetch(request, env) {

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const { query } = body;
    if (!query || typeof query !== "string") {
      return jsonError("Missing 'query' field", 400);
    }

    // Block anything that isn't a SELECT (safety measure)
    const trimmed = query.trim().toUpperCase();
    if (!trimmed.startsWith("SELECT")) {
      return jsonError("Only SELECT queries are allowed", 403);
    }

    // Get config from Worker environment (set via wrangler secret)
    const NEON_API_URL  = env.NEON_API_URL  || "https://ep-proud-sound-aqxwens1.c-8.us-east-1.aws.neon.tech";
    const NEON_API_KEY  = env.NEON_API_KEY;
    const NEON_DATABASE = env.NEON_DATABASE || "neondb";
    const NEON_ROLE     = env.NEON_ROLE     || "neondb_owner";

    if (!NEON_API_KEY) {
      return jsonError("NEON_API_KEY not configured in worker secrets", 500);
    }

    const neonUrl = `${NEON_API_URL}/sql`;
    const host    = NEON_API_URL.replace("https://", "");

    let neonResp;
    try {
      neonResp = await fetch(neonUrl, {
        method:  "POST",
        headers: {
          "Content-Type":           "application/json",
          "Authorization":          `Bearer ${NEON_API_KEY}`,
          "Neon-Connection-String": `postgresql://${NEON_ROLE}@${host}/${NEON_DATABASE}`,
        },
        body: JSON.stringify({ query }),
      });
    } catch (err) {
      return jsonError(`Neon fetch failed: ${err.message}`, 502);
    }

    const data = await neonResp.text();

    return new Response(data, {
      status:  neonResp.status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(request),
      },
    });
  },
};

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin":  ALLOWED_ORIGIN === "*" ? origin : ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age":       "86400",
  };
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
