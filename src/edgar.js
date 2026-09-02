// src/edgar.js — SEC Form 4 data layer (ES module for Vite)
// No window.APP_CONFIG, no window.EdgarData, no XHR hacks.
// Normal fetch works fine since Babel is gone.
import cfg from './config.js';

// ── Sector map ────────────────────────────────────────────────────────────────
const SECTOR_MAP = {
  Technology:               ['AAPL','MSFT','GOOGL','GOOG','META','NVDA','AMZN','TSLA','INTC','AMD','ORCL','CRM','ADBE','QCOM','TXN','AVGO','NOW','SNOW','PLTR','IBM','CSCO','INTU','DDOG','PANW','CRWD','NET','ZS','MDB','OKTA'],
  Finance:                  ['JPM','BAC','WFC','GS','MS','C','BLK','AXP','V','MA','SCHW','USB','PNC','TFC','COF','SPGI','MCO','ICE','CME','BX','KKR','APO','CG'],
  Healthcare:               ['JNJ','PFE','UNH','ABBV','MRK','LLY','BMY','AMGN','GILD','CVS','MDT','ABT','TMO','DHR','ISRG','REGN','VRTX','BIIB','BSX','SYK','BAX','ILMN'],
  Energy:                   ['XOM','CVX','COP','SLB','PSX','EOG','MPC','VLO','OXY','HES','DVN','HAL','BKR','WMB','KMI','ET','EPD','LNG'],
  'Consumer Staples':       ['WMT','PG','KO','PEP','COST','PM','MO','CL','GIS','KHC','HSY','MKC','TSN','ADM'],
  'Consumer Discretionary': ['AMZN','HD','MCD','NKE','SBUX','LOW','TGT','TJX','EBAY','ROST','BKNG','ABNB','MAR','HLT','CMG','DPZ','DKNG'],
  Industrials:              ['HON','UNP','BA','CAT','GE','MMM','DE','EMR','ETN','ITW','LMT','RTX','NOC','GD','FDX','UPS','DAL','UAL','NSC','CSX'],
  'Real Estate':            ['AMT','PLD','EQIX','CCI','SPG','O','WELL','DLR','PSA','EXR','ARE','VTR'],
  Utilities:                ['NEE','DUK','SO','AEP','EXC','SRE','PCG','ED','FE','XEL','WEC'],
  'Communication Services': ['META','GOOGL','NFLX','DIS','VZ','T','CMCSA','TMUS','SNAP','PINS','RDDT'],
  Materials:                ['LIN','APD','SHW','FCX','NEM','NUE','VMC','DOW','PPG','ALB'],
};

const TICKER_SECTOR = {};
for (const [s, ts] of Object.entries(SECTOR_MAP)) for (const t of ts) TICKER_SECTOR[t] = s;

export const REL_LABELS = { strong: 'Executive', medium: 'Officer', weak: 'Director' };
const OPEN_MARKET = new Set(['P', 'S']);

export function getSector(t) { return TICKER_SECTOR[(t||'').toUpperCase()] || 'Other'; }

// Build a direct link to the SEC EDGAR filing viewer.
// accession format from DB: "0001234567-26-012345"
// URL needs: CIK (no leading zeros) and accession with dashes.
export function secFilingUrl(accessionNumber, cikIssuer) {
  if (!accessionNumber) return null;
  // Some filings (congressional) don't have a CIK — no SEC link possible
  if (!cikIssuer) return null;
  const cik = String(cikIssuer).replace(/^0+/, '');
  const accDashed = accessionNumber; // already has dashes from DB
  const accNoDash = accessionNumber.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/${accDashed}-index.htm`;
}

// Pre-compiled patterns — getRel runs on every row, so these shouldn't
// be re-created on each call.
const RE_CSUITE = /chief|ceo|cfo|coo|cto|cio|cmo|cso|president/;
const RE_OFFICER = /\bsvp\b|\bevp\b|senior v|managing|general counsel|treasurer|controller|secretary/;

function getRel(title, isOfficer) {
  const t = (title||'').toLowerCase();
  if (RE_CSUITE.test(t)) return 'strong';
  if (isOfficer || RE_OFFICER.test(t)) return 'medium';
  return 'weak';
}

export function enrich(raw) {
  // The database provides relationship, sector, and is_open_market for all
  // modern rows — only fall back to client-side computation for legacy rows
  // where these columns are NULL.
  const rel = raw.relationship || getRel(raw.title, raw.isOfficer);
  const value = raw.value != null ? +raw.value
              : (raw.shares && raw.price ? Math.round(raw.shares * +raw.price) : null);
  let signal = 0;
  if (OPEN_MARKET.has(raw.transactionCode)) signal += 2;
  if (rel === 'strong') signal += 2;
  if (rel === 'congress') signal += 2;
  if (rel === 'medium') signal += 1;
  if (raw.isRoutine === false) signal += 3;
  if (value && value >= 1_000_000) signal += 3;
  else if (value && value >= 100_000) signal += 1;
  if (raw.transactionType === 'buy') signal += 1;

  return {
    ...raw,
    sector:       raw.sector || getSector(raw.ticker),
    relationship: rel,
    relLabel:     REL_LABELS[rel] || 'Director',
    value,
    signal,
    isOpenMarket: raw.isOpenMarket ?? OPEN_MARKET.has(raw.transactionCode),
  };
}

// ── Auth header helper ────────────────────────────────────────────────────────
// Shares the poll promise and token cache with app.jsx via window.__seliAuth.
// Whichever file's getAuthHeaders runs first creates the shared state; every
// other caller across both files piggybacks on the same polling loop and the
// same cached token. This eliminates the 0-2s independent polling loop that
// loadFilings (the critical-path query) used to run separately from app.jsx's
// own 15+ callers.
async function getAuthHeaders() {
  if (!window.__seliAuth) window.__seliAuth = { poll: null, token: null, expiry: 0 };
  const auth = window.__seliAuth;

  // Fast path: reuse a recently-fetched token
  if (auth.token && Date.now() < auth.expiry) {
    return { 'Authorization': `Bearer ${auth.token}` };
  }

  // Shared polling loop — same promise as app.jsx's callers
  if (!window.__clerkGetToken) {
    if (!auth.poll) {
      auth.poll = (async () => {
        for (let i = 0; i < 40 && !window.__clerkGetToken; i++) {
          await new Promise(r => setTimeout(r, 50));
        }
        auth.poll = null;
      })();
    }
    await auth.poll;
  }

  if (window.__clerkGetToken) {
    try {
      const token = await window.__clerkGetToken();
      if (token) {
        auth.token = token;
        auth.expiry = Date.now() + 10_000;
        return { 'Authorization': `Bearer ${token}` };
      }
    } catch {}
  }
  return {};
}

// ── Main data fetch ───────────────────────────────────────────────────────────
// Performance notes for the Neon/Worker side:
// - An index on (is_open_market, transaction_date DESC) or a partial index
//   WHERE is_open_market = true ORDER BY transaction_date DESC would turn
//   the narrow-window queries (7d/14d) from sequential scans into index
//   scans — the single biggest server-side win.
// - The Worker could pre-compute and cache the 7-day result set (the
//   default initial load) and serve it from R2/KV, updating on each
//   ingestion run, so the very first page load never hits Neon at all.
async function fetchFromNeon(daysBack = 90) {
  // Absolute floor — matches the earliest data backfilled into Neon.
  // daysBack=null ("All") uses this floor; otherwise the computed date
  // from daysBack will be more recent and override it.
  let floorDate = '2013-01-01';
  if (daysBack != null) {
    const d = new Date();
    d.setDate(d.getDate() - daysBack);
    floorDate = d.toISOString().split('T')[0];
  }

  // Scale the LIMIT to the window size. The 7-day default rarely exceeds
  // ~500 rows; 30d caps around 2-3K; wider windows get the full 50K ceiling.
  // This keeps the JSON payload small for the critical initial load while
  // still allowing full data for Pro users widening to "All".
  const limit = daysBack != null && daysBack <= 7 ? 5000
              : daysBack != null && daysBack <= 30 ? 15000
              : 50000;

  const sql = `
    SELECT
      accession_number,
      cik_issuer,
      filing_date            AS date,
      transaction_date,
      company_name           AS company,
      ticker,
      insider_name,
      insider_title          AS title,
      is_officer,
      transaction_type,
      transaction_code,
      is_open_market,
      shares::float,
      price_per_share::float AS price,
      value::float,
      shares_owned_after::float,
      pct_owned_change::float,
      sector,
      relationship,
      is_routine
    FROM public.filings
    WHERE COALESCE(transaction_date, filing_date) >= '${floorDate}'
      AND COALESCE(transaction_date, filing_date) <= CURRENT_DATE
      AND is_open_market = true
    ORDER BY COALESCE(transaction_date, filing_date) DESC,
             value DESC NULLS LAST
    LIMIT ${limit}
  `;

  // Normal fetch — no XHR needed since Babel is gone
  const res = await fetch(cfg.NEON_PROXY_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...await getAuthHeaders() },
    body:    JSON.stringify({ query: sql }),
  });

  if (!res.ok) throw new Error(`Worker ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  return (data.rows || []).map(r => enrich({
    accessionNumber:      r.accession_number,
    cikIssuer:            r.cik_issuer,
    date:                 r.date,
    transactionDate:      r.transaction_date,
    company:              r.company,
    ticker:               r.ticker,
    insiderName:          r.insider_name,
    title:                r.title,
    isOfficer:            r.is_officer,
    transactionType:      r.transaction_type,
    transactionCode:      r.transaction_code,
    isOpenMarket:         r.is_open_market,
    shares:               r.shares,
    price:                r.price,
    value:                r.value,
    sharesOwnedAfter:     r.shares_owned_after,
    pctOwnedChange:       r.pct_owned_change,
    sector:               r.sector,
    relationship:         r.relationship,
    isRoutine:            r.is_routine,
  }));
}

export async function loadFilings(daysBack = 90) {
  switch (cfg.DATA_SOURCE) {
    case 'neon':
    case 'proxy': return fetchFromNeon(daysBack);
    default:      return [];
  }
}
