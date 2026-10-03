import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// zip 187: the Hotel dashboard command center - every figure reconciles with the sales / tab / stock records and with the classic snapshot cards,
// voided and unpaid sales never count, rooms only appear when rooms exist, empty states are honest, a broken widget never takes the page down,
// and the layout does not overflow a phone.
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
const MIN = 60 * 1000, HOUR = 60 * MIN;
const dayKeyOfMs = (ms) => new Date(ms + 3 * HOUR).toISOString().slice(0, 10);   // the shop's business date (East Africa time)

function seed({ withCost = true, withRooms = true, withKegs = true } = {}) {
  const wp = (n) => (withCost ? n : 0);
  const inv = [
    { code: 'B1', type: 'item', name: 'Beer', category: 'Drinks', price: 300, wholesalePrice: wp(180), qty: 24, unit: 'pcs' },
    { code: 'N1', type: 'item', name: 'Nyama', category: 'Food', price: 500, wholesalePrice: wp(300), qty: 2, unit: 'pcs' },
    { code: 'C1', type: 'item', name: 'Chips', category: 'Food', price: 150, wholesalePrice: wp(60), qty: 0, unit: 'pcs' },
    { code: 'G1', type: 'item', name: 'Gin', category: 'Drinks', price: 2000, wholesalePrice: wp(1000), qty: 9, unit: 'pcs' },
    { code: 'D1', type: 'item', name: 'Loose sugar', category: 'Food', price: 20, wholesalePrice: wp(100), qty: 5, unit: 'kg', dualUnit: true, pieceQty: 10, pieceWholesalePrice: wp(10) },
    { code: 'RM1', type: 'service', name: 'Room night', category: 'Rooms', price: 4000, wholesalePrice: 0, qty: 0, unit: 'night' },
  ];
  const line = (code, name, price, qty, w, extra = {}) => ({ code, name, price, qty, unit: 'pcs', wholesalePrice: w, ...extra });
  const mk = (id, msAgo, items, by, method, extra = {}) => {
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    return { id, refNumber: 'ref-' + id, timestamp: iso(msAgo), items, servedBy: by, paymentMethod: method, paid: true, cashAmount: method === 'cash' ? total : 0, mpesaAmount: method === 'mpesa' ? total : 0, cardAmount: 0, ...extra };
  };
  const sales = [
    mk('s1', 1 * MIN, [line('B1', 'Beer', 300, 2, wp(180), { station: 'bar' }), line('N1', 'Nyama', 500, 1, wp(300), { station: 'kitchen' })], 'Cashier', 'cash', { tabId: 't1', tableOrRoom: 'Table 1' }),   // 1100, waiter Wanjiru
    mk('s2', 2 * MIN, [line('C1', 'Chips', 150, 2, wp(60), { station: 'kitchen' })], 'Brian', 'mpesa', { mpesaReceiptNumber: 'QWE123XYZ' }),                                                        // 300
    mk('s3', 3 * MIN, [line('RM1', 'Room night', 4000, 1, 0, { station: 'none', type: 'room-charge', unit: 'night' }), line('SVC-CHARGE', 'Service charge 10%', 400, 1, 0, { unit: 'service', serviceCharge: true, isService: true })], 'Cashier', 'mpesa', { tabId: 't2', tableOrRoom: 'Room 1' }), // 4400, no M-Pesa code, waiter Otieno
    mk('s4', 4 * MIN, [line('B1', 'Beer', 300, 1, 180, { station: 'bar' })], 'Brian', 'cash', { voided: true }),                                                                                      // voided: never counted
    mk('s5', 5 * MIN, [line('B1', 'Beer', 300, 1, 180, { station: 'bar' })], 'Brian', 'bill', { paid: false }),                                                                                       // unpaid: credit, not revenue
    mk('s6', 6 * MIN, [{ code: 'PART-PAY', name: 'Part payment - Table 5', price: 700, qty: 1, unit: 'service', isService: true, partPayment: true, wholesalePrice: 0 }], 'Cashier', 'cash', { tabId: 't3', tableOrRoom: 'Table 3' }), // 700 on account
    mk('s7', 7 * MIN, [line('B1', 'Beer', 300, 1, wp(180), { station: 'bar' })], 'Brian', 'cash', { orderType: 'delivery', deliveryDetails: { fee: 100 } }),                                              // 300 + 100 delivery
  ];
  const ent = (code, name, qty, price, station) => ({ code, name, qty, price, unit: 'pcs', station });
  const tabs = [
    { id: 't1', kind: 'table', label: 'Table 1', status: 'CLOSED', openedAt: iso(3 * HOUR), orders: [], waiter: 'Wanjiru', openedBy: 'Wanjiru' },
    { id: 't2', kind: 'room', label: 'Room 1', status: 'CLOSED', openedAt: iso(30 * HOUR), orders: [], waiter: 'Otieno', openedBy: 'Otieno' },
    { id: 't3', kind: 'table', label: 'Table 3', status: 'CLOSED', openedAt: iso(2 * HOUR), orders: [], waiter: 'Wanjiru', openedBy: 'Wanjiru' },
    { id: 't4', kind: 'table', label: 'Table 5', status: 'OPEN', openedAt: iso(2 * HOUR), waiter: 'Wanjiru', openedBy: 'Wanjiru', orders: [{ id: 'o1', timestamp: iso(2 * HOUR), servedBy: 'Wanjiru', entries: [ent('B1', 'Beer', 2, 300, 'bar'), ent('N1', 'Nyama', 1, 500, 'kitchen')] }], lineStatus: { 'o1:0': { st: 'READY' } } },   // owes 1100; beer ready, nyama new
    { id: 't5', kind: 'room', label: 'Room 2', status: 'OPEN', openedAt: iso(13 * HOUR), waiter: 'Otieno', openedBy: 'Otieno', orders: [{ id: 'o2', timestamp: iso(13 * HOUR), servedBy: 'Otieno', entries: [ent('N1', 'Nyama', 1, 800, 'kitchen')] }] },                        // owes 800, open 13 h, new
    { id: 't6', kind: 'guest', label: 'Guest: Guest 1', status: 'OPEN', openedAt: iso(10 * MIN), waiter: 'Otieno', openedBy: 'Otieno', orders: [] },                                                                                                        // empty tab: owes nothing
  ];
  const yesterday = dayKeyOfMs(NOW - 24 * HOUR);
  return {
    inv, sales, tabs,
    expenses: [{ id: 'e1', timestamp: iso(30 * 1000), category: 'Rent', description: 'Hotel', amount: 250 }],
    tables: ['Table 1', 'Table 3', 'Table 5'],
    tableStates: { 'Table 1': { status: 'occupied', reservation: null }, 'Table 5': { status: 'occupied', reservation: null } },
    rooms: withRooms ? ['Room 1', 'Room 2'] : [],
    roomStates: withRooms ? { 'Room 1': { status: 'occupied', reservation: null }, 'Room 2': { status: 'cleaning', reservation: null } } : {},
    roomStays: withRooms ? { 'Room 1': { guestName: 'Mr Kamau', guestPhone: '', checkInAt: iso(30 * HOUR), checkOutDue: yesterday, nightlyRate: 4000, depositAmount: 0, creditLimit: null, tabId: 't2' } } : {},
    kegs: withKegs ? [{ id: 'k1', tag: 'K-1', productCode: 'B1', status: 'ACTIVE', capacityMl: 50000, lowMl: 5000, usedBy: { dev1: { ml: 46000, at: 1 } }, events: [], updatedAt: 1 }] : [],
    bills: [{ id: 'b1', timestamp: iso(HOUR), customerName: 'Corporate', items: [{ code: 'N1', name: 'Event', qty: 1, price: 5000, unit: 'pcs' }], amountPaid: 1000, closed: false, dueDate: yesterday, servedBy: 'Cashier' }],
  };
}
async function open(browser, base, data, width = 390) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 700, hasTouch: width < 700, acceptDownloads: true });
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([h, d]) => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'Test Hotel');
    set('pos_inventory', d.inv); set('pos_sales_log', d.sales); set('pos_expenses', d.expenses); set('pos_tabs', d.tabs); set('pos_tables', d.tables); set('pos_rooms', d.rooms);
    set('pos_table_states', d.tableStates); set('pos_room_states', d.roomStates); set('pos_room_stays', d.roomStays); set('pos_kegs', d.kegs); set('pos_bills', d.bills);
  }, [H, data]);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.goto(base + '/hotel/index.html'); await page.waitForTimeout(1200);
  await page.evaluate(() => { document.getElementById('login-screen').style.display = 'none'; });
  await page.evaluate(() => { document.querySelector('.tab-link[data-tab="dashboard-tab"]').click(); });
  await page.waitForSelector('#dash-pro-root .dp-kpis', { timeout: 8000 });
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}
const txt = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);
const kpiMap = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.dp-kpi')).map((k) => [k.querySelector('.dp-kpi-l').textContent, k.querySelector('.dp-kpi-v').textContent]));
async function withBrowser(fn) {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try { await fn(browser, base); } finally { await browser.close(); srv.close(); }
}

test('hotel dashboard figures reconcile with the records and the classic cards (voided and unpaid excluded)', { skip, timeout: 120000 }, async () => {
  await withBrowser(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, seed());
    const kpi = await kpiMap(page);
    const get = (label) => (kpi.find((k) => k[0].toLowerCase().includes(label)) || [])[1];
    assert.equal(get('sales'), 'KES 6,900');                 // 1100 + 300 + 4400 + 700 + 400 (voided s4 and unpaid s5 never count)
    assert.equal(get('transactions'), '5');
    assert.equal(get('items sold'), '7');
    assert.equal(get('open tabs'), 'KES 1,900');             // 1100 + 800 (the empty tab owes nothing)
    assert.equal(get('tabs paid'), '3');
    assert.equal(get('orders waiting'), '2');                // nyama on Table 5 + nyama on Room 2 (the beer is ready, not waiting)
    assert.equal(get('tables in use'), '2 / 3');
    assert.equal(get('rooms occupied'), '1 / 2');
    assert.equal(get('stock value'), 'KES 14,520');
    assert.equal(get('bills & debts owed'), 'KES 4,300');   // the app's own open-bill list: the 4,000 corporate bill + the 300 unpaid sale (the app files it as a bill)
    const d = await page.evaluate(() => {
      const r = DashPro.rangeFor('today'); const x = DashPro.compute(r);
      const dept = {}; x.depts.forEach((e) => { dept[e.label] = e.rev; });
      const staff = {}; x.staffRows.forEach((e) => { staff[e.name] = e.rev; });
      return { rev: x.A.revenue, cogs: x.A.cogs, unpaid: x.A.unpaid, exp: x.expTotal, cash: x.A.method.cash.amt, mpesa: x.A.method.mpesa.amt, card: x.A.method.card.amt, other: x.A.method.other.amt, dept, deptSum: x.depts.reduce((s, e) => s + e.rev, 0), staff, staffSum: x.staffRows.reduce((s, e) => s + e.rev, 0), cat: Object.values(x.A.cat).reduce((s, c) => s + c.rev, 0), item: Object.values(x.A.item).reduce((s, c) => s + c.rev, 0), tabsValue: x.tabsValue, owing: x.owingTabs.length, long: x.longOpen.length, ready: x.ready, waitNew: x.waitNew, wait: x.wait, tabsPaidRev: x.tabsPaidRev, mpesaNoCode: x.A.mpesaNoCode, mpesaCount: x.A.mpesaCount, kegLow: x.kegInfo.low, kegLeft: x.kegInfo.leftMl, inHouse: x.inHouse, dueOut: x.dueOut, billOwed: x.billOwed, overdue: x.overdue.length, classicLow: x.classicLow, low: x.low.length, out: x.out.length, invValue: x.invValue, rowsLen: x.rows.length };
    });
    assert.equal(d.rev, 6900);   // the voided and the unpaid sale are not in it
    assert.equal(d.cash + d.mpesa + d.card + d.other, d.rev, 'payment methods add up to revenue');
    assert.equal(d.cash, 2200); assert.equal(d.mpesa, 4700);
    assert.equal(d.deptSum, d.rev, 'departments add up to revenue');
    assert.deepEqual(d.dept, { Bar: 900, Kitchen: 800, 'Rooms & lodging': 4000, 'Service charge': 400, 'Payments on account': 700, 'Delivery fees': 100 });
    assert.equal(d.staffSum, d.rev, 'waiters add up to revenue');
    assert.deepEqual(d.staff, { Wanjiru: 1800, Otieno: 4400, Brian: 700 });   // a tab's sales go to its waiter, not to the cashier who settled it
    assert.equal(d.cat + 400 + 700 + 100, d.rev, 'categories + service charge + part-payments + delivery = revenue');
    assert.equal(d.item, d.cat);
    assert.equal(d.cogs, 2 * 180 + 300 + 2 * 60 + 180);
    assert.equal(d.exp, 250);
    assert.equal(d.tabsValue, 1900); assert.equal(d.owing, 2); assert.equal(d.long, 1);
    assert.equal(d.ready, 1); assert.equal(d.waitNew, 2); assert.deepEqual(d.wait, { Kitchen: 2 });
    assert.equal(d.tabsPaidRev, 6200);
    assert.equal(d.mpesaCount, 2); assert.equal(d.mpesaNoCode, 1);
    assert.equal(d.kegLow, 1); assert.equal(d.kegLeft, 4000);
    assert.equal(d.inHouse, 1); assert.equal(d.dueOut, 1);
    assert.equal(d.billOwed, 4300); assert.equal(d.overdue, 1);
    assert.equal(d.low + d.out, d.classicLow);
    // the classic snapshot (kept in the page for branch compare and the printed report) says the same thing
    const cl = await page.evaluate(() => ['dash-today-revenue', 'dash-stock-value', 'dash-low-stock-count', 'dash-bills-total', 'dash-item-count'].map((i) => document.getElementById(i).textContent));
    assert.equal(cl[0], 'KES 6900.00'); assert.equal(cl[1], 'KES 14520.00'); assert.equal(cl[2], String(d.classicLow)); assert.equal(cl[3], 'KES 4300.00'); assert.equal(cl[4], String(d.rowsLen));
    // the drawn widgets agree with the numbers
    const body = await txt(page, '#dash-pro-root');
    assert.match(body, /Revenue by department/); assert.match(body, /Open tabs &? ?orders|Open tabs/); assert.match(body, /Tables\s*&\s*rooms/i); assert.match(body, /Kegs/);
    assert.match(await txt(page, '[data-w="alerts"]'), /M-Pesa payment.*no M-Pesa code/);
    assert.match(await txt(page, '[data-w="alerts"]'), /open for over 12 hours/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

test('missing buying prices: profit is not invented, and a clear note is shown', { skip, timeout: 120000 }, async () => {
  await withBrowser(async (browser, base) => {
    const { ctx, page } = await open(browser, base, seed({ withCost: false }));
    const kpi = await kpiMap(page);
    assert.equal((kpi.find((k) => /gross profit/i.test(k[0])) || [])[1], 'No data');
    assert.ok(!kpi.some((k) => /margin/i.test(k[0])), 'no margin without costs');
    assert.match(await txt(page, '[data-w="profit"]'), /buying prices/i);
    await ctx.close();
  });
});

test('no sales, no tabs, no rooms: honest empty states, nothing invented', { skip, timeout: 120000 }, async () => {
  await withBrowser(async (browser, base) => {
    const d = seed(); d.sales = []; d.expenses = []; d.tabs = []; d.tables = []; d.tableStates = {}; d.rooms = []; d.roomStates = {}; d.roomStays = {}; d.kegs = []; d.bills = [];
    const { ctx, page, errors } = await open(browser, base, d);
    assert.match(await txt(page, '#dash-pro-root'), /No sales yet/);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#dash-pro-root svg.dp-line').length), 0, 'no empty charts drawn');
    const kpi = await kpiMap(page);
    assert.ok(!kpi.some((k) => /rooms occupied|tables in use/i.test(k[0])), 'no occupancy KPI without rooms or tables');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-w="places"], [data-w="kegs"]').length), 0, 'no tables/rooms or keg card without any');
    assert.match(await txt(page, '[data-w="tabsw"]'), /No open tabs right now/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

test('tables but no rooms: rooms are omitted, not invented', { skip, timeout: 120000 }, async () => {
  await withBrowser(async (browser, base) => {
    const { ctx, page } = await open(browser, base, seed({ withRooms: false, withKegs: false }));
    const kpi = await kpiMap(page);
    assert.ok(kpi.some((k) => /tables in use/i.test(k[0])));
    assert.ok(!kpi.some((k) => /rooms occupied/i.test(k[0])));
    assert.ok(!/Rooms \(/.test(await txt(page, '[data-w="places"]')));
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-w="kegs"]').length), 0);
    await ctx.close();
  });
});

test('date range chips, switching views, drill-down, CSV export, a failing widget, dark mode and the phone layout', { skip, timeout: 150000 }, async () => {
  await withBrowser(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, seed(), 390);
    await page.click('[data-preset="yesterday"]'); await page.waitForTimeout(500);
    const yk = await page.evaluate(() => { const r = DashPro.rangeFor('yesterday'); return [r.fromKey, r.toKey, r.days]; });
    assert.equal(yk[0], yk[1]); assert.equal(yk[2], 1);
    assert.match(await txt(page, '.dp-range'), /Yesterday|compared/);
    const wk = await page.evaluate(() => { const r = DashPro.rangeFor('week', '', '', '2026-10-02'); const l = DashPro.rangeFor('lastweek', '', '', '2026-10-02'); const m = DashPro.rangeFor('lastmonth', '', '', '2026-01-15'); return [r.fromKey, r.toKey, l.fromKey, l.toKey, m.fromKey, m.toKey, r.days]; });
    assert.deepEqual(wk, ['2026-09-28', '2026-10-02', '2026-09-21', '2026-09-27', '2025-12-01', '2025-12-31', 5]);
    await page.click('[data-preset="month"]'); await page.waitForTimeout(500);
    assert.equal((await kpiMap(page)).find((k) => /sales/i.test(k[0]))[1], 'KES 6,900', 'this month includes today');
    await page.click('[data-preset="today"]'); await page.waitForTimeout(500);
    // department <-> order type toggle redraws just that card
    await page.click('[data-deptby="type"]'); await page.waitForTimeout(200);
    assert.match(await txt(page, '[data-w="depts"]'), /Delivery/);
    // drill-down opens the existing Tabs tab
    await page.evaluate(() => { document.querySelector('[data-w="tabsw"] [data-goto="tabs-tab"]').click(); });
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => document.getElementById('tabs-tab').classList.contains('active')), 'drill-down switched to the Tabs tab');
    await page.evaluate(() => { document.querySelector('.tab-link[data-tab="dashboard-tab"]').click(); });
    await page.waitForSelector('#dash-pro-root .dp-kpis'); await page.waitForTimeout(500);
    // CSV export carries the reconciled figures
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('[data-act="export"]')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    assert.match(csv, /Sales,6900/); assert.match(csv, /Bar,900,/); assert.match(csv, /Wanjiru,1800,/); assert.match(csv, /Owed on open tabs \(now\),1900/);
    // a widget that throws shows its own retry state and every other widget still draws
    await page.evaluate(() => { DashPro.widgets.depts = function () { throw new Error('boom'); }; DashPro.render(); });
    await page.waitForTimeout(800);
    assert.match(await txt(page, '[data-w="depts"]'), /could not load/);
    assert.ok(await page.evaluate(() => !!document.querySelector('[data-w="tabsw"] .dp-stats') && !!document.querySelector('[data-w="staff"]')), 'other widgets still drawn');
    assert.ok(await page.evaluate(() => !!document.querySelector('[data-w="depts"] [data-retry]')), 'retry offered');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll on a phone');
    const wide = await page.evaluate(() => Array.from(document.querySelectorAll('#dash-pro-root *')).filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('.dp-chips') && !e.closest('.dp-tbl') && !e.closest('svg')).length);
    assert.equal(wide, 0, 'nothing inside the dashboard pokes out of a 390px screen');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector('.dp-kpi')).backgroundColor !== 'rgb(255, 255, 255)'), 'dark theme card');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no overflow in dark mode either');
    assert.deepEqual(errors.filter((e) => !/boom/.test(e)), []);
    await ctx.close();
  });
});

test('desktop width keeps the layout in a grid with no page overflow', { skip, timeout: 120000 }, async () => {
  await withBrowser(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, seed(), 1280);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    assert.ok(await page.evaluate(() => document.querySelectorAll('#dash-pro-root .dp-card').length >= 12), 'sections drawn');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});
