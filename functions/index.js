// / — the signed-out home page, pre-filled for Google and link previews.
// Signed-in visitors get the app as usual (React replaces this on load).
import { serve, layout, h, personHref, stockHref, money, amt, SITE } from '../edge/seo.js';

export function onRequestGet(context) {
  return serve(context, '/public/insider-buying', d => {
    const clusters = [d.featured, ...(d.more || [])].filter(Boolean).slice(0, 8);
    const rows = clusters.map(c => `<li><a href="${stockHref(c.ticker)}">${h(c.ticker)}</a> ${h(c.company)}: ${
      (c.buyers || []).slice(0, 2).map(b => `<a href="${personHref(b.raw)}">${h(b.name)}</a> (${h(b.role)}, ${h(amt(b.value, b.congress))})`).join(', ')}, ${money(c.total)} total</li>`).join('');
    return {
      canonical: '/',
      title: 'Seli: Insider Trading & Congress Stock Trades Tracker',
      description: 'Track insider trading and Congress stock trades. Every SEC Form 4 filing and STOCK Act disclosure, explained in plain English, with free alerts on the stocks you own.',
      body: layout(`
<section class="sx-hero"><h1 class="sx-hero__title">See what executives and members of Congress are buying with their own money.</h1>
<p class="sx-hero__sub">Every SEC Form 4 and STOCK Act filing, explained in plain English. Look up any stock or person, and get an email when someone trades what you own.</p></section>
<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Insider buying this week</h2><ul>${rows || '<li>No notable insider buying filed yet this week.</li>'}</ul>
<p><a href="/insider-buying">All insider buying this week</a> · <a href="/congress">Congress stock trades</a> · <a href="/leaderboard">Insider leaderboard</a></p></div></section>`),
      // Keep the homepage's WebApplication JSON-LD from index.html.
      keepJsonLd: true,
      prefetch: { path: '/public/insider-buying', data: d },
      jsonld: [{ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Seli', url: SITE }],
    };
  });
}
