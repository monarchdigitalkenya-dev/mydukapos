import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Hospital: variable dosing (loose tablets in fixed dose packs), dosage instructions on cart lines / sales / receipts, sectioned receipts.
const APP = 'hospital/index.html';
const INV = JSON.stringify([
  { code: 'MM', type: 'item', name: 'Mara Moja', price: 240, wholesalePrice: 120, qty: 2, unit: 'box', vatCategory: 'A', dualUnit: true, unitsPerBox: 24, piecePrice: 10, pieceWholesalePrice: 5, pieceQty: 0, minDoseQty: 4, doseIncrements: '4, 6, 12, 24', allowLooseSale: true },
  { code: 'AX', type: 'item', name: 'Amoxicillin 500mg', price: 600, wholesalePrice: 300, qty: 3, unit: 'box', vatCategory: 'A', dualUnit: true, unitsPerBox: 12, piecePrice: 60, pieceWholesalePrice: 30, pieceQty: 0, allowLooseSale: false },
  { code: 'BD', type: 'item', name: 'Bandage', price: 20, wholesalePrice: 10, qty: 10, unit: 'pcs', vatCategory: 'A' },
  { code: 'CS', type: 'service', name: 'GP Consultation Fee', price: 1500, unit: 'use', vatCategory: 'A' },
]);
async function session() {
  const b = await boot(APP, { storage: { pos_inventory: INV }, wait: 900 });
  b.w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.confirm = () => true");
  return b;
}
const cartQty = (w, key) => Number(w.eval(`(currentCart['${key}'] || {}).qty || 0`));
const last = (w) => (w.__toasts || []).slice(-1)[0] || '';
const stock = (w, code, f) => Number(w.eval(`inventory.find(p => p.code === '${code}').${f}`));
async function checkout(b) {
  b.w.eval("currentPaymentMethod = 'cash'");
  b.d.getElementById('cash-tendered-input').value = '100000';
  await b.w.eval('checkoutCart()');
  return JSON.parse(b.w.eval('JSON.stringify(salesLog)')).pop();
}

test('dose rules: minimum, allowed packs and their combinations (4, 6, 12, 24; minimum 4)', async () => {
  const b = await session();
  const { w } = b;
  assert.deepEqual(JSON.parse(w.eval("JSON.stringify(parseDoseIncrements('Child Dose=4, Full Pack=24, 12'))")), [{ label: 'Child Dose', qty: 4 }, { label: '', qty: 12 }, { label: 'Full Pack', qty: 24 }]);
  assert.equal(w.eval("parseDoseIncrements('4, x, 6')"), null, 'garbage is rejected');
  const valid = (n) => w.eval(`isValidDoseQty(dosePolicy(inventory.find(p => p.code === 'MM')), ${n})`);
  for (const n of [4, 6, 8, 10, 12, 14, 16, 24, 30]) assert.equal(valid(n), true, n + ' is a valid dose');
  for (const n of [1, 2, 3, 5, 7, 9, 11, 13, 0, 2.5]) assert.equal(valid(n), false, n + ' is not');
  b.close();
});

test('cart: the first loose add is the minimum dose, +/- move by allowed packs, typing an invalid quantity is refused', async () => {
  const b = await session();
  const { w } = b;
  const key = 'product:MM:piece';
  w.eval("addToCart('MM', 'piece')");
  const k = w.eval("Object.keys(currentCart)[0]");
  assert.equal(cartQty(w, k), 4, 'the first add is the minimum dose, not 1');
  w.eval(`changeCartQty('${k}', 1)`); assert.equal(cartQty(w, k), 6);
  w.eval(`changeCartQty('${k}', 1)`); assert.equal(cartQty(w, k), 8, '7 is skipped');
  w.eval(`changeCartQty('${k}', -1)`); assert.equal(cartQty(w, k), 6);
  w.eval(`setCartQty('${k}', 5)`);
  assert.equal(cartQty(w, k), 6, 'a typed 5 is refused');
  assert.match(last(w), /5 is not a valid quantity of "Mara Moja".*minimum 4.*4, 6, 12, 24/);
  w.eval(`setCartQty('${k}', 12)`); assert.equal(cartQty(w, k), 12);
  w.eval(`setCartQty('${k}', 3)`); assert.equal(cartQty(w, k), 12, 'below the minimum is refused');
  for (const expected of [10, 8, 6, 4]) { w.eval(`changeCartQty('${k}', -1)`); assert.equal(cartQty(w, k), expected); }
  w.eval(`changeCartQty('${k}', -1)`);
  assert.equal(cartQty(w, k), 0, 'stepping below the minimum takes it out of the cart');
  b.close();
});

test('quick-select dose buttons and the inline dosage input appear under the medicine in the cart', async () => {
  const b = await session();
  const { w, d } = b;
  w.eval("addToCart('MM', 'piece')");
  const buttons = [...d.querySelectorAll('#cart-table .dose-quick button')].map((x) => x.textContent.trim());
  assert.deepEqual(buttons, ['4', '6', '12', '24']);
  d.querySelectorAll('#cart-table .dose-quick button')[2].click();                                     // "12"
  assert.equal(cartQty(w, w.eval("Object.keys(currentCart)[0]")), 12);
  assert.ok(d.querySelector('#cart-table .cart-dosage-input'), 'a dosage box under the item name');
  w.eval("addToCart('CS')");
  const rows = [...d.querySelectorAll('#cart-table tbody tr')];
  assert.ok(!rows.find((r) => r.textContent.includes('GP Consultation')).querySelector('.cart-dosage-input'), 'no dosage box on a service');
  b.close();
});

test('"whole boxes only": loose pieces cannot be sold, the box still can', async () => {
  const b = await session();
  const { w } = b;
  assert.equal(w.eval("getAvailableStock(inventory.find(p => p.code === 'AX'), 'piece')"), 0);
  w.eval("addToCart('AX', 'piece')");
  assert.equal(w.eval('Object.keys(currentCart).length'), 0);
  assert.match(last(w), /sold by the full .* only/);
  w.eval("addToCart('AX', 'box')");
  assert.equal(w.eval('Object.keys(currentCart).length'), 1);
  b.close();
});

test('checkout refuses a dose the rules forbid, whatever put it in the cart', async () => {
  const b = await session();
  const { w } = b;
  w.eval("addToCart('MM', 'piece')");
  const k = w.eval("Object.keys(currentCart)[0]");
  w.eval(`currentCart['${k}'].qty = 5; renderCart()`);                                                // bypasses the cart controls
  const s = await checkout(b);
  assert.equal(w.eval('salesLog.length'), 0, 'no sale');
  assert.match(last(w), /5 is not a valid quantity/);
  assert.equal(stock(w, 'MM', 'qty'), 2, 'and no stock moved');
  b.close();
});

test('stock is counted in base units: 6 tablets from a 24-tablet box opens one box and leaves 18 loose', async () => {
  const b = await session();
  const { w } = b;
  w.eval("addToCart('MM', 'piece')"); const k = w.eval("Object.keys(currentCart)[0]");
  w.eval(`setCartQty('${k}', 6)`);
  const s = await checkout(b);
  assert.equal(s.items[0].qty, 6);
  assert.equal(stock(w, 'MM', 'qty'), 1, 'one box opened');
  assert.equal(stock(w, 'MM', 'pieceQty'), 18, '24 - 6 loose tablets left');
  b.close();
});

test('dosage instruction: stored on the sale line and printed under the medicine; fees and medicines are listed under separate headings', async () => {
  const b = await session();
  const { w, d } = b;
  w.eval("addToCart('CS')");
  w.eval("addToCart('MM', 'piece')"); const k = w.eval("Object.keys(currentCart).find(x => x.includes('MM'))");
  w.eval(`setCartQty('${k}', 6); setCartLineDosage('${k}', '1 x 3 daily after meals')`);
  w.eval("addToCart('BD')");
  const s = await checkout(b);
  assert.equal(s.items.find((i) => i.code === 'MM').dosage, '1 x 3 daily after meals', 'stored on the line');
  const text = w.eval('lastReceiptText');
  assert.match(text, /--> Dose: 1 x 3 daily after meals/);
  const iFees = text.indexOf('SERVICES & HOSPITAL FEES:'), iMeds = text.indexOf('DISPENSED MEDICATIONS:');
  assert.ok(iFees >= 0 && iMeds > iFees, 'fees first, then dispensed medications');
  assert.ok(text.indexOf('GP Consultation') > iFees && text.indexOf('GP Consultation') < iMeds, 'the consultation is under the fees heading');
  assert.ok(text.indexOf('Mara Moja') > iMeds && text.indexOf('Bandage') > iMeds, 'medicines and supplies under dispensed');
  assert.ok(text.indexOf('--> Dose') > text.indexOf('Mara Moja') && text.indexOf('--> Dose') < text.indexOf('Bandage'), 'the dose sits right under its medicine');
  assert.match(d.getElementById('receipt-body').innerHTML, /SERVICES &amp; HOSPITAL FEES:/, 'and in the on-screen receipt');
  b.close();
});

test('a sale of medicines only, or fees only, keeps the plain receipt (no headings)', async () => {
  const b = await session();
  const { w } = b;
  w.eval("addToCart('BD')");
  await checkout(b);
  assert.doesNotMatch(w.eval('lastReceiptText'), /DISPENSED MEDICATIONS|SERVICES & HOSPITAL FEES/);
  b.close();
});

test('setting the rules on an item: bad dose packs are rejected, good ones are stored tidily, and minimum must be a whole number', async () => {
  const b = await session();
  const { w } = b;
  w.eval("updateInventoryField('BD', 'doseIncrements', '4, x')");
  assert.equal(w.eval("inventory.find(p => p.code === 'BD').doseIncrements || ''"), '');
  w.eval("updateInventoryField('MM', 'doseIncrements', 'Child Dose = 4,12 ,Full Pack=24')");
  assert.equal(w.eval("inventory.find(p => p.code === 'MM').doseIncrements"), 'Child Dose=4, 12, Full Pack=24');
  w.eval("updateInventoryField('MM', 'minDoseQty', '0')");
  assert.equal(w.eval("inventory.find(p => p.code === 'MM').minDoseQty"), 4, 'unchanged');
  w.eval("updateInventoryField('MM', 'allowLooseSale', false)");
  assert.equal(w.eval("inventory.find(p => p.code === 'MM').allowLooseSale"), false);
  b.close();
});
