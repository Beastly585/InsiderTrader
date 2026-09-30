// src/pages/LeaderboardPage.jsx — /leaderboard
// A ranked list whose only job is to lead you to insider pages. No drawer,
// no second profile viewer: click a name, you're on their page.
// Ranking, filtering and the free-plan limits happen in the Worker
// (/api/leaderboard, cached 30 min), so this page downloads ~10–200 rows
// instead of 500 and never runs the heavy query from the browser.
import React, { useEffect, useState } from 'react';
import { InsiderLink, StockLink } from '../lib/nav.jsx';
import { useApi } from '../lib/api.js';
import { money, pct, plural } from '../lib/text.js';
import { Card, Segmented, Skeleton, ErrorNote, Gate, Chip } from '../components/ui.jsx';

const LIST = { rank: 'ranked', hit: 'by_hit', ret: 'by_return', buys: 'by_buying' };

export default function LeaderboardPage({ pro, onUpgrade }) {
  const [years, setYears] = useState(pro ? 2 : 1);
  const [source, setSource] = useState('all');
  const [sort, setSort] = useState('rank');
  useEffect(() => { document.title = 'Insider leaderboard · Seli'; }, []);
  useEffect(() => { if (!pro && years !== 1) setYears(1); }, [pro]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, error, loading } = useApi(`/api/leaderboard?years=${years}&source=${source}`);
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
          { value: 'all', label: 'Everyone' }, { value: 'corporate', label: 'Executives' }, { value: 'congress', label: 'Congress' },
        ]} />
        {pro
          ? <Segmented size="sm" value={years} onChange={setYears} options={[{ value: 1, label: '1Y' }, { value: 2, label: '2Y' }, { value: 5, label: '5Y' }]} />
          : <span className="sx-muted sx-small">Last 12 months</span>}
      </div>

      <Card pad={false}>
        {error && !data && <ErrorNote message={error} />}
        {!data && !error && <div className="sx-card__body"><Skeleton lines={8} /></div>}
        {visible && !visible.length && !loading && (
          <div className="sx-empty"><div className="sx-empty__body">Nobody has {rules.min_scored} or more scored open-market buys in this window yet. Try a longer window or a different group.</div></div>
        )}
        {visible && visible.length > 0 && (
          <div className={`sx-table-wrap${loading ? ' sx-dim' : ''}`}>
            <table className="sx-table sx-table--lb">
              <thead>
                <tr>
                  <th className="sx-r">#</th>
                  <th>Insider</th>
                  <th className="sx-r">Hit rate</th>
                  <th className="sx-r sx-hide-sm">Avg since buy</th>
                  <th className="sx-r">vs S&amp;P</th>
                  <th className="sx-r sx-hide-sm">Bought</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => {
                  const ex = r.excess;
                  return (
                    <tr key={r.raw}>
                      <td className="sx-r sx-muted sx-mono">{i + 1}</td>
                      <td className="sx-table__who">
                        <InsiderLink raw={r.raw}>{r.name}</InsiderLink>
                        <span className="sx-table__role">
                          {r.congress ? <Chip tone="accent">Congress</Chip> : r.title}
                          {(r.tickers || []).slice(0, 2).map(t => <StockLink key={t} ticker={t} className="sx-ml" />)}
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
