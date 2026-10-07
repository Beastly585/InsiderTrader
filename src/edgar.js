// src/edgar.js — SEC Form 4 data layer (ES module for Vite)
import cfg from './config.js';
import { api } from './lib/api.js';

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
  // Congress rows are stored as relationship "strong" (the table only allows
  // strong/medium/weak), so tag them here from their CONGRESS_* code. Every
  // badge, filter and name check on the Data page keys off 'congress'.
  const rel = /^CONGRESS/i.test(raw.transactionCode || '') ? 'congress'
    : (raw.relationship || getRel(raw.title, raw.isOfficer));
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

// ── Main data fetch ───────────────────────────────────────────────────────────
// The Worker builds the query now (GET /api/filings, worker/lib/data.js), so
// the browser never sends SQL and the free plan's 12-month window is enforced
// server-side. Auth and the shared token cache come from lib/api.js.
async function fetchFilings(daysBack = 90) {
  const days = daysBack == null ? 'all' : Math.max(1, Math.round(daysBack));
  const data = await api(`/api/filings?days=${days}`);
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
    case 'proxy': return fetchFilings(daysBack);
    default:      return [];
  }
}
