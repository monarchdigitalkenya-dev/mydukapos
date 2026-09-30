// zip 161: measures the CRM page in a real Chromium (Playwright) against tools/crm-dev-server.mjs.
//   node tools/measure-crm-browser.mjs --base http://localhost:8901 [--profile fast|mobile] [--as owner|sales] [--json out.json]
//   profile "mobile" = CDP network emulation (150 ms round trip, 1.6 Mbit/s down, 0.75 Mbit/s up) + 4x CPU slowdown; "fast" = none. Both are EMULATIONS on this sandbox.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('base', 'http://localhost:8901'), PROFILE = opt('profile', 'fast'), AS = opt('as', 'owner'), OUT = opt('json', '');
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs');
const chromium = pw.chromium || pw.default.chromium;
const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const tokens = await (await fetch(BASE + '/__tokens')).json().catch(() => null);
const browser = await chromium.launch({ executablePath: exe });
const out = { base: BASE, profile: PROFILE, as: AS, steps: [] };
try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 } });
  const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable'); await cdp.send('Performance.enable');
  if (PROFILE === 'mobile') { await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 0.75e6 / 8 }); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); }
  const tok = AS === 'owner' ? 'owner-tok' : (tokens && tokens[AS]) || opt('token', '');
  await page.addInitScript(([t, mode]) => { try { if (mode === 'owner') { localStorage.setItem('pos_owner_session_token', t); localStorage.setItem('crm_mode', 'owner'); } else { localStorage.setItem('crm_token', t); localStorage.setItem('crm_mode', 'staff'); } } catch (e) {} window.__lt = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt += e.duration; }).observe({ type: 'longtask', buffered: true }); } catch (e) {} }, [tok, AS === 'owner' ? 'owner' : 'staff']);
  let step = 'boot'; const reqs = [];
  page.on('request', (r) => { if (/\/api\/crm|\/crm\//.test(r.url())) reqs.push({ step, url: r.url().replace(BASE, ''), t: Date.now() }); });
  const readyExpr = `(() => { const m = document.querySelector('#main'); if (!m) return false; if (m.querySelector('.spinner, [role=status]')) return false; return m.children.length > 0; })()`;
  const waitReady = (extra) => page.waitForFunction(extra ? `${readyExpr} && (${extra})` : readyExpr, null, { timeout: 60000, polling: 'raf' });
  const nodes = () => page.evaluate(() => document.querySelectorAll('*').length);
  const heap = async () => { try { await cdp.send('HeapProfiler.collectGarbage'); } catch (e) {} const m = await cdp.send('Performance.getMetrics'); const g = (n) => (m.metrics.find((x) => x.name === n) || {}).value || 0; return { jsHeapMB: +(g('JSHeapUsedSize') / 1048576).toFixed(1), domNodes: g('Nodes'), layoutCount: g('LayoutCount'), scriptMs: +(g('ScriptDuration') * 1000).toFixed(0), taskMs: +(g('TaskDuration') * 1000).toFixed(0) }; };
  const record = async (name, fn) => {
    step = name; const before = reqs.length; const t0 = Date.now(); const extra = await fn(); const ms = Date.now() - t0;
    const mine = reqs.filter((r) => r.step === name); const dn = await nodes();
    out.steps.push({ name, ms, requests: mine.length, urls: mine.map((r) => r.url.replace(/^\/api\/crm/, '').slice(0, 70)), domNodes: dn, ...(extra || {}) });
  };
  const resources = () => page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\/crm/.test(e.name)).map((e) => ({ n: e.name.replace(location.origin, ''), start: Math.round(e.startTime), end: Math.round(e.responseEnd), transfer: e.transferSize, enc: e.encodedBodySize, dec: e.decodedBodySize })));
  await record('1 cold open /crm/#/dashboard (empty cache)', async () => {
    await page.goto(BASE + '/crm/#/dashboard'); await waitReady('document.querySelector(".kpi, .kpis, .card")');
    const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const fcp = (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime; return { dcl: Math.round(n.domContentLoadedEventEnd), fcp: Math.round(fcp || 0), load: Math.round(n.loadEventEnd), longTaskMs: Math.round(window.__lt) }; });
    const rs = await resources(); const js = rs.filter((r) => /\.js/.test(r.n)), css = rs.filter((r) => /\.css/.test(r.n));
    return { ...nav, jsBytesGz: js.reduce((a, r) => a + r.enc, 0), jsBytesRaw: js.reduce((a, r) => a + r.dec, 0), cssBytesGz: css.reduce((a, r) => a + r.enc, 0), apiBytes: rs.filter((r) => /api\/crm/.test(r.n)).reduce((a, r) => a + r.enc, 0), assetTransferBytes: rs.filter((r) => !/api\/crm/.test(r.n)).reduce((a, r) => a + r.transfer, 0), waterfall: rs.map((r) => `${r.n.replace('/api/crm', '').slice(0, 44)} ${r.start}->${r.end}ms`) };
  });
  Object.assign(out, { bootHeap: await heap() });
  await record('2 repeat open (reload, browser cache warm)', async () => {
    await page.reload(); await waitReady('document.querySelector(".kpi, .kpis, .card")');
    const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const fcp = (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime; return { dcl: Math.round(n.domContentLoadedEventEnd), fcp: Math.round(fcp || 0) }; });
    const rs = await resources(); return { ...nav, assetRequests: rs.filter((r) => !/api\/crm/.test(r.n)).length, assetTransferBytes: rs.filter((r) => !/api\/crm/.test(r.n)).reduce((a, r) => a + r.transfer, 0) };
  });
  const goto = async (name, hash, extra) => record(name, async () => { const t = await page.evaluate((h) => { location.hash = h; return performance.now(); }, hash); await waitReady(extra); return {}; });
  await goto('3 open Leads', '#/leads', 'document.querySelector("#main table tbody tr, #main .empty")');
  Object.assign(out, { leadsHeap: await heap() });
  await record('4 leads: type a search (debounced), "wanjiru"', async () => { await page.fill('input.search', ''); await page.waitForTimeout(50); step = '4 leads: type a search (debounced), "wanjiru"'; await page.type('input.search', 'wanjiru', { delay: 60 }); await page.waitForTimeout(1500); await waitReady(); return {}; });
  await record('5 leads: click a column sort (Name)', async () => { await page.click('th.sortable >> text=Name'); await page.waitForTimeout(100); await waitReady(); return {}; });
  await record('6 leads: next page', async () => { const nb = await page.$('button:has-text("Next")'); if (nb) { await nb.click(); await page.waitForTimeout(100); await waitReady(); } return {}; });
  const first = await page.$eval('#main table tbody tr', (r) => r.getAttribute('onclick') ? '' : '').catch(() => '');
  await record('7 open a lead (row click)', async () => { await page.click('#main table tbody tr >> nth=0'); await page.waitForFunction('location.hash.startsWith("#/leads/")'); await waitReady('document.querySelector("#main .card")'); return {}; });
  await goto('8 open Inbox (list)', '#/inbox', 'document.querySelector(".convs .conv, .convs .empty")');
  await record('9 inbox: open a conversation', async () => { await page.click('.convs .conv >> nth=0'); await waitReady('document.querySelector(".p-chat .msg, .p-chat .bubble, .p-chat [class*=msg]")').catch(() => {}); await page.waitForTimeout(300); return {}; });
  Object.assign(out, { inboxHeap: await heap() });
  await goto('10 open Follow-ups', '#/followups', 'document.querySelector("#main .card, #main .empty")');
  await goto('11 open Settings', '#/settings', null);
  await goto('12 open Reports', '#/reports', null);
  await goto('13 open Dashboard again', '#/dashboard', 'document.querySelector(".kpi, .kpis, .card")');
  // steady-state polling: how many requests in 50 s while the tab is visible
  await record('14 idle 50 s, tab visible (polling)', async () => { await page.waitForTimeout(50000); return {}; });
  out.finalHeap = await heap();
} finally { await browser.close(); }
const bytes = (n) => n == null ? '' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
console.log(`# ${BASE} profile=${PROFILE} as=${AS}`);
for (const s of out.steps) console.log(`${s.name.padEnd(52)} ${String(s.ms).padStart(6)} ms  ${String(s.requests).padStart(2)} req  ${String(s.domNodes).padStart(6)} nodes${s.fcp ? `  fcp ${s.fcp}ms dcl ${s.dcl}ms` : ''}${s.jsBytesGz ? `  js ${bytes(s.jsBytesGz)} gz / ${bytes(s.jsBytesRaw)}, css ${bytes(s.cssBytesGz)}, api ${bytes(s.apiBytes)}` : ''}${s.assetRequests != null ? `  asset reqs ${s.assetRequests} (${bytes(s.assetTransferBytes)})` : ''}`);
for (const s of out.steps) console.log('  ' + s.name.slice(0, 40) + ' -> ' + s.urls.join(', '));
console.log('heap', JSON.stringify({ boot: out.bootHeap, leads: out.leadsHeap, inbox: out.inboxHeap, final: out.finalHeap }));
if (out.steps[0].waterfall) console.log('waterfall(cold):\n  ' + out.steps[0].waterfall.join('\n  '));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
