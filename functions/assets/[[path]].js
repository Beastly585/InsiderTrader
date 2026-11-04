// /assets/* — the built JS and CSS. If a file isn't there (a page from the
// previous deploy asking for an old file, or a request that lands mid-deploy),
// Pages would answer with index.html, and _headers marks /assets/* as cacheable
// for a year. Browsers then keep that HTML as the "script" and the app never
// starts. Answer a real 404 that nothing caches instead.
export async function onRequest(context) {
  const res = await context.next();
  const type = res.headers.get('Content-Type') || '';
  if (res.status === 200 && type.includes('text/html')) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  }
  return res;
}
