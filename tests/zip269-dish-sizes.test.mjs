import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 269 - dish sizes (Small / Regular / Large, Half / Full): chosen when ordering, with their own price, cost and share of the recipe.
const APP = 'hotel/index.html';
const SIZES = [{ id: 'sReg', name: 'Regular', price: 650, factor: 1 }, { id: 'sLrg', name: 'Large', price: 900, factor: 1.5, cost: 500 }];
const INV = [
  { code: 'BRG', type: 'service', name: 'Beef Burger', category: 'Mains', price: 650, wholesalePrice: 0, unit: 'pcs', vatCategory: 'A', recipe: [{ code: 'MNC', qtyPerUnit: 0.25 }], sizes: SIZES },
  { code: 'CHP', type: 'service', name: 'Chips', category: 'Sides', price: 200, wholesalePrice: 0, unit: 'pcs', vatCategory: 'A' },
  { code: 'MNC', type: 'item', name: 'Minced meat', category: 'Ingredients', price: 0, wholesalePrice: 400, qty: 10, unit: 'kg', vatCategory: 'A' },
];
const STAFF = [{ id: 'w1', name: 'Wanjiru', roles: ['service-tab', 'hosp-role:waiter'], salesTabMigrated: true }];
const J = (w, e) => JSON.parse(w.eval(`JSON.stringify(${e})`));
async function app() {
  const b = await boot(APP, { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 05']), pos_staff: JSON.stringify(STAFF), pos_kitchen_ticket_enabled: 'true' }, wait: 1500 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.print = () => {}");
  b.w.eval('queuePrintJob = function () { return Promise.resolve(); }');
  return b;
}
const qty = (w, code) => Number(w.eval(`inventory.find(p => p.code === '${code}').qty`));

test('Orders tab: a dish with sizes asks for the size; the line carries its price and the ingredients follow that size; voiding gives them back', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("svcAdd('BRG')");
  const modal = d.getElementById('hosp-size-modal');
  assert.ok(modal && modal.style.display === 'flex', 'the size picker opens');
  assert.deepEqual([...modal.querySelectorAll('.hosp-size-btn')].map((x) => x.dataset.size), ['sReg', 'sLrg']);
  assert.equal(J(w, 'svcDraft.lines.length'), 0, 'nothing is added until a size is chosen');
  w.eval("hospPickSize('sLrg')");
  assert.equal(modal.style.display, 'none');
  w.eval("svcAdd('BRG', 'sLrg')");                                   // the same size again merges into one line
  w.eval("svcAdd('BRG', 'sReg')");
  w.eval("svcAdd('CHP')");                                           // a plain dish needs no picker
  assert.deepEqual(J(w, 'svcDraft.lines.map(l => [l.code, l.sizeId, l.qty])'), [['BRG', 'sLrg', 2], ['BRG', 'sReg', 1], ['CHP', '', 1]]);
  assert.match(d.getElementById('svc-draft').textContent, /Beef Burger — Large/);
  assert.match(d.getElementById('svc-post-total').textContent, /3[,.]?650|3650|3 items/, 'total = 2 x 900 + 650 + 200 = 2650');
  d.getElementById('svc-new-location').value = 'Table 05';
  w.eval('svcPostOrder()');
  const tab = J(w, "tabs.find(t => t.status === 'OPEN')");
  const lines = J(w, `hospTabLines(tabs.find(t => t.id === '${tab.id}'))`);
  const large = lines.find((l) => l.name === 'Beef Burger — Large'), reg = lines.find((l) => l.name === 'Beef Burger — Regular');
  assert.equal(large.price, 900); assert.equal(large.qty, 2); assert.equal(large.wholesalePrice, 500, 'the size\'s own cost');
  assert.deepEqual(large.size, { id: 'sLrg', name: 'Large', factor: 1.5 });
  assert.equal(reg.price, 650); assert.equal(reg.wholesalePrice, 100, 'no own cost: recipe cost x recipe share (0.25 kg x 400)');
  // stock: 2 Large = 2 x 0.25 x 1.5 = 0.75 kg, 1 Regular = 0.25 kg
  assert.equal(qty(w, 'MNC'), 9);
  // the kitchen display shows the size and the order reference
  const card = J(w, 'hospKdsCards("kitchen").map(c => [c.tab.label, c.lines.map(l => l.name)])');
  assert.ok(card[0][0].length > 0); assert.ok(card[0][1].includes('Beef Burger — Large'));
  // voiding the whole order gives back exactly what was taken
  w.eval(`activeTabDetailId = '${tab.id}'; voidActiveTab()`);
  assert.equal(qty(w, 'MNC'), 10, 'the 1 kg is back after the void');
  b.close();
});

test('Sales Counter: the size picker, size price and cost on the cart line, and the recipe share when sold', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("addToCart('BRG')");
  assert.equal(d.getElementById('hosp-size-modal').style.display, 'flex');
  w.eval("hospPickSize('sLrg')");
  const lines = J(w, 'Object.values(currentCart)');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].name, 'Beef Burger — Large'); assert.equal(lines[0].price, 900); assert.equal(lines[0].wholesalePrice, 500);
  assert.deepEqual(lines[0].size, { id: 'sLrg', name: 'Large', factor: 1.5 });
  w.eval("hospPickSize && addToCart('BRG'); hospPickSize('sLrg')");
  assert.equal(J(w, 'Object.values(currentCart)[0].qty'), 2, 'the same size merges');
  // what checkout writes on the sale line, and how the stock is taken
  const items = J(w, 'checkoutItemLines(Object.values(currentCart), { lineResults: {}, flatResults: [] }, Object.values(currentCart))');
  assert.deepEqual(items[0].size, { id: 'sLrg', name: 'Large', factor: 1.5 });
  w.eval('deductEntriesForHotelBill(Object.values(currentCart))');
  assert.equal(qty(w, 'MNC'), 9.25, '2 Large = 0.75 kg');
  w.eval(`restoreEntriesForVoid(${JSON.stringify(items)})`);
  assert.equal(qty(w, 'MNC'), 10, 'a void restores the same amount');
  b.close();
});

test('a dish WITHOUT sizes behaves exactly as before (no picker, base price, full recipe)', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("svcAdd('CHP')");
  assert.ok(!d.getElementById('hosp-size-modal') || d.getElementById('hosp-size-modal').style.display !== 'flex');
  assert.deepEqual(J(w, 'svcDraft.lines'), [{ code: 'CHP', qty: 1, note: '', sizeId: '' }]);
  w.eval("inventory.find(p => p.code === 'BRG').sizes = undefined; svcClearDraft(); svcAdd('BRG')");
  assert.deepEqual(J(w, 'svcDraft.lines.length'), 1, 'no sizes: added straight away');
  b.close();
});

test('the dish form: sizes are validated, presets fill sensible rows, and an edited dish keeps its sizes', async () => {
  const b = await app(); const { w } = b;
  const read = (rows) => { w.eval(`dishSizesDraft = ${JSON.stringify(rows)}`); return J(w, 'dishSizesRead()'); };
  assert.deepEqual(read([]).list, []);
  assert.match(read([{ name: '', price: 100 }]).error, /name/i);
  assert.match(read([{ name: 'Large', price: '' }]).error, /price/i);
  assert.match(read([{ name: 'Large', price: 5, factor: 0 }]).error, /recipe amount/i);
  assert.match(read([{ name: 'A', price: 5 }, { name: 'a', price: 6 }]).error, /Two sizes/);
  assert.deepEqual(read([{ id: 'x1', name: ' Half ', price: '300', factor: '0.5', cost: '' }, { name: '', price: '' }]).list, [{ id: 'x1', name: 'Half', price: 300, factor: 0.5 }], 'an empty row is ignored, values are cleaned');
  w.eval("document.getElementById('inv-price').value = '500'; dishSizePreset('half')");
  assert.deepEqual(J(w, 'dishSizesDraft.map(r => [r.name, r.price, r.factor])'), [['Half', 300, 0.5], ['Full', 500, 1]]);
  // loading a dish for editing shows its sizes
  w.eval("editService('BRG')");
  assert.deepEqual(J(w, 'dishSizesDraft.map(r => r.name)'), ['Regular', 'Large']);
  assert.equal(w.document.querySelectorAll('#dish-sizes-rows .dish-size-row').length, 2);
  b.close();
});
