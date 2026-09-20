import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, ROOT } from './helpers.mjs';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// Hotel/Restaurant/Bar: dishes always sell; the Inventory tab has a Used column; the Kitchen tab tracks Prepared / Sold / Left per dish.
const APP = 'hotel/index.html';
const INV = () => JSON.stringify([
  { code: 'ING01', type: 'item', name: 'Flour', price: 50, wholesalePrice: 40, qty: 0, unit: 'kg', vatCategory: 'A' },       // ZERO stock
  { code: 'ING02', type: 'item', name: 'Sugar', price: 60, wholesalePrice: 45, qty: 100, unit: 'kg', vatCategory: 'A' },
  { code: 'D001', type: 'service', name: 'Bread', price: 100, unit: 'use', vatCategory: 'A', recipe: [{ code: 'ING01', qtyPerUnit: 0.5 }, { code: 'ING02', qtyPerUnit: 0.1 }] },
  { code: 'D002', type: 'service', name: 'Tea', price: 30, unit: 'use', vatCategory: 'A' },                                    // no recipe at all
]);
async function session(extra = {}) {
  const b = await boot(APP, { storage: { pos_inventory: INV(), ...extra }, wait: 900 });
  b.w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.confirm = () => true; window.prompt = () => null");
  return b;
}
const num = (w, expr) => Number(w.eval(expr));
const stock = (w, code) => num(w, `inventory.find(p => p.code === '${code}').qty`);
const setInput = (d, id, v) => { d.getElementById(id).value = String(v); };
async function sell(b, code, qty) {
  for (let i = 0; i < qty; i++) b.w.eval(`addToCart('${code}')`);
  b.w.eval("currentPaymentMethod = 'cash'");
  setInput(b.d, 'cash-tendered-input', 100000);
  await b.w.eval('checkoutCart()');
  return JSON.parse(b.w.eval('JSON.stringify(salesLog)')).pop();
}
const state = (w, code, now) => JSON.parse(w.eval(`JSON.stringify(kitchenDishState('${code}'${now ? ', ' + now : ''}))`));
const used = (w, code) => num(w, `kitchenUsedFor('${code}')`);

test('a dish sells with ingredient stock at ZERO, and a dish with NO recipe sells too; nothing is marked out of stock', async () => {
  const b = await session();
  const { w, d } = b;
  assert.equal(w.eval("getAvailableStock(inventory.find(p => p.code === 'D001'))"), Infinity);
  assert.equal(w.eval("getAvailableStock(inventory.find(p => p.code === 'D002'))"), Infinity);
  w.eval("renderItemImageGrid('')");
  const cells = [...d.querySelectorAll('.item-grid-cell')];
  assert.ok(cells.some((c) => c.textContent.includes('Bread')), 'the dish is on the grid');
  assert.equal(cells.filter((c) => /Bread|Tea/.test(c.textContent)).filter((c) => c.classList.contains('out-of-stock') || /Out of stock/.test(c.textContent)).length, 0, 'no dish is shown as out of stock');
  const s = await sell(b, 'D001', 2);
  assert.ok(s && s.items[0].qty === 2, 'the sale was recorded');
  assert.ok(!(w.__toasts || []).some((m) => /Only .* can be made/.test(m)), 'no "only N can be made" refusal');
  const s2 = await sell(b, 'D002', 3);
  assert.ok(s2 && s2.items[0].qty === 3);
  assert.equal(stock(w, 'ING01'), -1, 'flour had 0: it went below zero instead of blocking (0 - 2 x 0.5)');
  assert.equal(stock(w, 'ING02'), 99.8);
  b.close();
});

test('Used: sales add to it from the recipe, it starts at 0, and it is never negative', async () => {
  const b = await session();
  const { w } = b;
  assert.equal(used(w, 'ING01'), 0);
  await sell(b, 'D001', 3);
  assert.equal(used(w, 'ING01'), 1.5);
  assert.equal(used(w, 'ING02'), 0.3);
  assert.equal(used(w, 'D002'), 0, 'a dish or an unused item is simply 0');
  // more voids than sales: still not negative
  w.eval("kitchenUnsellDishLine(inventory.find(p => p.code === 'D001'), 50)");
  assert.equal(used(w, 'ING01'), 0, 'clamped at 0');
  assert.ok(used(w, 'ING02') >= 0);
  b.close();
});

test('Inventory tab has a Used column beside the stock level, and a below-zero stock shows what is short', async () => {
  const b = await session();
  const { w, d } = b;
  await sell(b, 'D001', 2);
  w.eval('renderInventoryTable()');
  const heads = [...d.querySelectorAll('#inventory-table thead th')].map((t) => t.textContent.trim());
  assert.deepEqual(heads.slice(3, 7), ['Price (KES)', 'Qty Remaining', 'Used', 'Status']);
  const rows = [...d.querySelectorAll('#inventory-table tbody tr')];
  const flour = rows.find((r) => r.textContent.includes('Flour'));
  assert.equal(flour.querySelectorAll('td').length, 8, 'as many cells as headers');
  assert.match(flour.querySelector('.inv-used-cell').textContent, /1/);
  assert.match(flour.textContent, /short by/);
  assert.match(flour.textContent, /dishes still sell/);
  b.close();
});

test('Kitchen tab: with nothing prepared a dish is "Untracked" but still counts what it SOLD today', async () => {
  const b = await session();
  const { w, d } = b;
  await sell(b, 'D002', 4);
  w.eval("performTabSwitch(null, 'kitchen-tab')");
  const row = [...d.querySelectorAll('#kitchen-table tbody tr')].find((r) => r.textContent.includes('Tea'));
  assert.ok(row, 'the dish is listed');
  assert.match(row.textContent, /Untracked/);
  const cells = row.querySelectorAll('td');
  assert.match(cells[3].textContent, /4/, 'Servings Sold is tracked with no prep data at all');
  assert.match(cells[1].querySelector('input').value, /^1$/, 'shelf life defaults to 1 day');
  b.close();
});

test('Prepared / Sold / Left: logging portions, then sales, then a void giving the portion back', async () => {
  const b = await session();
  const { w, d } = b;
  w.eval("kitchenAddPrepared('D001', 10)");
  let st = state(w, 'D001');
  assert.deepEqual([st.tracked, st.prepared, st.sold, st.left], [true, 10, 0, 10]);
  const sale = await sell(b, 'D001', 3);
  st = state(w, 'D001');
  assert.deepEqual([st.prepared, st.sold, st.left], [10, 3, 7], 'sold goes up by itself, left = prepared - sold');
  w.eval("performTabSwitch(null, 'kitchen-tab')");
  const cells = [...d.querySelectorAll('#kitchen-table tbody tr')].find((r) => r.textContent.includes('Bread')).querySelectorAll('td');
  assert.match(cells[2].textContent, /10/); assert.match(cells[3].textContent, /3/); assert.match(cells[4].textContent, /7/);
  // void it
  w.eval(`pendingVoidSaleSource = 'sales'; pendingVoidReason = 'wrong order'; performVoidSale('${sale.id}')`);
  st = state(w, 'D001');
  assert.deepEqual([st.prepared, st.sold, st.left], [10, 0, 10], 'the void re-credits Sold and Left');
  assert.equal(used(w, 'ING01'), 0, 'and takes the ingredients back off Used');
  assert.equal(stock(w, 'ING01'), 0, 'and puts the flour back exactly');
  assert.equal(stock(w, 'ING02'), 100);
  // restore it
  w.eval(`pendingVoidSaleSource = 'sales'; performUnvoidSale('${sale.id}')`);
  st = state(w, 'D001');
  assert.deepEqual([st.sold, st.left], [3, 7], 'un-voiding counts it again');
  assert.equal(used(w, 'ING01'), 1.5);
  b.close();
});

test('shelf life: a multi-day batch stays active across days until it expires; an expired batch drops to Untracked', async () => {
  const b = await session();
  const { w } = b;
  const H = 3600000, now = Date.now(), t0 = now - 26 * H;                      // prepared 26 hours ago
  w.eval("kitchenSetShelfLife('D001', 3)");
  w.eval(`kitchenAddPrepared('D001', 10, ${t0})`);
  w.eval(`kitchenLog('sale', inventory.find(p => p.code === 'D001'), 2, [], new Date(${t0 + H}).toISOString())`);       // sold yesterday
  w.eval(`kitchenLog('sale', inventory.find(p => p.code === 'D001'), 1, [], new Date(${now - H}).toISOString())`);       // sold today
  let st = state(w, 'D001', now);
  assert.deepEqual([st.tracked, st.prepared, st.sold, st.left], [true, 10, 3, 7], 'yesterday\'s batch still counts today');
  st = state(w, 'D001', t0 + 3 * 24 * H + 1000);                                // after its 3 days
  assert.equal(st.tracked, false, 'expired');
  assert.ok(st.expiredAt > 0, 'and it says so');
  // shelf life 1 day: the same batch is already expired 26 hours later
  const b2 = await session();
  b2.w.eval(`kitchenAddPrepared('D001', 10, ${t0})`);
  st = state(b2.w, 'D001', now);
  assert.equal(st.tracked, false); assert.ok(st.expiredAt > 0);
  b.close(); b2.close();
});

test('appending portions: adds to the pool while some are left; a finished pool is closed so old sales do not eat the new batch; corrections and clearing work', async () => {
  const b = await session();
  const { w } = b;
  w.eval("kitchenAddPrepared('D001', 2)");
  await sell(b, 'D001', 3);                                                    // 3 sold, only 2 prepared: allowed
  let st = state(w, 'D001');
  assert.deepEqual([st.prepared, st.sold, st.left], [2, 3, -1], 'overselling is allowed and shown');
  await sleep(5);
  w.eval("kitchenAddPrepared('D001', 5)");
  st = state(w, 'D001');
  assert.deepEqual([st.prepared, st.sold, st.left], [5, 0, 5], 'the new batch starts fresh');
  await sleep(5);
  w.eval("kitchenAddPrepared('D001', 4)");
  st = state(w, 'D001');
  assert.deepEqual([st.prepared, st.left], [9, 9], 'portions left: the new ones are added to the pool');
  await sleep(5);
  w.eval("kitchenSetPrepared('D001', 6)");
  assert.equal(state(w, 'D001').prepared, 6, 'a correction (recorded as an adjustment)');
  await sleep(5);
  w.eval("kitchenSetPrepared('D001', 0)");
  assert.equal(state(w, 'D001').tracked, false, 'cleared');
  b.close();
});

test('voiding a tab gives its dishes\' servings and ingredients back', async () => {
  const b = await session();
  const { w } = b;
  const entries = "[{ code: 'D001', name: 'Bread', qty: 2, price: 100, isService: true }]";
  w.eval(`deductEntriesForHotelBill(${entries}); tabs = [{ id: 'T1', label: 'Table 1', kind: 'table', status: 'OPEN', orders: [{ id: 'o1', timestamp: new Date().toISOString(), entries: ${entries} }] }]; activeTabDetailId = 'T1'`);
  assert.equal(state(w, 'D001').sold, 2); assert.equal(stock(w, 'ING01'), -1);
  w.eval('voidActiveTab()');
  assert.equal(state(w, 'D001').sold, 0, 'servings sold re-credited');
  assert.equal(used(w, 'ING01'), 0);
  assert.equal(stock(w, 'ING01'), 0, 'flour back exactly');
  b.close();
});

test('the tab sits right next to Sales Counter, can be handed to staff as a role, and opens without errors', async () => {
  const b = await boot(APP, { wait: 900 });
  const { w, d, errors } = b;
  const raw = fs.readFileSync(path.join(ROOT, APP), 'utf8');
  assert.match(raw, /id="sales-tab-btn"[^>]*>[^<]*<\/button>\s*<button id="kitchen-tab-btn"/, 'in the nav bar, right after Sales Counter');
  assert.ok(d.getElementById('kitchen-tab-btn'), 'and it is on the page');
  assert.ok(w.eval("LOCKABLE_TABS.some(t => t.id === 'kitchen-tab')"));
  assert.ok(w.eval("ROLE_TABS.some(t => t.id === 'kitchen-tab')"));
  w.eval("performTabSwitch(document.getElementById('kitchen-tab-btn'), 'kitchen-tab')");
  assert.ok(d.getElementById('kitchen-tab').classList.contains('active'));
  assert.deepEqual(errors, []);
  b.close();
});

test('two tills: dish sales and prepared portions from both tills add up on both (the ledger syncs like any other log)', { timeout: 120000 }, async () => {
  const s = makeServer();
  const seed = { pos_inventory: INV() };
  const a = await openDevice(APP, s, seed, 2500); a.w.eval("showToast = function () {}");
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  const b = await openDevice(APP, s, deviceStorage(a.w), 2500); b.w.eval("showToast = function () {}");
  await b.w.eval('flushThenPull()');
  a.w.eval("kitchenAddPrepared('D001', 10); deductEntriesForHotelBill([{ code: 'D001', name: 'Bread', qty: 2, price: 100, isService: true }])");
  b.w.eval("deductEntriesForHotelBill([{ code: 'D001', name: 'Bread', qty: 3, price: 100, isService: true }])");
  await a.w.eval('pushNow()'); await b.w.eval('pushNow()');
  await a.w.eval('flushThenPull()'); await b.w.eval('flushThenPull()');
  for (const dev of [a, b]) {
    const st = state(dev.w, 'D001');
    assert.deepEqual([st.prepared, st.sold, st.left], [10, 5, 5], 'both tills agree: 2 + 3 sold, 10 prepared');
    assert.equal(used(dev.w, 'ING01'), 2.5, 'and the ingredients used add up too');
  }
  a.close(); b.close();
});
