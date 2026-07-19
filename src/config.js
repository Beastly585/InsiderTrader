// src/config.js
// In Vite, env vars are read from .env.local at build time.
// VITE_ prefix required. Never commit .env.local.
const cfg = {
  DATA_SOURCE:    import.meta.env.VITE_DATA_SOURCE    || 'proxy',
  NEON_PROXY_URL: import.meta.env.VITE_NEON_PROXY_URL || '',
  WORKER_API_KEY: import.meta.env.VITE_WORKER_API_KEY || '',
  FINNHUB_API_KEY:import.meta.env.VITE_FINNHUB_API_KEY|| '',
  ALPACA_LIVE:    import.meta.env.VITE_ALPACA_LIVE === 'true',
  STRIPE_PUBLISHABLE_KEY: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '',
  SENTRY_DSN:     import.meta.env.VITE_SENTRY_DSN     || '',
  DEFAULT_DAYS_BACK: 14,
  PAGE_SIZE: 25,
};

export default cfg;
