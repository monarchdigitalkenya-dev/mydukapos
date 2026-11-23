// zip 288 — SEO: sitemap, robots, audit logic, Owner Console SEO API, home-page cards. Plain Node (no jsdom), so it runs anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeKV } from './kv-fake.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const APEX = 'https://mydukapos.store';
const ENV = { ROOT_DOMAIN: 'mydukapos.store' };
const R = (url, o = {}) => new Request(url, o);

// ---------- robots + sitemap ----------
test('sitemap.xml: valid, canonical https URLs only, no priority/changefreq, no private paths, same list on www', async () => {
  const sm = await load('functions/sitemap.xml.js'), { validateSitemapXml } = await load('functions/api/_seo-audit.js');
  const xml = await (await sm.onRequestGet({ request: R(APEX + '/sitemap.xml'), env: ENV })).text();
  const v = validateSitemapXml(xml, APEX);
  assert.ok(v.ok, v.errors.join('; '));
  assert.equal(v.urls.length, 19);   // zip 361: + /products/carwash
  assert.ok(!/<priority>|<changefreq>/.test(xml));
  assert.ok(!/<lastmod>/.test(xml), 'no invented dates');
  for (const bad of ['/owner', '/dashboard', '/api/', '/hotel', '/hospital', '/pharmacy', '/production', '/services', '/water', '/order', '/pay/', '/pesapal', '/app.html']) assert.ok(!xml.includes(`<loc>${APEX}${bad}`), bad);   // (/products/hotel is a public page; /hotel/ is the private app)
  const www = await (await sm.onRequestGet({ request: R('https://www.mydukapos.store/sitemap.xml'), env: ENV })).text();
  assert.equal(www, xml, 'www lists the apex (canonical) addresses');
  assert.ok(!www.includes('<loc>https://www.'));
  const pages = await (await sm.onRequestGet({ request: R('https://x.pages.dev/sitemap.xml'), env: ENV })).status;
  assert.equal(pages, 404, 'a preview host has no sitemap');
  assert.equal((await sm.onRequestGet({ request: R('https://george.mydukapos.store/sitemap.xml'), env: ENV })).status, 404, 'a shop host has none');
});

test('robots.txt: apex open with private paths disallowed and the canonical Sitemap line; shop hosts closed', async () => {
  const rb = await load('functions/robots.txt.js');
  const t = await (await rb.onRequestGet({ request: R(APEX + '/robots.txt'), env: ENV })).text();
  assert.match(t, /^User-agent: \*\nAllow: \//);
  assert.match(t, /Sitemap: https:\/\/mydukapos\.store\/sitemap\.xml\n$/);
  for (const p of ['/api/', '/owner/', '/dashboard.html']) assert.ok(t.includes('Disallow: ' + p), p);
  assert.ok(!/Disallow: \/\s*$/m.test(t), 'public site is not blocked');
  assert.ok(!/Disallow: \/(img|public-site|site\.css)/.test(t), 'assets needed for rendering stay crawlable');
  const www = await (await rb.onRequestGet({ request: R('https://www.mydukapos.store/robots.txt'), env: ENV })).text();
  assert.match(www, /Sitemap: https:\/\/mydukapos\.store\/sitemap\.xml/);
  assert.match(await (await rb.onRequestGet({ request: R('https://george.mydukapos.store/robots.txt'), env: ENV })).text(), /^User-agent: \*\nDisallow: \/\n$/);
});

test('validateSitemapXml rejects HTML fallbacks, wrong domains, http, duplicates, missing namespace', async () => {
  const { validateSitemapXml } = await load('functions/api/_seo-audit.js');
  assert.ok(!validateSitemapXml('<!DOCTYPE html><html></html>', APEX).ok);
  const ns = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
  const mk = (...locs) => `<?xml version="1.0"?><urlset ${ns}>${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;
  assert.ok(validateSitemapXml(mk(APEX + '/', APEX + '/faq'), APEX).ok);
  assert.match(validateSitemapXml(mk('https://evil.example/x'), APEX).errors.join(), /Wrong domain/);
  assert.match(validateSitemapXml(mk('http://mydukapos.store/x'), APEX).errors.join(), /absolute HTTPS/);
  assert.match(validateSitemapXml(mk(APEX + '/a', APEX + '/a'), APEX).errors.join(), /Duplicate/);
  assert.match(validateSitemapXml('<urlset><url><loc>' + APEX + '/</loc></url></urlset>', APEX).errors.join(), /namespace/);
});

// ---------- audit ----------
function fakeSite({ break: brk = {} } = {}) {
  const site = await_pages();
  return async (p) => {
    if (brk[p]) return brk[p];
    if (p === '/robots.txt') return { status: 200, headers: new Headers({ 'content-type': 'text/plain' }), text: 'User-agent: *\nAllow: /\nDisallow: /owner/\n\nSitemap: https://mydukapos.store/sitemap.xml\n' };
    if (p === '/sitemap.xml') return { status: 200, headers: new Headers({ 'content-type': 'application/xml' }), text: site.xml };
    if (site.pages[p]) return { status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: site.pages[p] };
    if (/^\/(owner|hotel|hospital|pharmacy|production|services|water|order|pay)\//.test(p) || p === '/dashboard.html' || p === '/pesapal-done.html') return { status: 200, headers: new Headers({ 'content-type': 'text/html', 'x-robots-tag': 'noindex, nofollow' }), text: '<html></html>' };
    return { status: 404, headers: new Headers({ 'content-type': 'text/html' }), text: 'nope' };
  };
}
function await_pages() {
  const { sitemapEntries } = SITE;
  const pages = {};
  sitemapEntries().forEach((e, i) => {
    const url = APEX + (e.path === '/' ? '/' : e.path);
    pages[e.path] = `<!doctype html><html lang="en"><head><title>Page ${i} — MyDukaPOS</title><meta name="description" content="A unique description for page number ${i} that is long enough to be useful to a searcher."><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="${url}"><meta property="og:title" content="t${i}"><meta property="og:description" content="d${i}"><meta property="og:url" content="${url}"><meta property="og:image" content="${APEX}/img/og-default.png"></head><body><h1>Heading ${i}</h1><p>${'text '.repeat(120)}</p><img src="/x.png" alt="x"></body></html>`;
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries().map((e) => `<url><loc>${APEX}${e.path === '/' ? '/' : e.path}</loc></url>`).join('\n')}\n</urlset>\n`;
  return { pages, xml };
}
let SITE, AUDIT;
test('audit: a healthy site has no critical/high issues, 19 eligible pages, 19 in sitemap, google state unknown', async () => {
  SITE = await load('functions/_site.js'); AUDIT = await load('functions/api/_seo-audit.js');
  const a = await AUDIT.runAudit({ env: ENV, fetcher: fakeSite(), now: 1 });
  assert.deepEqual(a.issues.filter((i) => ['critical', 'high'].includes(i.severity)), []);
  assert.equal(a.summary.eligibleIndexable, 19); assert.equal(a.summary.inSitemap, 19); assert.equal(a.summary.httpErrors, 0);
  assert.equal(a.summary.discoveredPublicRoutes, 19 + SITE.NOINDEX_PUBLIC.length, 'discovered counts the noindex public routes too, separately from eligible');
  for (const p of a.pages) { assert.equal(p.google.indexed, null); assert.equal(p.google.submitted, null); assert.equal(p.discovered, true); assert.equal(p.inSitemap, true); }
});

test('audit: catches noindex on an eligible page, wrong canonical, missing description, duplicate titles, soft 404, blocked robots, missing sitemap line, private page exposed', async () => {
  const base = await_pages();
  const html = (o) => base.pages['/faq'].replace(/<link rel="canonical"[^>]*>/, o.canonical ?? '<link rel="canonical" href="' + APEX + '/faq">').replace(/<meta name="description"[^>]*>/, o.noDesc ? '' : '$&').replace('<head>', '<head>' + (o.head || ''));
  const brk = {
    '/faq': { status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: html({ head: '<meta name="robots" content="noindex">' }) },
    '/contact': { status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: html({ canonical: '<link rel="canonical" href="' + APEX + '/">' }) },
    '/offers': { status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: base.pages['/offers'].replace(/<meta name="description"[^>]*>/, '') },
    '/robots.txt': { status: 200, headers: new Headers({ 'content-type': 'text/plain' }), text: 'User-agent: *\nDisallow: /\n' },
    '/owner/': { status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: '<html>open</html>' },
    '/seo-probe-1-does-not-exist': { status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: 'home again' },
  };
  const a = await AUDIT.runAudit({ env: ENV, fetcher: fakeSite({ break: brk }), now: 1 });
  const ids = a.issues.map((i) => i.id);
  for (const want of ['noindex:/faq', 'canon-diff:/contact', 'desc:/offers', 'robots:blocks', 'robots:sitemap', 'priv-idx:/owner/', 'soft404']) assert.ok(ids.includes(want), want + ' in ' + ids.join(','));
  assert.equal(a.issues[0].severity, 'critical', 'sorted most severe first');
  assert.equal(a.pages.find((p) => p.path === '/faq').indexable, false);
  // an issue present before and gone now is RESOLVED by re-checking, not by hand
  const fixed = await AUDIT.runAudit({ env: ENV, fetcher: fakeSite(), now: 2 });
  const d = AUDIT.diffIssues({ ...a, issues: a.issues.map((i) => ({ ...i, firstSeen: 'x' })) }, fixed, 'now');
  assert.equal(d.issues.length, 0); assert.ok(d.resolved.some((i) => i.id === 'noindex:/faq'));
});

test('audit: a sitemap that is an HTML app fallback is a critical problem', async () => {
  const a = await AUDIT.runAudit({ env: ENV, fetcher: fakeSite({ break: { '/sitemap.xml': { status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: '<!DOCTYPE html><html></html>' } } }), now: 1 });
  assert.ok(a.issues.some((i) => i.severity === 'critical' && i.url === '/sitemap.xml'));
});

// ---------- every public page, from the real files ----------
test('real public pages: title, description, canonical == own URL, viewport, lang; unique titles and descriptions; no image without alt', async () => {
  const { parsePage } = await load('functions/api/_seo-audit.js');
  const { sitemapEntries, PRODUCT_PAGES } = await load('functions/_site.js');
  const fileFor = (p) => p === '/' ? 'public-site/index.html' : PRODUCT_PAGES[p.replace('/products/', '')] ? null : `public-site${p}.html`;
  const titles = new Set(), descs = new Set();
  for (const e of sitemapEntries()) {
    const f = fileFor(e.path); if (!f) continue;                       // product pages get theirs from the middleware (tested below)
    const p = parsePage(read(f)), url = APEX + (e.path === '/' ? '/' : e.path);
    assert.ok(p.title && p.title.length > 10, e.path + ' title'); assert.ok(p.description && p.description.length >= 50, e.path + ' description');
    assert.equal(p.canonical, url, e.path + ' canonical'); assert.ok(p.viewport, e.path + ' viewport'); assert.equal(p.lang, 'en', e.path + ' lang');
    assert.equal(p.imagesWithoutAlt, 0, e.path + ' img alt');
    assert.ok(!titles.has(p.title), 'duplicate title ' + p.title); titles.add(p.title);
    assert.ok(!descs.has(p.description), 'duplicate description ' + e.path); descs.add(p.description);
    assert.ok(!/noindex/i.test(p.robotsMeta || ''), e.path + ' noindex');
  }
});

test('product pages: the served HTML has the real heading, summary, canonical, breadcrumb schema, og tags (not "Loading…")', async () => {
  const mw = await load('functions/_middleware.js'), { PRODUCT_PAGES } = await load('functions/_site.js'), { parsePage } = await load('functions/api/_seo-audit.js');
  const tpl = read('public-site/app.html');
  const env = { ...ENV, ASSETS: { fetch: async () => new Response(tpl, { status: 200, headers: { 'content-type': 'text/html' } }) } };
  const seen = new Set();
  for (const key of Object.keys(PRODUCT_PAGES)) {
    const res = await mw.onRequest({ request: R(`${APEX}/products/${key}`), env, next: async () => new Response('NEXT') });
    assert.equal(res.status, 200); const html = await res.text(), p = parsePage(html);
    assert.equal(p.canonical, `${APEX}/products/${key}`); assert.equal(p.h1, 1); assert.ok(html.includes(`<h1 id="p-name">${PRODUCT_PAGES[key].name.replace(/&/g, '&amp;')}</h1>`), key + ' h1'); assert.ok(!html.includes('<h1 id="p-name">Loading'), key);
    assert.ok(p.ldTypes.includes('SoftwareApplication') && p.ldTypes.includes('BreadcrumbList'), key + ' schema');
    assert.ok(p.ogTitle && p.ogImage && p.ogUrl, key + ' og'); assert.equal(p.imagesWithoutAlt, 0, key + ' alt');
    assert.ok(!seen.has(p.title) && !seen.has(p.description), key + ' unique'); seen.add(p.title); seen.add(p.description);
  }
  const unknown = await mw.onRequest({ request: R(`${APEX}/products/nope`), env, next: async () => new Response('NEXT', { status: 404 }) });
  assert.equal(unknown.status, 404, 'unknown product falls through to the 404 page');
});

test('private apps and consoles are never indexable: noindex in _headers, never in the sitemap', async () => {
  const h = read('_headers');
  for (const d of ['/owner/*', '/hotel/*', '/hospital/*', '/pharmacy/*', '/production/*', '/services/*', '/water/*', '/carwash/*', '/order/*', '/dashboard.html', '/pay/*']) assert.match(h, new RegExp(d.replace(/[*/.]/g, '\\$&') + '\\n  X-Robots-Tag: noindex'), d);
  for (const f of ['owner/index.html', 'hotel/index.html', 'hospital/index.html', 'order/index.html']) assert.match(read(f).slice(0, 3000), /<meta name="robots" content="noindex, nofollow">/, f);
});

// ---------- the home page's crawlable product cards ----------
test('home page: every product card is in the served HTML as a real link with a heading, photo alt and unique accent; cards are in sync with the generator', async () => {
  const html = read('public-site/index.html'), { PRODUCT_PAGES } = await load('functions/_site.js');
  const grid = html.slice(html.indexOf('<!--@cards:begin-->'), html.indexOf('<!--@cards:end-->'));
  for (const k of Object.keys(PRODUCT_PAGES)) assert.ok(grid.includes(`href="/products/${k}"`), k + ' link in static HTML');
  assert.equal((grid.match(/<h3 class="name">/g) || []).length, 8);   // zip 361: + Car Wash & Cleaning
  assert.equal((grid.match(/<img [^>]*alt="[^"]{20,}"/g) || []).length, 8, 'descriptive alt on every photo');
  assert.equal((grid.match(/loading="lazy"/g) || []).length, 8); assert.equal((grid.match(/width="1200" height="800"/g) || []).length, 8, 'image size reserved (no layout shift)');
  const gen = await load('tools/build-home-cards.mjs'); assert.equal(gen.build(), html, 'run `npm run build:cards`');
  const names = JSON.parse(read('public-site/product-cards.json')).cards.map((c) => c.key);
  assert.deepEqual(names, Object.keys(PRODUCT_PAGES), 'cards and product pages list the same products in the same order');
  assert.match(html, /prefers-reduced-motion: reduce/); assert.match(html, /\.app-card:focus-visible/); assert.match(html, /@media \(hover: hover\)/);
});

// ---------- Owner Console SEO API ----------
async function api({ method = 'POST', body, token = 'good', env = {}, fetchImpl } = {}) {
  const mod = await load('functions/api/owner-seo.js');
  const kv = env.mydukapos_kv || makeKV();
  const e = { ...ENV, mydukapos_kv: kv, ...env };
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) };
  const request = R(APEX + '/api/owner-seo', { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}) });
  const res = await (method === 'GET' ? mod.onRequestGet : mod.onRequestPost)({ request, env: e, fetchImpl });
  return { res, json: await res.json(), kv };
}
test('owner-seo: refuses everything without an owner session (GET and every POST action)', async () => {
  for (const action of ['audit', 'validate-sitemap', 'gsc-status', 'gsc-sitemaps', 'gsc-submit', 'gsc-performance', 'gsc-inspect', 'nope']) {
    const { res } = await api({ body: { action }, token: 'forged' });
    assert.equal(res.status, 401, action);
  }
  assert.equal((await api({ method: 'GET', token: null })).res.status, 401);
});

function ownerEnv() { const kv = makeKV(); kv.data.set('owner-session:good', { value: JSON.stringify({ at: Date.now() }) }); return kv; }
test('owner-seo: with a valid session — audit runs against the site and is stored; Google actions say "not connected" instead of inventing data', async () => {
  const { sitemapEntries } = await load('functions/_site.js'); SITE = await load('functions/_site.js');
  const site = await_pages();
  const fetchImpl = async (u) => {
    const p = new URL(u).pathname; const f = fakeSite();
    const r = await f(p);
    return new Response(r.text, { status: r.status, headers: r.headers });
  };
  const kv = ownerEnv();
  const auth = await load('functions/api/_owner-auth.js');
  // find the session prefix the real auth uses, so this test does not guess it
  const src = read('functions/api/_owner-auth.js'); const m = /SESSION_PREFIX\s*=\s*'([^']+)'/.exec(src); assert.ok(m, 'session prefix');
  kv.data.clear(); kv.data.set(m[1] + 'good', { value: '{"createdAt":1}' });
  const a = await api({ body: { action: 'audit' }, env: { mydukapos_kv: kv }, fetchImpl });
  assert.equal(a.res.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.audit.summary.inSitemap, sitemapEntries().length);
  assert.ok(kv.data.has('seo:last-audit'));
  const v = await api({ body: { action: 'validate-sitemap' }, env: { mydukapos_kv: kv }, fetchImpl });
  assert.equal(v.json.ok, true); assert.equal(v.json.urls, 19);
  const g = await api({ body: { action: 'gsc-sitemaps' }, env: { mydukapos_kv: kv }, fetchImpl });
  assert.equal(g.res.status, 409); assert.equal(g.json.code, 'not_configured');
  const st = await api({ body: { action: 'gsc-status' }, env: { mydukapos_kv: kv } });
  assert.equal(st.json.google.configured, false); assert.equal(st.json.google.property, 'sc-domain:mydukapos.store'); assert.ok(!JSON.stringify(st.json).includes('private_key'));
  const get = await api({ method: 'GET', env: { mydukapos_kv: kv } });
  assert.equal(get.json.sitemaps[0].url, APEX + '/sitemap.xml'); assert.equal(get.json.robotsUrl, APEX + '/robots.txt'); assert.ok(get.json.audit); assert.ok(get.json.log.length >= 2);
  assert.ok(!JSON.stringify(get.json.log).match(/Bearer|private_key|good/));
  const bad = await api({ body: { action: 'gsc-inspect', url: 'https://evil.example/' }, env: { mydukapos_kv: kv, GSC_SERVICE_ACCOUNT_JSON: '{"client_email":"a@b.iam","private_key":"x"}' }, fetchImpl });
  assert.equal(bad.res.status, 400, 'only the site\'s own URLs can be inspected');
});

test('owner-seo: the audit is rate-limited', async () => {
  const kv = makeKV(); const m = /SESSION_PREFIX\s*=\s*'([^']+)'/.exec(read('functions/api/_owner-auth.js')); kv.data.set(m[1] + 'good', { value: '{"createdAt":1}' });
  const fetchImpl = async (u) => { const r = await fakeSite()(new URL(u).pathname); return new Response(r.text, { status: r.status, headers: r.headers }); };
  let last;
  for (let i = 0; i < 22; i++) last = await api({ body: { action: 'validate-sitemap' }, env: { mydukapos_kv: kv }, fetchImpl });
  assert.equal(last.res.status, 429);
});

// ---------- Google client ----------
test('gsc client: reads use the read-only scope, only submit asks for read/write; secrets are validated, never echoed; ranges are clamped', async () => {
  const g = await load('functions/api/_gsc.js');
  assert.equal(g.gscConfig({}).reason, 'not_configured'); assert.equal(g.gscConfig({ GSC_SERVICE_ACCOUNT_JSON: 'nope' }).reason, 'secret_not_json'); assert.equal(g.gscConfig({ GSC_SERVICE_ACCOUNT_JSON: '{}' }).reason, 'secret_incomplete');
  const { privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pem = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64') + '\n-----END PRIVATE KEY-----\n';
  const env = { GSC_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'seo@proj.iam.gserviceaccount.com', private_key: pem }) };
  const calls = [];
  const f = async (url, o) => {
    calls.push({ url: String(url), method: o.method, body: String(o.body || '') });
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }));
    if (String(url).includes('/sitemaps') && o.method === 'GET') return new Response(JSON.stringify({ sitemap: [{ path: APEX + '/sitemap.xml', errors: '0', warnings: '0', contents: [{ type: 'web', submitted: '15' }] }] }));
    if (o.method === 'PUT') return new Response(null, { status: 204 });
    if (String(url).includes('searchAnalytics')) return new Response(JSON.stringify({ rows: [{ keys: ['x'], clicks: 3, impressions: 40, ctr: 0.075, position: 8.2 }] }));
    return new Response('{}');
  };
  const list = await g.listSitemaps(env, f);
  assert.equal(list[0].submittedUrls, 15); assert.equal(list[0].indexedUrls, null);
  const scopeOf = (c) => decodeURIComponent((c.body.match(/assertion=([^&]+)/) || [])[1] || '').split('.')[1];
  const tokenCalls = calls.filter((c) => c.url.includes('oauth2'));
  assert.match(Buffer.from(scopeOf(tokenCalls[0]), 'base64url').toString(), /webmasters\.readonly/);
  await g.submitSitemap(env, APEX + '/sitemap.xml', f);
  const rw = calls.filter((c) => c.url.includes('oauth2')).pop();
  assert.match(Buffer.from(scopeOf(rw), 'base64url').toString(), /auth\/webmasters"/);
  assert.ok(calls.find((c) => c.method === 'PUT').url.includes(encodeURIComponent('sc-domain:mydukapos.store')));
  const perf = await g.performance(env, { dimension: 'query; drop' }, f); assert.equal(perf.dimension, 'page'); assert.equal(perf.totals.clicks, 3);
  const r = g.clampRange('2020-01-01', '2026-10-10'); assert.ok(Date.parse(r.endDate) - Date.parse(r.startDate) <= 480 * 86400000);
  assert.ok(!JSON.stringify(list).includes('BEGIN PRIVATE'));
});

// ---------- nothing else was disturbed ----------
test('Owner Console: the SEO tab is wired (button, panel, loader, group) and the rest of the nav is intact', () => {
  const h = read('owner/index.html');
  for (const needle of ['id="seo-tab"', 'data-tab="seo-tab"', "if (tabId === 'seo-tab') loadSeo();", "'website-tab', 'seo-tab'", 'async function seoCopy', "fetch('/api/owner-seo'"]) assert.ok(h.includes(needle), needle);
  for (const t of ['health-tab', 'storage-tab', 'website-tab', 'billing-tab', 'settings-tab']) assert.ok(h.includes(`id="${t}"`), t);
});

// ---------- demo gallery photos ----------
test('demo gallery: every demo has a picture that exists (nine with webp photos or scenes, the service-business demos drawn svg), each with its svg fallback present', async () => {
  const mod = await load('functions/api/shared-demos.js');
  const res = await mod.onRequestGet({ request: R(APEX + '/api/shared-demos'), env: { ...ENV, mydukapos_kv: makeKV() } });
  const { demos } = await res.json();
  assert.equal(demos.length, 17);
  for (const d of demos) {
    const photo = ['retail', 'hotel', 'hospital', 'production', 'pharmacy', 'services', 'water', 'hardware', 'liquor', 'carwash'].includes(d.key);   // zip 361: the Car Wash app's own picture
    assert.equal(d.image, `/img/demo-${d.key}.${photo ? 'webp' : 'svg'}`, d.key);
    assert.ok(fs.existsSync(path.join(ROOT, 'public-site', d.image)), d.image + ' exists');
    assert.equal(d.fallback, `/img/demo-${d.key}.svg`); assert.ok(fs.existsSync(path.join(ROOT, 'public-site', d.fallback)));
    if (photo) { const b = fs.readFileSync(path.join(ROOT, 'public-site', d.image)); assert.equal(b.slice(0, 4).toString(), 'RIFF'); assert.equal(b.slice(8, 12).toString(), 'WEBP'); assert.ok(b.length > 10000 && b.length < 150000, d.key + ' size ' + b.length); }
  }
});
