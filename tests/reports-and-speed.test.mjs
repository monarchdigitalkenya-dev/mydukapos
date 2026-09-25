import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const SHOP = ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (daysAgo, hour, min = 0) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hour, min, 0, 0); return d.toISOString(); };
const sale = (id, ts, who, lines, method = 'cash') => ({ id, refNumber: 'REF-' + id, timestamp: ts, paymentMethod: method, paid: true, servedBy: who, items: lines.map(([code, name, qty, price, cost]) => ({ code, name, qty, price, wholesalePrice: cost })) });
const INV = [{ code: 'A1', type: 'item', name: 'Tea', price: 100, wholesalePrice: 40, qty: 20, unit: 'pcs', category: 'Drinks' }, { code: 'B2', type: 'item', name: 'Bread', price: 60, wholesalePrice: 45, qty: 2, unit: 'pcs', category: 'Food' }, { code: 'C3', type: 'item', name: 'Sugar', price: 200, wholesalePrice: 150, qty: 0, unit: 'kg', category: 'Food' }, { code: 'D4', type: 'item', name: 'Old Stock', price: 90, wholesalePrice: 70, qty: 5, unit: 'pcs', category: 'Food' }];
const SALES = [
  sale('s1', at(0, 9), 'Jane', [['A1', 'Tea', 2, 100, 40]]),                       // today 09:00 = 200
  sale('s2', at(0, 13), 'Jane', [['A1', 'Tea', 3, 100, 40], ['B2', 'Bread', 1, 60, 45]]),   // today 13:00 = 360
  sale('s3', at(0, 13, 30), 'Peter', [['C3', 'Sugar', 1, 200, 150]], 'mpesa'),     // today 13:30 = 200
  sale('s4', at(1, 13), 'Peter', [['A1', 'Tea', 1, 100, 40]], 'mpesa'),            // yesterday 13:00 = 100
  sale('s5', at(40, 10), 'Jane', [['B2', 'Bread', 5, 60, 45]]),                    // 40 days ago = 300 (outside "last 30 days")
  { ...sale('s6', at(0, 15), 'Jane', [['A1', 'Tea', 9, 100, 40]]), voided: true }, // voided: never counted
];
async function session(app) {
  const b = await boot(app, { storage: { pos_inventory: JSON.stringify(INV), pos_sales_log: JSON.stringify(SALES), pos_expenses: JSON.stringify([{ id: 'e1', timestamp: at(0, 8), category: 'Transport', description: 'Fuel', amount: 150 }, { id: 'e2', timestamp: at(2, 8), category: 'Rent', description: 'Shop', amount: 500 }]) }, wait: 1500 });
  b.w.eval("showToast = function (m) { window.__t = (window.__t || []).concat(m); }");
  return b;
}
const sel = (b, v) => { b.d.getElementById('reports-range-select').value = v; };
const text = (b) => b.d.getElementById('reports-output').innerHTML.replace(/<title>[^<]*<\/title>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

for (const app of SHOP) {
  test(`${app}: the Reports tab generates sales, insights, staff, stock, bills & debts and expenses & profit reports with the right figures`, async () => {
    const b = await session(app);
    const { w, d, errors } = b;
    assert.ok(d.getElementById('reports-tab-btn'), 'the tab is there');
    d.getElementById('reports-tab-btn').click(); await sleep(150);
    assert.ok(d.getElementById('reports-tab').classList.contains('active'));
    // Sales — last 30 days: 200 + 360 + 200 + 100 = 860 (the voided sale and the 40-day-old one are left out)
    sel(b, 'last30'); w.eval("reportsGenerate('sales')");
    let t = text(b);
    assert.match(t, /Total sales KES 860/); assert.match(t, /Number of sales 4/); assert.match(t, /Average sale KES 215/);
    assert.match(t, /cash\s*2\s*KES 560\s*65%/); assert.match(t, /mpesa\s*2\s*KES 300\s*35%/);
    assert.match(t, /Tea\s*6\s*KES 600/);
    // Today only
    sel(b, 'today'); w.eval('reportsRangeChanged()');
    assert.match(text(b), /Total sales KES 760/);
    // Insights: busiest hour 13:00, best worker Jane, weekly and monthly trends have 12 points
    sel(b, 'last30'); w.eval("reportsGenerate('insights')");
    t = text(b);
    assert.match(t, /Busiest hour: 13:00–14:00 \(3 sales\)/); assert.match(t, /Best-earning hour: 13:00–14:00 \(KES 660\)/);
    assert.match(t, /Best worker: Jane \(KES 560 from 2 sales\)/);
    assert.equal(d.querySelectorAll('#reports-output svg').length, 3, 'hour chart, weekday chart, trend line');
    w.eval("window.__reportsTrend = 'weekly'; reportsGenerate('insights')");
    assert.equal(d.querySelectorAll('#reports-output svg')[2].querySelectorAll('circle').length, 12, '12 weekly points');
    w.eval("window.__reportsTrend = 'monthly'; reportsGenerate('insights')");
    assert.equal(d.querySelectorAll('#reports-output svg')[2].querySelectorAll('circle').length, 12, '12 monthly points');
    assert.ok(d.querySelector('#reports-output svg polyline'), 'a trend LINE');
    // Staff
    w.eval("reportsGenerate('staff')"); t = text(b);
    assert.match(t, /Jane\s*2\s*KES 560\s*KES 280\s*65%/); assert.match(t, /Peter\s*2\s*KES 300\s*KES 150\s*35%/);
    // Stock: value at cost = 20*40 + 2*45 + 0 + 5*70 = 1240; retail = 2000+120+0+450 = 2570; low = Bread; out = Sugar; unsold in period = Old Stock
    w.eval("reportsGenerate('stock')"); t = text(b);
    assert.match(t, /Stock value \(cost\) KES 1,240/); assert.match(t, /Stock value \(retail\) KES 2,570/); assert.match(t, /Low stock \(1\)/); assert.match(t, /Out of stock \(1\)/); assert.match(t, /Not sold in this period \(1\)/);
    // Bills & debts
    w.eval("bills.push({ id: 'b1', customerName: 'Jane W', timestamp: new Date(Date.now() - 10 * 86400000).toISOString(), items: [{ name: 'x', qty: 2, price: 500 }], amountPaid: 300 }); debts.push({ id: 'd1', customerName: 'Otieno', amount: 400, createdAt: new Date().toISOString() })");
    w.eval("reportsGenerate('bills')"); t = text(b);
    assert.match(t, /Open bills 1 KES 700 owed/); assert.match(t, /Debts owed 1 KES 400 owed/); assert.match(t, /Bills 8–30 days KES 700/);
    // Expenses & profit (last 30 days): sales 860, cost 6*40 + 1*45 + 1*150 ... = tea 6x40=240, bread 1x45=45, sugar 150 => 435, gross 425, expenses 650, net -225
    w.eval("reportsGenerate('expenses')"); t = text(b);
    assert.match(t, /Sales KES 860/); assert.match(t, /Cost of goods sold KES 435/); assert.match(t, /Gross profit KES 425/); assert.match(t, /Expenses KES 650/); assert.match(t, /Net profit KES -225/);
    assert.match(t, /Transport\s*KES 150/);
    // CSV and print are wired
    w.eval("window.__csvBlob = null; URL.createObjectURL = (bl) => { window.__csvBlob = bl; return 'blob:x'; }; HTMLAnchorElement.prototype.click = function () {}");
    w.eval('reportsCsv()');
    assert.ok(w.eval('window.__csvBlob') && w.eval('window.__csvBlob.size') > 20, 'a CSV was made');
    w.eval("window.__printed = 0; window.print = () => { window.__printed++; window.dispatchEvent(new window.Event('afterprint')); }; window.open = () => ({ document: { write() {}, close() {} }, focus() {}, print() { window.__printed++; } })");
    w.eval('reportsPrint()'); await sleep(400);
    assert.ok(w.eval('window.__printed') >= 1, 'print was called');
    assert.deepEqual(errors, []);
    b.close();
  });
}

test('the "more reports" shortcuts only show for screens this app has', async () => {
  const b = await session('hotel/index.html');
  const shown = [...b.d.querySelectorAll('#reports-more-links [data-goto]')].filter((x) => x.style.display !== 'none').map((x) => x.dataset.goto);
  assert.ok(shown.includes('daily-sales-tab') && shown.includes('kitchen-tab'));
  assert.ok(!shown.includes('does-not-exist'));
  b.close();
});

// ---------- speed ----------
test('sold-per-item counts are ONE pass over the sales log (was: a full pass per item on every redraw), and stay correct after a new sale or a void', async () => {
  const items = Array.from({ length: 1500 }, (_, i) => ({ code: 'C' + i, type: 'item', name: 'P' + i, price: 10, wholesalePrice: 5, qty: 10, unit: 'pcs' }));
  const sales = Array.from({ length: 6000 }, (_, i) => sale('x' + i, at(i % 60, 8 + (i % 10)), 'Jane', [['C' + (i % 1500), 'P', 1 + (i % 2), 10, 5]]));
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(items), pos_sales_log: JSON.stringify(sales) }, wait: 1500 });
  const { w } = b;
  w.eval('window.__soldCache = null');
  const t0 = Date.now();
  const total = w.eval('(() => { let t = 0; inventory.forEach(p => { t += itemTotalSold(p.code); }); return t; })()');
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `1,500 items in ${ms} ms`);
  assert.equal(total, sales.reduce((s, x) => s + x.items[0].qty, 0));
  const before = w.eval("itemTotalSold('C7')");
  w.eval("salesLog.push({ id: 'new', timestamp: new Date().toISOString(), items: [{ code: 'C7', qty: 4, price: 10 }] })");
  assert.equal(w.eval("itemTotalSold('C7')"), before + 4, 'a new sale is counted at once');
  w.eval("window.__soldCache = null; salesLog.find(s => s.id === 'new').voided = true");
  assert.equal(w.eval("itemTotalSold('C7')"), before, 'a voided sale is not');
  b.close();
});

test('bursts of renderAllViews() calls are folded into one redraw a moment later; the first call is immediate and the last is never lost', async () => {
  const b = await boot('hotel/index.html', { wait: 1200 });
  const { w } = b;
  w.eval("window.__n = 0; window.__origRAV = window.renderAllViews; ");
  // wrap what perfInstall wrapped: count how often the ORIGINAL runs
  const orig = w.eval("(function () { let n = 0; const real = renderAllViews; return null; })()");
  w.eval("window.__perfInstalled = false; window.renderAllViews = function () { window.__n++; }; perfInstall();");
  w.eval('renderAllViews(); renderAllViews(); renderAllViews(); renderAllViews()');
  assert.equal(w.eval('window.__n'), 1, 'the first call ran at once, the rest wait');
  await sleep(400);
  assert.equal(w.eval('window.__n'), 2, 'and exactly one more redraw covers the rest');
  await sleep(300);
  w.eval('renderAllViews()');
  assert.equal(w.eval('window.__n'), 3, 'a later call is immediate again');
  b.close();
});

// ---------- hotel: cash tendered optional ----------
test('hotel: cash tendered is optional — empty means the exact total; a typed amount must still cover it; other apps still require it', async () => {
  const inv = JSON.stringify([{ code: 'T1', type: 'item', name: 'Tea', price: 100, qty: 10, unit: 'pcs', vatCategory: 'A' }]);
  const b = await boot('hotel/index.html', { storage: { pos_inventory: inv }, wait: 1500 });
  const { w, d } = b;
  w.eval("showToast = function (m) { window.__t = (window.__t || []).concat(m); }; window.confirm = () => true");
  assert.match(d.getElementById('cash-payment-panel').textContent, /optional, recommended/);
  w.eval("addToCart('T1'); currentPaymentMethod = 'cash'");
  d.getElementById('cash-tendered-input').value = '';
  await w.eval('checkoutCart()');
  assert.equal(w.eval('salesLog.length'), 1, 'empty = a normal sale');
  assert.deepEqual([w.eval('salesLog[0].cashAmount'), w.eval('salesLog[0].change')], [100, 0]);
  w.eval("addToCart('T1'); currentPaymentMethod = 'cash'"); d.getElementById('cash-tendered-input').value = '50';
  await w.eval('checkoutCart()');
  assert.equal(w.eval('salesLog.length'), 1, 'a typed amount that is too small is still refused');
  assert.match((w.__t || []).join(' '), /Amount tendered is less than the total/);
  d.getElementById('cash-tendered-input').value = '500';
  await w.eval('checkoutCart()');
  assert.equal(w.eval('salesLog[1].change'), 400, 'a typed amount gives the change');
  b.close();
  const o = await boot('index.html', { storage: { pos_inventory: inv }, wait: 1500 });
  o.w.eval("showToast = function (m) { window.__t = (window.__t || []).concat(m); }");
  o.w.eval("addToCart('T1'); currentPaymentMethod = 'cash'"); o.d.getElementById('cash-tendered-input').value = '';
  await o.w.eval('checkoutCart()');
  assert.equal(o.w.eval('salesLog.length'), 0, 'the Shop app is unchanged');
  o.close();
});

// ---------- import: waiting message, no AI for known headers, items become dishes ----------
test('importing a file shows a please-wait message while it works, does not call the AI when the headers are known, and never leaves the message stuck', async () => {
  let aiCalls = 0, sawBanner = false;
  const fetch = async (url) => { if (String(url).includes('/api/ai-capture-list')) aiCalls++; return Promise.reject(new Error('offline')); };
  const b = await boot('hotel/index.html', { fetch, wait: 1200 });
  const { w, d } = b;
  w.eval("showToast = function () {}");
  const rows = [['Name', 'Price'], ['Tea', '50']];
  w.window.__rows = rows;
  const p = w.eval('beginInventoryFileImport(window.__rows, "m.xlsx")');
  sawBanner = d.getElementById('busy-banner') && d.getElementById('busy-banner').style.display === 'block';
  await p;
  assert.ok(sawBanner, 'a please-wait banner was on screen while it worked');
  assert.equal(d.getElementById('busy-banner').style.display, 'none', 'and it is gone afterwards');
  assert.equal(aiCalls, 0, 'known headers: no AI call');
  assert.equal(d.getElementById('capture-review-modal').style.display, 'flex');
  // unknown headers: the AI is asked, but never for more than 8 s (it is aborted); the offline tiers follow
  w.eval("closeCaptureReviewModal()");
  w.window.__rows = [['Bidhaa', 'Bei'], ['Chai', '50']];
  await w.eval('beginInventoryFileImport(window.__rows, "sw.xlsx")');
  assert.ok(aiCalls >= 1, 'unknown headers do ask the AI');
  assert.equal(d.getElementById('busy-banner').style.display, 'none');
  b.close();
});

test('re-importing a menu turns dishes that were imported as ordinary items into Dishes (same codes, no duplicates)', async () => {
  const items = [{ code: 'HB01', type: 'item', name: 'Tea', price: 50, qty: 1000, unit: 'pcs', vatCategory: 'A' }, { code: 'HB02', type: 'item', name: 'Special Tea', price: 100, qty: 1000, unit: 'pcs', vatCategory: 'A' }];
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(items) }, wait: 1500 });
  const { w } = b;
  w.eval("showToast = function (m) { window.__t = (window.__t || []).concat(m); }; window.detectCsvColumnsAI = async () => null");
  w.window.__rows = [['Code', 'Name', 'Price', 'Item Type'], ['HB01', 'Tea', '55', 'Dish'], ['HB02', 'Special Tea', '100', 'Dish'], ['HB03', 'Milk', '100', 'Dish']];
  await w.eval('beginInventoryFileImport(window.__rows, "menu.xlsx")'); await sleep(100);
  w.eval('commitCaptureReview()');
  const inv = JSON.parse(w.eval('JSON.stringify(inventory.map(p => [p.code, p.name, p.type, p.price, p.qty]))'));
  assert.deepEqual(inv, [['HB01', 'Tea', 'service', 55, null], ['HB02', 'Special Tea', 'service', 100, null], ['HB03', 'Milk', 'service', 100, null]]);
  assert.match((w.__t || []).join(' '), /1 dish added, 2 updated, 2 changed from Item to Dish/);
  b.close();
});
