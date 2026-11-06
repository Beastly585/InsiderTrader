// src/pages/WatchlistPage.jsx — /watchlist
// One list: the stocks and people you follow, plus what you hold. Each row
// says in plain English what insiders did, with two labeled controls: the
// same-day email switch (Pro) and Following / Unfollow. Unfollowing keeps the
// row on the page, faded, with "Follow again", until you leave.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../lib/api.js';
import { StockLink, InsiderLink, Link } from '../lib/nav.jsx';
import { money, congressRange, ago, plural, prettyPerson } from '../lib/text.js';
import { Card, Chip, Empty, Skeleton, ErrorNote, Icon, RoleTag } from '../components/ui.jsx';
import WatchButton from '../components/WatchButton.jsx';
import { SearchBox } from '../components/Search.jsx';

export default function WatchlistPage({ watchlist, portfolioTickers = [], onUpgrade, alertsMasterOn }) {
  const h = (portfolioTickers || []).slice(0, 60).join(',');
  const { data: d, error, loading, reload } = useApi(`/api/watchlist/summary${h ? `?h=${encodeURIComponent(h)}` : ''}`);
  useEffect(() => { document.title = 'Watchlist · Seli'; }, []);

  const used = watchlist.tickers.length + watchlist.insiders.length;
  // Unfollowed this visit: kept on screen so a slip is one click to undo.
  const [gone, setGone] = useState([]); // [{ kind, id }]
  const isGone = (kind, id) => gone.some(g => g.kind === kind && g.id === id);
  const following = (kind, id) => (kind === 'stock' ? watchlist.hasTicker(id) : watchlist.hasInsider(id));
  const toggleFollow = (kind, id) => {
    const on = following(kind, id);
    kind === 'stock' ? watchlist.toggleTicker(id) : watchlist.toggleInsider(id);
    if (on && !isGone(kind, id)) setGone(g => [...g, { kind, id }]);
  };
  // Rows keep their place: anything new is added at the end, and an
  // unfollowed row stays where it was (faded) instead of jumping.
  const seen = useRef({ stock: [], person: [] });
  for (const t of watchlist.tickers) if (!seen.current.stock.includes(t)) seen.current.stock.push(t);
  for (const n of watchlist.insiders) if (!seen.current.person.includes(n)) seen.current.person.push(n);
  const tickers = seen.current.stock.filter(t => watchlist.hasTicker(t) || isGone('stock', t));
  const insiders = seen.current.person.filter(n => watchlist.hasInsider(n) || isGone('person', n));
  const Controls = ({ kind, id, label }) => {
    const on = following(kind, id);
    const type = kind === 'stock' ? 'ticker' : 'insider';
    const mail = on && pro && watchlist.alertsOn(type, id);
    return (
      <div className="sx-wl__ctl">
        {on && pro && (
          <button type="button" role="switch" aria-checked={mail} className={`sx-mail${mail ? ' sx-mail--on' : ''}`}
            title={mail ? 'Same-day email is on. Click to turn it off (it stays in your digest).' : 'Off: digest only. Click for a same-day email when they file.'}
            onClick={() => watchlist.setAlerts(type, id, !mail)}>
            <Icon name={mail ? 'bell' : 'bell-off'} size={13} /><span>Email</span><span className="sx-mail__knob" aria-hidden="true" />
          </button>
        )}
        <button type="button" className={`sx-follow2${on ? ' sx-follow2--on' : ''}`} aria-pressed={on}
          aria-label={on ? `Unfollow ${label}` : `Follow ${label} again`} onClick={() => toggleFollow(kind, id)}>
          <Icon name={on ? 'eye-on' : 'eye'} size={14} />
          <span className="sx-follow2__on">{on ? 'Following' : 'Follow again'}</span>
          {on && <span className="sx-follow2__off">Unfollow</span>}
        </button>
      </div>
    );
  };
  const days = d?.days || 30; // same window as Home
  const pro = watchlist.pro;
  // Rows follow the live watchlist immediately; details fill in when the summary lands.
  const byTicker = Object.fromEntries((d?.stocks || []).map(s => [s.ticker, s]));
  const byPerson = Object.fromEntries((d?.people || []).map(p => [p.raw, p]));
  // Removing an item just drops its row. Only refetch when something was added
  // that the last summary doesn't cover, and only once the add is saved (the
  // summary reads the saved list), so a long Pro list isn't re-queried on
  // every click and a fast add doesn't leave a row stuck loading.
  const missing = d ? [...watchlist.tickers.filter(t => !byTicker[t]), ...watchlist.insiders.filter(n => !byPerson[n])].join('|') : '';
  useEffect(() => { if (missing) reload(); }, [missing, watchlist.synced]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the last summary was asked about. A row it covered but has nothing
  // for gets a plain line instead of a placeholder that pulses forever; a
  // row added since keeps its placeholder until the refetch lands.
  // Snapshot taken when a new summary arrives (useMemo, so it's ready in the
  // same render; a ref set in an effect would leave rows pulsing a beat late).
  const covered = useMemo(() => new Set([...watchlist.tickers, ...watchlist.insiders]), [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = id => !error && (loading || !d || !covered.has(id));
  const noDetail = <p className="sx-wl__line sx-muted">{error ? "Couldn't load the latest. Try again above." : 'No insider filings on record yet.'}</p>;

  return (
    <div className="sx-page">
      <header className="sx-head sx-head--page">
        <div className="sx-head__main">
          <h1 className="sx-head__title">Watchlist</h1>
          <p className="sx-head__desc">
            {pro ? `Following ${plural(used, 'stock or person', 'stocks and people')}. `
              : used > watchlist.freeLimit ? `Following ${used}. Free accounts can add up to ${watchlist.freeLimit}. `
                : `${used} of ${watchlist.freeLimit} free slots used. `}
            Everything you follow is on your Home page and in your {pro ? 'daily and weekly digests' : 'Sunday email'}.
            {pro && ' Turn on Email for a same-day email when a new filing lands.'}
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
          <Icon name="bell-off" size={14} /> Same-day emails are switched off for your account, so the Email switches below are paused.
          <Link to="/account#emails" className="sx-link">Turn them on</Link>
        </div>
      )}

      {error && !d && <ErrorNote message={error} onRetry={reload} />}

      {!pro && used > 0 && (
        <p className="sx-wl__pronote"><Icon name="bell" size={13} /> Want an email the same day they file? <button type="button" className="sx-link" onClick={() => onUpgrade('notifications')}>Same-day emails are on Pro</button></p>
      )}

      {used === 0 && !gone.length && !(d?.holdings?.length) ? (
        <Card><Empty title="Not following anything yet">Search above for a stock you own or a person you want to keep tabs on. Follow anything from its page too.</Empty></Card>
      ) : (
        <>
          {tickers.length > 0 && (
            <Card title="Stocks" pad={false}>
              <ul className="sx-wl">
                {tickers.map(t => {
                  const s = byTicker[t];
                  return (
                    <li key={t} className={`sx-wl__row${following('stock', t) ? '' : ' sx-wl__row--gone'}`}>
                      <div className="sx-wl__main">
                        <div className="sx-wl__head">
                          <StockLink ticker={t} />
                          <span className="sx-wl__name">{s?.company && s.company !== t ? s.company : ''}</span>
                          {s?.held && <Chip tone="accent">You hold this</Chip>}
                          {s?.recent_buys?.n > 0 && <Chip tone="buy">Buying · {days}d</Chip>}
                          {s?.reversal && <Chip tone="rev" title="Someone at the company bought after 2+ sales and no buys of this stock in the previous 2 years">Reversal</Chip>}
                          {s?.recent_sells?.n > 0 && !s?.recent_buys?.n && <Chip tone="sell">Selling · {days}d</Chip>}
                        </div>
                        {s ? s.lines.slice(0, 2).map((l, i) => <p key={i} className={`sx-wl__line${i ? ' sx-muted' : ''}`}>{l}</p>) : pending(t) ? <Skeleton lines={1} height={12} /> : noDetail}
                      </div>
                      <Controls kind="stock" id={t} label={t} />
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {insiders.length > 0 && (
            <Card title="People" pad={false}>
              <ul className="sx-wl">
                {insiders.map(n => {
                  const p = byPerson[n];
                  return (
                    <li key={n} className={`sx-wl__row${following('person', n) ? '' : ' sx-wl__row--gone'}`}>
                      <div className="sx-wl__main">
                        <div className="sx-wl__head">
                          <InsiderLink raw={n} className="sx-strong">{p?.name || prettyPerson(n)}</InsiderLink>
                          {p?.role && <RoleTag role={p.role} name={n} />}
                        </div>
                        {!p ? (pending(n) ? <Skeleton lines={1} height={12} /> : noDetail)
                          : p.recent.length ? p.recent.slice(0, 2).map((t, i) => (
                            <p key={i} className="sx-wl__line">{t.type === 'buy' ? 'Bought' : 'Sold'} <b className={t.type === 'buy' ? 'sx-up' : 'sx-down'}>{t.congress ? congressRange(t.value) : money(t.value)}</b> of <StockLink ticker={t.ticker} /> {ago(t.date)}.</p>
                          ))
                            : <p className="sx-wl__line sx-muted">{p.last ? <>No trades in {days} days. Last: {p.last.type === 'buy' ? 'bought' : 'sold'} {money(p.last.value)} of <StockLink ticker={p.last.ticker} /> {ago(p.last.date)}.</> : 'No open-market trades on record.'}</p>}
                      </div>
                      <Controls kind="person" id={n} label={p?.name || prettyPerson(n)} />
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
