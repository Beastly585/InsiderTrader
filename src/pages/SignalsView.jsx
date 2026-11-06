// src/pages/SignalsView.jsx — the "Signals" view of /trades.
// One row per signal: a stock where company insiders traded close together
// and at least one of these happened (worker/lib/data.js signals() has the
// exact rules):
//   Buying:  2+ people bought, someone's first buy in 3+ years, or a reversal
//   Selling: a reversal sale (not a planned sale)
// Strongest first, using the same score that picks the home page's featured
// buys. Rows stay short (two reasons at most) and lead to the stock page,
// where the full story is.
//
// Signed out it reads /public/signals: the top 10, with what's straight from
// the filings (stock, people, amounts, trades) but not why each one is a
// signal or how strong it is.
import React, { useEffect, useState } from 'react';
import { useApi } from '../lib/api.js';
import { StockLink, go, stockPath } from '../lib/nav.jsx';
import { shortDate, money, plural } from '../lib/text.js';
import { Card, Skeleton, ErrorNote, Icon, FollowButton } from '../components/ui.jsx';

const ROWS = 50;
export const SIGNAL_KINDS = [
  { value: 'all', label: 'All signals' },
  { value: 'cluster', label: 'Several insiders' },
  { value: 'first', label: 'First buys' },
  { value: 'rev', label: 'Reversals' },
];
const STRENGTH_TIP = 'How the signal ranks against others, out of 100: how many insiders, their roles, how much they bought, how much their stake grew, and first-time buying.';

const dateRange = r => (r.start === r.end ? shortDate(r.end) : `${shortDate(r.start)} to ${shortDate(r.end)}`);
const stakeText = v => (v == null || v < 1 ? '—' : v >= 100 ? `${(1 + v / 100).toFixed(1).replace(/\.0$/, '')}x` : `+${Math.round(v)}%`);

// Color tells the story at a glance: green strong, amber moderate, gray weak.
// Cut-offs are on the score itself (not this list's spread), so a quiet week
// honestly shows fewer greens.
const TIERS = [[75, 'strong', 'Strong'], [50, 'mid', 'Moderate'], [0, 'weak', 'Weak']];
const tierOf = score => TIERS.find(([min]) => score >= min);
function Strength({ score }) {
  if (score == null) return <span className="sx-muted" title="Selling signals aren't scored. They're ordered by size.">—</span>;
  const on = Math.max(1, Math.ceil(score / 20));
  const [, tone, label] = tierOf(score);
  return (
    <span className={`hx-meter hx-meter--${tone}`} title={`${label}: ${score} of 100. ${STRENGTH_TIP}`} aria-label={`${label} signal, ${score} of 100`}>
      {[1, 2, 3, 4, 5].map(i => <span key={i} className={`hx-meter__bar${i <= on ? ' hx-meter__bar--on' : ''}`} />)}
      <span className="hx-meter__n">{score}</span>
    </span>
  );
}

// The two reasons that matter most. Head counts and stake changes have their
// own columns, so they're left out here; rarer reads (first buy, reversal)
// come before who was buying. The rest are on the stock page.
const SHOW_WHY = 2;
// 3+ people trading together reads as "Cluster", the same bar the blog uses
// (BUY_CLUSTER_N in db/blog_generate.py). It leads, since it's the strongest
// read; two people are left to the Insiders column.
const CLUSTER_N = 3;
function topWhy(r) {
  const why = r.why.filter(w => !/^\d+ insiders (buying|selling)$/.test(w.label) && w.tone !== 'neutral');
  const rank = w => (w.cluster ? -1 : w.tone === 'accent' || w.tone === 'rev' ? 0 : 1);
  if (r.n >= CLUSTER_N) why.push({ label: 'Cluster', tone: r.side === 'sell' ? 'sell' : 'buy', cluster: true, tip: `${r.n} insiders ${r.side === 'sell' ? 'sold' : 'bought'} within 2 weeks of each other` });
  return why.slice().sort((a, b) => rank(a) - rank(b));
}
function Why({ r, locked, signUp }) {
  if (locked) return <button type="button" className="hx-sig hx-sig--lock" onClick={signUp} title="Why it's a signal, and how strong. Free with an account."><Icon name="lock" size={10} /> Why it's a signal</button>;
  const why = topWhy(r);
  const rest = why.slice(SHOW_WHY).map(w => w.label).join(', ');
  return (
    <span className="hx-sigs hx-sigs--row">
      {why.slice(0, SHOW_WHY).map(w => <span key={w.label} title={w.tip} className={`hx-sig hx-sig--${w.tone === 'rev' ? 'rev' : w.tone === 'accent' ? 'accent' : w.tone === 'sell' ? 'sell' : 'buy'}${w.cluster ? ' hx-sig--cluster' : ''}`}>{w.label}</span>)}
      {rest && <span className="hx-sig hx-sig--more" title={rest}>+{why.length - SHOW_WHY}</span>}
    </span>
  );
}

// Everyone in the signal, for the Insiders cell's hover.
const peopleTip = r => r.people.map(x => `${x.name} (${x.role})`).join(', ');

export default function SignalsView({ f, set, signedIn, watchlist, narrow, signUp }) {
  const [screen, setScreen] = useState(0);
  const filterKey = JSON.stringify({ ...f, page: 0 });
  useEffect(() => { setScreen(0); }, [filterKey]);

  const params = new URLSearchParams({ days: String(f.days), side: f.side === 'sell' ? 'sell' : 'buy' });
  if (signedIn) {
    params.set('sort', f.ssort);
    if (f.kind !== 'all') params.set('kind', f.kind);
    if (f.min !== '0') params.set('min', f.min);
    if (f.q) params.set('q', f.q);
    if (f.mine === '1') {
      params.set('mine', '1');
      params.set('mt', (watchlist.tickers || []).join(','));
      params.set('mi', (watchlist.insiders || []).join('|'));
    }
  }
  const waitForList = signedIn && f.mine === '1' && !watchlist.ready;
  const watchCount = (watchlist.tickers?.length || 0) + (watchlist.insiders?.length || 0);
  const { data: d, error, reload, loading } = useApi(waitForList ? null : `/${signedIn ? 'api' : 'public'}/signals?${params}`);
  const locked = !signedIn;
  const all = d?.rows || [];
  const rows = all.slice(screen * ROWS, screen * ROWS + ROWS);
  const screens = Math.max(1, Math.ceil(all.length / ROWS));
  const side = f.side === 'sell' ? 'sell' : 'buy';

  const Th = ({ k, children, right }) => {
    const on = f.ssort === k;
    if (!signedIn) return <th className={right ? 'sx-r' : ''}>{children}</th>;
    return (
      <th className={right ? 'sx-r' : ''} aria-sort={on ? 'descending' : 'none'}>
        <button type="button" className={`hx-th${on ? ' hx-th--on' : ''}`} onClick={() => set({ ssort: k })}>
          {children}<span className="hx-th__arrow" aria-hidden="true">{on ? '↓' : '↕'}</span>
        </button>
      </th>
    );
  };
  // A row opens its stock page, unless the click was on a link or button in it.
  const open = (e, r) => { if (e.target.closest('a,button')) return; if (e.metaKey || e.ctrlKey) { window.open(stockPath(r.ticker), '_blank'); return; } go(stockPath(r.ticker)); };

  return (
    <Card pad={false}>
      <div className="hx-trades__bar">
        <span className="sx-muted sx-small" role="status">
          {d ? `${(d.total ?? all.length).toLocaleString('en-US')} ${side === 'buy' ? 'buying' : 'selling'} ${d.total === 1 ? 'signal' : 'signals'}` : loading ? 'Loading…' : ''}
          {d?.from ? ` · ${shortDate(d.from, { year: true })} to ${shortDate(d.to, { year: true })}` : ''}
          {signedIn && d?.total > all.length ? ` · showing the top ${all.length}` : ''}
        </span>
        <span className="hx-trades__tools">
          {signedIn && (
            <button type="button" role="checkbox" aria-checked={f.mine === '1'} className={`hx-toggle hx-toggle--sm${f.mine === '1' ? ' hx-toggle--on' : ''}`}
              disabled={!watchCount && f.mine !== '1'}
              onClick={() => set({ mine: f.mine === '1' ? '0' : '1' })}>
              <span className="hx-toggle__box">{f.mine === '1' && <Icon name="check" size={10} />}</span>Only my watchlist{watchCount ? ` (${watchCount})` : ''}
            </button>
          )}
          {signedIn && narrow && (
            <select className="hx-select" value={f.ssort} onChange={e => set({ ssort: e.target.value })} aria-label="Sort">
              <option value="strength">Strongest first</option>
              <option value="date">Newest first</option>
              <option value="total">Biggest first</option>
              <option value="people">Most insiders</option>
              <option value="trades">Most trades</option>
            </select>
          )}
        </span>
      </div>

      {error && !d && <div className="sx-card__body"><ErrorNote message={error} onRetry={reload} /></div>}
      {!d && !error && <div className="sx-card__body"><Skeleton lines={8} /></div>}
      {d && !all.length && (
        <div className="sx-empty"><div className="sx-empty__body">
          {f.mine === '1' ? 'No signals in your watchlist for this period.' : 'No signals match these filters. Try a longer period.'}
        </div></div>
      )}

      {d && rows.length > 0 && (narrow ? (
        <ul className={`hx-sigcards${loading ? ' sx-dim' : ''}`}>
          {rows.map(r => (
            <li key={r.id} className="hx-sigcard" onClick={e => open(e, r)}>
              <div className="hx-sigcard__top">
                <span className="hx-sigcard__stock"><StockLink ticker={r.ticker} /><span className="hx-trades__co">{r.company}</span></span>
                {!locked && <Strength score={r.score} />}
              </div>
              <Why r={r} locked={locked} signUp={signUp} />
              <div className="hx-sigcard__facts">
                <span title={peopleTip(r)}>{plural(r.n, side === 'buy' ? 'insider' : 'seller')} · {plural(r.nt, 'trade')}</span>
                <span className={`sx-mono sx-strong ${side === 'buy' ? 'sx-up' : 'sx-down'}`}>{money(r.total)}</span>
                <span className="sx-muted" title={dateRange(r)}>{shortDate(r.end)}</span>
                <span className="hx-sigcard__end"><FollowButton watchlist={watchlist} kind="stock" id={r.ticker} /><span className="hx-sigrow__go" aria-hidden="true"><Icon name="chevron" size={14} /></span></span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className={`sx-table-wrap${loading ? ' sx-dim' : ''}`}>
          <table className="sx-table hx-sigtable">
            <thead>
              <tr>
                <th>Stock</th>
                <Th k="people" right>Insiders</Th>
                <Th k="trades" right>Trades</Th>
                <th>Why it's a signal</th>
                <Th k="total" right>{side === 'buy' ? 'Bought' : 'Sold'}</Th>
                <th className="sx-r">Stake</th>
                <Th k="date">Latest</Th>
                {!locked && <Th k="strength">Strength</Th>}
                <th aria-label="Follow" />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="hx-sigrow" onClick={e => open(e, r)} title={`Open ${r.ticker}`}>
                  <td className="hx-trades__stock"><StockLink ticker={r.ticker} /><span className="hx-trades__co">{r.company}</span></td>
                  <td className="sx-r sx-mono" title={peopleTip(r)}>{r.n}</td>
                  <td className="sx-r sx-mono">{r.nt}</td>
                  <td><Why r={r} locked={locked} signUp={signUp} /></td>
                  <td className={`sx-r sx-mono sx-strong ${side === 'buy' ? 'sx-up' : 'sx-down'}`}>{money(r.total)}</td>
                  <td className="sx-r sx-mono">{side === 'buy' ? stakeText(r.max_pct) : '—'}</td>
                  <td className="sx-nowrap" title={dateRange(r)}>{shortDate(r.end)}</td>
                  {!locked && <td><Strength score={r.score} /></td>}
                  <td className="sx-r sx-nowrap">
                    <FollowButton watchlist={watchlist} kind="stock" id={r.ticker} />
                    <span className="hx-sigrow__go" aria-hidden="true"><Icon name="chevron" size={14} /></span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {signedIn && screens > 1 && (
        <nav className="hx-pager" aria-label="Pages">
          <button type="button" className="sx-btn sx-btn--ghost sx-btn--sm" disabled={screen === 0} onClick={() => setScreen(s => s - 1)} aria-label="Previous page"><Icon name="arrow" size={12} style={{ transform: 'rotate(180deg)' }} /></button>
          <span className="sx-small">Page <b>{screen + 1}</b> of {screens}</span>
          <button type="button" className="sx-btn sx-btn--ghost sx-btn--sm" disabled={screen >= screens - 1} onClick={() => setScreen(s => s + 1)} aria-label="Next page"><Icon name="arrow" size={12} /></button>
        </nav>
      )}
      {locked && d && (
        <div className="sx-gate sx-gate--signup hx-siggate">
          <span className="sx-gate__text"><Icon name="lock" size={13} /> {d.total > all.length ? `${(d.total - all.length).toLocaleString('en-US')} more signals, why` : 'Why'} each one is a signal and how strong it is, with a free account.</span>
          <button className="sx-btn sx-btn--accent sx-btn--sm" onClick={signUp}>Create free account</button>
        </div>
      )}
    </Card>
  );
}
