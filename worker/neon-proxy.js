// worker/neon-proxy.js
// Proxies SQL queries to Neon using the correct serverless HTTP API.
//
// Setup:
//   wrangler secret put NEON_CONNECTION_STRING
//   ← paste your full connection string:
//     postgresql://neondb_owner:PASSWORD@ep-proud-sound-aqxwens1.c-8.us-east-1.aws.neon.tech/neondb
//
// wrangler.toml needs no vars — everything is in the connection string secret.

export default {
  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return corsWrap(new Response(null, { status: 204 }), request);
    }

    if (request.method !== "POST") {
      return corsWrap(new Response("Method not allowed", { status: 405 }), request);
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
      return corsWrap(errResp("NEON_CONNECTION_STRING secret not set in worker", 500), request);
    }

    // Parse connection string: postgresql://user:pass@host/db
    let user, password, host, database;
    try {
      const u = new URL(connString);
      user     = u.username;
      password = u.password;
      host     = u.hostname;
      database = u.pathname.replace(/^\//, "");
    } catch {
      return corsWrap(errResp("Invalid NEON_CONNECTION_STRING format", 500), request);
    }

    // Neon serverless HTTP API — correct format
    // POST https://{host}/sql
    // Header: Neon-Connection-String: postgresql://user:pass@host/db
    const neonUrl = `https://${host}/sql`;

    let resp;
    try {
      resp = await fetch(neonUrl, {
        method:  "POST",
        headers: {
          "Content-Type":           "application/json",
          "Neon-Connection-String": connString,
        },
        body: JSON.stringify({ query }),
      });
    } catch (e) {
      return corsWrap(errResp(`Fetch failed: ${e.message}`, 502), request);
    }

    const text = await resp.text();
    return corsWrap(
      new Response(text, {
        status:  resp.status,
        headers: { "Content-Type": "application/json" },
      }),
      request
    );
  },
};

function corsWrap(response, request) {
  const origin = request.headers.get("Origin") || "*";
  const r = new Response(response.body, response);
  r.headers.set("Access-Control-Allow-Origin",  origin);
  r.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type");
  r.headers.set("Access-Control-Max-Age",       "86400");
  return r;
}

function errResp(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
