// src/config.js
window.APP_CONFIG = {
  // "demo" | "neon" | "proxy"
  DATA_SOURCE: "neon",

  // Neon (DATA_SOURCE = "neon")
  NEON_API_URL:  "https://ep-proud-sound-aqxwens1.c-8.us-east-1.aws.neon.tech/neondb/rest/v1",
  NEON_DATABASE: "neondb",
  NEON_ROLE:     "neondb_owner",

  // Cloudflare Worker (DATA_SOURCE = "proxy")
  NEON_PROXY_URL: "https://neon-proxy.beastly-insider-trades.workers.dev/",

  DEFAULT_DAYS_BACK: 14,
  PAGE_SIZE: 25,
};
