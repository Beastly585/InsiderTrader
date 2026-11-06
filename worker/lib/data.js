// worker/lib/data.js
// Named endpoints for the Data page, its explore drawers and onboarding.
// These replace the last places the browser sent raw SQL to the Worker, so
// the generic POST / passthrough can be switched off (see ALLOW_RAW_SQL in
// neon-proxy.js). Every user value goes through sqlVal, a whitelist or a
// strict regex before it touches SQL, and the free-plan 12-month window is
// enforced here rather than trusted from the client.
//
//   GET /api/filings?days=7|30|90|365|all      Data page filings (edgar.js)
//   GET /api/trades?insider=RAW[&om=1]         one person's trades (drawer)
//   GET /api/trades?ticker=NVDA                one stock's trades (drawer)
//   GET /api/price?t=NVDA                      latest close
//   GET /api/leaders?years=2|all&source=&q=&min=2   Insights drawer leaderboard
//   GET /api/sectors                           sector list for filters
//   GET /api/explore?...                       Raw Data drawer (paged, 200/pg)
//   GET /api/samples                           onboarding example trades

import { asDate, buyBreak, isEntityName, buildClusters, isFundName, prettyPerson, prettyCompany, shortRole } from './intel.js';

const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FREE_DAYS = 365;
const HARD_FLOOR = '2013-01-01'; // earliest backfilled data

const likeEsc = s => s.replace(/[\\%_]/g, m => '\\' + m);
const isoDaysAgo = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const bad = (error, status = 400) => ({ __status: status, error });

// Small per-isolate cache for results that are the same for everyone.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  // A request already in flight is shared, unless it's been pending 25s+: if
  // the visitor who started it left, Cloudflare may have cancelled it and it
  // would never finish, leaving everyone after them waiting.
  if (hit?.promise && Date.now() - hit.started < 25000) return hit.promise;
  const promise = fn();
  cache.set(key, { at: 0, promise, started: Date.now() });
  try { const value = await promise; cache.set(key, { at: Date.now(), value }); return value; }
  catch (e) { cache.delete(key); throw e; }
}

export const DATA_ROUTES = { filings, trades, price, leaders, sectors, explore, samples, signals };
export { explore, signals };

// Does public.filings have this column yet? Columns added by a migration can
// ship in code before the migration is run; queries use a fallback until then.
//
// Reads the column list straight from Postgres's catalog (pg_attribute), one
// query for all columns, about a millisecond. It used to ask
// information_schema.columns once per column, which walks every column of
// every table in the database; with TimescaleDB's internal tables that took
// long enough that requests timed out, and a request the visitor gave up on
// never saved its answer, so the next one paid again.
//
// The list is kept for 10 minutes per Worker instance. A lookup that fails or
// takes more than 3 seconds counts as "column not there yet" (the queries
// still work, just without that column) and is retried a minute later.
let colList = { at: 0, ttl: 0, cols: null, pending: null, started: 0 };
async function filingsColumns(ctx) {
  const now = Date.now();
  if (colList.cols && now - colList.at < colList.ttl) return colList.cols;
  // Reuse a lookup already in flight, unless it's stuck (its request may have
  // been cancelled before it finished).
  if (colList.pending && now - colList.started < 5000) return colList.pending;
  colList.started = now;
  colList.pending = Promise.race([
    ctx.db(`SELECT attname FROM pg_catalog.pg_attribute
             WHERE attrelid = 'public.filings'::regclass AND attnum > 0 AND NOT attisdropped`)
      .then(rows => ({ cols: new Set(rows.map(r => r.attname)), ok: true })),
    new Promise(res => setTimeout(() => res(null), 3000)),
  ]).catch(() => null).then(r => {
    colList = r?.ok
      ? { at: Date.now(), ttl: 10 * 60 * 1000, cols: r.cols, pending: null, started: 0 }
      : { at: Date.now(), ttl: 60 * 1000, cols: colList.cols || new Set(), pending: null, started: 0 };
    return colList.cols;
  });
  return colList.pending;
}
export async function hasColumn(ctx, col) {
  return (await filingsColumns(ctx)).has(col);
}
// filings.reversal ('buy' / 'sell' / NULL), from db/migrations/2026-10-24_reversals.sql.
export const reversalSql = async (ctx, alias = 'f.') => ((await hasColumn(ctx, 'reversal')) ? `${alias}reversal` : 'NULL::text');
// filings.offering (bought in a stock offering), from db/migrations/2026-10-28_offerings.sql.
export const offeringSql = async (ctx, alias = 'f.') => ((await hasColumn(ctx, 'offering')) ? `${alias}offering` : 'NULL::boolean');

// ── /api/filings ─────────────────────────────────────────────────────────────
async function filings(ctx, url) {
  const pro = await ctx.isPro();
  const raw = url.searchParams.get('days');
  let days = raw === 'all' ? null : Math.max(1, Math.min(Number(raw) || 90, 5000));
  if (!pro && (days == null || days > FREE_DAYS)) days = FREE_DAYS;
  const floor = days == null ? HARD_FLOOR : isoDaysAgo(days);
  const limit = days != null && days <= 7 ? 5000 : days != null && days <= 30 ? 15000 : 50000;
  const REV = await reversalSql(ctx, '');
  const rows = await ctx.db(`
    SELECT accession_number, cik_issuer, filing_date AS date, transaction_date,
           company_name AS company, ticker, insider_name, insider_title AS title, is_officer,
           transaction_type, transaction_code, is_open_market,
           shares::float, price_per_share::float AS price, value::float,
           shares_owned_after::float, pct_owned_change::float, sector, relationship, is_routine,
           ${REV} AS reversal
      FROM public.filings
     WHERE COALESCE(transaction_date, filing_date) >= '${floor}'
       AND COALESCE(transaction_date, filing_date) <= CURRENT_DATE
       AND is_open_market = true
     ORDER BY COALESCE(transaction_date, filing_date) DESC, value DESC NULLS LAST
     LIMIT ${limit}`);
  return { pro, days, rows };
}

// ── /api/trades ──────────────────────────────────────────────────────────────
async function trades(ctx, url) {
  const { sqlVal } = ctx.deps;
  const pro = await ctx.isPro();
  const insider = (url.searchParams.get('insider') || '').trim().slice(0, 200);
  const ticker = (url.searchParams.get('ticker') || '').trim().toUpperCase();
  const omOnly = url.searchParams.get('om') === '1';
  let who;
  if (insider) who = `LOWER(f.insider_name) = LOWER(${sqlVal(insider)})`;
  else if (TICKER_RE.test(ticker)) who = `f.ticker = ${sqlVal(ticker)}`;
  else return bad('Pass insider or ticker');
  const span = pro ? '' : `AND COALESCE(f.transaction_date, f.filing_date) >= CURRENT_DATE - ${FREE_DAYS}`;
  const rows = await ctx.db(`
    SELECT f.accession_number, f.cik_issuer, f.transaction_date, f.filing_date,
           f.ticker, f.company_name, f.insider_name, f.insider_title AS title, f.is_officer,
           f.transaction_type, f.transaction_code, f.is_open_market, f.is_derivative,
           f.shares::float, f.price_per_share::float AS price, f.value::float,
           f.pct_owned_change::float, f.shares_owned_after::float, f.relationship, f.sector,
           f.is_entity_owner, f.filing_lag_days,
           ph.close::float AS current_price,
           (f.price_per_share > 0 AND ph.close IS NOT NULL
             AND ABS((ph.close - f.price_per_share) / f.price_per_share) >= 3.0) AS is_foreign_price
      FROM public.filings f
      LEFT JOIN LATERAL (SELECT close FROM public.prices_history
                          WHERE ticker = f.ticker ORDER BY date DESC LIMIT 1) ph ON true
     WHERE ${who}
       AND ${omOnly ? 'f.is_open_market = true' : `f.transaction_type IN ('buy','sell')`}
       ${span}
     ORDER BY COALESCE(f.transaction_date, f.filing_date) DESC
     LIMIT 200`);
  return { pro, rows };
}

// ── /api/price ───────────────────────────────────────────────────────────────
async function price(ctx, url) {
  const t = (url.searchParams.get('t') || '').toUpperCase();
  if (!TICKER_RE.test(t)) return bad('Bad ticker');
  const rows = await ctx.db(`SELECT close::float AS close, date FROM public.prices_history
                              WHERE ticker = ${ctx.deps.sqlVal(t)} ORDER BY date DESC LIMIT 1`);
  return { ticker: t, close: rows[0]?.close ?? null };
}

// ── /api/sectors ─────────────────────────────────────────────────────────────
async function sectors(ctx) {
  return cached('sectors', 6 * 3600 * 1000, async () => {
    const rows = await ctx.db(`SELECT DISTINCT sector FROM public.filings WHERE sector IS NOT NULL AND sector <> '' ORDER BY sector`);
    return { sectors: rows.map(r => r.sector) };
  });
}

// ── /api/samples (onboarding) ────────────────────────────────────────────────
async function samples(ctx) {
  return cached('samples', 30 * 60 * 1000, async () => {
    const cols = 'insider_name, ticker, company_name, transaction_type, value::float AS value, filing_date';
    const [corporate, congress, officers] = await Promise.all([
      ctx.db(`SELECT ${cols} FROM public.filings WHERE relationship = 'strong' AND transaction_type = 'buy' AND is_open_market AND value > 100000 AND filing_date <= CURRENT_DATE ORDER BY filing_date DESC LIMIT 1`),
      ctx.db(`SELECT ${cols} FROM public.filings WHERE transaction_code LIKE 'CONGRESS%' AND filing_date <= CURRENT_DATE ORDER BY filing_date DESC LIMIT 1`),
      ctx.db(`SELECT ${cols} FROM public.filings WHERE relationship = 'medium' AND is_open_market AND filing_date <= CURRENT_DATE ORDER BY filing_date DESC LIMIT 1`),
    ].map(p => p.catch(() => [])));
    return { corporate: corporate[0] || null, congress: congress[0] || null, officers: officers[0] || null };
  });
}

// ── /api/explore (Raw Data drawer) ───────────────────────────────────────────
const SORTABLE = new Set(['transaction_date', 'signed_value', 'ticker', 'company_name', 'insider_name', 'transaction_type',
  'shares', 'price_per_share', 'value', 'pct_owned_change', 'relationship']);
const PAGE = 200;

async function explore(ctx, url) {
  const { sqlVal } = ctx.deps;
  const p = url.searchParams;
  const pro = await ctx.isPro();
  const today = new Date().toISOString().slice(0, 10);
  const freeFloor = isoDaysAgo(FREE_DAYS);

  let from = DATE_RE.test(p.get('from') || '') ? p.get('from') : null;
  const days = Number(p.get('days'));
  if (!from && days > 0) from = isoDaysAgo(Math.min(days, 5000));
  if (!from || from < HARD_FLOOR) from = HARD_FLOOR;
  if (!pro && from < freeFloor) from = freeFloor;
  let to = DATE_RE.test(p.get('to') || '') ? p.get('to') : today;
  if (to > today) to = today;

  const c = [
    `COALESCE(transaction_date, filing_date) >= '${from}'`,
    `COALESCE(transaction_date, filing_date) <= '${to}'`,
  ];
  const type = p.get('type');
  if (['buy', 'sell', 'other'].includes(type)) c.push(`transaction_type = '${type}'`);
  const rel = p.get('rel');
  if (['strong', 'medium', 'weak', 'congress'].includes(rel)) c.push(`relationship = '${rel}'`);
  const sector = (p.get('sector') || '').slice(0, 60);
  if (sector) c.push(`sector = ${sqlVal(sector)}`);
  if (p.get('om') === '1') c.push('is_open_market = true');
  // Who traded, by their filed title. Fixed SQL per option, nothing from the URL.
  const ROLE_SQL = {
    exec: `(insider_title ~* '(chief|\\mceo\\M|\\mcfo\\M|\\mcoo\\M|\\mcto\\M|president|chair)')`,
    director: `(insider_title ~* 'director' AND insider_title !~* '(chief|\\mceo\\M|\\mcfo\\M|president)')`,
    owner: `(insider_title ~* '(10%|ten percent)')`,
  };
  if (ROLE_SQL[p.get('role')]) c.push(ROLE_SQL[p.get('role')]);
  // Leave out funds and companies filing as big shareholders (same word list
  // as isEntityName in intel.js; \\y is Postgres's word boundary).
  if (p.get('people') === '1') c.push(`f.insider_name !~* ${ENTITY_SQL}`);
  // Smallest trade to include, in dollars (whole number only, so it's safe in SQL).
  const min = Math.floor(Number(p.get('min')));
  if (min > 0) c.push(`value >= ${Math.min(min, 1e11)}`);
  if (p.get('source') === 'corporate') c.push(`(transaction_code IS NULL OR transaction_code NOT LIKE 'CONGRESS%')`);
  if (p.get('source') === 'political') c.push(`transaction_code LIKE 'CONGRESS%'`);
  if (p.has('tickers')) {
    const ts = (p.get('tickers') || '').toUpperCase().split(',').map(s => s.trim()).filter(t => TICKER_RE.test(t)).slice(0, 200);
    c.push(ts.length ? `ticker IN (${ts.map(sqlVal).join(',')})` : '1=0');
  }
  // "My watchlist": the signed-in user's stocks (mt, comma-separated) and
  // people (mi, '|'-separated raw names), either one matching.
  if (p.get('mine') === '1') {
    const ts = (p.get('mt') || '').toUpperCase().split(',').map(x => x.trim()).filter(t => TICKER_RE.test(t)).slice(0, 200);
    const ns = (p.get('mi') || '').split('|').map(x => x.trim()).filter(Boolean).map(x => x.slice(0, 200)).slice(0, 100);
    const any = [ts.length && `ticker IN (${ts.map(sqlVal).join(',')})`, ns.length && `insider_name IN (${ns.map(sqlVal).join(',')})`].filter(Boolean);
    c.push(any.length ? `(${any.join(' OR ')})` : '1=0');
  }
  const q = (p.get('q') || '').trim().slice(0, 60);
  if (q) {
    const like = sqlVal('%' + likeEsc(q) + '%');
    c.push(`(ticker ILIKE ${like} OR insider_name ILIKE ${like} OR company_name ILIKE ${like})`);
  }
  const where = 'WHERE ' + c.join(' AND ');

  const sort = SORTABLE.has(p.get('sort')) ? p.get('sort') : 'transaction_date';
  const dir = p.get('dir') === 'asc' ? 'ASC' : 'DESC';
  // signed_value: buys count up, sales count down, so "largest" means the
  // biggest buys and the other end is the biggest sales.
  const orderBy = sort === 'transaction_date'
    ? `ORDER BY COALESCE(transaction_date, filing_date) ${dir} NULLS LAST`
    : sort === 'signed_value'
      ? `ORDER BY CASE WHEN transaction_type = 'sell' THEN -value ELSE value END ${dir} NULLS LAST`
      : `ORDER BY ${sort} ${dir} NULLS LAST`;
  const page = Math.max(0, Math.min(Number(p.get('page')) || 0, 500));

  const sig = p.get('sig') === '1';
  const [PLANNED, REV] = sig
    ? await Promise.all([hasColumn(ctx, 'planned').then(h => (h ? 'COALESCE(f.planned, f.is_routine)' : 'f.is_routine')), reversalSql(ctx)])
    : ['NULL::boolean', 'NULL::text'];
  const [rows, count] = await Promise.all([
    ctx.db(`
      SELECT transaction_date, filing_date, ticker, company_name, insider_name, insider_title,
             relationship, transaction_type, transaction_code, is_open_market, accession_number, cik_issuer,
             shares::float, price_per_share::float, value::float, pct_owned_change::float, sector,
             ${PLANNED} AS is_routine, ${REV} AS reversal
        FROM public.filings f ${where}
        ${orderBy}
        LIMIT ${PAGE} OFFSET ${page * PAGE}`),
    page === 0 ? ctx.db(`SELECT COUNT(*)::int AS n FROM public.filings f ${where}`) : null,
  ]);
  if (sig) await addSignals(ctx, rows);
  else for (const r of rows) { delete r.is_routine; delete r.reversal; }
  return { pro, page, page_size: PAGE, from, to, rows, total: count ? count[0]?.n ?? 0 : undefined };
}

// ── Trade signals ────────────────────────────────────────────────────────────
// Funds and companies filing as big shareholders (same word list as
// isEntityName in intel.js; \\y is Postgres's word boundary).
const ENTITY_SQL = `'\\y(INC|LLC|L\\.?P\\.?|LTD|CORP|CO|FUND|TRUST|CAPITAL|CAPITALES|PARTNERS|HOLDINGS|MANAGEMENT|ADVISORS|ADVISERS|GROUP|INVESTMENTS?|VENTURES|FOUNDATION|BANK|PLC|SA|AG|NV|GP|MASTER|LIMITED|COMPANY|GMBH|SE|BV|LLP|SARL|SPA|KG|S\\.A|C\\.V|L\\.L\\.C)\\y'`;
const DT = a => `COALESCE(${a}.transaction_date, ${a}.filing_date)`;
const OM_PERSON_BUY = a => `(${a}.transaction_type = 'buy' AND ${a}.is_open_market AND (${a}.transaction_code IS NULL OR ${a}.transaction_code NOT LIKE 'CONGRESS%'))`;

// Tags for one page of rows, from one extra query over the page's stocks:
//   brk      "First buy in 4 yrs" (buyBreak, the same rule as stock pages)
//   routine  planned under a 10b5-1 plan; rev comes from filings.reversal
// Groups of insiders buying together live in the Signals view (signals()).
async function addSignals(ctx, rows) {
  const { sqlVal } = ctx.deps;
  const isBuy = r => r.transaction_type === 'buy' && r.is_open_market && !String(r.transaction_code || '').startsWith('CONGRESS') && r.ticker;
  const tickers = [...new Set(rows.filter(isBuy).map(r => r.ticker))];
  const hist = new Map(); // ticker -> Map(name -> { first, buys: [iso dates] })
  if (tickers.length) {
    const h = await ctx.db(`
      SELECT g.ticker, g.insider_name, MIN(${DT('g')}) AS first_seen,
             ARRAY_AGG(${DT('g')}::text) FILTER (WHERE ${OM_PERSON_BUY('g')}) AS buys
        FROM public.filings g
       WHERE g.ticker IN (${tickers.map(sqlVal).join(',')}) AND g.transaction_type IN ('buy','sell')
         AND ${DT('g')} >= DATE '2013-01-01'
       GROUP BY g.ticker, g.insider_name`);
    for (const x of h) {
      if (!hist.has(x.ticker)) hist.set(x.ticker, new Map());
      hist.get(x.ticker).set(x.insider_name, { first: asDate(x.first_seen), buys: (x.buys || []).map(asDate).filter(Boolean) });
    }
  }
  const DAY = 86400000;
  const t = d => Date.parse(d + 'T00:00:00Z');
  for (const r of rows) {
    const out = {};
    if (r.is_routine === true) out.routine = true;
    if (r.reversal === 'buy' || r.reversal === 'sell') out.rev = r.reversal;
    const d = asDate(r.transaction_date || r.filing_date);
    const people = isBuy(r) && d ? hist.get(r.ticker) : null;
    if (people) {
      const me = people.get(r.insider_name);
      if (me) {
        const prior = me.buys.filter(b => t(b) <= t(d) - 31 * DAY).sort().pop() || null;
        const b = buyBreak(prior, me.first, d);
        if (b) out.brk = b[0];
      }
    }
    delete r.is_routine; delete r.reversal;
    if (Object.keys(out).length) r.sig = out;
  }
}

// ── /api/leaders (Insights drawer) ───────────────────────────────────────────
// Same columns the old client-built LEADERBOARD_QUERY returned, so the
// drawer's processLeaderboardRows keeps working unchanged. Faster than the
// old version: latest close per ticker is computed once instead of per row,
// and the historical S&P lookup only runs for open-market buys.
async function leaders(ctx, url) {
  const { sqlVal } = ctx.deps;
  const p = url.searchParams;
  const pro = await ctx.isPro();
  const yRaw = p.get('years');
  let years = yRaw === 'all' ? null : [1, 2, 3, 5, 10].includes(Number(yRaw)) ? Number(yRaw) : 2;
  if (!pro) years = 1;
  const source = ['corporate', 'congress'].includes(p.get('source')) ? p.get('source') : 'all';
  const min = [1, 2, 3, 5].includes(Number(p.get('min'))) ? Number(p.get('min')) : 2;
  const q = (p.get('q') || '').trim().slice(0, 60);
  const limit = pro ? 500 : 100;

  const run = () => ctx.db(leadersSql({ years, source, min, limit, nameLike: q ? sqlVal('%' + likeEsc(q) + '%') : null }));
  const rows = q ? await run() : await cached(`leaders|${years}|${source}|${min}|${limit}`, 30 * 60 * 1000, run);
  return { pro, years, source, rows };
}

function leadersSql({ years, source, min, limit, nameLike }) {
  const dateClause = years != null ? `AND COALESCE(f.transaction_date, f.filing_date) >= CURRENT_DATE - ${years * 365}` : '';
  const sourceClause = source === 'congress' ? `AND f.transaction_code LIKE 'CONGRESS%'`
    : source === 'corporate' ? `AND (f.transaction_code IS NULL OR f.transaction_code NOT LIKE 'CONGRESS%')` : '';
  const nameClause = nameLike ? `AND f.insider_name ILIKE ${nameLike}` : '';
  const buy = `f.transaction_type = 'buy' AND f.is_open_market`;
  const priced = `${buy} AND f.price_per_share > 0 AND l.close IS NOT NULL AND ABS((l.close - f.price_per_share) / f.price_per_share) < 3`;
  return `
    WITH latest AS (
      SELECT DISTINCT ON (ticker) ticker, close::float AS close
        FROM public.prices_history ORDER BY ticker, date DESC
    ), spy_now AS (
      SELECT close::float AS close FROM public.benchmark_prices WHERE symbol = 'SPY' ORDER BY date DESC LIMIT 1
    ), agg AS (
      SELECT f.insider_name,
             MODE() WITHIN GROUP (ORDER BY f.insider_title) AS insider_title,
             MODE() WITHIN GROUP (ORDER BY f.relationship) AS relationship,
             BOOL_OR(f.transaction_code LIKE 'CONGRESS%') AS is_congress,
             COUNT(*) FILTER (WHERE ${buy}) AS om_buys,
             COUNT(*) FILTER (WHERE f.transaction_type = 'sell' AND f.is_open_market) AS om_sells,
             COUNT(*) FILTER (WHERE f.transaction_type = 'buy') AS total_buys,
             SUM(f.value) FILTER (WHERE ${buy} AND f.value < 50000000000) AS bought_value,
             SUM(f.value) FILTER (WHERE f.transaction_type = 'sell' AND f.is_open_market AND f.value < 50000000000) AS sold_value,
             ARRAY_AGG(DISTINCT f.ticker) FILTER (WHERE f.ticker IS NOT NULL) AS tickers,
             ARRAY_AGG(DISTINCT f.sector) FILTER (WHERE f.sector IS NOT NULL AND f.sector <> 'Other') AS sectors,
             COUNT(*) FILTER (WHERE ${priced} AND l.close >= f.price_per_share * 1.05) AS wins,
             COUNT(*) FILTER (WHERE ${priced} AND (l.close >= f.price_per_share * 1.05 OR l.close <= f.price_per_share * 0.95)) AS priced,
             AVG((l.close - f.price_per_share) / f.price_per_share * 100) FILTER (WHERE ${priced}) AS avg_return_pct,
             AVG((sn.close - st.close) / st.close * 100) FILTER (WHERE ${priced} AND st.close IS NOT NULL AND sn.close IS NOT NULL) AS avg_spy_return_pct
        FROM public.filings f
        LEFT JOIN latest l ON l.ticker = f.ticker
        LEFT JOIN spy_now sn ON true
        LEFT JOIN LATERAL (
          SELECT close::float AS close FROM public.benchmark_prices
           WHERE f.transaction_type = 'buy' AND f.is_open_market AND symbol = 'SPY'
             AND date <= COALESCE(f.transaction_date, f.filing_date)
           ORDER BY date DESC LIMIT 1
        ) st ON true
       WHERE f.insider_name IS NOT NULL
         ${dateClause} ${sourceClause} ${nameClause}
       GROUP BY f.insider_name
      HAVING COUNT(*) FILTER (WHERE f.transaction_type IN ('buy','sell') AND f.is_open_market) >= ${Number(min)}
    )
    SELECT agg.*,
      ( CASE WHEN priced >= 5 AND wins::float / NULLIF(priced, 0) >= 0.7 THEN 2
             WHEN priced >= 5 AND wins::float / NULLIF(priced, 0) >= 0.5 THEN 1 ELSE 0 END
      + CASE WHEN avg_return_pct >= 30 THEN 1.5 WHEN avg_return_pct >= 15 THEN 1
             WHEN avg_return_pct >= 5 THEN 0.5 WHEN avg_return_pct < 0 THEN -0.5 ELSE 0 END
      + CASE WHEN relationship = 'strong' THEN 1.5 WHEN relationship = 'medium' THEN 0.75 ELSE 0 END
      + CASE WHEN (om_buys + om_sells) >= 10 THEN 1 WHEN (om_buys + om_sells) >= 5 THEN 0.5 ELSE 0 END
      + CASE WHEN total_buys > 0 AND om_buys::float / total_buys >= 0.7 THEN 0.5 ELSE 0 END
      ) AS proxy_rank
      FROM agg
     ORDER BY proxy_rank DESC NULLS LAST
     LIMIT ${Number(limit)}`;
}

// ── /api/signals and /public/signals ─────────────────────────────────────────
// The Signals view of the Trades page: one row per signal, strongest first.
//
// A signal is a stock where company insiders made open-market trades close
// together (each within GAP_DAYS of the one before), and at least one of:
//   Buying
//     - 2+ different people bought (a cluster)
//     - someone bought for the first time in 3+ years (buyBreak, same rule
//       as stock pages; not counted for 10% owners)
//     - a reversal buy (filings.reversal = 'buy': 2+ sales and no buys of
//       this stock in the 2 years before)
//   Selling
//     - a reversal sale (filings.reversal = 'sell': not a planned sale, after
//       2+ buys and no sales in the 2 years before)
// Counted: trades of $10K+ at $1+ a share by people. Left out: funds and
// companies filing as big shareholders, closed-end funds, Congress (it
// reports ranges weeks later), and planned 10b5-1 sales.
// Strength is rankScore in intel.js, the score that picks the home page's
// featured buys, so the order matches what Seli features elsewhere.
const GAP_DAYS = 14;

async function signals(ctx, url) {
  const p = url.searchParams;
  const pro = await ctx.isPro();
  const allowed = pro ? [7, 30, 90, 365, 730, 1825] : [7, 30, 90, 365];
  const days = allowed.includes(Number(p.get('days'))) ? Number(p.get('days')) : 30;
  const side = p.get('side') === 'sell' ? 'sell' : 'buy';
  const from = isoDaysAgo(days), to = new Date().toISOString().slice(0, 10);
  const all = await cached(`signals|${days}|${side}`, 10 * 60 * 1000, () => signalRows(ctx, from, to, side));
  // Filters and sort run on the cached list, so they cover every signal, then
  // the first SIGNAL_LIMIT go to the browser.
  let rows = all;
  const min = Math.floor(Number(p.get('min')));
  if (min > 0) rows = rows.filter(r => r.total >= min);
  const q = (p.get('q') || '').trim().toLowerCase().slice(0, 60);
  if (q.length >= 2) rows = rows.filter(r => r.ticker.toLowerCase().includes(q) || (r.company || '').toLowerCase().includes(q) || r.people.some(x => x.raw.toLowerCase().includes(q) || x.name.toLowerCase().includes(q)));
  if (p.get('mine') === '1') {
    const ts = new Set((p.get('mt') || '').toUpperCase().split(',').map(x => x.trim()).filter(Boolean));
    const ns = new Set((p.get('mi') || '').split('|').map(x => x.trim()).filter(Boolean));
    rows = rows.filter(r => ts.has(r.ticker) || r.people.some(x => ns.has(x.raw)));
  }
  const kind = p.get('kind');
  if (['cluster', 'first', 'rev'].includes(kind)) rows = rows.filter(r => r.kinds[kind]);
  const SORT = {
    strength: (a, b) => ((b.score ?? -1) - (a.score ?? -1)) || (b.total - a.total),
    total: (a, b) => b.total - a.total,
    people: (a, b) => (b.n - a.n) || (b.total - a.total),
    trades: (a, b) => (b.nt - a.nt) || (b.total - a.total),
    date: (a, b) => b.end.localeCompare(a.end) || (b.total - a.total),
  };
  const sort = SORT[p.get('sort')] ? p.get('sort') : 'strength';
  rows = rows.slice().sort(SORT[sort]);
  if (p.get('dir') === 'asc') rows.reverse();
  return { pro, days, side, sort, from, to, total: rows.length, limit: SIGNAL_LIMIT, rows: rows.slice(0, SIGNAL_LIMIT) };
}
const SIGNAL_LIMIT = 300;

async function signalRows(ctx, from, to, side) {
  const [PLANNED, REV] = await Promise.all([
    hasColumn(ctx, 'planned').then(h => (h ? 'COALESCE(f.planned, f.is_routine)' : 'f.is_routine')),
    reversalSql(ctx),
  ]);
  if (side === 'sell' && REV === 'NULL::text') return [];
  const where = `f.is_open_market = true AND f.transaction_type = '${side}' AND f.ticker IS NOT NULL
      AND ${DT('f')} BETWEEN DATE '${from}' AND DATE '${to}'
      AND COALESCE(f.value, 0) >= 10000 AND (f.price_per_share IS NULL OR f.price_per_share >= 1)
      AND (f.transaction_code IS NULL OR f.transaction_code NOT LIKE 'CONGRESS%') AND f.relationship IS DISTINCT FROM 'congress'
      AND f.insider_name !~* ${ENTITY_SQL}
      ${side === 'sell' ? `AND NOT COALESCE(${PLANNED}, false)` : ''}`;
  const trades = await ctx.db(`
    SELECT f.ticker, f.company_name, f.insider_name, f.insider_title, f.relationship, f.transaction_code,
           f.transaction_type, f.accession_number, f.cik_issuer, f.shares::float AS shares, f.price_per_share::float AS price,
           f.value::float AS value, f.pct_owned_change::float AS pct, f.shares_owned_before::float AS owned_before,
           ${PLANNED} AS is_routine, ${REV} AS reversal, f.filing_date, ${DT('f')} AS trade_date
      FROM public.filings f WHERE ${where}`);
  if (!trades.length) return [];

  // Buy history per person and stock, for "First buy in N yrs".
  const hist = new Map();
  if (side === 'buy') {
    const h = await ctx.db(`
      WITH pairs AS (SELECT DISTINCT f.ticker, f.insider_name FROM public.filings f WHERE ${where})
      SELECT g.ticker, g.insider_name, MIN(${DT('g')}) AS first_seen,
             ARRAY_AGG(${DT('g')}::text) FILTER (WHERE g.is_open_market AND g.transaction_type = 'buy') AS buys
        FROM pairs JOIN public.filings g ON g.ticker = pairs.ticker AND g.insider_name = pairs.insider_name
       WHERE g.transaction_type IN ('buy','sell') AND ${DT('g')} >= DATE '2013-01-01'
       GROUP BY g.ticker, g.insider_name`);
    for (const x of h) hist.set(`${x.ticker}|${x.insider_name}`, { first: asDate(x.first_seen), buys: (x.buys || []).map(asDate).filter(Boolean) });
  }
  const t = d => Date.parse(d + 'T00:00:00Z');
  for (const r of trades) {
    r.trade_date = asDate(r.trade_date);
    const hh = hist.get(`${r.ticker}|${r.insider_name}`);
    if (hh) {
      r.first_seen = hh.first;
      r.prior_buy_date = hh.buys.filter(b => t(b) <= t(r.trade_date) - 31 * 86400000).sort().pop() || null;
    }
  }

  // Split each stock's trades into bursts: a gap of more than GAP_DAYS starts a new one.
  const byTicker = new Map();
  for (const r of trades) {
    if (!r.trade_date || isFundName(r.company_name)) continue;
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push(r);
  }
  const out = [];
  for (const [ticker, list] of byTicker) {
    list.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
    let burst = [];
    const flush = () => { if (burst.length) { const s = side === 'buy' ? buySignal(burst) : sellSignal(ticker, burst); if (s) out.push(s); } burst = []; };
    for (const r of list) {
      if (burst.length && t(r.trade_date) - t(burst[burst.length - 1].trade_date) > GAP_DAYS * 86400000) flush();
      burst.push(r);
    }
    flush();
  }
  out.sort((a, b) => (b.score - a.score) || (b.total - a.total));
  return out;
}

function buySignal(burst) {
  const c = buildClusters(burst, { includeCongress: false })[0];
  if (!c) return null;
  const kinds = { cluster: c.n_insiders >= 2, first: c.first_buy.length > 0, rev: c.reversals.length > 0 };
  if (!kinds.cluster && !kinds.first && !kinds.rev) return null;
  return {
    id: `${c.ticker}|${burst[0].trade_date}`, ticker: c.ticker, company: c.company, side: 'buy',
    start: burst[0].trade_date, end: burst[burst.length - 1].trade_date,
    n: c.n_insiders, total: c.total, max_pct: c.max_pct || null, score: Math.round(c.score), kinds,
    people: c.buyers.map(b => ({ raw: b.raw, name: b.name, role: b.role, value: b.value })),
    why: c.facts.map(([label, tone]) => ({ label, tone })), nt: burst.length,
  };
}

function sellSignal(ticker, burst) {
  const revs = burst.filter(r => r.reversal === 'sell');
  if (!revs.length) return null;
  const per = new Map();
  for (const r of burst) {
    if (!per.has(r.insider_name)) per.set(r.insider_name, { raw: r.insider_name, name: prettyPerson(r.insider_name), role: shortRole(r.insider_title, r.relationship), value: 0 });
    per.get(r.insider_name).value += Number(r.value) || 0;
  }
  const people = [...per.values()].sort((a, b) => b.value - a.value);
  const total = people.reduce((s, x) => s + x.value, 0);
  const why = [];
  if (people.length >= 2) why.push({ label: `${people.length} insiders selling`, tone: 'sell' });
  const revPeople = [...new Set(revs.map(r => r.insider_name))];
  why.push({ label: revPeople.length > 1 ? `${revPeople.length} reversals` : `Reversal (${shortRole(revs[0].insider_title, revs[0].relationship)})`, tone: 'rev' });
  // No buy-style score for sales: biggest first, more people ahead on ties.
  return {
    id: `${ticker}|${burst[0].trade_date}`, ticker, company: prettyCompany(burst[0].company_name) || ticker, side: 'sell',
    start: burst[0].trade_date, end: burst[burst.length - 1].trade_date,
    n: people.length, total, max_pct: Math.max(0, ...burst.map(r => Math.abs(r.pct || 0))) || null,
    score: null, kinds: { cluster: people.length >= 2, first: false, rev: true },
    people, why, nt: burst.length,
  };
}
