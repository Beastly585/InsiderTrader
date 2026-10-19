// /stocks — A to Z directory of every stock with recent insider filings.
// Gives Google (and people) a crawlable path to each stock page.
import { serve, layout, crumbs, h, stockHref, SITE, PAGE_TITLES } from '../edge/seo.js';

const letterOf = t => (/^[A-Z]/.test(t) ? t[0] : '#');

export function onRequestGet(context) {
  return serve(context, '/public/stocks', d => {
    const stocks = d.stocks || [];
    const groups = new Map();
    for (const s of stocks) {
      const k = letterOf(s.t);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    const jump = [...groups.keys()].map(k => `<a href="#letter-${k === '#' ? 'num' : k}">${k}</a>`).join(' ');
    const sections = [...groups.entries()].map(([k, list]) => `
<section class="sx-card" id="letter-${k === '#' ? 'num' : k}"><div class="sx-card__body"><h2 class="sx-card__title">${k}</h2>
<ul>${list.map(s => `<li><a href="${stockHref(s.t)}">${h(s.t)}</a> ${h(s.c)}</li>`).join('')}</ul></div></section>`).join('');
    const popular = (d.popular || []).slice(0, 20).map(s => `<a href="${stockHref(s.t)}">${h(s.t)}</a>`).join(' ');
    return {
      canonical: '/stocks',
      title: PAGE_TITLES.stocks,
      description: `Insider trading for ${stocks.length.toLocaleString('en-US')} stocks: every open-market buy and sale by executives, directors and large shareholders from SEC Form 4 filings, A to Z.`,
      body: layout(`
<header class="sx-head sx-head--page"><div class="sx-head__main">
<h1 class="sx-head__title">Insider trading by stock</h1>
<p class="sx-head__desc">Every stock with an SEC Form 4 insider filing in the last 12 months. Pick a company to see which executives and directors are buying or selling, and how their past trades did.</p></div></header>
${popular ? `<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Most active</h2><p>${popular}</p></div></section>` : ''}
<p>${jump}</p>
${sections}`),
      prefetch: { path: '/public/stocks', data: d },
      jsonld: [
        crumbs([['Seli', '/'], ['Stocks', '/stocks']]),
        { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Insider trading by stock', url: `${SITE}/stocks`,
          description: 'A to Z directory of stocks with SEC Form 4 insider filings.' },
      ],
    };
  });
}
