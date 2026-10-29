// src/pages/BlogPages.jsx — seli.app/blog
//
// /blog              the timeline: newest first, grouped by day, with search
//                    and Buys / Sells / Weekly roundups filters
// /blog/page/N       older pages of the same
// /blog/:slug        one post
//
// Posts are written by db/blog_generate.py from the filings themselves and
// stored as structured sections (body), so every post renders the same way
// and every number on it links back to the stock, the person and the SEC
// filing. Signed-out visitors get it inside the public shell, signed-in
// users inside the app.
import React, { useEffect, useMemo, useState } from 'react';
import { useApi } from '../lib/api.js';
import { go, StockLink, InsiderLink, stockPath, insiderPath } from '../lib/nav.jsx';
import { money, price, shares, shortDate } from '../lib/text.js';
import { etDate } from '../lib/visit.js';
import { Card, Segmented, Empty, Skeleton, ErrorNote, Icon, RoleTag } from '../components/ui.jsx';
import WatchButton from '../components/WatchButton.jsx';

export const BLOG_TITLE = 'Insider Trading News: Notable Insider Buys and Sells | Seli';
const KIND_LABEL = { buy: 'Insider buy', sell: 'Insider sale', roundup: 'Weekly roundup' };
const KIND_CLASS = { buy: 'sx-chip--buy', sell: 'sx-chip--sell', roundup: 'sx-chip--accent' };

const track = (event, props) => { try { window.posthog?.capture?.(event, props); } catch { /* analytics never breaks a page */ } };
const navClick = path => e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); go(path); };
export const blogPath = slug => `/blog/${slug}`;

const dayKey = iso => (iso ? etDate(iso) : '');
function dayLabel(key) {
  if (!key) return '';
  const today = etDate(Date.now());
  const yesterday = etDate(Date.now() - 864e5);
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  const d = new Date(`${key}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: key.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric', timeZone: 'UTC' });
}
const longDate = iso => (iso ? new Date(`${dayKey(iso)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

function Tags({ post }) {
  return (
    <span className="sx-blog__tags">
      <span className={`sx-chip ${KIND_CLASS[post.kind] || ''}`}>{KIND_LABEL[post.kind] || post.kind}</span>
      {(post.tags || []).filter(t => t !== 'Weekly roundup').map(t => (
        <span key={t} className={`sx-chip${/reversal/i.test(t) ? ' sx-chip--rev' : ''}`}>{t}</span>
      ))}
    </span>
  );
}

// ── /blog ────────────────────────────────────────────────────────────────────
function readFilters() {
  try {
    const p = new URLSearchParams(window.location.search);
    const kind = p.get('kind');
    return { q: (p.get('q') || '').slice(0, 60), kind: ['buy', 'sell', 'roundup'].includes(kind) ? kind : 'all', ticker: (p.get('ticker') || '').toUpperCase().slice(0, 10) };
  } catch { return { q: '', kind: 'all', ticker: '' }; }
}

export function BlogTimeline({ pageNo = 1 }) {
  const [f, setF] = useState(readFilters);
  const [typed, setTyped] = useState(f.q);
  useEffect(() => { document.title = pageNo > 1 ? `Insider Trading News, Page ${pageNo} | Seli` : BLOG_TITLE; }, [pageNo]);
  // Search as you type, a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setF(x => (x.q === typed.trim() ? x : { ...x, q: typed.trim() })), 350);
    return () => clearTimeout(t);
  }, [typed]);
  const filtered = !!(f.q || f.ticker || f.kind !== 'all');
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (f.q) p.set('q', f.q);
    if (f.kind !== 'all') p.set('kind', f.kind);
    if (f.ticker) p.set('ticker', f.ticker);
    return p.toString();
  }, [f]);
  // Keep the address bar in step, so a filtered view can be shared. A new
  // search starts again from page 1.
  useEffect(() => {
    const want = (filtered ? '/blog' : pageNo > 1 ? `/blog/page/${pageNo}` : '/blog') + (qs ? `?${qs}` : '');
    if (window.location.pathname + window.location.search !== want) window.history.replaceState({}, '', want);
  }, [qs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (f.q) track('blog_search', { q: f.q }); }, [f.q]);

  const page = filtered ? 1 : pageNo;
  const { data: d, error, reload } = useApi(`/public/blog?page=${page}${qs ? `&${qs}` : ''}`);
  const groups = useMemo(() => {
    const m = new Map();
    for (const p of d?.posts || []) { const k = dayKey(p.published_at); if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
    return [...m.entries()];
  }, [d]);
  const clear = () => { setTyped(''); setF({ q: '', kind: 'all', ticker: '' }); };

  return (
    <div className="sx-page sx-blog">
      <header className="sx-head sx-head--page">
        <div className="sx-head__main">
          <h1 className="sx-head__title">Insider trading news</h1>
          <p className="sx-head__desc">The insider trades worth a closer look, written up from SEC Form 4 filings as they come in: big and first-time buys, several insiders buying together, and heavy unplanned selling. Planned 10b5-1 trades, offering purchases and option exercises don't make the cut.</p>
        </div>
      </header>

      <div className="sx-blog__bar">
        <div className="sx-search__field sx-blog__search">
          <span className="sx-search__icon"><Icon name="search" size={14} /></span>
          <input className="sx-search__input" type="search" value={typed} onChange={e => setTyped(e.target.value)}
            placeholder="Search a ticker, company or insider" aria-label="Search the blog by ticker, company or insider" />
        </div>
        <Segmented size="sm" value={f.kind} onChange={kind => setF(x => ({ ...x, kind }))} options={[
          { value: 'all', label: 'All' }, { value: 'buy', label: 'Buys' }, { value: 'sell', label: 'Sells' }, { value: 'roundup', label: 'Roundups' },
        ]} />
      </div>
      {f.ticker && (
        <p className="sx-blog__filter">Posts about <StockLink ticker={f.ticker} /> <button className="sx-link" onClick={() => setF(x => ({ ...x, ticker: '' }))}>Show all</button></p>
      )}

      {error && !d && <ErrorNote message={error} onRetry={reload} />}
      {!d && !error && <Card><Skeleton lines={8} /></Card>}
      {d && !d.posts.length && (
        <Card><Empty title={filtered ? 'Nothing matches that' : 'No posts yet'}>
          {filtered
            ? <>No posts mention it yet. Try a ticker or a last name, or <button className="sx-link" onClick={clear}>clear the search</button>.</>
            : 'The first write-ups land here as notable trades are filed.'}
        </Empty></Card>
      )}
      {d && d.posts.length > 0 && (
        <ol className="sx-tl" aria-label="Posts, newest first">
          {groups.map(([k, posts]) => (
            <li key={k} className="sx-tl__day">
              <h2 className="sx-tl__date"><time dateTime={k}>{dayLabel(k)}</time></h2>
              <ul className="sx-tl__posts">
                {posts.map(p => (
                  <li key={p.slug} className={`sx-tl__post sx-tl__post--${p.kind}`}>
                    <Tags post={p} />
                    <h3 className="sx-tl__title"><a href={blogPath(p.slug)} onClick={navClick(blogPath(p.slug))}>{p.title}</a></h3>
                    <p className="sx-tl__sum">{p.summary}</p>
                    <p className="sx-tl__meta">
                      {p.ticker && <StockLink ticker={p.ticker} />}
                      {(p.insiders || []).slice(0, 3).map(i => <InsiderLink key={i.raw} raw={i.raw}>{i.name}</InsiderLink>)}
                      {(p.insiders || []).length > 3 && <span className="sx-muted">+{p.insiders.length - 3} more</span>}
                    </p>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {d && d.pages > 1 && (
        <nav className="sx-blog__pager" aria-label="More posts">
          {page > 1 && <a className="sx-btn sx-btn--ghost sx-btn--sm" href={page === 2 ? '/blog' : `/blog/page/${page - 1}`} onClick={navClick(page === 2 ? '/blog' : `/blog/page/${page - 1}`)}>Newer</a>}
          <span className="sx-muted sx-small">Page {page} of {d.pages}</span>
          {page < d.pages && !filtered && <a className="sx-btn sx-btn--ghost sx-btn--sm" href={`/blog/page/${page + 1}`} onClick={navClick(`/blog/page/${page + 1}`)}>Older posts</a>}
        </nav>
      )}
      <p className="sx-note sx-note--center">Written up by Kevin Maresca from public SEC filings. Not investment advice. <a href="/about" className="sx-link">How the data works</a></p>
    </div>
  );
}

// ── /blog/:slug ──────────────────────────────────────────────────────────────
export function BlogPostPage({ slug, watchlist }) {
  const preview = useMemo(() => { try { return new URLSearchParams(window.location.search).get('preview') || ''; } catch { return ''; } }, []);
  const { data: d, error, reload } = useApi(`/public/blog/post/${slug}${preview ? `?preview=${encodeURIComponent(preview)}` : ''}`);
  const post = d?.known ? d.post : null;
  useEffect(() => {
    if (post) { document.title = `${post.title} | Seli`; track('blog_view', { slug, kind: post.kind, ticker: post.ticker }); }
    else if (d && !d.known) document.title = 'Post not found | Seli';
  }, [post?.slug, d?.known]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !d) return <div className="sx-page"><ErrorNote message={error} onRetry={reload} /></div>;
  if (!d) return <div className="sx-page sx-blog"><Card><Skeleton lines={10} /></Card></div>;
  if (!post) {
    return (
      <div className="sx-page sx-blog">
        <Card><Empty title="Post not found" action={<a className="sx-btn sx-btn--sm" href="/blog" onClick={navClick('/blog')}>See all posts</a>}>
          It may have been taken down, or the link is off by a character.
        </Empty></Card>
      </div>
    );
  }
  const b = post.body || {};
  const cta = where => () => track('blog_cta_click', { slug, where, ticker: post.ticker });
  return (
    <div className="sx-page sx-blog sx-post">
      {post.draft && <p className="sx-post__draft"><Icon name="bell" size={14} /> Draft preview. Only people with this link can see it.</p>}
      <nav className="sx-post__crumbs" aria-label="Breadcrumb">
        <a href="/blog" onClick={navClick('/blog')}>Insider trading news</a>
        {post.ticker && <><span aria-hidden="true">/</span><StockLink ticker={post.ticker} plain /></>}
      </nav>
      <article>
        <header className="sx-post__head">
          <Tags post={post} />
          <h1 className="sx-post__title">{post.title}</h1>
          <p className="sx-post__by">By {b.author || 'Kevin Maresca'} · <time dateTime={post.published_at || post.created_at}>{longDate(post.published_at || post.created_at)}</time>
            {post.updated_at && post.published_at && dayKey(post.updated_at) !== dayKey(post.published_at) && <> · Updated {longDate(post.updated_at)}</>}
          </p>
        </header>
        {post.kind === 'roundup' ? <RoundupBody b={b} cta={cta} /> : <TradeBody post={post} b={b} watchlist={watchlist} cta={cta} />}
      </article>

      {(d.related || []).length > 0 && (
        <Card title={d.related.some(r => r.same_stock) && post.ticker ? `More on ${post.ticker} and other recent posts` : 'More insider trading news'} pad={false}>
          <ul className="sx-rows">
            {d.related.map(r => (
              <li key={r.slug} className="sx-row">
                <div className="sx-row__main">
                  <div className="sx-row__title"><a href={blogPath(r.slug)} onClick={e => { cta('related')(); navClick(blogPath(r.slug))(e); }}>{r.title}</a></div>
                  <div className="sx-row__sub">{KIND_LABEL[r.kind]} · {shortDate(dayKey(r.published_at))}</div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="sx-note">Seli writes these up from SEC Form 4 filings, linked above. It shows what was filed and isn't investment advice. Insiders buy and sell for many reasons, and a buy can still lose money.</p>
    </div>
  );
}

function TradeBody({ post, b, watchlist, cta }) {
  const t = post.ticker;
  const lead = (b.people || []).find(p => !p.entity) || (b.people || [])[0];
  const sell = post.kind === 'sell';
  return (
    <>
      <p className="sx-post__lead">{b.lead}</p>
      <div className="sx-post__grid">
        <Card title="The trades at a glance" className="sx-post__facts">
          <dl className="sx-facts">
            {(b.facts || []).map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}
          </dl>
          {b.range && <RangeBar r={b.range} sell={sell} />}
        </Card>
        <Card title={`Follow ${t}`} className="sx-post__follow">
          <p className="sx-small">Get an email the next time {t} insiders buy or sell.</p>
          {watchlist && <div onClickCapture={cta('watch')}><WatchButton watchlist={watchlist} kind="stock" id={t} /></div>}
          <ul className="sx-post__links">
            <li><a href={stockPath(t)} onClick={e => { cta('stock')(); navClick(stockPath(t))(e); }}>Every {t} insider trade, with a price chart <Icon name="arrow" size={12} /></a></li>
            {lead && <li><a href={insiderPath(lead.raw)} onClick={e => { cta('insider')(); navClick(insiderPath(lead.raw))(e); }}>{lead.name}'s trades and track record <Icon name="arrow" size={12} /></a></li>}
            <li><a href="/leaderboard" onClick={e => { cta('leaderboard')(); navClick('/leaderboard')(e); }}>Insiders with the best records <Icon name="arrow" size={12} /></a></li>
          </ul>
        </Card>
      </div>

      {(b.why || []).length > 0 && (
        <section className="sx-post__sec">
          <h2>Why it stands out</h2>
          <ul>{b.why.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </section>
      )}

      <Card title={sell ? 'Who sold' : 'Who bought'} sub="Each row links to the person's page and the Form 4 on SEC.gov" pad={false}>
        <div className="sx-table-wrap">
          <table className="sx-table sx-post__people">
            <thead><tr><th>Insider</th><th className="sx-r">{sell ? 'Sold' : 'Bought'}</th><th className="sx-r">Shares</th><th className="sx-r">Avg price</th><th>Date</th><th>Filing</th></tr></thead>
            <tbody>
              {(b.people || []).map(p => (
                <tr key={p.raw}>
                  <td>
                    <span className="sx-post__who"><InsiderLink raw={p.raw}>{p.name}</InsiderLink> <span><RoleTag role={p.role} title={p.title} name={p.raw} /></span></span>
                    {(p.stake || (p.flags || []).length > 0) && (
                      <span className="sx-post__flags">
                        {(p.flags || []).map(fl => <span key={fl} className={`sx-chip${/reversal/i.test(fl) ? ' sx-chip--rev' : ''}`}>{fl}</span>)}
                        {p.stake && <span className="sx-muted sx-small">{p.stake}</span>}
                      </span>
                    )}
                  </td>
                  <td className={`sx-r ${sell ? 'sx-down' : 'sx-up'}`}>{money(p.value)}</td>
                  <td className="sx-r">{shares(p.shares)}</td>
                  <td className="sx-r">{price(p.price)}</td>
                  <td>{p.first && p.last && p.first !== p.last ? `${shortDate(p.first)} to ${shortDate(p.last)}` : shortDate(p.last || p.first)}</td>
                  <td>{p.sec_url ? <a href={p.sec_url} target="_blank" rel="noreferrer" className="sx-link">Form 4 <Icon name="external" size={11} /></a> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {(b.context || []).length > 0 && (
        <section className="sx-post__sec">
          <h2>Context</h2>
          <ul>{b.context.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </section>
      )}
    </>
  );
}

// Where the trades happened inside the 52-week range, and where the stock is now.
function RangeBar({ r, sell }) {
  const at = v => `${Math.max(0, Math.min(100, v * 100)).toFixed(1)}%`;
  if (r.low == null || r.high == null) return null;
  return (
    <div className="sx-range" aria-label="52-week price range">
      <div className="sx-range__track">
        {r.avg_pos != null && <span className={`sx-range__mark sx-range__mark--${sell ? 'sell' : 'buy'}`} style={{ left: at(r.avg_pos) }} title={`${sell ? 'Sold' : 'Bought'} around ${price(r.avg)}`} />}
        {r.pos != null && <span className="sx-range__mark sx-range__mark--now" style={{ left: at(r.pos) }} title={`Now ${price(r.now)}`} />}
      </div>
      <div className="sx-range__ends"><span>52-wk low {price(r.low)}</span><span>high {price(r.high)}</span></div>
      <div className="sx-range__key">
        <span><i className={`sx-range__dot sx-range__dot--${sell ? 'sell' : 'buy'}`} />{sell ? 'Sold' : 'Bought'} around {price(r.avg)}</span>
        {r.now != null && <span><i className="sx-range__dot sx-range__dot--now" />Now {price(r.now)}</span>}
      </div>
    </div>
  );
}

const rangeTxt = p => (p == null ? '—' : `${p < 0.25 ? 'Near the low' : p >= 0.75 ? 'Near the high' : 'Mid-range'} (${Math.round(p * 100)}%)`);
const chgTxt = c => (c == null ? '' : Math.abs(c) < 0.05 ? ' (flat)' : ` (${c >= 0 ? '+' : ''}${c.toFixed(1)}%)`);

function RoundupBody({ b, cta }) {
  return (
    <>
      <p className="sx-post__lead">{b.lead}</p>
      {(b.buys || []).length > 0 && (
        <Card title="Biggest buying" sub="What they paid, where the stock is now, and where it sits in its 52-week range" pad={false}>
          <div className="sx-table-wrap">
            <table className="sx-table">
              <thead><tr><th>Stock</th><th className="sx-r">Insiders</th><th className="sx-r">Bought</th><th className="sx-r">Avg price</th><th className="sx-r">Now</th><th>52-wk range</th></tr></thead>
              <tbody>
                {b.buys.map(r => (
                  <tr key={r.ticker}>
                    <td><StockLink ticker={r.ticker} onClick={cta('roundup_stock')} /> <span className="sx-muted">{r.company}</span></td>
                    <td className="sx-r">{r.insiders}</td>
                    <td className="sx-r sx-up">{money(r.value)}</td>
                    <td className="sx-r">{price(r.avg_price)}</td>
                    <td className="sx-r">{r.now ? price(r.now) : '—'}<span className="sx-muted">{chgTxt(r.chg)}</span></td>
                    <td>{rangeTxt(r.range_pos)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {(b.sells || []).length > 0 && (
        <Card title="Biggest selling" sub="Planned means set up in advance under a 10b5-1 plan" pad={false}>
          <div className="sx-table-wrap">
            <table className="sx-table">
              <thead><tr><th>Stock</th><th className="sx-r">Insiders</th><th className="sx-r">Sold</th><th className="sx-r">Planned</th><th>52-wk range</th></tr></thead>
              <tbody>
                {b.sells.map(r => (
                  <tr key={r.ticker}>
                    <td><StockLink ticker={r.ticker} onClick={cta('roundup_stock')} /> <span className="sx-muted">{r.company}</span></td>
                    <td className="sx-r">{r.insiders}</td>
                    <td className="sx-r sx-down">{money(r.value)}</td>
                    <td className="sx-r">{r.planned} of {r.trades}</td>
                    <td>{rangeTxt(r.range_pos)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {b.method && <p className="sx-note">{b.method}</p>}
      <p className="sx-post__more">See every trade as it's filed on <a href="/insider-buying" onClick={e => { cta('insider_buying')(); navClick('/insider-buying')(e); }}>Insider buying this week</a>.</p>
    </>
  );
}

// ── "In the news" on stock and people pages ──────────────────────────────────
export function BlogMentions({ ticker, raw }) {
  const q = ticker ? `ticker=${encodeURIComponent(ticker)}` : `insider=${encodeURIComponent(raw || '')}`;
  const { data } = useApi(ticker || raw ? `/public/blog?${q}&limit=3` : null);
  const posts = data?.posts || [];
  if (!posts.length) return null;
  return (
    <Card title="In the news" sub="From the Seli blog" pad={false}>
      <ul className="sx-rows">
        {posts.map(p => (
          <li key={p.slug} className="sx-row">
            <div className="sx-row__main">
              <div className="sx-row__title"><a href={blogPath(p.slug)} onClick={e => { track('blog_mention_click', { slug: p.slug }); navClick(blogPath(p.slug))(e); }}>{p.title}</a></div>
              <div className="sx-row__sub">{shortDate(dayKey(p.published_at))}</div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
