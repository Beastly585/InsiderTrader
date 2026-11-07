// src/pages/LeaderboardPage.jsx — /leaderboard
// A ranked list whose only job is to lead you to insider pages. No drawer,
// no second profile viewer: click a name, you're on their page.
// Ranking, filtering and the free-plan limits happen in the Worker
// (/api/leaderboard, cached 30 min), so this page downloads ~10–200 rows
// instead of 500 and never runs the heavy query from the browser.
import React, { useEffect, useState } from 'react';
import { InsiderLink, StockLink } from '../lib/nav.jsx';
import { useApi } from '../lib/api.js';
import { money, pct, plural, PAGE_TITLES } from '../lib/text.js';
import { Card, Segmented, Skeleton, ErrorNote, Gate, useNarrow, RoleTag, Icon, FollowButton } from '../components/ui.jsx';

const LIST = { rank: 'ranked', hit: 'by_hit', ret: 'by_return', buys: 'by_buying' };
const signed = (v, d = 1) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}`;

// The number a row is ranked by, so the list always leads with it.
function headline(r, sort) {
  if (sort === 'hit') return { value: r.hit_rate != null ? `${r.hit_rate}%` : '—', label: 'hit rate', tone: r.hit_rate >= 50 ? 'sx-up' : 'sx-down' };
  if (sort === 'ret') return { value: r.avg_return != null ? `${signed(r.avg_return, 0)}%` : '—', label: 'avg since buy', tone: r.avg_return >= 0 ? 'sx-up' : 'sx-down' };
  if (sort === 'buys') return { value: money(r.bought), label: 'bought', tone: '' };
  return { value: r.excess != null ? `${signed(r.excess, 0)} pts` : '—', label: 'vs S&P 500', tone: r.excess == null ? 'sx-muted' : r.excess >= 0 ? 'sx-up' : 'sx-down' };
}


// Phone layout: one card-like row per person, ranked number on the right.
function LeaderList({ rows, sort, watchlist }) {
  return (
    <ol className="sx-lb">
      {rows.map(r => {
        const h = headline(r, sort);
        // One short line of context, minus whatever the big number already says.
        const bits = [
          sort === 'hit' && r.priced ? `hit rate of ${r.priced} scored` : null,
          plural(r.om_buys || 0, 'buy'),
          sort !== 'hit' && r.hit_rate != null ? `${r.hit_rate}% hit (of ${r.priced} scored)` : null,
          sort !== 'ret' && r.avg_return != null ? `avg ${signed(r.avg_return, 0)}%` : null,
          sort === 'buys' && r.excess != null ? `${signed(r.excess, 0)} pts vs S&P` : null,
        ].filter(Boolean);
        return (
          <li key={r.raw} className="sx-lb__row">
            <div className="sx-lb__main">
              <InsiderLink raw={r.raw} className="sx-lb__name">{r.name}</InsiderLink>
              <div className="sx-lb__who">
                <RoleTag role={r.role} congress={!!r.congress} title={r.title} />
                {(r.tickers || []).slice(0, 2).map(t => <StockLink key={t} ticker={t} plain className="sx-lb__tk" />)}
              </div>
              <div className="sx-lb__stats">{bits.join(' · ')}</div>
            </div>
            <div className="sx-lb__num">
              <span className={`sx-lb__val ${h.tone}`}>{h.value}</span>
              <span className="sx-lb__lbl">{h.label}</span>
            </div>
            {watchlist && <div className="sx-lb__follow"><FollowButton watchlist={watchlist} kind="person" id={r.raw} label={r.name} /></div>}
          </li>
        );
      })}
    </ol>
  );
}


const PHONE_PAGE = 25;

export default function LeaderboardPage({ pro, onUpgrade, publicMode = false, watchlist }) {
  const [mine, setMine] = useState(false);
  const watchedPeople = publicMode ? 0 : (watchlist?.insiders?.length || 0);
  const [years, setYears] = useState(pro ? 2 : 1);
  const [source, setSource] = useState('all');
  const [sort, setSort] = useState('rank');
  useEffect(() => { document.title = publicMode ? PAGE_TITLES.leaderboard : 'Insider leaderboard · Seli'; }, [publicMode]);
  useEffect(() => { if (!pro && years !== 1) setYears(1); }, [pro]); // eslint-disable-line react-hooks/exhaustive-deps

  const narrow = useNarrow();
  // Phones show the list in pages of 25 (Pro gets up to 200 rows, which
  // made an endless scroll). Desktop shows the whole table as before.
  const [shown, setShown] = useState(PHONE_PAGE);
  useEffect(() => { setShown(PHONE_PAGE); }, [sort, source, years, mine]);
  const { data, error, loading } = useApi(`/${publicMode ? 'public' : 'api'}/leaderboard?years=${years}&source=${source}`);
  const ranked = data ? data[LIST[sort]] || [] : null;
  const visible = ranked && mine && watchlist ? ranked.filter(r => watchlist.hasInsider(r.raw)) : ranked;
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
          { value: 'all', label: 'Everyone' }, { value: 'corporate', label: 'Insiders' }, { value: 'congress', label: 'Congress' },
        ]} />
        {pro
          ? <Segmented size="sm" value={years} onChange={setYears} options={[{ value: 1, label: '1Y' }, { value: 2, label: '2Y' }, { value: 5, label: '5Y' }]} />
          : <span className="sx-muted sx-small">Last 12 months</span>}
        {!publicMode && watchlist && (
          <button type="button" role="checkbox" aria-checked={mine} className={`hx-toggle hx-toggle--sm${mine ? ' hx-toggle--on' : ''}`}
            disabled={!watchedPeople && !mine} title={watchedPeople ? 'Only the people you follow' : 'Follow someone first (the eye on their row)'}
            onClick={() => setMine(m => !m)}>
            <span className="hx-toggle__box">{mine && <Icon name="check" size={10} />}</span>Only my watchlist{watchedPeople ? ` (${watchedPeople})` : ''}
          </button>
        )}
        {loading && data && <span className="sx-muted sx-small" role="status">Updating…</span>}
      </div>

      <Card pad={false}>
        {error && !data && <ErrorNote message={error} />}
        {!data && !error && <div className="sx-card__body"><Skeleton lines={8} /></div>}
        {visible && !visible.length && !loading && mine && (
          <div className="sx-empty"><div className="sx-empty__body">None of the people you follow are ranked in this view. Someone needs {rules.min_scored} or more scored buys to make the list{!pro ? ', and the free plan shows the top of it' : ''}.</div></div>
        )}
        {visible && !visible.length && !loading && !mine && (
          <div className="sx-empty"><div className="sx-empty__body">Nobody has {rules.min_scored} or more scored open-market buys in this window yet. Try a longer window or a different group.</div></div>
        )}
        {visible && visible.length > 0 && narrow && (
          <div className={loading ? 'sx-dim' : ''}>
            <LeaderList rows={visible.slice(0, shown)} sort={sort} watchlist={watchlist} />
            {visible.length > shown && (
              <button className="sx-more" onClick={() => setShown(n => n + PHONE_PAGE)}>
                Show {Math.min(PHONE_PAGE, visible.length - shown)} more <span className="sx-muted">({shown} of {visible.length})</span>
                <Icon name="chevron" size={12} />
              </button>
            )}
          </div>
        )}
        {visible && visible.length > 0 && !narrow && (
          <div className={`sx-table-wrap sx-lb__scroll${loading ? ' sx-dim' : ''}`}>
            <table className="sx-table sx-table--lb">
              <thead>
                <tr>
                  <th>Insider</th>
                  <th className="sx-r">Hit rate</th>
                  <th className="sx-r sx-hide-sm">Avg since buy</th>
                  <th className="sx-r">vs S&amp;P 500</th>
                  <th className="sx-r sx-hide-sm">Bought</th>
                  {watchlist && <th aria-label="Follow" />}
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
                          <RoleTag role={r.role} congress={!!r.congress} title={r.title} />
                          {(r.tickers || []).slice(0, 3).map(t => <StockLink key={t} ticker={t} plain className="sx-lb__tk" />)}
                        </span>
                      </td>
                      <td className="sx-r sx-mono">{r.hit_rate != null ? `${r.hit_rate}%` : '—'}<span className="sx-n">{r.priced ? `of ${r.priced} scored` : ''}</span></td>
                      <td className={`sx-r sx-mono sx-hide-sm ${r.avg_return >= 0 ? 'sx-up' : 'sx-down'}`}>{r.avg_return != null ? pct(r.avg_return, 1) : '—'}</td>
                      <td className={`sx-r sx-mono ${ex == null ? 'sx-muted' : ex >= 0 ? 'sx-up' : 'sx-down'}`}>
                        {ex != null ? `${ex >= 0 ? '+' : ''}${ex.toFixed(1)} pts` : '—'}
                        <span className="sx-n">{r.avg_spy != null ? `S&P ${pct(r.avg_spy, 1)}` : ''}</span>
                      </td>
                      <td className="sx-r sx-mono sx-hide-sm">{money(r.bought)}<span className="sx-n">{plural(r.om_buys || 0, 'buy')}</span></td>
                      {watchlist && <td className="sx-r sx-lb__followcell"><FollowButton watchlist={watchlist} kind="person" id={r.raw} label={r.name} /></td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!pro && data && !mine && total > visible.length && (
          <Gate onUpgrade={onUpgrade} feature="insider_detail">Showing the top {visible.length} of {total}. Every insider page stays open on the free plan; Pro unlocks the full ranking and longer windows.</Gate>
        )}
      </Card>
      <p className="sx-note sx-note--center">
        Track record ranks by how far someone's buys beat the S&amp;P 500 over the same periods, discounted when there are only a few buys.
        Hit rate is the share of scored buys now 5%+ higher. A buy is scored when there's a price to check it against, and buys that moved less than 5% either way are left out, so it's often based on fewer buys than the Bought column counts.
        To be ranked: at least {rules.min_scored} scored buys averaging {money(rules.min_avg_buy)}+, and a person rather than a company or fund.
      </p>
      <RoleGuide />
    </div>
  );
}

// What the role labels mean: collapsed under the table, open on request.
const ROLE_GUIDE = [
  ['CEO', true, 'Chief executive. Runs the company day to day.'],
  ['CFO', true, 'Chief financial officer. Runs the money side.'],
  ['Executive', true, 'Any other top officer: COO, CTO, president, general counsel and the like. Hover a name\'s role to see the exact title.'],
  ['Board chair', true, 'Leads the board of directors.'],
  ['VP', false, 'Vice president (VP, SVP or EVP). Senior manager who has to report trades.'],
  ['Board member', false, 'Sits on the board. Usually not an employee, but sees the same inside picture.'],
  ['Major shareholder', false, 'Owns 10% or more of the stock, so has to report trades like an insider.'],
  ['Fund', false, 'A firm or fund (not a person) that owns 10%+. Not ranked here.'],
];
function RoleGuide() {
  return (
    <details className="sx-roles">
      <summary className="sx-roles__sum">What do the roles mean?</summary>
      <p className="sx-roles__intro">Company insiders report their own trades to the SEC within 2 business days on a Form 4. The role is their job at the company that filed; the top jobs are in darker text.</p>
      <dl className="sx-roles__list">
        {ROLE_GUIDE.map(([label, top, text]) => (
          <div key={label} className="sx-roles__item">
            <dt><span className={`sx-role sx-role--corp${top ? ' sx-role--top' : ''}`}>{label}</span></dt>
            <dd>{text}</dd>
          </div>
        ))}
        <div className="sx-roles__item">
          <dt className="sx-roles__pair"><RoleTag role="Senator" congress /><RoleTag role="Representative" congress /></dt>
          <dd>Members of Congress. They report under the STOCK Act, in dollar ranges, up to 45 days after the trade.</dd>
        </div>
      </dl>
    </details>
  );
}
