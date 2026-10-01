// /sitemap/stocks.xml, /sitemap/congress.xml, /sitemap/insiders-1.xml, ...
import { proxyXml } from '../../edge/sitemap.js';
export function onRequestGet(context) {
  const name = String(context.params.name || '');
  if (!/^[a-z0-9-]{1,20}\.xml$/.test(name)) return new Response('Not found', { status: 404 });
  return proxyXml(context, `/public/sitemap/${name}`);
}
