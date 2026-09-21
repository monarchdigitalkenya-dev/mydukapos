import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Gas cylinders: Full and Empty counts per size, kept as ordinary inventory items; four ways to sell; exchanges move both counts; accessories are normal items.
const APPS = ['index.html', 'production/index.html', 'services/index.html'];
const EXTRA = JSON.stringify([
  { code: 'REG', type: 'item', name: 'Regulator', price: 600, wholesalePrice: 400, qty: 10, unit: 'pcs', vatCategory: 'A' },
  { code: 'HOS', type: 'item', name: 'Gas Hose', price: 200, wholesalePrice: 100, qty: 10, unit: 'pcs', vatCategory: 'A' },
]);
async function session(app) {
  const b = await boot(app, { storage: { pos_inventory: EXTRA, pos_do_gas_refills: 'true' }, wait: 2000 });
  b.w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.confirm = () => true");
  return b;
}
const val = (d, id, v) => { d.getElementById(id).value = String(v); };
function addSize(b, size, full, empty, brand = '') {
  val(b.d, 'gas-new-size', size); val(b.d, 'gas-new-full-stock', full); val(b.d, 'gas-new-empty-stock', empty); val(b.d, 'gas-new-brand', brand);
  b.w.eval('addGasSize()');
}
const find = (w, name) => JSON.parse(w.eval(`JSON.stringify(inventory.find(p => p.name === ${JSON.stringify(name)}) || null)`));
const qty = (w, name) => (find(w, name) || {}).qty;
const totals = (w) => JSON.parse(w.eval('JSON.stringify(gasTotals())'));
async function stocked(app) {
  const b = await session(app);
  addSize(b, '13kg', 20, 5); addSize(b, '6kg', 31, 8);
  const f13 = find(b.w, '13kg (Full)').code, f6 = find(b.w, '6kg (Full)').code;
  b.w.eval(`gasBoardPrice('${f13}', 'outright', 4500); gasBoardPrice('${f13}', 'refill', 1500); gasBoardPrice('${f13}', 'empty', 2500)`);
  b.w.eval(`gasBoardPrice('${f6}', 'outright', 2200); gasBoardPrice('${f6}', 'refill', 800); gasBoardPrice('${f6}', 'empty', 1200)`);
  return { b, f13, f6 };
}
async function pay(b) {
  b.w.eval("currentPaymentMethod = 'cash'");
  b.d.getElementById('cash-tendered-input').value = '1000000';
  await b.w.eval('checkoutCart()');
  return JSON.parse(b.w.eval('JSON.stringify(salesLog[salesLog.length - 1])'));
}
const add = (b, type, q = 1) => { b.w.eval(`setGasTxType('${type}')`); val(b.d, 'gas-tx-qty', q); b.w.eval('addGasLineToCart()'); };

for (const app of APPS) {
  test(`${app}: sizes with Full and Empty counts (13kg 20/5, 6kg 31/8) live in Inventory, with totals by state; brand is optional; counts and prices can be corrected in place`, async () => {
    const { b, f13 } = await stocked(app);
    const { w, d } = b;
    assert.deepEqual([qty(w, '13kg (Full)'), qty(w, '13kg (Empty)'), qty(w, '6kg (Full)'), qty(w, '6kg (Empty)')], [20, 5, 31, 8]);
    assert.deepEqual(totals(w), { full: 51, empty: 13, away: 0, total: 64 });
    assert.match(d.getElementById('gas-totals').textContent, /Full\s*51/); assert.match(d.getElementById('gas-totals').textContent, /Empty\s*13/); assert.match(d.getElementById('gas-totals').textContent, /All cylinders\s*64/);
    assert.equal(d.querySelectorAll('#gas-board-body tr').length, 2, 'one row per size');
    w.eval('renderInventoryTable()');
    assert.match(d.getElementById('inventory-table').textContent, /13kg \(Full\)/, 'they are ordinary inventory items');
    assert.match(d.getElementById('inventory-table').textContent, /6kg \(Empty\)/);
    addSize(b, '13kg', 1, 1);
    assert.match(d.getElementById('gas-size-msg').textContent, /already in the list/, 'the same size twice is refused');
    addSize(b, '13kg', 2, 3, 'Total');
    assert.equal(qty(w, 'Total 13kg (Full)'), 2, 'a brand can be added when two brands share a size');
    w.eval(`gasBoardSet('${f13}', 'empty', 9)`);
    assert.equal(qty(w, '13kg (Empty)'), 9);
    assert.equal(w.eval("stockMovementLog.some(e => e.reason === 'Gas stock count' && e.delta === 4)"), true, 'a manual count is recorded like any stock adjustment');
    w.eval(`gasBoardSet('${f13}', 'full', -3)`);
    assert.equal(qty(w, '13kg (Full)'), 20, 'a bad number changes nothing');
    b.close();
  });
}

for (const app of APPS) test(`${app}: refill / exchange: one less full and one more empty, at the refill price; a void puts both back`, async () => {
  const { b, f13 } = await stocked(app);
  const { w } = b;
  w.eval(`selectGasSize('${f13}')`);
  add(b, 'exchange', 2);
  const cart = JSON.parse(w.eval('JSON.stringify(Object.values(currentCart))'));
  assert.equal(cart.length, 1); assert.equal(cart[0].price, 1500); assert.equal(cart[0].qty, 2); assert.match(cart[0].name, /13kg — Refill\/Exchange/);
  const sale = await pay(b);
  assert.deepEqual([qty(w, '13kg (Full)'), qty(w, '13kg (Empty)')], [18, 7], '20 full - 2, 5 empty + 2');
  assert.deepEqual(totals(w), { full: 49, empty: 15, away: 0, total: 64 }, 'the number of cylinders you own does not change');
  if (w.eval("typeof performVoidSale === 'function'")) {
    w.eval(`pendingVoidSaleSource = 'sales'; pendingVoidReason = 'test'; performVoidSale('${sale.id}')`);
    assert.deepEqual([qty(w, '13kg (Full)'), qty(w, '13kg (Empty)')], [20, 5], 'void: back to where it was');
  }
  b.close();
});

for (const app of APPS) test(`${app}: full cylinder (theirs to keep): only the full count drops; empty cylinder on its own: only the empty count drops`, async () => {
  const { b, f13, f6 } = await stocked(app);
  const { w } = b;
  w.eval(`selectGasSize('${f13}')`); add(b, 'outright', 1);
  assert.equal(JSON.parse(w.eval('JSON.stringify(Object.values(currentCart)[0])')).price, 4500);
  await pay(b);
  assert.deepEqual([qty(w, '13kg (Full)'), qty(w, '13kg (Empty)')], [19, 5]);
  w.eval(`selectGasSize('${f6}')`); add(b, 'empty', 3);
  const line = JSON.parse(w.eval('JSON.stringify(Object.values(currentCart)[0])'));
  assert.equal(line.price, 1200); assert.match(line.name, /6kg — Empty Cylinder/);
  await pay(b);
  assert.deepEqual([qty(w, '6kg (Full)'), qty(w, '6kg (Empty)')], [31, 5], '8 empties - 3');
  assert.deepEqual(totals(w), { full: 50, empty: 10, away: 0, total: 60 });
  add(b, 'empty', 6);
  assert.match(b.d.getElementById('gas-add-msg').textContent, /Only 5 empty "6kg" in stock/, 'cannot sell empties you do not have');
  b.close();
});

test('complete set: the full cylinder plus the accessories you tick (with how many per set); accessories are ordinary items that can also be sold alone', async () => {
  const { b, f13 } = await stocked('services/index.html');
  const { w, d } = b;
  d.getElementById('gas-accessory-pick').value = 'REG'; w.eval('markGasAccessory()');
  d.getElementById('gas-accessory-pick').value = 'HOS'; w.eval('markGasAccessory()');
  assert.equal(w.eval("inventory.filter(p => p.isGasAccessory).length"), 2);
  w.eval(`selectGasSize('${f13}')`); w.eval("setGasTxType('set')");
  assert.equal(d.getElementById('gas-set-accessories').style.display, 'block');
  const rows = [...d.querySelectorAll('#gas-set-accessories-list .gas-acc-row')];
  assert.equal(rows.length, 2);
  for (const r of rows) r.querySelector('.gas-acc-check').checked = true;
  rows.find((r) => r.dataset.code === 'HOS').querySelector('.gas-acc-qty').value = '2';
  add(b, 'set', 2);
  const cart = Object.fromEntries(JSON.parse(w.eval('JSON.stringify(Object.values(currentCart))')).map((l) => [l.code, l.qty]));
  assert.equal(cart[f13], 2); assert.equal(cart.REG, 2, '1 regulator x 2 sets'); assert.equal(cart.HOS, 4, '2 hoses x 2 sets');
  await pay(b);
  assert.equal(qty(w, '13kg (Full)'), 18); assert.equal(qty(w, 'Regulator'), 8); assert.equal(qty(w, 'Gas Hose'), 6);
  w.eval("addToCart('REG')");                                                                     // and a regulator alone, like any item
  assert.equal(JSON.parse(w.eval('JSON.stringify(Object.values(currentCart))')).length, 1);
  w.eval("gasSaveInventory(); unmarkGasAccessory('HOS')");
  assert.equal(w.eval("inventory.find(p => p.code === 'HOS').isGasAccessory"), undefined);
  b.close();
});

test('cylinders with the supplier: sent empties are counted as "with supplier", then come back full', async () => {
  const { b, f13 } = await stocked('services/index.html');
  const { w, d } = b;
  const rec = (dir, q) => { d.getElementById('gas-supplier-variant-select').value = f13; d.getElementById('gas-supplier-direction').value = dir; val(d, 'gas-supplier-qty', q); w.eval('performSupplierGasExchange()'); return d.getElementById('gas-supplier-msg').textContent; };
  rec('send', 3);
  assert.deepEqual([qty(w, '13kg (Full)'), qty(w, '13kg (Empty)')], [20, 2]); assert.equal(totals(w).away, 3);
  assert.deepEqual(totals(w), { full: 51, empty: 10, away: 3, total: 64 }, 'still 64 cylinders, and you can see where each is');
  assert.match(rec('receive', 5), /Only 3/, 'cannot receive more than are away');
  rec('receive', 2);
  assert.deepEqual([qty(w, '13kg (Full)'), qty(w, '13kg (Empty)')], [22, 2]); assert.equal(totals(w).away, 1);
  rec('return', 1);
  assert.deepEqual([qty(w, '13kg (Full)'), qty(w, '13kg (Empty)')], [23, 1]);
  assert.match(rec('send', 5), /Only 1 empty/);
  b.close();
});

test('a price is needed before something can be sold', async () => {
  const b = await session('services/index.html');
  addSize(b, '13kg', 5, 5);
  b.w.eval("setGasTxType('exchange')"); val(b.d, 'gas-tx-qty', 1); b.w.eval('addGasLineToCart()');
  assert.match(b.d.getElementById('gas-add-msg').textContent, /Set the refill price/);
  assert.equal(b.w.eval('Object.keys(currentCart).length'), 0);
  b.close();
});
