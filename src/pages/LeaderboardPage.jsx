// src/pages/LeaderboardPage.jsx — /leaderboard
// A ranked list whose only job is to lead you to insider pages. No drawer,
// no second profile viewer: click a name, you're on their page.
// Ranking, filtering and the free-plan limits happen in the Worker
// (/api/leaderboard, cached 30 min), so this page downloads ~10–200 rows
// instead of 500 and never runs the heavy query from the browser.
import React, { useEffect, useState } from 'react';
import { InsiderLink, StockLink } from '../lib/nav.jsx';
import { useApi } from '../lib/api.js';
import { money, pct, plural, memberRole, memberChamber } from '../lib/text.js';
import { Card, Segmented, Skeleton, ErrorNote, Gate, Chip, useNarrow } from '../components/ui.jsx';

const LIST = { rank: 'ranked', hit: 'by_hit', ret: 'by_return', buys: 'by_buying' };
const signed = (v, d = 1) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}`;
const roleOf = r => (r.congress ? memberRole(r) : r.role || (/^unknown$/i.test(r.title || '') ? '' : r.title) || 'Insider');

// The number a row is ranked by, so the list always leads with it.
function headline(r, sort) {
  if (sort === 'hit') return { value: r.hit_rate != null ? `${r.hit_rate}%` : '—', label: 'hit rate', tone: r.hit_rate >= 50 ? 'sx-up' : 'sx-down' };
  if (sort === 'ret') return { value: r.avg_return != null ? `${signed(r.avg_return, 0)}%` : '—', label: 'avg since buy', tone: r.avg_return >= 0 ? 'sx-up' : 'sx-down' };
  if (sort === 'buys') return { value: money(r.bought), label: 'bought', tone: '' };
  return { value: r.excess != null ? `${signed(r.excess, 0)} pts` : '—', label: 'vs S&P 500', tone: r.excess == null ? 'sx-muted' : r.excess >= 0 ? 'sx-up' : 'sx-down' };
}


// Phone layout: one card-like row per person, ranked number on the right.
function LeaderList({ rows, sort }) {
  return (
    <ol className="sx-lb">
      {rows.map(r => {
        const h = headline(r, sort);
        // One short line of context, minus whatever the big number already says.
        const bits = [
          plural(r.priced || r.om_buys || 0, 'buy'),
          sort !== 'hit' && r.hit_rate != null ? `${r.hit_rate}% hit` : null,
          sort !== 'ret' && r.avg_return != null ? `avg ${signed(r.avg_return, 0)}%` : null,
          sort === 'buys' && r.excess != null ? `${signed(r.excess, 0)} pts vs S&P` : null,
        ].filter(Boolean);
        return (
          <li key={r.raw} className="sx-lb__row">
            <div className="sx-lb__main">
              <InsiderLink raw={r.raw} className="sx-lb__name">{r.name}</InsiderLink>
              <div className="sx-lb__who">
                {r.congress ? <Chip tone="accent">{memberChamber(r)}</Chip> : <span>{roleOf(r)}</span>}
                {(r.tickers || []).slice(0, 2).map(t => <StockLink key={t} ticker={t} plain className="sx-lb__tk" />)}
              </div>
              <div className="sx-lb__stats">{bits.join(' · ')}</div>
            </div>
            <div className="sx-lb__num">
              <span className={`sx-lb__val ${h.tone}`}>{h.value}</span>
              <span className="sx-lb__lbl">{h.label}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}


export default function LeaderboardPage({ pro, onUpgrade, publicMode = false }) {
  const [years, setYears] = useState(pro ? 2 : 1);
  const [source, setSource] = useState('all');
  const [sort, setSort] = useState('rank');
  useEffect(() => { document.title = publicMode ? 'Best Insider Traders: Leaderboard of Insider Buying Track Records | Seli' : 'Insider leaderboard · Seli'; }, [publicMode]);
  useEffect(() => { if (!pro && years !== 1) setYears(1); }, [pro]); // eslint-disable-line react-hooks/exhaustive-deps

  const narrow = useNarrow();
  const { data, error, loading } = useApi(`/${publicMode ? 'public' : 'api'}/leaderboard?years=${years}&source=${source}`);
  const visible = data ? data[LIST[sort]] || [] : null;
  const rules = data?.rules || { min_scored: 3, min_avg_buy: 25000 };
  const total = data?.total ?? 0;

  return (
    <div className="sx-page">
      <header className="sx-head sx-head--page">
        <div className="sx-head__main">
          <h1 className="sx-head__title">Insider leaderboard</h1>
          <p className="sx-head__desc">People whose open-market buys have done best since they made them. Every number shows how many buys it's based on.</p>
        </div>
      </header>
      <div className="sx-toolbar">
        <Segmented size="sm" value={sort} onChange={setSort} options={[
          { value: 'rank', label: 'Track record' }, { value: 'hit', label: 'Hit rate' }, { value: 'ret', label: 'Avg return' }, { value: 'buys', label: 'Most buying' },
        ]} />
        <Segmented size="sm" value={source} onChange={setSource} options={[
          { value: 'all', label: 'Everyone' }, { value: 'corporate', label: 'Insiders' }, { value: 'congress', label: 'Politicians' },
        ]} />
        {pro
          ? <Segmented size="sm" value={years} onChange={setYears} options={[{ value: 1, label: '1Y' }, { value: 2, label: '2Y' }, { value: 5, label: '5Y' }]} />
          : <span className="sx-muted sx-small">Last 12 months</span>}
        {loading && data && <span className="sx-muted sx-small" role="status">Updating…</span>}
      </div>

      <Card pad={false}>
        {error && !data && <ErrorNote message={error} />}
        {!data && !error && <div className="sx-card__body"><Skeleton lines={8} /></div>}
        {visible && !visible.length && !loading && (
          <div className="sx-empty"><div className="sx-empty__body">Nobody has {rules.min_scored} or more scored open-market buys in this window yet. Try a longer window or a different group.</div></div>
        )}
        {visible && visible.length > 0 && narrow && <div className={loading ? 'sx-dim' : ''}><LeaderList rows={visible} sort={sort} /></div>}
        {visible && visible.length > 0 && !narrow && (
          <div className={`sx-table-wrap${loading ? ' sx-dim' : ''}`}>
            <table className="sx-table sx-table--lb">
              <thead>
                <tr>
                  <th>Insider</th>
                  <th className="sx-r">Hit rate</th>
                  <th className="sx-r sx-hide-sm">Avg since buy</th>
                  <th className="sx-r">vs S&amp;P 500</th>
                  <th className="sx-r sx-hide-sm">Bought</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(r => {
                  const ex = r.excess;
                  return (
                    <tr key={r.raw}>
                      <td className="sx-table__who">
                        <InsiderLink raw={r.raw}>{r.name}</InsiderLink>
                        <span className="sx-table__role">
                          {r.congress ? <Chip tone="accent">{memberChamber(r)}</Chip> : roleOf(r)}
                          {(r.tickers || []).slice(0, 3).map(t => <StockLink key={t} ticker={t} plain className="sx-lb__tk" />)}
                        </span>
                      </td>
                      <td className="sx-r sx-mono">{r.hit_rate != null ? `${r.hit_rate}%` : '—'}<span className="sx-n">{r.priced ? plural(r.priced, 'buy') : ''}</span></td>
                      <td className={`sx-r sx-mono sx-hide-sm ${r.avg_return >= 0 ? 'sx-up' : 'sx-down'}`}>{r.avg_return != null ? pct(r.avg_return, 1) : '—'}</td>
                      <td className={`sx-r sx-mono ${ex == null ? 'sx-muted' : ex >= 0 ? 'sx-up' : 'sx-down'}`}>
                        {ex != null ? `${ex >= 0 ? '+' : ''}${ex.toFixed(1)} pts` : '—'}
                        <span className="sx-n">{r.avg_spy != null ? `S&P ${pct(r.avg_spy, 1)}` : ''}</span>
                      </td>
                      <td className="sx-r sx-mono sx-hide-sm">{money(r.bought)}<span className="sx-n">{plural(r.om_buys || 0, 'buy')}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!pro && data && total > visible.length && (
          <Gate onUpgrade={onUpgrade} feature="insider_detail">Showing the top {visible.length} of {total}. Every insider page stays open on the free plan; Pro unlocks the full ranking and longer windows.</Gate>
        )}
      </Card>
      <p className="sx-note sx-note--center">
        Track record ranks by how far someone's buys beat the S&amp;P 500 over the same periods, discounted when there are only a few buys.
        Hit rate is the share of buys now 5%+ higher (buys within 5% either way are left out).
        To be ranked: at least {rules.min_scored} scored buys averaging {money(rules.min_avg_buy)}+, and a person rather than a company or fund.
      </p>
    </div>
  );
}
