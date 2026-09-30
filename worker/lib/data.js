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
  if (hit?.promise) return hit.promise;
  const promise = fn();
  cache.set(key, { at: 0, promise });
  try { const value = await promise; cache.set(key, { at: Date.now(), value }); return value; }
  catch (e) { cache.delete(key); throw e; }
}

export const DATA_ROUTES = { filings, trades, price, leaders, sectors, explore, samples };

// ── /api/filings ─────────────────────────────────────────────────────────────
async function filings(ctx, url) {
  const pro = await ctx.isPro();
  const raw = url.searchParams.get('days');
  let days = raw === 'all' ? null : Math.max(1, Math.min(Number(raw) || 90, 5000));
  if (!pro && (days == null || days > FREE_DAYS)) days = FREE_DAYS;
  const floor = days == null ? HARD_FLOOR : isoDaysAgo(days);
  const limit = days != null && days <= 7 ? 5000 : days != null && days <= 30 ? 15000 : 50000;
  const rows = await ctx.db(`
    SELECT accession_number, cik_issuer, filing_date AS date, transaction_date,
           company_name AS company, ticker, insider_name, insider_title AS title, is_officer,
           transaction_type, transaction_code, is_open_market,
           shares::float, price_per_share::float AS price, value::float,
           shares_owned_after::float, pct_owned_change::float, sector, relationship, is_routine
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
const SORTABLE = new Set(['transaction_date', 'ticker', 'company_name', 'insider_name', 'transaction_type',
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
  if (p.get('source') === 'corporate') c.push(`(transaction_code IS NULL OR transaction_code NOT LIKE 'CONGRESS%')`);
  if (p.get('source') === 'political') c.push(`transaction_code LIKE 'CONGRESS%'`);
  if (p.has('tickers')) {
    const ts = (p.get('tickers') || '').toUpperCase().split(',').map(s => s.trim()).filter(t => TICKER_RE.test(t)).slice(0, 200);
    c.push(ts.length ? `ticker IN (${ts.map(sqlVal).join(',')})` : '1=0');
  }
  const q = (p.get('q') || '').trim().slice(0, 60);
  if (q) {
    const like = sqlVal('%' + likeEsc(q) + '%');
    c.push(`(ticker ILIKE ${like} OR insider_name ILIKE ${like} OR company_name ILIKE ${like})`);
  }
  const where = 'WHERE ' + c.join(' AND ');

  const sort = SORTABLE.has(p.get('sort')) ? p.get('sort') : 'transaction_date';
  const dir = p.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const orderBy = sort === 'transaction_date'
    ? `ORDER BY COALESCE(transaction_date, filing_date) ${dir} NULLS LAST`
    : `ORDER BY ${sort} ${dir} NULLS LAST`;
  const page = Math.max(0, Math.min(Number(p.get('page')) || 0, 500));

  const [rows, count] = await Promise.all([
    ctx.db(`
      SELECT transaction_date, filing_date, ticker, company_name, insider_name, insider_title,
             relationship, transaction_type, transaction_code, is_open_market,
             shares::float, price_per_share::float, value::float, pct_owned_change::float, sector
        FROM public.filings ${where}
        ${orderBy}
        LIMIT ${PAGE} OFFSET ${page * PAGE}`),
    page === 0 ? ctx.db(`SELECT COUNT(*)::int AS n FROM public.filings ${where}`) : null,
  ]);
  return { pro, page, page_size: PAGE, from, to, rows, total: count ? count[0]?.n ?? 0 : undefined };
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
