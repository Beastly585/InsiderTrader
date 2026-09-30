// worker/lib/research.js
// Named, read-only endpoints for the research pages. These replace the
// client building SQL strings for search, stock pages, insider pages, the
// home feed and the watchlist. Every user value goes through sqlVal or a
// strict regex before it touches SQL.
//
//   GET /api/search?q=nvda               global search (stocks + people)
//   GET /api/stock/:ticker               stock page
//   GET /api/insider/:rawName            insider page
//   GET /api/feed?h=AAPL,MSFT            home feed (h = linked-portfolio tickers)
//   GET /api/watchlist/summary?h=...     watchlist page
//
// Free vs Pro: every page is open to every signed-in user. Free accounts see
// the last 12 months of individual trades; summaries (track record, 12-month
// totals, last insider buy) are computed over full history for everyone,
// because that's what makes a page worth coming back to.

import {
  tickerStatus, buildClusters, clusterOut, prettyPerson, prettyCompany, shortRole, isCongress, asDate, todayStr,
} from './intel.js';

const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;
const FREE_DAYS = 365;

export async function handleResearch(request, env, origin, url, deps) {
  const { corsResponse, verifiedUserId, isProServerSide } = deps;
  if (request.method !== 'GET') return corsResponse({ error: 'Method not allowed' }, 405, origin, env);
  const userId = await verifiedUserId(request, env);
  if (!userId) return corsResponse({ error: 'Authentication required' }, 401, origin, env);
  const pro = await isProServerSide(env, userId).catch(() => false);
  const ctx = { env, userId, pro, deps, db: q => deps.neonFetch(env, q).then(r => r.rows || []) };
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'stock', 'NVDA']
  try {
    let body;
    if (parts[1] === 'search') body = await search(ctx, url.searchParams.get('q') || '');
    else if (parts[1] === 'stock' && parts[2]) body = await stock(ctx, decodeURIComponent(parts[2]).toUpperCase());
    else if (parts[1] === 'insider' && parts[2]) body = await insider(ctx, decodeURIComponent(parts.slice(2).join('/')));
    else if (parts[1] === 'feed') body = await feed(ctx, holdingsParam(url));
    else if (parts[1] === 'watchlist' && parts[2] === 'summary') body = await watchlistSummary(ctx, holdingsParam(url));
    else return corsResponse({ error: 'Not found' }, 404, origin, env);
    if (body && body.__status) return corsResponse({ error: body.error }, body.__status, origin, env);
    return corsResponse(body, 200, origin, env);
  } catch (e) {
    console.error('[Worker] research route failed:', url.pathname, e.message);
    return corsResponse({ error: 'Something went wrong loading this. Try again in a moment.' }, 500, origin, env);
  }
}

function holdingsParam(url) {
  return (url.searchParams.get('h') || '').toUpperCase().split(',').map(s => s.trim()).filter(t => TICKER_RE.test(t)).slice(0, 60);
}

const sqlList = (vals, sqlVal) => `ARRAY[${vals.map(v => sqlVal(v)).join(',')}]::text[]`;
const likeEsc = s => s.replace(/[\\%_]/g, m => '\\' + m);
const num = v => (v == null ? null : Number(v));

// ── Search ───────────────────────────────────────────────────────────────────
async function search(ctx, qRaw) {
  const { sqlVal } = ctx.deps;
  const q = qRaw.trim().slice(0, 60);
  if (!q) return { stocks: [], people: [] };
  const up = q.toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  const tokens = q.toLowerCase().split(/[\s,]+/).filter(Boolean).slice(0, 4);
  const nameConds = tokens.map(t => `lower(key) LIKE ${sqlVal('%' + likeEsc(t) + '%')}`).join(' AND ');
  const coLike = sqlVal('%' + likeEsc(q.toLowerCase()) + '%');
  const upLike = sqlVal(likeEsc(up) + '%');

  let stocks, people;
  try {
    [stocks, people] = await Promise.all([
      ctx.db(`
        SELECT key, label, n, last_date FROM public.search_entities
         WHERE kind = 'stock' AND (${up ? `key = ${sqlVal(up)} OR key LIKE ${upLike} OR ` : ''}lower(label) LIKE ${coLike})
         ORDER BY ${up ? `(key = ${sqlVal(up)}) DESC, (key LIKE ${upLike}) DESC,` : ''} (last_date >= CURRENT_DATE - 365) DESC, n DESC
         LIMIT 6`),
      ctx.db(`
        SELECT key, sub, ticker, n, last_date, congress FROM public.search_entities
         WHERE kind = 'person' AND ${nameConds}
         ORDER BY (last_date >= CURRENT_DATE - 730) DESC, n DESC
         LIMIT 6`),
    ]);
  } catch (e) {
    // search_entities not created yet (see db/migrations). Slower fallback
    // straight off filings, limited to recent years so it stays usable.
    if (!/search_entities/.test(e.message)) throw e;
    const fName = tokens.map(t => `lower(insider_name) LIKE ${sqlVal('%' + likeEsc(t) + '%')}`).join(' AND ');
    [stocks, people] = await Promise.all([
      ctx.db(`
        SELECT ticker AS key, MAX(company_name) AS label, COUNT(*)::int AS n, MAX(filing_date) AS last_date
          FROM public.filings
         WHERE filing_date >= CURRENT_DATE - 1095 AND ticker IS NOT NULL
           AND (${up ? `ticker LIKE ${upLike} OR ` : ''}lower(company_name) LIKE ${coLike})
         GROUP BY ticker
         ORDER BY ${up ? `(ticker = ${sqlVal(up)}) DESC,` : ''} COUNT(*) DESC LIMIT 6`),
      ctx.db(`
        SELECT insider_name AS key, MODE() WITHIN GROUP (ORDER BY insider_title) AS sub,
               MODE() WITHIN GROUP (ORDER BY ticker) AS ticker, COUNT(*)::int AS n, MAX(filing_date) AS last_date,
               BOOL_OR(relationship = 'congress' OR transaction_code LIKE 'CONGRESS%') AS congress
          FROM public.filings
         WHERE filing_date >= CURRENT_DATE - 1095 AND ${fName}
         GROUP BY insider_name ORDER BY COUNT(*) DESC LIMIT 6`),
    ]);
  }
  return {
    stocks: stocks.map(r => ({ ticker: r.key, company: prettyCompany(r.label) || r.key, n: num(r.n), last: asDate(r.last_date) })),
    people: people.map(r => ({
      raw: r.key, name: prettyPerson(r.key, !!r.congress), title: r.sub || '',
      role: shortRole(r.sub, r.congress ? 'congress' : null), ticker: r.ticker, congress: !!r.congress,
      n: num(r.n), last: asDate(r.last_date),
    })),
  };
}

// ── Shared: ticker status for a list of tickers ──────────────────────────────
async function statusFor(ctx, tickers, windowDays) {
  const { sqlVal } = ctx.deps;
  tickers = [...new Set(tickers)].filter(t => TICKER_RE.test(t));
  if (!tickers.length) return {};
  const arr = sqlList(tickers, sqlVal);
  const [rows, lastBuys, names] = await Promise.all([
    ctx.db(`
      SELECT f.ticker, f.company_name, f.insider_name, f.insider_title, f.relationship, f.transaction_code,
             f.transaction_type, f.value::float AS value, f.pct_owned_change::float AS pct,
             f.accession_number, f.filing_date, COALESCE(f.transaction_date, f.filing_date) AS trade_date
        FROM public.filings f
       WHERE f.ticker = ANY(${arr}) AND f.is_open_market = true AND f.transaction_type IN ('buy','sell')
         AND f.filing_date <= CURRENT_DATE AND COALESCE(f.transaction_date, f.filing_date) >= CURRENT_DATE - 380`),
    ctx.db(`
      SELECT DISTINCT ON (f.ticker) f.ticker, f.company_name, f.insider_name, f.insider_title, f.relationship,
             f.value::float AS value, COALESCE(f.transaction_date, f.filing_date) AS trade_date
        FROM public.filings f
       WHERE f.ticker = ANY(${arr}) AND f.is_open_market = true AND f.transaction_type = 'buy'
         AND COALESCE(f.transaction_date, f.filing_date) <= CURRENT_DATE
         AND COALESCE(f.relationship, '') <> 'congress' AND COALESCE(f.transaction_code, '') NOT ILIKE 'CONGRESS%'
       ORDER BY f.ticker, COALESCE(f.transaction_date, f.filing_date) DESC, f.value DESC NULLS LAST`),
    ctx.db(`
      SELECT DISTINCT ON (f.ticker) f.ticker, f.company_name FROM public.filings f
       WHERE f.ticker = ANY(${arr}) AND f.company_name IS NOT NULL ORDER BY f.ticker, f.filing_date DESC`),
  ]);
  const lb = Object.fromEntries(lastBuys.map(r => [r.ticker, r]));
  const nm = Object.fromEntries(names.map(r => [r.ticker, r.company_name]));
  return tickerStatus(tickers, rows, lb, nm, windowDays);
}

function statusOut(s) {
  return {
    ticker: s.ticker, company: s.company, known: s.known, active: s.active, lines: s.lines,
    recent_buys: { n: s.recent_buys.n, v: s.recent_buys.v }, recent_sells: { n: s.recent_sells.n, v: s.recent_sells.v },
    yr_buys: { n: s.yr_buys.n, v: s.yr_buys.v }, yr_sells: { n: s.yr_sells.n, v: s.yr_sells.v },
    recent_congress: s.recent_congress.n, last_buy: s.last_buy,
  };
}

// ── Stock page ───────────────────────────────────────────────────────────────
async function stock(ctx, ticker) {
  const { sqlVal } = ctx.deps;
  if (!TICKER_RE.test(ticker)) return { __status: 400, error: 'That doesn\'t look like a ticker' };
  const T = sqlVal(ticker);
  const days = ctx.pro ? 3650 : FREE_DAYS;
  const date = 'COALESCE(f.transaction_date, f.filing_date)';
  const [meta, trades, older, people, prices, status] = await Promise.all([
    ctx.db(`SELECT company_name, sector, cik_issuer FROM public.filings f WHERE ticker = ${T} ORDER BY filing_date DESC LIMIT 1`),
    ctx.db(`
      SELECT f.accession_number, f.cik_issuer, f.insider_name, f.insider_title, f.relationship, f.transaction_code,
             f.transaction_type, f.is_open_market, f.is_routine, f.shares::float AS shares,
             f.price_per_share::float AS price, f.value::float AS value, f.pct_owned_change::float AS pct,
             f.shares_owned_after::float AS owned_after, f.filing_date, ${date} AS trade_date
        FROM public.filings f
       WHERE f.ticker = ${T} AND f.transaction_type IN ('buy','sell') AND ${date} >= CURRENT_DATE - ${days}
       ORDER BY ${date} DESC, f.value DESC NULLS LAST LIMIT 400`),
    ctx.pro ? Promise.resolve([{ n: 0 }]) : ctx.db(`
      SELECT COUNT(*)::int AS n FROM public.filings f
       WHERE f.ticker = ${T} AND f.transaction_type IN ('buy','sell') AND ${date} < CURRENT_DATE - ${FREE_DAYS}`),
    ctx.db(`
      SELECT f.insider_name,
             MODE() WITHIN GROUP (ORDER BY f.insider_title) AS title,
             MODE() WITHIN GROUP (ORDER BY f.relationship) AS relationship,
             BOOL_OR(f.relationship = 'congress' OR f.transaction_code LIKE 'CONGRESS%') AS congress,
             COUNT(*) FILTER (WHERE f.transaction_type = 'buy' AND f.is_open_market)::int AS buys,
             COALESCE(SUM(f.value) FILTER (WHERE f.transaction_type = 'buy' AND f.is_open_market), 0)::float AS buy_v,
             COUNT(*) FILTER (WHERE f.transaction_type = 'sell' AND f.is_open_market)::int AS sells,
             COALESCE(SUM(f.value) FILTER (WHERE f.transaction_type = 'sell' AND f.is_open_market), 0)::float AS sell_v,
             COUNT(*) FILTER (WHERE NOT COALESCE(f.is_open_market, false))::int AS other,
             MAX(${date}) AS last,
             (ARRAY_AGG(f.shares_owned_after::float ORDER BY ${date} DESC) FILTER (WHERE f.shares_owned_after IS NOT NULL))[1] AS owned
        FROM public.filings f
       WHERE f.ticker = ${T} AND f.transaction_type IN ('buy','sell') AND ${date} >= CURRENT_DATE - ${Math.min(days, 1095)}
       GROUP BY f.insider_name
       ORDER BY MAX(${date}) DESC LIMIT 40`),
    ctx.db(`SELECT date, close::float AS close FROM public.prices_history WHERE ticker = ${T} AND date >= CURRENT_DATE - 1095 ORDER BY date`)
      .catch(() => []),
    statusFor(ctx, [ticker], 90),
  ]);
  if (!meta.length) return { ticker, known: false, pro: ctx.pro };
  const last = prices[prices.length - 1];
  const s = status[ticker];
  return {
    ticker, known: true, pro: ctx.pro, window_days: days, older_count: num(older[0]?.n) || 0,
    company: prettyCompany(meta[0].company_name) || ticker, sector: meta[0].sector || null, cik: meta[0].cik_issuer || null,
    price: last ? { close: num(last.close), date: asDate(last.date) } : null,
    prices: prices.map(p => [asDate(p.date), num(p.close)]),
    summary: s ? statusOut(s) : null,
    insiders: people.map(p => ({
      raw: p.insider_name, name: prettyPerson(p.insider_name, !!p.congress), title: p.title || '',
      role: shortRole(p.title, p.congress ? 'congress' : p.relationship), congress: !!p.congress,
      buys: num(p.buys), buy_v: num(p.buy_v), sells: num(p.sells), sell_v: num(p.sell_v), other: num(p.other),
      last: asDate(p.last), owned: num(p.owned),
    })),
    trades: trades.map(r => tradeOut(r)),
  };
}

function tradeOut(r) {
  const cg = isCongress(r);
  return {
    acc: r.accession_number, cik: r.cik_issuer, raw: r.insider_name, name: prettyPerson(r.insider_name, cg),
    title: r.insider_title || '', role: shortRole(r.insider_title, cg ? 'congress' : r.relationship), congress: cg,
    ticker: r.ticker, company: r.company_name ? prettyCompany(r.company_name) : undefined,
    type: r.transaction_type, code: r.transaction_code, om: !!r.is_open_market, routine: r.is_routine,
    shares: num(r.shares), price: num(r.price), value: num(r.value), pct: num(r.pct), owned_after: num(r.owned_after),
    filed: asDate(r.filing_date), date: asDate(r.trade_date),
  };
}

// ── Insider page ─────────────────────────────────────────────────────────────
async function insider(ctx, raw) {
  const { sqlVal } = ctx.deps;
  raw = raw.slice(0, 200);
  if (!raw.trim()) return { __status: 400, error: 'Missing name' };
  const N = sqlVal(raw);
  const date = 'COALESCE(f.transaction_date, f.filing_date)';
  const rows = await ctx.db(`
    SELECT f.accession_number, f.cik_issuer, f.ticker, f.company_name, f.insider_name, f.insider_title, f.relationship,
           f.transaction_code, f.transaction_type, f.is_open_market, f.is_routine, f.shares::float AS shares,
           f.price_per_share::float AS price, f.value::float AS value, f.pct_owned_change::float AS pct,
           f.shares_owned_after::float AS owned_after, f.filing_date, ${date} AS trade_date
      FROM public.filings f
     WHERE f.insider_name = ${N} AND f.transaction_type IN ('buy','sell')
     ORDER BY ${date} DESC LIMIT 800`);
  if (!rows.length) return { raw, known: false, pro: ctx.pro };

  const tickers = [...new Set(rows.map(r => r.ticker).filter(t => t && TICKER_RE.test(t)))];
  const buys = rows.filter(r => r.is_open_market && r.transaction_type === 'buy' && r.price > 0);
  const firstBuy = buys.map(r => asDate(r.trade_date)).filter(Boolean).sort()[0];
  const [latest, spy] = await Promise.all([
    tickers.length ? ctx.db(`
      SELECT t.ticker, p.close, p.date FROM unnest(${sqlList(tickers, sqlVal)}) AS t(ticker)
      LEFT JOIN LATERAL (SELECT close::float AS close, date FROM public.prices_history
                          WHERE ticker = t.ticker ORDER BY date DESC LIMIT 1) p ON true`).catch(() => []) : [],
    firstBuy ? ctx.db(`SELECT date, close::float AS close FROM public.benchmark_prices
                         WHERE symbol = 'SPY' AND date >= ${sqlVal(firstBuy)}::date - 7 ORDER BY date`).catch(() => []) : [],
  ]);
  const now = Object.fromEntries(latest.filter(r => r.close != null).map(r => [r.ticker, num(r.close)]));
  const spyDates = spy.map(r => asDate(r.date));
  const spyClose = spy.map(r => num(r.close));
  const spyOn = d => { // last close on or before d
    let lo = 0, hi = spyDates.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (spyDates[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans >= 0 ? spyClose[ans] : null;
  };
  const spyNow = spyClose[spyClose.length - 1] ?? null;

  // Track record: open-market buys with a real price and a current price.
  // Same sanity bound and 5% "push" band as the leaderboard query, so the
  // number here matches the number on the leaderboard.
  let priced = 0, wins = 0, retSum = 0, retN = 0, spySum = 0, mRetSum = 0, spyN = 0, beat = 0;
  for (const r of buys) {
    const cur = now[r.ticker];
    if (cur == null) continue;
    const ret = (cur - r.price) / r.price;
    if (Math.abs(ret) >= 3) continue;
    retSum += ret * 100; retN++;
    if (Math.abs(ret) >= 0.05) { priced++; if (ret >= 0.05) wins++; }
    const then = spyOn(asDate(r.trade_date));
    if (then && spyNow) {
      // vs-S&P is averaged over the same buys only (ones with benchmark data)
      const sret = (spyNow - then) / then * 100;
      spySum += sret; mRetSum += ret * 100; spyN++;
      if (ret * 100 > sret) beat++;
    }
  }

  // Per-company rollup (affiliations + current position).
  const byT = new Map();
  for (const r of rows) {
    if (!r.ticker) continue;
    if (!byT.has(r.ticker)) byT.set(r.ticker, {
      ticker: r.ticker, company: prettyCompany(r.company_name) || r.ticker, title: r.insider_title || '',
      role: shortRole(r.insider_title, isCongress(r) ? 'congress' : r.relationship),
      buys: 0, buy_v: 0, sells: 0, sell_v: 0, other: 0, last: null, owned: null, cost: 0, costShares: 0,
    });
    const c = byT.get(r.ticker);
    const d = asDate(r.trade_date);
    if (!c.last || d > c.last) c.last = d; // rows are newest-first, so first seen = latest title
    if (c.owned == null && r.owned_after != null) c.owned = num(r.owned_after);
    if (!r.is_open_market) { c.other++; continue; }
    if (r.transaction_type === 'buy') {
      c.buys++; c.buy_v += num(r.value) || 0;
      if (r.price > 0 && r.shares > 0) { c.cost += r.price * r.shares; c.costShares += num(r.shares); }
    } else { c.sells++; c.sell_v += num(r.value) || 0; }
  }
  const companies = [...byT.values()].map(c => {
    const avgBuy = c.costShares ? c.cost / c.costShares : null;
    const price = now[c.ticker] ?? null;
    return {
      ticker: c.ticker, company: c.company, title: c.title, role: c.role, buys: c.buys, buy_v: c.buy_v,
      sells: c.sells, sell_v: c.sell_v, other: c.other, last: c.last, owned: c.owned, price,
      est_value: c.owned != null && price != null ? c.owned * price : null,
      avg_buy: avgBuy, since_avg_buy: avgBuy && price ? (price - avgBuy) / avgBuy * 100 : null,
    };
  }).sort((a, b) => (b.last || '').localeCompare(a.last || ''));

  const cg = rows.some(isCongress);
  const cutoff = new Date(Date.now() - FREE_DAYS * 86400000).toISOString().slice(0, 10);
  const visible = ctx.pro ? rows : rows.filter(r => asDate(r.trade_date) >= cutoff);
  const dates = rows.map(r => asDate(r.trade_date)).filter(Boolean).sort();
  return {
    raw, known: true, pro: ctx.pro, congress: cg, name: prettyPerson(raw, cg),
    title: companies[0]?.title || '', role: companies[0]?.role || (cg ? 'Congress' : 'Insider'),
    first_trade: dates[0], last_trade: dates[dates.length - 1], total_rows: rows.length, capped: rows.length >= 800,
    older_count: rows.length - visible.length, window_days: ctx.pro ? null : FREE_DAYS,
    record: {
      buys_scored: retN, priced, wins, hit_rate: priced >= 1 ? Math.round(wins / priced * 100) : null,
      avg_return: retN ? retSum / retN : null,
      vs_spy: spyN ? { n: spyN, avg_return: mRetSum / spyN, avg_spy: spySum / spyN, beat } : null,
    },
    companies,
    trades: visible.map(r => ({ ...tradeOut(r), now: now[r.ticker] ?? null })),
  };
}

// ── Personal: watchlist + holdings ───────────────────────────────────────────
async function loadWatchlist(ctx) {
  const { sqlVal } = ctx.deps;
  try {
    return await ctx.db(`SELECT item_type, item_value, alerts FROM public.user_watchlist WHERE clerk_user_id = ${sqlVal(ctx.userId)} ORDER BY added_at DESC`);
  } catch (e) {
    if (!/alerts/.test(e.message)) throw e;
    const rows = await ctx.db(`SELECT item_type, item_value FROM public.user_watchlist WHERE clerk_user_id = ${sqlVal(ctx.userId)} ORDER BY added_at DESC`);
    return rows.map(r => ({ ...r, alerts: true }));
  }
}

async function peopleActivity(ctx, names, days) {
  const { sqlVal } = ctx.deps;
  if (!names.length) return [];
  const rows = await ctx.db(`
    SELECT DISTINCT ON (f.insider_name, f.accession_number, f.ticker, f.transaction_type)
           f.accession_number, f.cik_issuer, f.ticker, f.company_name, f.insider_name, f.insider_title, f.relationship,
           f.transaction_code, f.transaction_type, f.is_open_market, f.is_routine, f.shares::float AS shares,
           f.price_per_share::float AS price, f.value::float AS value, f.pct_owned_change::float AS pct,
           f.shares_owned_after::float AS owned_after, f.filing_date, COALESCE(f.transaction_date, f.filing_date) AS trade_date
      FROM public.filings f
     WHERE f.insider_name = ANY(${sqlList(names, sqlVal)}) AND f.is_open_market = true
       AND f.transaction_type IN ('buy','sell') AND f.filing_date > CURRENT_DATE - ${days}
     ORDER BY f.insider_name, f.accession_number, f.ticker, f.transaction_type`);
  const last = await ctx.db(`
    SELECT DISTINCT ON (f.insider_name) f.insider_name, f.insider_title, f.relationship, f.transaction_code, f.ticker,
           f.transaction_type, f.value::float AS value, COALESCE(f.transaction_date, f.filing_date) AS trade_date
      FROM public.filings f
     WHERE f.insider_name = ANY(${sqlList(names, sqlVal)}) AND f.transaction_type IN ('buy','sell') AND f.is_open_market = true
     ORDER BY f.insider_name, COALESCE(f.transaction_date, f.filing_date) DESC`);
  const lastBy = Object.fromEntries(last.map(r => [r.insider_name, r]));
  return names.map(n => {
    const mine = rows.filter(r => r.insider_name === n).map(tradeOut).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const l = lastBy[n];
    const cg = l ? isCongress(l) : false;
    return {
      raw: n, name: prettyPerson(n, cg), role: l ? shortRole(l.insider_title, cg ? 'congress' : l.relationship) : '',
      recent: mine,
      last: l ? { ticker: l.ticker, type: l.transaction_type, value: num(l.value), date: asDate(l.trade_date) } : null,
    };
  });
}

async function watchlistSummary(ctx, holdings) {
  const items = await loadWatchlist(ctx);
  const tickers = items.filter(i => i.item_type === 'ticker').map(i => String(i.item_value).toUpperCase());
  const names = items.filter(i => i.item_type === 'insider').map(i => i.item_value);
  const heldOnly = holdings.filter(t => !tickers.includes(t));
  const [status, people] = await Promise.all([
    statusFor(ctx, [...tickers, ...heldOnly], 30),
    peopleActivity(ctx, names, 90),
  ]);
  const alertsOf = (type, v) => items.find(i => i.item_type === type && i.item_value === v)?.alerts !== false;
  return {
    pro: ctx.pro,
    stocks: tickers.map(t => ({ ...(status[t] ? statusOut(status[t]) : { ticker: t, company: t, lines: [] }), alerts: alertsOf('ticker', t), held: holdings.includes(t) })),
    people: people.map(p => ({ ...p, alerts: alertsOf('insider', p.raw) })),
    holdings: heldOnly.map(t => (status[t] ? statusOut(status[t]) : { ticker: t, company: t, lines: [] })),
  };
}

// ── Home feed ────────────────────────────────────────────────────────────────
const FEED_TTL_MS = 10 * 60 * 1000;
let feedCache = { at: 0, data: null, promise: null };

async function marketFeed(ctx) {
  if (feedCache.data && Date.now() - feedCache.at < FEED_TTL_MS) return feedCache.data;
  if (feedCache.promise) return feedCache.promise;
  feedCache.promise = (async () => {
    const [buys, sells, pulseRows] = await Promise.all([
      ctx.db(`
        SELECT f.ticker, f.company_name, f.insider_name, f.insider_title, f.relationship, f.transaction_code,
               f.value::float AS value, f.price_per_share::float AS price, f.pct_owned_change::float AS pct,
               f.shares_owned_before::float AS owned_before, f.is_routine, f.filing_date,
               COALESCE(f.transaction_date, f.filing_date) AS trade_date,
               (SELECT MAX(COALESCE(p.transaction_date, p.filing_date)) FROM public.filings p
                 WHERE p.insider_name = f.insider_name AND p.ticker = f.ticker AND p.is_open_market = true
                   AND p.transaction_type = 'buy'
                   AND COALESCE(p.transaction_date, p.filing_date) < COALESCE(f.transaction_date, f.filing_date) - 30) AS prior_buy_date
          FROM public.filings f
         WHERE f.is_open_market = true AND f.transaction_type = 'buy' AND f.ticker IS NOT NULL
           AND f.filing_date > CURRENT_DATE - 7 AND f.filing_date <= CURRENT_DATE
           AND COALESCE(f.transaction_date, f.filing_date) >= CURRENT_DATE - 52
           AND COALESCE(f.value, 0) >= 10000
           AND (f.price_per_share IS NULL OR f.price_per_share >= 1
                OR f.relationship = 'congress' OR f.transaction_code LIKE 'CONGRESS%')`),
      ctx.db(`
        SELECT f.ticker, MAX(f.company_name) AS company_name, f.insider_name,
               MODE() WITHIN GROUP (ORDER BY f.insider_title) AS insider_title,
               MODE() WITHIN GROUP (ORDER BY f.relationship) AS relationship,
               MAX(f.transaction_code) AS transaction_code,
               SUM(f.value)::float AS value, COUNT(*)::int AS n, MAX(COALESCE(f.transaction_date, f.filing_date)) AS trade_date,
               BOOL_AND(f.is_routine) AS planned
          FROM public.filings f
         WHERE f.is_open_market = true AND f.transaction_type = 'sell' AND f.ticker IS NOT NULL
           AND f.filing_date > CURRENT_DATE - 7 AND f.filing_date <= CURRENT_DATE
           AND COALESCE(f.relationship, '') <> 'congress' AND COALESCE(f.transaction_code, '') NOT LIKE 'CONGRESS%'
           AND f.value < 50000000000
         GROUP BY f.ticker, f.insider_name
         ORDER BY SUM(f.value) DESC NULLS LAST LIMIT 6`),
      ctx.db(`
        SELECT ((CURRENT_DATE - f.filing_date) / 7)::int AS bucket, f.transaction_type,
               COUNT(DISTINCT f.accession_number)::int AS n, COALESCE(SUM(f.value), 0)::float AS v
          FROM public.filings f
         WHERE f.is_open_market = true AND f.transaction_type IN ('buy','sell') AND f.ticker IS NOT NULL
           AND f.filing_date > CURRENT_DATE - 91 AND f.filing_date <= CURRENT_DATE
         GROUP BY 1, 2`),
    ]);
    const all = buildClusters(buys, { includeCorporate: true, includeCongress: false });
    const congress = buildClusters(buys, { includeCorporate: false, includeCongress: true });
    const data = {
      featured: all[0] ? clusterOut(all[0], 'this week') : null,
      more: all.slice(1, 9).map(c => clusterOut(c, 'this week')),
      congress: congress.slice(0, 4).map(c => clusterOut(c, 'this week')),
      sells: sells.map(r => ({
        ticker: r.ticker, company: prettyCompany(r.company_name), raw: r.insider_name, name: prettyPerson(r.insider_name),
        role: shortRole(r.insider_title, r.relationship), value: num(r.value), n: num(r.n), date: asDate(r.trade_date),
        planned: r.planned === true,
      })),
      pulse: pulse(pulseRows),
      generated_at: new Date().toISOString(),
    };
    feedCache = { at: Date.now(), data, promise: null };
    return data;
  })().catch(e => { feedCache.promise = null; throw e; });
  return feedCache.promise;
}

function pulse(rows) {
  const now = { buy: [0, 0], sell: [0, 0] };
  const hist = {};
  for (const r of rows) {
    const b = num(r.bucket);
    if (b === 0) now[r.transaction_type] = [num(r.n), num(r.v)];
    else if (b >= 1 && b <= 12) { hist[b] = hist[b] || { buy: 0, sell: 0 }; hist[b][r.transaction_type] = num(r.n); }
  }
  if (now.buy[0] + now.sell[0] === 0) return null;
  const weeks = Object.values(hist).filter(w => w.buy + w.sell > 0);
  const avg = weeks.length ? weeks.reduce((s, w) => s + w.buy, 0) / weeks.length : null;
  let line = null;
  if (avg && weeks.length >= 4) {
    const ratio = now.buy[0] / avg;
    const pct = Math.round(Math.abs(ratio - 1) * 100);
    line = ratio >= 1.2 ? `More insider buying than usual this week: ${pct}% above the 12-week average number of buys.`
      : ratio <= 0.8 ? `Less insider buying than usual this week: ${pct}% below the 12-week average number of buys.`
        : 'About a normal week for insider buying, in line with the 12-week average.';
    line += ' Sales usually outnumber buys in any given week.';
  }
  return { buy_n: now.buy[0], buy_v: now.buy[1], sell_n: now.sell[0], sell_v: now.sell[1], line };
}

async function feed(ctx, holdings) {
  const [market, items] = await Promise.all([marketFeed(ctx), loadWatchlist(ctx)]);
  const tickers = items.filter(i => i.item_type === 'ticker').map(i => String(i.item_value).toUpperCase());
  const names = items.filter(i => i.item_type === 'insider').map(i => i.item_value);
  const [status, people] = await Promise.all([
    statusFor(ctx, [...tickers, ...holdings], 14),
    peopleActivity(ctx, names, 14),
  ]);
  const yours = [...new Set([...tickers, ...holdings])].map(t => status[t]).filter(Boolean)
    .map(s => ({ ...statusOut(s), held: holdings.includes(s.ticker), watched: tickers.includes(s.ticker) }))
    .sort((a, b) => (b.active - a.active) || ((b.recent_buys.v + b.recent_sells.v) - (a.recent_buys.v + a.recent_sells.v)));
  return {
    pro: ctx.pro,
    today: todayStr(),
    yours: { stocks: yours, people, watching: tickers.length + names.length, holdings: holdings.length },
    ...market,
  };
}
