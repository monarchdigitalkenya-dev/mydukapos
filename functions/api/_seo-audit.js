// functions/api/_seo-audit.js — shared helper, NOT a route (zip 288).
//
// The Owner Console's SEO audit. Pure logic: it is handed a `fetcher(path)` (the real site in production, a fake in tests) and returns a page
// inventory plus a list of issues. Nothing here talks to Google. It keeps four states apart, because they are NOT the same thing:
//   discovered   — the application serves this public URL            (known here)
//   inSitemap    — sitemap.xml lists it                                 (known here)
//   google.*     — submitted / crawled / indexed by Google              (NOT known here: only Search Console says; reported as null until it does)
// Nothing in this file may claim a page is "indexed".

import { sitemapEntries, NOINDEX_PUBLIC, PRIVATE_PATHS, canonicalOrigin } from '../_site.js';

export const SEVERITY = ['critical', 'high', 'medium', 'low'];

const decode = (t) => String(t == null ? '' : t).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const attr = (tag, name) => { const m = new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i').exec(tag); return m ? decode(m[2] != null ? m[2] : m[3]) : null; };

// What a crawler sees in the FIRST response (before any script runs).
export function parsePage(html) {
  const h = String(html || '');
  // markup that only exists inside <script> (templates the page draws later) is not part of what a crawler's first response contains
  const hs = h.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const metas = (h.match(/<meta\b[^>]*>/gi) || []);
  const metaBy = (key, val) => { for (const m of metas) if ((attr(m, key) || '').toLowerCase() === val) return attr(m, 'content'); return null; };
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h) || [])[1];
  const links = (h.match(/<link\b[^>]*>/gi) || []);
  const canon = links.find((l) => (attr(l, 'rel') || '').toLowerCase() === 'canonical');
  const body = (/<body[\s\S]*$/i.exec(h) || [h])[0];
  const text = body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const imgs = (hs.match(/<img\b[^>]*>/gi) || []);
  const ld = [];
  for (const m of h.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const j = JSON.parse(m[1]); (Array.isArray(j) ? j : j['@graph'] ? j['@graph'] : [j]).forEach((n) => ld.push(n && n['@type'])); } catch (e) { ld.push('INVALID_JSON'); }
  }
  return {
    title: title == null ? null : decode(title),
    description: metaBy('name', 'description'),
    canonical: canon ? attr(canon, 'href') : null,
    robotsMeta: metaBy('name', 'robots'),
    viewport: metaBy('name', 'viewport'),
    lang: (/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(h) || [])[1] || null,
    h1: (hs.match(/<h1[\s>]/gi) || []).length,
    ogTitle: metaBy('property', 'og:title'), ogDescription: metaBy('property', 'og:description'), ogImage: metaBy('property', 'og:image'), ogUrl: metaBy('property', 'og:url'),
    twitterCard: metaBy('name', 'twitter:card'),
    ldTypes: ld.filter(Boolean),
    images: imgs.length, imagesWithoutAlt: imgs.filter((i) => attr(i, 'alt') == null).length,
    textChars: text.length,
    internalLinks: (hs.match(/<a\b[^>]*\bhref\s*=\s*["']\/(?!\/)[^"']*["']/gi) || []).length,
  };
}

// Strict-enough sitemap check: namespace, well-formed <url><loc>, https + canonical origin, no duplicates, protocol limits.
export function validateSitemapXml(xml, origin) {
  const errors = [], warnings = [], urls = [];
  const x = String(xml || '');
  if (/^\s*<!doctype html|^\s*<html/i.test(x)) return { ok: false, errors: ['The response is an HTML page, not XML (an app fallback is answering this address).'], warnings, urls };
  if (!/^\s*<\?xml[^>]*\?>/i.test(x)) warnings.push('No XML declaration at the top.');
  const isIndex = /<sitemapindex\b/i.test(x);
  if (!/xmlns\s*=\s*["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["']/.test(x)) errors.push('Missing the sitemap namespace http://www.sitemaps.org/schemas/sitemap/0.9.');
  if (!isIndex && !/<urlset\b/i.test(x)) errors.push('Missing <urlset>.');
  const open = (x.match(/<url>/gi) || []).length, close = (x.match(/<\/url>/gi) || []).length;
  if (open !== close) errors.push('Unbalanced <url> elements.');
  const seen = new Set();
  for (const m of x.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/gi)) {
    const u = decode(m[1]); urls.push(u);
    if (!/^https:\/\//i.test(u)) errors.push('Not an absolute HTTPS URL: ' + u);
    else if (origin && !u.startsWith(origin + '/') && u !== origin) errors.push('Wrong domain (expected ' + origin + '): ' + u);
    if (seen.has(u)) errors.push('Duplicate URL: ' + u); seen.add(u);
    if (/[?#]/.test(u)) warnings.push('URL has a query string or fragment: ' + u);
  }
  if (!urls.length) errors.push('No <loc> entries.');
  if (urls.length > 50000) errors.push('More than 50,000 URLs in one file.');
  if (x.length > 50 * 1024 * 1024) errors.push('Larger than 50 MB uncompressed.');
  if (/<priority>|<changefreq>/i.test(x)) warnings.push('Uses <priority>/<changefreq>, which Google ignores.');
  return { ok: !errors.length, errors, warnings, urls, type: isIndex ? 'index' : 'urlset' };
}

const issue = (id, severity, url, title, detail, fix) => ({ id, severity, url, title, detail, fix });

// Issues for ONE eligible page, from what was fetched.
export function auditPage(path, expectedUrl, r, p) {
  const out = [], u = path;
  if (r.status !== 200) out.push(issue('status:' + u, 'critical', u, 'Page does not answer 200', `HTTP ${r.status}${r.location ? ' → ' + r.location : ''}. Only 200 pages belong in the sitemap.`, 'Fix the route or remove it from the sitemap list in functions/_site.js.'));
  if (!p) return out;
  const xr = (r.xRobots || '').toLowerCase(), mr = (p.robotsMeta || '').toLowerCase();
  if (/noindex/.test(xr) || /noindex/.test(mr)) out.push(issue('noindex:' + u, 'critical', u, 'Eligible page is marked noindex', 'It is listed for search but tells Google not to index it.', 'Remove the noindex, or take the page out of the sitemap.'));
  if (!p.title) out.push(issue('title:' + u, 'high', u, 'Missing <title>', '', 'Add a unique, descriptive title.'));
  else if (p.title.length > 70) out.push(issue('title-long:' + u, 'low', u, 'Title longer than ~70 characters', `${p.title.length} characters; Google may cut it.`, 'Shorten the title.'));
  if (!p.description) out.push(issue('desc:' + u, 'high', u, 'Missing meta description', '', 'Add a description written for this page.'));
  else if (p.description.length < 50 || p.description.length > 170) out.push(issue('desc-len:' + u, 'low', u, 'Meta description length', `${p.description.length} characters (50–170 reads best in results).`, 'Rewrite it to a sentence or two.'));
  if (!p.canonical) out.push(issue('canon:' + u, 'high', u, 'Missing canonical URL', '', `Add <link rel="canonical" href="${expectedUrl}">.`));
  else if (p.canonical !== expectedUrl) out.push(issue('canon-diff:' + u, 'high', u, 'Canonical points somewhere else', `Page says ${p.canonical}; expected ${expectedUrl}.`, 'Make the canonical equal to the page\'s own clean URL (or drop the page from the sitemap if it is a duplicate).'));
  if (p.h1 === 0) out.push(issue('h1:' + u, p.textChars < 400 ? 'high' : 'medium', u, 'No <h1> in the HTML a crawler first receives', p.textChars < 400 ? 'The first response has almost no text: the content is drawn by script. Google can render it, but later and less reliably.' : 'The heading is added by script.', 'Put the main heading and key text in the served HTML.'));
  else if (p.h1 > 1) out.push(issue('h1-many:' + u, 'low', u, `${p.h1} <h1> elements`, '', 'Keep one primary heading per page.'));
  if (!p.ogTitle || !p.ogDescription || !p.ogUrl) out.push(issue('og:' + u, 'medium', u, 'Incomplete Open Graph tags', 'Shared links will not preview well.', 'Add og:title, og:description, og:url and og:image.'));
  else if (!p.ogImage) out.push(issue('og-img:' + u, 'low', u, 'No og:image', '', 'Add a 1200×630 image.'));
  if (p.imagesWithoutAlt) out.push(issue('alt:' + u, 'medium', u, `${p.imagesWithoutAlt} image(s) without an alt attribute`, '', 'Add descriptive alt text (alt="" only for purely decorative images).'));
  if (!p.viewport) out.push(issue('viewport:' + u, 'medium', u, 'No viewport meta tag', '', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.'));
  if (!p.lang) out.push(issue('lang:' + u, 'low', u, 'No lang attribute on <html>', '', 'Add lang="en".'));
  if (p.ldTypes.includes('INVALID_JSON')) out.push(issue('ld:' + u, 'high', u, 'Structured data is not valid JSON', '', 'Fix the JSON-LD block.'));
  return out;
}

// The whole audit. fetcher(path, opts?) -> { status, headers: {get}|plain, text } ; it must NOT follow redirects (so redirects are seen).
export async function runAudit({ env, fetcher, entries = sitemapEntries(), now = Date.now() }) {
  const origin = canonicalOrigin(env);
  const issues = [], pages = [];
  const read = async (path) => {
    try {
      const res = await fetcher(path);
      const hv = (n) => (res.headers && (res.headers.get ? res.headers.get(n) : res.headers[n])) || '';
      return { status: res.status, location: hv('location'), contentType: hv('content-type'), xRobots: hv('x-robots-tag'), text: res.text != null ? res.text : (typeof res.text === 'function' ? await res.text() : '') };
    } catch (e) { return { status: 0, error: String(e && e.message || e), text: '', location: '', contentType: '', xRobots: '' }; }
  };

  // robots.txt + sitemap.xml
  const robots = await read('/robots.txt'), sm = await read('/sitemap.xml');
  const rob = { status: robots.status, hasSitemapLine: new RegExp('^Sitemap:\\s*' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/sitemap\\.xml\\s*$', 'mi').test(robots.text), blocksAll: /^Disallow:\s*\/\s*$/mi.test(robots.text), isText: /text\/plain/i.test(robots.contentType) };
  if (robots.status !== 200 || !rob.isText) issues.push(issue('robots:status', 'critical', '/robots.txt', 'robots.txt is not served as plain text', `HTTP ${robots.status}, ${robots.contentType || 'no content type'}.`, 'Check functions/robots.txt.js and that no redirect/fallback answers this path.'));
  if (rob.blocksAll) issues.push(issue('robots:blocks', 'critical', '/robots.txt', 'robots.txt blocks the whole site', 'Disallow: / on the public domain keeps Google out.', 'Remove it: only private paths should be disallowed.'));
  if (!rob.hasSitemapLine) issues.push(issue('robots:sitemap', 'high', '/robots.txt', 'robots.txt does not name the sitemap', `Expected "Sitemap: ${origin}/sitemap.xml".`, 'Add the Sitemap line.'));

  const smv = sm.status === 200 ? validateSitemapXml(sm.text, origin) : { ok: false, errors: ['HTTP ' + sm.status], warnings: [], urls: [] };
  if (!/xml/i.test(sm.contentType) && sm.status === 200) smv.errors.push('Content-Type is not XML (' + (sm.contentType || 'none') + ').');
  smv.ok = smv.ok && !smv.errors.length;
  smv.errors.forEach((e, i) => issues.push(issue('sitemap:err' + i, 'critical', '/sitemap.xml', 'Sitemap problem', e, 'Fix functions/sitemap.xml.js / functions/_site.js.')));
  const inSitemap = new Set(smv.urls);

  // every eligible page, a few at a time
  const eligible = entries.map((e) => ({ path: e.path, group: e.group, url: origin + (e.path === '/' ? '/' : e.path) }));
  const results = [];
  for (let i = 0; i < eligible.length; i += 4) results.push(...await Promise.all(eligible.slice(i, i + 4).map(async (e) => ({ e, r: await read(e.path) }))));
  const titles = new Map(), descs = new Map();
  for (const { e, r } of results) {
    const p = r.status === 200 ? parsePage(r.text) : null;
    const pi = auditPage(e.path, e.url, r, p);
    if (p && p.title) titles.set(p.title, (titles.get(p.title) || []).concat(e.path));
    if (p && p.description) descs.set(p.description, (descs.get(p.description) || []).concat(e.path));
    pages.push({ path: e.path, url: e.url, group: e.group, status: r.status, title: p && p.title, description: p && p.description, canonical: p && p.canonical, robots: p ? ((r.xRobots || '') + ' ' + (p.robotsMeta || '')).trim() || 'index, follow (default)' : null, indexable: !!p && !/noindex/i.test((r.xRobots || '') + (p.robotsMeta || '')) && r.status === 200 && (!p.canonical || p.canonical === e.url), h1: p && p.h1, structuredData: p && p.ldTypes, imagesWithoutAlt: p && p.imagesWithoutAlt, textChars: p && p.textChars,
      discovered: true, inSitemap: inSitemap.has(e.url), problems: pi.map((x) => x.id), google: { submitted: null, crawled: null, indexed: null, note: 'Only Search Console knows this.' } });
    issues.push(...pi);
  }
  for (const [map, what, id] of [[titles, 'title', 'dup-title'], [descs, 'meta description', 'dup-desc']]) for (const [val, paths] of map) if (paths.length > 1) issues.push(issue(`${id}:${paths.join(',')}`, 'medium', paths.join(', '), `Duplicate ${what}`, `${paths.length} pages share: "${val.slice(0, 80)}"`, `Give each page its own ${what}.`));
  for (const pg of pages) if (!pg.inSitemap && pg.status === 200) issues.push(issue('notinsm:' + pg.path, 'high', pg.path, 'Eligible page missing from sitemap.xml', '', 'Check functions/_site.js sitemapEntries().'));
  for (const u of smv.urls) if (!eligible.some((e) => e.url === u)) issues.push(issue('smextra:' + u, 'high', u, 'Sitemap lists a URL the audit does not consider eligible', '', 'Remove it from sitemap.xml or add it to the eligible list.'));

  // private areas must never be offered to search
  const priv = [];
  for (const path of PRIVATE_PATHS.filter((p) => !p.startsWith('/api/')).slice(0, 8)) {
    const r = await read(path); const noindex = /noindex/i.test(r.xRobots) || /noindex/i.test(r.text.slice(0, 4000));
    const row = { path, status: r.status, noindex, listedInSitemap: smv.urls.some((u) => u.endsWith(path)) };
    priv.push(row);
    if (row.listedInSitemap) issues.push(issue('priv-sm:' + path, 'critical', path, 'Private path is listed in the sitemap', '', 'Remove it immediately.'));
    if (r.status === 200 && !noindex) issues.push(issue('priv-idx:' + path, 'high', path, 'Private page is reachable without a noindex signal', 'robots.txt alone does not keep a URL out of Google.', 'Add X-Robots-Tag: noindex in _headers / middleware.'));
  }

  // a nonexistent URL must be a real 404, not a 200 page
  const probe = await read('/seo-probe-' + now.toString(36) + '-does-not-exist');
  if (probe.status === 200) issues.push(issue('soft404', 'high', '/(unknown)', 'Unknown addresses answer 200 (soft 404)', 'A made-up URL returned a normal page.', 'Make the fallback return HTTP 404.'));
  else if (probe.status !== 404) issues.push(issue('probe404', 'medium', '/(unknown)', 'Unknown addresses do not answer 404', `HTTP ${probe.status}.`, 'Return 404 for unknown paths.'));

  issues.sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
  const counts = Object.fromEntries(SEVERITY.map((s) => [s, issues.filter((i) => i.severity === s).length]));
  return {
    ranAt: new Date(now).toISOString(), origin,
    summary: {
      discoveredPublicRoutes: pages.length + NOINDEX_PUBLIC.length, eligibleIndexable: pages.filter((p) => p.indexable).length, inSitemap: smv.urls.length,
      missingTitle: pages.filter((p) => !p.title).length, missingDescription: pages.filter((p) => !p.description).length,
      canonicalOrIndexingProblems: pages.filter((p) => !p.indexable || p.problems.some((x) => /^(canon|noindex)/.test(x))).length,
      httpErrors: pages.filter((p) => p.status !== 200).length, issues: counts, totalIssues: issues.length,
    },
    robots: rob, sitemap: { url: origin + '/sitemap.xml', ok: smv.ok, urls: smv.urls.length, errors: smv.errors, warnings: smv.warnings, type: smv.type || 'urlset' },
    pages, privatePaths: priv, excludedPublic: NOINDEX_PUBLIC, issues,
  };
}

// Resolved/unresolved comes from re-checking: an issue present in the previous run and absent now is resolved (kept, dated); one still present stays open.
export function diffIssues(prev, cur, nowIso) {
  const prevOpen = new Map(((prev && prev.issues) || []).map((i) => [i.id, i]));
  const curIds = new Set(cur.issues.map((i) => i.id));
  const resolved = [...((prev && prev.resolved) || [])];
  for (const [id, i] of prevOpen) if (!curIds.has(id) && !resolved.some((r) => r.id === id && r.resolvedAt >= (prev.ranAt || ''))) resolved.push({ ...i, resolvedAt: nowIso });
  const openIds = curIds;
  const stillResolved = resolved.filter((r) => !openIds.has(r.id)).slice(-100);
  return { ...cur, issues: cur.issues.map((i) => ({ ...i, firstSeen: (prevOpen.get(i.id) && prevOpen.get(i.id).firstSeen) || nowIso, status: 'open' })), resolved: stillResolved };
}
