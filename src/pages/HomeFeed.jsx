// src/pages/HomeFeed.jsx — /
// Your stuff first, then the week's most notable insider buying told the
// way the Sunday email tells it, then the rest. Every tile answers
// "what did insiders do".
import React, { useEffect, useState } from 'react';
import { useApi } from '../lib/api.js';
import { StockLink, InsiderLink, Link, stockPath } from '../lib/nav.jsx';
import { money, congressRange, ago, plural } from '../lib/text.js';
import { Card, Chip, Skeleton, ErrorNote, Icon } from '../components/ui.jsx';
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
      <div className="sx-feed-hello">
        <h1 className="sx-feed-hello__title">{hello}</h1>
        <p className="sx-feed-hello__sub">What company insiders and members of Congress did with their own money.</p>
      </div>

      {error && !d && <ErrorNote message={error} onRetry={reload} />}
      {!d && !error && <><Card><Skeleton lines={4} /></Card><Card><Skeleton lines={6} /></Card></>}
      {d && (
        <>
          <Yours d={d} watchlist={watchlist} />
          <MarketSections d={d} watchlist={watchlist} />
        </>
      )}
    </div>
  );
}

// The market-wide part of Home: this week's buying, Congress, big sales.
// Also used by the public /insider-buying page.
export function MarketSections({ d, watchlist }) {
  return (
    <>
    {d.pulse && <Pulse p={d.pulse} />}
    {d.featured && <Featured c={d.featured} watchlist={watchlist} />}
    <div className="sx-feed-cols">
      {d.more?.length > 0 && (
        <Card title="More insider buying this week" pad={false}>
          <ul className="sx-rows">{d.more.map(c => <ClusterRow key={c.ticker} c={c} />)}</ul>
        </Card>
      )}
      <div className="sx-feed-stack">
        {d.congress?.length > 0 && (
          <Card title="From Congress" sub="Disclosed as ranges, often weeks after the trade" pad={false}>
            <ul className="sx-rows">
              {d.congress.map(c => (
                <li key={c.ticker} className="sx-row">
                  <StockLink ticker={c.ticker} />
                  <div className="sx-row__main">
                    <div className="sx-row__title"><InsiderLink raw={c.buyers[0].raw}>{c.buyers[0].name}</InsiderLink> bought {congressRange(c.buyers[0].value)}</div>
                    <div className="sx-row__sub">{c.company}{c.n_insiders > 1 ? ` · ${plural(c.n_insiders - 1, 'other member')}` : ''}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {d.sells?.length > 0 && (
          <Card title="Largest insider sales this week" pad={false}>
            <ul className="sx-rows">
              {d.sells.map(r => (
                <li key={`${r.ticker}:${r.raw}`} className="sx-row">
                  <StockLink ticker={r.ticker} />
                  <div className="sx-row__main">
                    <div className="sx-row__title"><InsiderLink raw={r.raw}>{r.name}</InsiderLink> <span className="sx-muted">({r.role})</span></div>
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
  const y = d.yours;
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
  return (
    <Card title="Your stocks and people" sub="Last 14 days" className="sx-yours"
      action={<Link to="/watchlist" className="sx-link">Watchlist <Icon name="arrow" size={12} /></Link>}>
      {!active.length && !activePeople.length && <p className="sx-lead">Nothing new in the last two weeks. Here's where each one stands.</p>}
      <ul className="sx-yours__list">
        {active.map(s => (
          <li key={s.ticker} className="sx-yours__item">
            <div className="sx-yours__head">
              <StockLink ticker={s.ticker} />
              <span className="sx-yours__co">{s.company}</span>
              {s.held && <Chip tone="accent">You hold this</Chip>}
              {s.recent_buys.n > 0 && <Chip tone="buy">{plural(s.recent_buys.n, 'buy')} · {money(s.recent_buys.v)}</Chip>}
              {s.recent_sells.n > 0 && <Chip tone="sell">{plural(s.recent_sells.n, 'sale')} · {money(s.recent_sells.v)}</Chip>}
            </div>
            {s.lines.slice(0, 2).map((l, i) => <p key={i} className={i === 0 ? 'sx-yours__line' : 'sx-yours__line sx-muted'}>{l}</p>)}
          </li>
        ))}
        {activePeople.map(p => (
          <li key={p.raw} className="sx-yours__item">
            <div className="sx-yours__head">
              <InsiderLink raw={p.raw} className="sx-strong">{p.name}</InsiderLink>
              <span className="sx-yours__co">{p.role}</span>
            </div>
            {p.recent.slice(0, 3).map((t, i) => (
              <p key={i} className="sx-yours__line">
                {t.type === 'buy' ? 'Bought' : 'Sold'} <b className={t.type === 'buy' ? 'sx-up' : 'sx-down'}>{t.congress ? congressRange(t.value) : money(t.value)}</b> of <StockLink ticker={t.ticker} /> {ago(t.date)}.
              </p>
            ))}
          </li>
        ))}
      </ul>
      {/* Quiet ones still say something: 12-month picture and the last insider buy. */}
      {(quiet.length > 0 || quietPeople.length > 0) && (
        <ul className={`sx-yours__list${active.length || activePeople.length ? ' sx-yours__list--quiet' : ''}`}>
          {quiet.map(s => (
            <li key={s.ticker} className="sx-yours__item sx-yours__item--quiet">
              <div className="sx-yours__head">
                <StockLink ticker={s.ticker} />
                <span className="sx-yours__co">{s.company}</span>
                {s.held && <Chip tone="accent">You hold this</Chip>}
                <Chip>No trades in 14 days</Chip>
              </div>
              {s.lines.slice(0, 2).map((l, i) => <p key={i} className={`sx-yours__line${i ? ' sx-muted' : ''}`}>{l}</p>)}
            </li>
          ))}
          {quietPeople.map(p => (
            <li key={p.raw} className="sx-yours__item sx-yours__item--quiet">
              <div className="sx-yours__head">
                <InsiderLink raw={p.raw} className="sx-strong">{p.name}</InsiderLink>
                {p.role && <span className="sx-yours__co">{p.role}</span>}
                <Chip>No trades in 14 days</Chip>
              </div>
              <p className="sx-yours__line sx-muted">
                {p.last ? <>Last trade: {p.last.type === 'buy' ? 'bought' : 'sold'} {money(p.last.value)} of <StockLink ticker={p.last.ticker} /> {ago(p.last.date)}.</> : 'No open-market trades on record.'}
              </p>
            </li>
          ))}
        </ul>
      )}
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

function Pulse({ p }) {
  return (
    <div className="sx-pulse">
      <div className="sx-pulse__stat"><span className="sx-pulse__label">Insiders bought this week</span><span className="sx-pulse__val sx-up">{money(p.buy_v)}</span><span className="sx-muted">{plural(p.buy_n, 'filing')}</span></div>
      <div className="sx-pulse__stat"><span className="sx-pulse__label">Insiders sold</span><span className="sx-pulse__val sx-down">{money(p.sell_v)}</span><span className="sx-muted">{plural(p.sell_n, 'filing')}</span></div>
      {p.line && <p className="sx-pulse__line">{p.line}</p>}
    </div>
  );
}

function Featured({ c, watchlist }) {
  return (
    <Card className="sx-featured" title="Featured filing this week" sub="Picked by how many insiders bought, their roles, trade size and stake change. A summary of what was filed, not a recommendation.">
      <div className="sx-featured__head">
        <div>
          <StockLink ticker={c.ticker} className="sx-tk--lg" />
          <span className="sx-featured__co">{c.company}</span>
        </div>
        <div className="sx-featured__right">
          <span className="sx-featured__total sx-up">{money(c.total)}</span>
          <WatchButton watchlist={watchlist} kind="stock" id={c.ticker} compact />
        </div>
      </div>
      <p className="sx-featured__lead">{c.lead}</p>
      {c.facts.length > 0 && <div className="sx-chips">{c.facts.map(f => <Chip key={f.label} tone={f.tone}>{f.label}</Chip>)}</div>}
      <ul className="sx-buyers">
        {c.buyers.map(b => (
          <li key={b.raw}>
            <span><InsiderLink raw={b.raw} className="sx-strong">{b.name}</InsiderLink> <span className="sx-muted">· {b.role}</span></span>
            <span>{b.stake && <Chip>{b.stake}</Chip>}<b className="sx-mono sx-up">{money(b.value)}</b></span>
          </li>
        ))}
        {c.more_buyers > 0 && <li className="sx-muted">+ {plural(c.more_buyers, 'more insider')}</li>}
      </ul>
      <div className="sx-about">
        <div className="sx-about__label">About this filing</div>
        <p>{c.context}</p>
      </div>
      <Link to={stockPath(c.ticker)} className="sx-link">See every {c.ticker} insider trade <Icon name="arrow" size={12} /></Link>
    </Card>
  );
}

function ClusterRow({ c }) {
  const top = c.buyers[0];
  const facts = c.facts.slice(0, 3).map(f => f.label);
  return (
    <li className="sx-row">
      <StockLink ticker={c.ticker} />
      <div className="sx-row__main">
        <div className="sx-row__title">{c.company}</div>
        <div className="sx-row__sub">
          {facts.length ? facts.join(' · ') : <><InsiderLink raw={top.raw}>{top.name}</InsiderLink> ({top.role})</>}
        </div>
      </div>
      <span className="sx-row__amt sx-up">{money(c.total)}</span>
    </li>
  );
}

