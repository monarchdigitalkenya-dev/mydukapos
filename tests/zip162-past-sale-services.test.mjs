import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';

// zip 162: "Record a Past Sale" offers recipe / service / dish / combo items in every module that has them, and takes their materials exactly like a normal
// checkout of that kind of item (the app's own deduction), keeping componentsUsed (what was really taken) on the sale line.
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];
const INV = (extra = []) => JSON.stringify([
  { code: 'M1', type: 'ingredient', name: 'Mince', price: 0, wholesalePrice: 200, qty: 10, unit: 'kg', vatCategory: 'A' },
  { code: 'M2', type: 'item', name: 'Bun', price: 20, wholesalePrice: 8, qty: 50, unit: 'pcs', vatCategory: 'A' },
  { code: 'R1', type: 'service', name: 'Burger', price: 500, wholesalePrice: 0, unit: 'pcs', vatCategory: 'A', recipe: [{ code: 'M1', qtyPerUnit: 0.25 }] },
  { code: 'C1', type: 'service', name: 'Combo Meal', price: 600, unit: 'pcs', vatCategory: 'A', comboItems: [{ code: 'M2', qty: 2, name: 'Bun' }] },
  { code: 'U1', type: 'service', name: 'Haircut', price: 300, unit: 'pcs', vatCategory: 'A' },
  ...extra,
]);
const val = (d, id, v) => { d.getElementById(id).value = String(v); };
async function session(app, inv = INV(), storage = {}) {
  const b = await boot(app, { storage: { pos_inventory: inv, ...storage }, wait: 1500 });
  b.w.eval("window.__ok = true; window.confirm = () => true; showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }");
  return b;
}
function record(b, code, qty, price) {
  const { w, d } = b;
  w.eval('openRecordPastSaleModal()');
  w.eval(`selectPastSaleItem('${code}')`);
  val(d, 'past-sale-date-input', '2026-09-10'); val(d, 'past-sale-time-input', '14:30');
  val(d, 'past-sale-qty-input', qty); if (price != null) val(d, 'past-sale-price-input', price);
  val(d, 'past-sale-payment-select', 'cash'); w.eval('pastSalePaymentChanged()');
  w.eval('saveRecordPastSale()');
  return d.getElementById('past-sale-error').textContent;
}
const qtyOf = (w, code) => w.eval(`inventory.find(p => p.code === "${code}").qty`);
const lastSale = (w) => JSON.parse(w.eval('JSON.stringify(salesLog[salesLog.length - 1] || null)'));
const moves = (w, code) => JSON.parse(w.eval(`JSON.stringify(stockMovementLog.filter(m => m.code === "${code}" && m.type !== 'kitchen'))`));

for (const app of APPS) {
  test(`${app}: the past-sale search lists services / recipe items / combos (with a SERVICE tag)`, async () => {
    const b = await session(app);
    const { w, d, errors } = b;
    w.eval("openRecordPastSaleModal()");
    w.eval("liveSearchPastSaleItem('burger')");
    const box = d.getElementById('past-sale-item-results');
    assert.match(box.textContent, /Burger/);
    assert.ok(box.querySelector('.service-badge'), 'tagged as a service');
    w.eval("liveSearchPastSaleItem('combo')"); assert.match(box.textContent, /Combo Meal/);
    w.eval("liveSearchPastSaleItem('hair')"); assert.match(box.textContent, /Haircut/);
    w.eval("liveSearchPastSaleItem('bun')"); assert.match(box.textContent, /Bun/, 'plain items still listed');
    assert.deepEqual(errors, []);
    b.close();
  });

  test(`${app}: a recipe item's ingredients come off (scaled by a fractional qty), componentsUsed is kept, one exact movement`, async () => {
    const b = await session(app);
    const { w, errors } = b;
    assert.equal(record(b, 'R1', '2', 500), '');
    assert.equal(qtyOf(w, 'M1'), 9.5, '10 - 2 x 0.25');
    const s = lastSale(w);
    assert.equal(s.recordedLate, true);
    assert.equal(s.items[0].code, 'R1'); assert.equal(s.items[0].qty, 2); assert.equal(s.items[0].isService, true);
    assert.deepEqual(s.items[0].componentsUsed.map((c) => [c.code, c.qty]), [['M1', 0.5]]);
    assert.equal(s.cashAmount, 1000);
    assert.deepEqual(moves(w, 'M1').map((m) => m.delta), [-0.5]);
    assert.equal(record(b, 'R1', '0.5', 500), '');            // a half portion: 0.125 kg, exact
    assert.equal(qtyOf(w, 'M1'), 9.375);
    assert.equal(lastSale(w).items[0].qty, 0.5);
    assert.deepEqual(lastSale(w).items[0].componentsUsed.map((c) => [c.code, c.qty]), [['M1', 0.125]]);
    // a void puts the same materials back (the app's own void path)
    w.eval("restoreEntriesForVoid(salesLog[salesLog.length - 1].items)");
    assert.equal(qtyOf(w, 'M1'), 9.5);
    assert.deepEqual(errors, []);
    b.close();
  });

  test(`${app}: a combo takes its components; a plain service just records the sale`, async () => {
    const b = await session(app);
    const { w, errors } = b;
    assert.equal(record(b, 'C1', '3', 600), '');
    assert.equal(qtyOf(w, 'M2'), 44, '50 - 3 x 2 buns');
    assert.deepEqual(lastSale(w).items[0].componentsUsed.map((c) => [c.code, c.qty]), [['M2', 6]]);
    const n = w.eval("stockMovementLog.filter(m => m.type !== 'kitchen').length");
    assert.equal(record(b, 'U1', '1', 300), '');
    assert.equal(lastSale(w).items[0].isService, true);
    assert.equal(lastSale(w).items[0].componentsUsed, undefined, 'nothing consumed, nothing recorded');
    assert.equal(w.eval("stockMovementLog.filter(m => m.type !== 'kitchen').length"), n, 'no stock movement for an unlimited service');
    assert.equal(qtyOf(w, 'M1'), 10); assert.equal(qtyOf(w, 'M2'), 44);
    assert.equal(w.eval("salesLog.filter(s => s.recordedLate).length"), 2);
    assert.deepEqual(errors, []);
    b.close();
  });

  test(`${app}: a short material is floored at 0 like a normal sale (Hotel dishes are always sellable)`, async () => {
    const b = await session(app);
    const { w, errors } = b;
    w.eval("inventory.find(p => p.code === 'M1').qty = 0.3");
    let asked = 0; w.eval("window.confirm = () => { window.__asked = (window.__asked || 0) + 1; return true; }");
    assert.equal(record(b, 'R1', '2', 500), '');
    if (app === 'hotel/index.html') {       // a Hotel dish is ALWAYS sellable: its checkout lets an ingredient go below zero, so the late sale does too
      assert.equal(qtyOf(w, 'M1'), -0.2);
      assert.deepEqual(lastSale(w).items[0].componentsUsed.map((c) => [c.code, c.qty]), [['M1', 0.5]]);
    } else {
      assert.equal(qtyOf(w, 'M1'), 0, 'never below 0');
      assert.deepEqual(moves(w, 'M1').map((m) => m.delta), [-0.3]);
      assert.deepEqual(lastSale(w).items[0].componentsUsed.map((c) => [c.code, c.qty]), [['M1', 0.3]], 'what was REALLY taken');
    }
    assert.deepEqual(errors, []);
    b.close();
  });
}

test('production: a produced item and a Set are still consumed with componentsUsed, beside services', async () => {
  const b = await session('production/index.html', INV([
    { code: 'P1', type: 'item', name: 'Loaf', price: 90, wholesalePrice: 40, unit: 'pcs', vatCategory: 'A', productionRecipe: [{ code: 'M1', qty: 0.4 }] },
  ]));
  const { w } = b;
  assert.equal(record(b, 'P1', '2', 90), '');
  assert.equal(qtyOf(w, 'M1'), 9.2);
  assert.deepEqual(lastSale(w).items[0].componentsUsed.map((c) => [c.code, c.qty]), [['M1', 0.8]]);
  b.close();
});

test('hotel: a dish sold late is written to the kitchen ledger on the date of the sale', async () => {
  const b = await session('hotel/index.html');
  const { w } = b;
  assert.equal(record(b, 'R1', '2', 500), '');
  const k = JSON.parse(w.eval("JSON.stringify(stockMovementLog.filter(m => m.type === 'kitchen' && m.code === 'R1'))"));
  assert.equal(k.length, 1);
  assert.equal(k[0].kitchen.kind, 'sale'); assert.equal(k[0].kitchen.qty, 2);
  assert.equal(new Date(k[0].kitchen.at).toISOString().slice(0, 10), '2026-09-10', 'counted on the day it happened');
  assert.equal(qtyOf(w, 'M1'), 9.5);
  b.close();
});

for (const app of ['services/index.html', 'hotel/index.html']) {
  test(`${app}: sync - a past sale of a recipe item reaches the server: its stock equals the till's`, { timeout: 90000 }, async () => {
    const s = makeServer();
    const dev = await openDevice(app, s, { pos_inventory: INV() }, 1500);
    dev.w.eval("window.confirm = () => true; showToast = function () {}");
    const settled = () => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0));
    await dev.w.eval('pushNow()'); await settled();
    assert.equal(record(dev, 'R1', '2', 500), '');
    await dev.w.eval('pushNow()'); await settled(); await sleep(100);
    assert.equal(qtyOf(dev.w, 'M1'), 9.5);
    const srv = s.serverState();
    assert.equal(srv.inventory.find((p) => p.code === 'M1').qty, 9.5);
    assert.equal(srv.salesLog.filter((x) => x.recordedLate).length, 1);
    dev.close();
  });
}
