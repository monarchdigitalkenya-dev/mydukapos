// functions/api/owner-seo.js — Cloudflare Pages Function (Owner Console → 🔎 SEO). Zip 288.
//
//   GET                               (owner signed in) -> { audit (last run or null), sitemaps, links, google: { configured, ... } }
//   POST { action: 'audit' }                            -> runs the site audit now (fetches the site's own public pages), stores and returns it
//   POST { action: 'validate-sitemap' }                 -> fetches /sitemap.xml and checks it
//   POST { action: 'gsc-status' }                       -> is the Google connection configured, and as which e-mail (never the key)
//   POST { action: 'gsc-sitemaps' }                     -> Search Console's own list of submitted sitemaps and their processing status
//   POST { action: 'gsc-submit' }                       -> submits https://<canonical>/sitemap.xml to Search Console (the only write)
//   POST { action: 'gsc-performance', start, end, dimension }  -> clicks / impressions / CTR / position
//   POST { action: 'gsc-inspect', url }                 -> Google's own index verdict for ONE eligible URL (URL Inspection API)
//
// Every action needs the owner session (requireOwnerAuth). Audit and Google calls are rate-limited, URLs are checked against the site's own
// list before any Google call (so this cannot be used to probe arbitrary addresses), nothing secret is returned or logged, and each administrative
// action is appended to a short log (who/what/when/outcome — never a token or key).

import { requireOwnerAuth } from './_owner-auth.js';
import { checkRateLimit } from './_ratelimit.js';
import { sitemapEntries, canonicalOrigin } from '../_site.js';
import { runAudit, diffIssues, validateSitemapXml } from './_seo-audit.js';
import { gscConfig, gscSite, listSitemaps, submitSitemap, performance, inspectUrl, searchConsoleLinks } from './_gsc.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const LAST_KEY = 'seo:last-audit', LOG_KEY = 'seo:admin-log';

// The audit fetches the site's own public pages. redirect:'manual' so a redirect is SEEN, not silently followed.
export function selfFetcher(origin, fetchImpl = fetch) {
  return async (path) => {
    const res = await fetchImpl(origin + path, { redirect: 'manual', headers: { 'User-Agent': 'MyDukaPOS-SEO-Audit/1', 'Cache-Control': 'no-cache' } });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, text: /text|xml|json/i.test(ct) ? (await res.text()).slice(0, 600000) : '' };
  };
}

async function logAction(env, action, outcome) {
  try {
    const prev = JSON.parse((await env.mydukapos_kv.get(LOG_KEY)) || '[]');
    prev.unshift({ at: new Date().toISOString(), action, outcome: String(outcome).slice(0, 160) });
    await env.mydukapos_kv.put(LOG_KEY, JSON.stringify(prev.slice(0, 50)));
  } catch (e) { /* the log is best effort */ }
}

function sitemapList(origin) {
  const n = sitemapEntries().length;
  return [{ name: 'Main sitemap', type: 'urlset (single file)', url: origin + '/sitemap.xml', path: '/sitemap.xml', urls: n, note: 'The whole public site is one file (well under the 50,000-URL limit), so no sitemap index is needed. Submit this one.' }];
}

function googleBlock(env, origin) {
  const c = gscConfig(env);
  const l = searchConsoleLinks(env, origin);
  return {
    configured: c.ok, reason: c.ok ? null : c.reason, serviceAccountEmail: c.ok ? c.email : null, property: gscSite(env),
    links: { property: l.property, sitemaps: l.sitemaps, performance: l.performance },
    checklist: [
      { step: 'Create a Google Cloud project and enable the "Google Search Console API"', done: null },
      { step: 'Create a service account and download its JSON key', done: null },
      { step: 'Save the key as the Pages secret GSC_SERVICE_ACCOUNT_JSON (wrangler pages secret put GSC_SERVICE_ACCOUNT_JSON --project-name=mydukapos)', done: c.ok },
      { step: 'In Search Console → Settings → Users and permissions, add the service account e-mail as a user (Full permission is needed to submit a sitemap; Restricted is enough to read)', done: null },
      { step: 'Redeploy, then press "Check connection"', done: null },
    ],
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  const origin = canonicalOrigin(env);
  let audit = null, log = [];
  try { audit = JSON.parse((await env.mydukapos_kv.get(LAST_KEY)) || 'null'); } catch (e) { audit = null; }
  try { log = JSON.parse((await env.mydukapos_kv.get(LOG_KEY)) || '[]').slice(0, 15); } catch (e) { log = []; }
  return json({ origin, robotsUrl: origin + '/robots.txt', sitemaps: sitemapList(origin), audit, log, google: googleBlock(env, origin) });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  let body = {}; try { body = await request.json(); } catch (e) { return json({ error: 'Send JSON.' }, 400); }
  const action = String(body.action || '');
  const origin = canonicalOrigin(env);
  const fetchImpl = context.fetchImpl || fetch;       // overridden in tests

  try {
    if (action === 'audit' || action === 'validate-sitemap') {
      const rl = await checkRateLimit(env, 'seoAudit', 'owner');
      if (!rl.ok) return json({ error: `Audit limit reached (${rl.limit}/hour). Try again in about ${Math.ceil(rl.retryAfter / 60)} minute(s).`, code: 'rate_limited' }, 429);
      if (action === 'validate-sitemap') {
        const r = await selfFetcher(origin, fetchImpl)('/sitemap.xml');
        const v = r.status === 200 ? validateSitemapXml(r.text, origin) : { ok: false, errors: ['HTTP ' + r.status], warnings: [], urls: [] };
        await logAction(env, 'validate-sitemap', v.ok ? `ok, ${v.urls.length} URLs` : `${v.errors.length} error(s)`);
        return json({ checkedAt: new Date().toISOString(), url: origin + '/sitemap.xml', status: r.status, ok: v.ok, urls: v.urls.length, errors: v.errors, warnings: v.warnings });
      }
      let prev = null; try { prev = JSON.parse((await env.mydukapos_kv.get(LAST_KEY)) || 'null'); } catch (e) { prev = null; }
      const cur = await runAudit({ env, fetcher: selfFetcher(origin, fetchImpl) });
      const audit = diffIssues(prev, cur, cur.ranAt);
      await env.mydukapos_kv.put(LAST_KEY, JSON.stringify(audit));
      await logAction(env, 'audit', `${audit.summary.totalIssues} issue(s), ${audit.summary.inSitemap} URLs in sitemap`);
      return json({ audit });
    }

    if (action === 'gsc-status') return json({ google: googleBlock(env, origin) });

    if (action.startsWith('gsc-')) {
      const cfg = gscConfig(env);
      if (!cfg.ok) return json({ error: 'Google Search Console is not connected yet. Follow the setup checklist; until then use the copy-and-submit steps.', code: 'not_configured', reason: cfg.reason }, 409);
      const rl = await checkRateLimit(env, 'seoGoogle', 'owner');
      if (!rl.ok) return json({ error: `Google request limit reached (${rl.limit}/hour).`, code: 'rate_limited' }, 429);

      if (action === 'gsc-sitemaps') { const s = await listSitemaps(env, fetchImpl); return json({ property: gscSite(env), sitemaps: s, note: 'Google reports what it has processed. A listed sitemap does not mean its pages are indexed.' }); }
      if (action === 'gsc-submit') {
        const r = await submitSitemap(env, origin + '/sitemap.xml', fetchImpl);
        await logAction(env, 'gsc-submit', 'submitted ' + r.submitted);
        return json({ ok: true, submitted: r.submitted, note: 'Submitted. Google decides when to fetch it; check "Search Console sitemaps" for its processing status.' });
      }
      if (action === 'gsc-performance') { const p = await performance(env, { start: body.start, end: body.end, dimension: body.dimension, limit: body.limit }, fetchImpl); return json(p); }
      if (action === 'gsc-inspect') {
        const url = String(body.url || '');
        if (!sitemapEntries().some((e) => origin + (e.path === '/' ? '/' : e.path) === url)) return json({ error: 'Only the site\'s own eligible public URLs can be inspected.' }, 400);
        const r = await inspectUrl(env, url, fetchImpl);
        await logAction(env, 'gsc-inspect', url);
        return json(r);
      }
    }
    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    const code = e && e.code || 'error';
    await logAction(env, action, 'failed: ' + code);
    return json({ error: String(e && e.message || e).slice(0, 300), code }, e && e.status === 403 ? 403 : 502);
  }
}
