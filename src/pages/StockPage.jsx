// src/pages/StockPage.jsx — /stock/:ticker
// Everything about one stock's insiders on one page: the plain-English
// summary (same words as the emails), a price chart with every insider buy
// and sale on it, who's trading, and the filings themselves.
import React, { useEffect, useMemo, useState } from 'react';
import { useApi } from '../lib/api.js';
import { InsiderLink, StockLink, pushRecent } from '../lib/nav.jsx';
import { money, amount, price, shares, pct, shortDate, ago, plural, codeLabel, edgarCompanyUrl } from '../lib/text.js';
import { secFilingUrl } from '../edgar.js';
import { Card, TypeBadge, Segmented, Empty, Skeleton, ErrorNote, Gate, Stat, Icon } from '../components/ui.jsx';
import WatchButton from '../components/WatchButton.jsx';
import PriceChart from '../components/PriceChart.jsx';

const PAGE = 25;

export default function StockPage({ ticker, watchlist, onUpgrade, renderProfile }) {
  const { data, error, loading, reload } = useApi(`/api/stock/${encodeURIComponent(ticker)}`);
  const d = data && data.ticker === ticker ? data : null;

  useEffect(() => {
    document.title = `${ticker}${d?.company ? ` · ${d.company}` : ''} insider trading · Seli`;
    if (d?.known) pushRecent({ kind: 'stock', id: ticker, label: ticker, sub: d.company });
  }, [ticker, d?.company, d?.known]);

  if (error && !d) return <div className="sx-page"><ErrorNote message={error} onRetry={reload} /></div>;
  if (!d) return <div className="sx-page"><StockHeaderSkeleton ticker={ticker} /><Card><Skeleton lines={4} /></Card></div>;
  if (!d.known) {
    return (
      <div className="sx-page">
        <header className="sx-head"><div className="sx-head__main"><h1 className="sx-head__ticker">{ticker}</h1></div></header>
        <Card><Empty title={`No insider filings for ${ticker}`}>
          Either nobody at this company has filed an insider trade since our records start, or the ticker is spelled differently. Try the search box above with the company name.
        </Empty></Card>
      </div>
    );
  }
  return <StockView d={d} watchlist={watchlist} onUpgrade={onUpgrade} renderProfile={renderProfile} loading={loading} />;
}

function StockHeaderSkeleton({ ticker }) {
  return (
    <header className="sx-head">
      <div className="sx-head__main"><h1 className="sx-head__ticker">{ticker}</h1><div className="sx-head__sub"><Skeleton lines={1} /></div></div>
    </header>
  );
}

function StockView({ d, watchlist, onUpgrade, renderProfile }) {
  const s = d.summary;
  const hasCongress = d.trades.some(t => t.congress);
  const [filter, setFilter] = useState('om');
  const [shown, setShown] = useState(PAGE);
  useEffect(() => { setShown(PAGE); }, [filter, d.ticker]);

  const filtered = useMemo(() => d.trades.filter(t =>
    filter === 'all' ? true : filter === 'congress' ? t.congress : filter === 'buys' ? (t.om && t.type === 'buy') : filter === 'sells' ? (t.om && t.type === 'sell') : t.om,
  ), [d.trades, filter]);
  const counts = useMemo(() => ({
    om: d.trades.filter(t => t.om).length, all: d.trades.length, congress: d.trades.filter(t => t.congress).length,
  }), [d.trades]);

  // 1-year change, measured from the first close on or after a year before the latest one.
  const yearAgo = d.price ? new Date(Date.parse(d.price.date + 'T00:00:00Z') - 365 * 86400000).toISOString().slice(0, 10) : null;
  const yearPt = yearAgo && d.prices[0]?.[0] <= yearAgo ? d.prices.find(p => p[0] >= yearAgo) : null;
  const yChg = yearPt && d.price ? (d.price.close - yearPt[1]) / yearPt[1] * 100 : null;
  const edgar = edgarCompanyUrl(d.cik);

  return (
    <div className="sx-page">
      <header className="sx-head">
        <div className="sx-head__main">
          <div className="sx-head__row">
            <h1 className="sx-head__ticker">{d.ticker}</h1>
            <span className="sx-head__name">{d.company}</span>
          </div>
          <div className="sx-head__sub">
            {d.price && <span className="sx-head__price">{price(d.price.close)}</span>}
            {yChg != null && <span className={yChg >= 0 ? 'sx-up' : 'sx-down'}>{pct(yChg, 1)} 1y</span>}
            {d.sector && <span>{d.sector}</span>}
            {d.price && <span className="sx-muted">Close {shortDate(d.price.date)}</span>}
          </div>
        </div>
        <div className="sx-head__actions">
          {edgar && <a className="sx-btn sx-btn--ghost sx-btn--sm" href={edgar} target="_blank" rel="noreferrer">SEC filings <Icon name="external" size={12} /></a>}
          <WatchButton watchlist={watchlist} kind="stock" id={d.ticker} />
        </div>
      </header>

      <div className="sx-grid">
        <div className="sx-grid__main">
          <Card title="What insiders are doing" className="sx-summary">
            {s?.lines?.length ? (
              <div className="sx-lines">
                {s.lines.map((l, i) => <p key={i} className={i === 0 ? 'sx-lines__lead' : ''}>{l}</p>)}
              </div>
            ) : <p className="sx-muted">No open-market insider trades on record.</p>}
            {s && (
              <div className="sx-stats">
                <Stat label="Bought · 12 mo" value={s.yr_buys.n ? money(s.yr_buys.v) : 'None'} sub={s.yr_buys.n ? plural(s.yr_buys.n, 'buy') : 'no open-market buys'} tone={s.yr_buys.n ? 'buy' : undefined} />
                <Stat label="Sold · 12 mo" value={s.yr_sells.n ? money(s.yr_sells.v) : 'None'} sub={s.yr_sells.n ? plural(s.yr_sells.n, 'sale') : 'no open-market sales'} tone={s.yr_sells.n ? 'sell' : undefined} />
                <Stat label="Last insider buy" value={s.last_buy ? ago(s.last_buy.date) : 'Never'} sub={s.last_buy ? <><InsiderLink raw={s.last_buy.raw}>{s.last_buy.name}</InsiderLink> · {money(s.last_buy.value)}</> : 'on record'} />
              </div>
            )}
          </Card>

          <Card title="Price and insider trades" sub="Open-market trades only. Bigger dot, bigger trade.">
            <PriceChart prices={d.prices} trades={d.trades} />
          </Card>

          <Card title="Filings" pad={false}
            action={<Segmented size="sm" value={filter} onChange={setFilter} options={[
              { value: 'om', label: 'Open market', count: counts.om },
              { value: 'buys', label: 'Buys' },
              { value: 'sells', label: 'Sales' },
              ...(hasCongress ? [{ value: 'congress', label: 'Congress', count: counts.congress }] : []),
              { value: 'all', label: 'Everything', count: counts.all },
            ]} />}>
            {filter === 'all' && <p className="sx-note">Includes grants, option exercises and tax withholding. Those aren't decisions to buy or sell, which is why they're hidden by default.</p>}
            <TradeTable trades={filtered.slice(0, shown)} />
            {!filtered.length && <Empty>No {filter === 'om' ? 'open-market ' : ''}filings in this window.</Empty>}
            {filtered.length > shown && (
              <div className="sx-more"><button className="sx-btn sx-btn--ghost" onClick={() => setShown(n => n + PAGE)}>Show {Math.min(PAGE, filtered.length - shown)} more</button></div>
            )}
            {!d.pro && d.older_count > 0 && (
              <Gate onUpgrade={onUpgrade}>{plural(d.older_count, 'older filing')} before the last 12 months. Pro shows the full history.</Gate>
            )}
          </Card>
        </div>

        <aside className="sx-grid__side">
          <Card title="Who's trading" sub={d.pro ? 'Last 3 years' : 'Last 12 months'} pad={false}>
            {d.insiders.length ? (
              <ul className="sx-people">
                {d.insiders.slice(0, 12).map(p => (
                  <li key={p.raw} className="sx-people__row">
                    <div className="sx-people__who">
                      <InsiderLink raw={p.raw} className="sx-people__name">{p.name}</InsiderLink>
                      <span className="sx-people__role">{p.congress ? 'Congress' : p.role !== 'Insider' ? p.role : (p.title || 'Insider')}</span>
                    </div>
                    <div className="sx-people__nums">
                      {/* Congress reports ranges, so summing them would invent a number: show counts. */}
                      {p.buys > 0 && <span className="sx-up">{p.congress ? plural(p.buys, 'buy') : `+${money(p.buy_v)}`}</span>}
                      {p.sells > 0 && <span className="sx-down">{p.congress ? plural(p.sells, 'sale') : `−${money(p.sell_v)}`}</span>}
                      {!p.buys && !p.sells && <span className="sx-muted">{plural(p.other, 'grant/exercise', 'grants/exercises')}</span>}
                      <span className="sx-people__when">{ago(p.last)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <Empty>No insider trades in this window.</Empty>}
          </Card>
          {renderProfile && <Card title="About" className="sx-card--about">{renderProfile(d.ticker, d.cik, d.company)}</Card>}
        </aside>
      </div>
    </div>
  );
}

export function TradeTable({ trades, showTicker = false, showInsider = true, showNow = false }) {
  if (!trades.length) return null;
  return (
    <div className="sx-table-wrap">
      <table className="sx-table">
        <thead>
          <tr>
            <th>Date</th>
            {showTicker && <th>Stock</th>}
            {showInsider && <th>Insider</th>}
            <th>Type</th>
            <th className="sx-r sx-hide-sm">Shares</th>
            <th className="sx-r sx-hide-sm">Price</th>
            <th className="sx-r">Value</th>
            {showNow ? <th className="sx-r">Since</th> : <th className="sx-r sx-hide-sm">Stake</th>}
            <th aria-label="SEC filing" />
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => {
            const url = secFilingUrl(t.acc, t.cik);
            const since = showNow && t.om && t.type === 'buy' && t.price > 0 && t.now ? (t.now - t.price) / t.price * 100 : null;
            return (
              <tr key={`${t.acc}:${i}`} className={t.om ? '' : 'sx-table__muted'}>
                <td className="sx-nowrap">{shortDate(t.date)}</td>
                {showTicker && <td>{t.ticker ? <StockLink ticker={t.ticker} /> : '—'}</td>}
                {showInsider && (
                  <td className="sx-table__who">
                    <InsiderLink raw={t.raw}>{t.name}</InsiderLink>
                    <span className="sx-table__role">{t.congress ? 'Congress' : t.role}</span>
                  </td>
                )}
                <td><TypeBadge type={t.type} om={t.om} />{!t.om && <span className="sx-table__code" title={codeLabel(t.code)}>{codeLabel(t.code)}</span>}{t.om && t.routine && <span className="sx-table__code" title="Filed under a pre-scheduled 10b5-1 trading plan">Planned</span>}</td>
                <td className="sx-r sx-mono sx-hide-sm">{t.congress ? '—' : shares(t.shares)}</td>
                <td className="sx-r sx-mono sx-hide-sm">{t.congress ? '—' : price(t.price)}</td>
                <td className={`sx-r sx-mono sx-strong${t.om ? (t.type === 'buy' ? ' sx-up' : ' sx-down') : ''}`}>{amount(t.value, t.congress)}</td>
                {showNow
                  ? <td className={`sx-r sx-mono ${since == null ? 'sx-muted' : since >= 0 ? 'sx-up' : 'sx-down'}`}>{since == null ? '—' : pct(since)}</td>
                  : <td className="sx-r sx-mono sx-hide-sm">{t.pct != null && t.type === 'buy' ? pct(t.pct) : '—'}</td>}
                <td className="sx-r">{url && <a href={url} target="_blank" rel="noreferrer" className="sx-sec" title="Open the SEC filing"><Icon name="external" size={12} /></a>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

