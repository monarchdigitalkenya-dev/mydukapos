// functions/api/_gsc.js — shared helper, NOT a route (zip 288).
//
// Optional Google Search Console integration for the Owner Console SEO tab. Authentication is a Google SERVICE ACCOUNT (Google's approved
// server-to-server method): the service account's e-mail is added as a user of the Search Console property, and its key lives ONLY in a
// Cloudflare secret. No password, no OAuth token ever reaches the browser; the browser only ever sees results.
//
//   Secrets / variables (Pages -> Settings -> Environment variables; secrets via `wrangler pages secret put NAME --project-name=mydukapos`):
//     GSC_SERVICE_ACCOUNT_JSON   the whole service-account key file (JSON)                       [secret]
//     GSC_SITE_URL               default "sc-domain:mydukapos.store"                              [variable]
//
//   Least privilege: reads (sitemap list, performance, URL inspection) use the READ-ONLY scope; only "submit sitemap" asks for the read/write scope.
//   What Google's APIs really offer (and so what this file does NOT pretend): sitemaps list/get/submit, search analytics (clicks, impressions,
//   CTR, position), and URL Inspection (one URL per call, ~2,000/day per property). There is NO API for the full "Pages" coverage report.

export const GSC_DEFAULT_SITE = 'sc-domain:mydukapos.store';
const SCOPE_RO = 'https://www.googleapis.com/auth/webmasters.readonly';
const SCOPE_RW = 'https://www.googleapis.com/auth/webmasters';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = (s) => b64url(new TextEncoder().encode(s));

export function gscSite(env) { return String((env && env.GSC_SITE_URL) || GSC_DEFAULT_SITE).trim(); }

// Parse the secret without ever echoing it. Returns { ok, email } or { ok:false, reason }.
export function gscConfig(env) {
  const raw = env && env.GSC_SERVICE_ACCOUNT_JSON;
  if (!raw) return { ok: false, reason: 'not_configured' };
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!j.client_email || !j.private_key) return { ok: false, reason: 'secret_incomplete' };
    return { ok: true, email: j.client_email, key: j };
  } catch (e) { return { ok: false, reason: 'secret_not_json' }; }
}

async function importKey(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

const tokenCache = new Map();   // scope -> { token, exp }   (per isolate; a token lives an hour)
export async function accessToken(env, scope, fetchImpl = fetch) {
  const cfg = gscConfig(env);
  if (!cfg.ok) throw Object.assign(new Error('Google Search Console is not connected.'), { code: cfg.reason });
  const hit = tokenCache.get(scope + cfg.email);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlStr(JSON.stringify({ iss: cfg.email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await importKey(cfg.key.private_key), new TextEncoder().encode(head + '.' + claim));
  const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + b64url(sig) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw Object.assign(new Error('Google refused the service-account sign-in (' + (j.error || res.status) + ').'), { code: 'auth_failed' });
  tokenCache.set(scope + cfg.email, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}

async function call(env, scope, method, url, body, fetchImpl = fetch) {
  const token = await accessToken(env, scope, fetchImpl);
  const res = await fetchImpl(url, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let j = {}; try { j = text ? JSON.parse(text) : {}; } catch (e) { j = {}; }
  if (!res.ok) {
    const msg = (j.error && (j.error.message || j.error)) || ('HTTP ' + res.status);
    throw Object.assign(new Error(res.status === 403 ? 'Google says this service account is not a user of ' + gscSite(env) + ' (add it in Search Console → Settings → Users and permissions). ' + msg : String(msg)), { code: res.status === 403 ? 'forbidden' : 'google_error', status: res.status });
  }
  return j;
}

const site = (env) => encodeURIComponent(gscSite(env));
const SW = 'https://www.googleapis.com/webmasters/v3/sites/';

export async function listSitemaps(env, f) { const j = await call(env, SCOPE_RO, 'GET', SW + site(env) + '/sitemaps', null, f); return (j.sitemap || []).map(shapeSitemap); }
export async function getSitemap(env, feed, f) { return shapeSitemap(await call(env, SCOPE_RO, 'GET', SW + site(env) + '/sitemaps/' + encodeURIComponent(feed), null, f)); }
export async function submitSitemap(env, feed, f) { await call(env, SCOPE_RW, 'PUT', SW + site(env) + '/sitemaps/' + encodeURIComponent(feed), null, f); return { submitted: feed }; }

function shapeSitemap(s) {
  const c = Array.isArray(s.contents) ? s.contents : [];
  return { path: s.path, type: s.type || null, lastSubmitted: s.lastSubmitted || null, lastDownloaded: s.lastDownloaded || null, isPending: !!s.isPending, isSitemapsIndex: !!s.isSitemapsIndex, errors: Number(s.errors) || 0, warnings: Number(s.warnings) || 0,
    submittedUrls: c.reduce((n, x) => n + (Number(x.submitted) || 0), 0), indexedUrls: null /* the API no longer reports an indexed count reliably: never shown as a number */ };
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
export function clampRange(start, end, now = Date.now()) {
  let e = end && /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : ymd(now - 2 * 86400000);      // Search Console data lags ~2 days
  let s = start && /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : ymd(Date.parse(e) - 27 * 86400000);
  if (Date.parse(s) > Date.parse(e)) s = e;
  if (Date.parse(e) - Date.parse(s) > 480 * 86400000) s = ymd(Date.parse(e) - 480 * 86400000);   // the API keeps ~16 months
  return { startDate: s, endDate: e };
}

export async function performance(env, { start, end, dimension = 'page', limit = 25 } = {}, f) {
  const { startDate, endDate } = clampRange(start, end);
  const dim = ['page', 'query', 'date', 'country', 'device'].includes(dimension) ? dimension : 'page';
  const body = (dims) => ({ startDate, endDate, dimensions: dims, rowLimit: Math.min(Math.max(Number(limit) || 25, 1), 100), dataState: 'final' });
  const [totals, rows] = await Promise.all([
    call(env, SCOPE_RO, 'POST', SW + site(env) + '/searchAnalytics/query', { startDate, endDate, dataState: 'final' }, f),
    call(env, SCOPE_RO, 'POST', SW + site(env) + '/searchAnalytics/query', body([dim]), f),
  ]);
  const t = (totals.rows && totals.rows[0]) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  return { startDate, endDate, dimension: dim, totals: { clicks: t.clicks || 0, impressions: t.impressions || 0, ctr: t.ctr || 0, position: t.position || 0 },
    rows: (rows.rows || []).map((r) => ({ key: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })) };
}

// URL Inspection API: the one place Google reports crawl/index state per URL. Verdicts are Google's words, passed through untouched.
export async function inspectUrl(env, url, f) {
  const j = await call(env, SCOPE_RO, 'POST', 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', { inspectionUrl: url, siteUrl: gscSite(env) }, f);
  const r = (j.inspectionResult && j.inspectionResult.indexStatusResult) || {};
  return { url, verdict: r.verdict || null, coverageState: r.coverageState || null, robotsTxtState: r.robotsTxtState || null, indexingState: r.indexingState || null, lastCrawlTime: r.lastCrawlTime || null, googleCanonical: r.googleCanonical || null, userCanonical: r.userCanonical || null, pageFetchState: r.pageFetchState || null, crawledAs: r.crawledAs || null,
    link: (j.inspectionResult && j.inspectionResult.inspectionResultLink) || null };
}

export const searchConsoleLinks = (env, origin) => ({
  property: 'https://search.google.com/search-console?resource_id=' + encodeURIComponent(gscSite(env)),
  sitemaps: 'https://search.google.com/search-console/sitemaps?resource_id=' + encodeURIComponent(gscSite(env)),
  inspect: (u) => 'https://search.google.com/search-console/inspect?resource_id=' + encodeURIComponent(gscSite(env)) + '&id=' + encodeURIComponent(u),
  performance: 'https://search.google.com/search-console/performance/search-analytics?resource_id=' + encodeURIComponent(gscSite(env)),
});
