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
import { money, congressRange, ago, plural, roleText } from '../lib/text.js';
import { Card, Chip, Skeleton, ErrorNote, Icon, Freshness, RoleTag, Segmented, usePublicView } from '../components/ui.jsx';
import { LatestPostPill, NewsRail, ScrollRow } from './PublicPages.jsx';
import '../home.css';
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
  const { data: news } = useApi('/public/blog?page=1&limit=4');
  useEffect(() => { document.title = 'Home · Seli'; }, []);
  const watchKey = `${watchlist.tickers.join(',')}|${watchlist.insiders.join(',')}`;
  // Re-pull "yours" when the watchlist changes (e.g. after a Watch click).
  useEffect(() => { if (d) reload(); }, [watchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const hello = `Welcome back${user?.firstName ? `, ${user.firstName}` : ''}`;
  const y = d ? visibleYours(d.yours, watchlist) : null;
  const activeN = y ? y.stocks.filter(s => s.active).length + y.people.filter(p => p.recent.length).length : 0;
  const totalN = y ? y.stocks.length + y.people.length : 0;
  const summary = !y ? 'What company insiders and members of Congress did with their own money.'
    : !totalN ? 'Watch a few stocks or people and their insider trades show up here.'
      : activeN ? `${activeN} of your ${plural(totalN, 'stock or person', 'stocks and people')} had insider activity in the last ${HOME_DAYS} days.`
        : `Nothing new on your ${plural(totalN, 'stock or person', 'stocks and people')} in the last ${HOME_DAYS} days.`;

  return (
    <div className="hx hx--in">
      <div className="hx__grid">
        <section className="hx__main">
          <LatestPostPill post={news?.posts?.[0]} />
          <h1 className="hx-h1 hx-h1--in">{hello}</h1>
          <p className="hx-sub">{summary}</p>
          <div className="hx-search"><SearchBox variant="inline" placeholder="Search a stock, CEO, or member of Congress" /></div>
          <Freshness className="hx-fresh" />
          {error && !d && <div style={{ marginTop: 24 }}><ErrorNote message={error} onRetry={reload} /></div>}
          {!d && !error && <div style={{ marginTop: 28 }}><Card><Skeleton lines={5} /></Card></div>}
          {d && <Yours d={d} watchlist={watchlist} since={since} />}
          {d && (d.featured || d.leader) && (
            <div className="hx-duo">
              {d.featured && <FeaturedTile c={d.featured} watchlist={watchlist} />}
              {d.leader && <LeaderTile l={d.leader} />}
            </div>
          )}
        </section>
        <aside className="hx__rail" aria-label="This week on Seli">
          {d ? <WeekFeed d={d} /> : <Skeleton lines={8} />}
          <div className="hx-rail__sep">
            <NewsRail posts={news ? news.posts || [] : null} limit={3} title="From the newswire" compact />
          </div>
        </aside>
      </div>
    </div>
  );
}

// The watchlist part of the feed, trimmed to what this browser's saved list
// actually holds (the feed is a server snapshot; a stock removed a moment ago
// shouldn't linger here while it's already gone from Watchlist).
function visibleYours(raw, watchlist) {
  // A feed without the watchlist part (an error, an old Worker) shows as empty, not a crash.
  if (!raw || !Array.isArray(raw.stocks)) return { stocks: [], people: [], watching: 0, holdings: 0, days: HOME_DAYS };
  if (!watchlist.ready) return raw;
  const t = new Set(watchlist.tickers.map(x => String(x).toUpperCase()));
  const p = new Set(watchlist.insiders);
  return {
    ...raw,
    stocks: raw.stocks.filter(s => s.held || t.has(s.ticker)),
    people: raw.people.filter(x => p.has(x.raw)),
    watching: watchlist.tickers.length + watchlist.insiders.length,
  };
}

// Right rail: this week across the market, one list at a time.
function WeekFeed({ d }) {
  const [tab, setTab] = useState('buys');
  const buys = [d.featured, ...(d.more || [])].filter(Boolean);
  const rows = tab === 'buys'
    ? buys.slice(0, 7).map(c => ({ key: c.ticker, ticker: c.ticker, who: <><InsiderLink raw={c.buyers[0].raw}>{c.buyers[0].name}</InsiderLink>{c.n_insiders > 1 ? ` + ${c.n_insiders - 1}` : ''}</>, sub: c.facts?.[0]?.label || c.company, amt: money(c.total), tone: 'sx-up' }))
    : tab === 'sells'
      ? (d.sells || []).map(r => ({ key: `${r.ticker}:${r.raw}`, ticker: r.ticker, who: <InsiderLink raw={r.raw}>{r.name}</InsiderLink>, sub: `${roleText(r.role)}${r.planned ? ' · planned sale' : ''}`, amt: money(r.value), tone: 'sx-down' }))
      : (d.congress || []).map(c => ({ key: c.ticker, ticker: c.ticker, who: <InsiderLink raw={c.buyers[0].raw}>{c.buyers[0].name}</InsiderLink>, sub: c.n_insiders > 1 ? `${c.company} · ${plural(c.n_insiders - 1, 'other member')}` : c.company, amt: congressRange(c.buyers[0].value), tone: '' }));
  return (
    <div className="hx-feed">
      <h2 className="hx-feed__title">This week on Seli</h2>
      <Segmented size="sm" value={tab} onChange={setTab} options={[{ value: 'buys', label: 'Buys' }, { value: 'sells', label: 'Sells' }, { value: 'congress', label: 'Congress' }]} />
      <ul className="hx-feed__rows">
        {rows.map(r => (
          <li key={r.key} className="hx-feed__row">
            <StockLink ticker={r.ticker} />
            <div className="hx-feed__who"><div>{r.who}</div><div>{r.sub}</div></div>
            <span className={`hx-feed__amt ${r.tone}`}>{r.amt}</span>
          </li>
        ))}
        {!rows.length && <li className="hx-feed__row sx-muted sx-small">Nothing filed yet this week.</li>}
      </ul>
      <Link to={tab === 'congress' ? '/congress' : `/trades${tab === 'sells' ? '?tab=trades&side=sell&sort=value' : '?tab=trades'}`} className="sx-link hx-feed__more">
        {tab === 'congress' ? 'All Congress trades' : 'Every trade'} <Icon name="arrow" size={12} /></Link>
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
  const y = visibleYours(d.yours, watchlist);
  const raw = y;
  if (!y.watching && !y.holdings) {
    return (
      <>
        <div className="hx-sechead"><h2>Start with what you own</h2></div>
        <Card className="sx-yours sx-yours--empty">
          <p className="sx-lead">Watch a few stocks or people. Their insider activity shows up here first, and in your {watchlist.pro ? 'digests' : 'Sunday email'}.</p>
          <div className="sx-yours__search"><SearchBox mode="pick" variant="inline" watchlist={watchlist} placeholder="Add a stock or person you follow"
            onPick={it => (it.kind === 'stock' ? watchlist.toggleTicker(it.id) : watchlist.toggleInsider(it.id))} /></div>
          <div className="sx-starters">
            <span className="sx-muted">Popular:</span>
            {STARTERS.map(t => <button key={t} className="sx-starter" onClick={() => watchlist.toggleTicker(t)}><Icon name="plus" size={12} />{t}</button>)}
          </div>
        </Card>
      </>
    );
  }

  // "New": filed after the day of your last visit. (Filings from that same
  // day may be ones you already saw, so they're listed without the tag.)
  // A first visit, or one more than a week ago, would tag everything, so
  // nothing is tagged then.
  const days = raw.days || HOME_DAYS;
  const recentVisit = Number.isFinite(since) && Date.now() - since < days * 864e5;
  const sinceDay = recentVisit ? etDate(since) : null;
  const isNewStock = s => !!(sinceDay && s.last_filed && s.last_filed > sinceDay);
  const isNewPerson = p => !!(sinceDay && p.recent.some(r => r.filed && r.filed > sinceDay));

  // Anything with filings in the window gets a tile, newest first (the
  // server sorts). Everything quiet shares one line under the tiles.
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

  const StockTile = ({ s }) => {
    const b = s.recent_buys || {}, sl = s.recent_sells || {};
    const cg = s.congress || { buys: 0, sells: 0, buy_range: [0, 0], sell_range: [0, 0] };
    const congressOnly = !b.n && !sl.n && s.recent_congress > 0;
    // Active only because a member of Congress traded it: lead with that line.
    const lines = congressOnly ? [...s.lines.filter(l => l.startsWith('Congress:')), ...s.lines.filter(l => !l.startsWith('Congress:'))] : s.lines;
    const side = congressOnly ? 'cg' : b.n && b.v >= (sl.v || 0) ? 'buy' : sl.n ? 'sell' : 'buy';
    const tag = congressOnly ? 'Congress' : side === 'buy' ? 'Buying' : 'Selling';
    return (
      <div role="listitem" className={`hx-tile hx-tile--${side}`} title={lines[0] || undefined}>
        <div className="hx-tile__top">
          <Link to={stockPath(s.ticker)} className="hx-tile__tk">{s.ticker}</Link>
          <span className="hx-tile__tags">
            <span className={`hx-tag hx-tag--${side}`}>{tag}</span>
            {isNewStock(s) && <span className="hx-tag hx-tag--new">New</span>}
            {s.reversal && <span className="hx-tag hx-tag--rev" title="Someone at the company bought after 2+ sales and no buys of this stock in the previous 2 years">Reversal</span>}
            {s.held && <span className="hx-tag" title="You hold this">Held</span>}
          </span>
        </div>
        <div className="hx-tile__co">{s.company}</div>
        <div className="hx-tile__foot">
          {congressOnly ? (<>
            {cg.buys > 0 && <span className="hx-tile__amt sx-up">+{range(cg.buy_range)}</span>}
            {cg.sells > 0 && <span className="hx-tile__amt sx-down">−{range(cg.sell_range)}</span>}
          </>) : (<>
            {b.n > 0 && <span className="hx-tile__amt sx-up">+{money(b.v)}</span>}
            {sl.n > 0 && <span className="hx-tile__amt sx-down">−{money(sl.v)}</span>}
          </>)}
          <span className="hx-tile__meta">{congressOnly
            ? [cg.buys && plural(cg.buys, 'buy'), cg.sells && plural(cg.sells, 'sale')].filter(Boolean).join(' · ')
            : [b.n && plural(b.n, 'buy'), sl.n && plural(sl.n, 'sale')].filter(Boolean).join(' · ')}</span>
        </div>
      </div>
    );
  };
  const PersonTile = ({ p }) => {
    const t = p.recent[0];
    const side = t?.type === 'buy' ? 'buy' : 'sell';
    return (
      <div role="listitem" className={`hx-tile hx-tile--${side}`} title={p.role ? roleText(p.role) : undefined}>
        <div className="hx-tile__top">
          <InsiderLink raw={p.raw} className="hx-tile__name">{p.name}</InsiderLink>
          <span className="hx-tile__tags">
            <span className={`hx-tag hx-tag--${side}`}>{side === 'buy' ? 'Bought' : 'Sold'}</span>
            {isNewPerson(p) && <span className="hx-tag hx-tag--new">New</span>}
          </span>
        </div>
        <div className="hx-tile__co">{t ? `${t.ticker} · ${ago(t.date)}` : (p.role ? roleText(p.role) : 'Person you follow')}</div>
        <div className="hx-tile__foot">
          {t && <span className={`hx-tile__amt ${side === 'buy' ? 'sx-up' : 'sx-down'}`}>{side === 'buy' ? '+' : '−'}{t.congress ? congressRange(t.value) : money(t.value)}</span>}
          <span className="hx-tile__meta">{plural(p.recent.length, 'trade')}</span>
        </div>
      </div>
    );
  };
  return (
    <>
      <div className="hx-sechead">
        <h2>Your watchlist this week</h2>
        <span className="hx-sechead__links">
          <Link to="/data?mine=1" className="sx-link">Their trades</Link>
          <Link to="/watchlist" className="sx-link">Edit watchlist ({y.watching})</Link>
        </span>
      </div>
      {activeTotal > 0 ? (
        <ScrollRow label="Your watchlist this week" className="hx-tiles">
          {activeAll.map(s => <StockTile key={s.ticker} s={s} />)}
          {activePeopleAll.map(p => <PersonTile key={p.raw} p={p} />)}
        </ScrollRow>
      ) : <p className="sx-muted">Nothing new in the last {days} days. Quiet is normal: most stocks see a few insider trades a year.</p>}
      {quietCount > 0 && (
        <p className="hx-quiet">
          {activeTotal ? 'Quiet this week:' : 'Watching:'}
          {quietShown.map(q => q.kind === 'stock'
            ? <StockLink key={'s' + q.s.ticker} ticker={q.s.ticker} />
            : <InsiderLink key={'p' + q.p.raw} raw={q.p.raw}>{q.p.name}</InsiderLink>)}
          {quietCount > quietShown.length && <> <Link to="/watchlist" className="sx-link">+{quietCount - quietShown.length} more</Link></>}
        </p>
      )}
    </>
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
  const pub = usePublicView();
  return (
    <div className="sx-pulse">
      <div className="sx-pulse__stat"><span className="sx-pulse__label">Bought this week</span><span className="sx-pulse__val sx-up">{money(p.buy_v)}</span><span className="sx-muted">{plural(p.buy_n, 'filing')}</span></div>
      <div className="sx-pulse__stat"><span className="sx-pulse__label">Sold this week</span><span className="sx-pulse__val sx-down">{money(p.sell_v)}</span><span className="sx-muted">{plural(p.sell_n, 'filing')}</span></div>
      <div className="sx-pulse__text">
        {p.line && !pub && <p className="sx-pulse__line">{p.line}</p>}
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
  // Signed out: the filing itself, without Seli's read on it.
  const pub = usePublicView();
  return (
    <Card className="sx-featured" title={pub ? 'Biggest insider buying this week' : 'Featured filing'} sub={pub ? 'Open-market purchases filed in the last 7 days.' : `${c.why ? `${c.why}. ` : "The week's most notable insider buying. "}A summary of what was filed, not a recommendation.`}>
      <div className="sx-featured__head">
        <StockLink ticker={c.ticker} className="sx-tk--lg" />
        <span className="sx-featured__co">{c.company}</span>
        <span className="sx-featured__total sx-up">{money(c.total)}</span>
        <WatchButton watchlist={watchlist} kind="stock" id={c.ticker} compact />
      </div>
      {!pub && <p className="sx-featured__lead">{c.lead}</p>}
      {!pub && c.facts.length > 0 && <div className="sx-chips">{c.facts.map(f => <Chip key={f.label} tone={f.tone}>{f.label}</Chip>)}</div>}
      {/* One buyer: the summary above already says who and how much. */}
      {(pub || c.buyers.length > 1 || c.more_buyers > 0) && (
        <ul className="sx-buyers">
          {c.buyers.map(b => (
            <li key={b.raw}>
              <span><InsiderLink raw={b.raw} className="sx-strong">{b.name}</InsiderLink> <RoleTag role={b.role} name={b.raw} /></span>
              <span>{!pub && b.stake && <Chip>{b.stake}</Chip>}<b className="sx-mono sx-up">{money(b.value)}</b></span>
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
        {!pub && c.context && <p className="sx-note">{c.context}</p>}
      </div>
    </Card>
  );
}

function ClusterRow({ c }) {
  const pub = usePublicView();
  const top = c.buyers[0];
  const facts = pub ? [] : c.facts.slice(0, 2).map(f => f.label);
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


// Home's short version of the featured filing: who, how much, a couple of
// tags, and a link. The full write-up lives on the stock page.
function FeaturedTile({ c, watchlist }) {
  const top = c.buyers[0];
  return (
    <section className="hx-mini">
      <div className="hx-mini__label">Featured filing</div>
      <div className="hx-mini__head">
        <StockLink ticker={c.ticker} />
        <span className="hx-mini__co">{c.company}</span>
        <WatchButton watchlist={watchlist} kind="stock" id={c.ticker} compact />
      </div>
      <div className="hx-mini__big sx-up">{money(c.total)}</div>
      <div className="hx-mini__sub">
        {c.n_insiders > 1 ? `${c.n_insiders} insiders bought, led by ` : 'Bought by '}
        <InsiderLink raw={top.raw}>{top.name}</InsiderLink>
      </div>
      {c.facts.length > 0 && <div className="hx-mini__tags">{c.facts.slice(0, 2).map(f => <Chip key={f.label} tone={f.tone}>{f.label}</Chip>)}</div>}
      <Link to={stockPath(c.ticker)} className="sx-link hx-mini__link">See the filing <Icon name="arrow" size={12} /></Link>
    </section>
  );
}

function LeaderTile({ l }) {
  const pts = Math.round(l.excess);
  if (!(pts > 0)) return null;
  return (
    <section className="hx-mini">
      <div className="hx-mini__label">Top insider, last 12 months</div>
      <div className="hx-mini__head">
        <InsiderLink raw={l.raw} className="hx-mini__co sx-strong">{l.name}</InsiderLink>
        <RoleTag role={l.role} congress={l.congress} />
      </div>
      <div className="hx-mini__big sx-up">+{pts} pts</div>
      <div className="hx-mini__sub">vs the S&amp;P 500, across {plural(l.scored, 'scored buy')}</div>
      <Link to="/leaderboard" className="sx-link hx-mini__link">Insiders leaderboard <Icon name="arrow" size={12} /></Link>
    </section>
  );
}
