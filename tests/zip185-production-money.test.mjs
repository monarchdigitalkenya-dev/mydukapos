import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 185 - Production money / stock fixes: line offers add up to the charged total, split lines share the materials, a produced-item float floor,
// the cart total never goes below 0, a second tap on Complete cannot sell twice, a rename updates the build recipe, a deliberate clear marks the bulk delete.
const INV = () => [
  { code: 'FLR', type: 'item', name: 'Flour', category: 'Raw', price: 0, wholesalePrice: 100, qty: 0.3, unit: 'kg', vatCategory: 'A' },
  { code: 'BUN', type: 'item', name: 'Bun', category: 'Baked', price: 50, wholesalePrice: 0, qty: 0, unit: 'pcs', vatCategory: 'A', productionRecipe: [{ code: 'FLR', qty: 0.1 }] },
  { code: 'A', type: 'item', name: 'Alpha', category: 'General', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' },
  { code: 'ASM', type: 'item', name: 'Assembled', category: 'General', price: 100, wholesalePrice: 0, qty: 0, unit: 'pcs', vatCategory: 'A', assemblyRecipe: [{ code: 'A', qty: 2 }] },
];
async function app() {
  const b = await boot('production/index.html', { storage: { pos_inventory: JSON.stringify(INV()) }, wait: 1000 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => d; window.print = () => {}; queuePrintJob = function () { return Promise.resolve(); }");
  return b;
}
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));

test('production: a line offer settles to whole cents that add up to what was charged', { timeout: 60000 }, async () => {
  const { w, close } = await app();
  const items = J(w, `(() => {
    const l = { code: 'A', name: 'Alpha', qty: 3, price: 33.33, wholesalePrice: 10, unit: 'pcs' };
    const lines = { A: { amount: 10, label: '10% off', offerName: 'x' } };
    const it = { ...checkoutItemLine(l, lines), componentsUsed: [{ code: 'FLR', name: 'Flour', qty: 9, unit: 'kg' }] };
    return rescaleSplitComponents(settleOfferLines([it]));
  })()`);
  const sum = Math.round(items.reduce((t, i) => t + i.price * i.qty, 0) * 100) / 100;
  assert.equal(sum, 89.99, '3 x 33.33 less 10 = 89.99, not 90.00');
  assert.ok(items.every((i) => Math.abs(i.price * 100 - Math.round(i.price * 100)) < 1e-6), 'every line is a whole-cent price');
  assert.equal(items.length, 2, 'split into qty 2 + a remainder line');
  const mats = items.reduce((t, i) => t + i.componentsUsed[0].qty, 0);
  assert.ok(Math.abs(mats - 9) < 1e-9, 'the materials are shared between the split lines, not repeated (a void would put them back twice)');
  // a line that divides exactly stays one line
  const one = J(w, "settleOfferLines([checkoutItemLine({ code: 'A', name: 'A', qty: 2, price: 50 }, { A: { amount: 10, label: 'x' } })])");
  assert.equal(one.length, 1); assert.equal(one[0].price, 45);
  close();
});

test('production: produced-item availability does not lose a unit to float division', { timeout: 60000 }, async () => {
  const { w, close } = await app();
  assert.equal(w.eval("calculateMaxProducible([{ code: 'FLR', qty: 0.1 }])"), 3, '0.3 / 0.1 is 2.9999999999999996 in floats');
  close();
});

test('production: the cart total never goes below 0', { timeout: 60000 }, async () => {
  const { w, close } = await app();
  w.eval("currentCart = {}; addToCart('A'); window.__oldOffers = applyOffersToCart; applyOffersToCart = function () { return { lineResults: {}, flatResults: [], totalDiscount: 500 }; }");
  assert.equal(w.eval('cartTotal()'), 0);
  w.eval('applyOffersToCart = window.__oldOffers');
  close();
});

test('production: a second tap on Complete while a sale is running does not sell twice', { timeout: 60000 }, async () => {
  const { w, close } = await app();
  w.eval("currentCart = {}; addToCart('A'); currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '1000'");
  const a = w.eval('checkoutCart()'); const b = w.eval('checkoutCart()');
  await Promise.all([a, b]); await new Promise((r) => setTimeout(r, 100));
  assert.equal(w.eval('salesLog.length'), 1);
  assert.equal(w.eval("inventory.find(i => i.code === 'A').qty"), 49);
  assert.equal(w.eval('!!window.__checkoutBusy'), false, 'the till is free again');
  close();
});

test('production: a negative cash / M-Pesa split is refused at checkout', { timeout: 60000 }, async () => {
  const { w, close } = await app();
  w.eval("currentCart = {}; addToCart('A'); currentPaymentMethod = 'split'");
  const d = w.document; const set = (id, v) => { const el = d.getElementById(id); if (el) el.value = v; };
  set('split-cash-input', '-50'); set('split-mpesa-input', '150'); set('mpesa-code-input', 'QWE1234567'); set('mpesa-phone-input', '0712345678');
  await w.eval('checkoutCart()'); await new Promise((r) => setTimeout(r, 80));
  assert.equal(w.eval('salesLog.length'), 0);
  close();
});

test('production: renaming an item code updates the build (assembly) recipes that use it', { timeout: 60000 }, async () => {
  const { w, close } = await app();
  w.eval("updateInventoryField('A', 'code', 'ALPHA2')");
  assert.equal(w.eval("inventory.find(i => i.code === 'ASM').assemblyRecipe[0].code"), 'ALPHA2');
  close();
});

test('production: a deliberate clear of the inventory marks the bulk delete', { timeout: 60000 }, async () => {
  const { w, close } = await app();
  w.eval('window.__bulkDelete = {}; performClearInventory()');
  assert.equal(w.eval('!!window.__bulkDelete.inventory'), true);
  close();
});
