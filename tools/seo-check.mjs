// tools/seo-check.mjs — run the Owner Console's SEO audit from your own computer against the LIVE site (zip 288).
//   node tools/seo-check.mjs                       audits https://mydukapos.store
//   node tools/seo-check.mjs https://mydukapos.store
// Prints the same findings as Owner Console → SEO → Run site audit. Exit code 1 when a critical or high issue is open.
// This is how to verify a deployment: nothing here is simulated, it fetches the real pages (without following redirects, so redirects are visible).
import { runAudit } from '../functions/api/_seo-audit.js';

const origin = (process.argv[2] || 'https://mydukapos.store').replace(/\/+$/, '');
const host = new URL(origin).hostname;
const env = { ROOT_DOMAIN: host.replace(/^www\./, '') };
const fetcher = async (path) => {
  const res = await fetch(origin + path, { redirect: 'manual', headers: { 'User-Agent': 'MyDukaPOS-SEO-Check/1' } });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, text: /text|xml|json/i.test(ct) ? await res.text() : '' };
};
const a = await runAudit({ env, fetcher });
console.log(`Audited ${a.origin} at ${a.ranAt}`);
console.log(`Public routes ${a.summary.discoveredPublicRoutes} · eligible ${a.summary.eligibleIndexable} · in sitemap ${a.summary.inSitemap} · issues ${a.summary.totalIssues} (${Object.entries(a.summary.issues).map(([k, v]) => v + ' ' + k).join(', ')})`);
console.log(`sitemap.xml: ${a.sitemap.ok ? 'valid' : 'INVALID ' + a.sitemap.errors.join('; ')} (${a.sitemap.urls} URLs)   robots.txt: HTTP ${a.robots.status}${a.robots.hasSitemapLine ? ', names the sitemap' : ', NO sitemap line'}`);
for (const p of a.pages) console.log(`  ${String(p.status).padEnd(4)} ${p.indexable ? 'index ' : 'NOIDX '} ${p.inSitemap ? 'sm ' : '-- '} ${p.path}  — ${p.title || '(no title)'}`);
for (const i of a.issues) console.log(`[${i.severity.toUpperCase()}] ${i.url}: ${i.title}${i.detail ? ' — ' + i.detail : ''}`);
process.exit(a.issues.some((i) => i.severity === 'critical' || i.severity === 'high') ? 1 : 0);
