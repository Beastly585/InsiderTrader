// /blog, /blog/page/N, /blog/:slug and /blog/rss.xml. See edge/seo.js for how
// these pages work: the post is written into the HTML (so Google reads it
// without running JavaScript), with NewsArticle data, and the app takes over
// once it loads.
//
// A filtered timeline (?q=, ?ticker=, ?kind=) and a draft preview (?preview=)
// are left out of the index and rendered by the app alone.
import { serve, renderShell, workerJson, layout, crumbs, h, stockHref, personHref, money, price, shortDate, SITE, clip, safeDecode } from '../../edge/seo.js';

const AUTHOR = 'Kevin Maresca';
const TITLE = 'Insider Trading News: Notable Insider Buys and Sells | Seli';
const DESC = 'Notable insider buying and selling from SEC Form 4 filings, written up as it is filed: CEO and first-time buys, cluster buys, reversals, and heavy unplanned selling, plus a weekly roundup.';
const KIND = { buy: 'Insider buy', sell: 'Insider sale', roundup: 'Weekly roundup' };
const RSS_LINK = `<link rel="alternate" type="application/rss+xml" title="Seli: insider trading news" href="${SITE}/blog/rss.xml">`;
const PUBLISHER = { '@type': 'Organization', name: 'Seli', url: SITE, logo: { '@type': 'ImageObject', url: `${SITE}/favicon.png` } };
const day = iso => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : '');

export function onRequestGet(context) {
  const url = new URL(context.request.url);
  const parts = [].concat(context.params.path || []).map(safeDecode).filter(Boolean);
  if (parts[0] === 'rss.xml' && parts.length === 1) return rss(context);
  if (!parts.length) return timeline(context, url, 1);
  if (parts[0] === 'page' && parts.length === 2 && /^\d{1,3}$/.test(parts[1])) {
    const n = Number(parts[1]);
    return n > 1 ? timeline(context, url, n) : Response.redirect(`${SITE}/blog`, 301);
  }
  if (parts.length === 1 && /^[a-z0-9-]{1,160}$/i.test(parts[0])) return post(context, url, parts[0].toLowerCase());
  return renderShell(context, notFound());
}

function notFound() {
  return {
    status: 404, noindex: true, canonical: '/blog', title: 'Post not found | Seli',
    description: 'That post is not on the Seli blog.',
    body: layout('<h1 class="sx-head__title">Post not found</h1><p><a href="/blog">See every post</a>.</p>'),
  };
}

// ── Timeline ─────────────────────────────────────────────────────────────────
const entry = p => `<li><p>${h(KIND[p.kind] || p.kind)}${(p.tags || []).filter(t => t !== 'Weekly roundup').map(t => ` · ${h(t)}`).join('')} · <time datetime="${h(day(p.published_at))}">${h(shortDate(day(p.published_at), { year: true }))}</time></p>
<h2><a href="/blog/${h(p.slug)}">${h(p.title)}</a></h2><p>${h(p.summary)}</p>${p.ticker ? `<p><a href="${stockHref(p.ticker)}">${h(p.ticker)} insider trading</a></p>` : ''}</li>`;

function timeline(context, url, n) {
  const filtered = ['q', 'ticker', 'kind', 'insider'].some(k => url.searchParams.get(k));
  const canonical = n > 1 ? `/blog/page/${n}` : '/blog';
  const fallback = {
    canonical, title: TITLE, description: DESC, headHtml: RSS_LINK, noindex: filtered,
    body: layout(`<h1 class="sx-head__title">Insider trading news</h1><p>${h(DESC)}</p>`),
  };
  // Search results and filters: the app fetches them; not for the index.
  if (filtered) return renderShell(context, fallback);
  const path = `/public/blog?page=${n}`;
  return serve(context, path, d => {
    if (n > (d.pages || 1)) return { ...notFound(), canonical };
    const posts = d.posts || [];
    const nav = [n > 1 ? `<a href="${n === 2 ? '/blog' : `/blog/page/${n - 1}`}" rel="prev">Newer posts</a>` : '', n < d.pages ? `<a href="/blog/page/${n + 1}" rel="next">Older posts</a>` : ''].filter(Boolean).join(' · ');
    const tickers = [...new Set(posts.map(p => p.ticker).filter(Boolean))].slice(0, 5);
    return {
      canonical, headHtml: RSS_LINK,
      title: n > 1 ? `Insider Trading News, Page ${n} | Seli` : TITLE,
      description: n > 1 ? `Older insider trading write-ups from SEC Form 4 filings, page ${n}.` : (tickers.length ? `${DESC} Latest: ${tickers.join(', ')}.` : DESC),
      body: layout(`
<header class="sx-head sx-head--page"><div class="sx-head__main"><h1 class="sx-head__title">Insider trading news${n > 1 ? `, page ${n}` : ''}</h1><p class="sx-head__desc">${h(DESC)}</p></div></header>
<ol class="sx-wire">${posts.map(entry).join('') || '<li>The first write-ups land here as notable trades are filed.</li>'}</ol>
${nav ? `<p>${nav}</p>` : ''}`),
      prefetch: { path, data: d },
      jsonld: [
        crumbs([['Seli', '/'], ['Insider trading news', '/blog']]),
        { '@context': 'https://schema.org', '@type': 'Blog', name: 'Seli insider trading news', url: `${SITE}/blog`, description: DESC, publisher: PUBLISHER,
          blogPost: posts.map(p => ({ '@type': 'BlogPosting', headline: p.title, url: `${SITE}/blog/${p.slug}`, datePublished: p.published_at, author: { '@type': 'Person', name: AUTHOR } })) },
      ],
    };
  }, fallback);
}

// ── One post ─────────────────────────────────────────────────────────────────
const li = items => (items || []).map(x => `<li>${h(x)}</li>`).join('');
function tradeHtml(p, b) {
  const sell = p.kind === 'sell';
  const people = (b.people || []).map(x => `<tr><td><a href="${personHref(x.raw)}">${h(x.name)}</a>${x.role ? ` (${h(x.role)})` : ''}</td><td>${money(x.value)}</td><td>${price(x.price)}</td><td>${h(shortDate(x.last || x.first, { year: true }))}</td><td>${x.sec_url ? `<a href="${h(x.sec_url)}" rel="noopener">Form 4</a>` : ''}</td></tr>`).join('');
  return `<p class="sx-post__lead">${h(b.lead)}</p>
<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">The trades at a glance</h2><dl class="sx-facts">${(b.facts || []).map(([k, v]) => `<dt>${h(k)}</dt><dd>${h(v)}</dd>`).join('')}</dl></div></section>
${b.why?.length ? `<section class="sx-post__sec"><h2>Why it stands out</h2><ul>${li(b.why)}</ul></section>` : ''}
<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">${sell ? 'Who sold' : 'Who bought'}</h2>
<table class="sx-table"><thead><tr><th>Insider</th><th>${sell ? 'Sold' : 'Bought'}</th><th>Avg price</th><th>Date</th><th>Filing</th></tr></thead><tbody>${people}</tbody></table></div></section>
${b.context?.length ? `<section class="sx-post__sec"><h2>Context</h2><ul>${li(b.context)}</ul></section>` : ''}
<p><a href="${stockHref(p.ticker)}">Every ${h(p.ticker)} insider trade, with a price chart</a>${(b.people || [])[0] ? ` · <a href="${personHref(b.people[0].raw)}">${h(b.people[0].name)}'s trades</a>` : ''}</p>`;
}
function roundupHtml(b) {
  const rows = (list, sell) => (list || []).map(r => `<tr><td><a href="${stockHref(r.ticker)}">${h(r.ticker)}</a> ${h(r.company)}</td><td>${r.insiders}</td><td>${money(r.value)}</td>${
    sell ? `<td>${r.planned} of ${r.trades} planned</td>` : `<td>${price(r.avg_price)}</td><td>${r.now ? price(r.now) : ''}</td>`}</tr>`).join('');
  return `<p class="sx-post__lead">${h(b.lead)}</p>
${b.buys?.length ? `<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Biggest buying</h2><table class="sx-table"><thead><tr><th>Stock</th><th>Insiders</th><th>Bought</th><th>Avg price</th><th>Now</th></tr></thead><tbody>${rows(b.buys, false)}</tbody></table></div></section>` : ''}
${b.sells?.length ? `<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Biggest selling</h2><table class="sx-table"><thead><tr><th>Stock</th><th>Insiders</th><th>Sold</th><th>Planned</th></tr></thead><tbody>${rows(b.sells, true)}</tbody></table></div></section>` : ''}
${b.method ? `<p>${h(b.method)}</p>` : ''}`;
}

function post(context, url, slug) {
  const fallback = {
    canonical: `/blog/${slug}`, title: 'Insider trading news | Seli', description: DESC, headHtml: RSS_LINK,
    body: layout('<h1 class="sx-head__title">Insider trading news</h1>'),
  };
  // A draft preview from the review email: the app loads it, nothing is cached or indexed.
  if (url.searchParams.get('preview')) return renderShell(context, { ...fallback, noindex: true });
  const path = `/public/blog/post/${slug}`;
  return serve(context, path, d => {
    if (!d.known) return notFound();
    const p = d.post, b = p.body || {};
    const related = (d.related || []).map(r => `<li><a href="/blog/${h(r.slug)}">${h(r.title)}</a></li>`).join('');
    const names = (p.insiders || []).map(i => i.name).filter(Boolean);
    return {
      canonical: `/blog/${p.slug}`, headHtml: RSS_LINK, ogType: 'article',
      title: `${p.title} | Seli`,
      description: p.summary,
      body: layout(`
<p><a href="/blog">Insider trading news</a>${p.ticker ? ` / <a href="${stockHref(p.ticker)}">${h(p.ticker)}</a>` : ''}</p>
<article><header class="sx-post__head"><p>${h(KIND[p.kind] || '')}${(p.tags || []).filter(t => t !== 'Weekly roundup').map(t => ` · ${h(t)}`).join('')}</p>
<h1 class="sx-post__title">${h(p.title)}</h1>
<p class="sx-post__by">By ${h(b.author || AUTHOR)} · <time datetime="${h(p.published_at)}">${h(shortDate(day(p.published_at), { year: true }))}</time></p></header>
${p.kind === 'roundup' ? roundupHtml(b) : tradeHtml(p, b)}</article>
${related ? `<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">More insider trading news</h2><ul>${related}</ul></div></section>` : ''}
<p>Written up from SEC Form 4 filings. Not investment advice.</p>
<p class="seo-cta"><a href="/">Get a free email when insiders trade your stocks →</a></p>`),
      prefetch: { path, data: d },
      jsonld: [
        crumbs([['Seli', '/'], ['Insider trading news', '/blog'], [p.title, `/blog/${p.slug}`]]),
        {
          '@context': 'https://schema.org', '@type': 'NewsArticle',
          headline: clip(p.title, 110), description: clip(p.summary), url: `${SITE}/blog/${p.slug}`,
          mainEntityOfPage: `${SITE}/blog/${p.slug}`,
          datePublished: p.published_at, dateModified: p.updated_at || p.published_at,
          author: { '@type': 'Person', name: b.author || AUTHOR, url: `${SITE}/about` },
          publisher: PUBLISHER, image: [`${SITE}/og-image.png`],
          keywords: [p.ticker, p.company, ...names, ...(p.tags || []), 'insider trading', 'Form 4'].filter(Boolean).join(', '),
          ...(p.ticker ? { about: { '@type': 'Corporation', name: p.company || p.ticker, tickerSymbol: p.ticker } } : {}),
          ...(names.length ? { mentions: (p.insiders || []).map(i => ({ '@type': 'Person', name: i.name, url: `${SITE}${personHref(i.raw)}` })) } : {}),
        },
      ],
    };
  }, fallback);
}

// ── RSS ──────────────────────────────────────────────────────────────────────
const x = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function rss(context) {
  let posts = [];
  try {
    const { data } = await workerJson(context, '/public/blog?page=1');
    posts = data?.posts || [];
  } catch { /* an empty feed beats an error */ }
  const items = posts.map(p => `<item><title>${x(p.title)}</title><link>${SITE}/blog/${p.slug}</link><guid isPermaLink="true">${SITE}/blog/${p.slug}</guid>${
    p.published_at ? `<pubDate>${new Date(p.published_at).toUTCString()}</pubDate>` : ''}<description>${x(p.summary)}</description>${
    (p.tags || []).map(t => `<category>${x(t)}</category>`).join('')}</item>`).join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>Seli: insider trading news</title><link>${SITE}/blog</link><description>${x(DESC)}</description><language>en-us</language>
<atom:link href="${SITE}/blog/rss.xml" rel="self" type="application/rss+xml"/>
${items}
</channel></rss>`;
  return new Response(body, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=900' } });
}
