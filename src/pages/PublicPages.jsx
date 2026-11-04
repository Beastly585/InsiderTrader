// src/pages/PublicPages.jsx
// What signed-out visitors (and Google) see on stock, insider, Congress and
// insider-buying URLs: the real pages, read-only, with the free plan's 12
// months of data. Anything that needs an account (watching, alerts, Pro)
// opens sign-up instead. Signed-in users get the same URLs inside the app.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SignInButton, useClerk } from '@clerk/clerk-react';
import { useApi, useDataSinceYear } from '../lib/api.js';
import { go, StockLink, InsiderLink, NAV_TABS, tabOf, stockPath, insiderPath } from '../lib/nav.jsx';
import { plural, shortDate, money, congressRange, PAGE_TITLES, roleText } from '../lib/text.js';
import { Card, Skeleton, ErrorNote, Icon, useNarrow, Freshness, RoleTag, Segmented, PublicViewContext } from '../components/ui.jsx';
import '../home.css';
import { SearchBox, SearchOverlay } from '../components/Search.jsx';
import { openSignUp } from '../lib/intent.js';
import { TradeTable } from './StockPage.jsx';
import { MarketSections } from './HomeFeed.jsx';

// Same four tabs as the signed-in app (lib/nav.jsx).
const PUBLIC_LINKS = NAV_TABS;
const isOn = (page, id) => tabOf(page) === id;
const POPULAR = ['NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'META', 'GOOGL', 'JPM', 'PLTR', 'AMD'];

const navClick = path => e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(path); };

// Watch buttons and Pro gates on public pages: every action opens sign-up.
export function usePublicWatchlist() {
  const clerk = useClerk();
  return useMemo(() => {
    // Each action remembers itself, so after sign-up the app finishes it
    // (watches the stock, opens checkout) right where the visitor was.
    const signUp = () => openSignUp(clerk, { kind: 'signup' });
    const watch = (kind, id) => openSignUp(clerk, { kind: 'watch', what: kind, id });
    const upgrade = () => openSignUp(clerk, { kind: 'upgrade' });
    return {
      tickers: [], insiders: [], pro: false, freeLimit: 3, freeSlotsLeft: 3, synced: 0, publicMode: true,
      has: () => false, hasTicker: () => false, hasInsider: () => false,
      toggle: t => watch('stock', t), toggleTicker: t => watch('stock', t), toggleInsider: n => watch('person', n), upgrade,
      alertsOn: () => false, setAlerts: signUp, showUpgrade: null, setShowUpgrade: () => { }, signUp,
    };
  }, [clerk]);
}

// watchTarget: on a stock or person page, a slim bar under the nav offers
// alerts for that exact page. Most visitors from X or a shared link land here,
// not on the home page.
export function PublicShell({ page, logoSrc, isMobile, watchTarget, children }) {
  const clerk = useClerk();
  const [searchOpen, setSearchOpen] = useState(false);
  const signUp = () => openSignUp(clerk, { kind: 'signup' });
  const logo = (
    <a className="sx-nav__logo" href="/" onClick={navClick('/')} aria-label="Seli home">
      {logoSrc && <img src={logoSrc} alt="" />}<span>Seli</span>
    </a>
  );
  const actions = (
    <div className="sx-nav__right sx-pub__actions">
      {isMobile && <button className="sx-nav__icon" onClick={() => setSearchOpen(true)} aria-label="Search stocks and insiders"><Icon name="search" size={18} /></button>}
      <SignInButton mode="modal" forceRedirectUrl={typeof window !== 'undefined' ? window.location.pathname : '/'}><button className="sx-btn sx-btn--ghost sx-btn--sm">Sign in</button></SignInButton>
      {!isMobile && <button className="sx-btn sx-btn--accent sx-btn--sm" onClick={signUp}>Get started free</button>}
    </div>
  );
  return (
    <div className="ws-shell sx-pub">
      {isMobile ? (
        <header className="sx-nav">{logo}{actions}</header>
      ) : (
        <header className="sx-nav">
          {logo}
          <div className="sx-nav__mid">
            <nav className="sx-nav__links" aria-label="Main">
              {PUBLIC_LINKS.map(n => (
                <a key={n.id} href={n.path} aria-current={isOn(page, n.id) ? 'page' : undefined}
                  className={`sx-nav__link${isOn(page, n.id) ? ' sx-nav__link--on' : ''}`} onClick={navClick(n.path)}>{n.label}</a>
              ))}
            </nav>
            <div className="sx-nav__end">
              <div className="sx-nav__search"><SearchBox hotkey /></div>
              {actions}
            </div>
          </div>
          {/* Empty right column keeps the grid symmetric, so the middle column
              (links → buttons) lines up with the page content edges. */}
          <div className="sx-nav__right" />
        </header>
      )}
      {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} />}
      {isMobile && (
        <nav className="sx-pub__tabs" aria-label="Browse">
          {PUBLIC_LINKS.map(n => (
            <a key={n.id} href={n.path} className={isOn(page, n.id) ? 'is-on' : ''} aria-current={isOn(page, n.id) ? 'page' : undefined} onClick={navClick(n.path)}>{n.short || n.label}</a>
          ))}
        </nav>
      )}
      <main className="ws-main sx-pub__main">
        {/* The page's own Watch button does the signing up; this just says what
            Seli is and what Watch gets you. */}
        {watchTarget && (
          <p className="sx-pub__watchbar">
            <Icon name="bell" size={14} />
            <span><b>New to Seli?</b> It tracks insider and Congress trades. Tap <b>Watch</b> to get a free email when {watchTarget.kind === 'stock'
              ? <>insiders trade <b>{watchTarget.id}</b>.</> : <>this person trades.</>}</span>
          </p>
        )}
        <PublicViewContext.Provider value={signUp}>
          <div className="sx-pub__content">{children}</div>
        </PublicViewContext.Provider>
        {/* Home has its own sign-up and ticker chips. */}
        {page !== 'home' && <SignupBand onSignUp={signUp} />}
        {page !== 'home' && <PopularStocks />}
        <PublicFooter logoSrc={logoSrc} />
      </main>
    </div>
  );
}

function SignupBand({ onSignUp }) {
  return (
    <section className="sx-pub__band">
      <div>
        <h2>Get an email when insiders trade your stocks</h2>
        <p>Watch up to 3 stocks or people free. Seli emails you a plain-English summary every week, and Pro sends it the same day.</p>
      </div>
      <button className="sx-btn sx-btn--accent" onClick={onSignUp}>Get started free</button>
    </section>
  );
}

function PopularStocks() {
  return (
    <section className="sx-pub__popular" aria-label="Popular stocks">
      <h2>Popular stocks</h2>
      <p className="sx-pub__tickers">{POPULAR.map(t => <StockLink key={t} ticker={t} />)}
        <a href="/stocks" className="sx-link sx-pub__all" onClick={navClick('/stocks')}>All stocks A to Z <Icon name="arrow" size={12} /></a></p>
    </section>
  );
}

const FOOT_LINKS = [['All stocks', '/stocks'], ['Insider buying', '/insider-buying'], ['Congress trades', '/congress'], ['Insider trading news', '/blog'], ['Terms', '/terms'], ['Privacy', '/privacy'], ['Cookies', '/cookies'], ['Help', '/help']];

export function PublicFooter({ logoSrc, className = '' }) {
  return (
    <footer className={`sx-pub__foot ${className}`}>
      <a className="sx-pub__foot-logo" href="/" onClick={navClick('/')}>{logoSrc && <img src={logoSrc} alt="" />}<span>Seli</span></a>
      <nav className="sx-pub__foot-links" aria-label="Footer">
        {FOOT_LINKS.map(([label, path]) => <a key={path} href={path}>{label}</a>)}
      </nav>
      <p className="sx-pub__fine">Data from SEC EDGAR and congressional STOCK Act disclosures. Not financial advice.</p>
    </footer>
  );
}

// ── /congress ────────────────────────────────────────────────────────────────
export function CongressPage() {
  const { data: d, error, reload } = useApi('/public/congress');
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { document.title = PAGE_TITLES.congress; }, []);
  const members = d?.members || [];
  const shownMembers = showAll ? members : members.slice(0, 24);
  return (
    <div className="sx-page">
      <header className="sx-head sx-head--page">
        <div className="sx-head__main">
          <h1 className="sx-head__title">Congress stock trades</h1>
          <p className="sx-head__desc">Members of Congress have to disclose their stock trades under the STOCK Act, usually within 45 days. Amounts are reported as ranges.</p>
        </div>
      </header>
      {error && !d && <ErrorNote message={error} onRetry={reload} />}
      {!d && !error && <><Card><Skeleton lines={6} /></Card><Card><Skeleton lines={4} /></Card></>}
      {d && (
        <>
          <Card title="Latest disclosures" sub="Stock trades, most recent first" pad={false}>
            <TradeTable trades={(d.recent || []).slice(0, 30)} showTicker personLabel="Member" membersOnly />
          </Card>
          <div className="sx-feed-cols">
            <Card title="Members who traded in the last 12 months" pad={false}>
              <ul className="sx-rows">
                {shownMembers.map(m => (
                  <li key={m.raw} className="sx-row">
                    <div className="sx-row__main">
                      <div className="sx-row__title"><InsiderLink raw={m.raw}>{m.name}</InsiderLink></div>
                      <div className="sx-row__sub">
                        {plural(m.n, 'trade')}{m.last ? ` · latest ${shortDate(m.last)}` : ''}
                        {m.tickers?.length > 0 && <> · {m.tickers.map((t, i) => <React.Fragment key={t}>{i > 0 && ' '}<StockLink ticker={t} /></React.Fragment>)}</>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              {members.length > 24 && (
                <button className="sx-more" onClick={() => setShowAll(v => !v)} aria-expanded={showAll}>
                  {showAll ? 'Show less' : `Show all ${members.length} members`}
                  <Icon name="chevron" size={12} className={showAll ? 'sx-more__up' : ''} />
                </button>
              )}
            </Card>
            <Card title="Most traded by Congress" sub="Last 90 days, by number of members" pad={false}>
              <ul className="sx-rows">
                {(d.popular || []).map(p => (
                  <li key={p.ticker} className="sx-row">
                    <StockLink ticker={p.ticker} />
                    <div className="sx-row__main">
                      <div className="sx-row__title">{p.company}</div>
                      <div className="sx-row__sub">{plural(p.members, 'member')} · {plural(p.buys, 'buy')} · {plural(p.sells, 'sale')}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

// ── /insider-buying ──────────────────────────────────────────────────────────
export function InsiderBuyingPage({ watchlist }) {
  const { data: d, error, reload } = useApi('/public/insider-buying');
  useEffect(() => { document.title = PAGE_TITLES.insiderBuying; }, []);
  return (
    <div className="sx-page sx-page--feed">
      <header className="sx-head sx-head--page">
        <div className="sx-head__main">
          <h1 className="sx-head__title">Insider buying this week</h1>
          <p className="sx-head__desc">Executives and directors buying their own company's stock with their own money, from SEC Form 4 filings in the last 7 days. Grants and option exercises are left out.</p>
          <Freshness />
        </div>
      </header>
      {error && !d && <ErrorNote message={error} onRetry={reload} />}
      {!d && !error && <><Card><Skeleton lines={4} /></Card><Card><Skeleton lines={6} /></Card></>}
      {d && <MarketSections d={d} watchlist={watchlist} />}
    </div>
  );
}

// ── /stocks ──────────────────────────────────────────────────────────────────
// A to Z directory of every stock with a Form 4 in the last 12 months. Mostly
// here so every stock page is a click or two from the homepage (for Google as
// much as for people), plus a quick filter for browsing.
const letterOf = t => (/^[A-Z]/.test(t) ? t[0] : '#');
export function StocksPage() {
  const { data: d, error, reload } = useApi('/public/stocks');
  const [q, setQ] = useState('');
  useEffect(() => { document.title = PAGE_TITLES.stocks; }, []);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (d?.stocks || []).filter(s => !needle || s.t.toLowerCase().startsWith(needle) || s.c.toLowerCase().includes(needle));
    const m = new Map();
    for (const s of list) { const k = letterOf(s.t); if (!m.has(k)) m.set(k, []); m.get(k).push(s); }
    return [...m.entries()];
  }, [d, q]);
  const jumpTo = k => e => {
    e.preventDefault();
    document.getElementById(`letter-${k === '#' ? 'num' : k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <div className="sx-page sx-stocks">
      <header className="sx-head sx-head--page">
        <div className="sx-head__main">
          <h1 className="sx-head__title">Insider trading by stock</h1>
          <p className="sx-head__desc">Every stock with an SEC Form 4 insider filing in the last 12 months{d?.stocks ? ` (${d.stocks.length.toLocaleString('en-US')})` : ''}. Pick a company to see which executives and directors are buying or selling.</p>
        </div>
      </header>
      {error && !d && <ErrorNote message={error} onRetry={reload} />}
      {!d && !error && <Card><Skeleton lines={8} /></Card>}
      {d && (
        <>
          {(d.popular || []).length > 0 && (
            <Card title="Most active" sub="Stocks with the most insider filings">
              <p className="sx-pub__tickers">{d.popular.slice(0, 24).map(s => <StockLink key={s.t} ticker={s.t} title={s.c} />)}</p>
            </Card>
          )}
          <div className="sx-stocks__bar">
            <div className="sx-search__field sx-stocks__filter">
              <span className="sx-search__icon"><Icon name="search" size={14} /></span>
              <input className="sx-search__input" type="search" value={q} onChange={e => setQ(e.target.value)}
                placeholder="Filter by ticker or company" aria-label="Filter stocks by ticker or company" />
            </div>
            {!q && (
              <nav className="sx-stocks__jump" aria-label="Jump to letter">
                {groups.map(([k]) => <a key={k} href={`#letter-${k === '#' ? 'num' : k}`} onClick={jumpTo(k)}>{k}</a>)}
              </nav>
            )}
          </div>
          {groups.map(([k, list]) => (
            <Card key={k} id={`letter-${k === '#' ? 'num' : k}`} title={k} className="sx-stocks__group">
              <ul className="sx-stocks__grid">
                {list.map(s => (
                  <li key={s.t}><StockLink ticker={s.t} /><span className="sx-stocks__co">{s.c}</span></li>
                ))}
              </ul>
            </Card>
          ))}
          {!groups.length && <p className="sx-muted">No stocks match "{q}".</p>}
        </>
      )}
    </div>
  );
}

// ── Shared bits for both homes ───────────────────────────────────────────────
const initialsOf = name => String(name || '').split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
const postPath = p => `/blog/${p.slug}`;

// One row that scrolls sideways. Arrow buttons and a fade show on the side
// that has more (desktop); on phones it's a plain swipe.
export function ScrollRow({ children, label, className = '' }) {
  const ref = useRef(null);
  const [edge, setEdge] = useState({ l: false, r: false });
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const l = el.scrollLeft > 4, r = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setEdge(e => (e.l === l && e.r === r ? e : { l, r }));
  };
  useEffect(() => {
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro && ref.current) ro.observe(ref.current);
    return () => ro?.disconnect();
  });
  const by = dir => () => ref.current?.scrollBy({ left: dir * Math.max(240, ref.current.clientWidth * 0.8), behavior: 'smooth' });
  return (
    <div className={`hx-scroll${edge.l ? ' can-l' : ''}${edge.r ? ' can-r' : ''} ${className}`}>
      <div className="hx-scroll__track" ref={ref} onScroll={measure} role="list" aria-label={label}>{children}</div>
      {edge.l && <button type="button" className="hx-scroll__btn hx-scroll__btn--l" onClick={by(-1)} aria-label="Scroll left"><Icon name="arrow" size={14} style={{ transform: 'rotate(180deg)' }} /></button>}
      {edge.r && <button type="button" className="hx-scroll__btn hx-scroll__btn--r" onClick={by(1)} aria-label="Scroll right"><Icon name="arrow" size={14} /></button>}
    </div>
  );
}

// "New: <latest post title>" link above both homes' headlines.
export function LatestPostPill({ post }) {
  if (!post) return <div className="hx-new hx-new--empty" aria-hidden="true" />;
  return (
    <a className="hx-new" href={postPath(post)} onClick={navClick(postPath(post))}>
      <span className="hx-new__dot" aria-hidden="true" /><b>New:</b><span className="hx-new__title">{post.title}</span><Icon name="arrow" size={12} />
    </a>
  );
}

// The newswire in a column: kind and date, the headline, and a button into
// the stock it's about.
export function NewsRail({ posts, limit = 5, title = 'Latest from the newswire', compact = false }) {
  const list = (posts || []).slice(0, limit);
  return (
    <div className={`hx-rail__news${compact ? ' hx-rail__news--compact' : ''}`}>
      <a className="hx-rail__title" href="/blog" onClick={navClick('/blog')}>{title} <Icon name="arrow" size={13} /></a>
      {!posts && <Skeleton lines={4} />}
      {posts && !list.length && <p className="sx-muted sx-small">No posts yet this week.</p>}
      <ul className="hx-posts">
        {list.map(p => (
          <li key={p.slug} className="hx-post">
            <div className="hx-post__meta">
              <span className={p.kind === 'sell' ? 'sx-down' : p.kind === 'buy' ? 'sx-up' : ''}>{NEWS_KIND[p.kind] || 'News'}</span>
              {p.published_at ? ` · ${shortDate(p.published_at.slice(0, 10))}` : ''}
            </div>
            <a className="hx-post__title" href={postPath(p)} onClick={navClick(postPath(p))}>{p.title}</a>
            {!compact && (p.ticker
              ? <a className="hx-go" href={stockPath(p.ticker)} onClick={navClick(stockPath(p.ticker))}>See {p.ticker} <Icon name="arrow" size={11} /></a>
              : <a className="hx-go" href={postPath(p)} onClick={navClick(postPath(p))}>Read it <Icon name="arrow" size={11} /></a>)}
          </li>
        ))}
      </ul>
      {posts && list.length > 0 && <a className="hx-allnews" href="/blog" onClick={navClick('/blog')}>All news</a>}
    </div>
  );
}

// ── / for signed-out visitors ────────────────────────────────────────────────
const NEWS_KIND = { buy: 'Insider buy', sell: 'Insider sale', roundup: 'Weekly roundup' };

// This week's biggest moves, raw facts only: several insiders buying the same
// stock first, then the largest buys and sales by dollars, then Congress.
function useMovers(buying, congress) {
  return useMemo(() => {
    const clusters = [buying?.featured, ...(buying?.more || [])].filter(Boolean);
    const who = (name, role, n) => `${name}${role ? `, ${roleText(role)}` : ''}${n > 1 ? ` + ${plural(n - 1, 'other')}` : ''}`;
    const buys = clusters.map(c => ({
      ticker: c.ticker, company: c.company, side: 'up', amt: `+${money(c.total)}`, v: c.total,
      count: c.n_insiders > 1 ? `${c.n_insiders} insiders` : null, kind: c.n_insiders > 1 ? `${c.n_insiders} insiders buying` : 'Insider buy',
      detail: who(c.buyers[0].name, c.buyers[0].role, c.n_insiders), group: c.n_insiders > 1 ? 0 : 1,
    }));
    const sells = (buying?.sells || []).filter(r => !r.planned).map(r => ({
      ticker: r.ticker, company: r.company, side: 'down', amt: `−${money(r.value)}`, v: r.value,
      count: r.n > 1 ? plural(r.n, 'sale') : null, kind: 'Insider sale', detail: who(r.name, r.role, 1), group: 1,
    }));
    const cg = (congress?.recent || []).slice(0, 4).map(t => ({
      ticker: t.ticker, company: t.company, side: t.type === 'buy' ? 'up' : 'down', amt: congressRange(t.value), v: 0,
      count: null, kind: `Congress ${t.type === 'buy' ? 'buy' : 'sale'}`, detail: `${t.name}${t.date ? `, ${shortDate(t.date)}` : ''}`, group: 2, cg: true,
    }));
    const all = [...buys, ...sells, ...cg].sort((a, b) => a.group - b.group || b.v - a.v);
    const seen = new Set();
    return all.filter(m => m.ticker && !seen.has(m.ticker) && seen.add(m.ticker)).slice(0, 10);
  }, [buying, congress]);
}

const WHY = [
  { icon: 'clock', title: 'Research clean history', body: 'Every open-market insider and Congress trade, cleaned up and searchable.', tier: 'Pro' },
  { icon: 'user', title: 'Cluster detection', body: 'See when several insiders buy the same stock at once.', tier: 'Free' },
  { icon: 'search', title: 'Follow what you own, or want to', body: 'Watch stocks and people. 3 free, unlimited on Pro.', tier: 'Free' },
  { icon: 'bell', title: 'Instant alerts', body: 'An email the same day someone trades a stock you watch.', tier: 'Pro' },
  { icon: 'check', title: 'Weekly recaps', body: 'What your stocks and people did, in a two-minute read.', tier: 'Free' },
  { icon: 'building', title: 'Link your portfolio', body: 'Connect your brokerage and Seli watches what you hold automatically.', tier: 'Pro' },
];

// Example filings for the "how it works" picture: what SEC sends, and what
// happens to each one. Form 4 transaction codes are the real ones.
const RAW_ROWS = [
  { code: 'A', what: 'Stock award', out: 'Grant, not a decision', fate: 'drop' },
  { code: 'M', what: 'Option exercise', out: 'Paperwork, not a trade', fate: 'drop' },
  { code: 'F', what: 'Shares withheld for tax', out: 'Tax, not a trade', fate: 'drop' },
  { code: 'S', what: 'Sale under 10b5-1 plan', out: 'Kept, marked planned', fate: 'flag' },
  { code: 'P', what: 'Open-market purchase', out: 'Kept', fate: 'keep' },
  { code: 'PTR', what: 'Congress disclosure', out: 'Kept', fate: 'keep' },
];

function HowItWorks({ c, signUp }) {
  const top = c?.buyers?.[0];
  return (
    <section className="hx-how" id="how">
      <h2 className="sx-section-title">How it works</h2>
      <p className="hx-how__lead">Insiders and members of Congress have to report their trades. Most of what they file isn't a real decision to buy or sell. Seli sorts that out.</p>
      <div className="hx-how__flow">
        <div className="hx-how__col">
          <div className="hx-how__step"><span>1</span>Filed</div>
          <p className="hx-how__cap">SEC Form 4s and House and Senate disclosures, read as they're published.</p>
          <ul className="hx-how__list">
            {RAW_ROWS.map(r => (
              <li key={r.code} className="hx-how__raw"><span className="hx-how__code">{r.code}</span>{r.what}</li>
            ))}
          </ul>
        </div>
        <div className="hx-how__arrow" aria-hidden="true"><Icon name="arrow" size={18} /></div>
        <div className="hx-how__col">
          <div className="hx-how__step"><span>2</span>Cleaned</div>
          <p className="hx-how__cap">Grants, exercises and tax paperwork come out. Planned sales stay, labeled.</p>
          <ul className="hx-how__list">
            {RAW_ROWS.map(r => (
              <li key={r.code} className={`hx-how__row hx-how__row--${r.fate}`}>
                <span className="hx-how__mark" aria-hidden="true">{r.fate === 'drop' ? <Icon name="x" size={12} /> : r.fate === 'flag' ? <Icon name="clock" size={12} /> : <Icon name="check" size={12} />}</span>
                <span className="hx-how__what">{r.what}</span>
                <span className="hx-how__out">{r.out}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="hx-how__arrow" aria-hidden="true"><Icon name="arrow" size={18} /></div>
        <div className="hx-how__col">
          <div className="hx-how__step"><span>3</span>Sent to you</div>
          <p className="hx-how__cap">What's left, in plain English, on the stocks you watch.</p>
          <div className="hx-how__out-card">
            <div className="hx-notif">
              <span className="hx-notif__logo" aria-hidden="true">S</span>
              <span>
                <b>{c ? `${c.ticker}: insider buying` : 'Insider buying'}</b><br />
                {top ? `${top.name} (${roleText(top.role)}) bought ${money(top.value)} on the open market.` : 'An executive bought shares on the open market.'}
                {c?.n_insiders > 1 ? ` ${plural(c.n_insiders - 1, 'other insider')} bought too.` : ''}
              </span>
            </div>
            <ul className="hx-how__adds">
              <li><Icon name="check" size={12} />First buy in years</li>
              <li><Icon name="check" size={12} />Several insiders at once</li>
              <li><Icon name="check" size={12} />Their track record</li>
            </ul>
            <button className="sx-btn sx-btn--accent" onClick={signUp}>Get alerts free</button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function PublicHome() {
  const clerk = useClerk();
  const since = useDataSinceYear();
  const { data: buying } = useApi('/public/insider-buying');
  const { data: congress } = useApi('/public/congress');
  const { data: pricing } = useApi('/public/pricing');
  const { data: news } = useApi('/public/blog?page=1&limit=3');
  useEffect(() => { document.title = PAGE_TITLES.home; }, []);
  const narrow = useNarrow();
  const signUp = () => openSignUp(clerk, { kind: 'signup' });
  const goPro = () => openSignUp(clerk, { kind: 'upgrade' });
  const movers = useMovers(buying, congress);
  const howLink = e => { e.preventDefault(); document.getElementById('how')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  return (
    <div className="hx hx--out">
      <div className="hx__grid">
        <section className="hx__main">
          <LatestPostPill post={news?.posts?.[0]} />
          <h1 className="hx-h1">Never miss a trade.</h1>
          <p className="hx-sub">Seli watches your back. Clean, near-instant insider trading data. Instant alerts. <a href="#how" className="sx-link hx-sub__link" onClick={howLink}>See how it works <Icon name="arrow" size={13} /></a></p>
          <div className="hx-search"><SearchBox variant="inline" placeholder={narrow ? 'Stock, CEO, or member of Congress' : 'Search a stock, CEO, or member of Congress...'} /></div>
          <Freshness className="hx-fresh" />

          <p className="hx-label">Biggest moves this week</p>
          {!buying && !congress ? (
            <div className="hx-chips"><span className="hx-mv hx-mv--ghost" /><span className="hx-mv hx-mv--ghost" /><span className="hx-mv hx-mv--ghost" /><span className="hx-mv hx-mv--ghost" /></div>
          ) : (
            <ScrollRow label="Biggest moves this week" className="hx-movers">
              {movers.map(m => (
                <a key={m.ticker} role="listitem" className={`hx-mv hx-mv--${m.side}`} href={stockPath(m.ticker)} onClick={navClick(stockPath(m.ticker))}
                  aria-label={`${m.ticker}: ${m.kind}, ${m.amt}. ${m.detail}`}>
                  <span className="hx-mv__main">
                    <span className="hx-mv__top">
                      <b className="hx-mv__tk">{m.ticker}</b>
                      {m.cg && <Icon name="capitol" size={12} className="hx-mv__cg" />}
                    </span>
                    <span className={`hx-mv__amt ${m.side === 'up' ? 'sx-up' : 'sx-down'}`}>{m.amt}</span>
                    <span className="hx-mv__count">{m.count || m.kind}</span>
                  </span>
                  <span className="hx-mv__more" aria-hidden="true">
                    <span className="hx-mv__co">{m.company}</span>
                    <span className="hx-mv__kind">{m.kind}</span>
                    <span className="hx-mv__who">{m.detail}</span>
                    <span className="hx-mv__go">See {m.ticker} <Icon name="arrow" size={11} /></span>
                  </span>
                </a>
              ))}
              {!movers.length && <span className="sx-muted sx-small">Nothing filed yet this week.</span>}
            </ScrollRow>
          )}
        </section>

        <aside className="hx__rail" aria-label="Latest news">
          <NewsRail posts={news ? news.posts || [] : null} limit={3} />
        </aside>
      </div>

      <section className="hx-why">
        <h2 className="sx-section-title">Why use Seli</h2>
        <ul className="hx-why__grid">
          {WHY.map(w => (
            <li key={w.title} className="hx-why__item">
              <span className="hx-why__icon"><Icon name={w.icon} size={15} /></span>
              <div>
                <div className="hx-why__title">{w.title} <span className={`hx-why__tier hx-why__tier--${w.tier.toLowerCase()}`}>{w.tier}</span></div>
                <p>{w.title === 'Research clean history' && since ? `Every open-market insider and Congress trade back to ${since}, cleaned up and searchable.` : w.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="sx-plans hx-plans" id="pricing">
        <h2 className="sx-section-title">Pricing</h2>
        <div className="sx-plans__grid">
          <div className="sx-plan">
            <div className="sx-plan__name">Free</div>
            <div className="sx-plan__price">$0</div>
            <p className="sx-plan__desc">Everything on this site, plus an account:</p>
            <ul className="sx-plan__list">
              <li>Watch 3 stocks or people</li>
              <li>A weekly email on what they did</li>
              <li>Plain-English reads, cluster and first-buy flags, track records</li>
              <li>12 months of trades on every page</li>
            </ul>
            <button className="sx-btn" onClick={signUp}>Get started free</button>
          </div>
          <div className="sx-plan sx-plan--pro">
            <div className="sx-plan__name">Pro <span className="sx-plan__beta">Beta price</span></div>
            <div className="sx-plan__price">$6.99<span>/month</span></div>
            {pricing?.annual && <p className="sx-plan__alt">or $69 a year, save 18%</p>}
            <p className="sx-plan__desc">For people who want to know the same day:</p>
            <ul className="sx-plan__list">
              <li>Watch as many stocks and people as you like</li>
              <li>Same-day email alerts and a daily digest</li>
              <li>Full history{since ? `, back to ${since}` : ''}</li>
              <li>The full leaderboard, 2 and 5 year views</li>
              <li>Link your brokerage to watch what you hold</li>
            </ul>
            <button className="sx-btn sx-btn--accent" onClick={goPro}>Go Pro</button>
          </div>
          <div className="sx-plan">
            <div className="sx-plan__name">Dataset</div>
            <div className="sx-plan__price">$39.99<span> one time</span></div>
            <p className="sx-plan__desc">For your own analysis, no subscription:</p>
            <ul className="sx-plan__list">
              <li>Every open-market insider and Congress trade{since ? ` since ${since}` : ''}</li>
              <li>CSV, one file per year, 18 fields</li>
              <li>Linked to the original SEC filing</li>
            </ul>
            <a className="sx-btn" href="/data-download">See the dataset</a>
          </div>
        </div>
      </section>

      <HowItWorks c={buying?.featured} signUp={signUp} />
      <p className="sx-note sx-note--center hx-fine">Seli shows what was filed. It isn't investment advice. <a href="/about" className="sx-link">How the data and scores work</a></p>
    </div>
  );
}

// ── /trades for signed-out visitors ─────────────────────────────────────────
// The raw feed: this week's biggest open-market buys and sales and the latest
// Congress disclosures. No reads or flags on top (those need an account).
export function TradesPage() {
  const clerk = useClerk();
  const signUp = () => openSignUp(clerk, { kind: 'signup' });
  const [tab, setTab] = useState('buys');
  const { data: buying, error: bErr, reload: bReload } = useApi('/public/insider-buying');
  const { data: congress, error: cErr, reload: cReload } = useApi(tab === 'congress' ? '/public/congress' : null);
  useEffect(() => { document.title = 'Latest insider and Congress trades · Seli'; }, []);
  const clusters = [buying?.featured, ...(buying?.more || [])].filter(Boolean);
  return (
    <div className="sx-page sx-page--feed hx-trades">
      <header className="sx-head sx-head--page">
        <div className="sx-head__main">
          <h1 className="sx-head__title">Latest trades</h1>
          <p className="sx-head__desc">Open-market insider buys and sales filed with the SEC in the last 7 days, and the newest Congress disclosures. Grants and option exercises are left out.</p>
          <Freshness />
        </div>
      </header>
      <div className="sx-toolbar">
        <Segmented size="sm" value={tab} onChange={setTab} options={[
          { value: 'buys', label: 'Insider buys' }, { value: 'sells', label: 'Insider sales' }, { value: 'congress', label: 'Congress' },
        ]} />
      </div>
      {tab !== 'congress' && bErr && !buying && <ErrorNote message={bErr} onRetry={bReload} />}
      {tab !== 'congress' && !buying && !bErr && <Card><Skeleton lines={6} /></Card>}
      {tab === 'buys' && buying && (
        <Card title="Biggest insider buys this week" sub="Open-market purchases of $10K+, by total" pad={false}
          action={<a href="/insider-buying" className="sx-link" onClick={navClick('/insider-buying')}>Insider buying page <Icon name="arrow" size={12} /></a>}>
          <ul className="sx-rows">
            {clusters.map(c => (
              <li key={c.ticker} className="sx-row">
                <StockLink ticker={c.ticker} />
                <div className="sx-row__main">
                  <div className="sx-row__title">{c.company}</div>
                  <div className="sx-row__sub">
                    {c.buyers.slice(0, 2).map((b, i) => <React.Fragment key={b.raw}>{i > 0 && ', '}<InsiderLink raw={b.raw}>{b.name}</InsiderLink> <RoleTag role={b.role} name={b.raw} /></React.Fragment>)}
                    {c.n_insiders > 2 ? ` + ${plural(c.n_insiders - 2, 'other')}` : ''}
                  </div>
                </div>
                <span className="sx-row__amt sx-up">{money(c.total)}</span>
              </li>
            ))}
            {!clusters.length && <li className="sx-row sx-muted">No open-market insider buys filed yet this week.</li>}
          </ul>
        </Card>
      )}
      {tab === 'sells' && buying && (
        <Card title="Biggest insider sales this week" sub="Open-market sales by company insiders" pad={false}>
          <ul className="sx-rows">
            {(buying.sells || []).map(r => (
              <li key={`${r.ticker}:${r.raw}`} className="sx-row">
                <StockLink ticker={r.ticker} />
                <div className="sx-row__main">
                  <div className="sx-row__title"><InsiderLink raw={r.raw}>{r.name}</InsiderLink> <RoleTag role={r.role} name={r.raw} /></div>
                  <div className="sx-row__sub">{r.company}{r.n > 1 ? ` · ${plural(r.n, 'sale')}` : ''}{r.date ? ` · ${shortDate(r.date)}` : ''}</div>
                </div>
                <span className="sx-row__amt sx-down">{money(r.value)}</span>
              </li>
            ))}
            {!(buying.sells || []).length && <li className="sx-row sx-muted">No open-market insider sales filed yet this week.</li>}
          </ul>
        </Card>
      )}
      {tab === 'congress' && (
        <Card title="Latest Congress disclosures" sub="Amounts are reported as ranges, usually within 45 days" pad={false}
          action={<a href="/congress" className="sx-link" onClick={navClick('/congress')}>All Congress trades <Icon name="arrow" size={12} /></a>}>
          {cErr && !congress && <div className="sx-card__body"><ErrorNote message={cErr} onRetry={cReload} /></div>}
          {!congress && !cErr && <div className="sx-card__body"><Skeleton lines={6} /></div>}
          {congress && <TradeTable trades={(congress.recent || []).slice(0, 30)} showTicker personLabel="Member" membersOnly />}
        </Card>
      )}
      <div className="sx-gate sx-gate--signup">
        <span className="sx-gate__text"><Icon name="lock" size={13} /> A free account adds every trade with filters and sorting, plus Seli's reads: first buys, reversals and track records.</span>
        <button className="sx-btn sx-btn--accent sx-btn--sm" onClick={signUp}>Create free account</button>
      </div>
      <p className="sx-note sx-note--center"><a href="/stocks" className="sx-link" onClick={navClick('/stocks')}>Browse every stock A to Z</a></p>
    </div>
  );
}
