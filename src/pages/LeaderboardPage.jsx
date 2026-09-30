// src/pages/LeaderboardPage.jsx — /leaderboard
// A ranked list whose only job is to lead you to insider pages. No drawer,
// no second profile viewer: click a name, you're on their page.
import React, { useEffect, useMemo, useState } from 'react';
import { InsiderLink, StockLink } from '../lib/nav.jsx';
import { money, pct, plural, prettyPerson } from '../lib/text.js';
import { Card, Segmented, Skeleton, ErrorNote, Gate, Chip } from '../components/ui.jsx';

const FREE_ROWS = 10;

export default function LeaderboardPage({ fetchLeaderboard, pro, onUpgrade }) {
  const [years, setYears] = useState(pro ? 2 : 1);
  const [source, setSource] = useState(null);
  const [sort, setSort] = useState('rank');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { document.title = 'Insider leaderboard · Seli'; }, []);
  useEffect(() => { if (!pro && years !== 1) setYears(1); }, [pro]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    setRows(null); setError(null);
    fetchLeaderboard(500, 2, years, source)
      .then(r => { if (live) setRows(r || []); })
      .catch(e => { if (live) setError(e.message || 'Couldn\'t load the leaderboard.'); });
    return () => { live = false; };
  }, [years, source, fetchLeaderboard]);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const scored = rows.filter(r => (r.priced ?? 0) >= 3 || sort === 'buys');
    const key = {
      rank: r => r.proxy_score ?? 0,
      hit: r => r.hit_rate ?? -1,
      ret: r => r.avg_return ?? -999,
      buys: r => Number(r.bought_value) || 0,
    }[sort];
    return [...scored].sort((a, b) => key(b) - key(a));
  }, [rows, sort]);

  const visible = sorted ? (pro ? sorted.slice(0, 200) : sorted.slice(0, FREE_ROWS)) : null;

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
        <Segmented size="sm" value={source ?? 'all'} onChange={v => setSource(v === 'all' ? null : v)} options={[
          { value: 'all', label: 'Everyone' }, { value: 'corporate', label: 'Executives' }, { value: 'congress', label: 'Congress' },
        ]} />
        {pro
          ? <Segmented size="sm" value={years} onChange={setYears} options={[{ value: 1, label: '1Y' }, { value: 2, label: '2Y' }, { value: 5, label: '5Y' }]} />
          : <span className="sx-muted sx-small">Last 12 months</span>}
      </div>

      <Card pad={false}>
        {error && <ErrorNote message={error} />}
        {!visible && !error && <div className="sx-card__body"><Skeleton lines={8} /></div>}
        {visible && !visible.length && (
          <div className="sx-empty"><div className="sx-empty__body">Nobody has 3 or more scored open-market buys in this window yet. Try a longer window or a different group.</div></div>
        )}
        {visible && visible.length > 0 && (
          <div className="sx-table-wrap">
            <table className="sx-table sx-table--lb">
              <thead>
                <tr>
                  <th className="sx-r">#</th>
                  <th>Insider</th>
                  <th className="sx-r">Hit rate</th>
                  <th className="sx-r">Avg since buy</th>
                  <th className="sx-r sx-hide-sm">S&amp;P, same periods</th>
                  <th className="sx-r sx-hide-sm">Bought</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => {
                  const spy = r.avg_spy_return ?? r.avg_spy_return_pct;
                  const tickers = (r.tickers || []).slice(0, 2);
                  return (
                    <tr key={r.insider_name}>
                      <td className="sx-r sx-muted sx-mono">{i + 1}</td>
                      <td className="sx-table__who">
                        <InsiderLink raw={r.insider_name}>{prettyPerson(r.insider_name, r.is_congress)}</InsiderLink>
                        <span className="sx-table__role">
                          {r.is_congress ? <Chip tone="accent">Congress</Chip> : (r.insider_title || '')}
                          {tickers.map(t => <StockLink key={t} ticker={t} className="sx-ml" />)}
                        </span>
                      </td>
                      <td className="sx-r sx-mono">{r.hit_rate != null ? `${r.hit_rate}%` : '—'}<span className="sx-n">{r.priced ? plural(r.priced, 'buy') : ''}</span></td>
                      <td className={`sx-r sx-mono ${r.avg_return >= 0 ? 'sx-up' : 'sx-down'}`}>{r.avg_return != null ? pct(r.avg_return, 1) : '—'}</td>
                      <td className="sx-r sx-mono sx-hide-sm sx-muted">{spy != null ? pct(Number(spy), 1) : '—'}</td>
                      <td className="sx-r sx-mono sx-hide-sm">{money(r.bought_value)}<span className="sx-n">{plural(r.om_buys || 0, 'buy')}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!pro && sorted && sorted.length > FREE_ROWS && (
          <Gate onUpgrade={onUpgrade} feature="insider_detail">Showing the top {FREE_ROWS} of {sorted.length}. Every insider page stays open on the free plan; Pro unlocks the full ranking and longer windows.</Gate>
        )}
      </Card>
      <p className="sx-note sx-note--center">Hit rate: share of open-market buys where the stock is now 5%+ higher (buys within 5% either way are left out). Needs at least 3 scored buys to be ranked.</p>
    </div>
  );
}
