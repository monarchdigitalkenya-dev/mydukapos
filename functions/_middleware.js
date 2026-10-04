// functions/_middleware.js — Cloudflare Pages Function, runs on EVERY request
//
// Distinguishes the bare apex domain (mydukapos.store, no subdomain) from
// every client's own subdomain (georgehardware.mydukapos.store) — both
// reach this same Pages deployment, but should show completely different
// content. A client subdomain must keep showing that client's Shop POS app
// exactly as it always has; only the bare apex (or www) gets the new public
// marketing site instead.
//
// Deliberately reuses the EXACT SAME hostname/subdomain-detection logic
// already used by every API route (see api/_license.js's resolveClientId)
// rather than a second, separately-written copy that could drift out of
// sync and misclassify a request differently than the API layer does — the
// definition of "is this the apex" must never disagree between the two.
//
// Scoped as narrowly as possible on purpose: only a plain GET at the exact
// root path "/" is ever considered for interception. Every API call (under
// /api/), every static asset, every other path, and — critically — every
// client subdomain's own "/" falls straight through to next() completely
// untouched. Getting this condition wrong in either direction either hides
// the new public site or, far worse, breaks an existing client's link.

import { LEGAL_PAGES, APEX_PAGES, APEX_FILES, PRODUCT_PAGES, SITE_NAME, isApexRequest } from './_site.js';

// `wrangler pages deploy .` uploads the WHOLE project folder as public files, so without this the live site would serve the source of the
// tests, the shared code, the tools, the design notes (SYNC_AUTH_DESIGN.md describes exactly which endpoints a leaked link exposes),
// package.json and wrangler.toml to anyone who asks. None of those are needed by a browser, so they answer 404. The apps, icons,
// manifests, service workers and the public site are untouched.
// zip 186: also the migrations (SQL), docs, and the backup / sql folders (database exports hold every shop's data): never downloadable.
const INTERNAL_DIRS = /^\/(tests|src|tools|wildcard-router|functions|node_modules|\.git|\.github|\.wrangler|docs|migrations|migrations-optional|backup|backups|sql)(\/|$)/i;
// ... and database / backup / script files wherever they sit (a stray export dropped into any folder), except under /api/.
const INTERNAL_EXT = /\.(sql|bak|zip|cmd|bat|sqlite3?|db|dump|tar|gz|log)$/i;
const INTERNAL_FILES = /^\/(?:[^/]+\.md|package(?:-lock)?\.json|wrangler(?:\.[a-z]+)?\.toml|\.gitignore|\.gitattributes|\.dev\.vars|\.env.*)$/i;
export function isInternalPath(pathname) {
  let p = pathname;
  try { p = decodeURIComponent(pathname); } catch (e) { /* keep as is */ }
  return INTERNAL_DIRS.test(p) || INTERNAL_FILES.test(p) || (!/^\/api\//i.test(p) && INTERNAL_EXT.test(p));
}

// zip 177 — clean URLs for the public site, and "do not index the POS".
//   * /terms /privacy /cookies /acceptable-use answer on EVERY host (a client's own subdomain links to them from its sign-up screen).
//   * /faq /contact /offers, /products/<id> and the files the marketing pages load (/app.html, /dashboard.html, /site.css, /img/...) answer on the
//     apex only. They live in /public-site/; the apex used to serve only "/" from there, so the relative links on those pages had nothing at the
//     root to point at.
//   * Every other host (a client's shop) gets `X-Robots-Tag: noindex, nofollow` on its pages: a shop's POS is private and must never be searchable.
const servePublic = (env, request, file) => env.ASSETS.fetch(new Request(new URL('/public-site/' + file, request.url), request));

// /products/<id>: app.html with this product's own title, description, canonical URL and structured data (the page itself is filled in by script).
async function serveProductPage(env, request, key) {
  const res = await servePublic(env, request, 'app.html');
  if (!res || res.status !== 200) return res;
  const p = PRODUCT_PAGES[key];
  const origin = new URL(request.url).origin;
  const url = `${origin}/products/${key}`;
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const title = `${p.name} — ${SITE_NAME}, point of sale for Kenyan business`;
  const ld = { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: p.name, applicationCategory: 'BusinessApplication', operatingSystem: 'Android, iOS, Windows, any modern browser', description: p.description, url, publisher: { '@type': 'Organization', name: SITE_NAME, url: origin } };
  const tags = [
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta name="description" content="${esc(p.description)}">`,
    `<meta property="og:type" content="website"><meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(p.description)}">`,
    `<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(origin + '/img/og-default.png')}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
  ].join('\n');
  let html = await res.text();
  html = html.replace('<!--@seo-->', tags).replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  const headers = new Headers(res.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.delete('Content-Length'); headers.delete('ETag');
  return new Response(html, { status: 200, headers });
}

export async function onRequest(context) {
  const { request, env, next } = context;

  if (isInternalPath(new URL(request.url).pathname)) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return next();

  const url = new URL(request.url);
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  // legal pages: every host
  if (path in LEGAL_PAGES && env.ASSETS) return servePublic(env, request, LEGAL_PAGES[path] + '.html');

  // the legal pages' stylesheet, on every host too (they are linked from a client's own sign-up screen)
  if (path === '/site.css' && env.ASSETS) return servePublic(env, request, 'site.css');

  // anything that is not "/" and not a public-site path goes straight on (the apex and a client subdomain both) — but a client's own pages are
  // marked noindex on the way out
  const needsApex = path === '/' || path in APEX_PAGES || path.startsWith('/products/') || path.startsWith('/shop/') || APEX_FILES.test(path);
  if (!needsApex) return noindexIfShop(request, env, await next());

  if (!isApexRequest(request, env)) return noindexIfShop(request, env, await next());

  // Served as a plain static-asset fetch, not a redirect — the address bar keeps showing the clean apex URL rather than jumping to /public-site/.
  if (path === '/') return servePublic(env, request, 'index.html');
  if (path in APEX_PAGES) return servePublic(env, request, APEX_PAGES[path] + '.html');
  if (path.startsWith('/shop/')) return servePublic(env, request, 'shop.html');            // the storefront's own routes: /shop/p/<item>, /shop/s/<system>
  if (path.startsWith('/products/')) {
    const key = decodeURIComponent(path.slice('/products/'.length));
    if (Object.prototype.hasOwnProperty.call(PRODUCT_PAGES, key)) return serveProductPage(env, request, key);
    return next();                                                                    // unknown product: the branded 404 page
  }
  return servePublic(env, request, path.slice(1));                                    // /app.html, /dashboard.html, /site.css, /img/...
}

// A client's shop (any host that is not the apex) must not be searchable.
async function noindexIfShop(request, env, res) {
  try {
    if (!res || res.status === 101 || res.webSocket) return res;
    if (isApexRequest(request, env)) return res;
    const ct = res.headers.get('Content-Type') || '';
    if (!/text\/html/i.test(ct)) return res;
    const out = new Response(res.body, res);
    out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return out;
  } catch (e) { return res; }
}
