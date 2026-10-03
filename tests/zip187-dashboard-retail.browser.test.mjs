import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// zip 187: the dashboard command center in Pharmacy, Production and Services. Same promises as the Shop test (zip 186): every figure reconciles with the
// seeded sales / stock records (voided and unpaid sales never count), the app's own extras are honest (expiry in Pharmacy, produced items in Production,
// "stock not tracked" in Services), the empty state is clear, nothing throws, and a phone does not scroll sideways.
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
const dayStr = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const line = (code, name, price, qty, wp, extra = {}) => ({ code, name, price, qty, unit: 'pcs', wholesalePrice: wp, ...extra });
const total = (items) => items.reduce((s, i) => s + i.price * i.qty, 0);
const mk = (id, msAgo, items, by, method, extra = {}) => ({ id, refNumber: 'ref-' + id, timestamp: iso(msAgo), items, servedBy: by, paymentMethod: method, paid: true, cashAmount: method === 'cash' ? total(items) : 0, mpesaAmount: method === 'mpesa' ? total(items) : 0, cardAmount: 0, ...extra });

// ---- seeds: three small, realistic shops. Sales 4 (voided) and 5 (unpaid) must never show up as revenue. ----
function pharmacySeed() {
  const inv = [
    { code: 'P1', type: 'item', name: 'Paracetamol 500mg', category: 'Pain relief', price: 100, wholesalePrice: 60, qty: 40, unit: 'pcs', expiryDate: dayStr(-10), batches: [{ id: 'b1', batchNumber: 'B1', expiryDate: dayStr(-10), qty: 5 }, { id: 'b2', batchNumber: 'B2', expiryDate: dayStr(200), qty: 35 }] },
    { code: 'P2', type: 'item', name: 'Amoxicillin 250mg', category: 'Antibiotics', price: 300, wholesalePrice: 180, qty: 2, unit: 'pcs', expiryDate: dayStr(10) },
    { code: 'P3', type: 'item', name: 'Cough Syrup', category: 'Cold & flu', price: 250, wholesalePrice: 150, qty: 0, unit: 'pcs', expiryDate: dayStr(300) },
    { code: 'P4', type: 'item', name: 'Vitamin C', category: 'Supplements', price: 80, wholesalePrice: 40, qty: 20, unit: 'pcs', expiryDate: dayStr(400) },
    { code: 'S1', type: 'service', name: 'Blood pressure check', category: 'Services', price: 50, qty: 0, unit: 'pcs' },
  ];
  const sales = [
    mk('s1', 60e3, [line('P1', 'Paracetamol 500mg', 100, 3, 60)], 'Amina', 'cash'),                                                    // 300
    mk('s2', 120e3, [line('P2', 'Amoxicillin 250mg', 300, 1, 180), line('P1', 'Paracetamol 500mg', 100, 1, 60)], 'Brian', 'mpesa'),    // 400
    mk('s3', 180e3, [line('P1', 'Paracetamol 500mg', 100, 2, 60)], 'Amina', 'cash'),                                                   // 200
    mk('s4', 240e3, [line('P1', 'Paracetamol 500mg', 100, 1, 60)], 'Amina', 'cash', { voided: true }),
    mk('s5', 300e3, [line('P4', 'Vitamin C', 80, 1, 40)], 'Brian', 'cash', { paid: false, paidStatusChanges: [{ at: iso(299e3), paid: false, by: 'Owner' }] }),
  ];
  return { app: 'pharmacy', inv, sales, expenses: [{ id: 'e1', timestamp: iso(30e3), category: 'Rent', description: 'Shop', amount: 250 }] };
}
function productionSeed() {
  const inv = [
    { code: 'F1', type: 'ingredient', name: 'Flour', category: 'Materials', price: 0, wholesalePrice: 50, qty: 100, unit: 'kg' },
    { code: 'S1', type: 'ingredient', name: 'Sugar', category: 'Materials', price: 0, wholesalePrice: 80, qty: 2, unit: 'kg' },
    { code: 'BR', type: 'item', name: 'Bread', category: 'Bakery', price: 100, wholesalePrice: 40, qty: 0, unit: 'pcs', productionRecipe: [{ code: 'F1', qty: 0.5 }, { code: 'S1', qty: 0.1 }] },
    { code: 'MG', type: 'item', name: 'Mug', category: 'Gifts', price: 200, wholesalePrice: 120, qty: 0, unit: 'pcs' },
    { code: 'CD', type: 'item', name: 'Candle', category: 'Gifts', price: 150, wholesalePrice: 90, qty: 12, unit: 'pcs' },
  ];
  const sales = [
    mk('s1', 60e3, [line('BR', 'Bread', 100, 5, 40)], 'Amina', 'cash'),     // 500
    mk('s2', 120e3, [line('MG', 'Mug', 200, 1, 120)], 'Brian', 'mpesa'),     // 200
    mk('s4', 240e3, [line('BR', 'Bread', 100, 9, 40)], 'Amina', 'cash', { voided: true }),
    mk('s5', 300e3, [line('CD', 'Candle', 150, 1, 90)], 'Brian', 'cash', { paid: false, paidStatusChanges: [{ at: iso(299e3), paid: false, by: 'Owner' }] }),
  ];
  const production = [{ id: 'pr1', timestamp: iso(60e3), itemCode: 'BR', itemName: 'Bread', qtyProduced: 5, unit: 'pcs', componentsUsed: [{ code: 'F1', name: 'Flour', qty: 2.5, unit: 'kg' }, { code: 'S1', name: 'Sugar', qty: 0.5, unit: 'kg' }], producedBy: 'Amina' }];
  return { app: 'production', inv, sales, expenses: [{ id: 'e1', timestamp: iso(30e3), category: 'Gas', description: 'Oven', amount: 250 }], production };
}
function servicesSeed() {
  const inv = [
    { code: 'V1', type: 'service', name: 'Haircut', category: 'Hair', price: 500, wholesalePrice: 0, qty: 0, unit: 'pcs' },
    { code: 'V2', type: 'service', name: 'Braiding', category: 'Hair', price: 1500, wholesalePrice: 0, qty: 0, unit: 'pcs' },
  ];
  const sales = [
    mk('s1', 60e3, [line('V1', 'Haircut', 500, 2, 0)], 'Amina', 'cash'),     // 1000
    mk('s2', 120e3, [line('V2', 'Braiding', 1500, 1, 0)], 'Brian', 'mpesa'), // 1500
    mk('s4', 240e3, [line('V1', 'Haircut', 500, 1, 0)], 'Amina', 'cash', { voided: true }),
    mk('s5', 300e3, [line('V2', 'Braiding', 1500, 1, 0)], 'Brian', 'cash', { paid: false, paidStatusChanges: [{ at: iso(299e3), paid: false, by: 'Owner' }] }),
  ];
  return { app: 'services', inv, sales, expenses: [{ id: 'e1', timestamp: iso(30e3), category: 'Supplies', description: 'Oils', amount: 250 }] };
}
const PAGE = { pharmacy: '/pharmacy/index.html', production: '/production/index.html', services: '/services/index.html' };

async function open(browser, base, data, width = 390) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 700, hasTouch: width < 700 });
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([h, d]) => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'Test Shop');
    localStorage.setItem('pos_inventory', JSON.stringify(d.inv)); localStorage.setItem('pos_sales_log', JSON.stringify(d.sales)); localStorage.setItem('pos_expenses', JSON.stringify(d.expenses));
    if (d.production) localStorage.setItem('pos_production_history', JSON.stringify(d.production));
  }, [H, data]);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.goto(base + PAGE[data.app]); await page.waitForTimeout(1200);
  await page.evaluate(() => { document.getElementById('login-screen').style.display = 'none'; });
  await page.evaluate(() => { document.querySelector('.tab-link[data-tab="dashboard-tab"]').click(); });
  await page.waitForSelector('#dash-pro-root .dp-kpis', { timeout: 8000 });
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}
const kpis = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.dp-kpi')).map((k) => [k.querySelector('.dp-kpi-l').textContent, k.querySelector('.dp-kpi-v').textContent]));
const txt = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);
const today = (page) => page.evaluate(() => { const x = DashPro.compute(DashPro.rangeFor('today')); const A = x.A; return { rev: A.revenue, cogs: A.cogs, count: A.count, items: A.items, unpaid: A.unpaid, cash: A.method.cash.amt, mpesa: A.method.mpesa.amt, exp: x.expTotal, hasCost: x.hasCost, top: Object.values(A.item).sort((a, b) => b.qty - a.qty)[0], rows: x.rows.map((r) => r.name), low: x.low.map((r) => r.name), out: x.out.map((r) => r.name), slow: x.slow.map((r) => r.name), invValue: x.invValue, noStock: x.noStock, expiry: x.expiry && { expired: x.expiry.expired.map((e) => [e.name, e.batch, e.qty]), soon: x.expiry.soon.map((e) => [e.name, e.qty]) }, prod: x.prod && { runs: x.prod.runs, units: x.prod.units, used: x.prod.used.map((u) => [u.name, u.qty]), can: x.prod.can.map((c) => [c.name, c.n]) }, alerts: DashPro.alerts(x).map((a) => a.text) }; });
async function withApp(fn) {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try { await fn(browser, base); } finally { await browser.close(); srv.close(); }
}

test('Pharmacy: figures reconcile with the sales and batch records, expiry is watched', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, pharmacySeed());
    const k = await kpis(page); const get = (l) => (k.find((x) => x[0].toLowerCase().includes(l)) || [])[1];
    assert.equal(get('sales'), 'KES 900');             // 300 + 400 + 200 (voided and unpaid left out)
    assert.equal(get('transactions'), '3');
    assert.equal(get('items sold'), '7');
    assert.equal(get('gross profit'), 'KES 360');       // 900 - 540 (cost of goods)
    const d = await today(page);
    assert.equal(d.rev, 900); assert.equal(d.cogs, 3 * 60 + 180 + 60 + 2 * 60); assert.equal(d.cash + d.mpesa, d.rev); assert.equal(d.unpaid, 80); assert.equal(d.exp, 250);
    assert.equal(d.top.name, 'Paracetamol 500mg'); assert.equal(d.top.qty, 6);
    assert.deepEqual(d.rows.sort(), ['Amoxicillin 250mg', 'Cough Syrup', 'Paracetamol 500mg', 'Vitamin C'], 'the service is not a stock row');
    assert.deepEqual(d.low, ['Amoxicillin 250mg']); assert.deepEqual(d.out, ['Cough Syrup']); assert.deepEqual(d.slow, ['Vitamin C']);
    assert.equal(d.invValue, 40 * 60 + 2 * 180 + 20 * 40);
    // the old cards (kept for branch compare / print) agree with the new figures
    assert.equal(await txt(page, '#dash-today-revenue'), 'KES 900.00');
    assert.equal(await txt(page, '#dash-low-stock-count'), String(d.low.length + d.out.length));
    // expiry: per batch - the 5 expired units of B1, and Amoxicillin inside the warning window; the B2 batch (200 days away) is fine
    assert.deepEqual(d.expiry.expired, [['Paracetamol 500mg', 'B1', 5]]); assert.deepEqual(d.expiry.soon, [['Amoxicillin 250mg', 2]]);
    assert.ok(d.alerts.some((a) => /past expiry/.test(a)) && d.alerts.some((a) => /expire within/.test(a)));
    assert.match(await txt(page, '[data-w="expiry"]'), /Expiry watch[\s\S]*Expired[\s\S]*Paracetamol/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

test('Production: produced items are not stock, runs and materials come from the production log', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, productionSeed());
    const k = await kpis(page); const get = (l) => (k.find((x) => x[0].toLowerCase().includes(l)) || [])[1];
    assert.equal(get('sales'), 'KES 700');             // 500 + 200
    assert.equal(get('transactions'), '2');
    assert.equal(get('items sold'), '6');
    const d = await today(page);
    assert.equal(d.rev, 700); assert.equal(d.cogs, 5 * 40 + 120); assert.equal(d.cash + d.mpesa, d.rev); assert.equal(d.unpaid, 150); assert.equal(d.exp, 250);
    assert.equal(d.top.name, 'Bread'); assert.equal(d.top.qty, 5);
    assert.ok(!d.rows.includes('Bread'), 'a produced item has no stock of its own');
    assert.deepEqual(d.rows.sort(), ['Candle', 'Flour', 'Mug', 'Sugar']);
    assert.deepEqual(d.out, ['Mug'], 'Bread (qty 0) is not reported out of stock'); assert.deepEqual(d.low, ['Sugar']); assert.deepEqual(d.slow.sort(), ['Candle', 'Flour', 'Sugar']);
    assert.equal(d.invValue, 100 * 50 + 2 * 80 + 12 * 90);
    assert.equal(await txt(page, '#dash-today-revenue'), 'KES 700.00');
    assert.equal(d.prod.runs, 1); assert.equal(d.prod.units, 5); assert.deepEqual(d.prod.used, [['Flour', 2.5], ['Sugar', 0.5]]);
    assert.equal(d.prod.can.length, 1); assert.equal(d.prod.can[0][0], 'Bread'); assert.ok(d.prod.can[0][1] >= 19 && d.prod.can[0][1] <= 20, 'sugar limits it: 2kg / 0.1kg = 20');
    assert.match(await txt(page, '[data-w="production"]'), /Production runs[\s\S]*Bread/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

test('Services: revenue and top services reconcile, stock is honestly "not tracked"', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, servicesSeed());
    const k = await kpis(page); const get = (l) => (k.find((x) => x[0].toLowerCase().includes(l)) || [])[1];
    assert.equal(get('sales'), 'KES 2,500');           // 1000 + 1500
    assert.equal(get('transactions'), '2');
    assert.equal(get('items sold'), '3');
    assert.equal(get('gross profit'), 'No data', 'no costs recorded: profit is not invented');
    assert.ok(!k.some((x) => /stock value/i.test(x[0])), 'no stock value tile for a service business');
    const d = await today(page);
    assert.equal(d.rev, 2500); assert.equal(d.cash + d.mpesa, d.rev); assert.equal(d.unpaid, 1500); assert.equal(d.exp, 250); assert.equal(d.hasCost, false);
    assert.equal(d.top.name, 'Haircut'); assert.equal(d.top.qty, 2);
    assert.equal(d.noStock, true); assert.deepEqual(d.rows, []); assert.deepEqual(d.out, []);
    assert.ok(!d.alerts.some((a) => /out of stock|low on stock/.test(a)), 'no stock alerts without stock');
    for (const w of ['inventory', 'slow', 'movement']) assert.match(await txt(page, `[data-w="${w}"]`), /not tracked/i);
    assert.equal(await txt(page, '#dash-today-revenue'), 'KES 2500.00');
    assert.ok(await page.evaluate(() => !!document.getElementById('svc-dash-cards')), 'the Services engine cards are still there');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

for (const [name, seedFn] of [['pharmacy', pharmacySeed], ['production', productionSeed], ['services', servicesSeed]]) {
  test(`${name}: empty state, phone layout, dark theme, date ranges`, { skip, timeout: 150000 }, async () => {
    await withApp(async (browser, base) => {
      const empty = seedFn(); empty.sales = []; empty.expenses = []; if (empty.production) empty.production = [];
      const e = await open(browser, base, empty, 390);
      assert.match(await txt(e.page, '#dash-pro-root'), /No sales yet/);
      assert.equal(await e.page.evaluate(() => document.querySelectorAll('#dash-pro-root svg.dp-line').length), 0, 'no empty charts drawn');
      assert.deepEqual(e.errors, []);
      await e.ctx.close();
      const { ctx, page, errors } = await open(browser, base, seedFn(), 390);
      for (const p of ['yesterday', 'week', 'month', 'today']) { await page.click(`[data-preset="${p}"]`); await page.waitForTimeout(500); }
      await page.waitForTimeout(600);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll on a phone');
      assert.ok(await page.evaluate(() => { const r = document.getElementById('dash-pro-root'); return r.scrollWidth <= r.clientWidth + 1; }), 'the dashboard itself fits the phone');
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector('.dp-kpi')).backgroundColor !== 'rgb(255, 255, 255)'), 'dark theme card');
      assert.equal(await page.evaluate(() => document.querySelectorAll('#dash-classic [id^="dash-"]').length >= 6), true, 'the classic snapshot ids are still on the page');
      assert.deepEqual(errors, []);
      await ctx.close();
    });
  });
}
