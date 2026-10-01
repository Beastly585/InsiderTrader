// /congress — Congress stock trades hub. See edge/seo.js.
import { serve, layout, tradeTable, crumbs, h, personHref, stockHref, plural, shortDate, SITE } from '../edge/seo.js';

export function onRequestGet(context) {
  return serve(context, '/public/congress', d => {
    const members = (d.members || []).map(m => `<li><a href="${personHref(m.raw)}">${h(m.name)}</a>: ${plural(m.n, 'trade')} in the last 12 months${
      m.tickers?.length ? ` (${m.tickers.map(t => `<a href="${stockHref(t)}">${h(t)}</a>`).join(', ')})` : ''}${m.last ? `, latest ${h(shortDate(m.last, { year: true }))}` : ''}</li>`).join('');
    const popular = (d.popular || []).map(p => `<li><a href="${stockHref(p.ticker)}">${h(p.ticker)}</a> ${h(p.company)}: ${plural(p.members, 'member')}, ${plural(p.buys, 'buy')}, ${plural(p.sells, 'sale')}</li>`).join('');
    const names = (d.members || []).slice(0, 5).map(m => m.name);
    return {
      canonical: '/congress',
      title: 'Congress Stock Trades Tracker: Latest STOCK Act Disclosures | Seli',
      description: `What members of Congress are buying and selling, from STOCK Act disclosures, updated daily.${names.length ? ` Latest filers include ${names.join(', ')}.` : ''}`,
      body: layout(`
<header class="sx-head sx-head--page"><div class="sx-head__main">
<h1 class="sx-head__title">Congress stock trades</h1>
<p class="sx-head__desc">Members of Congress have to disclose their stock trades under the STOCK Act, usually within 45 days. Here's every recent disclosure, who filed it, and which stocks Congress is trading most.</p></div></header>
<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Latest disclosures</h2>${tradeTable(d.recent, { limit: 40 })}</div></section>
${popular ? `<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Most traded by Congress (90 days)</h2><ul>${popular}</ul></div></section>` : ''}
<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Members who traded in the last 12 months</h2><ul>${members}</ul></div></section>
<p class="seo-cta"><a href="/">Get an email when a member of Congress trades a stock you own →</a></p>`),
      prefetch: { path: '/public/congress', data: d },
      jsonld: [
        crumbs([['Seli', '/'], ['Congress stock trades', '/congress']]),
        { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Congress stock trades', url: `${SITE}/congress`,
          description: 'Recent STOCK Act stock trade disclosures by members of the U.S. House and Senate.' },
      ],
    };
  });
}
