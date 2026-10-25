// src/pages/HomeFeed.jsx — /
// One timeframe, the last 7 days, in two parts:
//   1. Your stocks and people. Anything with filings this week gets a full
//      row (anything filed since your last visit is tagged New); the
//      quiet ones share one line.
//   2. This week across the market: the week's totals, the featured filing,
//      more buying, Congress, the largest sales, and the leaderboard's top name.
import React, { useEffect, useMemo, useState } from 'react';
import { useApi } from '../lib/api.js';
import { StockLink, InsiderLink, Link, stockPath } from '../lib/nav.jsx';
import { money, congressRange, ago, plural } from '../lib/text.js';
import { Card, Chip, Skeleton, ErrorNote, Icon, Freshness, RoleTag } from '../components/ui.jsx';
import WatchButton from '../components/WatchButton.jsx';
import { visitSince, etDate } from '../lib/visit.js';

const HOME_DAYS = 7; // matches "This week across the market"
const range = ([lo, hi]) => `${money(lo)}–${money(hi).replace('$', '')}`;
import { SearchBox } from '../components/Search.jsx';

const STARTERS = ['NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'JPM'];

export default function HomeFeed({ watchlist, portfolioTickers = [], user }) {
  const h = (portfolioTickers || []).slice(0, 60).join(',');
  // Fixed for this page load: when your last visit ended (null until we know who you are).
  const since = useMemo(() => visitSince(user?.id), [user?.id]);
  const { data: d, error, reload } = useApi(user?.id ? `/api/feed?days=${HOME_DAYS}${h ? `&h=${encodeURIComponent(h)}` : ''}` : null);
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
          <Yours d={d} watchlist={watchlist} since={since} />
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
    {onHome && (
      <div className="sx-week">
        <div className="sx-section-head">
          <h2 className="sx-section-head__title">This week across the market</h2>
          <span className="sx-section-head__sub">Filed in the last 7 days</span>
        </div>
        {/* The week's totals, as a one-line summary before the details. */}
        {d.pulse && (
          <p className="sx-week__stats">
            Insiders and Congress bought <b className="sx-up">{money(d.pulse.buy_v)}</b> ({plural(d.pulse.buy_n, 'filing')}) and sold <b className="sx-down">{money(d.pulse.sell_v)}</b> ({plural(d.pulse.sell_n, 'filing')}).
            {d.pulse.line && <> {shortPulse(d.pulse.line)}.</>}
            {signedIn && <> <Link to="/data?tab=trades" className="sx-link">See every trade <Icon name="arrow" size={12} /></Link></>}
          </p>
        )}
      </div>
    )}
    {/* The public buying page leads with the totals; Home keeps them for the end. */}
    {!onHome && d.pulse && <Pulse p={d.pulse} signedIn={signedIn} />}
    {d.featured && <Featured c={d.featured} watchlist={watchlist} />}
    <div className="sx-feed-cols">
      {d.more?.length > 0 && (
        <Card title="More insider buying" pad={false} action={onHome ? seeAll('/insider-buying', 'All buying') : null}>
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
          <Card title="Largest insider sales" pad={false} action={signedIn ? seeAll('/data?tab=trades&side=sell&sort=value', 'All sales') : null}>
            <ul className="sx-rows">
              {d.sells.map(r => (
                <li key={`${r.ticker}:${r.raw}`} className="sx-row">
                  <StockLink ticker={r.ticker} />
                  <div className="sx-row__main">
                    <div className="sx-row__title"><InsiderLink raw={r.raw}>{r.name}</InsiderLink> <RoleTag role={r.role} name={r.raw} /></div>
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
    {onHome && d.leader && <Leader l={d.leader} />}
    </>
  );
}

const YOURS_PREVIEW = 8;
const QUIET_PREVIEW = 16;

function Yours({ d, watchlist, since }) {
  const [expanded, setExpanded] = useState(false);
  // The feed is a snapshot from the server. Once this browser has the saved
  // watchlist, only show what's on it (plus holdings), so a stock removed a
  // moment ago doesn't linger here while it's already gone from Watchlist.
  const raw = d.yours;
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

  // "New": filed after the day of your last visit. (Filings from that same
  // day may be ones you already saw, so they're listed without the tag.)
  // A first visit, or one more than a week ago, would tag everything, so
  // nothing is tagged then.
  const days = raw.days || HOME_DAYS;
  const recentVisit = Number.isFinite(since) && Date.now() - since < days * 864e5;
  const sinceDay = recentVisit ? etDate(since) : null;
  const label = `Last ${days} days${sinceDay ? ' · New since your last visit' : ''}`;
  const isNewStock = s => !!(sinceDay && s.last_filed && s.last_filed > sinceDay);
  const isNewPerson = p => !!(sinceDay && p.recent.some(r => r.filed && r.filed > sinceDay));

  // Anything with filings in the window gets a full row, newest first (the
  // server sorts). Everything quiet shares one line at the bottom.
  const activeAll = y.stocks.filter(s => s.active);
  const activePeopleAll = y.people.filter(p => p.recent.length);
  const quietStocks = y.stocks.filter(s => !s.active);
  const quietPeople = y.people.filter(p => !p.recent.length);
  const activeTotal = activeAll.length + activePeopleAll.length;
  let budget = expanded ? Infinity : YOURS_PREVIEW;
  const take = arr => { const out = arr.slice(0, Math.max(0, budget)); budget -= out.length; return out; };
  const active = take(activeAll);
  const activePeople = take(activePeopleAll);
  const hidden = activeTotal - active.length - activePeople.length;
  const quietCount = quietStocks.length + quietPeople.length;
  const quietShown = [...quietStocks.map(s => ({ kind: 'stock', s })), ...quietPeople.map(p => ({ kind: 'person', p }))].slice(0, QUIET_PREVIEW);

  const Stock = ({ s }) => {
    const b = s.recent_buys || {}, sl = s.recent_sells || {};
    // Active only because a member of Congress traded it: lead with that line
    // (it comes last from the server, after the 12-month company summary).
    const cg = s.congress || { buys: 0, sells: 0, buy_range: [0, 0], sell_range: [0, 0] };
    const congressOnly = !b.n && !sl.n && s.recent_congress > 0;
    const lines = congressOnly ? [...s.lines.filter(l => l.startsWith('Congress:')), ...s.lines.filter(l => !l.startsWith('Congress:'))] : s.lines;
    return (
      <li className="sx-row sx-row--yours">
        <StockLink ticker={s.ticker} />
        <div className="sx-row__main">
          <div className="sx-row__title"><Link to={stockPath(s.ticker)} className="sx-row__name">{s.company}</Link>{isNewStock(s) && <Chip tone="new">New</Chip>}{s.reversal && <Chip tone="rev" title="Someone at the company bought after 2+ sales and no buys of this stock in the previous 2 years">Reversal</Chip>}{s.held && <Chip tone="accent">You hold this</Chip>}</div>
          {lines.slice(0, 2).map((l, i) => <div key={i} className="sx-row__sub">{l}</div>)}
        </div>
        {/* Same shape on every row: amounts on top, how many trades under. Congress
            amounts are disclosed as ranges, so their totals are ranges too. */}
        <div className="sx-row__end">
          {congressOnly ? (<>
            {cg.buys > 0 && <span className="sx-row__amt sx-up">+{range(cg.buy_range)}</span>}
            {cg.sells > 0 && <span className="sx-row__amt sx-down">−{range(cg.sell_range)}</span>}
            <span className="sx-row__meta">{[cg.buys && plural(cg.buys, 'buy'), cg.sells && plural(cg.sells, 'sale')].filter(Boolean).join(' · ')}</span>
            <span className="sx-row__meta sx-row__meta--congress">by Congress</span>
          </>) : (<>
            {b.n > 0 && <span className="sx-row__amt sx-up">+{money(b.v)}</span>}
            {sl.n > 0 && <span className="sx-row__amt sx-down">−{money(sl.v)}</span>}
            <span className="sx-row__meta">{[b.n && plural(b.n, 'buy'), sl.n && plural(sl.n, 'sale')].filter(Boolean).join(' · ')}</span>
          </>)}
        </div>
      </li>
    );
  };
  const Person = ({ p }) => {
    const t = p.recent[0];
    const initials = (p.name || '').split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    return (
      <li className="sx-row sx-row--yours">
        <span className="sx-avatar-sm" aria-hidden="true">{initials}</span>
        <div className="sx-row__main">
          <div className="sx-row__title"><InsiderLink raw={p.raw}>{p.name}</InsiderLink>{p.role && <RoleTag role={p.role} name={p.raw} className="sx-row__role" />}{isNewPerson(p) && <Chip tone="new">New</Chip>}</div>
          {p.recent.slice(0, 3).map((r, i) => (
            <div key={i} className="sx-row__sub">
              {r.type === 'buy' ? 'Bought' : 'Sold'} {r.congress ? congressRange(r.value) : money(r.value)} of <StockLink ticker={r.ticker} plain /> {ago(r.date)}
            </div>))}
        </div>
        <div className="sx-row__end">
          {t && <span className={`sx-row__amt ${t.type === 'buy' ? 'sx-up' : 'sx-down'}`}>{t.type === 'buy' ? '+' : '−'}{t.congress ? congressRange(t.value) : money(t.value)}</span>}
          <span className="sx-row__meta">{plural(p.recent.length, 'trade')}</span>
        </div>
      </li>
    );
  };
  return (
    <Card title="Your stocks and people" sub={activeTotal ? label : `${label}: nothing new`} pad={false}
      action={<Link to="/watchlist" className="sx-link">Watchlist <Icon name="arrow" size={12} /></Link>}>
      {activeTotal > 0 && (
        <ul className="sx-rows">
          {active.map(s => <Stock key={s.ticker} s={s} />)}
          {activePeople.map(p => <Person key={p.raw} p={p} />)}
        </ul>
      )}
      {hidden > 0 || (expanded && activeTotal > YOURS_PREVIEW) ? (
        <button className="sx-more" onClick={() => setExpanded(e => !e)} aria-expanded={expanded}>
          {expanded ? 'Show less' : `Show ${hidden} more with new trades`}
          <Icon name="chevron" size={12} className={expanded ? 'sx-more__up' : ''} />
        </button>
      ) : null}
      {quietCount > 0 && (
        <div className="sx-quiet">
          <span className="sx-quiet__label">{activeTotal ? 'Quiet' : 'No new filings'}</span>
          <span className="sx-quiet__list">
            {quietShown.map(q => q.kind === 'stock'
              ? <StockLink key={'s' + q.s.ticker} ticker={q.s.ticker} />
              : <InsiderLink key={'p' + q.p.raw} raw={q.p.raw} className="sx-quiet__person">{q.p.name}</InsiderLink>)}
            {quietCount > quietShown.length && <Link to="/watchlist" className="sx-link sx-quiet__more">+{quietCount - quietShown.length} more</Link>}
          </span>
        </div>
      )}
      <div className="sx-card__links">
        <Link to="/data?mine=1" className="sx-link">See their trades <Icon name="arrow" size={12} /></Link>
      </div>
    </Card>
  );
}

// "Less insider buying than usual this week: 42% below the 12-week average
// number of buys. Sales usually..." -> "Less insider buying than usual this
// week (42% below the 12-week average)".
function shortPulse(line) {
  const [head, rest] = String(line).split(': ');
  const first = s => s.split('. ')[0].replace(/\.$/, '');
  return rest ? `${head} (${first(rest).replace(' number of buys', '')})` : first(head);
}

// Every open-market buy and sale filed in the last 7 days, all stocks.
// The Data page's Signals tab only totals the stocks it groups, so the
// labels here say exactly what's counted.
function Pulse({ p, signedIn }) {
  return (
    <div className="sx-pulse">
      <div className="sx-pulse__stat"><span className="sx-pulse__label">Bought this week</span><span className="sx-pulse__val sx-up">{money(p.buy_v)}</span><span className="sx-muted">{plural(p.buy_n, 'filing')}</span></div>
      <div className="sx-pulse__stat"><span className="sx-pulse__label">Sold this week</span><span className="sx-pulse__val sx-down">{money(p.sell_v)}</span><span className="sx-muted">{plural(p.sell_n, 'filing')}</span></div>
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
    <Card className="sx-featured" title="Featured filing" sub={`${c.why ? `${c.why}. ` : "The week's most notable insider buying. "}A summary of what was filed, not a recommendation.`}>
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
              <span><InsiderLink raw={b.raw} className="sx-strong">{b.name}</InsiderLink> <RoleTag role={b.role} name={b.raw} /></span>
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
          {facts.length ? facts.join(' · ') : <><InsiderLink raw={top.raw}>{top.name}</InsiderLink> <RoleTag role={top.role} name={top.raw} /></>}
        </div>
      </div>
      <span className="sx-row__amt sx-up">{money(c.total)}</span>
    </li>
  );
}

