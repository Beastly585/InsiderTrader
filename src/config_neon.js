// ─────────────────────────────────────────────────────────────────────────────
// config.js  — edit this file to change your data source
// ─────────────────────────────────────────────────────────────────────────────

window.APP_CONFIG = {

  // ── Data source ────────────────────────────────────────────────────────────
  // Options: "neon" | "proxy" | "demo"
  //
  //  "demo"  → built-in realistic fake data. No setup. Great for previewing.
  //
  //  "proxy" → Cloudflare Worker proxies live SEC EDGAR filings (metadata only).
  //            Free, ~100k req/day. Deploy worker/index.js, paste URL below.
  //
  //  "neon"  → reads from your Neon Postgres via their HTTP Data API.
  //            Full transaction data (shares, price, value). Best option.
  //            Run db/fetch_filings.py to populate, paste connection below.
  //
  DATA_SOURCE: "neon",   // ← change to "neon" once your DB is populated

  // ── Cloudflare Worker proxy (DATA_SOURCE = "proxy") ────────────────────────
  PROXY_URL: "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev",

  // ── Neon (DATA_SOURCE = "neon") ────────────────────────────────────────────
  // From Neon Console → your project → Connection Details
  // Use the HTTP/Data API endpoint, NOT the connection string.
  // Neon Console → "Connect" → toggle to "HTTP" tab → copy the fetch snippet
  NEON_API_URL:  "https://ep-proud-sound-aqxwens1.apirest.c-8.us-east-1.aws.neon.tech",
  NEON_API_KEY:  "napi_6nbvrg910i4j9tg882cinwfdtr1rx4v2bpy4caf08gtlrjubr2vft1qzshg61a3l",   // Neon Console → Account → API Keys
  NEON_DATABASE: "neondb",                   // default DB name (change if different)
  NEON_ROLE:     "neondb_owner",             // default role (change if different)

  // ── Pagination ─────────────────────────────────────────────────────────────
  PAGE_SIZE: 25,

  // ── How many days back to show by default ─────────────────────────────────
  DEFAULT_DAYS_BACK: 14,
};
