// src/pages/HomeFeed.jsx — /
// One timeframe, the last 7 days, in two parts:
//   1. Your stocks and people. Anything with filings this week gets a full
//      row (anything filed since your last visit is tagged New); the
//      quiet ones share one line.
//   2. This week across the market: the week's totals, the featured filing,
//      more buying, Congress, the largest sales, and the leaderboard's top name.
import React, { useEffect, useMemo, useState } from 'react';
import { useApi } from '../lib/api.js';
import { StockLink, InsiderLink, Link, stockPath, insiderPath, go } from '../lib/nav.jsx';
import { money, congressRange, ago, plural, roleText, isEntityName } from '../lib/text.js';
import { Card, Chip, Skeleton, ErrorNote, Icon, Freshness, RoleTag, Segmented, usePublicView } from '../components/ui.jsx';
import { LatestPostPill, NewsRail, TopBuyTile } from './PublicPages.jsx';
import '../home.css';
import WatchButton from '../components/WatchButton.jsx';
import { visitSince, etDate } from '../lib/visit.js';
import BubbleSphere from '../components/BubbleSphere.jsx';

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
  // This week's market (featured buy, the Buys/Sells/Congress list) is the
  // same for everyone, so it comes from the public, edge-cached copy: the
  // right column shows up fast even when your own feed is slow.
  const { data: market } = useApi('/public/insider-buying');
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
        </section>
        <aside className="hx__rail" aria-label="This week on Seli">
          {market?.featured ? <TopBuyTile c={market.featured} watchlist={watchlist} /> : !market && <Skeleton lines={6} />}
          {market && <WeekFeed d={market} skip={market.featured?.ticker} />}
          {d?.leader && <LeaderTile l={d.leader} />}
          <NewsRail posts={news ? news.posts || [] : null} limit={3} title="From the newswire" skipSlug={news?.posts?.[0]?.slug} />
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
// skip: a ticker already shown above it (the featured buy), left out of Buys.
function WeekFeed({ d, skip = null }) {
  const [tab, setTab] = useState('buys');
  const buys = [d.featured, ...(d.more || [])].filter(c => c && c.ticker !== skip);
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
      <Link to={tab === 'congress' ? '/congress' : `/trades?view=trades${tab === 'sells' ? '&side=sell&sort=value&dir=asc' : '&side=buy'}`} className="sx-link hx-feed__more">
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


function Yours({ d, watchlist, since }) {
  const sig = useWatchSignals(watchlist); // before any early return (hooks)
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
  const activeTotal = activeAll.length + activePeopleAll.length;

  // One view of the whole watchlist (see WatchSphere below).
  const items = [
    ...y.stocks.map(s => stockItem(s, isNewStock(s))),
    ...y.people.map(p => personItem(p, isNewPerson(p))),
  ];
  for (const it of items) it.signal = it.kind === 'stock' ? sig.tickers[it.label] : sig.people[it.raw];
  return (
    <>
      <div className="hx-sechead">
        <h2>Your watchlist this week</h2>
        <span className="hx-sechead__links">
          <Link to="/trades?view=trades&mine=1" className="sx-link">Their trades</Link>
          <Link to="/watchlist" className="sx-link">Edit watchlist ({y.watching})</Link>
        </span>
      </div>
      {activeTotal === 0 && <p className="sx-muted hx-sphere__quiet">Nothing new in the last {days} days. Quiet is normal: most stocks see a few insider trades a year.</p>}
      <WatchSphere items={items} />
    </>
  );
}

// ── The watchlist as a word cloud ────────────────────────────────────────────
// Every stock and person you watch is one tile. Size says how recent the last
// insider trade was (this week, 30 days, a year, nothing in a year), color
// says which way (green bought, red sold, blue Congress, gray nothing in a
// year). The biggest sit in the middle and smaller ones fan out to the edges:
// the list is ordered center-out and wrapped centered, which gives the round
// word-cloud shape with plain CSS. Hover or focus lifts a tile and shows a
// card with what happened; a click opens its page.
const DAY_MS = 864e5;
const ageDays = d => (d ? (Date.now() - Date.parse(d + 'T12:00:00Z')) / DAY_MS : Infinity);
// People as "J. Sweet". Funds and companies keep their own name, minus the
// LLC/LP part, cut to fit.
const ENTITY_TAIL = /[,\s]+(inc|llc|l\.?l\.?c|l\.?p|lp|ltd|corp|co|plc|sa|ag|nv|se|gp|limited|company)\.?$/i;
const initialLast = name => {
  if (isEntityName(name)) {
    const short = String(name).replace(ENTITY_TAIL, '').replace(ENTITY_TAIL, '').trim();
    return short.length > 16 ? `${short.slice(0, 15).trim()}…` : short;
  }
  const parts = String(name || '').split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0][0]}. ${parts[parts.length - 1]}` : name;
};
// "CEO" stays as is; "Director" becomes "director".
const roleLower = r => (/^[A-Z0-9+ ]+$/.test(r) || /^[A-Z]{2,}\b/.test(r) ? r : r.toLowerCase());
// 3 this week, 2 within 30 days, 1 within a year, 0 nothing in a year.
const tierOfAge = (active, date) => (active ? 3 : ageDays(date) <= 30 ? 2 : ageDays(date) <= 365 ? 1 : 0);

function stockItem(s, isNew) {
  const b = s.recent_buys || {}, sl = s.recent_sells || {};
  const congressOnly = s.active && !b.n && !sl.n && s.recent_congress > 0;
  const lt = s.last_trade;
  const tier = tierOfAge(s.active, lt?.date);
  const side = s.active ? (congressOnly ? 'cg' : b.n && b.v >= (sl.v || 0) ? 'buy' : 'sell') : tier ? (lt.type === 'buy' ? 'buy' : 'sell') : 'none';
  const cg = s.congress;
  const amt = !s.active ? (tier ? `${lt.type === 'buy' ? '+' : '−'}${money(lt.value)}` : null)
    : congressOnly ? (cg?.buys ? `+${range(cg.buy_range)}` : `−${range(cg.sell_range)}`)
      : side === 'buy' ? `+${money(b.v)}` : `−${money(sl.v)}`;
  const detail = s.active ? (s.lines?.[0] || '')
    : tier ? `${lt.type === 'buy' ? 'Bought' : 'Sold'} ${money(lt.value)}${lt.role ? ` by the ${roleLower(roleText(lt.role))}` : ''}, ${ago(lt.date)}.`
      : 'No company insider trades in the last year.';
  const tags = [isNew && 'New', s.reversal && 'Reversal', s.held && 'You hold this', congressOnly && 'Congress'].filter(Boolean);
  return { key: `s:${s.ticker}`, kind: 'stock', group: tier ? (side === 'cg' ? (s.congress?.buys ? 'buy' : 'sell') : side) : 'quiet', label: s.ticker, mono: true, title: s.company || s.ticker, path: stockPath(s.ticker), tier, side, amt, detail, tags,
    date: s.active ? s.last_activity : lt?.date || null,
    weight: (b.v || 0) + (sl.v || 0) + (lt?.value || 0) / 1e3 };
}

function personItem(p, isNew) {
  const t = p.recent[0];
  const last = t ? { type: t.type, date: t.date, value: t.value, ticker: t.ticker, congress: t.congress } : p.last;
  const tier = tierOfAge(!!t, last?.date);
  const side = tier ? (last.type === 'buy' ? 'buy' : 'sell') : 'none';
  const val = v => (last?.congress ? congressRange(v) : money(v));
  const amt = tier ? `${side === 'buy' ? '+' : '−'}${val(last.value)}` : null;
  const detail = tier ? `${last.type === 'buy' ? 'Bought' : 'Sold'} ${val(last.value)} of ${last.ticker}, ${ago(last.date)}.${p.recent.length > 1 ? ` ${plural(p.recent.length, 'trade')} this week.` : ''}`
    : 'No open-market trades in the last year.';
  return { key: `p:${p.raw}`, kind: 'person', raw: p.raw, group: 'people', label: initialLast(p.name), title: `${p.name}${p.role ? ` · ${roleText(p.role)}` : ''}`, path: insiderPath(p.raw), tier, side, amt, detail, date: last?.date || null,
    tags: [isNew && 'New'].filter(Boolean), weight: (t?.value || 0) + (p.last?.value || 0) / 1e3 };
}

const byWeight = (a, b) => (b.tier - a.tier) || (b.weight - a.weight) || a.label.localeCompare(b.label);

// Which watched stocks and people are in Signals right now (last 30 days),
// for the marker on their tile. Reads the shared, saved signal lists with the
// watchlist filter, so it's two small requests.
function useWatchSignals(watchlist) {
  const ready = watchlist.ready && (watchlist.tickers.length + watchlist.insiders.length) > 0;
  const q = ready ? `days=30&mine=1&mt=${encodeURIComponent(watchlist.tickers.join(','))}&mi=${encodeURIComponent(watchlist.insiders.join('|'))}` : null;
  const { data: buys } = useApi(q ? `/api/signals?side=buy&${q}` : null);
  const { data: sells } = useApi(q ? `/api/signals?side=sell&${q}` : null);
  return useMemo(() => {
    const tickers = {}, people = {};
    const watchedPeople = new Set(watchlist.insiders);
    for (const r of [...(buys?.rows || []), ...(sells?.rows || [])]) {
      const why = r.n >= 3 ? ['Cluster', ...r.why.map(w => w.label).filter(l => !/insiders (buying|selling)$/.test(l))] : r.why.map(w => w.label);
      const sig = { side: r.side, score: r.score, why: why.slice(0, 3), ticker: r.ticker };
      if (!tickers[r.ticker] || (sig.score ?? -1) > (tickers[r.ticker].score ?? -1)) tickers[r.ticker] = sig;
      for (const p of r.people || []) if (watchedPeople.has(p.raw) && !people[p.raw]) people[p.raw] = sig;
    }
    return { tickers, people };
  }, [buys, sells, watchlist.insiders]);
}

// Cloud or a plain list, remembered in this browser (phones default to the list).
const VIEW_KEY = 'seli_watch_view';
function useWatchView() {
  // Phones start on the list (the cloud is a tap away); a choice is remembered.
  const [view, setView] = useState(() => {
    const phone = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches;
    try { const v = localStorage.getItem(VIEW_KEY); return v === 'list' || v === 'cloud' ? v : phone ? 'list' : 'cloud'; } catch { return phone ? 'list' : 'cloud'; }
  });
  const set = v => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } };
  return [view, set];
}

const sigText = s => `${s.why.join(' · ')}${s.score != null ? ` · strength ${s.score}` : ''}`;
const sigPath = s => `/trades?view=signals${s.side === 'sell' ? '&side=sell' : ''}&q=${encodeURIComponent(s.ticker)}`;

// Cloud (BubbleSphere) or a plain list, with the switch between them.
const GROUP_ORDER = { buy: 0, sell: 1, people: 2, quiet: 3 };
function WatchSphere({ items }) {
  const [view, setView] = useWatchView();
  if (!items.length) return null;
  const open = (e, path) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(path); };
  const nSig = items.filter(it => it.signal).length;
  return (
    <div className="hx-sphere">
      <div className="hx-sphere__bar">
        <span className="hx-sphere__note">
          {nSig > 0 && <><span className="hx-sigdot" aria-hidden="true"><Icon name="trend" size={10} /></span>{plural(nSig, 'is a signal', 'are signals')} right now</>}
        </span>
        <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'cloud', label: 'Cloud' }, { value: 'list', label: 'List' }]} />
      </div>
      {view === 'cloud' ? <BubbleSphere items={items} sigText={sigText} sigPath={sigPath} /> : (
        <ul className="hx-wlist">
          {items.slice().sort((a, b) => (GROUP_ORDER[a.group] - GROUP_ORDER[b.group]) || byWeight(a, b)).map(it => (
            <li key={it.key} className={`hx-wlist__row hx-wlist__row--${it.side}`}>
              <a href={it.path} className={`hx-wlist__name${it.mono ? ' sx-mono' : ''}`} onClick={e => open(e, it.path)}>{it.label}</a>
              <span className="hx-wlist__detail">{it.detail}</span>
              {it.signal ? <a href={sigPath(it.signal)} className="hx-wlist__sig" onClick={e => open(e, sigPath(it.signal))} title={sigText(it.signal)}><Icon name="trend" size={11} />Signal</a> : <span />}
              <span className={`hx-wlist__amt sx-mono${it.side === 'buy' ? ' sx-up' : it.side === 'sell' ? ' sx-down' : ''}`}>{it.amt || ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
