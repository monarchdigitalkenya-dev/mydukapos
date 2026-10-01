import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 163 - purchase packaging, one conversion engine, weighted-average cost, measured selling.
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];
const INV = () => JSON.stringify([
  { code: 'S1', type: 'item', name: 'Soda', price: 100, wholesalePrice: 50, qty: 10, unit: 'pcs', vatCategory: 'A' },
  { code: 'B1', type: 'item', name: 'Beef', price: 1000, wholesalePrice: 700, qty: 10, unit: 'kg', vatCategory: 'A', measureSale: true },
  { code: 'M1', type: 'item', name: 'Oil', price: 200, wholesalePrice: 120, qty: 20, unit: 'l', vatCategory: 'A', measureSale: true },
]);
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const row = (extra) => ({ rowId: 1, code: '', name: 'Soda', qty: '', cost: '', sellPrice: '', wholesaleSell: '', unit: 'pcs', ...extra });
const setDraft = (w, r) => w.eval(`restockDraft = [${JSON.stringify(r)}]; renderRestockRows();`);
const prod = (w, c) => J(w, `inventory.find(p => p.code === '${c}')`);

test('engine: conversions, packs + loose, no guessing across kinds, whole-KES display', async () => {
  const { w, close } = await boot('index.html', { storage: { pos_inventory: INV() }, wait: 800 });
  assert.equal(w.eval("msConvert(500, 'g', 'kg')"), 0.5);
  assert.equal(w.eval("msConvert(1.5, 'l', 'ml')"), 1500);
  assert.ok(Number.isNaN(w.eval("msConvert(1, 'kg', 'l')")), 'mass to volume is never guessed');
  assert.equal(w.eval("msPurchaseCalc({ invUnit: 'pcs', mode: 'pack', packs: 3, packSize: 24 }).invQty"), 72);
  assert.equal(w.eval("msPurchaseCalc({ invUnit: 'pcs', mode: 'pack', packs: 2, packSize: 24, loose: 5 }).invQty"), 53);
  assert.equal(w.eval("msPurchaseCalc({ invUnit: 'pcs', mode: 'inv', qty: 17 }).invQty"), 17, 'bypass packaging');
  assert.equal(w.eval("msPurchaseCalc({ invUnit: 'kg', mode: 'g', qty: 500, total: 250 }).invQty"), 0.5);
  assert.equal(w.eval("msPurchaseCalc({ invUnit: 'kg', mode: 'g', qty: 500, total: 250 }).effUnitCost"), 500);
  assert.ok(w.eval("msPurchaseCalc({ invUnit: 'pcs', mode: 'pack', packs: 3 }).error"), 'packs without contents is an error, not a guess');
  assert.equal(w.eval("msWac(10, 50, 72, 60)"), (500 + 4320) / 82);
  assert.equal(w.eval("msWac(0, 50, 5, 60)"), 60);
  assert.equal(w.eval("msWac(-3, 50, 5, 60)"), 60);
  assert.equal(w.eval("msKes(1234567.4)"), 'KES 1,234,567');
  assert.equal(w.eval("msKes(0.83)"), 'KES 0.83');
  assert.equal(w.eval("msQtyForAmount(250, 1000, 'kg', 'kg')"), 0.25);
  close();
});

for (const app of APPS) {
  test(`${app}: 3 boxes x 24 = 72 pieces once, effective cost, weighted average, history, exact expense`, async () => {
    const { w, errors, close } = await boot(app, { storage: { pos_inventory: INV() }, wait: 1200 });
    w.eval("showToast = function () {}; printRestockNote = function () {};");
    setDraft(w, row({ qty: '', cost: '' }));
    w.eval("msPuSet(1, 'mode', 'pack', true); msPuSet(1, 'packs', '3'); msPuSet(1, 'packSize', '24'); msPuSet(1, 'total', '4320');");
    assert.equal(w.eval('restockDraft[0].qty'), '72');
    assert.equal(w.eval('restockDraft[0].cost'), '60');
    assert.equal(w.eval('restockRowLineTotal(restockDraft[0])'), 4320);
    w.eval('completeRestock()');
    const p = prod(w, 'S1');
    assert.equal(p.qty, 82, '10 + 72, converted exactly once');
    assert.ok(Math.abs(p.wholesalePrice - (500 + 4320) / 82) < 1e-9, 'weighted average cost: ' + p.wholesalePrice);
    assert.equal(p.purchases.length, 1);
    assert.deepEqual([p.purchases[0].purchaseUnit, p.purchases[0].purchaseQty, p.purchases[0].packSize, p.purchases[0].invQty, p.purchases[0].totalCost, p.purchases[0].effUnitCost], ['Box', 3, 24, 72, 4320, 60]);
    assert.equal(p.purchasePackSize, 24, 'the pack contents are remembered for next time');
    const mv = J(w, "stockMovementLog.filter(m => m.code === 'S1').pop()");
    assert.equal(mv.delta, 72); assert.equal(mv.pu, 'Box'); assert.equal(mv.puQty, 3); assert.equal(mv.cost, 4320);
    assert.equal(w.eval("expenses[expenses.length - 1].amount"), 4320, 'expense = the exact total paid');
    assert.deepEqual(errors, []);
    close();
  });
}

test('2 boxes + 5 loose = 53; a contents override warns; a one-off override does not change the remembered contents', async () => {
  const { w, close } = await boot('index.html', { storage: { pos_inventory: INV().replace('"unit":"pcs"', '"unit":"pcs","purchaseUnit":"Box","purchasePackSize":24') }, wait: 1000 });
  w.eval("showToast = function () {}; printRestockNote = function () {};");
  setDraft(w, row());
  w.eval("msPuSet(1, 'mode', 'pack', true); msPuSet(1, 'packs', '2'); msPuSet(1, 'loose', '5');");
  assert.equal(w.eval('restockDraft[0].qty'), '53', 'packSize defaults to the remembered 24');
  w.eval("msPuSet(1, 'packSize', '20');");
  assert.equal(w.eval('restockDraft[0].qty'), '45');
  assert.ok(/normally holds 24/.test(w.eval("document.getElementById('ms-pu-sum-1').textContent")), 'override warning shown');
  w.eval("msPuSet(1, 'total', '100'); completeRestock()");
  assert.equal(prod(w, 'S1').qty, 55);
  assert.equal(prod(w, 'S1').purchasePackSize, 24, 'a one-off override is not remembered');
  close();
});

test('rounding: KES 100 for 3 pieces keeps the exact total and cost; weighted average is not rounded', async () => {
  const { w, close } = await boot('index.html', { storage: { pos_inventory: INV() }, wait: 1000 });
  w.eval("showToast = function () {}; printRestockNote = function () {};");
  setDraft(w, row({ qty: '3' }));
  w.eval("msPuSet(1, 'total', '100');");
  assert.equal(w.eval('restockDraft[0].cost'), String(100 / 3));
  assert.equal(w.eval('restockRowLineTotal(restockDraft[0])'), 100);
  w.eval('completeRestock()');
  assert.equal(w.eval("expenses[expenses.length - 1].amount"), 100);
  assert.ok(Math.abs(prod(w, 'S1').wholesalePrice - (10 * 50 + 100) / 13) < 1e-9);
  assert.equal(prod(w, 'S1').qty, 13);
  close();
});

test('mixed units: 500 g bought into a kg item is 0.5 kg; cost method "last" keeps the old behaviour', async () => {
  const { w, close } = await boot('index.html', { storage: { pos_inventory: INV().replace('"unit":"kg"', '"unit":"kg","costMethod":"last"') }, wait: 1000 });
  w.eval("showToast = function () {}; printRestockNote = function () {};");
  setDraft(w, row({ name: 'Beef', code: 'B1', unit: 'kg' }));
  w.eval("msPuSet(1, 'mode', 'g', true); msPuSet(1, 'amt', '500'); msPuSet(1, 'total', '400');");
  assert.equal(w.eval('restockDraft[0].qty'), '0.5');
  assert.equal(w.eval('restockDraft[0].cost'), '800');
  w.eval('completeRestock()');
  const p = prod(w, 'B1');
  assert.equal(p.qty, 10.5); assert.equal(p.wholesalePrice, 800, 'last-price method');
  close();
});

test('measured selling: by price and by amount land on the line in the stock unit with exact totals', async () => {
  const { w, errors, close } = await boot('index.html', { storage: { pos_inventory: INV() }, wait: 1000 });
  w.eval("showToast = function (m, e) { (window.__t = window.__t || []).push(m); }");
  // by price: KES 250 of KES 1000/kg beef = 0.25 kg
  w.eval("addToCart('B1')");
  assert.ok(w.eval("document.getElementById('ms-modal').style.display") === 'flex', 'measured item opens the measure dialog instead of adding 1 kg');
  assert.equal(w.eval("Object.keys(currentCart).length"), 0);
  w.eval("document.getElementById('ms-s-val').value = '250'; msSaleCalc(); msSaleAdd();");
  assert.equal(w.eval("currentCart.B1.qty"), 0.25);
  assert.equal(w.eval("cartTotal()"), 250);
  // a second purchase of the same item merges, exactly
  w.eval("addToCart('B1'); document.getElementById('ms-s-val').value = '100'; msSaleCalc(); msSaleAdd();");
  assert.equal(w.eval("currentCart.B1.qty"), 0.35);
  assert.equal(w.eval("cartTotal()"), 350);
  // by amount: 500 ml of KES 200/l oil = KES 100
  w.eval("addToCart('M1'); msSaleMode('amt'); document.getElementById('ms-s-val').value = '500'; document.getElementById('ms-s-unit').value = 'ml'; msSaleCalc(); msSaleAdd();");
  assert.equal(w.eval("currentCart.M1.qty"), 0.5);
  assert.equal(w.eval("currentCart.M1.price * currentCart.M1.qty"), 100);
  // a price that does not divide: KES 100 of KES 300/kg is a third of a kg, never a rounded-up one
  w.eval("delete currentCart.B1; delete currentCart.M1; inventory.find(p => p.code === 'B1').price = 300; addToCart('B1'); document.getElementById('ms-s-val').value = '100'; msSaleCalc(); msSaleAdd();");
  assert.ok(w.eval("currentCart.B1.price * currentCart.B1.qty") <= 100 + 1e-9, 'never charges more than the customer asked to spend');
  assert.ok(w.eval("currentCart.B1.price * currentCart.B1.qty") >= 99.8);
  // more than in stock is refused
  w.eval("delete currentCart.B1; inventory.find(p => p.code === 'B1').price = 1000; addToCart('B1'); document.getElementById('ms-s-val').value = '50000'; msSaleCalc(); msSaleAdd();");
  assert.equal(w.eval("currentCart.B1"), undefined);
  assert.ok(/Only 10 kg/.test(w.eval("window.__t.pop()")));
  assert.deepEqual(errors, []);
  close();
});

test('selling then voiding returns exactly the measured quantity (no double conversion, no drift)', async () => {
  const { w, close } = await boot('index.html', { storage: { pos_inventory: INV() }, wait: 1000 });
  w.eval("showToast = function () {}");
  w.eval("restoreStockForSaleUnit(inventory.find(p => p.code === 'B1'), 0.25, undefined)");
  assert.equal(prod(w, 'B1').qty, 10.25);
  w.eval("restoreStockForSaleUnit(inventory.find(p => p.code === 'B1'), 0.333, undefined)");
  assert.equal(prod(w, 'B1').qty, 10.583);
  close();
});

test('Orders tab "Arrived" also averages the cost', async () => {
  const { w, close } = await boot('index.html', { storage: { pos_inventory: INV() }, wait: 1000 });
  w.eval("poApplyArrivedLine({ orderNo: 'PO1' }, { code: 'S1', name: 'Soda', cost: 60 }, 10)");
  const p = prod(w, 'S1');
  assert.equal(p.qty, 20); assert.equal(p.wholesalePrice, 55);
  close();
});

test('Aqua POS is untouched (no purchase cards / measure wrapper)', async () => {
  const { w, errors, close } = await boot('water/index.html', { wait: 800 });
  assert.equal(w.eval("typeof msPurchaseCalc"), 'undefined');
  close();
});

test('end to end: sell 0.25 kg for KES 250, stock 9.75, profit uses the averaged cost, purchases report lists the delivery', async () => {
  const { w, errors, close } = await boot('index.html', { storage: { pos_inventory: INV() }, wait: 1000 });
  w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }; printRestockNote = function () {};");
  setDraft(w, row({ name: 'Beef', code: 'B1', unit: 'kg' }));
  w.eval("msPuSet(1, 'mode', 'pack', true); msPuSet(1, 'packName', 'Carcass'); msPuSet(1, 'packs', '1'); msPuSet(1, 'packSize', '10'); msPuSet(1, 'total', '8000'); completeRestock()");
  assert.equal(prod(w, 'B1').qty, 20);
  assert.equal(prod(w, 'B1').wholesalePrice, 750, '(10 x 700 + 10 x 800) / 20');
  w.eval("window.__lastRestockAt = 0; currentCart = {}; addToCart('B1'); document.getElementById('ms-s-val').value = '250'; msSaleCalc(); msSaleAdd(); currentPaymentMethod = 'cash'");
  w.document.getElementById('cash-tendered-input').value = '1000';
  await w.eval('checkoutCart()');
  assert.equal(w.eval('salesLog.length'), 1);
  assert.equal(prod(w, 'B1').qty, 19.75);
  const line = J(w, 'salesLog[0].items[0]');
  assert.equal(line.qty, 0.25); assert.equal(line.price * line.qty, 250); assert.equal(line.wholesalePrice, 750);
  w.eval("msOpenPurchasesReport(30)");
  const txt = w.document.getElementById('ms-modal').textContent;
  assert.ok(/Carcass/.test(txt) && /KES 8,000/.test(txt) && /Beef/.test(txt) && /KES 63/.test(txt), txt.slice(0, 400));
  assert.deepEqual(errors, []);
  close();
});
