// src/pages/WatchlistPage.jsx — /watchlist
// One list: the stocks and people you watch, plus what you hold. Each row
// says in plain English what insiders did, and has its own alert bell.
import React, { useEffect } from 'react';
import { useApi } from '../lib/api.js';
import { StockLink, InsiderLink, Link } from '../lib/nav.jsx';
import { money, congressRange, ago, plural, prettyPerson } from '../lib/text.js';
import { Card, Chip, Empty, Skeleton, ErrorNote, Icon } from '../components/ui.jsx';
import WatchButton, { AlertBell } from '../components/WatchButton.jsx';
import { SearchBox } from '../components/Search.jsx';

export default function WatchlistPage({ watchlist, portfolioTickers = [], onUpgrade, alertsMasterOn }) {
  const h = (portfolioTickers || []).slice(0, 60).join(',');
  const { data: d, error, reload } = useApi(`/api/watchlist/summary${h ? `?h=${encodeURIComponent(h)}` : ''}`);
  const key = `${watchlist.tickers.join(',')}|${watchlist.insiders.join(',')}`;
  useEffect(() => { document.title = 'Watchlist · Seli'; }, []);
  useEffect(() => { if (d) reload(); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const used = watchlist.tickers.length + watchlist.insiders.length;
  const pro = watchlist.pro;
  // Rows follow the live watchlist immediately; details fill in when the summary lands.
  const byTicker = Object.fromEntries((d?.stocks || []).map(s => [s.ticker, s]));
  const byPerson = Object.fromEntries((d?.people || []).map(p => [p.raw, p]));

  return (
    <div className="sx-page sx-page--narrow">
      <header className="sx-head sx-head--page">
        <div className="sx-head__main">
          <h1 className="sx-head__title">Watchlist</h1>
          <p className="sx-head__desc">
            {pro ? `${plural(used, 'item')}. ` : `${used} of ${watchlist.freeLimit} free slots used. `}
            Everything here is in your {pro ? 'daily and weekly digests' : 'Sunday email'}.{pro && ' The bell sends a same-day email when a new filing lands.'}
          </p>
        </div>
      </header>

      <div className="sx-add">
        <SearchBox mode="pick" variant="inline" watchlist={watchlist} placeholder="Add a stock or person"
          onPick={it => {
            const on = it.kind === 'stock' ? watchlist.hasTicker(it.id) : watchlist.hasInsider(it.id);
            if (!on) (it.kind === 'stock' ? watchlist.toggleTicker(it.id) : watchlist.toggleInsider(it.id));
          }} />
      </div>

      {pro && alertsMasterOn === false && used > 0 && (
        <div className="sx-banner">
          <Icon name="bell-off" size={14} /> Same-day alerts are switched off for your account, so the bells below are paused.
          <Link to="/account#emails" className="sx-link">Turn them on</Link>
        </div>
      )}

      {error && !d && <ErrorNote message={error} onRetry={reload} />}

      {used === 0 && !(d?.holdings?.length) ? (
        <Card><Empty title="Nothing watched yet">Search above for a stock you own or a person you want to keep tabs on. Watch anything from its page too.</Empty></Card>
      ) : (
        <>
          {watchlist.tickers.length > 0 && (
            <Card title="Stocks" pad={false}>
              <ul className="sx-wl">
                {watchlist.tickers.map(t => {
                  const s = byTicker[t];
                  return (
                    <li key={t} className="sx-wl__row">
                      <div className="sx-wl__main">
                        <div className="sx-wl__head">
                          <StockLink ticker={t} />
                          <span className="sx-wl__name">{s?.company && s.company !== t ? s.company : ''}</span>
                          {s?.held && <Chip tone="accent">You hold this</Chip>}
                          {s?.recent_buys?.n > 0 && <Chip tone="buy">Buying · 30d</Chip>}
                          {s?.recent_sells?.n > 0 && !s?.recent_buys?.n && <Chip tone="sell">Selling · 30d</Chip>}
                        </div>
                        {s ? s.lines.slice(0, 2).map((l, i) => <p key={i} className={`sx-wl__line${i ? ' sx-muted' : ''}`}>{l}</p>) : <Skeleton lines={1} height={12} />}
                      </div>
                      <div className="sx-wl__ctl">
                        <AlertBell watchlist={watchlist} kind="stock" id={t} onUpgrade={onUpgrade} />
                        <button className="sx-x" title={`Stop watching ${t}`} aria-label={`Stop watching ${t}`} onClick={() => watchlist.toggleTicker(t)}><Icon name="x" size={14} /></button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {watchlist.insiders.length > 0 && (
            <Card title="People" pad={false}>
              <ul className="sx-wl">
                {watchlist.insiders.map(n => {
                  const p = byPerson[n];
                  return (
                    <li key={n} className="sx-wl__row">
                      <div className="sx-wl__main">
                        <div className="sx-wl__head">
                          <InsiderLink raw={n} className="sx-strong">{p?.name || prettyPerson(n)}</InsiderLink>
                          {p?.role && <span className="sx-wl__name">{p.role}</span>}
                        </div>
                        {!p ? <Skeleton lines={1} height={12} />
                          : p.recent.length ? p.recent.slice(0, 2).map((t, i) => (
                            <p key={i} className="sx-wl__line">{t.type === 'buy' ? 'Bought' : 'Sold'} <b className={t.type === 'buy' ? 'sx-up' : 'sx-down'}>{t.congress ? congressRange(t.value) : money(t.value)}</b> of <StockLink ticker={t.ticker} /> {ago(t.date)}.</p>
                          ))
                            : <p className="sx-wl__line sx-muted">{p.last ? <>No trades in 90 days. Last: {p.last.type === 'buy' ? 'bought' : 'sold'} {money(p.last.value)} of <StockLink ticker={p.last.ticker} /> {ago(p.last.date)}.</> : 'No open-market trades on record.'}</p>}
                      </div>
                      <div className="sx-wl__ctl">
                        <AlertBell watchlist={watchlist} kind="person" id={n} onUpgrade={onUpgrade} />
                        <button className="sx-x" title="Stop watching" aria-label="Stop watching" onClick={() => watchlist.toggleInsider(n)}><Icon name="x" size={14} /></button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {d?.holdings?.length > 0 && (
            <Card title="In your portfolio" sub="From your linked brokerage. Watch one to get it in alerts." pad={false}>
              <ul className="sx-wl">
                {d.holdings.map(s => (
                  <li key={s.ticker} className="sx-wl__row">
                    <div className="sx-wl__main">
                      <div className="sx-wl__head"><StockLink ticker={s.ticker} /><span className="sx-wl__name">{s.company !== s.ticker ? s.company : ''}</span></div>
                      {s.lines.slice(0, 1).map((l, i) => <p key={i} className="sx-wl__line">{l}</p>)}
                    </div>
                    <div className="sx-wl__ctl"><WatchButton watchlist={watchlist} kind="stock" id={s.ticker} compact /></div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {!pro && used >= watchlist.freeLimit && (
        <div className="sx-gate sx-gate--block">
          <span className="sx-gate__text">That's all {watchlist.freeLimit} free slots. Pro watches as many stocks and people as you like, emails you the same day they file, and links your brokerage.</span>
          <button className="sx-btn sx-btn--accent sx-btn--sm" onClick={() => onUpgrade('watchlist_ticker')}>See Pro</button>
        </div>
      )}
      {pro && !portfolioTickers.length && (
        <p className="sx-note sx-note--center">Link your brokerage in <Link to="/account#portfolio" className="sx-link">Account</Link> and your holdings show up here automatically.</p>
      )}
    </div>
  );
}
