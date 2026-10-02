// worker/lib/public.js
// Signed-out, read-only data for the pages Google indexes and for visitors who
// aren't logged in. Same numbers a free account sees (12 months of trades).
//
//   GET /public/stock/:ticker            stock page
//   GET /public/insider/:rawName         insider or member-of-Congress page
//   GET /public/congress                 Congress hub (members, latest trades)
//   GET /public/insider-buying           this week's insider buying hub
//   GET /public/search?q=nvda            search box for signed-out visitors
//   GET /public/leaderboard?source=      top 10 insiders, last 12 months
//   GET /public/sitemap.xml              sitemap index
//   GET /public/sitemap/{static,stocks,congress,insiders-N}.xml
//
// Everything is cached in memory per Worker isolate (Cache API doesn't work on
// workers.dev), and the site's Pages Functions cache again at the edge, so
// crawlers and visitors rarely reach Neon. The IP rate limiter in
// neon-proxy.js runs before this, same as every other route.

import { stock, insider, marketFeed, search, leaderboard, tradeOut, TICKER_RE, FREE_DAYS } from './research.js';
import { prettyPerson, prettyCompany, shortRole, asDate } from './intel.js';

const SITE = 'https://seli.app';
const TTL = { page: 30 * 60 * 1000, hub: 15 * 60 * 1000, sitemap: 6 * 3600 * 1000 };
const MAX_ENTRIES = 600;
const mem = new Map();

async function cached(key, ttl, fn) {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  if (hit?.promise) return hit.promise;
  const promise = fn();
  mem.set(key, { at: 0, promise });
  try {
    const value = await promise;
    mem.delete(key);
    mem.set(key, { at: Date.now(), value });
    if (mem.size > MAX_ENTRIES) mem.delete(mem.keys().next().value); // oldest first
    return value;
  } catch (e) { mem.delete(key); throw e; }
}

export async function handlePublic(request, env, origin, url, deps) {
  const { corsHeaders, neonFetch, sqlVal } = deps;
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const ctx = {
    env, userId: null, isPro: async () => false,
    deps: { sqlVal }, db: q => neonFetch(env, q).then(r => r.rows || []),
  };
  const parts = url.pathname.split('/').filter(Boolean); // ['public', 'stock', 'NVDA']
  const json = (body, status = 200, maxAge = 600) => new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin, env), 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${maxAge}` },
  });
  const xml = body => new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=21600' },
  });
  try {
    if (parts[1] === 'stock' && parts[2]) {
      const t = decodeURIComponent(parts[2]).toUpperCase();
      if (!TICKER_RE.test(t)) return json({ error: 'Not a ticker' }, 400);
      const d = await cached(`stock|${t}`, TTL.page, () => stock(ctx, t));
      return json(d, d.known ? 200 : 404);
    }
    if (parts[1] === 'insider' && parts[2]) {
      const raw = decodeURIComponent(parts.slice(2).join('/')).slice(0, 200);
      const d = await cached(`insider|${raw}`, TTL.page, () => insider(ctx, raw));
      return json(d, d.known ? 200 : 404);
    }
    if (parts[1] === 'leaderboard' && !parts[2]) {
      // Free view: top 10 over 12 months (leaderboard() has its own 30-min cache).
      return json(await leaderboard(ctx, url), 200, 900);
    }
    if (parts[1] === 'search' && !parts[2]) {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 60).toLowerCase();
      return json(q ? await cached(`search|${q}`, TTL.hub, () => search(ctx, q)) : { stocks: [], people: [] }, 200, 300);
    }
    if (parts[1] === 'congress' && !parts[2]) return json(await cached('congress', TTL.hub, () => congressHub(ctx)));
    if (parts[1] === 'insider-buying' && !parts[2]) {
      const d = await marketFeed(ctx); // has its own 10-minute cache
      return json({ ...d, today: new Date().toISOString().slice(0, 10) }, 200, 300);
    }
    if (parts[1] === 'sitemap.xml') return xml(await cached('sm|index', TTL.sitemap, () => sitemapIndex(ctx)));
    if (parts[1] === 'sitemap' && parts[2]) {
      const name = parts[2].replace(/\.xml$/, '');
      if (name === 'static') return xml(staticSitemap());
      if (name === 'stocks') return xml(await cached('sm|stocks', TTL.sitemap, () => stockSitemap(ctx)));
      if (name === 'congress') return xml(await cached('sm|congress', TTL.sitemap, () => peopleSitemap(ctx, true, 1)));
      const m = /^insiders-(\d{1,2})$/.exec(name);
      if (m) return xml(await cached(`sm|ins|${m[1]}`, TTL.sitemap, () => peopleSitemap(ctx, false, Number(m[1]))));
    }
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    console.error('[Worker] public route failed:', url.pathname, e.message);
    return json({ error: 'Something went wrong loading this. Try again in a moment.' }, 500, 0);
  }
}

// ── Congress hub ─────────────────────────────────────────────────────────────
const CONGRESS = `(f.relationship = 'congress' OR f.transaction_code LIKE 'CONGRESS%')`;
const DATE = 'COALESCE(f.transaction_date, f.filing_date)';

async function congressHub(ctx) {
  const [members, recent, popular] = await Promise.all([
    ctx.db(`
      SELECT f.insider_name,
             MODE() WITHIN GROUP (ORDER BY f.insider_title) AS title,
             COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE f.transaction_type = 'buy')::int AS buys,
             COUNT(*) FILTER (WHERE f.transaction_type = 'sell')::int AS sells,
             MAX(${DATE}) AS last,
             (ARRAY_AGG(f.ticker ORDER BY ${DATE} DESC) FILTER (WHERE f.ticker IS NOT NULL))[1:12] AS tickers
        FROM public.filings f
       WHERE ${CONGRESS} AND f.transaction_type IN ('buy','sell')
         AND ${DATE} >= CURRENT_DATE - ${FREE_DAYS} AND ${DATE} <= CURRENT_DATE
       GROUP BY f.insider_name
       ORDER BY MAX(${DATE}) DESC
       LIMIT 400`),
    ctx.db(`
      SELECT f.accession_number, f.cik_issuer, f.ticker, f.company_name, f.insider_name, f.insider_title, f.relationship,
             f.transaction_code, f.transaction_type, f.is_open_market, f.is_routine, f.shares::float AS shares,
             f.price_per_share::float AS price, f.value::float AS value, f.pct_owned_change::float AS pct,
             f.shares_owned_after::float AS owned_after, f.filing_date, ${DATE} AS trade_date
        FROM public.filings f
       WHERE ${CONGRESS} AND f.transaction_type IN ('buy','sell') AND f.filing_date <= CURRENT_DATE
         -- Stock trades only: disclosures without a ticker are bonds, funds
         -- and other assets that don't belong on a stock page.
         AND f.ticker IS NOT NULL AND f.ticker <> ''
         AND ${DATE} <= CURRENT_DATE AND f.filing_date > CURRENT_DATE - 120
       ORDER BY ${DATE} DESC, f.filing_date DESC
       LIMIT 60`),
    ctx.db(`
      SELECT f.ticker, MAX(f.company_name) AS company_name,
             COUNT(DISTINCT f.insider_name)::int AS members,
             COUNT(*) FILTER (WHERE f.transaction_type = 'buy')::int AS buys,
             COUNT(*) FILTER (WHERE f.transaction_type = 'sell')::int AS sells
        FROM public.filings f
       WHERE ${CONGRESS} AND f.transaction_type IN ('buy','sell') AND f.ticker IS NOT NULL
         AND ${DATE} >= CURRENT_DATE - 90 AND ${DATE} <= CURRENT_DATE
       GROUP BY f.ticker
       ORDER BY COUNT(DISTINCT f.insider_name) DESC, COUNT(*) DESC
       LIMIT 16`),
  ]);
  return {
    generated_at: new Date().toISOString(),
    members: members.map(r => ({
      raw: r.insider_name, name: prettyPerson(r.insider_name, true), role: shortRole(r.title, 'congress'),
      n: Number(r.n) || 0, buys: Number(r.buys) || 0, sells: Number(r.sells) || 0,
      last: asDate(r.last) || null,
      tickers: [...new Set(r.tickers || [])].slice(0, 4),
    })),
    recent: recent.map(tradeOut),
    popular: popular.map(r => ({
      ticker: r.ticker, company: prettyCompany(r.company_name) || r.ticker,
      members: Number(r.members) || 0, buys: Number(r.buys) || 0, sells: Number(r.sells) || 0,
    })),
  };
}

// ── Sitemaps ─────────────────────────────────────────────────────────────────
// Built from public.search_entities (the search index the 6am cron refreshes),
// so a sitemap never scans the filings table.
const PER_FILE = 40000;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const urlset = urls => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
  urls.map(u => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')
}\n</urlset>\n`;
const day = d => asDate(d) || null;

export const STATIC_PATHS = ['/', '/congress', '/insider-buying', '/leaderboard', '/about', '/data-download', '/help', '/terms', '/privacy'];
function staticSitemap() {
  const today = new Date().toISOString().slice(0, 10);
  return urlset(STATIC_PATHS.map(p => ({ loc: SITE + p, lastmod: ['/', '/congress', '/insider-buying'].includes(p) ? today : null })));
}

const PEOPLE_WHERE = (congress) => `kind = 'person' AND congress = ${congress ? 'true' : 'false'}
   AND last_date >= CURRENT_DATE - ${congress ? 1825 : 730} AND n >= ${congress ? 1 : 2}`;

async function sitemapIndex(ctx) {
  const [cnt] = await ctx.db(`SELECT COUNT(*)::int AS n FROM public.search_entities WHERE ${PEOPLE_WHERE(false)}`);
  const files = Math.min(10, Math.max(1, Math.ceil((Number(cnt?.n) || 0) / PER_FILE)));
  const today = new Date().toISOString().slice(0, 10);
  const maps = ['static', 'stocks', 'congress', ...Array.from({ length: files }, (_, i) => `insiders-${i + 1}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    maps.map(m => `  <sitemap><loc>${SITE}/sitemap/${m}.xml</loc><lastmod>${today}</lastmod></sitemap>`).join('\n')
  }\n</sitemapindex>\n`;
}

async function stockSitemap(ctx) {
  const rows = await ctx.db(`
    SELECT key, last_date FROM public.search_entities
     WHERE kind = 'stock' AND key ~ '^[A-Z0-9][A-Z0-9.\\-]{0,9}$' AND last_date >= CURRENT_DATE - 1095
     ORDER BY n DESC LIMIT ${PER_FILE}`);
  return urlset(rows.map(r => ({ loc: `${SITE}/stock/${encodeURIComponent(r.key)}`, lastmod: day(r.last_date) })));
}

async function peopleSitemap(ctx, congress, page) {
  const rows = await ctx.db(`
    SELECT key, last_date FROM public.search_entities
     WHERE ${PEOPLE_WHERE(congress)}
     ORDER BY n DESC, key LIMIT ${PER_FILE} OFFSET ${(Math.max(1, page) - 1) * PER_FILE}`);
  return urlset(rows.map(r => ({ loc: `${SITE}/insider/${encodeURIComponent(r.key)}`, lastmod: day(r.last_date) })));
}
