// functions/sitemap.xml.js — GET /sitemap.xml. Zip 177; reworked zip 288.
// ONE flat <urlset>: the site has ~15 public pages, far below the 50,000-URL / 50 MB limit, so a sitemap index would only add a hop.
// Public marketing pages only (home, the product pages, offers, FAQ, contact, legal). Never the apps, the Owner Console, the CRM, dashboards,
// APIs or anything about a customer. Every <loc> uses the CANONICAL origin (canonicalOrigin), never the host the request happened to use,
// so https://www.mydukapos.store/sitemap.xml still lists https://mydukapos.store/... URLs. A client's own subdomain has no sitemap (404).
import { isApexRequest, sitemapEntries, canonicalOrigin } from './_site.js';

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildSitemapXml(origin, entries = sitemapEntries()) {
  const body = entries.map((e) => `  <url><loc>${esc(origin + (e.path === '/' ? '/' : e.path))}</loc>${e.lastmod ? `<lastmod>${esc(e.lastmod)}</lastmod>` : ''}</url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export async function onRequestGet({ request, env }) {
  if (!isApexRequest(request, env)) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  // 5 minutes at the edge: a new page or offer shows up quickly, and a crawler still never costs a function run per hit.
  return new Response(buildSitemapXml(canonicalOrigin(env)), { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
}
