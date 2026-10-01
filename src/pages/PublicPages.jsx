// src/pages/PublicPages.jsx
// What signed-out visitors (and Google) see on stock, insider, Congress and
// insider-buying URLs: the real pages, read-only, with the free plan's 12
// months of data. Anything that needs an account (watching, alerts, Pro)
// opens sign-up instead. Signed-in users get the same URLs inside the app.
import React, { useEffect, useMemo, useState } from 'react';
import { SignInButton, useClerk } from '@clerk/clerk-react';
import { useApi } from '../lib/api.js';
import { go, StockLink, InsiderLink } from '../lib/nav.jsx';
import { plural, shortDate } from '../lib/text.js';
import { Card, Skeleton, ErrorNote, Icon } from '../components/ui.jsx';
import { SearchBox, SearchOverlay } from '../components/Search.jsx';
import { TradeTable } from './StockPage.jsx';
import { MarketSections } from './HomeFeed.jsx';

const PUBLIC_LINKS = [
  { id: 'insiderBuying', label: 'Insider buying', path: '/insider-buying' },
  { id: 'congress', label: 'Congress trades', path: '/congress' },
];
const POPULAR = ['NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'META', 'GOOGL', 'JPM', 'PLTR', 'AMD'];

const navClick = path => e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(path); };

// Watch buttons and Pro gates on public pages: every action opens sign-up.
export function usePublicWatchlist() {
  const clerk = useClerk();
  return useMemo(() => {
    const signUp = () => clerk.openSignUp?.({ afterSignUpUrl: window.location.pathname, afterSignInUrl: window.location.pathname });
    return {
      tickers: [], insiders: [], pro: false, freeLimit: 3, freeSlotsLeft: 3, synced: 0, publicMode: true,
      has: () => false, hasTicker: () => false, hasInsider: () => false,
      toggle: signUp, toggleTicker: signUp, toggleInsider: signUp,
      alertsOn: () => false, setAlerts: signUp, showUpgrade: null, setShowUpgrade: () => { }, signUp,
    };
  }, [clerk]);
}

export function PublicShell({ page, logoSrc, isMobile, children }) {
  const clerk = useClerk();
  const [searchOpen, setSearchOpen] = useState(false);
  const signUp = () => clerk.openSignUp?.({ afterSignUpUrl: window.location.pathname });
  const logo = (
    <a className="sx-nav__logo" href="/" onClick={navClick('/')} aria-label="Seli home">
      {logoSrc && <img src={logoSrc} alt="" />}<span>Seli</span>
    </a>
  );
  const actions = (
    <div className="sx-nav__right sx-pub__actions">
      {isMobile && <button className="sx-nav__icon" onClick={() => setSearchOpen(true)} aria-label="Search stocks and insiders"><Icon name="search" size={18} /></button>}
      <SignInButton mode="modal"><button className="sx-btn sx-btn--ghost sx-btn--sm">Sign in</button></SignInButton>
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
                <a key={n.id} href={n.path} aria-current={page === n.id ? 'page' : undefined}
                  className={`sx-nav__link${page === n.id ? ' sx-nav__link--on' : ''}`} onClick={navClick(n.path)}>{n.label}</a>
              ))}
            </nav>
            <div className="sx-nav__search"><SearchBox hotkey /></div>
          </div>
          {actions}
        </header>
      )}
      {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} />}
      {isMobile && (
        <nav className="sx-pub__tabs" aria-label="Browse">
          {PUBLIC_LINKS.map(n => (
            <a key={n.id} href={n.path} className={page === n.id ? 'is-on' : ''} onClick={navClick(n.path)}>{n.label}</a>
          ))}
        </nav>
      )}
      <main className="ws-main">
        {children}
        <SignupBand onSignUp={signUp} />
        <PublicFooter />
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

function PublicFooter() {
  return (
    <footer className="sx-pub__foot">
      <div className="sx-pub__foot-cols">
        <div>
          <h3>Browse</h3>
          <a href="/insider-buying" onClick={navClick('/insider-buying')}>Insider buying this week</a>
          <a href="/congress" onClick={navClick('/congress')}>Congress stock trades</a>
          <a href="/data-download">Download the dataset</a>
        </div>
        <div>
          <h3>Popular stocks</h3>
          <p className="sx-pub__tickers">{POPULAR.map(t => <StockLink key={t} ticker={t} />)}</p>
        </div>
        <div>
          <h3>Seli</h3>
          <a href="/about">About the data</a>
          <a href="/help">Help</a>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
        </div>
      </div>
      <p className="sx-pub__fine">Data from SEC EDGAR Form 4 filings and congressional STOCK Act disclosures. Not financial advice.</p>
    </footer>
  );
}

// ── /congress ────────────────────────────────────────────────────────────────
export function CongressPage() {
  const { data: d, error, reload } = useApi('/public/congress');
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { document.title = 'Congress Stock Trades Tracker: Latest STOCK Act Disclosures | Seli'; }, []);
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
          <Card title="Latest disclosures" sub="Newest filings first" pad={false}>
            <TradeTable trades={(d.recent || []).slice(0, 30)} showTicker />
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
  useEffect(() => { document.title = 'Insider Buying This Week: Latest CEO & Director Stock Purchases | Seli'; }, []);
  return (
    <div className="sx-page sx-page--feed">
      <header className="sx-head sx-head--page">
        <div className="sx-head__main">
          <h1 className="sx-head__title">Insider buying this week</h1>
          <p className="sx-head__desc">Executives and directors buying their own company's stock with their own money, from SEC Form 4 filings in the last 7 days. Grants and option exercises are left out.</p>
        </div>
      </header>
      {error && !d && <ErrorNote message={error} onRetry={reload} />}
      {!d && !error && <><Card><Skeleton lines={4} /></Card><Card><Skeleton lines={6} /></Card></>}
      {d && <MarketSections d={d} watchlist={watchlist} />}
    </div>
  );
}
