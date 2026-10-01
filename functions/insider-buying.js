// /insider-buying — this week's insider buying hub. See edge/seo.js.
import { serve, layout, crumbs, h, personHref, stockHref, money, amt, SITE } from '../edge/seo.js';

const cluster = c => `<li><a href="${stockHref(c.ticker)}">${h(c.ticker)}</a> ${h(c.company)}: ${h(c.lead || '')} ${
  (c.buyers || []).slice(0, 3).map(b => `<a href="${personHref(b.raw)}">${h(b.name)}</a> (${h(b.role)}, ${h(amt(b.value, b.congress))})`).join(', ')}</li>`;

export function onRequestGet(context) {
  return serve(context, '/public/insider-buying', d => {
    const all = [d.featured, ...(d.more || [])].filter(Boolean);
    const congress = (d.congress || []).map(cluster).join('');
    const sells = (d.sells || []).map(s => `<li><a href="${personHref(s.raw)}">${h(s.name)}</a> (${h(s.role)}) sold ${money(s.value)} of <a href="${stockHref(s.ticker)}">${h(s.ticker)}</a>${s.planned ? ' under a pre-set trading plan' : ''}</li>`).join('');
    const top = all.slice(0, 4).map(c => c.ticker);
    return {
      canonical: '/insider-buying',
      title: 'Insider Buying This Week: Latest CEO & Director Stock Purchases | Seli',
      description: `The biggest open-market insider stock purchases filed with the SEC this week${top.length ? `, including ${top.join(', ')}` : ''}. Updated every few hours from Form 4 filings.`,
      body: layout(`
<header class="sx-head sx-head--page"><div class="sx-head__main">
<h1 class="sx-head__title">Insider buying this week</h1>
<p class="sx-head__desc">Executives and directors buying their own company's stock with their own money, from SEC Form 4 filings in the last 7 days. Open-market buys only; grants and option exercises are left out.</p></div></header>
<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Biggest insider buys</h2><ul>${all.map(cluster).join('') || '<li>No notable insider buying filed yet this week.</li>'}</ul></div></section>
${congress ? `<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Members of Congress buying</h2><ul>${congress}</ul></div></section>` : ''}
${sells ? `<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Largest insider sales</h2><ul>${sells}</ul></div></section>` : ''}
<p class="seo-cta"><a href="/">Get these in your inbox every week, free →</a></p>`),
      prefetch: { path: '/public/insider-buying', data: d },
      jsonld: [
        crumbs([['Seli', '/'], ['Insider buying this week', '/insider-buying']]),
        { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Insider buying this week', url: `${SITE}/insider-buying`,
          description: 'Recent open-market insider stock purchases from SEC Form 4 filings.' },
      ],
    };
  });
}
