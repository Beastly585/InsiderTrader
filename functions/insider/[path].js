// /insider/:name — corporate insiders and members of Congress.
// See edge/seo.js for how these pages work.
import { serve, renderShell, safeDecode, layout, tradeTable, crumbs, cta, h, stockHref, plural, shortDate, clip, SITE } from '../../edge/seo.js';

export function onRequestGet(context) {
  const segs = [].concat(context.params.path || []);
  const raw = segs.map(safeDecode).join('/').slice(0, 200);
  if (!raw.trim()) return renderShell(context, null);
  const api = `/public/insider/${encodeURIComponent(raw)}`;
  const path = `/insider/${encodeURIComponent(raw)}`;
  return serve(context, api, (d, status) => {
    if (status === 404 || !d.known) {
      return {
        status: 404, noindex: true, canonical: path, title: 'Insider not found | Seli',
        description: 'No SEC Form 4 or STOCK Act filings on record for this name.',
        body: layout(`<h1 class="sx-head__title">${h(raw)}</h1><p>No filings on record for this name.</p>`),
      };
    }
    const cos = (d.companies || []).slice(0, 12);
    const tickers = cos.map(c => c.ticker).filter(Boolean);
    const r = d.record || {};
    const since = d.first_trade ? shortDate(d.first_trade, { year: true }) : null;
    const coList = cos.map(c => `<li><a href="${stockHref(c.ticker)}">${h(c.ticker)}</a> ${h(c.company || '')}: ${
      [c.buys ? `${plural(c.buys, 'buy')}` : '', c.sells ? `${plural(c.sells, 'sale')}` : ''].filter(Boolean).join(', ') || 'other filings'
    }${c.last ? `, last ${h(shortDate(c.last, { year: true }))}` : ''}</li>`).join('');
    let title, intro, desc;
    if (d.congress) {
      title = `${d.name} Stock Trades & STOCK Act Disclosures | Seli`;
      intro = `Every stock trade ${h(d.name)} has disclosed under the STOCK Act${since ? `, since ${h(since)}` : ''}. Amounts are the ranges members of Congress are required to report.`;
      desc = `${d.name} stock trades: every STOCK Act disclosure${tickers.length ? `, including ${tickers.slice(0, 4).join(', ')}` : ''}. See what ${d.name} bought and sold, updated daily.`;
    } else {
      const at = cos[0]?.company ? ` at ${cos[0].company}` : '';
      title = `${d.name} Insider Trades${tickers[0] ? ` (${tickers.slice(0, 2).join(', ')})` : ''}: ${d.role || 'Insider'} Form 4 Filings | Seli`;
      intro = `Open-market stock purchases and sales by ${h(d.name)}${d.title ? `, ${h(d.title)}` : ''}${h(at)}, from SEC Form 4 filings${since ? ` since ${h(since)}` : ''}.`;
      desc = `${d.name}${d.role ? ` (${d.role}${at})` : ''} insider trading: every Form 4 buy and sell${tickers.length ? ` in ${tickers.slice(0, 3).join(', ')}` : ''}, with how each buy has done since.`;
    }
    const record = !d.congress && r.priced
      ? `<p>Track record: ${r.hit_rate}% of ${plural(r.priced, 'scored buy')} are up 5% or more since purchase${r.avg_return != null ? `, averaging ${r.avg_return >= 0 ? '+' : ''}${Math.round(r.avg_return)}%` : ''}.</p>` : '';
    const body = layout(`
<header class="sx-head sx-head--page"><div class="sx-head__main">
<h1 class="sx-head__title">${h(d.name)} ${d.congress ? 'stock trades' : 'insider trades'}</h1>
<p class="sx-head__desc">${intro}</p></div></header>
${record}
<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Recent trades</h2>${tradeTable(d.trades, { showPerson: false })}</div></section>
${coList ? `<section class="sx-card"><div class="sx-card__body"><h2 class="sx-card__title">Companies traded</h2><ul>${coList}</ul></div></section>` : ''}
${cta(d.name)}`);
    return {
      canonical: path, title, description: desc, body,
      prefetch: { path: api, data: d },
      jsonld: [
        crumbs([['Seli', '/'], d.congress ? ['Congress stock trades', '/congress'] : ['Insider buying', '/insider-buying'], [d.name, path]]),
        { '@context': 'https://schema.org', '@type': 'ProfilePage', url: SITE + path, name: clip(title, 110),
          mainEntity: { '@type': 'Person', name: d.name, jobTitle: d.congress ? 'Member of Congress' : (d.title || undefined),
            worksFor: cos[0]?.company && !d.congress ? { '@type': 'Corporation', name: cos[0].company, tickerSymbol: cos[0].ticker } : undefined } },
      ],
    };
  });
}
