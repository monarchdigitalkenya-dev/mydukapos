// functions/sitemap.xml.js — GET /sitemap.xml. Zip 177.
// Public marketing pages only (home, the product pages, offers, FAQ, contact, legal). Never the apps, the Owner Console, the CRM, dashboards,
// APIs or anything about a customer. URLs use the host the request came in on, so they are always the canonical ones. A client's own subdomain
// has no sitemap (404): it is not meant to be indexed.
import { isApexRequest, sitemapEntries } from './_site.js';

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export async function onRequestGet({ request, env }) {
  if (!isApexRequest(request, env)) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const origin = new URL(request.url).origin;
  const body = sitemapEntries().map((e) => `  <url><loc>${esc(origin + (e.path === '/' ? '/' : e.path))}</loc><changefreq>${e.changefreq}</changefreq><priority>${e.priority}</priority></url>`).join('\n');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}
