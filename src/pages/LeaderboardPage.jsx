// src/pages/LeaderboardPage.jsx — /leaderboard
// A ranked list whose only job is to lead you to insider pages. No drawer,
// no second profile viewer: click a name, you're on their page.
import React, { useEffect, useMemo, useState } from 'react';
import { InsiderLink, StockLink } from '../lib/nav.jsx';
import { money, pct, plural, prettyPerson, isEntityName } from '../lib/text.js';
import { Card, Segmented, Skeleton, ErrorNote, Gate, Chip } from '../components/ui.jsx';

const FREE_ROWS = 10;
// Ranking rules. A leaderboard is only worth trusting if the top isn't
// people with three lucky buys or companies buying their own stock.
const MIN_SCORED = 3;          // scored buys needed to be ranked at all
const MIN_AVG_BUY = 25_000;    // average open-market buy size; filters token buys
const SHRINK = 10;             // pulls small samples toward zero: n / (n + SHRINK)

const spyOf = r => { const v = r.avg_spy_return ?? r.avg_spy_return_pct; return v == null ? null : Number(v); };
const excessOf = r => (r.avg_return != null && spyOf(r) != null ? r.avg_return - spyOf(r) : null);
// Excess return over the S&P, discounted by sample size. 8 buys at +40 pts
// beats 3 buys at +60 pts; 30 buys at +25 pts beats both.
const rankScore = r => { const e = excessOf(r); const n = r.priced || 0; return e == null ? -Infinity : e * (n / (n + SHRINK)); };

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
    const eligible = rows.filter(r => {
      if (!r.is_congress && isEntityName(r.insider_name)) return false;
      if (sort === 'buys') return true;
      const avgBuy = (Number(r.bought_value) || 0) / Math.max(1, r.om_buys || 0);
      return (r.priced ?? 0) >= MIN_SCORED && (r.is_congress || avgBuy >= MIN_AVG_BUY);
    });
    const key = {
      rank: rankScore,
      hit: r => (r.hit_rate ?? -1) * 1000 + (r.priced || 0),   // ties broken by sample size
      ret: r => (r.avg_return ?? -999) * (r.priced || 0) / ((r.priced || 0) + SHRINK),
      buys: r => Number(r.bought_value) || 0,
    }[sort];
    return [...eligible].sort((a, b) => key(b) - key(a));
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
                  <th className="sx-r">vs S&amp;P</th>
                  <th className="sx-r sx-hide-sm">Bought</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => {
                  const spy = spyOf(r);
                  const ex = excessOf(r);
                  const tickers = (r.tickers || []).slice(0, 2);
                  return (
                    <tr key={r.insider_name}>
                      <td className="sx-r sx-muted sx-mono">{i + 1}</td>
                      <td className="sx-table__who">
                        <InsiderLink raw={r.insider_name}>{prettyPerson(r.insider_name, r.is_congress)}</InsiderLink>
                        <span className="sx-table__role">
                          {r.is_congress ? <Chip tone="accent">Congress</Chip> : (/^unknown$/i.test(r.insider_title || '') ? '' : (r.insider_title || ''))}
                          {tickers.map(t => <StockLink key={t} ticker={t} className="sx-ml" />)}
                        </span>
                      </td>
                      <td className="sx-r sx-mono">{r.hit_rate != null ? `${r.hit_rate}%` : '—'}<span className="sx-n">{r.priced ? plural(r.priced, 'buy') : ''}</span></td>
                      <td className={`sx-r sx-mono ${r.avg_return >= 0 ? 'sx-up' : 'sx-down'}`}>{r.avg_return != null ? pct(r.avg_return, 1) : '—'}</td>
                      <td className={`sx-r sx-mono ${ex == null ? 'sx-muted' : ex >= 0 ? 'sx-up' : 'sx-down'}`}>
                        {ex != null ? `${ex >= 0 ? '+' : ''}${ex.toFixed(1)} pts` : '—'}
                        <span className="sx-n">{spy != null ? `S&P ${pct(spy, 1)}` : ''}</span>
                      </td>
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
      <p className="sx-note sx-note--center">
        Track record ranks by how far someone's buys beat the S&amp;P 500 over the same periods, discounted when there are only a few buys.
        Hit rate is the share of buys now 5%+ higher (buys within 5% either way are left out).
        To be ranked: at least {MIN_SCORED} scored buys averaging {money(MIN_AVG_BUY)}+, and a person rather than a company or fund.
      </p>
    </div>
  );
}
