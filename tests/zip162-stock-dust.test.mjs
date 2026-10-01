import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';

// zip 162: a normal fractional sale used to leave float dust in stock (0.3 - 0.1 = 0.19999999999999998, 10 - 0.1 - 0.2 - 0.3 = 9.399999999999999).
// Stock is now kept to 3 decimals on every sale / void / return / restock path, whole numbers behave exactly as before, and the server ledger agrees.
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];
const quiet = (w) => w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => d; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }");
const ITEMS = (qty) => JSON.stringify([
  { code: 'A', type: 'item', name: 'Alpha', category: 'General', price: 100, wholesalePrice: 50, qty, unit: 'kg', vatCategory: 'A' },
  { code: 'D', type: 'item', name: 'Boxed', category: 'General', price: 100, wholesalePrice: 50, qty: 5, unit: 'box', vatCategory: 'A', dualUnit: true, pieceQty: 0.5, unitsPerBox: 10, piecePrice: 12, pieceUnit: 'pc' },
]);
const isClean = (n) => Math.round(n * 1000) / 1000 === n;

for (const app of APPS) {
  test(`${app}: stockRound3 cleans dust, keeps whole numbers and genuine finer figures`, async () => {
    const b = await boot(app, { wait: 600 });
    const r = (x) => b.w.eval(`stockRound3(${x})`);
    assert.equal(r('0.3 - 0.1'), 0.2);
    assert.equal(r('10 - 0.1 - 0.2 - 0.3'), 9.4);
    assert.equal(r('7'), 7);
    assert.equal(r('-3'), -3);
    assert.equal(r('1.234567'), 1.234567, 'a 6-decimal recipe material is not cut to 3');
    assert.equal(r('NaN'), 0);
    b.close();
  });

  test(`${app}: fractional sales through deductStockForSaleUnit / restoreStockForSaleUnit leave no dust`, async () => {
    const b = await boot(app, { storage: { pos_inventory: ITEMS(0.3) }, wait: 700 });
    const { w, errors } = b; quiet(w);
    const q = () => w.eval("inventory.find(i => i.code === 'A').qty");
    w.eval("deductStockForSaleUnit(inventory.find(i => i.code === 'A'), 0.1, 'box')");
    assert.equal(q(), 0.2, '0.3 - 0.1 is exactly 0.2');
    w.eval("inventory.find(i => i.code === 'A').qty = 10");
    for (const x of [0.1, 0.2, 0.3]) { w.eval(`deductStockForSaleUnit(inventory.find(i => i.code === 'A'), ${x}, 'box')`); assert.ok(isClean(q()), 'clean after ' + x + ': ' + q()); }
    assert.equal(q(), 9.4);
    const deltas = JSON.parse(w.eval("JSON.stringify(stockMovementLog.filter(m => m.code === 'A').map(m => m.delta))"));
    assert.ok(deltas.every(isClean), 'every logged movement is clean: ' + deltas);
    w.eval("restoreStockForSaleUnit(inventory.find(i => i.code === 'A'), 0.3, 'box'); restoreStockForSaleUnit(inventory.find(i => i.code === 'A'), 0.2, 'box'); restoreStockForSaleUnit(inventory.find(i => i.code === 'A'), 0.1, 'box')");
    assert.equal(q(), 10, 'void puts back exactly what was taken');
    // whole numbers: unchanged behaviour (including the floor at 0)
    w.eval("deductStockForSaleUnit(inventory.find(i => i.code === 'A'), 4, 'box')"); assert.equal(q(), 6);
    w.eval("deductStockForSaleUnit(inventory.find(i => i.code === 'A'), 99, 'box')"); assert.equal(q(), 0, 'floored at 0 like before');
    // dual-unit loose pieces: 0.5 loose, sell 0.1 + 0.2 pieces -> 0.2 left, no box opened, and no "need > 0" loop from dust
    w.eval("deductStockForSaleUnit(inventory.find(i => i.code === 'D'), 0.1, 'piece'); deductStockForSaleUnit(inventory.find(i => i.code === 'D'), 0.2, 'piece')");
    assert.equal(w.eval("inventory.find(i => i.code === 'D').pieceQty"), 0.2);
    assert.equal(w.eval("inventory.find(i => i.code === 'D').qty"), 5, 'no box was opened');
    assert.deepEqual(errors, []);
    b.close();
  });

  test(`${app}: a real fractional checkout leaves clean stock`, { timeout: 45000 }, async () => {
    const b = await boot(app, { storage: { pos_inventory: ITEMS(10) }, wait: 900 });
    const { w, errors } = b; quiet(w);
    const q = () => w.eval("inventory.find(i => i.code === 'A').qty");
    const ring = async (qty) => {
      w.eval(`currentCart = {}; addToCart('A'); currentCart['A'].qty = ${qty}; currentPaymentMethod = 'cash'`);
      w.document.getElementById('cash-tendered-input').value = '100000';
      await w.eval('checkoutCart()');
      await new Promise((r) => setTimeout(r, 60));
    };
    for (const x of [0.1, 0.2, 0.3]) { await ring(x); assert.ok(isClean(q()), app + ' stock after ' + x + ' = ' + q()); }
    assert.equal(q(), 9.4);
    await ring(2); assert.equal(q(), 7.4, 'whole-number quantity behaves as before');
    assert.deepEqual(errors, []);
    b.close();
  });
}

// Server ledger parity: the server rebuilds stock from the movements; it must land on the same clean figure the till shows.
for (const app of ['index.html', 'hotel/index.html']) {
  test(`${app}: sync - fractional checkouts reach the server as clean movements and its stock equals the till's`, { timeout: 90000 }, async () => {
    const s = makeServer();
    const dev = await openDevice(app, s, { pos_inventory: ITEMS(10) }, 1500);
    quiet(dev.w);
    const settled = () => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0));
    await dev.w.eval('pushNow()'); await settled();
    for (const x of [0.1, 0.2, 0.3]) {
      dev.w.eval(`currentCart = {}; addToCart('A'); currentCart['A'].qty = ${x}; currentPaymentMethod = 'cash'`);
      dev.w.document.getElementById('cash-tendered-input').value = '100000';
      await dev.w.eval('checkoutCart()');
      await dev.w.eval('pushNow()'); await settled();
    }
    await sleep(100);
    const till = dev.w.eval("inventory.find(i => i.code === 'A').qty");
    assert.equal(till, 9.4);
    const srv = s.serverState();
    assert.equal(srv.inventory.find((p) => p.code === 'A').qty, 9.4, 'server stock equals the till (no 9.399999999)');
    const mv = srv.stockMovementLog.filter((m) => m.code === 'A' && /^Sale/.test(m.reason || ''));
    assert.deepEqual(mv.map((m) => m.delta).sort((a, b) => a - b), [-0.3, -0.2, -0.1]);
    dev.close();
  });
}
