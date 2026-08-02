# Seli — Project Handoff Summary (August 2026)

Context for a fresh Claude conversation. This covers everything done across a long session — business planning, data investigation, scoring overhaul, UI work, legal pages, email templates, and mobile fixes. A new chat can pick up wherever Kevin left off.

## What Seli is

Kevin Maresca's (solo founder, mechanical/power engineer turned self-taught full-stack dev, Albuquerque NM) SaaS product: aggregates and scores SEC Form 4 insider trading filings + congressional stock trade disclosures (STOCK Act / PTR filings). Sold as a subscription ($11.99/mo Pro) plus a one-time full-data CSV export ($39.99).

**Entity:** SELI LLC (New Mexico LLC, approval pending as of Aug 2026). Plan: LLC approval → EIN → Mercury bank account → Stripe Live keys.

**Stack:**
- **Frontend**: React app (`app.jsx`), vanilla CSS (`style.css`), Vite build
- **Backend**: Cloudflare Worker (`neon-proxy.js`) — all API routes
- **Database**: Neon Postgres, table `public.filings` — one row per transaction line-item
- **Auth**: Clerk (free up to 50K MAU)
- **Billing**: Stripe (currently test mode, switching to live after EIN/Mercury)
- **Email**: Resend (digests + instant alerts)
- **Storage**: Cloudflare R2 (CSV exports, feedback screenshots)
- **Portfolio linking**: SnapTrade (read-only, $2/connected user/month)
- **Local ops tool**: Flask status dashboard (`localhost:5001`, separate from the product)

---

## What was done this session

### Database & Data Integrity

**Row-count discrepancy — resolved.** Kevin ran backfill for 2017 Q3-Q4 and saw 343K "written" but only 143K rows in the dashboard. Root cause: (1) `write_batch()` returns `len(txns)` not `cur.rowcount`, inflating the count because duplicate CIK entries re-process the same accessions; (2) the dashboard filters `is_open_market = true`, which correctly shows only ~40% of all transactions. Data is clean.

**AAPL data gap — resolved.** Compared against OpenInsider. Missing Cook/Levinson/O'Brien 2026 trades were from an ingestion gap in April-July 2026 (Kevin hadn't backfilled Q2 or started daily fetch until July). Not a code bug.

**Congressional relationship mislabeling — fixed.** `fetch_political_trades.py` hardcoded `relationship = 'strong'`, making every House member display as "C-Suite." Changed to `relationship = 'congress'`. New blue badge. Migration `009_congress_relationship.sql` applied. All files updated: `fetch_political_trades.py`, `edgar.js`, `scoring.js`, `app.jsx`, `style.css`.

**Test data deleted.** "Test Insider" / AAPL row removed from production.

**Backfill status:** Congressional data back to 2015. Corporate data backfilling toward 2003 (SOX electronic filing mandate). Target: 2003 for full 20+ year track record data.

### Scoring Overhaul (Literature-Backed)

**Conviction formula rewritten** in `scoring.js`. Old formula: `(cSuiteBuys×5) + (politicalBuys×5) + (buys−sells) + log₁₀(buyValue) + swingBonus`

New formula:
```
conviction =
  (opportunisticBuys × 5) +   // Cohen, Malloy & Pomorski 2012
  (cSuiteBuys × 2) +          // Ravina & Sapienza 2010
  (politicalBuys × 4) +       // congressional info edge
  buys +                      // Seyhun 1986 — no sell subtraction
  log₁₀(buyValue+1) +         // diminishing dollar value
  swingBonus +                 // position size relative to holdings
  clusterBonus                 // Lakonishok & Lee 2001
```

Key changes:
- **Routine vs. Opportunistic classification** added (Cohen et al. 2012). Migration `010_scoring_upgrade.sql` adds `is_routine` column. Computed from 3+ years of same-month trading history per insider. `fetch_filings_neon.py` updated to refresh routine flags after each ingestion run. The batched migration (v2, no transaction wrapper) was successfully run against Neon.
- **Sells no longer subtract** from conviction (Seyhun 1986, Lakonishok & Lee 2001 — insider sales are diversification noise)
- **Cluster bonus** added (2+ insiders buying same stock = +1, 4+ = +3)
- **C-Suite weighting demoted** from ×5 to ×2 (still a factor but no longer dominant)
- **Market cap weighting** was considered but dropped — historical market cap data requires paid vendors. Scoring works well without it.
- **Quality gate** updated to pass signals with `opportunisticBuys >= 1`

**ConvictionBar UI** changed from 3 tiers to 5 tiers (Very Low / Low / Medium / High / Very High). Max raised from 15 to 20. "Very High" (85%+, bright green) requires a score of 17+ — practically very rare, needs multiple factors converging. Tick marks at 20%/40%/60%/85%.

### Email Templates

Both `send_digests.py` and `send_instant_alerts.py` rewritten:
- **Mobile-first stacked cards** instead of multi-column table rows
- **Advisory language removed**: "to know about" → "with insider activity", "notable activity" → "insider activity", "Insights / Top signals" → "Insider activity / Open-market trades", tier labels "High/Medium/Low" → factual descriptors ("Executive · $1M+", etc.)
- **Preheader text** added (hidden text for inbox previews)
- **Stronger disclaimer**: "This is a factual summary of publicly filed insider trading disclosures, not financial advice or a recommendation to buy or sell any security."
- **Subject lines improved**: single-alert shows ticker + insider name; multi-alert shows count + ticker list preview

### UI Changes

**Guide modal consolidated** from 7 sections to 5: Welcome, Using Seli, Sourcing the Data, Data Scoring, Pro Features. Icons removed from nav (just numbered labels). Section headings in "Using Seli" use `.guide-section-heading` class with bottom border. All content written by Kevin, with citations added to the scoring section (Ravina & Sapienza 2010, Lakonishok & Lee 2001, Seyhun 1986).

**Landing page copy** rewritten by Kevin:
- Hero: "Insiders have an edge that beats the market, which they have to publish. Use it."
- Tagline: "Public data that works for you." (accent color)
- All four feature cards updated (Portfolio, Alerts, Data, Signals)
- Alert snapshot reduced from 4 to 3 rows, now respects dark/light theme (was hardcoded white)
- Data snapshot expanded from 4 to 7 rows

**Legal pages:**
- Entity changed to "SELI LLC" everywhere (ToS, Privacy)
- Dates updated to July 2026
- ToS section 3 expanded with strong public-data / uniform-scoring / notifications-as-delivery framing
- All page footers now cross-link (Home · Help · Terms · Privacy · Cookies)
- Content width set to `max-width: 880px`
- Still pending: full legal rewrite modeled on Stripe's approach (indemnification, CCPA, dispute resolution)

**Dashboard/app UI:**
- Purple left border removed from tile headers (`.dash-tile__title`, `.dash-inner-label`)
- Settings gap above nav fixed (`padding-top: 0` on `.content-area` for settings)
- Settings legal links aligned left
- Sidebar footer line removed (`border-top` on `.sidebar__footer`)
- Settings group double border fixed (`.settings-group > :last-child { border-bottom: none }`)
- Billing spinner gets `minHeight:200` to prevent nav reflow
- Upgrade $ button moved to right of settings icon in nav
- Export CSV button hidden on mobile via `.data-export-btn { display: none }`
- Mobile `page-content` bottom padding reduced
- Skeleton loading rows added (dashboard signals, insights signals, data tab, insider leaderboard)
- Checkout modal widened (720-820px), info panel 38%, mobile padding tightened
- PaymentElement layout changed to `tabs` with `defaultCollapsed: true`
- Signal row mobile layout rearranged (net value on row 1, "More" inline with conviction bar)
- Dashboard tiles `min-height` raised to 400px on mobile
- Top Insiders expand button hidden on mobile
- Watchlist drawer list gets border radii on mobile

**SnapTrade bug fixed:** Canceling the SnapTrade auth flow no longer shows portfolio as "connected." Root cause: `/snaptrade/connect` wrote `status = 'active'` before the user completed auth. Fix: writes `status = 'pending'` now, new `/snaptrade/confirm` endpoint verifies with SnapTrade's API and flips to `'active'` only if real brokerage accounts exist. Client calls `/confirm` on redirect return.

---

## What's still pending

### Immediate (pre-launch)
- **LLC approval** → EIN → Mercury → Stripe Live (Kevin is waiting on LLC)
- **Backfill to 2003** — currently at 2015, running toward 2003
- **Neon snapshot → R2 backup → CSV export finalization** (after backfill completes, verify row counts per year first)
- **Google OAuth** — already approved
- **SnapTrade Alpaca/Fidelity approval** — email SnapTrade at support@snaptrade.com requesting enablement for Kevin's client ID. Draft email provided in conversation.
- **Full legal rewrite** — ToS/Privacy/Cookies modeled on Stripe's approach (indemnification, CCPA/state privacy rights, dispute resolution, data sub-processor transparency). Not yet done — Kevin should review as standalone text before it goes into JSX.
- **PostHog analytics** — recommended, free tier is 1M events/month, install in a morning

### Near-term features
- **10b5-1 plan flagging** — Form 4 XML has this field since 2023 SEC amendment. Parse it, surface as badge, discount in scoring. Cheapest credibility improvement.
- **Post-trade return overlay** — compute 1/3/6-month returns for each open-market buy using Finnhub daily candles. Store as columns. Powers the leaderboard hit-rate with real numbers.
- **Sector signals** — aggregate by sector over trailing window ("4 opportunistic buys across 3 energy companies this week")
- **SEC filing links** — the Data page claims to link to original filings but doesn't. The URL format is deterministic from accession number. Quick feature.
- **Dead-man's-switch on ingestion** — if no new filings land for 48 hours, send an alert email. Prevents silent ingestion gaps like the April 2026 one.

### Future expansions discussed
- **Backtesting** ("If you'd followed every High conviction signal for 5 years, here's your portfolio")
- **Insider network mapping** (cross-board relationships between companies)
- **AI: natural language search** (map plain English to filter params via Sonnet)
- **AI: footnote anomaly detection** (LLM reads Form 4 footnotes for unusual structures)
- **AI: digest personalization** (LLM writes 2-3 sentence human-readable summary of daily activity)

---

## Files to upload to the new chat

**Essential:**
- `app.jsx` — the product UI (8700+ lines)
- `style.css` — all styling (4900+ lines)
- `scoring.js` — conviction formula + signal building + leaderboard processing
- `edgar.js` — data layer, enrich(), fetchFromNeon query
- `neon-proxy.js` — Cloudflare Worker, all API routes including SnapTrade fix

**For ingestion/backend work:**
- `fetch_filings_neon.py` — daily SEC ingestion + routine flag refresh
- `fetch_political_trades.py` — congressional data ingestion
- `backfill_historical.py` — historical SEC backfill
- `send_digests.py` — digest email builder
- `send_instant_alerts.py` — instant alert email builder

**For the Flask dashboard (if it comes up):**
- `checks.py`, `app.py`, `milestones.json`

**This document** — upload it as the first message in the new chat.

---

## Scaling constraints

| Service | Free ceiling | What triggers paid |
|---|---|---|
| Clerk | 50K MAU | Effectively unlimited early |
| Workers | 10M req/mo ($5 paid plan) | ~500K page loads/month |
| Neon | Usage-based | DB size is the cost driver |
| R2 | 10GB / 1M writes | Thousands of CSV customers |
| **Resend** | **3K emails/mo** | **~50-100 Pro users with daily digests** |
| Stripe | 2.9% + $0.30 flat | Every charge |
| SnapTrade | $2/connected user/mo | Every brokerage-linked Pro user |

Resend is the first bottleneck. Paid tier is $20/mo for 50K emails.

---

## Important context

- **Congressional PTR data legal note**: Ethics in Government Act restricts commercial use to "news and communications media." Worth a real lawyer conversation before congressional-data revenue becomes significant. Flagged in `milestones.json` as a metric-triggered milestone (at $500 MRR).
- **The `--resume` flag on `backfill_historical.py` has a partial-accession bug**: if a run is interrupted mid-batch, `--resume` skips the entire accession on the next run, permanently losing the un-written transactions. Kevin is aware and not using `--resume`.
- **Favicon and OG image are working.** Confirmed via screenshots.
- **The app takes a while to load data.** Skeleton loading rows were added to dashboard signals, insights signals, data tab, and insider leaderboard to keep users engaged during fetch.
