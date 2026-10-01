// /stock/:ticker — see edge/seo.js for how these pages work.
import { serve, renderShell, price, layout, tradeTable, crumbs, cta, h, personHref, money, plural, shortDate, clip, SITE } from '../../edge/seo.js';

export function onRequestGet(context) {
  const t = String(context.params.ticker || '').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(t)) return renderShell(context, null);
  return serve(context, `/public/stock/${encodeURIComponent(t)}`, (d, status) => {
    if (status === 404 || !d.known) {
      return {
        status: 404, noindex: true, canonical: `/stock/${t}`,
        title: `${t}: no insider filings found | Seli`,
        description: `Seli has no SEC Form 4 insider filings on record for ${t}.`,
        body: layout(`<h1 class="sx-head__title">${h(t)}</h1><p>No insider filings on record for this ticker yet.</p>`),
      };
    }
    const s = d.summary || {};
    const yb = s.yr_buys || {}, ys = s.yr_sells || {};
    const name = `${d.company} (${t})`;
    const lines = (s.lines || []).map(l => `<li>${h(l)}</li>`).join('');
    const insiders = (d.insiders || []).slice(0, 15).map(p => `<li><a href="${personHref(p.raw)}">${h(p.name)}</a>${p.role ? `, ${h(p.role)}` : ''}: ${
      [p.buys ? `bought ${money(p.buy_v)} (${plural(p.buys, 'buy')})` : '', p.sells ? `sold ${money(p.sell_v)} (${plural(p.sells, 'sale')})` : ''].filter(Boolean).join(', ') || 'other filings'
    }${p.last ? `, last ${h(shortDate(p.last, { year: true }))}` : ''}</li>`).join('');
    const body = layout(`
<header class="sx-head sx-head--page"><div class="sx-head__main">
<h1 class="sx-head__title">${h(name)} insider trading</h1>
<p class="sx-head__desc">Every open-market stock purchase and sale by ${h(d.company)} executives, directors, large shareholders and members of Congress, from SEC Form 4 filings.${d.sector ? ` Sector: ${h(d.sector)}.` : ''}</p>
</div></header>
<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Insider activity at a glance</h2><ul>${lines}</ul>
<p>Last 12 months: insiders bought ${yb.n ? money(yb.v) : '$0'} (${plural(yb.n || 0, 'buy')}) and sold ${ys.n ? money(ys.v) : '$0'} (${plural(ys.n || 0, 'sale')}).${d.price ? ` Last close ${price(d.price.close)} on ${h(shortDate(d.price.date, { year: true }))}.` : ''}</p></div></section>
<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Recent ${h(t)} insider trades</h2>${tradeTable(d.trades, { showTicker: false })}</div></section>
${insiders ? `<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Who's trading ${h(t)}</h2><ul>${insiders}</ul></div></section>` : ''}
${cta(`an insider at ${d.company}`)}`);
    const desc = s.lines?.length
      ? `${d.company} (${t}) insider trading: ${s.lines.slice(0, 2).join(' ')}`
      : `Insider buying and selling at ${d.company} (${t}) from SEC Form 4 filings, updated daily.`;
    return {
      canonical: `/stock/${t}`,
      title: `${name} Insider Trading: Buys & Sells by Executives | Seli`,
      description: desc,
      body,
      prefetch: { path: `/public/stock/${t}`, data: d },
      jsonld: [
        crumbs([['Seli', '/'], ['Insider buying', '/insider-buying'], [name, `/stock/${t}`]]),
        { '@context': 'https://schema.org', '@type': 'WebPage', name: `${name} insider trading`, url: `${SITE}/stock/${t}`,
          description: clip(desc), about: { '@type': 'Corporation', name: d.company, tickerSymbol: t } },
      ],
    };
  });
}
