// /sitemap.xml — sitemap index, built by the Worker from the search index.
import { proxyXml } from '../edge/sitemap.js';
export const onRequestGet = context => proxyXml(context, '/public/sitemap.xml');
