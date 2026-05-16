# SEC Form 4 — Insider Trading Tracker

A fast, filterable dashboard for SEC Form 4 insider trading filings.
Hosted on GitHub Pages with an optional Cloudflare Worker proxy and Supabase backend.

---

## Architecture at a glance

```
GitHub Pages (static HTML/React)
       │
       │  ← reads data from ONE of:
       ▼
┌──────────────┐   ┌──────────────────────────┐   ┌──────────────┐
│  Demo mode   │   │  Cloudflare Worker proxy  │   │   Supabase   │
│  (built-in)  │   │  → proxies SEC EDGAR      │   │  (Postgres)  │
│  zero setup  │   │  free, ~100k req/day      │   │  full history│
└──────────────┘   └──────────────────────────┘   └──────────────┘
                                                          ▲
                                                   Python cron job
                                                   fetches EDGAR daily
```

---

## Quick start (demo mode — 5 minutes)

1. **Fork or clone** this repo on GitHub.
2. In your repo → **Settings → Pages → Source**: set to `GitHub Actions`.
3. Push any commit to `main`. The Actions workflow deploys automatically.
4. Visit `https://<your-username>.github.io/<repo-name>/`

The site runs in **demo mode** with realistic fake data out of the box.

---

## Step 2: Connect live data via Cloudflare Worker (recommended)

The browser can't call SEC EDGAR directly due to CORS headers.
A free Cloudflare Worker acts as a transparent proxy.

### Deploy the worker

```bash
# Install wrangler CLI
npm install -g wrangler
wrangler login

# Deploy from the worker/ directory
cd worker
wrangler deploy
# Output: https://sec-insider-proxy.<your-subdomain>.workers.dev
```

### Point the site at your worker

Edit `src/config.js`:

```js
DATA_SOURCE: "proxy",
PROXY_URL:   "https://sec-insider-proxy.your-subdomain.workers.dev",
```

Commit and push. Done — you now have live EDGAR data.

**Cloudflare Worker free tier**: 100,000 requests/day, no credit card needed.

> **Note:** The EDGAR EFTS index doesn't expose share counts or prices —
> those fields are only in the full XML filings. The proxy returns filing
> metadata (company, insider, date, relationship). For full transaction data,
> use the Supabase path below.

---

## Step 3 (optional): Full data with Supabase + Python cron

This gives you share counts, prices, historical data, and fast queries.

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com), create a free project.

### 2. Run the migration

In the Supabase **SQL Editor**, paste and run:
```
supabase/migrations/001_create_filings.sql
```

### 3. Set environment variables

```bash
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_SERVICE="your-service-role-key"   # Settings → API → service_role
export DAYS_BACK=7
```

### 4. Install Python deps and run

```bash
pip install requests supabase python-dateutil
python supabase/fetch_filings.py
```

### 5. Schedule it as a cron job

```cron
# Run weekdays at 6 PM ET (after markets close)
0 23 * * 1-5 SUPABASE_URL=... SUPABASE_SERVICE=... python /path/to/fetch_filings.py
```

Or use **GitHub Actions** with a scheduled workflow:

```yaml
on:
  schedule:
    - cron: '0 23 * * 1-5'
```

Add `SUPABASE_URL` and `SUPABASE_SERVICE` as GitHub repository secrets.

### 6. Point the site at Supabase

Edit `src/config.js`:

```js
DATA_SOURCE:   "supabase",
SUPABASE_URL:  "https://your-project.supabase.co",
SUPABASE_ANON: "your-anon-key",   // Settings → API → anon/public
```

---

## File structure

```
sec-insider-tracker/
├── index.html                     ← entry point
├── src/
│   ├── config.js                  ← ⭐ edit this to change data source
│   ├── edgar.js                   ← fetch / parse / enrich layer
│   ├── app.jsx                    ← React UI (compiled by Babel in-browser)
│   └── style.css                  ← styles
├── worker/
│   ├── index.js                   ← Cloudflare Worker source
│   └── wrangler.toml              ← Worker config
├── supabase/
│   ├── fetch_filings.py           ← Python ingestion script
│   └── migrations/
│       └── 001_create_filings.sql ← Postgres schema
└── .github/
    └── workflows/
        └── deploy.yml             ← GitHub Pages auto-deploy
```

---

## Do I need Supabase?

| Feature | Demo | Worker proxy | Supabase |
|---|---|---|---|
| Works immediately | ✅ | ✅ (after 10 min setup) | ✅ |
| Live EDGAR data | ❌ | ✅ (metadata only) | ✅ (full) |
| Share counts & prices | ❌ | ❌ | ✅ |
| Historical data (months/years) | ❌ | ❌ | ✅ |
| Fast search & filter | ✅ | ✅ | ✅ (indexed) |
| Cost | Free | Free | Free (up to 500MB) |

**Recommendation**: Start with the Worker proxy for live metadata. Add Supabase
when you want share/price data or historical analysis.

---

## SEC EDGAR rate limits

- Max 10 requests/second per IP
- The Python script sleeps between requests to stay well under this
- The Cloudflare Worker caches responses for 5 minutes at the edge

---

## Roadmap ideas

- [ ] Email/webhook alerts for large insider buys
- [ ] Charts: buy/sell ratio over time, top buyers by sector
- [ ] Cluster view: multiple insiders buying the same stock
- [ ] Export to CSV
- [ ] Mobile-optimized card view
