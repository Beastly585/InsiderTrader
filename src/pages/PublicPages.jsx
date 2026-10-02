// src/pages/PublicPages.jsx
// What signed-out visitors (and Google) see on stock, insider, Congress and
// insider-buying URLs: the real pages, read-only, with the free plan's 12
// months of data. Anything that needs an account (watching, alerts, Pro)
// opens sign-up instead. Signed-in users get the same URLs inside the app.
import React, { useEffect, useMemo, useState } from 'react';
import { SignInButton, useClerk } from '@clerk/clerk-react';
import { useApi, useDataSinceYear } from '../lib/api.js';
import { go, StockLink, InsiderLink } from '../lib/nav.jsx';
import { plural, shortDate, money, congressRange } from '../lib/text.js';
import { Card, Skeleton, ErrorNote, Icon } from '../components/ui.jsx';
import { SearchBox, SearchOverlay } from '../components/Search.jsx';
import { openSignUp } from '../lib/intent.js';
import { TradeTable } from './StockPage.jsx';
import { MarketSections } from './HomeFeed.jsx';

const PUBLIC_LINKS = [
  { id: 'insiderBuying', label: 'Insider buying', short: 'Buying', path: '/insider-buying' },
  { id: 'congress', label: 'Congress trades', short: 'Congress', path: '/congress' },
  { id: 'leaderboard', label: 'Leaderboard', short: 'Leaders', path: '/leaderboard' },
];
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

export function PublicShell({ page, logoSrc, isMobile, children }) {
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
                <a key={n.id} href={n.path} aria-current={page === n.id ? 'page' : undefined}
                  className={`sx-nav__link${page === n.id ? ' sx-nav__link--on' : ''}`} onClick={navClick(n.path)}>{n.label}</a>
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
            <a key={n.id} href={n.path} className={page === n.id ? 'is-on' : ''} onClick={navClick(n.path)}>{n.short || n.label}</a>
          ))}
        </nav>
      )}
      <main className="ws-main sx-pub__main">
        <div className="sx-pub__content">{children}</div>
        <SignupBand onSignUp={signUp} />
        <PopularStocks />
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
      <p className="sx-pub__tickers">{POPULAR.map(t => <StockLink key={t} ticker={t} />)}</p>
    </section>
  );
}

const FOOT_LINKS = [['Terms', '/terms'], ['Privacy', '/privacy'], ['Cookies', '/cookies'], ['Help', '/help']];

function PublicFooter({ logoSrc }) {
  return (
    <footer className="sx-pub__foot">
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
          <Card title="Latest disclosures" sub="Stock trades, most recent first" pad={false}>
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

// ── / for signed-out visitors ────────────────────────────────────────────────
// The front door: what Seli is, a search box, real data from this week, and
// pricing. Same look as every other public page, no mock screenshots.
export function PublicHome() {
  const clerk = useClerk();
  const since = useDataSinceYear();
  const { data: buying } = useApi('/public/insider-buying');
  const { data: congress } = useApi('/public/congress');
  const { data: leaders } = useApi('/public/leaderboard?years=1&source=all');
  useEffect(() => { document.title = 'Seli: Insider Trading & Congress Stock Trades Tracker'; }, []);
  const signUp = () => openSignUp(clerk, { kind: 'signup' });
  const goPro = () => openSignUp(clerk, { kind: 'upgrade' });
  const clusters = [buying?.featured, ...(buying?.more || [])].filter(Boolean).slice(0, 9);

  return (
    <div className="sx-page sx-page--feed sx-home">
      <section className="sx-hero">
        <p className="sx-hero__eyebrow">Insider trading &amp; Congress stock tracker</p>
        <h1 className="sx-hero__title">See what executives and members of Congress are buying with their own money.</h1>
        <p className="sx-hero__sub">Every SEC Form 4 and STOCK Act filing, explained in plain English. Look up any stock or person, and get an email when someone trades what you own.</p>
        <div className="sx-hero__search"><SearchBox variant="inline" placeholder="Search a ticker, company, executive or member of Congress" /></div>
        <div className="sx-hero__cta">
          <button className="sx-btn sx-btn--accent" onClick={signUp}>Get started free</button>
          <span className="sx-muted sx-small">No card needed. Data from SEC EDGAR and congressional disclosures.</span>
        </div>
      </section>

      <div className="sx-feed-cols">
        <Card title="Insider buying this week" sub="Open-market purchases, biggest first" pad={false}
          action={<a href="/insider-buying" className="sx-link" onClick={navClick('/insider-buying')}>See all <Icon name="arrow" size={12} /></a>}>
          {!buying ? <div className="sx-card__body"><Skeleton lines={5} /></div> : (
            <ul className="sx-rows">
              {clusters.map(c => (
                <li key={c.ticker} className="sx-row">
                  <StockLink ticker={c.ticker} />
                  <div className="sx-row__main">
                    <div className="sx-row__title">{c.company}</div>
                    <div className="sx-row__sub">
                      <InsiderLink raw={c.buyers[0].raw}>{c.buyers[0].name}</InsiderLink> ({c.buyers[0].role}){c.n_insiders > 1 ? ` + ${plural(c.n_insiders - 1, 'other')}` : ''}
                    </div>
                  </div>
                  <span className="sx-row__amt sx-up">{money(c.total)}</span>
                </li>
              ))}
              {!clusters.length && <li className="sx-row sx-muted">No notable insider buying filed yet this week.</li>}
            </ul>
          )}
        </Card>
        <div className="sx-feed-stack">
          <Card title="Latest from Congress" sub="STOCK Act disclosures, most recent trades" pad={false}
            action={<a href="/congress" className="sx-link" onClick={navClick('/congress')}>See all <Icon name="arrow" size={12} /></a>}>
            {!congress ? <div className="sx-card__body"><Skeleton lines={4} /></div> : (
              <ul className="sx-rows">
                {(congress.recent || []).slice(0, 5).map((t, i) => (
                  <li key={`${t.acc}:${i}`} className="sx-row">
                    <StockLink ticker={t.ticker} />
                    <div className="sx-row__main">
                      <div className="sx-row__title"><InsiderLink raw={t.raw}>{t.name}</InsiderLink> {t.type === 'buy' ? 'bought' : 'sold'}</div>
                      <div className="sx-row__sub">{congressRange(t.value)} · {shortDate(t.date)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Best insider track records" sub="Buys that beat the S&P 500, last 12 months" pad={false}
            action={<a href="/leaderboard" className="sx-link" onClick={navClick('/leaderboard')}>Leaderboard <Icon name="arrow" size={12} /></a>}>
            {!leaders ? <div className="sx-card__body"><Skeleton lines={4} /></div> : (
              <ul className="sx-rows">
                {(leaders.ranked || []).slice(0, 5).map(r => (
                  <li key={r.raw} className="sx-row">
                    <div className="sx-row__main">
                      <div className="sx-row__title"><InsiderLink raw={r.raw}>{r.name}</InsiderLink></div>
                      <div className="sx-row__sub">{r.role || r.title}{r.tickers?.[0] ? <> · <StockLink ticker={r.tickers[0]} plain className="sx-lb__tk" /></> : null} · {plural(r.priced || r.om_buys || 0, 'buy')}</div>
                    </div>
                    {r.excess != null && <span className={`sx-row__amt ${r.excess >= 0 ? 'sx-up' : 'sx-down'}`}>{r.excess >= 0 ? '+' : ''}{Math.round(r.excess)} pts</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <section className="sx-how">
        <h2 className="sx-section-title">How Seli works</h2>
        <ol className="sx-how__steps">
          <li><b>Every filing, same day.</b> Executives, directors, big shareholders and members of Congress have to report their trades. Seli reads every report as it's published.</li>
          <li><b>In plain English.</b> Each stock and person gets a page that says what they did, how big it was, and whether it's unusual: a first buy in years, several insiders at once, a big stake increase.</li>
          <li><b>Emailed to you.</b> Watch the stocks you own and the people you trust. Seli emails you when they trade.</li>
        </ol>
      </section>

      <section className="sx-plans" id="pricing">
        <h2 className="sx-section-title">Pricing</h2>
        <div className="sx-plans__grid">
          <div className="sx-plan">
            <div className="sx-plan__name">Free</div>
            <div className="sx-plan__price">$0</div>
            <p className="sx-plan__desc">Everything on this site, plus an account:</p>
            <ul className="sx-plan__list">
              <li>Watch 3 stocks or people</li>
              <li>A weekly email on what they did</li>
              <li>Your own Home feed and watchlist</li>
              <li>12 months of trades on every page</li>
            </ul>
            <button className="sx-btn" onClick={signUp}>Get started free</button>
          </div>
          <div className="sx-plan sx-plan--pro">
            <div className="sx-plan__name">Pro</div>
            <div className="sx-plan__price">$6.99<span>/month</span></div>
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
        <p className="sx-note sx-note--center">Seli shows what was filed. It isn't investment advice. <a href="/about" className="sx-link">How the data and scores work</a></p>
      </section>
    </div>
  );
}
