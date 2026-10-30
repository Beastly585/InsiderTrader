// /sitemap/stocks.xml, /sitemap/insiders.xml, /sitemap/blog.xml, /sitemap/news.xml, ...
import { proxyXml } from '../../edge/sitemap.js';

// How long the edge keeps each one. The news sitemap only lists the last two
// days of posts, so it has to be close to live; the blog within the hour; the
// stock and people lists change slowly.
const MAX_AGE = { 'news.xml': 300, 'blog.xml': 1800 };

export function onRequestGet(context) {
  const name = String(context.params.name || '');
  if (!/^[a-z0-9-]{1,20}\.xml$/.test(name)) return new Response('Not found', { status: 404 });
  return proxyXml(context, `/public/sitemap/${name}`, MAX_AGE[name] || 21600);
}
