// src/pages/HomeFeed.jsx — /
// Your stuff first, then the week's most notable insider buying told the
// way the Sunday email tells it, then the rest. Every tile answers
// "what did insiders do".
import React, { useEffect, useState } from 'react';
import { useApi } from '../lib/api.js';
import { StockLink, InsiderLink, Link, stockPath } from '../lib/nav.jsx';
import { money, congressRange, ago, plural } from '../lib/text.js';
import { Card, Chip, Skeleton, ErrorNote, Icon, Freshness, RoleTag } from '../components/ui.jsx';
import WatchButton from '../components/WatchButton.jsx';
import { SearchBox } from '../components/Search.jsx';

const STARTERS = ['NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'JPM'];

export default function HomeFeed({ watchlist, portfolioTickers = [], user }) {
  const h = (portfolioTickers || []).slice(0, 60).join(',');
  const { data: d, error, reload } = useApi(`/api/feed${h ? `?h=${encodeURIComponent(h)}` : ''}`);
  useEffect(() => { document.title = 'Home · Seli'; }, []);
  const watchKey = `${watchlist.tickers.join(',')}|${watchlist.insiders.join(',')}`;
  // Re-pull "yours" when the watchlist changes (e.g. after a Watch click).
  useEffect(() => { if (d) reload(); }, [watchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const hour = new Date().getHours();
  const hello = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}${user?.firstName ? `, ${user.firstName}` : ''}`;

  return (
    <div className="sx-page sx-page--feed">
      <header className="sx-head sx-head--page">
        <div className="sx-head__main">
          <h1 className="sx-head__title">{hello}</h1>
          <p className="sx-head__desc">What company insiders and members of Congress did with their own money.</p>
          <Freshness />
        </div>
      </header>

      {error && !d && <ErrorNote message={error} onRetry={reload} />}
      {!d && !error && <><Card><Skeleton lines={4} /></Card><Card><Skeleton lines={6} /></Card></>}
      {d && (
        <>
          <Yours d={d} watchlist={watchlist} />
          <MarketSections d={d} watchlist={watchlist} signedIn onHome />
        </>
      )}
    </div>
  );
}

// The market-wide part of Home: this week's buying, Congress, big sales.
// Also used by the public /insider-buying page.
// signedIn: links into the Data page (signed-in only) are shown.
// onHome: links out to the full buying page (which is this same list, so it's
// left off there) and the leaderboard teaser.
export function MarketSections({ d, watchlist, signedIn = false, onHome = false }) {
  const seeAll = (to, label) => <Link to={to} className="sx-link">{label} <Icon name="arrow" size={12} /></Link>;
  return (
    <>
    {d.pulse && <Pulse p={d.pulse} signedIn={signedIn} />}
    {d.featured && <Featured c={d.featured} watchlist={watchlist} />}
    {onHome && d.leader && <Leader l={d.leader} />}
    <div className="sx-feed-cols">
      {d.more?.length > 0 && (
        <Card title="More insider buying this week" pad={false} action={onHome ? seeAll('/insider-buying', 'All buying') : null}>
          <ul className="sx-rows">{d.more.map(c => <ClusterRow key={c.ticker} c={c} />)}</ul>
        </Card>
      )}
      <div className="sx-feed-stack">
        {d.congress?.length > 0 && (
          <Card title="From Congress" sub="Disclosed as ranges, often weeks after the trade" pad={false} action={seeAll('/congress', 'All Congress trades')}>
            <ul className="sx-rows">
              {d.congress.map(c => (
                <li key={c.ticker} className="sx-row">
                  <StockLink ticker={c.ticker} />
                  <div className="sx-row__main">
                    <div className="sx-row__title"><InsiderLink raw={c.buyers[0].raw}>{c.buyers[0].name}</InsiderLink> bought {congressRange(c.buyers[0].value)}</div>
                    <div className="sx-row__sub"><RoleTag role={c.buyers[0].role} congress /> {c.company}{c.n_insiders > 1 ? ` · ${plural(c.n_insiders - 1, 'other member')}` : ''}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {d.sells?.length > 0 && (
          <Card title="Largest insider sales this week" pad={false} action={signedIn ? seeAll('/data?tab=trades&side=sell&sort=value', 'All sales') : null}>
            <ul className="sx-rows">
              {d.sells.map(r => (
                <li key={`${r.ticker}:${r.raw}`} className="sx-row">
                  <StockLink ticker={r.ticker} />
                  <div className="sx-row__main">
                    <div className="sx-row__title"><InsiderLink raw={r.raw}>{r.name}</InsiderLink> <RoleTag role={r.role} /></div>
                    <div className="sx-row__sub">{r.company}{r.planned ? ' · pre-scheduled plan' : ''}</div>
                  </div>
                  <span className="sx-row__amt sx-down">{money(r.value)}</span>
                </li>
              ))}
            </ul>
            <p className="sx-note">Insiders sell for lots of reasons: taxes, diversification, scheduled plans. Sales are shown for context, not as a signal.</p>
          </Card>
        )}
      </div>
    </div>
    </>
  );
}

const YOURS_PREVIEW = 8;

function Yours({ d, watchlist }) {
  const [expanded, setExpanded] = useState(false);
  // The feed is a snapshot from the server. Once this browser has the saved
  // watchlist, only show what's on it (plus holdings), so a stock removed a
  // moment ago doesn't linger here while it's already gone from Watchlist.
  const raw = d.yours;
  const days = raw.days || 30;
  const y = watchlist.ready ? (() => {
    const t = new Set(watchlist.tickers.map(x => String(x).toUpperCase()));
    const p = new Set(watchlist.insiders);
    return {
      ...raw,
      stocks: raw.stocks.filter(s => s.held || t.has(s.ticker)),
      people: raw.people.filter(x => p.has(x.raw)),
      watching: watchlist.tickers.length + watchlist.insiders.length,
    };
  })() : raw;
  if (!y.watching && !y.holdings) {
    return (
      <Card title="Start with what you own" className="sx-yours sx-yours--empty">
        <p className="sx-lead">Watch a few stocks or people. Their insider activity shows up here first, and in your {watchlist.pro ? 'digests' : 'Sunday email'}.</p>
        <div className="sx-yours__search"><SearchBox mode="pick" variant="inline" watchlist={watchlist} placeholder="Add a stock or person you follow"
          onPick={it => (it.kind === 'stock' ? watchlist.toggleTicker(it.id) : watchlist.toggleInsider(it.id))} /></div>
        <div className="sx-starters">
          <span className="sx-muted">Popular:</span>
          {STARTERS.map(t => <button key={t} className="sx-starter" onClick={() => watchlist.toggleTicker(t)}><Icon name="plus" size={12} />{t}</button>)}
        </div>
      </Card>
    );
  }
  const activeAll = y.stocks.filter(s => s.active);
  const quietAll = y.stocks.filter(s => !s.active);
  const activePeopleAll = y.people.filter(p => p.recent.length);
  const quietPeopleAll = y.people.filter(p => !p.recent.length);
  // Long lists open collapsed: anything with new activity comes first, then
  // quiet ones, up to YOURS_PREVIEW rows. "Show all" opens the rest in place.
  const total = y.stocks.length + y.people.length;
  let budget = expanded ? Infinity : YOURS_PREVIEW;
  const take = arr => { const out = arr.slice(0, Math.max(0, budget)); budget -= out.length; return out; };
  const active = take(activeAll);
  const activePeople = take(activePeopleAll);
  const quiet = take(quietAll);
  const quietPeople = take(quietPeopleAll);
  const hidden = total - (active.length + activePeople.length + quiet.length + quietPeople.length);
  const movedHidden = activeAll.length + activePeopleAll.length - active.length - activePeople.length;
  const Stock = ({ s }) => {
    const b = s.recent_buys || {}, sl = s.recent_sells || {};
    return (
      <li className="sx-row sx-row--yours">
        <StockLink ticker={s.ticker} />
        <div className="sx-row__main">
          <div className="sx-row__title">{s.company}{s.held && <Chip tone="accent">You hold this</Chip>}</div>
          {s.lines.slice(0, 2).map((l, i) => <div key={i} className="sx-row__sub">{l}</div>)}
        </div>
        <div className="sx-row__end">
          {b.n > 0 && <span className="sx-row__amt sx-up">+{money(b.v)}</span>}
          {sl.n > 0 && <span className="sx-row__amt sx-down">−{money(sl.v)}</span>}
          {!b.n && !sl.n && <span className="sx-row__quiet">Quiet</span>}
          {(b.n > 0 || sl.n > 0) && <span className="sx-row__meta">{[b.n && plural(b.n, 'buy'), sl.n && plural(sl.n, 'sale')].filter(Boolean).join(' · ')}</span>}
        </div>
      </li>
    );
  };
  const Person = ({ p }) => {
    const t = p.recent[0] || p.last;
    const initials = (p.name || '').split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    return (
      <li className="sx-row sx-row--yours">
        <span className="sx-avatar-sm" aria-hidden="true">{initials}</span>
        <div className="sx-row__main">
          <div className="sx-row__title"><InsiderLink raw={p.raw}>{p.name}</InsiderLink>{p.role && <RoleTag role={p.role} className="sx-row__role" />}</div>
          {p.recent.length > 0
            ? p.recent.slice(0, 3).map((r, i) => (
              <div key={i} className="sx-row__sub">
                {r.type === 'buy' ? 'Bought' : 'Sold'} {r.congress ? congressRange(r.value) : money(r.value)} of <StockLink ticker={r.ticker} plain /> {ago(r.date)}
              </div>))
            : <div className="sx-row__sub">{t ? <>Last trade: {t.type === 'buy' ? 'bought' : 'sold'} {money(t.value)} of <StockLink ticker={t.ticker} plain /> {ago(t.date)}</> : 'No open-market trades on record'}</div>}
        </div>
        <div className="sx-row__end">
          {p.recent.length > 0 && t
            ? <span className={`sx-row__amt ${t.type === 'buy' ? 'sx-up' : 'sx-down'}`}>{t.type === 'buy' ? '+' : '−'}{t.congress ? congressRange(t.value) : money(t.value)}</span>
            : <span className="sx-row__quiet">Quiet</span>}
        </div>
      </li>
    );
  };
  return (
    <Card title="Your stocks and people" sub={active.length || activePeople.length ? `Newest activity first · last ${days} days` : `Nothing new in the last ${days} days`} pad={false}
      action={<Link to="/watchlist" className="sx-link">Watchlist <Icon name="arrow" size={12} /></Link>}>
      <ul className="sx-rows">
        {/* New activity first (stocks, then people), then the quiet ones. */}
        {active.map(s => <Stock key={s.ticker} s={s} />)}
        {activePeople.map(p => <Person key={p.raw} p={p} />)}
        {quiet.map(s => <Stock key={s.ticker} s={s} />)}
        {quietPeople.map(p => <Person key={p.raw} p={p} />)}
      </ul>
      <div className="sx-card__links">
        <Link to="/data?mine=1" className="sx-link">See their trades <Icon name="arrow" size={12} /></Link>
      </div>
      {(hidden > 0 || (expanded && total > YOURS_PREVIEW)) && (
        <button className="sx-more" onClick={() => setExpanded(e => !e)} aria-expanded={expanded}>
          {expanded ? 'Show less'
            : `Show all ${total}${movedHidden > 0 ? ` (${movedHidden} more with new trades)` : ''}`}
          <Icon name="chevron" size={12} className={expanded ? 'sx-more__up' : ''} />
        </button>
      )}
    </Card>
  );
}

// Every open-market buy and sale filed in the last 7 days, all stocks.
// The Data page's Signals tab only totals the stocks it groups, so the
// labels here say exactly what's counted.
function Pulse({ p, signedIn }) {
  return (
    <div className="sx-pulse">
      <div className="sx-pulse__stat"><span className="sx-pulse__label">Bought, last 7 days</span><span className="sx-pulse__val sx-up">{money(p.buy_v)}</span><span className="sx-muted">{plural(p.buy_n, 'filing')}</span></div>
      <div className="sx-pulse__stat"><span className="sx-pulse__label">Sold, last 7 days</span><span className="sx-pulse__val sx-down">{money(p.sell_v)}</span><span className="sx-muted">{plural(p.sell_n, 'filing')}</span></div>
      <div className="sx-pulse__text">
        {p.line && <p className="sx-pulse__line">{p.line}</p>}
        <p className="sx-pulse__scope">Every open-market insider and Congress trade filed in the last 7 days.{signedIn && <> <Link to="/data?tab=trades" className="sx-link">See every trade <Icon name="arrow" size={12} /></Link></>}</p>
      </div>
    </div>
  );
}

// One line pointing at the leaderboard: whose buys have done best lately.
function Leader({ l }) {
  const pts = Math.round(l.excess);
  if (!(pts > 0)) return null; // only worth a line when someone actually beat the market
  return (
    <div className="sx-leader">
      <span className="sx-leader__label">Top insider, last 12 months</span>
      <span className="sx-leader__who">
        <InsiderLink raw={l.raw} className="sx-strong">{l.name}</InsiderLink> <RoleTag role={l.role} congress={l.congress} />
        {l.tickers?.[0] && <> <StockLink ticker={l.tickers[0]} plain /></>}
      </span>
      <span className="sx-leader__stat">Their buys beat the S&amp;P 500 by <b className="sx-up">{pts} points</b> on average, across {plural(l.scored, 'scored buy')}.</span>
      <Link to="/leaderboard" className="sx-link sx-leader__link">Leaderboard <Icon name="arrow" size={12} /></Link>
    </div>
  );
}

function Featured({ c, watchlist }) {
  return (
    <Card className="sx-featured" title="Featured filing this week" sub={`${c.why ? `${c.why}. ` : "The week's most notable insider buying. "}A summary of what was filed, not a recommendation.`}>
      <div className="sx-featured__head">
        <StockLink ticker={c.ticker} className="sx-tk--lg" />
        <span className="sx-featured__co">{c.company}</span>
        <span className="sx-featured__total sx-up">{money(c.total)}</span>
        <WatchButton watchlist={watchlist} kind="stock" id={c.ticker} compact />
      </div>
      <p className="sx-featured__lead">{c.lead}</p>
      {c.facts.length > 0 && <div className="sx-chips">{c.facts.map(f => <Chip key={f.label} tone={f.tone}>{f.label}</Chip>)}</div>}
      {/* One buyer: the summary above already says who and how much. */}
      {(c.buyers.length > 1 || c.more_buyers > 0) && (
        <ul className="sx-buyers">
          {c.buyers.map(b => (
            <li key={b.raw}>
              <span><InsiderLink raw={b.raw} className="sx-strong">{b.name}</InsiderLink> <RoleTag role={b.role} /></span>
              <span>{b.stake && <Chip>{b.stake}</Chip>}<b className="sx-mono sx-up">{money(b.value)}</b></span>
            </li>
          ))}
          {c.more_buyers > 0 && <li className="sx-muted">+ {plural(c.more_buyers, 'more insider')}</li>}
        </ul>
      )}
      <div className="sx-featured__foot">
        <div className="sx-featured__links">
          <Link to={stockPath(c.ticker)} className="sx-link">Every {c.ticker} insider trade <Icon name="arrow" size={12} /></Link>
          {c.buyers.length === 1 && !c.more_buyers && (
            <InsiderLink raw={c.buyers[0].raw} className="sx-link">More from {c.buyers[0].name} <Icon name="arrow" size={12} /></InsiderLink>
          )}
        </div>
        {c.context && <p className="sx-note">{c.context}</p>}
      </div>
    </Card>
  );
}

function ClusterRow({ c }) {
  const top = c.buyers[0];
  const facts = c.facts.slice(0, 2).map(f => f.label);
  return (
    <li className="sx-row sx-row--cluster">
      <StockLink ticker={c.ticker} />
      <div className="sx-row__main">
        <div className="sx-row__title">{c.company}</div>
        <div className="sx-row__sub">
          {facts.length ? facts.join(' · ') : <><InsiderLink raw={top.raw}>{top.name}</InsiderLink> <RoleTag role={top.role} /></>}
        </div>
      </div>
      <span className="sx-row__amt sx-up">{money(c.total)}</span>
    </li>
  );
}

