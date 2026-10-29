// Fetches a sitemap from the Worker and caches it at the edge (6 hours unless told otherwise).
const DEFAULT_WORKER = 'https://neon-proxy.beastly-insider-trades.workers.dev';

export async function proxyXml(context, path, maxAge = 21600) {
  const cache = caches.default;
  const key = new Request(new URL(path.replace('/public', ''), context.request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const base = (context.env.WORKER_URL || DEFAULT_WORKER).replace(/\/$/, '');
  const headers = context.env.EDGE_KEY ? { 'X-Seli-Edge': context.env.EDGE_KEY } : {};
  const res = await fetch(base + path, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return new Response('Sitemap unavailable', { status: 503, headers: { 'Retry-After': '600' } });
  const out = new Response(await res.text(), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': `public, max-age=${maxAge}` },
  });
  context.waitUntil(cache.put(key, out.clone()));
  return out;
}
