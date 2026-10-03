import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// zip 187: the Water/Aqua dashboard command center - every figure reconciles with the sales / bills / tank records, each sale is counted at its own
// site (an old "both" record belongs to the Shop), voided and unpaid sales never count, empty states are honest, a broken widget never takes the page
// down, the classic cards keep filling in (branch compare / printed report), and the layout does not overflow a phone.
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
const SHOP = 'site-shop-1', PROD = 'site-production';
const MIN = 60 * 1000;

function seed() {
  const products = [
    { code: 'B1', category: 'bottled', name: '500ml Sealed Bottle', sizeML: 500, price: 20, wholesalePrice: 10, qty: 40, stock: { [SHOP]: 40, [PROD]: 0 }, vatCategory: 'A' },
    { code: 'BL1', category: 'bale', name: '500ml Bale', sizeML: 500, bottlesPerBale: 12, baleKind: 'standard', price: 200, wholesalePrice: 100, qty: 0, stock: { [SHOP]: 0, [PROD]: 0 }, vatCategory: 'A' },
    { code: 'A1', category: 'accessory', name: 'Dispenser', price: 100, wholesalePrice: 60, qty: 2, stock: { [SHOP]: 2, [PROD]: 0 }, vatCategory: 'A' },
  ];
  const line = (type, name, price, qty, extra = {}) => ({ type, code: null, refillSizeId: null, name, sizeML: null, qty, price, materialsUsed: [], vatCategory: 'A', ...extra });
  const refill = (qty) => line('refill', '1L Refill', 10, qty, { sizeML: 1000, refillSizeId: 'size-1' });
  const sale = (id, minAgo, siteId, items, method, extra = {}) => {
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    return { id, siteId, refNumber: 'ref-' + id, timestamp: iso(minAgo * MIN), orderType: 'walkin', paymentMethod: method, paid: true, cashAmount: method === 'cash' ? total : 0, mpesaAmount: method === 'mpesa' ? total : 0, cardAmount: 0, servedBy: 'Amina', items, total, waterCostPerLiterAtSale: 1, ...extra };
  };
  const salesLog = [
    sale('s1', 10, SHOP, [refill(3)], 'cash'),                                                             // 30   litres 3     cost 3
    sale('s2', 20, SHOP, [line('bottled', '500ml Sealed Bottle', 20, 10, { code: 'B1', sizeML: 500, costAtSale: 10 })], 'mpesa', { servedBy: 'Brian' }),   // 200  litres 5   cost 100
    sale('s3', 30, SHOP, [line('bale', '500ml Bale', 200, 2, { code: 'BL1', sizeML: 500, costAtSale: 100 })], 'cash'),                                     // 400  litres 12  cost 200
    sale('s4', 40, SHOP, [refill(5)], 'cash', { voided: true }),                                           // voided: never counted
    sale('s5', 50, SHOP, [line('bottled', '500ml Sealed Bottle', 20, 1, { code: 'B1', sizeML: 500 })], 'bill', { paid: false, total: 70 }),   // unpaid: not revenue
    sale('s6', 60, SHOP, [line('bulk-booking', 'Bulk Order - Acme (5,000L)', 700, 1, { costShare: 400 })], 'cash'),                                          // 700  litres 5000 cost 400
    sale('p1', 15, PROD, [refill(4)], 'mpesa'),                                                            // 40   (Production)
    sale('p2', 25, 'both', [refill(1)], 'cash'),                                                           // 10   legacy "both" record = Shop
  ];
  const bulkOrders = [
    { id: 'bo1', clientName: 'Acme', volumeLiters: 5000, pricePerLiter: 0.14, totalPrice: 700, scheduledDate: '2020-01-01', status: 'fulfilled', depositAmount: 0, siteId: SHOP, fulfilledSaleId: 's6', createdAt: iso(5000 * MIN) },
    { id: 'bo2', clientName: 'Beta Hotel', volumeLiters: 8000, pricePerLiter: 0.1, totalPrice: 800, scheduledDate: '2020-01-02', status: 'pending', depositAmount: 100, siteId: SHOP, createdAt: iso(4000 * MIN) },
  ];
  const tanks = [
    { id: 'tank-1', siteId: SHOP, name: 'Shop Tank', capacityLiters: 5000, currentVolumeLiters: 3000, lowStockThresholdLiters: 500, refillLog: [{ id: 'r1', timestamp: iso(90 * MIN), litersAdded: 1000, cost: 800, supplier: 'Water Co', servedBy: 'Admin' }] },
    { id: 'tank-2', siteId: PROD, name: 'Production Tank', capacityLiters: 2000, currentVolumeLiters: 200, lowStockThresholdLiters: 500, refillLog: [] },
  ];
  const bills = [
    { id: 'bl1', siteId: SHOP, timestamp: iso(100 * MIN), customerName: 'Chege', items: [line('bottled', 'x', 100, 5, { code: 'B1' })], total: 500, amountPaid: 100, paid: false },        // owes 400
    { id: 'bl2', siteId: SHOP, timestamp: iso(100 * MIN), customerName: 'Wanjiru', orderType: 'delivery', paymentMethod: 'pod', deliveryStatus: 'assigned', deliveryDetails: { pod: true, fee: 0 }, items: [refill(30)], total: 300, amountPaid: 0, paid: false },   // pay on delivery, owes 300
    { id: 'bl3', siteId: PROD, timestamp: iso(100 * MIN), customerName: 'Depot', items: [], total: 200, amountPaid: 0, paid: false },            // Production's
    { id: 'bl4', siteId: SHOP, timestamp: iso(100 * MIN), customerName: 'Voided', items: [], total: 999, amountPaid: 0, voided: true },        // voided: not owed
    { id: 'bl5', siteId: SHOP, timestamp: iso(100 * MIN), customerName: 'Closed', items: [], total: 888, amountPaid: 888, closed: true },      // settled
  ];
  const debts = [{ id: 'd1', siteId: SHOP, customerName: 'Mwangi', amount: 150, payments: [{ amount: 50 }], createdAt: iso(1000 * MIN) }];
  const expenses = [{ id: 'e1', timestamp: iso(5 * MIN), category: 'Rent', description: 'Shop', amount: 250, transactionCost: 5 }];
  const returns = [{ id: 'rt1', timestamp: iso(8 * MIN), type: 'return', siteId: SHOP, itemCode: 'B1', itemName: '500ml Sealed Bottle', qty: 2, restocked: true, servedBy: 'Amina' }];
  const productionLog = [{ id: 'pl1', timestamp: iso(12 * MIN), siteId: PROD, producedBy: 'Admin', targetKind: 'product', targetId: 'B1', targetName: '500ml Sealed Bottle', qty: 100 }];
  const refillSizes = [{ id: 'size-1', sizeML: 1000, label: '1L', price: 10, siteId: SHOP, vatCategory: 'A' }];
  return { products, salesLog, bulkOrders, tanks, bills, debts, expenses, returns, productionLog, refillSizes };
}
async function open(browser, base, data, width = 390, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 700, hasTouch: width < 700, acceptDownloads: true });
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([h, d, site]) => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    localStorage.setItem('aqua_pw_hash', h); localStorage.setItem('aqua_biz_name', 'Test Aqua'); localStorage.setItem('aqua_active_site_id', site);
    const put = (k, v) => localStorage.setItem(k, JSON.stringify(v));
    put('aqua_products', d.products); put('aqua_sales_log', d.salesLog); put('aqua_bulk_orders', d.bulkOrders); put('aqua_tanks', d.tanks); put('aqua_bills', d.bills);
    put('aqua_debts', d.debts); put('aqua_expenses', d.expenses); put('aqua_returns', d.returns); put('aqua_production_log', d.productionLog); put('aqua_refill_sizes', d.refillSizes);
  }, [H, data, opts.site || SHOP]);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.goto(base + '/water/index.html'); await page.waitForTimeout(1500);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; });
  await page.evaluate(() => { document.querySelector('.tab-link[data-tab="dashboard-tab"]').click(); });
  await page.waitForSelector('#dash-pro-root .dp-kpis', { timeout: 10000 });
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}
const txt = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);
const kpiMap = (page) => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('.dp-kpi')).map((k) => [k.querySelector('.dp-kpi-l').textContent, k.querySelector('.dp-kpi-v').textContent])));
async function withBrowser(fn) {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try { await fn(browser, base); } finally { await browser.close(); srv.close(); }
}

test('Shop view: figures reconcile with the records (voided / unpaid excluded; legacy "both" counts for the Shop)', { skip, timeout: 120000 }, async () => {
  await withBrowser(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, seed());
    const k = await kpiMap(page);
    assert.equal(k["Today's sales"], 'KES 1,340');          // 30 + 200 + 400 + 700 + 10 (production's 40 is not the Shop's)
    assert.equal(k['Transactions'], '5');
    assert.equal(k['Refills sold'], '4');                    // 3 + the legacy "both" record's 1
    assert.equal(k['Bottles & bales sold'], '12');
    assert.match(k['Litres sold'], /^5,021 L/);              // refills 4 + bottles 5 + bale 12 + bulk 5,000
    const d = await page.evaluate(() => {
      const r = DashPro.rangeFor('today'), x = DashPro.compute(r);
      const app = salesLog.filter((s) => !s.voided && s.paid !== false && (s.siteId === 'site-shop-1' || s.siteId === 'both') && new Date(s.timestamp).getTime() >= r.from).reduce((a, s) => ({ rev: a.rev + s.total, cost: a.cost + saleCogs(s) }), { rev: 0, cost: 0 });
      return { rev: x.A.revenue, cogs: x.A.cogs, unpaid: x.A.unpaid, unpaidCount: x.A.unpaidCount, cash: x.A.method.cash.amt, mpesa: x.A.method.mpesa.amt, lit: x.A.lit, app, scope: x.scope.key, cat: x.A.rev };
    });
    assert.equal(d.rev, 1340); assert.equal(d.app.rev, d.rev, 'same as the app\'s own sales filter');
    assert.equal(d.cogs, 3 + 100 + 200 + 400 + 1); assert.equal(d.app.cost, d.cogs, 'same cost as the app\'s saleCogs');
    assert.equal(d.unpaid, 70); assert.equal(d.unpaidCount, 1);
    assert.equal(d.cash + d.mpesa, d.rev, 'payment methods add up to revenue');
    assert.deepEqual(d.lit, { refill: 4, packaged: 17, bulk: 5000 });
    assert.equal(d.rev, d.cat.refill + d.cat.bottled + d.cat.bale + d.cat.bulk + d.cat.other + d.cat.payment, 'category shares add up to sales');
    assert.equal(d.scope, SHOP);
    assert.equal(k['Gross profit'], 'KES 636');              // 1340 - 704
    assert.equal(k['Expenses'], 'KES 255');                   // 250 + 5 transaction cost
    assert.equal(k['Tank level'], '60%');
    assert.equal(k['Owed to you'], 'KES 800');                // bills 400 + 300 (pay on delivery) + debt 100; Production's bill, the voided and the closed bill are not the Shop's
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

test('sites are never mixed: Production, All sites, and staff stay inside their own site', { skip, timeout: 120000 }, async () => {
  await withBrowser(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, seed());
    const r = await page.evaluate(() => {
      const range = DashPro.rangeFor('today'), shop = DashPro.compute(range, { scope: 'site-shop-1' }), prod = DashPro.compute(range, { scope: 'site-production' }), all = DashPro.compute(range, { scope: 'all' });
      const sc = (x) => ({ rev: x.A.revenue, n: x.A.count, lit: x.A.lit.refill + x.A.lit.packaged + x.A.lit.bulk, owed: x.billOwed, tank: x.tankVol, out: x.out.length, prodUnits: x.prodUnits });
      // a staff member only ever sees their own site, whatever was asked for
      const saved = currentServer; currentServer = { id: 'x', name: 'Amina' };
      const staff = DashPro.compute(range, { scope: 'all' }).scope.key; currentServer = saved;
      return { shop: sc(shop), prod: sc(prod), all: sc(all), rows: all.siteRows.map((s) => [s.id, s.rev, s.n]), staff };
    });
    assert.deepEqual(r.shop, { rev: 1340, n: 5, lit: 5021, owed: 700, tank: 3000, out: 1, prodUnits: 0 });   // out: the Bale has no stock at the Shop
    assert.equal(r.prod.rev, 40); assert.equal(r.prod.n, 1); assert.equal(r.prod.lit, 4); assert.equal(r.prod.owed, 200); assert.equal(r.prod.tank, 200); assert.equal(r.prod.prodUnits, 100);
    assert.equal(r.all.rev, 1380); assert.equal(r.all.n, 6); assert.equal(r.all.owed, 900); assert.equal(r.all.tank, 3200);
    assert.deepEqual(r.rows, [[SHOP, 1340, 5], [PROD, 40, 1]]);
    assert.equal(r.staff, SHOP);
    // the site picker in the header drives the page
    await page.selectOption('#dp-site', PROD); await page.waitForTimeout(500);
    assert.equal((await kpiMap(page))['Sales'] || (await kpiMap(page))["Today's sales"], 'KES 40');
    assert.match(await txt(page, '.dp-head'), /Production/);
    await page.selectOption('#dp-site', 'all'); await page.waitForTimeout(700);
    assert.equal((await kpiMap(page))["Today's sales"], 'KES 1,380');
    assert.match(await txt(page, '[data-w="sites"]'), /Production/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

test('tank, days of supply, bulk orders, deliveries, alerts and drill-down', { skip, timeout: 120000 }, async () => {
  await withBrowser(async (browser, base) => {
    const data = seed();
    const { ctx, page, errors } = await open(browser, base, data);
    // add older refill sales (3 days ago and yesterday) so there is history to estimate the pace from
    await page.evaluate(() => {
      const at = (key) => new Date(bizDayBounds(key).from + 12 * 3600e3).toISOString();
      const addDays = (k, n) => { const p = k.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); };
      const t = todayDateString(), mk = (id, key, qty) => ({ id, siteId: 'site-shop-1', refNumber: id, timestamp: at(key), orderType: 'walkin', paymentMethod: 'cash', paid: true, cashAmount: qty * 10, mpesaAmount: 0, servedBy: 'Amina', items: [{ type: 'refill', name: '1L Refill', sizeML: 1000, qty, price: 10, materialsUsed: [] }], total: qty * 10, waterCostPerLiterAtSale: 1 });
      salesLog.push(mk('old3', addDays(t, -3), 100), mk('old1', addDays(t, -1), 2));
      DashPro.open();
    });
    await page.waitForTimeout(800);
    const d = await page.evaluate(() => { const x = DashPro.compute(DashPro.rangeFor('today')); return { vol: x.tankVol, perDay: x.perDay, win: x.windowDays, supply: x.supplyDays, delivered: x.delivered, prevRev: x.P.revenue, bulk: x.bulkOpen.map((b) => b.id), bulkLit: x.bulkLitres, pod: [x.podCount, x.podOwed], deliv: x.openDeliv, due: x.bulkDue.length }; });
    assert.equal(d.win, 4);
    assert.ok(Math.abs(d.perDay - (4 + 5000 + 100 + 2) / 4) < 1e-6, 'average daily draw = refills + bulk litres over the window');
    assert.ok(Math.abs(d.supply - 3000 / d.perDay) < 1e-6);
    assert.equal(d.delivered, 1000); assert.equal(d.prevRev, 20);
    assert.deepEqual(d.bulk, ['bo2']); assert.equal(d.bulkLit, 8000); assert.deepEqual(d.pod, [1, 300]); assert.equal(d.deliv, 1); assert.equal(d.due, 1);
    const tank = await txt(page, '[data-w="tank"]');
    assert.match(tank, /Shop Tank/); assert.match(tank, /Days of supply/);
    const alerts = await txt(page, '[data-w="alerts"]');
    assert.match(alerts, /low on stock/); assert.match(alerts, /waiting to be paid on delivery/); assert.match(alerts, /bulk order is due/);
    assert.match(await txt(page, '[data-w="bulk"]'), /need/i, 'open orders larger than the tank are flagged');
    // drill-down: an alert and a widget link open the real tab
    await page.click('[data-w="tank"] [data-goto="tank-tab"]'); await page.waitForTimeout(400);
    assert.ok(await page.evaluate(() => document.getElementById('tank-tab').classList.contains('active')), 'tank link opens the Bulk Tank tab');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

test('classic cards keep their ids and the printed report still works', { skip, timeout: 120000 }, async () => {
  await withBrowser(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, seed());
    const ids = ['dash-today-revenue', 'dash-month-revenue', 'dash-liters-today', 'dash-tank-level', 'dash-low-stock-count', 'dash-bills-total', 'dash-top-sellers-table', 'dash-top-staff-table', 'dash-upcoming-bookings-table', 'dash-branch-switcher', 'dash-branches-section'];
    for (const id of ids) assert.ok(await page.evaluate((i) => !!document.getElementById(i), id), id + ' still exists');
    assert.ok(await page.evaluate(() => !!document.querySelector('#dash-classic #dash-today-revenue')), 'the classic cards live inside the collapsible snapshot');
    assert.notEqual((await txt(page, '#dash-today-revenue')).trim(), '—', 'the classic cards are still filled in');
    await page.evaluate(() => printDashboardReport());
    assert.match(await txt(page, '#sales-report-body'), /Dashboard Report/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

test('date range chips, previous-period comparison, CSV export, and an honest empty state', { skip, timeout: 120000 }, async () => {
  await withBrowser(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, seed());
    const ranges = await page.evaluate(() => ['today', 'yesterday', '7d', '30d', 'month', 'lastmonth'].map((p) => { const r = DashPro.rangeFor(p, '', '', '2026-10-15'); return [p, r.fromKey, r.toKey, r.days, r.prevFromKey, r.prevToKey]; }));
    assert.deepEqual(ranges, [['today', '2026-10-15', '2026-10-15', 1, '2026-10-14', '2026-10-14'], ['yesterday', '2026-10-14', '2026-10-14', 1, '2026-10-13', '2026-10-13'], ['7d', '2026-10-09', '2026-10-15', 7, '2026-10-02', '2026-10-08'],
      ['30d', '2026-09-16', '2026-10-15', 30, '2026-08-17', '2026-09-15'], ['month', '2026-10-01', '2026-10-15', 15, '2026-09-16', '2026-09-30'], ['lastmonth', '2026-09-01', '2026-09-30', 30, '2026-08-02', '2026-08-31']]);
    // with nothing earlier to compare against, no percentage is invented
    assert.match(await txt(page, '.dp-kpi'), /No earlier data to compare/);
    await page.click('[data-preset="7d"]'); await page.waitForTimeout(500);
    assert.match(await txt(page, '.dp-range'), /previous 7 days/);
    const csv = await page.evaluate(() => DashPro.exportCsv());
    assert.match(csv, /Sales,1340/); assert.match(csv, /Litres sold,5021/); assert.match(csv, /Site,Shop/);
    await page.click('[data-preset="today"]'); await page.waitForTimeout(400);
    await ctx.close();
    // no sales at all: honest empty states, no empty charts drawn
    const e = seed(); e.salesLog = []; e.expenses = []; e.bills = []; e.debts = []; e.bulkOrders = []; e.returns = []; e.productionLog = [];
    const o2 = await open(browser, base, e);
    assert.match(await txt(o2.page, '#dash-pro-root'), /No sales yet/);
    assert.equal(await o2.page.evaluate(() => document.querySelectorAll('#dash-pro-root svg.dp-line').length), 0, 'no empty charts drawn');
    assert.equal((await kpiMap(o2.page))['Gross profit'], 'No data');
    assert.deepEqual(errors, []); assert.deepEqual(o2.errors, []);
    await o2.ctx.close();
  });
});

test('a failing widget never takes the page down; phone layout has no horizontal scroll; dark mode', { skip, timeout: 120000 }, async () => {
  await withBrowser(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, seed(), 390);
    await page.evaluate(() => { const orig = DashPro.compute; DashPro.compute = (r, o) => { const x = orig(r, o); x.tankRows = null; return x; }; DashPro.open(); });
    await page.waitForTimeout(1200);
    assert.match(await txt(page, '[data-w="tank"]'), /could not load/);
    assert.match(await txt(page, '[data-w="payments"]'), /Cash/, 'other widgets still draw');
    assert.ok(await page.evaluate(() => document.querySelectorAll('[data-w]').length >= 10));
    await page.evaluate(() => location.reload()); await page.waitForTimeout(100);
    await ctx.close();
    const o = await open(browser, base, seed(), 390);
    for (const p of ['today', '7d', 'month']) { await o.page.click('[data-preset="' + p + '"]'); await o.page.waitForTimeout(700); assert.ok(await o.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll on a phone (' + p + ')'); }
    await o.page.click('[data-act="refresh"]'); await o.page.waitForTimeout(700);
    await o.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    assert.ok(await o.page.evaluate(() => getComputedStyle(document.querySelector('.dp-kpi')).backgroundColor !== 'rgb(255, 255, 255)'), 'dark theme card');
    const wide = await open(browser, base, seed(), 1280);
    assert.ok(await wide.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no overflow on desktop either');
    assert.deepEqual(errors, []); assert.deepEqual(o.errors, []); assert.deepEqual(wide.errors, []);
    await o.ctx.close(); await wide.ctx.close();
  });
});
