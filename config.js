// ─────────────────────────────────────────────────────────────────────────────
// config.js  — edit this file to change your data source
// ─────────────────────────────────────────────────────────────────────────────

window.APP_CONFIG = {

  // ── Data source ────────────────────────────────────────────────────────────
  // Options: "proxy" | "supabase" | "demo"
  //
  //  "demo"     → uses built-in realistic fake data, no network calls needed.
  //               Great for developing / previewing on GitHub Pages right away.
  //
  //  "proxy"    → calls a Cloudflare Worker that proxies SEC EDGAR.
  //               Free tier handles ~100k requests/day. See worker/index.js.
  //               Deploy the worker and paste its URL below.
  //
  //  "supabase" → reads from your own Postgres DB (via Supabase REST API).
  //               A Python cron job (supabase/fetch_filings.py) keeps it fresh.
  //               Paste your Supabase URL + anon key below.
  //
  DATA_SOURCE: "demo",   // ← change this when you're ready

  // ── Cloudflare Worker proxy (DATA_SOURCE = "proxy") ────────────────────────
  PROXY_URL: "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev",
  // e.g. "https://sec-proxy.acme.workers.dev"

  // ── Supabase (DATA_SOURCE = "supabase") ────────────────────────────────────
  SUPABASE_URL:  "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON: "your-anon-public-key-here",

  // ── Pagination ─────────────────────────────────────────────────────────────
  PAGE_SIZE: 25,

  // ── How many days back to show by default ─────────────────────────────────
  DEFAULT_DAYS_BACK: 14,
};
