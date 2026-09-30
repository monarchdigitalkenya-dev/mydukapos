import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';

// zip 161: "For recording a past sale I need to be able to sell even 0.5; it's typable but it auto-rounds to 1."
// Every module with the Record a Past Sale window takes fractional quantities (up to 3 decimals) and NEVER rounds them to a whole number.
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];
const INV = (qty = 10, extra = {}) => JSON.stringify([{ code: 'A1', type: 'item', name: 'Widget', price: 100, wholesalePrice: 40, qty, unit: 'kg', vatCategory: 'A', ...extra }]);
const val = (d, id, v) => { d.getElementById(id).value = String(v); };
async function session(app, inv = INV()) {
  const b = await boot(app, { storage: { pos_inventory: inv }, wait: 1500 });
  b.w.eval("window.__confirms = []; window.__ok = true; window.confirm = (m) => { window.__confirms.push(m); return window.__ok; }; showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }");
  return b;
}
function record(b, qty, price = 100) {
  const { w, d } = b;
  w.eval('openRecordPastSaleModal()');
  w.eval("selectPastSaleItem('A1')");
  val(d, 'past-sale-date-input', '2026-09-10'); val(d, 'past-sale-time-input', '14:30');
  val(d, 'past-sale-qty-input', qty); val(d, 'past-sale-price-input', price);
  val(d, 'past-sale-payment-select', 'cash'); w.eval('pastSalePaymentChanged()');
  w.eval('saveRecordPastSale()');
  return d.getElementById('past-sale-error').textContent;
}
const stock = (w) => w.eval('inventory.find(p => p.code === "A1").qty');
const lastSale = (w) => JSON.parse(w.eval('JSON.stringify(salesLog[salesLog.length - 1] || null)'));
const moves = (w) => JSON.parse(w.eval('JSON.stringify(stockMovementLog.filter(m => m.code === "A1"))'));

for (const app of APPS) {
  test(`${app}: the quantity box takes decimals (no min=1 / step=1, decimal keypad)`, async () => {
    const b = await session(app);
    const el = b.d.getElementById('past-sale-qty-input');
    assert.equal(el.getAttribute('inputmode'), 'decimal');
    assert.equal(el.getAttribute('step'), 'any');
    assert.equal(el.getAttribute('min'), '0.001');
    b.close();
  });

  test(`${app}: 0.5, 0.25, 1.5 are recorded exactly; stock 10 - 0.5 = 9.5 with no float dust`, async () => {
    const b = await session(app);
    const { w, errors } = b;
    assert.equal(record(b, '0.5'), '');
    assert.equal(lastSale(w).items[0].qty, 0.5, 'not rounded to 1');
    assert.equal(lastSale(w).cashAmount, 50, 'total = 100 x 0.5');
    assert.equal(stock(w), 9.5);
    assert.equal(record(b, '0.25'), '');
    assert.equal(lastSale(w).items[0].qty, 0.25);
    assert.equal(stock(w), 9.25);
    assert.equal(record(b, '1.5'), '');
    assert.equal(lastSale(w).items[0].qty, 1.5);
    assert.equal(stock(w), 7.75);
    assert.equal(record(b, '0.1'), '');           // 7.75 - 0.1 would be 7.65 with dust in plain floating point
    assert.equal(stock(w), 7.65);
    assert.equal(record(b, '0.05'), '');
    assert.equal(stock(w), 7.6, 'exactly, never 7.6000000000000005');
    assert.equal(w.eval('salesLog.length'), 5);
    assert.deepEqual(errors, []);
    b.close();
  });

  test(`${app}: comma decimal, fractions, 3-decimal rounding, and bad input is refused (never rounded to a whole)`, async () => {
    const b = await session(app);
    const { w, errors } = b;
    assert.equal(record(b, '0,5'), ''); assert.equal(lastSale(w).items[0].qty, 0.5);
    assert.equal(record(b, '1/2'), ''); assert.equal(lastSale(w).items[0].qty, 0.5);
    assert.equal(record(b, '0,125'), ''); assert.equal(lastSale(w).items[0].qty, 0.125);
    assert.equal(record(b, '0.12345'), ''); assert.equal(lastSale(w).items[0].qty, 0.123, 'rounded to 3 decimals');
    assert.equal(record(b, ' 2 '), ''); assert.equal(lastSale(w).items[0].qty, 2);
    const n = w.eval('salesLog.length'), st = stock(w);
    for (const bad of ['', 'abc', '0', '-1', '-0.5', '0.0001', '1e9', '2000000']) {
      const err = record(b, bad);
      assert.ok(err, `"${bad}" is refused with a message`);
    }
    assert.equal(w.eval('salesLog.length'), n, 'nothing recorded for any of them');
    assert.equal(stock(w), st, 'stock untouched');
    assert.deepEqual(errors, []);
    b.close();
  });

  test(`${app}: total is rounded to 2 dp, the sale/receipt show the fraction, and the movement log has one exact entry`, async () => {
    const b = await session(app, INV(10, { price: 33.33 }));
    const { w, errors } = b;
    assert.equal(record(b, '0.125', 33.33), '');
    const s = lastSale(w);
    assert.equal(s.items[0].qty, 0.125);
    assert.equal(s.cashAmount, 4.17, '33.33 x 0.125 = 4.16625 -> 4.17');
    assert.equal(w.eval('formatQtyDisplay(0.125, "kg")'), '0.125', 'shown as 0.125, not 0.13');
    assert.equal(w.eval('formatQtyDisplay(0.5, "kg")'), '0.5');
    assert.equal(w.eval('formatQtyDisplay(0.3333333, "kg")'), '0.33', 'longer figures still show 2 dp');
    const mv = moves(w);
    assert.equal(mv.length, 1);
    assert.equal(mv[0].delta, -0.125);
    assert.equal(mv[0].unit, 'qty');
    assert.match(mv[0].reason, /Sale/);
    assert.equal(stock(w), 9.875);
    assert.deepEqual(errors, []);
    b.close();
  });

  test(`${app}: not enough stock asks first (fractions shown as typed); "no" records nothing, "yes" floors stock at 0`, async () => {
    const b = await session(app, INV(0.5));
    const { w, errors } = b;
    w.eval('window.__ok = false');
    assert.equal(record(b, '0.75'), '');
    const msgs = JSON.parse(w.eval('JSON.stringify(window.__confirms)'));
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /Only 0\.5 in stock right now, but recording 0\.75/);
    assert.equal(w.eval('salesLog.length'), 0); assert.equal(stock(w), 0.5);
    w.eval('window.__ok = true');
    assert.equal(record(b, '0.75'), '');
    assert.equal(w.eval('salesLog.length'), 1); assert.equal(stock(w), 0);
    assert.equal(lastSale(w).items[0].qty, 0.75, 'the sale keeps the real 0.75');
    // enough stock: no question at all
    const w2 = await session(app, INV(10));
    assert.equal(record(w2, '9.999'), '');
    assert.equal(JSON.parse(w2.w.eval('JSON.stringify(window.__confirms)')).length, 0);
    assert.equal(stock(w2.w), 0.001);
    w2.close();
    assert.deepEqual(errors, []);
    b.close();
  });

  test(`${app}: a whole 'pcs' item takes fractions too (the normal cart does: every unit is decimal-capable) — and 2 pcs is still exactly 2`, async () => {
    const b = await session(app, INV(10, { unit: 'pcs' }));
    const { w } = b;
    assert.equal(w.eval('isDecimalUnit("pcs")'), true, 'the rule the normal Sales Counter follows');
    assert.equal(record(b, '0.5'), '');
    assert.equal(lastSale(w).items[0].qty, 0.5);
    assert.equal(record(b, '2'), '');
    assert.equal(lastSale(w).items[0].qty, 2);
    assert.equal(stock(w), 7.5);
    b.close();
  });

  test(`${app}: a dual-unit (box/piece) item: the quantity is in boxes, fractional, and pieces are untouched`, async () => {
    const b = await session(app, INV(10, { unit: 'box', dualUnit: true, unitsPerBox: 12, pieceQty: 5 }));
    const { w } = b;
    assert.equal(record(b, '0.5'), '');
    assert.equal(stock(w), 9.5);
    assert.equal(w.eval('inventory[0].pieceQty'), 5);
    b.close();
  });
}

// --- production: a produced item / set scales its components by the fractional qty, exactly like a normal fractional sale ---------------
test('production: a past sale of 0.5 of a produced item uses half the recipe, logs each material, and keeps componentsUsed for a void', async () => {
  const inv = JSON.stringify([
    { code: 'P1', type: 'item', name: 'Paint', price: 200, wholesalePrice: 80, qty: 0, unit: 'l', vatCategory: 'A', productionRecipe: [{ code: 'M1', qty: 2 }, { code: 'M2', qty: 0.3 }] },
    { code: 'M1', type: 'ingredient', name: 'Base', price: 0, wholesalePrice: 10, qty: 10, unit: 'kg' },
    { code: 'M2', type: 'ingredient', name: 'Pigment', price: 0, wholesalePrice: 10, qty: 1, unit: 'kg' },
  ]);
  const b = await boot('production/index.html', { storage: { pos_inventory: inv }, wait: 1500 });
  const { w, d, errors } = b;
  w.eval("window.confirm = () => true; showToast = function () {}");
  w.eval('openRecordPastSaleModal()'); w.eval("selectPastSaleItem('P1')");
  val(d, 'past-sale-date-input', '2026-09-10'); val(d, 'past-sale-time-input', '14:30');
  val(d, 'past-sale-qty-input', '0,5'); val(d, 'past-sale-price-input', 200);
  val(d, 'past-sale-payment-select', 'cash'); w.eval('pastSalePaymentChanged()');
  w.eval('saveRecordPastSale()');
  assert.equal(d.getElementById('past-sale-error').textContent, '');
  const q = (c) => w.eval(`inventory.find(p => p.code === "${c}").qty`);
  assert.equal(q('M1'), 9); assert.equal(q('M2'), 0.85);
  const s = lastSale(w);
  assert.equal(s.items[0].qty, 0.5);
  assert.deepEqual(s.items[0].componentsUsed.map((c) => [c.code, c.qty]), [['M1', 1], ['M2', 0.15]]);
  const mv = JSON.parse(w.eval('JSON.stringify(stockMovementLog)'));
  assert.deepEqual(mv.filter((m) => m.code === 'M1').map((m) => m.delta), [-1]);
  assert.deepEqual(mv.filter((m) => m.code === 'M2').map((m) => m.delta), [-0.15]);
  assert.deepEqual(errors, []);
  b.close();
});

// --- sync: the server rebuilds stock from the ledger and must land on the same figure the till shows --------------------------------
for (const app of ['index.html', 'hotel/index.html']) {
  test(`${app}: sync - fractional past sales reach the server as exact movements and its stock equals the till's (9.5, 9.25, 7.75)`, async () => {
    const s = makeServer();
    const dev = await openDevice(app, s, { pos_inventory: INV(10) }, 1500);
    dev.w.eval("window.confirm = () => true; showToast = function () {}");
    await dev.w.eval('pushNow()');
    const settled = () => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0));
    await settled();
    assert.equal(record(dev, '0.5'), '');
    await dev.w.eval('pushNow()'); await settled();
    assert.equal(stock(dev.w), 9.5);
    assert.equal(s.serverState().inventory.find((p) => p.code === 'A1').qty, 9.5, 'server rebuilt 10 - 0.5');
    assert.equal(record(dev, '0.25'), ''); assert.equal(record(dev, '1.5'), '');
    await dev.w.eval('pushNow()'); await settled();
    await sleep(100);
    const srv = s.serverState();
    assert.equal(srv.inventory.find((p) => p.code === 'A1').qty, 7.75);
    assert.equal(stock(dev.w), 7.75);
    const lg = srv.stockMovementLog.filter((m) => m.code === 'A1' && /recorded late/.test(m.reason || ''));
    assert.deepEqual(lg.map((m) => m.delta).sort((a, b) => a - b), [-1.5, -0.5, -0.25]);
    assert.ok(lg.every((m) => !m._srv || m._srv.applied !== false), 'each applied once');
    // a refresh (reopen from the same storage) keeps it, and re-sending changes nothing
    await dev.w.eval('pullState()');
    assert.equal(stock(dev.w), 7.75);
    dev.close();
  });
}
