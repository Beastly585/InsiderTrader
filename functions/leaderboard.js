// /leaderboard — top insiders by how their buys did vs the S&P 500.
import { serve, layout, crumbs, h, personHref, stockHref, plural, SITE } from '../edge/seo.js';

export function onRequestGet(context) {
  return serve(context, '/public/leaderboard?years=1&source=all', d => {
    const rows = (d.ranked || []).map(r => `<li><a href="${personHref(r.raw)}">${h(r.name)}</a>${r.role ? `, ${h(r.role)}` : ''}${
      (r.tickers || []).length ? ` (${r.tickers.slice(0, 2).map(t => `<a href="${stockHref(t)}">${h(t)}</a>`).join(', ')})` : ''}: ${
      r.excess != null ? `${r.excess >= 0 ? '+' : ''}${Math.round(r.excess)} points vs the S&amp;P 500` : ''}, ${plural(r.priced || r.om_buys || 0, 'buy')}${r.hit_rate != null ? `, ${r.hit_rate}% up 5% or more` : ''}</li>`).join('');
    const top = (d.ranked || []).slice(0, 3).map(r => r.name);
    return {
      canonical: '/leaderboard',
      title: 'Best Insider Traders: Leaderboard of Insider Buying Track Records | Seli',
      description: `Which company insiders' stock purchases have beaten the S&P 500 over the last 12 months${top.length ? `, led by ${top.join(', ')}` : ''}. Ranked from SEC Form 4 filings.`,
      body: layout(`
<header class="sx-head sx-head--page"><div class="sx-head__main"><h1 class="sx-head__title">Insider leaderboard</h1>
<p class="sx-head__desc">People whose open-market buys have done best since they made them, compared with the S&amp;P 500 over the same periods. At least 3 scored buys averaging $25K or more; companies and funds are left out.</p></div></header>
<section class="sx-card"><div class="sx-card__body"><ol>${rows}</ol></div></section>`),
      prefetch: { path: '/public/leaderboard?years=1&source=all', data: d },
      jsonld: [crumbs([['Seli', '/'], ['Insider leaderboard', '/leaderboard']]),
        { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Insider leaderboard', url: `${SITE}/leaderboard` }],
    };
  });
}
