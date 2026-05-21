// src/config.js
window.APP_CONFIG = {
  // "demo" | "neon" | "proxy"
  DATA_SOURCE: "neon",

  // Neon (DATA_SOURCE = "neon")
  NEON_API_URL:  "https://ep-proud-sound-aqxwens1.apirest.c-8.us-east-1.aws.neon.tech",
  NEON_API_KEY:  "napi_6nbvrg910i4j9tg882cinwfdtr1rx4v2bpy4caf08gtlrjubr2vft1qzshg61a3l",
  NEON_DATABASE: "neondb",
  NEON_ROLE:     "neondb_owner",

  // Cloudflare Worker (DATA_SOURCE = "proxy")
  PROXY_URL: "https://YOUR-WORKER.workers.dev",

  DEFAULT_DAYS_BACK: 30,
  PAGE_SIZE: 25,
};
