// ─────────────────────────────────────────────────────────────────────────────
// worker/index.js  — Cloudflare Worker: CORS proxy for SEC EDGAR EFTS
//
// Deploy:
//   1. npm install -g wrangler
//   2. wrangler login
//   3. wrangler deploy
//
// Then paste the worker URL into src/config.js → PROXY_URL
// ─────────────────────────────────────────────────────────────────────────────

const EDGAR_BASE = "https://efts.sec.gov/LATEST/search-index";

// Fields we care about from each hit
const SOURCE_FIELDS = [
  "period_of_report",
  "file_date",
  "entity_name",
  "display_names",
  "form_type",
].join(",");

export default {
  async fetch(request, env, ctx) {
    // Allow OPTIONS pre-flight
    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);

    // ── Parse caller params ────────────────────────────────────────────────
    const startdt = url.searchParams.get("startdt") || daysAgo(14);
    const enddt   = url.searchParams.get("enddt")   || today();
    const hits    = Math.min(parseInt(url.searchParams.get("hits") || "100"), 200);

    // ── Build EDGAR URL ────────────────────────────────────────────────────
    const edgarUrl = new URL(EDGAR_BASE);
    edgarUrl.searchParams.set("forms",            "4");
    edgarUrl.searchParams.set("dateRange",        "custom");
    edgarUrl.searchParams.set("startdt",          startdt);
    edgarUrl.searchParams.set("enddt",            enddt);
    edgarUrl.searchParams.set("hits.hits.total.value", "true");
    edgarUrl.searchParams.set("_source",          SOURCE_FIELDS);
    // EDGAR uses a non-standard hits param
    edgarUrl.searchParams.set("hits.hits._source", SOURCE_FIELDS);
    edgarUrl.searchParams.set("dateRange",        "custom");

    // Append the raw hits count Edgar uses
    const finalUrl = `${edgarUrl.toString()}&hits.hits.total.value=true`;

    let edgarData;
    try {
      const resp = await fetch(finalUrl, {
        headers: { "User-Agent": "insider-tracker/1.0 (github-pages; contact@example.com)" },
        cf: { cacheTtl: 300, cacheEverything: true },  // cache 5 min at CF edge
      });
      if (!resp.ok) throw new Error(`EDGAR ${resp.status}`);
      edgarData = await resp.json();
    } catch (err) {
      return corsResponse(new Response(
        JSON.stringify({ error: err.message }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      ));
    }

    // ── Parse and enrich hits ──────────────────────────────────────────────
    const rawHits = edgarData?.hits?.hits || [];
    const filings = rawHits.slice(0, hits).map(parseHit);

    const body = JSON.stringify({
      total:    edgarData?.hits?.total?.value || filings.length,
      filings,
    });

    return corsResponse(new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  },
};

// ── Parse a single EDGAR hit into a clean filing object ───────────────────────

const SECTOR_MAP = {
  Technology:              ["AAPL","MSFT","GOOGL","META","NVDA","AMZN","TSLA","INTC","AMD","ORCL","CRM","ADBE","QCOM","TXN","AVGO","NOW","SNOW","PLTR"],
  Finance:                 ["JPM","BAC","WFC","GS","MS","C","BLK","AXP","V","MA","SCHW","USB","PNC","TFC","COF"],
  Healthcare:              ["JNJ","PFE","UNH","ABBV","MRK","LLY","BMY","AMGN","GILD","CVS","MDT","ABT","TMO","DHR"],
  Energy:                  ["XOM","CVX","COP","SLB","PSX","EOG","MPC","VLO","PXD","OXY","HES"],
  "Consumer Staples":      ["WMT","PG","KO","PEP","COST","PM","MO","CL","GIS","KHC"],
  "Consumer Discretionary":["HD","MCD","NKE","SBUX","LOW","TGT","TJX","EBAY"],
  Industrials:             ["HON","UNP","BA","CAT","GE","MMM","DE","EMR","ETN","ITW","LMT","RTX"],
  "Real Estate":           ["AMT","PLD","EQIX","CCI","SPG","O","WELL","DLR"],
  Utilities:               ["NEE","DUK","SO","AEP","EXC","SRE","PCG","ED"],
  "Communication Services":["META","GOOGL","NFLX","DIS","VZ","T","CMCSA","TMUS"],
  Materials:               ["LIN","APD","ECL","SHW","FCX","NEM","NUE","VMC"],
};

const TICKER_REV = {};
for (const [s, ts] of Object.entries(SECTOR_MAP)) for (const t of ts) TICKER_REV[t] = s;

function getSector(ticker) { return TICKER_REV[(ticker||"").toUpperCase()] || "Other"; }

function getRelationship(title) {
  const t = (title||"").toLowerCase();
  if (/chief|ceo|cfo|coo|cto|president/i.test(t)) return "strong";
  if (/officer|svp|evp|senior v|managing/i.test(t)) return "medium";
  return "weak";
}

const REL_LABELS = { strong:"Insider", medium:"Officer", weak:"Director/10%" };

function parseHit(hit) {
  const s = hit._source || {};
  const displayNames = s.display_names || [];

  // display_names format: ["Name (Role)", "Company Name"]
  const firstEntry  = displayNames[0] || "";
  const insiderName = firstEntry.replace(/\s*\(.*\)\s*$/, "").trim() || "Unknown";
  const titleMatch  = firstEntry.match(/\(([^)]+)\)/);
  const title       = titleMatch ? titleMatch[1] : "";
  const company     = s.entity_name || (displayNames[1] || "Unknown");

  // Derive ticker from company name (best-effort; full ticker needs an XML parse)
  const ticker = guessTicker(company);
  const rel    = getRelationship(title);

  return {
    date:            s.period_of_report || s.file_date || "",
    company,
    ticker,
    insiderName,
    title,
    // Transaction type and share count require parsing the full XML filing.
    // The EFTS index doesn't surface these fields, so they're marked unknown
    // here. For full data, use the Supabase path (supabase/fetch_filings.py).
    transactionType: "unknown",
    shares:          null,
    price:           null,
    relationship:    rel,
    relLabel:        REL_LABELS[rel],
    sector:          getSector(ticker),
    accession:       hit._id || "",
    edgarUrl:        hit._id
      ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${hit._id.split("-")[0]}&type=4`
      : null,
  };
}

// Rough ticker guesser from company names for demo purposes
const COMPANY_TICKERS = {
  "apple":     "AAPL", "microsoft":"MSFT", "amazon":   "AMZN", "alphabet": "GOOGL",
  "google":    "GOOGL","meta":     "META", "nvidia":   "NVDA", "tesla":    "TSLA",
  "jpmorgan":  "JPM",  "goldman":  "GS",   "morgan stanley":"MS","berkshire":"BRK",
  "johnson":   "JNJ",  "pfizer":   "PFE",  "exxon":    "XOM",  "chevron":  "CVX",
  "walmart":   "WMT",  "costco":   "COST", "procter":  "PG",   "visa":     "V",
  "mastercard":"MA",   "netflix":  "NFLX", "disney":   "DIS",  "lilly":    "LLY",
};

function guessTicker(name) {
  const lower = (name || "").toLowerCase();
  for (const [k, v] of Object.entries(COMPANY_TICKERS)) {
    if (lower.includes(k)) return v;
  }
  // Fall back to first word, up to 4 uppercase letters
  return (name||"").split(/[\s,.(]/)[0].toUpperCase().replace(/[^A-Z]/g,"").slice(0,5) || "??";
}

// ── CORS helper ───────────────────────────────────────────────────────────────

function corsResponse(response) {
  const r = new Response(response.body, response);
  r.headers.set("Access-Control-Allow-Origin",  "*");
  r.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return r;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split("T")[0];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}
