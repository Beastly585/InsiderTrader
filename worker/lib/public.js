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
//   GET /public/stocks                   A to Z directory of stocks with recent Form 4s
//   GET /public/freshness                when the ingest last checked SEC (the "checked N min ago" line)
//   GET /public/pricing                  { annual } whether yearly Pro is on sale
//   GET /public/sitemap.xml              sitemap index
//   GET /public/sitemap/{static,stocks,congress,blog,insiders}.xml
//   GET /public/blog, /public/blog/post/:slug   the blog (see blog.js)
//
// Everything is cached in memory per Worker isolate (Cache API doesn't work on
// workers.dev), and the site's Pages Functions cache again at the edge, so
// crawlers and visitors rarely reach Neon. The IP rate limiter in
// neon-proxy.js runs before this, same as every other route.

import { stock, insider, marketFeed, search, leaderboard, tradeOut, TICKER_RE, FREE_DAYS } from './research.js';
import { blogList, blogPost, blogSitemap } from './blog.js';
import { prettyPerson, prettyCompany, shortRole, asDate, isPlaceholderTicker, isEntityName } from './intel.js';

const SITE = 'https://seli.app';
const TTL = { page: 30 * 60 * 1000, hub: 15 * 60 * 1000, sitemap: 6 * 3600 * 1000 };
const MAX_ENTRIES = 600;
const mem = new Map();

// Publishing or taking down a post clears this instance's blog copies at once
// (called from the review page in blog.js).
export function forgetBlog() {
  for (const k of [...mem.keys()]) if (k.startsWith('blog') || k === 'sm|blog') mem.delete(k);
}

async function cached(key, ttl, fn) {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  // A request already in flight is shared, unless it's been pending 25s+: if
  // the visitor who started it left, Cloudflare may have cancelled it and it
  // would never finish, leaving everyone after them waiting.
  if (hit?.promise && Date.now() - hit.started < 25000) return hit.promise;
  const promise = fn();
  mem.set(key, { at: 0, promise, started: Date.now() });
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
    if (parts[1] === 'blog' && !parts[2]) {
      const key = `blog|${['page', 'q', 'ticker', 'insider', 'kind', 'limit'].map(k => url.searchParams.get(k) || '').join('|')}`.toLowerCase();
      return json(await cached(key, 60 * 1000, () => blogList(ctx, url)), 200, 0);
    }
    if (parts[1] === 'blog' && parts[2] === 'post' && parts[3] && !parts[4]) {
      const slug = decodeURIComponent(parts[3]).toLowerCase();
      const preview = (url.searchParams.get('preview') || '').slice(0, 64);
      if (preview) {
        // A draft for review: never cached anywhere.
        return json(await blogPost(ctx, slug, preview), 200, 0);
      }
      // 200 with known: false for a missing post, so the app shows its own
      // "not found" and the site's page sets a 404 itself.
      return json(await cached(`blogpost|${slug}`, 60 * 1000, () => blogPost(ctx, slug)), 200, 0);
    }
    if (parts[1] === 'congress' && !parts[2]) return json(await cached('congress', TTL.hub, () => congressHub(ctx)));
    if (parts[1] === 'stocks' && !parts[2]) return json(await cached('stocks', TTL.sitemap, () => stocksDirectory(ctx)), 200, 3600);
    if (parts[1] === 'freshness' && !parts[2]) return json(await cached('freshness', 60 * 1000, () => freshness(ctx)), 200, 60);
    // Whether the yearly Pro price is set up, so the pricing card only
    // mentions it once checkout can actually sell it.
    if (parts[1] === 'pricing' && !parts[2]) return json({ annual: !!env.STRIPE_PRICE_PRO_ANNUAL }, 200, 600);
    if (parts[1] === 'insider-buying' && !parts[2]) {
      const d = await marketFeed(ctx); // has its own 10-minute cache
      return json({ ...d, today: new Date().toISOString().slice(0, 10) }, 200, 300);
    }
    if (parts[1] === 'sitemap.xml') return xml(await cached('sm|index', TTL.sitemap, () => sitemapIndex()));
    if (parts[1] === 'sitemap' && parts[2]) {
      const name = parts[2].replace(/\.xml$/, '');
      if (name === 'static') return xml(staticSitemap());
      if (name === 'stocks') return xml(await cached('sm|stocks', TTL.sitemap, () => stockSitemap(ctx)));
      if (name === 'blog') return xml(await cached('sm|blog', 10 * 60 * 1000, () => blogSitemap(ctx, urlset)));
      if (name === 'congress') return xml(await cached('sm|congress', TTL.sitemap, () => congressSitemap(ctx)));
      // insiders-1.xml is the old name Google already knows; insiders-2 and up
      // no longer exist and answer with an empty list so Google drops them.
      if (name === 'insiders' || name === 'insiders-1') return xml(await cached('sm|ins', TTL.sitemap, () => insiderSitemap(ctx)));
      if (/^insiders-\d{1,2}$/.test(name)) return xml(urlset([]));
    }
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    console.error('[Worker] public route failed:', url.pathname, e.message);
    return json({ error: 'Something went wrong loading this. Try again in a moment.' }, 500, 0);
  }
}

// ── Freshness ────────────────────────────────────────────────────────────────
// The last complete ingest run that looked at today's filings (written by
// db/fetch_filings_neon.py into ingest_runs). A manual backfill of old dates
// doesn't count. null until db/migrations/2026-10-22_ingest_runs_and_planned.sql
// has been run, and the site simply hides the line.
async function freshness(ctx) {
  try {
    const [r] = await ctx.db(`
      SELECT max(finished_at) AS checked_at FROM public.ingest_runs
       WHERE ok AND end_date >= CURRENT_DATE - 1`);
    return { checked_at: r?.checked_at ? new Date(r.checked_at).toISOString() : null };
  } catch {
    return { checked_at: null };
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
         AND upper(f.ticker) NOT IN ('N/A', 'NA', 'NONE', 'NULL', 'UNKNOWN', 'TBD', 'NOTICKER', 'FOMC')
         AND ${DATE} <= CURRENT_DATE AND f.filing_date > CURRENT_DATE - 120
       ORDER BY ${DATE} DESC, f.filing_date DESC
       LIMIT 60`),
    ctx.db(`
      SELECT f.ticker, (ARRAY_AGG(f.company_name ORDER BY (COALESCE(f.transaction_code, '') LIKE 'CONGRESS%'), f.filing_date DESC))[1] AS company_name,
             COUNT(DISTINCT f.insider_name)::int AS members,
             COUNT(*) FILTER (WHERE f.transaction_type = 'buy')::int AS buys,
             COUNT(*) FILTER (WHERE f.transaction_type = 'sell')::int AS sells
        FROM public.filings f
       WHERE ${CONGRESS} AND f.transaction_type IN ('buy','sell') AND f.ticker IS NOT NULL
         AND upper(f.ticker) NOT IN ('N/A', 'NA', 'NONE', 'NULL', 'UNKNOWN', 'TBD', 'NOTICKER', 'FOMC')
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
      tickers: [...new Set((r.tickers || []).filter(t => !isPlaceholderTicker(t)))].slice(0, 4),
    })),
    recent: recent.map(tradeOut),
    popular: popular.map(r => ({
      ticker: r.ticker, company: prettyCompany(r.company_name) || r.ticker,
      members: Number(r.members) || 0, buys: Number(r.buys) || 0, sells: Number(r.sells) || 0,
    })),
  };
}

// ── Sitemaps ─────────────────────────────────────────────────────────────────
// Only pages that show something real go in: a stock or person page is listed
// when it has open-market trades in its 12-month view, not just grants or a
// filing from years ago. A new site that offers Google tens of thousands of
// near-empty pages gets them "discovered, not indexed" and the whole site
// judged thin; a few thousand solid ones get crawled and kept.
//
//   static    the hub pages
//   blog      /blog and every published post (blog.js)
//   stocks    an open-market buy or sale by a company insider in 12 months
//   insiders  company insiders with an open-market trade in 12 months and
//             2+ trades or $100K+ (funds and holding companies left out),
//             top 15,000 by dollars
//   congress  members with a trade in the last 2 years
//
// lastmod is the page's latest trade, so it only moves when the page does.
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const urlset = urls => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
  urls.map(u => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')
}\n</urlset>\n`;
const day = d => asDate(d) || null;
const SM_TICKER = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;
const SM_PEOPLE_MAX = 15000;
const CORP = `COALESCE(f.relationship, '') <> 'congress' AND COALESCE(f.transaction_code, '') NOT LIKE 'CONGRESS%'`;

// Terms and privacy stay linked from every page's footer; they don't need to
// be in a sitemap. /blog is listed in the blog sitemap.
export const STATIC_PATHS = ['/', '/stocks', '/insider-buying', '/congress', '/leaderboard', '/about', '/data-download', '/help'];
function staticSitemap() {
  const today = new Date().toISOString().slice(0, 10);
  return urlset(STATIC_PATHS.map(p => ({ loc: SITE + p, lastmod: ['/', '/stocks', '/congress', '/insider-buying', '/leaderboard'].includes(p) ? today : null })));
}

// Which stocks get a sitemap entry and a spot in the /stocks directory: a real
// ticker with at least one Form 4. Tickers that only appear in Congress
// disclosures are often not stocks at all (FOMC, fund and bond codes from the
// PTR text), and the ones that are real have thin pages.
const STOCK_OK = `e.kind = 'stock' AND e.key ~ '^[A-Z0-9][A-Z0-9.\\-]{0,9}$'
   AND e.key NOT IN ('NONE', 'NA', 'N.A', 'NULL', 'UNKNOWN', 'TBD', 'NOTICKER', 'FOMC')  -- placeholders, not tickers
   AND EXISTS (SELECT 1 FROM public.filings f WHERE f.ticker = e.key AND COALESCE(f.transaction_code, '') NOT LIKE 'CONGRESS%')`;

async function stocksDirectory(ctx) {
  const rows = await ctx.db(`
    SELECT e.key, e.label, e.n, e.last_date FROM public.search_entities e
     WHERE ${STOCK_OK} AND e.last_date >= CURRENT_DATE - 365
     ORDER BY e.n DESC LIMIT 1500`);
  const all = rows.map(r => ({ t: r.key, c: prettyCompany(r.label) || r.key, n: Number(r.n) || 0 }));
  return {
    popular: all.slice(0, 40).map(({ t, c }) => ({ t, c })),
    stocks: all.map(({ t, c }) => ({ t, c })).sort((a, b) => a.t.localeCompare(b.t)),
  };
}

const CONGRESS_WHERE = `kind = 'person' AND congress = true AND last_date >= CURRENT_DATE - 730 AND n >= 1`;

async function sitemapIndex() {
  const today = new Date().toISOString().slice(0, 10);
  const maps = ['static', 'blog', 'stocks', 'insiders', 'congress'];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    maps.map(m => `  <sitemap><loc>${SITE}/sitemap/${m}.xml</loc><lastmod>${today}</lastmod></sitemap>`).join('\n')
  }\n</sitemapindex>\n`;
}

async function stockSitemap(ctx) {
  const rows = await ctx.db(`
    SELECT f.ticker, MAX(f.filing_date) AS last
      FROM public.filings f
     WHERE f.is_open_market AND f.transaction_type IN ('buy', 'sell') AND ${CORP}
       AND f.filing_date >= CURRENT_DATE - 365 AND f.filing_date <= CURRENT_DATE
       AND f.ticker IS NOT NULL
     GROUP BY f.ticker
     ORDER BY COUNT(*) DESC`);
  return urlset(rows.filter(r => SM_TICKER.test(r.ticker) && !isPlaceholderTicker(r.ticker))
    .map(r => ({ loc: `${SITE}/stock/${encodeURIComponent(r.ticker)}`, lastmod: day(r.last) })));
}

async function insiderSitemap(ctx) {
  const rows = await ctx.db(`
    SELECT f.insider_name AS name, MAX(f.filing_date) AS last
      FROM public.filings f
     WHERE f.is_open_market AND f.transaction_type IN ('buy', 'sell') AND ${CORP}
       AND f.filing_date >= CURRENT_DATE - 365 AND f.filing_date <= CURRENT_DATE
       AND f.insider_name IS NOT NULL AND f.insider_name <> ''
     GROUP BY f.insider_name
    HAVING COUNT(*) >= 2 OR SUM(f.value) >= 100000
     ORDER BY SUM(f.value) DESC NULLS LAST
     LIMIT ${SM_PEOPLE_MAX + 3000}`);
  return urlset(rows.filter(r => !isEntityName(r.name)).slice(0, SM_PEOPLE_MAX)
    .map(r => ({ loc: `${SITE}/insider/${encodeURIComponent(r.name)}`, lastmod: day(r.last) })));
}

async function congressSitemap(ctx) {
  const rows = await ctx.db(`
    SELECT key, last_date FROM public.search_entities
     WHERE ${CONGRESS_WHERE}
     ORDER BY n DESC, key LIMIT 2000`);
  return urlset(rows.map(r => ({ loc: `${SITE}/insider/${encodeURIComponent(r.key)}`, lastmod: day(r.last_date) })));
}
