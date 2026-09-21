import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Shop: an item sold as a package (a 50 kg bag) OR loose by weight (kilograms, decimals), with one stock balance.
const APP = 'index.html';
const INV = () => JSON.stringify([
  { code: 'CEM', type: 'item', name: 'Cement', price: 800, wholesalePrice: 700, qty: 40, unit: 'bag', vatCategory: 'A', dualUnit: true, unitsPerBox: 50, piecePrice: 18, pieceWholesalePrice: 14, pieceQty: 0, looseUnit: 'kg' },
  { code: 'NLS', type: 'item', name: 'Roofing Nails', price: 200, wholesalePrice: 150, qty: 100, unit: 'kg', vatCategory: 'A' },
  { code: 'BSC', type: 'item', name: 'Biscuits', price: 240, wholesalePrice: 120, qty: 5, unit: 'box', vatCategory: 'A', dualUnit: true, unitsPerBox: 24, piecePrice: 10, pieceWholesalePrice: 5, pieceQty: 0 },
]);
async function session() {
  const b = await boot(APP, { storage: { pos_inventory: INV() }, wait: 2000 });
  b.w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.confirm = () => true");
  return b;
}
const item = (w, code, f) => Number(w.eval(`inventory.find(p => p.code === '${code}').${f}`));
const keys = (w) => JSON.parse(w.eval('JSON.stringify(Object.keys(currentCart))'));
const line = (w, key) => JSON.parse(w.eval(`JSON.stringify(currentCart['${key}'])`));
async function pay(b) {
  b.w.eval("currentPaymentMethod = 'cash'");
  b.d.getElementById('cash-tendered-input').value = '100000';
  await b.w.eval('checkoutCart()');
  return JSON.parse(b.w.eval('JSON.stringify(salesLog[salesLog.length - 1])'));
}

test('the loose price can be auto-calculated (bag price / kg per bag) or set as your own margin; units per bag and loose stock take decimals', async () => {
  const b = await session();
  const { w } = b;
  w.eval("updateInventoryField('CEM', 'piecePrice', '')");
  assert.equal(item(w, 'CEM', 'piecePrice'), 16, '800 / 50 kg = 16 per kg');
  w.eval("updateInventoryField('CEM', 'piecePrice', '18')");
  assert.equal(item(w, 'CEM', 'piecePrice'), 18, 'a typed price is your own margin');
  w.eval("updateInventoryField('CEM', 'unitsPerBox', '25.5')"); assert.equal(item(w, 'CEM', 'unitsPerBox'), 25.5, 'a bag can hold a decimal amount');
  w.eval("updateInventoryField('CEM', 'unitsPerBox', '50')");
  w.eval("updateInventoryField('CEM', 'pieceQty', '12.5')"); assert.equal(item(w, 'CEM', 'pieceQty'), 12.5, 'loose stock takes decimals');
  w.eval("updateInventoryField('CEM', 'pieceQty', '0')");
  w.eval("updateInventoryField('CEM', 'looseUnit', 'g')"); assert.equal(w.eval("inventory.find(p => p.code === 'CEM').looseUnit"), 'g');
  b.close();
});

test('cart lines carry their unit: "Cement (50kg bag)" in bags, "Cement (Loose kg)" in kg; an item without a loose unit keeps Box / Piece', async () => {
  const b = await session();
  const { w, d } = b;
  w.eval("addToCart('CEM', 'box'); addToCart('CEM', 'piece'); addToCart('BSC', 'piece')");
  const byName = Object.fromEntries(keys(w).map((k) => [line(w, k).name, line(w, k)]));
  assert.equal(byName['Cement (50kg bag)'].unit, 'bag');
  assert.equal(byName['Cement (Loose kg)'].unit, 'kg');
  assert.equal(byName['Cement (Loose kg)'].price, 18);
  assert.ok(byName['Biscuits (Piece)'] && byName['Biscuits (Piece)'].unit === 'pcs', 'legacy dual-unit items are unchanged');
  const toggles = [...d.querySelectorAll('#cart-table .unit-toggle')];
  assert.equal(toggles.length, 3, 'a unit toggle on every dual-unit line');
  assert.match(toggles[0].textContent, /bag/); assert.match(toggles[0].textContent, /kg/);
  b.close();
});

test('the toggle flips a line between bag and kg keeping the same amount of goods (1 bag = 50 kg, 3 kg = 0.06 bag) and the total follows', async () => {
  const b = await session();
  const { w } = b;
  w.eval("addToCart('CEM', 'box')");
  let k = keys(w)[0];
  w.eval(`setCartQty('${k}', 2)`);
  w.eval(`switchCartUnit('${k}', 'piece')`);
  k = keys(w)[0];
  assert.deepEqual([line(w, k).saleMode, line(w, k).qty, line(w, k).unit], ['piece', 100, 'kg'], '2 bags = 100 kg');
  w.eval(`setCartQty('${k}', 3)`);
  w.eval(`switchCartUnit('${k}', 'box')`);
  k = keys(w)[0];
  assert.deepEqual([line(w, k).saleMode, line(w, k).qty], ['box', 0.06], '3 kg = 0.06 bag');
  assert.equal(Number(w.eval('cartTotal()')), 48, '0.06 bag x 800');
  assert.equal(keys(w).length, 1, 'still one line');
  b.close();
});

test('the example sale: 10 bags + 3 kg loose + 2.5 kg of nails = 8,554.00; stock stays one balance in kilograms', async () => {
  const b = await session();
  const { w } = b;
  w.eval("addToCart('CEM', 'box'); addToCart('CEM', 'piece'); addToCart('NLS')");
  const kBag = keys(w).find((k) => line(w, k).saleMode === 'box'), kKg = keys(w).find((k) => line(w, k).saleMode === 'piece'), kNl = keys(w).find((k) => k.includes('NLS'));
  w.eval(`setCartQty('${kBag}', 10); setCartQty('${kKg}', 3); setCartQty('${kNl}', 2.5)`);
  assert.equal(Number(w.eval('cartTotal()')), 8554);
  const sale = await pay(b);
  assert.deepEqual(sale.items.map((i) => [i.name, i.qty, i.unit, i.price]), [['Cement (50kg bag)', 10, 'bag', 800], ['Cement (Loose kg)', 3, 'kg', 18], ['Roofing Nails', 2.5, 'kg', 200]]);
  assert.equal(item(w, 'CEM', 'qty') * 50 + item(w, 'CEM', 'pieceQty'), 1497, '2,000 kg - 500 (10 bags) - 3 = 1,497 kg');
  assert.equal(w.eval("dualStockText(inventory.find(p => p.code === 'CEM'))"), '29 bag + 47 kg (1,497 kg in all)');
  assert.equal(item(w, 'NLS', 'qty'), 97.5);
  const text = w.eval('lastReceiptText');
  assert.match(text, /Cement \(50kg bag\)/); assert.match(text, /Cement \(Loose kg\)/); assert.match(text, /Roofing Nails/);
  assert.match(text, /10bag/); assert.match(text, /3kg/); assert.match(text, /2\.5kg/, 'quantities carry their unit on the receipt');
  assert.match(text, /TOTAL\s+KES 8554\.00/);
  b.close();
});

test('a decimal number of bags sells too (0.25 bag = 12.5 kg) and the balance shows bags + kg', async () => {
  const b = await session();
  const { w } = b;
  w.eval("addToCart('CEM', 'box')"); const k = keys(w)[0];
  w.eval(`setCartQty('${k}', 0.25)`);
  assert.equal(line(w, k).qty, 0.25);
  const sale = await pay(b);
  assert.equal(sale.items[0].qty, 0.25); assert.equal(sale.items[0].price * sale.items[0].qty, 200);
  assert.equal(w.eval("dualStockText(inventory.find(p => p.code === 'CEM'))"), '39 bag + 37.5 kg (1,987.5 kg in all)');
  b.close();
});

test('loose sales cannot exceed the one balance, and the inventory table shows it in bags + kg', async () => {
  const b = await session();
  const { w, d } = b;
  w.eval("addToCart('CEM', 'piece')"); const k = keys(w)[0];
  w.eval(`setCartQty('${k}', 5000)`);
  assert.match(w.__toasts.slice(-1)[0], /available/);
  assert.notEqual(line(w, k).qty, 5000);
  w.eval("renderInventoryTable()");
  const note = [...d.querySelectorAll('#inventory-table .dual-stock-note')].map((n) => n.textContent);
  assert.ok(note.some((t) => /40 bag \(2,000 kg in all\)/.test(t)), note.join(' | '));
  b.close();
});
