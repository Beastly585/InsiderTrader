// /edge-data/public/* — the app's public data, served from the edge cache.
//
// The prerendered pages (functions/stocks.js etc.) already keep a copy of each
// /public/* response at the edge (stale-while-revalidate, see edge/seo.js).
// When someone clicks from one page to another inside the app, though, the
// app used to call the Worker directly, which skipped that copy and waited on
// Neon. If Neon was asleep or a query was slow, the page sat on its loading
// skeleton. This hands the app the same edge copy the prerender uses, so
// in-app navigation is as fast as a fresh page load.
//
// Only the read-only public routes below are passed through, and only GET.
// Anything else 404s, and src/lib/api.js then falls back to the Worker.
import { workerJson } from '../../edge/seo.js';

const ALLOWED = [
  /^\/public\/stocks$/,
  /^\/public\/congress$/,
  /^\/public\/insider-buying$/,
  /^\/public\/leaderboard$/,
  /^\/public\/pricing$/,
  /^\/public\/data-stats$/,
  /^\/public\/stock\/[A-Za-z0-9.\-%]{1,30}$/,
  /^\/public\/insider\/[^?#]{1,400}$/,
  /^\/public\/blog$/,
  /^\/public\/blog\/post\/[a-z0-9-]{1,160}$/,
];

const reply = (body, status, maxAge = 0) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store' },
});

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const path = url.pathname.replace(/^\/edge-data/, '');
  if (!ALLOWED.some(re => re.test(path))) return reply({ error: 'Not found' }, 404);
  // Only the leaderboard and the blog list take options; keep their query
  // string so each variant is cached on its own. Everything else ignores it
  // (so a blog draft preview can never come from, or land in, this cache).
  const full = (path === '/public/leaderboard' || path === '/public/blog') ? path + url.search : path;
  try {
    const { status, data } = await workerJson(context, full);
    if (!data || status >= 500) return reply({ error: 'Unavailable' }, 502);
    // The browser can hold it for a minute; the edge copy does the real work.
    // Not the blog: a post just published should show on the next load.
    return reply(data, status, status === 200 && !path.startsWith('/public/blog') ? 60 : 0);
  } catch {
    return reply({ error: 'Unavailable' }, 502);
  }
}
