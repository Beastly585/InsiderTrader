// src/pages/PublicPages.jsx
// What signed-out visitors (and Google) see on stock, insider, Congress and
// insider-buying URLs: the real pages, read-only, with the free plan's 12
// months of data. Anything that needs an account (watching, alerts, Pro)
// opens sign-up instead. Signed-in users get the same URLs inside the app.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SignInButton, useClerk } from '@clerk/clerk-react';
import { useApi, useDataSinceYear } from '../lib/api.js';
import { go, StockLink, InsiderLink, NAV_TABS, tabOf, stockPath, insiderPath } from '../lib/nav.jsx';
import { plural, shortDate, money, congressRange, PAGE_TITLES, roleText, amount, shares, price, prettyPerson, prettyCompany, roleFromTitle, isEntityName, pct } from '../lib/text.js';
import { secFilingUrl } from '../edgar.js';
import { Card, Skeleton, ErrorNote, Icon, useNarrow, Freshness, RoleTag, Segmented, PublicViewContext, TypeBadge, FollowButton } from '../components/ui.jsx';
import '../home.css';
import { SearchBox, SearchOverlay } from '../components/Search.jsx';
import { openSignUp } from '../lib/intent.js';
import WatchButton from '../components/WatchButton.jsx';
import { TradeTable } from './StockPage.jsx';
import SignalsView, { SIGNAL_KINDS } from './SignalsView.jsx';
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
export function PublicShell({ page, logoSrc, isMobile, watchTarget, plain = false, children }) {
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
            <span><b>New to Seli?</b> It tracks insider and Congress trades. Tap <b>Follow</b> to get a free email when {watchTarget.kind === 'stock'
              ? <>insiders trade <b>{watchTarget.id}</b>.</> : <>this person trades.</>}</span>
          </p>
        )}
        <PublicViewContext.Provider value={signUp}>
          <div className="sx-pub__content">{children}</div>
        </PublicViewContext.Provider>
        {/* Home has its own sign-up and ticker chips. */}
        {/* Help, legal and export pages (plain) skip the sign-up pitch. */}
        {page !== 'home' && !plain && <SignupBand onSignUp={signUp} />}
        {page !== 'home' && !plain && <PopularStocks />}
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
        <p>Follow up to 3 stocks or people free. Seli emails you a plain-English summary every week, and Pro sends it the same day.</p>
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

// The newswire in a column, in the same card as the tiles above it: kind,
// date and stock on one line, the headline under it. skipSlug leaves out the
// post the "New:" pill at the top of the page already shows.
export function NewsRail({ posts, limit = 3, title = 'Latest from the newswire', skipSlug = null }) {
  const list = (posts || []).filter(p => p.slug !== skipSlug).slice(0, limit);
  return (
    <div className="hx-newscard">
      <div className="hx-newscard__head">
        <span className="hx-newscard__label">{title}</span>
        <a className="hx-newscard__all" href="/blog" onClick={navClick('/blog')}>All news <Icon name="arrow" size={11} /></a>
      </div>
      {!posts && <Skeleton lines={4} />}
      {posts && !list.length && <p className="sx-muted sx-small">No posts yet this week.</p>}
      <ul className="hx-posts">
        {list.map(p => (
          <li key={p.slug} className="hx-post">
            <div className="hx-post__meta">
              <span className={p.kind === 'sell' ? 'sx-down' : p.kind === 'buy' ? 'sx-up' : ''}>{NEWS_KIND[p.kind] || 'News'}</span>
              {p.published_at ? ` · ${shortDate(p.published_at.slice(0, 10))}` : ''}
              {p.ticker && <a className="hx-post__tk sx-mono" href={stockPath(p.ticker)} onClick={navClick(stockPath(p.ticker))}>{p.ticker}</a>}
            </div>
            <a className="hx-post__title" href={postPath(p)} onClick={navClick(postPath(p))}>{p.title}</a>
          </li>
        ))}
      </ul>
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
    // Funds and companies filing as big shareholders aren't "insiders" to a new
    // visitor, so a buy led by one is left out of the biggest moves.
    const buys = clusters.filter(c => !isEntityName(c.buyers?.[0]?.raw)).map(c => ({
      ticker: c.ticker, company: c.company, side: 'up', amt: `+${money(c.total)}`, v: c.total,
      count: c.n_insiders > 1 ? `${c.n_insiders} insiders` : null, kind: c.n_insiders > 1 ? `${c.n_insiders} insiders buying` : 'Insider buy',
      detail: who(c.buyers[0].name, c.buyers[0].role, c.n_insiders), group: c.n_insiders > 1 ? 0 : 1,
    }));
    const sells = (buying?.sells || []).filter(r => !r.planned && !isEntityName(r.raw)).map(r => ({
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
  { icon: 'search', title: 'Follow what you own, or want to', body: 'Follow stocks and people. 3 free, unlimited on Pro.', tier: 'Free' },
  { icon: 'bell', title: 'Instant alerts', body: 'An email the same day someone trades a stock you follow.', tier: 'Pro' },
  { icon: 'check', title: 'Weekly recaps', body: 'What your stocks and people did, in a two-minute read.', tier: 'Free' },
  { icon: 'building', title: 'Link your portfolio', body: 'Connect your brokerage and Seli watches what you hold automatically.', tier: 'Pro' },
];

// Example filings for the "how it works" picture: what SEC sends, and what
// happens to each one. Form 4 transaction codes are the real ones.
const RAW_ROWS = [
  { code: 'A', what: 'Stock award', out: 'Removed: a grant', fate: 'drop' },
  { code: 'M', what: 'Option exercise', out: 'Removed: paperwork', fate: 'drop' },
  { code: 'F', what: 'Shares withheld for tax', out: 'Removed: tax', fate: 'drop' },
  { code: 'S', what: 'Sale under a 10b5-1 plan', out: 'Kept, labeled planned', fate: 'flag' },
  { code: 'P', what: 'Open-market purchase', out: 'Kept, highlighted', fate: 'keep' },
  { code: 'PTR', what: 'Congress stock trade', out: 'Kept', fate: 'keep' },
];

function HowItWorks({ c, signUp }) {
  const top = c?.buyers?.[0];
  return (
    <section className="hx-how" id="how">
      <h2 className="sx-section-title">How it works</h2>
      <p className="hx-how__lead">Insiders and members of Congress have to report their trades, but most of what they file isn't a real decision to buy or sell. Seli sorts that out.</p>
      <div className="hx-how__flow">
        <div className="hx-how__col">
          <div className="hx-how__step"><span>1</span>Insiders file</div>
          <p className="hx-how__cap">Every SEC Form 4 and House and Senate disclosure, read as it's published.</p>
          <div className="hx-how__colhead"><span>Code</span><span>What was filed</span></div>
          <ul className="hx-how__list">
            {RAW_ROWS.map(r => (
              <li key={r.code} className="hx-how__raw"><span className="hx-how__code">{r.code}</span>{r.what}</li>
            ))}
          </ul>
        </div>
        <div className="hx-how__arrow" aria-hidden="true"><Icon name="arrow" size={18} /></div>
        <div className="hx-how__col">
          <div className="hx-how__step"><span>2</span>Seli cleans it</div>
          <p className="hx-how__cap">Grants, option exercises and tax paperwork come out. Planned sales stay, labeled as planned.</p>
          <div className="hx-how__colhead"><span>Filing</span><span>Result</span></div>
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
          <div className="hx-how__step"><span>3</span>Published and sent</div>
          <p className="hx-how__cap">What's worth knowing goes up in plain English on every stock and person page and <a href="/blog" className="sx-link" onClick={navClick('/blog')}>the newswire</a>. Follow a stock or person and it lands in your inbox.</p>
          <div className="hx-how__out-card">
            <div className="hx-notif">
              <span className="hx-notif__logo" aria-hidden="true">S</span>
              <span>
                <b>{c ? `${c.ticker}: insider buying` : 'Insider buying'}</b><br />
                {top ? `${top.name} (${roleText(top.role)}) bought ${money(top.value)} on the open market.` : 'An executive bought shares on the open market.'}
                {c?.n_insiders > 1 ? ` ${plural(c.n_insiders - 1, 'other insider')} bought too.` : ''}
              </span>
            </div>
            <div className="hx-how__addslabel">Every alert flags what makes it stand out:</div>
            <ul className="hx-how__adds">
              <li><Icon name="check" size={12} />First buy in years</li>
              <li><Icon name="check" size={12} />Several insiders buying at once</li>
              <li><Icon name="check" size={12} />How their past buys have done</li>
            </ul>
            <button className="sx-btn sx-btn--accent" onClick={signUp}>Get alerts free</button>
          </div>
        </div>
      </div>
    </section>
  );
}

// The week's biggest open-market insider buy, raw facts only, pointing at the
// full insider buying page. Sits above the newswire on the signed-out home.
// Signed in, Home passes the real watchlist; signed out, Watch opens sign-up
// and adds the stock afterwards.
export function TopBuyTile({ c, watchlist: wl }) {
  const publicWl = usePublicWatchlist();
  const watchlist = wl || publicWl;
  return (
    <div className="hx-topbuy">
      <span className="hx-topbuy__label">Biggest insider buying this week</span>
      <span className="hx-topbuy__head">
        <a className="sx-mono hx-topbuy__tk" href={stockPath(c.ticker)} onClick={navClick(stockPath(c.ticker))}>{c.ticker}</a>
        <a className="hx-topbuy__co" href={stockPath(c.ticker)} onClick={navClick(stockPath(c.ticker))}>{c.company}</a>
        <WatchButton watchlist={watchlist} kind="stock" id={c.ticker} />
      </span>
      <span className="hx-topbuy__amt sx-up">+{money(c.total)}</span>
      <span className="hx-topbuy__people">
        {(c.buyers || []).slice(0, 2).map(b => (
          <span key={b.raw} className="hx-topbuy__who"><InsiderLink raw={b.raw}>{b.name}</InsiderLink><RoleTag role={b.role} name={b.raw} /><span className="sx-mono sx-up hx-topbuy__v">{money(b.value)}</span></span>
        ))}
        {c.n_insiders > 2 && <span className="hx-topbuy__more">+ {plural(c.n_insiders - 2, 'more insider')}</span>}
      </span>
      <a className="hx-topbuy__go" href="/insider-buying" onClick={navClick('/insider-buying')}>All insider buying this week <Icon name="arrow" size={12} /></a>
    </div>
  );
}

// Totals for the week: every open-market buy and sale filed in the last 7 days.
function WeekPulse({ p }) {
  return (
    <div className="hx-pulse" aria-label="Insider trading this week">
      <div><span className="hx-pulse__label">Bought this week</span><span className="hx-pulse__val sx-up">{money(p.buy_v)}</span><span className="hx-pulse__n">{plural(p.buy_n, 'filing')}</span></div>
      <div><span className="hx-pulse__label">Sold this week</span><span className="hx-pulse__val sx-down">{money(p.sell_v)}</span><span className="hx-pulse__n">{plural(p.sell_n, 'filing')}</span></div>
    </div>
  );
}

export function PublicHome() {
  const clerk = useClerk();
  const since = useDataSinceYear();
  const { data: buying } = useApi('/public/insider-buying');
  const { data: congress } = useApi('/public/congress');
  const { data: pricing } = useApi('/public/pricing');
  const { data: news } = useApi('/public/blog?page=1&limit=4');
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
          <p className="hx-sub">Know the moment a CEO or member of Congress trades a stock you own. Seli filters out the noise other trackers pass along and alerts you instantly on the trades that matter.</p>
          <div className="hx-search"><SearchBox variant="inline" placeholder={narrow ? 'Stock, CEO, or member of Congress' : 'Search a stock, CEO, or member of Congress...'} /></div>
          <p className="hx-trust">
            <span><Icon name="check" size={13} />Free account, no card</span>
            <span><Icon name="check" size={13} />Straight from SEC and congressional filings</span>
            <a href="#how" className="sx-link" onClick={howLink}>See how it works <Icon name="arrow" size={12} /></a>
          </p>

          <p className="hx-label">Biggest moves this week <span className="hx-label__sub">Executives and members of Congress trading with their own money</span></p>
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
                    <span className="hx-mv__name">{m.company}</span>
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
          {buying?.pulse && <WeekPulse p={buying.pulse} />}
          {buying?.featured && <TopBuyTile c={buying.featured} />}
          <NewsRail posts={news ? news.posts || [] : null} limit={3} skipSlug={news?.posts?.[0]?.slug} />
        </aside>
      </div>

      {/* The hero fills the first screen; this says there's more below. */}
      <nav className="hx-below" aria-label="More on this page">
        <span className="hx-below__label">More below</span>
        {[['why', 'Why use Seli'], ['how', 'How it works'], ['pricing', 'Pricing']].map(([id, label]) => (
          <a key={id} href={`#${id}`} onClick={e => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{label}</a>
        ))}
        <Icon name="chevron" size={14} className="hx-below__chev" />
      </nav>

      <section className="hx-why" id="why">
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

      <HowItWorks c={buying?.featured} signUp={signUp} />

      <section className="sx-plans hx-plans" id="pricing">
        <h2 className="sx-section-title">Pricing</h2>
        <div className="sx-plans__grid">
          <div className="sx-plan">
            <div className="sx-plan__name">Free</div>
            <div className="sx-plan__price">$0</div>
            <p className="sx-plan__desc">What an account adds to this site:</p>
            <ul className="sx-plan__list">
              <li>Seli's plain-English read on every stock and person</li>
              <li>Cluster, first-buy and reversal flags, and track records</li>
              <li>Follow 3 stocks or people, with a weekly email on what they did</li>
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
              <li>Follow as many stocks and people as you like</li>
              <li>Same-day email alerts and a daily digest</li>
              <li>Full history{since ? `, back to ${since}` : ''}</li>
              <li>The full leaderboard, 2 and 5 year views</li>
              <li>Link your brokerage to follow what you hold</li>
            </ul>
            <button className="sx-btn sx-btn--accent" onClick={goPro}>Go Pro</button>
          </div>
          <div className="sx-plan">
            <div className="sx-plan__name">Dataset</div>
            <div className="sx-plan__price">$39.99<span> one time</span></div>
            <p className="sx-plan__desc">For your own analysis, no subscription:</p>
            <ul className="sx-plan__list">
              <li>Every corporate insider (Form 4) trade{since ? ` since ${since}` : ''}</li>
              <li>CSV, one file per year</li>
              <li>Open-market trades marked, so you can filter to them</li>
            </ul>
            <a className="sx-btn" href="/data-download">See the dataset</a>
          </div>
        </div>
      </section>

      <p className="sx-note sx-note--center hx-fine">Seli shows what was filed. It isn't investment advice. <a href="/about" className="sx-link">How the data and scores work</a></p>
    </div>
  );
}

// ── /trades ─────────────────────────────────────────────────────────────────
// Every open-market insider and Congress trade, with filters. Signed out it's
// the raw feed. Signed in, the same table adds Seli's signals: tags on each
// trade and filters for them (the Worker's explore() works them out, with the
// same rules as the stock pages).
// Filters, sort and page live in the URL, so a view can be shared or reloaded.
const TRADE_PERIODS = [{ value: 7, label: '7D' }, { value: 30, label: '30D' }, { value: 90, label: '90D' }, { value: 365, label: '1Y' }];
// Pro sees further back (the Worker caps everyone else at 12 months anyway).
const PRO_PERIODS = [...TRADE_PERIODS, { value: 730, label: '2Y' }, { value: 1825, label: '5Y' }];
const TRADE_ROWS = 50;    // rows per page on screen
const WORKER_ROWS = 200;  // rows the Worker sends per request (4 screen pages)
const TRADE_SORTS = { date: 'transaction_date', ticker: 'ticker', person: 'insider_name', shares: 'shares', price: 'price_per_share', value: 'value', stake: 'pct_owned_change' };
const TRADE_DEFAULTS = { view: 'trades', days: 30, side: 'all', source: 'all', min: '0', people: '0', mine: '0', kind: 'all', ssort: 'strength', sort: 'date', dir: 'desc', q: '', page: 0 };
const SIGNED_IN_DEFAULTS = { ...TRADE_DEFAULTS, view: 'signals' };
const REV_TIP = {
  buy: 'Reversal: bought after 2+ sales and no buys of this stock in the previous 2 years',
  sell: 'Reversal: sold (not a planned sale) after 2+ buys and no sales of this stock in the previous 2 years',
};
// The tags on one trade, strongest first.
function sigTags(r) {
  const s = r.sig;
  if (!s) return [];
  const out = [];
  if (s.brk) out.push({ k: 'brk', text: s.brk, tone: 'accent', tip: "This insider hadn't bought this stock on the open market in that long" });
  if (s.rev) out.push({ k: 'rev', text: 'Reversal', tone: 'rev', tip: REV_TIP[s.rev] });
  if (s.routine) out.push({ k: 'pl', text: 'Planned', tone: '', tip: 'Filed under a pre-scheduled 10b5-1 trading plan' });
  return out;
}
const SigTags = ({ r }) => {
  const t = sigTags(r);
  return t.length ? <span className="hx-sigs">{t.map(x => <span key={x.k} className={`hx-sig${x.tone ? ` hx-sig--${x.tone}` : ''}`} title={x.tip}>{x.text}</span>)}</span> : null;
};
const isCongressRow = r => r.relationship === 'congress' || String(r.transaction_code || '').startsWith('CONGRESS');
const dayGap = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// defs: TRADE_DEFAULTS, or SIGNED_IN_DEFAULTS (signed-in users start on Signals).
function readTradeParams(defs = TRADE_DEFAULTS) {
  const p = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const pick = (k, ok) => (ok(p.get(k)) ? p.get(k) : defs[k]);
  return {
    days: [7, 30, 90, 365, 730, 1825].includes(Number(p.get('days'))) ? Number(p.get('days')) : TRADE_DEFAULTS.days,
    side: pick('side', v => ['buy', 'sell'].includes(v)),
    source: pick('source', v => ['corporate', 'political'].includes(v)),
    min: pick('min', v => ['100000', '1000000'].includes(v)),
    people: pick('people', v => v === '1'),
    mine: pick('mine', v => v === '1'),
    view: pick('view', v => v === 'signals' || v === 'trades'),
    kind: pick('kind', v => ['cluster', 'first', 'rev'].includes(v)),
    ssort: pick('ssort', v => ['date', 'total', 'people', 'trades'].includes(v)),
    sort: pick('sort', v => v in TRADE_SORTS),
    dir: pick('dir', v => v === 'asc'),
    q: (p.get('q') || '').slice(0, 40),
    page: Math.max(0, Math.min(39, Number(p.get('page')) || 0)),
  };
}

// signedIn: the same page inside the app. It reads /api/explore instead (Pro
// gets more history), adds "My watchlist", and drops the sign-up pitch.
export function TradesPage({ watchlist: wlProp, signedIn = false }) {
  const clerk = useClerk();
  const publicWl = usePublicWatchlist();
  const watchlist = wlProp || publicWl;
  const pro = signedIn && !!watchlist.pro;
  const watchCount = (watchlist.tickers?.length || 0) + (watchlist.insiders?.length || 0);
  const signUp = () => openSignUp(clerk, { kind: 'signup' });
  const narrow = useNarrow();
  const defs = signedIn ? SIGNED_IN_DEFAULTS : TRADE_DEFAULTS;
  const [f, setF] = useState(() => readTradeParams(defs));
  const [text, setText] = useState(f.q);
  const [total, setTotal] = useState(null);
  useEffect(() => { document.title = 'Insider and Congress Trades, Last 12 Months | Seli'; }, []);
  // Any filter change goes back to page 1; the page number only changes itself.
  const set = patch => setF(prev => ({ ...prev, ...patch, page: 'page' in patch ? patch.page : 0 }));
  // Search waits for a pause in typing.
  useEffect(() => { const t = setTimeout(() => { const q = text.trim().length >= 2 ? text.trim() : ''; if (q !== f.q) set({ q }); }, 350); return () => clearTimeout(t); }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  // Mirror the view in the URL (replaceState: filtering shouldn't flood the back button).
  useEffect(() => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v !== defs[k] && v !== '') u.set(k, String(v));
    const next = `/trades${u.toString() ? `?${u}` : ''}`;
    if (window.location.pathname + window.location.search !== next) window.history.replaceState({}, '', next);
  }, [f]);

  const workerPage = Math.floor(f.page * TRADE_ROWS / WORKER_ROWS);
  const days = !pro && f.days > 365 ? 365 : f.days;
  const params = new URLSearchParams({ days: String(days) });
  if (signedIn) {
    // /api/explore takes the raw options; the public route maps them itself.
    params.set('om', '1');
    params.set('sort', f.sort === 'value' ? 'signed_value' : TRADE_SORTS[f.sort]);
    params.set('min', f.min !== '0' ? f.min : '1000');
  } else {
    params.set('sort', TRADE_SORTS[f.sort]);
    if (f.min !== '0') params.set('min', f.min);
  }
  if (f.dir === 'asc') params.set('dir', 'asc');
  if (f.side !== 'all') params.set('type', f.side);
  if (f.source !== 'all') params.set('source', f.source);
  if (f.people === '1') params.set('people', '1');
  if (f.q) params.set('q', f.q);
  if (signedIn) params.set('sig', '1');
  if (signedIn && f.mine === '1') {
    params.set('mine', '1');
    params.set('mt', (watchlist.tickers || []).join(','));
    params.set('mi', (watchlist.insiders || []).join('|'));
  }
  if (workerPage) params.set('page', String(workerPage));
  const waitForList = signedIn && f.mine === '1' && !watchlist.ready;
  const signalsView = f.view === 'signals';
  const { data: d, error, reload, loading } = useApi(waitForList || signalsView ? null : `/${signedIn ? 'api/explore' : 'public/trades'}?${params}`);
  // The total only comes with the first Worker page; keep it while paging.
  const filterKey = JSON.stringify({ ...f, page: 0 });
  useEffect(() => { setTotal(null); }, [filterKey]);
  useEffect(() => { if (d?.total != null) setTotal(d.total); }, [d]);
  const start = (f.page * TRADE_ROWS) % WORKER_ROWS;
  const rows = (d?.rows || []).slice(start, start + TRADE_ROWS);
  const pages = total != null ? Math.max(1, Math.min(40, Math.ceil(total / TRADE_ROWS))) : null;
  const goPage = n => { set({ page: n }); window.scrollTo?.({ top: 0, behavior: 'smooth' }); document.querySelector('.ws-main')?.scrollTo?.({ top: 0, behavior: 'smooth' }); };

  const sortBy = key => set(f.sort === key ? { dir: f.dir === 'desc' ? 'asc' : 'desc' } : { sort: key, dir: key === 'ticker' || key === 'person' ? 'asc' : 'desc' });
  const Th = ({ k, children, right, className = '' }) => {
    const on = f.sort === k;
    return (
      <th className={`${right ? 'sx-r ' : ''}${className}`} aria-sort={on ? (f.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className={`hx-th${on ? ' hx-th--on' : ''}`} onClick={() => sortBy(k)}>
          {children}<span className="hx-th__arrow" aria-hidden="true">{on ? (f.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
        </button>
      </th>
    );
  };
  const who = r => ({ raw: r.insider_name, name: prettyPerson(r.insider_name, isCongressRow(r)), role: roleFromTitle(r.insider_title, isCongressRow(r) ? 'congress' : r.relationship), congress: isCongressRow(r) });
  const dateOf = r => String(r.transaction_date || r.filing_date || '').slice(0, 10);
  // "Filed Nov 3" under the date when it was reported more than 3 days after the trade.
  const filedNote = r => {
    const t = dateOf(r), fd = String(r.filing_date || '').slice(0, 10);
    return t && fd && dayGap(t, fd) > 3 ? `filed ${shortDate(fd)}` : null;
  };
  // How much of their holding changed. Filings report the size, not the
  // direction, so the sign comes from the trade: sales shrink a stake.
  const stake = r => (r.pct_owned_change == null || isCongressRow(r) ? null : Math.abs(Number(r.pct_owned_change)) * (r.transaction_type === 'sell' ? -1 : 1));
  const stakeText = v => (v == null ? '—' : Math.abs(v) < 0.5 ? '<1%' : `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v))}%`);
  const sec = r => secFilingUrl(r.accession_number, r.cik_issuer);

  return (
    <div className="sx-page hx-trades">
      <header className="sx-head sx-head--page">
        <div className="sx-head__main">
          <h1 className="sx-head__title">Trades</h1>
          <p className="sx-head__desc">{signalsView
            ? 'Stocks where insiders are doing something unusual: several of them buying at once, a first buy in years, or a switch from selling to buying (or back). Strongest first.'
            : 'Every open-market insider and Congress stock trade from the last 12 months, straight from the filings. Grants, option exercises and tax withholding are left out.'}</p>
          <Freshness />
        </div>
      </header>

      <div className="hx-viewtabs" role="tablist" aria-label="View">
        {[['trades', 'All trades', 'list'], ['signals', 'Signals', 'trend']].map(([v, label, icon]) => (
          <button key={v} type="button" role="tab" aria-selected={f.view === v} className={`hx-viewtab${f.view === v ? ' hx-viewtab--on' : ''}`}
            onClick={() => set({ view: v, ...(v === 'signals' && f.side === 'all' ? { side: 'buy' } : {}) })}>
            <Icon name={icon} size={14} />{label}
          </button>
        ))}
      </div>

      <div className="hx-filters">
        <div className="hx-filters__row">
          <Segmented size="sm" value={f.days} onChange={v => set({ days: v })} options={pro ? PRO_PERIODS : TRADE_PERIODS} />
          {signalsView ? (
            <>
              <Segmented size="sm" value={f.side === 'sell' ? 'sell' : 'buy'} onChange={v => set({ side: v, kind: v === 'sell' && !['all', 'cluster'].includes(f.kind) ? 'all' : f.kind })} options={[{ value: 'buy', label: 'Buying' }, { value: 'sell', label: 'Selling' }]} />
              {signedIn && (
                <select className="hx-select" value={f.kind} onChange={e => set({ kind: e.target.value })} aria-label="Kind of signal">
                  {SIGNAL_KINDS.filter(k => f.side !== 'sell' || ['all', 'cluster'].includes(k.value)).map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
              )}
            </>
          ) : (
            <Segmented size="sm" value={f.side} onChange={v => set({ side: v })} options={[{ value: 'all', label: 'All' }, { value: 'buy', label: 'Buys' }, { value: 'sell', label: 'Sales' }]} />
          )}
          {!signalsView && <Segmented size="sm" value={f.source} onChange={v => set({ source: v })} options={[{ value: 'all', label: 'Everyone' }, { value: 'corporate', label: 'Insiders' }, { value: 'political', label: 'Congress' }]} />}
          <select className="hx-select" value={f.min} onChange={e => set({ min: e.target.value })} aria-label={signalsView ? 'Smallest total' : 'Smallest trade'}>
            <option value="0">Any size</option>
            <option value="100000">$100K+</option>
            <option value="1000000">$1M+</option>
          </select>
          {!signalsView && (
            <button type="button" className={`hx-toggle${f.people === '1' ? ' hx-toggle--on' : ''}`} aria-pressed={f.people === '1'}
              onClick={() => set({ people: f.people === '1' ? '0' : '1' })} title="Leave out funds and companies that file as big shareholders">
              <span className="hx-toggle__box" aria-hidden="true">{f.people === '1' && <Icon name="check" size={11} />}</span>Hide funds
            </button>
          )}
        </div>
        <div className="sx-search__field hx-filters__q">
          <span className="sx-search__icon"><Icon name="search" size={14} /></span>
          <input className="sx-search__input" type="search" value={text} onChange={e => setText(e.target.value)} placeholder="Ticker, company, person" aria-label="Filter by ticker, company or person" />
        </div>
      </div>

      {signalsView ? <SignalsView f={f} set={set} signedIn={signedIn} watchlist={watchlist} narrow={narrow} signUp={signUp} /> : (
      <Card pad={false}>
        <div className="hx-trades__bar">
          <span className="sx-muted sx-small" role="status">
            {total != null ? `${total.toLocaleString('en-US')} ${total === 1 ? 'trade' : 'trades'}` : loading ? 'Loading…' : ''}
            {d?.from ? ` · ${shortDate(d.from, { year: true })} to ${shortDate(d.to, { year: true })}` : ''}
          </span>
          <span className="hx-trades__tools">
          {signedIn && (
            <button type="button" role="checkbox" aria-checked={f.mine === '1'} className={`hx-toggle hx-toggle--sm${f.mine === '1' ? ' hx-toggle--on' : ''}`}
              disabled={!watchCount && f.mine !== '1'} title={watchCount ? 'Only trades in the stocks and by the people you follow' : 'Follow a stock or person first (the eye on any row)'}
              onClick={() => set({ mine: f.mine === '1' ? '0' : '1' })}>
              <span className="hx-toggle__box">{f.mine === '1' && <Icon name="check" size={10} />}</span>Only my watchlist{watchCount ? ` (${watchCount})` : ''}
            </button>
          )}
            {narrow && (
            <select className="hx-select" value={`${f.sort}:${f.dir}`} aria-label="Sort"
              onChange={e => { const [sort, dir] = e.target.value.split(':'); set({ sort, dir }); }}>
              <option value="date:desc">Newest first</option>
              <option value="date:asc">Oldest first</option>
              <option value="value:desc">Biggest buys first</option>
              <option value="value:asc">Biggest sales first</option>
              <option value="stake:desc">Biggest stake change</option>
              <option value="ticker:asc">Ticker A to Z</option>
            </select>
          )}
          </span>
        </div>
        {error && !d && <div className="sx-card__body"><ErrorNote message={error} onRetry={reload} /></div>}
        {!d && !error && <div className="sx-card__body"><Skeleton lines={10} /></div>}
        {d && !rows.length && <div className="sx-empty"><div className="sx-empty__body">{f.mine === '1' ? 'No trades in your watchlist match these filters.' : 'No trades match these filters.'}</div></div>}
        {d && rows.length > 0 && (narrow ? (
          <ul className={`sx-trows${loading ? ' sx-dim' : ''}`}>
            {rows.map((r, i) => { const p = who(r); const note = filedNote(r); const st = stake(r); const url = sec(r); return (
              <li key={`${f.page}:${i}`} className="sx-trow">
                {r.ticker ? <StockLink ticker={r.ticker} /> : <span className="sx-trow__asset">Other</span>}
                <div className="sx-trow__main">
                  <div className="sx-trow__title"><InsiderLink raw={p.raw}>{p.name}</InsiderLink></div>
                  <div className="sx-trow__sub">{shortDate(dateOf(r))}{note ? ` (${note})` : ''} · {p.congress ? 'Congress' : roleText(p.role)}</div>
                  <SigTags r={r} />
                </div>
                <div className="sx-trow__end">
                  <span className={`sx-trow__amt ${r.transaction_type === 'buy' ? 'sx-up' : 'sx-down'}`}>{amount(r.value, p.congress)}</span>
                  <span className="sx-trow__meta">
                    <TypeBadge type={r.transaction_type} />
                    {st != null && <span className="hx-stake">{stakeText(st)}</span>}
                    {url && <a href={url} target="_blank" rel="noreferrer" className="sx-sec" aria-label="Open the SEC filing"><Icon name="external" size={11} /></a>}
                    {r.ticker && <FollowButton watchlist={watchlist} kind="stock" id={r.ticker} />}
                  </span>
                </div>
              </li>
            ); })}
          </ul>
        ) : (
          <div className={`sx-table-wrap${loading ? ' sx-dim' : ''}`}>
            <table className="sx-table hx-trades__table">
              <thead>
                <tr>
                  <Th k="date">Date</Th>
                  <Th k="ticker">Stock</Th>
                  <Th k="person">Who</Th>
                  <th>Type</th>
                  <Th k="shares" right>Shares</Th>
                  <Th k="price" right>Price</Th>
                  <Th k="value" right><span title="Sorted with buys above zero and sales below it: one end is the biggest buys, the other the biggest sales">Value</span></Th>
                  <Th k="stake" right>Stake</Th>
                  <th aria-label="Filing and follow" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => { const p = who(r); const note = filedNote(r); const st = stake(r); const url = sec(r); return (
                  <tr key={`${f.page}:${i}`}>
                    <td className="sx-nowrap">{shortDate(dateOf(r), { year: f.days > 90 })}{note && <span className="hx-filed">{note}</span>}</td>
                    <td className="hx-trades__stock">{r.ticker ? <StockLink ticker={r.ticker} /> : null}<span className="hx-trades__co">{prettyCompany(r.company_name) || ''}</span></td>
                    <td className="sx-table__who"><InsiderLink raw={p.raw}>{p.name}</InsiderLink><span className="sx-table__role"><RoleTag role={p.role} congress={p.congress} title={r.insider_title} name={p.raw} /></span></td>
                    <td className="hx-trades__type"><TypeBadge type={r.transaction_type} /><SigTags r={r} /></td>
                    <td className="sx-r sx-mono">{p.congress || !r.shares ? '—' : shares(r.shares)}</td>
                    <td className="sx-r sx-mono">{p.congress || !r.price_per_share ? '—' : price(r.price_per_share)}</td>
                    <td className={`sx-r sx-mono sx-strong ${r.transaction_type === 'buy' ? 'sx-up' : 'sx-down'}`}>{amount(r.value, p.congress)}</td>
                    <td className="sx-r sx-mono" title="How much of their holding this trade added or sold, from the filing">{stakeText(st)}</td>
                    <td className="sx-r hx-trades__sec">{url && <a href={url} target="_blank" rel="noreferrer" className="sx-sec" title="Open the SEC filing" aria-label="Open the SEC filing"><Icon name="external" size={12} /></a>}{r.ticker && <FollowButton watchlist={watchlist} kind="stock" id={r.ticker} />}</td>
                  </tr>
                ); })}
              </tbody>
            </table>
          </div>
        ))}
        {pages != null && pages > 1 && (
          <nav className="hx-pager" aria-label="Pages">
            <button className="sx-btn sx-btn--ghost sx-btn--sm" disabled={f.page === 0} onClick={() => goPage(f.page - 1)} aria-label="Previous page"><Icon name="arrow" size={12} style={{ transform: 'rotate(180deg)' }} /></button>
            <span className="sx-small">Page <b>{f.page + 1}</b> of {pages.toLocaleString('en-US')}{total > 40 * TRADE_ROWS ? '+' : ''}</span>
            <button className="sx-btn sx-btn--ghost sx-btn--sm" disabled={f.page >= pages - 1} onClick={() => goPage(f.page + 1)} aria-label="Next page"><Icon name="arrow" size={12} /></button>
          </nav>
        )}
      </Card>
      )}

      {signalsView ? null : signedIn ? (
        <p className="sx-note sx-note--center">Want trades grouped by stock and ranked? <a href="/trades?view=signals" className="sx-link" onClick={e => { e.preventDefault(); set({ view: 'signals', side: 'buy' }); }}>See signals</a></p>
      ) : (
      <div className="sx-gate sx-gate--signup">
        <span className="sx-gate__text"><Icon name="lock" size={13} /> This is the raw feed. A free account adds Seli's reads on top: first buys in years, reversals, planned sales and track records.</span>
        <button className="sx-btn sx-btn--accent sx-btn--sm" onClick={signUp}>Create free account</button>
      </div>
      )}
      <p className="sx-note sx-note--center"><a href="/insider-buying" className="sx-link" onClick={navClick('/insider-buying')}>Insider buying this week</a> · <a href="/congress" className="sx-link" onClick={navClick('/congress')}>Congress trades</a> · <a href="/stocks" className="sx-link" onClick={navClick('/stocks')}>Every stock A to Z</a></p>
    </div>
  );
}
