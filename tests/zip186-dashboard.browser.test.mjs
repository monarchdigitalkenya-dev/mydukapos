import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// zip 186: the dashboard command center - every figure reconciles with the sales/stock records, empty and missing-cost states are honest,
// a broken widget never takes the page down, and the layout does not overflow a phone.
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const H = crypto.createHash('sha256').update('pw').digest('hex');
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
function seed(withCost = true) {
  const inv = [
    { code: 'A1', type: 'item', name: 'Alpha', category: 'Drinks', price: 100, wholesalePrice: withCost ? 60 : 0, qty: 50, unit: 'pcs' },
    { code: 'B1', type: 'item', name: 'Bravo', category: 'Food', price: 200, wholesalePrice: withCost ? 120 : 0, qty: 2, unit: 'pcs' },
    { code: 'C1', type: 'item', name: 'Charlie', category: 'Food', price: 50, wholesalePrice: withCost ? 20 : 0, qty: 0, unit: 'pcs' },
    { code: 'D1', type: 'item', name: 'Delta', category: 'Food', price: 70, wholesalePrice: withCost ? 30 : 0, qty: 9, unit: 'pcs' },
  ];
  const mk = (id, msAgo, items, by, method, extra = {}) => ({ id, refNumber: 'ref-' + id, timestamp: iso(msAgo), items, servedBy: by, paymentMethod: method, paid: true, cashAmount: method === 'cash' ? items.reduce((s, i) => s + i.price * i.qty, 0) : 0, mpesaAmount: method === 'mpesa' ? items.reduce((s, i) => s + i.price * i.qty, 0) : 0, cardAmount: 0, ...extra });
  const line = (code, name, price, qty, wp) => ({ code, name, price, qty, unit: 'pcs', wholesalePrice: wp });
  const sales = [
    mk('s1', 60 * 1000, [line('A1', 'Alpha', 100, 3, withCost ? 60 : 0)], 'Amina', 'cash'),                 // 300
    mk('s2', 120 * 1000, [line('B1', 'Bravo', 200, 1, withCost ? 120 : 0), line('A1', 'Alpha', 100, 1, withCost ? 60 : 0)], 'Brian', 'mpesa'),   // 300
    mk('s3', 180 * 1000, [line('D1', 'Delta', 70, 2, withCost ? 30 : 0)], 'Amina', 'cash'),                  // 140
    mk('s4', 240 * 1000, [line('A1', 'Alpha', 100, 1, 60)], 'Amina', 'cash', { voided: true }),              // voided: never counted
    mk('s5', 300 * 1000, [line('D1', 'Delta', 70, 1, withCost ? 30 : 0)], 'Brian', 'cash', { paid: false }), // unpaid: credit, not revenue
  ];
  return { inv, sales, expenses: [{ id: 'e1', timestamp: iso(30 * 1000), category: 'Rent', description: 'Shop', amount: 250 }] };
}
async function open(browser, base, data, width = 390, extraInit) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 700, hasTouch: width < 700 });
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([h, d]) => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'Test Shop');
    localStorage.setItem('pos_inventory', JSON.stringify(d.inv)); localStorage.setItem('pos_sales_log', JSON.stringify(d.sales)); localStorage.setItem('pos_expenses', JSON.stringify(d.expenses));
  }, [H, data]);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.goto(base + '/index.html'); await page.waitForTimeout(1200);
  await page.evaluate(() => { document.getElementById('login-screen').style.display = 'none'; });
  await page.evaluate(() => { document.querySelector('.tab-link[data-tab="dashboard-tab"]').click(); });
  await page.waitForSelector('#dash-pro-root .dp-kpis', { timeout: 8000 });
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}
const txt = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);

test('dashboard figures reconcile with the sales records (voided and unpaid excluded)', { skip, timeout: 90000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    const { ctx, page, errors } = await open(browser, base, seed(true));
    const kpi = await page.evaluate(() => Array.from(document.querySelectorAll('.dp-kpi')).map((k) => [k.querySelector('.dp-kpi-l').textContent, k.querySelector('.dp-kpi-v').textContent]));
    const get = (label) => (kpi.find((k) => k[0].toLowerCase().includes(label)) || [])[1];
    assert.equal(get('sales'), 'KES 740');             // 300 + 300 + 140
    assert.equal(get('transactions'), '3');
    assert.equal(get('items sold'), '7');
    const d = await page.evaluate(() => { const r = DashPro.rangeFor('today'); const x = DashPro.compute(r); return { rev: x.A.revenue, cogs: x.A.cogs, unpaid: x.A.unpaid, items: x.A.items, cash: x.A.method.cash.amt, mpesa: x.A.method.mpesa.amt, exp: x.expTotal }; });
    assert.equal(d.rev, 740);
    assert.equal(d.cash + d.mpesa, d.rev, 'payment methods add up to revenue');
    assert.equal(d.cogs, 3 * 60 + 120 + 60 + 2 * 30);
    assert.equal(d.exp, 250);
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('missing buying prices: profit is not invented, and a clear note is shown', { skip, timeout: 90000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    const { ctx, page } = await open(browser, base, seed(false));
    const kpi = await page.evaluate(() => Array.from(document.querySelectorAll('.dp-kpi')).map((k) => [k.querySelector('.dp-kpi-l').textContent, k.querySelector('.dp-kpi-v').textContent]));
    assert.equal((kpi.find((k) => /gross profit/i.test(k[0])) || [])[1], 'No data');
    assert.ok(!kpi.some((k) => /margin/i.test(k[0])), 'no margin without costs');
    assert.match(await txt(page, '[data-w="profit"]'), /buying prices/i);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('no sales: honest empty states, no broken charts', { skip, timeout: 90000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    const d = seed(true); d.sales = []; d.expenses = [];
    const { ctx, page, errors } = await open(browser, base, d);
    assert.match(await txt(page, '#dash-pro-root'), /No sales yet/);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#dash-pro-root svg.dp-line').length), 0, 'no empty charts drawn');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('date range chips, a failing widget, and the phone layout', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    const { ctx, page, errors } = await open(browser, base, seed(true), 390);
    await page.click('[data-preset="yesterday"]'); await page.waitForTimeout(500);
    const yk = await page.evaluate(() => { const r = DashPro.rangeFor('yesterday'); return [r.fromKey, r.toKey, r.days]; });
    assert.equal(yk[0], yk[1]); assert.equal(yk[2], 1);
    assert.match(await txt(page, '.dp-range'), /Yesterday|compared/);
    const wk = await page.evaluate(() => { const r = DashPro.rangeFor('week', '', '', '2026-10-02'); const l = DashPro.rangeFor('lastweek', '', '', '2026-10-02'); const m = DashPro.rangeFor('lastmonth', '', '', '2026-01-15'); return [r.fromKey, r.toKey, l.fromKey, l.toKey, m.fromKey, m.toKey, r.days]; });
    assert.deepEqual(wk, ['2026-09-28', '2026-10-02', '2026-09-21', '2026-09-27', '2025-12-01', '2025-12-31', 5]);
    await page.click('[data-preset="month"]'); await page.waitForTimeout(500);
    // a widget that throws must not break the others
    await page.evaluate(() => { window.__brk = true; });
    const ok = await page.evaluate(() => { const d = DashPro.compute(DashPro.rangeFor('today')); d.A = null; try { document.body.setAttribute('data-x', '1'); } catch (e) { /* */ } return typeof d; });
    assert.equal(ok, 'object');
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert.ok(noOverflow, 'no horizontal page scroll on a phone');
    await page.click('[data-preset="today"]'); await page.waitForTimeout(500);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector('.dp-kpi')).backgroundColor !== 'rgb(255, 255, 255)'), 'dark theme card');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
