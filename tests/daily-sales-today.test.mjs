import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 124: "I made a sale and printed the receipt, but it's not in Daily Sales" (same device). The Daily Sales date was filled in
// once and never moved on — a till open overnight showed yesterday; "jump to a receipt" / "record a past sale" left it on an old
// day; a leftover search or payment filter hid the new sale.
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const yesterday = () => { const d = new Date(Date.now() - 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
async function shop() {
  const t = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' }, wait: 800 });
  t.w.eval("showToast = function () {}; window.print = () => {}; document.getElementById('login-screen').style.display = 'none'");
  t.sell = async () => { t.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); t.d.getElementById('cash-tendered-input').value = '1000'; await t.w.eval('checkoutCart()'); };
  t.rows = () => [...t.d.querySelectorAll('#daily-sales-table tbody tr')].filter((r) => !r.querySelector('.empty-state')).length;
  t.openTab = () => { t.d.querySelector('.tab-link[data-tab="daily-sales-tab"]').click(); };
  return t;
}

test('a till left open since yesterday: the sale just made is in Daily Sales (the date follows today)', async () => {
  const t = await shop();
  const picker = t.d.getElementById('sales-table-date-picker');
  picker.value = yesterday();                           // what the app filled in when it was opened yesterday
  await t.sell();
  t.w.eval('renderDailySales()');
  assert.equal(picker.value, t.w.eval('todayDateString()'));
  assert.equal(t.rows(), 1, 'the sale is listed');
  t.close();
});

test('after "jump to a receipt" / picking an old date, opening Daily Sales again shows today — and a picked date is respected meanwhile', async () => {
  const t = await shop();
  await t.sell();
  const picker = t.d.getElementById('sales-table-date-picker');
  picker.value = yesterday(); picker.dispatchEvent(new t.w.Event('change'));        // the person picks yesterday
  assert.equal(picker.value, yesterday(), 'a date the person picked stays while they look at it');
  assert.equal(t.rows(), 0);
  t.openTab();                                           // later: back to the tab
  t.w.eval('renderDailySales()');
  assert.equal(picker.value, t.w.eval('todayDateString()'));
  assert.equal(t.rows(), 1);
  t.close();
});

test('a leftover search word or "M-Pesa only" filter no longer hides a new cash sale', async () => {
  const t = await shop();
  t.d.getElementById('daily-sales-search-input').value = 'something else';
  t.w.eval("setDailySalesMethodFilter('mpesa')");
  await t.sell();
  t.w.eval('renderDailySales()');
  assert.equal(t.rows(), 0, 'hidden, as before');
  t.openTab(); t.w.eval('renderDailySales()');
  assert.equal(t.d.getElementById('daily-sales-search-input').value, '');
  assert.equal(t.w.eval('dailySalesMethodFilter'), 'all');
  assert.equal(t.rows(), 1);
  t.close();
});

test("Daily Sales says how many of today's Pay-Later bills are in the Bills tab", async () => {
  const t = await shop();
  t.w.eval("bills.push({ id: 'b1', timestamp: new Date().toISOString(), items: [{ code: 'A', qty: 1, price: 100 }], paid: false })");
  t.openTab();
  assert.match(t.d.getElementById('daily-sales-bills-note').textContent, /1 Pay-Later bill .*Bills tab/);
  t.close();
});

test('Aqua: the Daily Sales date follows today too', async () => {
  const t = await boot('water/index.html', { wait: 800 });
  const picker = t.d.getElementById('sales-date-picker');
  picker.value = yesterday();
  t.w.eval('renderDailySales()');
  assert.equal(picker.value, t.w.eval('todayDateString()'));
  picker.value = yesterday(); picker.dispatchEvent(new t.w.Event('change'));
  assert.equal(picker.value, yesterday(), 'picked on purpose: kept');
  t.d.querySelector('.tab-link[data-tab="daily-sales-tab"]').click();
  assert.equal(picker.value, t.w.eval('todayDateString()'));
  t.close();
});
