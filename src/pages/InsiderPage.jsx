// src/pages/InsiderPage.jsx — /insider/:name
// One person: where they sit, how their past buys worked out (with the
// sample size next to every number), what they hold, and every trade.
import React, { useEffect, useMemo, useState } from 'react';
import { useApi } from '../lib/api.js';
import { StockLink, pushRecent } from '../lib/nav.jsx';
import { money, amount, price, shares, pct, shortDate, ago, plural, prettyPerson } from '../lib/text.js';
import { Card, Chip, Segmented, Empty, Skeleton, ErrorNote, Gate, Stat } from '../components/ui.jsx';
import WatchButton from '../components/WatchButton.jsx';
import { TradeTable } from './StockPage.jsx';

const PAGE = 30;

export default function InsiderPage({ raw, watchlist, onUpgrade }) {
  const { data, error, reload } = useApi(`/api/insider/${encodeURIComponent(raw)}`);
  const d = data && data.raw === raw ? data : null;

  useEffect(() => {
    document.title = `${d?.name || prettyPerson(raw)} · insider trades · Seli`;
    if (d?.known) pushRecent({ kind: 'person', id: raw, label: d.name, sub: [d.role, d.companies[0]?.ticker].filter(Boolean).join(' · ') });
  }, [raw, d?.name, d?.known]);

  if (error && !d) return <div className="sx-page"><ErrorNote message={error} onRetry={reload} /></div>;
  if (!d) return <div className="sx-page"><header className="sx-head"><div className="sx-head__main"><h1 className="sx-head__person">{prettyPerson(raw)}</h1></div></header><Card><Skeleton lines={5} /></Card></div>;
  if (!d.known) {
    return (
      <div className="sx-page">
        <header className="sx-head"><div className="sx-head__main"><h1 className="sx-head__person">{prettyPerson(raw)}</h1></div></header>
        <Card><Empty title="No trades on record for this name">Names come from the filings exactly as reported. Try searching a different spelling.</Empty></Card>
      </div>
    );
  }
  return <InsiderView d={d} watchlist={watchlist} onUpgrade={onUpgrade} />;
}

function TrackRecord({ r, congress }) {
  if (congress) {
    return <p className="sx-muted">Congressional disclosures report a dollar range and often land weeks after the trade, so Seli doesn't score a track record for members of Congress.</p>;
  }
  if (!r || r.buys_scored < 3) {
    return <p className="sx-muted">Not enough open-market buys with price data to judge a track record{r?.buys_scored ? ` (${plural(r.buys_scored, 'buy')} so far)` : ''}. Seli needs at least 3.</p>;
  }
  const vs = r.vs_spy;
  return (
    <>
      <div className="sx-stats">
        <Stat label="Hit rate" value={r.hit_rate != null ? `${r.hit_rate}%` : '—'}
          sub={`up 5%+ after ${r.wins} of ${plural(r.priced, 'buy')}`}
          tone={r.hit_rate >= 60 ? 'buy' : r.hit_rate < 45 ? 'sell' : undefined} />
        <Stat label="Avg since buy" value={pct(r.avg_return, 1)} sub={`across ${plural(r.buys_scored, 'buy')}`} tone={r.avg_return >= 0 ? 'buy' : 'sell'} />
        {vs && <Stat label="Same periods, S&P 500" value={pct(vs.avg_spy, 1)} sub={`beat it after ${vs.beat} of ${plural(vs.n, 'buy')}`} />}
      </div>
      <p className="sx-note sx-note--flush">
        Measured from each open-market buy price to the latest close. Buys within 5% either way count as flat and are left out of the hit rate.
        {vs && vs.n < r.buys_scored ? ` S&P comparison covers the ${vs.n} buys with benchmark data.` : ''} Past trades don't predict future ones.
      </p>
    </>
  );
}

function InsiderView({ d, watchlist, onUpgrade }) {
  const primary = d.companies[0];
  const [filter, setFilter] = useState('om');
  const [shown, setShown] = useState(PAGE);
  useEffect(() => { setShown(PAGE); }, [filter, d.raw]);
  const filtered = useMemo(() => d.trades.filter(t => filter === 'all' ? true : filter === 'buys' ? t.om && t.type === 'buy' : filter === 'sells' ? t.om && t.type === 'sell' : t.om), [d.trades, filter]);
  const multi = d.companies.length > 1;

  return (
    <div className="sx-page">
      <header className="sx-head">
        <div className="sx-head__main">
          <div className="sx-head__row">
            <h1 className="sx-head__person">{d.name}</h1>
            {d.congress && <Chip tone="accent">Congress</Chip>}
          </div>
          <div className="sx-head__sub">
            {primary && <span>{d.congress ? (primary.title || 'Member of Congress') : (primary.title || primary.role)}{!d.congress && <> at <StockLink plain ticker={primary.ticker}>{primary.company}</StockLink></>}</span>}
            {d.first_trade && <span className="sx-muted">Trades on record {shortDate(d.first_trade, { year: true })} to {shortDate(d.last_trade, { year: true })}</span>}
          </div>
        </div>
        <div className="sx-head__actions">
          <WatchButton watchlist={watchlist} kind="person" id={d.raw} />
        </div>
      </header>

      <div className="sx-grid">
        <div className="sx-grid__main">
          <Card title="Track record" sub="How this person's open-market buys have done since">
            <TrackRecord r={d.record} congress={d.congress} />
          </Card>

          <Card title="Trades" pad={false}
            action={<Segmented size="sm" value={filter} onChange={setFilter} options={[
              { value: 'om', label: 'Open market' }, { value: 'buys', label: 'Buys' }, { value: 'sells', label: 'Sales' }, { value: 'all', label: 'Everything' },
            ]} />}>
            <TradeTable trades={filtered.slice(0, shown)} showTicker={multi} showInsider={false} showNow />
            {!filtered.length && <Empty>No {filter === 'all' ? '' : 'open-market '}trades {d.pro ? 'on record' : 'in the last 12 months'}.</Empty>}
            {filtered.length > shown && <div className="sx-more"><button className="sx-btn sx-btn--ghost" onClick={() => setShown(n => n + PAGE)}>Show more</button></div>}
            {!d.pro && d.older_count > 0 && (
              <Gate onUpgrade={onUpgrade}>{plural(d.older_count, 'older trade')} before the last 12 months. The track record above already counts them; Pro lists them.</Gate>
            )}
          </Card>
        </div>

        <aside className="sx-grid__side">
          <Card title={multi ? 'Companies' : 'Position'} pad={false}>
            <ul className="sx-cos">
              {d.companies.map(c => (
                <li key={c.ticker} className="sx-cos__row">
                  <div className="sx-cos__top">
                    <StockLink ticker={c.ticker} />
                    <span className="sx-cos__name">{c.company}</span>
                  </div>
                  <div className="sx-cos__role">{d.congress ? 'Traded' : (c.title || c.role)} · last trade {ago(c.last)}</div>
                  <div className="sx-cos__nums">
                    {c.buys > 0 && <span>Bought <b className="sx-up">{amount(c.buy_v, d.congress)}</b> ({c.buys})</span>}
                    {c.sells > 0 && <span>Sold <b className="sx-down">{amount(c.sell_v, d.congress)}</b> ({c.sells})</span>}
                    {!c.buys && !c.sells && <span className="sx-muted">Grants and exercises only</span>}
                  </div>
                  {!d.congress && c.owned != null && c.owned > 0 && (
                    <div className="sx-cos__hold">
                      Holds {shares(c.owned)} shares{c.est_value ? <> · about <b>{money(c.est_value)}</b></> : ''}
                      {c.avg_buy && c.since_avg_buy != null && <span className={c.since_avg_buy >= 0 ? 'sx-up' : 'sx-down'}> · avg buy {price(c.avg_buy)} ({pct(c.since_avg_buy)})</span>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {!d.congress && <p className="sx-note">Holdings are what the most recent filing reported after that trade.</p>}
          </Card>
        </aside>
      </div>
    </div>
  );
}
