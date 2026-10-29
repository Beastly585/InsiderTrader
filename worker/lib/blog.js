// worker/lib/blog.js
// seli.app/blog. Posts are written by db/blog_generate.py into
// public.blog_posts; this only reads them, plus the publish button.
//
//   GET  /public/blog?page=&q=&ticker=&insider=&kind=&limit=   the timeline (published only, newest first)
//   GET  /public/blog/post/:slug                       one post plus related posts
//   GET  /public/blog/post/:slug?preview=<token>       a draft, for the review email (never cached)
//   GET  /public/sitemap/blog.xml                      (via public.js)
//   GET  /blog/review?id=&t=                           review page: Publish / Reject buttons
//   POST /blog/review?id=&t=                           does it
//
// The review GET never changes anything: mail scanners open every link in an
// email, and a GET that published would put drafts live on its own.
//
// Until db/migrations/2026-10-28_blog.sql runs there's no table, and every
// route answers as if there were no posts yet.

const SITE = 'https://seli.app';
const PER_PAGE = 20;
const KINDS = ['buy', 'sell', 'roundup'];
const LIST_COLS = `id, slug, kind, ticker, company, insiders, tags, title, summary, amount, published_at, updated_at`;

const missingTable = e => /blog_posts/.test(e?.message || '') && /does not exist/.test(e?.message || '');

function listOut(r) {
  return {
    slug: r.slug, kind: r.kind, ticker: r.ticker || null, company: r.company || null,
    insiders: parse(r.insiders) || [], tags: r.tags || [], title: r.title, summary: r.summary,
    amount: r.amount == null ? null : Number(r.amount),
    published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}
function parse(v) {
  if (v == null || typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

// ── Timeline ─────────────────────────────────────────────────────────────────
export async function blogList(ctx, url) {
  const sv = ctx.deps.sqlVal;
  const page = Math.min(500, Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1));
  const limit = Math.min(PER_PAGE, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || PER_PAGE));
  const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 60);
  const ticker = (url.searchParams.get('ticker') || '').trim().toUpperCase().slice(0, 10);
  const kind = (url.searchParams.get('kind') || '').trim().toLowerCase();
  const where = [`status = 'published'`];
  if (KINDS.includes(kind)) where.push(`kind = ${sv(kind)}`);
  if (/^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    // A roundup mentions many stocks; it counts for any ticker in its tables.
    where.push(`(ticker = ${sv(ticker)} OR (kind = 'roundup' AND search ~ ${sv('\\m' + ticker.toLowerCase().replace(/[.\-]/g, '\\$&') + '\\M')}))`);
  }
  const insider = (url.searchParams.get('insider') || '').trim().slice(0, 200);
  if (insider) where.push(`insiders @> ${sv(JSON.stringify([{ raw: insider }]))}::jsonb`);
  // Every word has to appear somewhere (ticker, company, names, title).
  for (const w of q.split(/\s+/).filter(Boolean).slice(0, 6)) {
    where.push(`search LIKE ${sv('%' + w.replace(/[\\%_]/g, '\\$&') + '%')}`);
  }
  try {
    const [rows, [cnt]] = await Promise.all([
      ctx.db(`SELECT ${LIST_COLS} FROM public.blog_posts WHERE ${where.join(' AND ')}
               ORDER BY published_at DESC, id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`),
      ctx.db(`SELECT COUNT(*)::int AS n FROM public.blog_posts WHERE ${where.join(' AND ')}`),
    ]);
    const total = Number(cnt?.n) || 0;
    return { posts: rows.map(listOut), page, pages: Math.max(1, Math.ceil(total / limit)), total };
  } catch (e) {
    if (missingTable(e)) return { posts: [], page: 1, pages: 1, total: 0 };
    throw e;
  }
}

// ── One post ─────────────────────────────────────────────────────────────────
// preview: the draft's review token, so Kevin can read a draft on the real
// page before publishing it. Without it only published posts are found.
export async function blogPost(ctx, slug, preview = '') {
  const sv = ctx.deps.sqlVal;
  if (!/^[a-z0-9-]{1,160}$/.test(slug)) return { known: false };
  let rows;
  try {
    rows = await ctx.db(`SELECT ${LIST_COLS}, status, body, created_at FROM public.blog_posts
                          WHERE slug = ${sv(slug)} AND (status = 'published'${preview ? ` OR (status = 'draft' AND review_token = ${sv(preview)})` : ''})`);
  } catch (e) {
    if (missingTable(e)) return { known: false };
    throw e;
  }
  const r = rows[0];
  if (!r) return { known: false };
  const post = { ...listOut(r), body: parse(r.body) || {}, draft: r.status !== 'published',
                 created_at: r.created_at ? new Date(r.created_at).toISOString() : null };
  // Related: other posts on the same stock first, then the latest few.
  const related = await ctx.db(`
    (SELECT ${LIST_COLS}, 0 AS rank FROM public.blog_posts
      WHERE status = 'published' AND id <> ${Number(r.id)} AND ${r.ticker ? `ticker = ${sv(r.ticker)}` : 'FALSE'}
      ORDER BY published_at DESC LIMIT 4)
    UNION ALL
    (SELECT ${LIST_COLS}, 1 AS rank FROM public.blog_posts
      WHERE status = 'published' AND id <> ${Number(r.id)}
      ORDER BY published_at DESC LIMIT 6)`).catch(() => []);
  const seen = new Set();
  const rel = [];
  for (const x of related) {
    if (seen.has(x.slug)) continue;
    seen.add(x.slug);
    rel.push({ ...listOut(x), same_stock: Number(x.rank) === 0 });
  }
  return { known: true, post, related: rel.slice(0, 5) };
}

// ── Sitemap ──────────────────────────────────────────────────────────────────
export async function blogSitemap(ctx, urlset) {
  let rows = [];
  try {
    rows = await ctx.db(`SELECT slug, GREATEST(published_at, updated_at) AS mod FROM public.blog_posts
                          WHERE status = 'published' ORDER BY published_at DESC LIMIT 5000`);
  } catch (e) { if (!missingTable(e)) throw e; }
  const day = d => (d ? new Date(d).toISOString().slice(0, 10) : null);
  return urlset([
    { loc: `${SITE}/blog`, lastmod: day(rows[0]?.mod) || new Date().toISOString().slice(0, 10) },
    ...rows.map(r => ({ loc: `${SITE}/blog/${r.slug}`, lastmod: day(r.mod) })),
  ]);
}

// ── Review (from the draft email) ────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(title, bodyHtml) {
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · Seli</title></head>
<body style="margin:0;background:#F3F4F6;font-family:Inter,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;">
<div style="max-width:520px;margin:48px auto;padding:0 16px;">
<div style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">
<div style="height:4px;background:linear-gradient(90deg,#5A4FE8,#4338C9 60%,#3FBFA0);"></div>
<div style="padding:28px 26px;">
<div style="font-weight:800;font-size:18px;letter-spacing:-.3px;margin-bottom:18px;">Seli blog</div>
${bodyHtml}
</div></div></div></body></html>`, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

const P = (html, size = 14, color = '#111827') => `<p style="font-size:${size}px;line-height:1.6;color:${color};margin:0 0 10px;">${html}</p>`;

export async function handleBlogReview(request, env, url, { neonFetch, sqlVal, forgetBlog }) {
  const id = parseInt(url.searchParams.get('id'), 10);
  const token = url.searchParams.get('t') || '';
  const bad = () => page('Link not valid', P("That review link doesn't match a post. It may have been regenerated; check the latest email."));
  if (!id || !/^[A-Za-z0-9_\-]{16,64}$/.test(token)) return bad();
  const find = async () => {
    const r = await neonFetch(env, `SELECT id, slug, status, title, summary, tags, review_token FROM public.blog_posts WHERE id = ${id}`);
    const row = (r.rows || [])[0];
    if (!row || !row.review_token) return null;
    // Constant-time compare.
    const a = String(row.review_token), b = token;
    let diff = a.length !== b.length ? 1 : 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0 ? row : null;
  };
  let row;
  try { row = await find(); } catch (e) {
    console.error('[Worker] blog review lookup failed:', e.message);
    return page('Something broke', P("Couldn't load that post. Try again in a minute."));
  }
  if (!row) return bad();

  const live = `${SITE}/blog/${row.slug}`;
  const preview = `${live}?preview=${encodeURIComponent(token)}`;
  const self = `${url.pathname}?${url.searchParams.toString()}`;
  const btn = (label, action, primary) => `<form method="POST" action="${esc(self)}" style="display:inline-block;margin:14px 10px 0 0;">
<input type="hidden" name="action" value="${action}">
<button type="submit" style="font:600 14px Inter,Arial,sans-serif;padding:11px 20px;border-radius:8px;border:${primary ? '0' : '1px solid #E5E7EB'};background:${primary ? '#5A4FE8' : '#fff'};color:${primary ? '#fff' : '#111827'};cursor:pointer;">${label}</button></form>`;
  const head = P(`<b>${esc(row.title)}</b>`, 16) + P(esc(row.summary), 13, '#6B7280');

  if (request.method === 'GET') {
    if (row.status === 'published') {
      return page('Already live', head + P(`It's live: <a href="${esc(live)}" style="color:#5A4FE8;">${esc(live.replace('https://', ''))}</a>`) + btn('Take it down', 'reject', false));
    }
    if (row.status === 'rejected') {
      return page('Rejected', head + P('You turned this one down. It stays off the blog and the generator won\'t rewrite it.', 13, '#6B7280') + btn('Publish it after all', 'publish', true));
    }
    return page('Review draft', head
      + P(`<a href="${esc(preview)}" style="color:#5A4FE8;">Read the full draft on the site</a> (only this link shows it).`, 13)
      + btn('Publish', 'publish', true) + btn('Reject', 'reject', false));
  }
  if (request.method !== 'POST') return page('Review', P('Method not allowed.'));

  let action = '';
  try { action = String((await request.formData()).get('action') || ''); } catch {}
  if (action !== 'publish' && action !== 'reject') return page('Review', P('Nothing to do.'));
  try {
    await neonFetch(env, action === 'publish'
      ? `UPDATE public.blog_posts SET status = 'published', published_at = COALESCE(published_at, now()), updated_at = now() WHERE id = ${id} AND review_token = ${sqlVal(token)}`
      : `UPDATE public.blog_posts SET status = 'rejected', updated_at = now() WHERE id = ${id} AND review_token = ${sqlVal(token)}`);
  } catch (e) {
    console.error('[Worker] blog review update failed:', e.message);
    return page('Something broke', P("Couldn't save that. Try again in a minute."));
  }
  forgetBlog?.();
  if (action === 'publish') {
    return page('Published', head + P(`Live at <a href="${esc(live)}" style="color:#5A4FE8;">${esc(live.replace('https://', ''))}</a>. It shows on the blog within a minute.`) + btn('Undo (take it down)', 'reject', false));
  }
  return page('Rejected', head + P("Done. It won't show on the blog and won't be rewritten.", 13, '#6B7280'));
}
