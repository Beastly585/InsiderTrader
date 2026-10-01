/* global HTMLRewriter */
// edge/seo.js
// Shared by the Pages Functions under functions/. Each public URL (a stock, an
// insider, a member of Congress, the two hub pages) is served as the normal
// app shell (index.html) with:
//   - its own <title>, description, canonical URL, social tags and JSON-LD
//   - the page's real content already inside <div id="root">, so Google and
//     link previews see text without running JavaScript
//   - the same data embedded as window.__SELI_PREFETCH__, so the app renders
//     instantly instead of fetching it again
// React replaces #root as soon as it loads; visitors get the normal app.
//
// If the Worker is slow or down, the plain shell is returned unchanged, so a
// data hiccup can never take the site down.

import { money, congressRange, shortDate, plural, pct, price } from '../src/lib/text.js';

export const SITE = 'https://seli.app';
const DEFAULT_WORKER = 'https://neon-proxy.beastly-insider-trades.workers.dev';
const DATA_TTL = 15 * 60; // seconds, edge cache for Worker JSON

export const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s, n = 158) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
export const stockHref = t => `/stock/${encodeURIComponent(t)}`;
export const personHref = raw => `/insider/${encodeURIComponent(raw)}`;
export const amt = (v, congress) => (congress ? congressRange(v) : money(v));

// Fetch JSON from the Worker's /public/* routes, cached at the edge.
export async function workerJson(context, path) {
  const base = (context.env.WORKER_URL || DEFAULT_WORKER).replace(/\/$/, '');
  const url = base + path;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(`${SITE}/__data${path}`);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return { status: hit.status, data: await hit.json() };
  }
  const headers = { Accept: 'application/json' };
  if (context.env.EDGE_KEY) headers['X-Seli-Edge'] = context.env.EDGE_KEY; // skips the Worker's per-IP rate limit
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (cache && (res.status === 200 || res.status === 404) && data) {
    context.waitUntil(cache.put(key, new Response(text, {
      status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${DATA_TTL}` },
    })));
  }
  return { status: res.status, data };
}

// page: { status, title, description, canonical, jsonld, body, prefetch: {path, data}, noindex }
export async function renderShell(context, page) {
  const { request, env } = context;
  const shell = await env.ASSETS.fetch(new URL('/', request.url));
  if (!page) return shell;
  const canonical = SITE + page.canonical;
  const description = clip(page.description);
  const prefetch = page.prefetch
    ? `<script>window.__SELI_PREFETCH__=${JSON.stringify({ [page.prefetch.path]: page.prefetch.data }).replace(/</g, '\\u003c')};</script>`
    : '';
  const ld = (page.jsonld || []).map(o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`).join('');
  const attr = (sel, name, value) => [sel, { element(el) { el.setAttribute(name, value); } }];
  const handlers = [
    ['title', { element(el) { el.setInnerContent(page.title); } }],
    attr('meta[name="description"]', 'content', description),
    attr('meta[property="og:title"]', 'content', page.title),
    attr('meta[property="og:description"]', 'content', description),
    attr('meta[property="og:url"]', 'content', canonical),
    attr('meta[name="twitter:title"]', 'content', page.title),
    attr('meta[name="twitter:description"]', 'content', description),
    attr('meta[name="twitter:url"]', 'content', canonical),
    attr('link[rel="canonical"]', 'href', canonical),
    attr('meta[name="robots"]', 'content', page.noindex ? 'noindex, follow' : 'index, follow'),
    // The homepage's generic WebApplication block doesn't describe this page.
    ...(page.keepJsonLd ? [] : [['script[type="application/ld+json"]', { element(el) { el.remove(); } }]]),
    ['head', { element(el) { el.append(ld + prefetch, { html: true }); } }],
    ['#root', { element(el) { el.setInnerContent(page.body, { html: true }); } }],
    // The homepage's noscript pitch would be duplicate text on every page.
    ...(page.keepJsonLd ? [] : [['body noscript', { element(el) { el.remove(); } }]]),
  ];
  let rw = new HTMLRewriter();
  for (const [sel, handler] of handlers) rw = rw.on(sel, handler);
  const headers = new Headers(shell.headers);
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return rw.transform(new Response(shell.body, { status: page.status || 200, headers }));
}

// Wraps a page builder: fetch data, build the page, never fail the request.
export async function serve(context, apiPath, build) {
  try {
    const { status, data } = await workerJson(context, apiPath);
    if (!data || status >= 500) return renderShell(context, null);
    return renderShell(context, build(data, status));
  } catch (e) {
    console.error('[seo] falling back to plain shell:', e?.message);
    return renderShell(context, null);
  }
}

// ── Shared bits of markup (uses the app's own CSS classes) ───────────────────
export const crumbs = items => ({
  '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: SITE + path })),
});

export function layout(inner) {
  return `<div class="seo-shell">
<header class="seo-top"><a href="/" class="seo-logo">Seli</a>
<nav><a href="/insider-buying">Insider buying</a> <a href="/congress">Congress trades</a> <a href="/leaderboard">Leaderboard</a> <a href="/">Sign up free</a></nav></header>
<main class="sx-page">${inner}</main>
<footer class="seo-foot"><p>Seli tracks SEC Form 4 insider filings and STOCK Act disclosures from members of Congress.
Data comes from SEC EDGAR and congressional disclosures. Not financial advice.</p>
<p><a href="/insider-buying">Insider buying this week</a> · <a href="/congress">Congress stock trades</a> · <a href="/about">About the data</a> · <a href="/data-download">Download the dataset</a></p></footer>
</div>`;
}

export function tradeTable(trades, { showTicker = true, showPerson = true, limit = 25 } = {}) {
  const rows = (trades || []).slice(0, limit);
  if (!rows.length) return '<p>No open-market trades in the last 12 months.</p>';
  return `<div class="sx-table-wrap"><table class="sx-table"><thead><tr><th>Date</th>${showPerson ? '<th>Insider</th>' : ''}${showTicker ? '<th>Stock</th>' : ''}<th>Trade</th><th>Value</th></tr></thead><tbody>${
    rows.map(t => `<tr><td>${h(shortDate(t.date, { year: true }))}</td>${
      showPerson ? `<td><a href="${personHref(t.raw)}">${h(t.name)}</a>${t.role ? ` <span>(${h(t.role)})</span>` : ''}</td>` : ''}${
      showTicker ? `<td><a href="${stockHref(t.ticker)}">${h(t.ticker)}</a>${t.company ? ` ${h(t.company)}` : ''}</td>` : ''}<td>${
      t.type === 'buy' ? 'Bought' : 'Sold'}${t.om === false ? ' (not open market)' : ''}</td><td>${h(amt(t.value, t.congress))}</td></tr>`).join('')
  }</tbody></table></div>`;
}

export const cta = what => `<p class="seo-cta"><a href="/">Get free alerts when ${h(what)} files a new trade →</a></p>`;
export { money, congressRange, shortDate, plural, pct, price, clip };

// Path segments from Pages can arrive encoded or not; decode once, safely.
export const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };
