import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice } from './e2e-harness.mjs';

// zip 292: the screens and checkout hooks on top of the serial / variant / import engine (src/shared/blocks/inventory-pro.html).
const PHONE = { code: 'PH1', type: 'item', name: 'Samsung A15', price: 18000, wholesalePrice: 15000, qty: 0, unit: 'pcs', vatCategory: 'A', serialized: true };
const PLAIN = { code: 'A', type: 'item', name: 'Alpha', price: 1000, wholesalePrice: 500, qty: 50, unit: 'pcs', vatCategory: 'A' };
const quiet = (w) => w.eval("window.__toasts = []; showToast = function (m, e) { window.__toasts.push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.print = () => {}; renderReceipt = function () {};");
const E = (w, code) => JSON.parse(w.eval(`JSON.stringify(${code})`));
const boot = async (inv = [PHONE, PLAIN], extra = {}) => {
  const dev = await openDevice('index.html', makeServer(), { pos_inventory: JSON.stringify(inv), ...extra }, 900);
  quiet(dev.w); return dev;
};
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const waitPick = async (d) => { for (let i = 0; i < 80; i++) { if (d.querySelector('[data-ip-act="pdone"]')) return; await tick(50); } };
const click = (d, sel) => { const el = d.querySelector(sel); assert.ok(el, 'missing ' + sel); el.click(); };
async function receive(dev, ids, extra = '') {
  const { w, d } = dev;
  w.eval("invProOpen('receive')");
  const ta = d.getElementById('ip-rtext'); ta.value = ids.join('\n'); ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  if (extra) w.eval(extra);
  await tick(); click(d, '[data-ip-act="rcvsave"]'); await tick();
}

test('receiving: 3 identifiers register 3 units, quantity follows, a repeated identifier is refused with its line number, one dual-IMEI line is ONE unit', async () => {
  const dev = await boot(); const { w, d } = dev;
  await receive(dev, ['356938035643801', '356938035643802', '356938035643803']);
  assert.equal(E(w, 'serialUnits.length'), 3);
  assert.equal(E(w, "inventory.find(i => i.code === 'PH1').qty"), 3);
  assert.ok(E(w, 'stockMovementLog').some((m) => m.code === 'PH1' && m.delta === 3));
  // the same identifier again + a new dual-IMEI unit
  w.eval("invProOpen('receive')");
  const ta = d.getElementById('ip-rtext'); ta.value = '356938035643802\n356938035643810 | 356938035643811'; ta.dispatchEvent(new w.Event('input', { bubbles: true })); await tick();
  assert.match(d.getElementById('ip-card').textContent, /Line 1: .*already registered/);
  click(d, '[data-ip-act="rcvsave"]'); await tick();
  assert.equal(E(w, 'serialUnits.length'), 4, 'only the valid line registered');
  assert.equal(E(w, "serialUnits.find(u => u.ids.length === 2).ids.length"), 2);
  assert.equal(E(w, "inventory.find(i => i.code === 'PH1').qty"), 4);
  assert.match(d.getElementById('ip-rtext').value, /356938035643802/, 'the failed line stays in the box');
});

test('checkout: the cashier must pick the real unit; the sale marks exactly it sold; the receipt carries its IMEI; void and unvoid follow the unit', async () => {
  const dev = await boot(); const { w, d } = dev;
  await receive(dev, ['111111111111111', '222222222222222', '333333333333333']);
  w.eval("document.getElementById('ip-ov').classList.remove('on')");
  w.eval("addToCart('PH1'); currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '18000'");
  const pending = w.eval('checkoutCart()');
  await waitPick(d);
  assert.ok(d.getElementById('ip-ov').classList.contains('on'), 'the unit picker opened');
  assert.equal(E(w, 'salesLog.length'), 0, 'no sale before a unit is chosen');
  const rows = d.querySelectorAll('[data-ip-act="ppick"]'); assert.equal(rows.length, 3);
  rows[1].click(); await tick();
  click(d, '[data-ip-act="pdone"]'); await pending; await tick(100);
  assert.equal(E(w, 'salesLog.length'), 1);
  const sale = E(w, 'salesLog[0]');
  assert.equal(sale.serialUnits.length, 1); assert.equal(sale.serialUnits[0].ids[0].value, '222222222222222');
  assert.equal(E(w, "serialUnits.find(u => u.ids[0].value === '222222222222222').status"), 'sold');
  assert.equal(E(w, "serialUnits.filter(u => u.status === 'in_stock').length"), 2);
  assert.equal(E(w, "inventory.find(i => i.code === 'PH1').qty"), 2, 'stock fell by exactly one');
  const doc = w.eval('buildReceiptDoc(salesLog[0], {}).text');
  assert.match(doc, /IMEI: 222222222222222/);
  // void: the unit is back in stock (stock is restored by the normal void path)
  w.eval("pendingVoidSaleSource = 'sales'; pendingVoidReason = 'test'; performVoidSale(salesLog[0].id)");
  assert.equal(E(w, "serialUnits.find(u => u.ids[0].value === '222222222222222').status"), 'in_stock');
  assert.equal(E(w, "inventory.find(i => i.code === 'PH1').qty"), 3);
  w.eval("pendingVoidSaleSource = 'sales'; performUnvoidSale(salesLog[0].id)");
  assert.equal(E(w, "serialUnits.find(u => u.ids[0].value === '222222222222222').status"), 'sold');
});

test('checkout: with no registered unit the sale is refused with the reason; a plain item is never asked for a unit', async () => {
  const dev = await boot([{ ...PHONE, qty: 2, serialUnregistered: 2 }, PLAIN]); const { w, d } = dev;
  w.eval("addToCart('A'); currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '1000'");
  await w.eval('checkoutCart()'); await tick(100);
  assert.equal(E(w, 'salesLog.length'), 1, 'plain item sold without any picker');
  assert.ok(!d.getElementById('ip-ov') || !d.getElementById('ip-ov').classList.contains('on'));
  w.eval("addToCart('PH1'); currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '18000'");
  const p = w.eval('checkoutCart()'); await waitPick(d);
  assert.match(d.getElementById('ip-card').textContent, /Only 0 registered unit.*2 more are counted/);
  click(d, '[data-ip-act="pcancel"]'); await p; await tick();
  assert.equal(E(w, 'salesLog.length'), 1, 'cancelling the picker cancels the sale');
});

test('units screen: a returned unit waits for inspection (not sellable, quantity unchanged); a manager passes it and the quantity rises; identifiers are searchable', async () => {
  const dev = await boot(); const { w, d } = dev;
  await receive(dev, ['444444444444444', '555555555555555']);
  w.eval("addToCart('PH1'); currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '18000'");
  const pending = w.eval('checkoutCart()'); await waitPick(d);
  d.querySelector('[data-ip-act="ppick"]').click(); await tick(); click(d, '[data-ip-act="pdone"]'); await pending; await tick(100);
  const id = E(w, "serialUnits.find(u => u.status === 'sold').id");
  w.eval("invProOpen('units')"); await tick();
  const q = d.getElementById('ip-uq'); q.value = '5555'; q.dispatchEvent(new w.Event('input', { bubbles: true })); await tick();
  assert.match(d.getElementById('ip-card').textContent, /555555555555555/);
  assert.doesNotMatch(d.getElementById('ip-card').textContent, /444444444444444/);
  w.eval(`invProState.uid = '${id}'; invProState.view = 'unit'; invProOpen('unit')`); await tick();
  d.getElementById('ip-ureason').value = 'changed mind';
  click(d, '[data-ip-act="uact"][data-to="returned"]'); await tick();
  assert.equal(E(w, `serialUnits.find(u => u.id === '${id}').status`), 'awaiting_inspection');
  assert.equal(E(w, "inventory.find(i => i.code === 'PH1').qty"), 1, 'not back in stock yet');
  d.getElementById('ip-ureason').value = 'checked, works'; await tick();
  w.eval("isAdminServing = function () { return true; }"); w.eval('invProOpen(\'unit\')'); await tick();
  d.getElementById('ip-ureason').value = 'checked, works';
  click(d, '[data-ip-act="uact"][data-to="in_stock"]'); await tick();
  assert.equal(E(w, `serialUnits.find(u => u.id === '${id}').status`), 'in_stock');
  assert.equal(E(w, "inventory.find(i => i.code === 'PH1').qty"), 2);
  assert.equal(E(w, `serialUnits.find(u => u.id === '${id}').history.length`), 5);
});

test('product editor: the checkbox keeps the flag through an edit, converts existing stock to "not yet identified", and Restock refuses a tracked item', async () => {
  const dev = await boot([PLAIN]); const { w, d } = dev;
  assert.ok(d.getElementById('inv-serialized'), 'checkbox in the Add Item form');
  assert.match(d.getElementById('inv-serialized-group').textContent, /This item has a unique identifier per item/);
  const set = (id, v) => { d.getElementById(id).value = v; };
  set('inv-code', 'A'); set('inv-name', 'Alpha'); set('inv-price', '1000'); set('inv-qty', '50');
  d.getElementById('inv-serialized').checked = true;
  w.eval('saveInventoryItem()'); await tick();
  const p = E(w, "inventory.find(i => i.code === 'A')");
  assert.equal(p.serialized, true); assert.equal(p.serialUnregistered, 50); assert.equal(p.qty, 50);
  // it cannot be sold until units exist
  w.eval("addToCart('A'); currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '1000'");
  const pend = w.eval('checkoutCart()'); await waitPick(d);
  assert.match(d.getElementById('ip-card').textContent, /Only 0 registered unit.*50 more are counted/);
  click(d, '[data-ip-act="pcancel"]'); await pend;
  // zip 345: restock of a tracked item no longer refuses - it asks for the serials of the new units first; stock does not move until they are entered
  w.eval("restockDraft.length = 0; restockDraft.push({ rowId: 1, code: 'A', name: 'Alpha', qty: '5', cost: '400', unit: 'pcs', sellPrice: '', wholesaleSell: '' })");
  w.eval('completeRestock()'); await tick();
  assert.equal(E(w, "inventory.find(i => i.code === 'A').qty"), 50);
  assert.ok(d.getElementById('ip-sr') || E(w, 'window.__toasts').some((t) => /IMEI|serial/i.test(t)), 'the serial entry screen opens (or a serial message shows)');
});

test('variants: the generator builds combinations, skips existing ones, and refuses a plain item that has stock', async () => {
  const shirt = { code: 'SH', type: 'item', name: 'Shirt', price: 500, wholesalePrice: 300, qty: 0, unit: 'pcs', vatCategory: 'A' };
  const dev = await boot([shirt, PLAIN]); const { w, d } = dev;
  w.eval("isAdminServing = function () { return true; }");
  w.eval("invProOpen('item', { code: 'SH' })"); await tick();
  click(d, '[data-ip-act="gen"]'); await tick();
  const set = (i, k, v) => { const el = d.querySelector(`[data-ip-def="${i}"][data-k="${k}"]`); el.value = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  set(0, 'name', 'Colour'); set(0, 'values', 'Black, Blue'); set(1, 'name', 'Size'); set(1, 'values', 'S, M');
  await tick();
  assert.match(d.getElementById('ip-card').textContent, /4 combination/);
  d.querySelector('[data-ip-combo="3"]').click(); await tick();
  click(d, '[data-ip-act="gencreate"]'); await tick();
  const sh = E(w, "inventory.find(i => i.code === 'SH')");
  assert.equal(sh.hasVariants, true); assert.equal(sh.variants.length, 3);
  assert.deepEqual(sh.variants.map((v) => v.name).sort(), ['Black / M', 'Black / S', 'Blue / S']);
  // plain item with stock: refused
  w.eval("invProOpen('item', { code: 'A' })"); await tick(); click(d, '[data-ip-act="gen"]'); await tick();
  assert.match(d.getElementById('ip-card').textContent, /plain item with 50 in stock/);
});

test('import wizard: preview, rejected rows, chunked run, a second run of the same file is blocked, variants go into the existing parent', async () => {
  const phone = { code: 'PH-A15', type: 'item', name: 'Samsung A15', price: 18000, wholesalePrice: 15000, qty: 0, unit: 'pcs', vatCategory: 'A' };
  const dev = await boot([phone]); const { w, d } = dev;
  w.eval("invProOpen('import')"); await tick();
  const sel = d.getElementById('ip-itype'); sel.value = 'variants'; sel.dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
  const headers = ['Parent SKU', 'Variant SKU', 'Colour', 'Storage', 'Cost price', 'Selling price', 'Quantity'];
  const rows = [['PH-A15', 'PH-A15-BLK-128', 'Black', '128GB', '15000', '18000', '0'], ['PH-A15', 'PH-A15-BLU-128', 'Blue', '128GB', '15000', '18000', '0'], ['NOPE', 'X-1', 'Red', '64GB', '1', '2', '0']];
  w.eval(`(function () { const I = invProState.imp; I.headers = ${JSON.stringify(headers)}; I.rows = ${JSON.stringify(rows)}; I.fileName = 'v.csv'; I.hash = 'hash-1'; I.map = importGuessMapping(I.headers); I.step = 3; })()`);
  w.eval("invProOpen('import')"); await tick();
  click(d, '[data-ip-act="iplan"]'); await tick();
  assert.match(d.getElementById('ip-card').textContent, /Rejected/);
  const plan = E(w, 'invProState.imp.plan'); assert.equal(plan.creatable, 2); assert.equal(plan.failed, 1);
  click(d, '[data-ip-act="irun"]'); await tick(300);
  const parent = E(w, "inventory.find(i => i.code === 'PH-A15')");
  assert.equal(parent.variants.length, 2); assert.equal(parent.hasVariants, true);
  assert.equal(E(w, 'importBatches.length'), 1); assert.equal(E(w, 'importBatches[0].status'), 'done');
  // the same file again is blocked unless the user overrides
  w.eval("(function () { const I = invProState.imp; I.step = 4; I.dup = importBatches[0]; I.override = false; })()"); w.eval("invProOpen('import')"); await tick();
  assert.equal(d.querySelector('[data-ip-act="irun"]').disabled, true);
  // re-running with an override changes nothing: variants already exist and are skipped
  w.eval("invProState.imp.override = true; invProState.imp.plan = importPlan(invProState.imp.rows, invProState.imp.map, 'variants', { inventory, units: serialUnits, mode: 'add', policy: 'skip' })");
  w.eval("invProOpen('import')"); await tick(); click(d, '[data-ip-act="irun"]'); await tick(300);
  assert.equal(E(w, "inventory.find(i => i.code === 'PH-A15').variants.length"), 2);
});

test('workspace: overview counts products, variants and units without double counting; search finds an item by IMEI; low stock lists', async () => {
  const dev = await boot([PHONE, { ...PLAIN, reorderLevel: 60 }]); const { w, d } = dev;
  await receive(dev, ['777777777777777', '888888888888888']);
  w.eval("invProOpen('home')"); await tick();
  const txt = d.getElementById('ip-card').textContent;
  assert.match(txt, /2\s*Products/); assert.match(txt, /2\s*Registered units · 2 available/);
  assert.match(txt, /Total quantity on hand/); assert.match(txt, /1\s*Low stock/);
  const q = d.getElementById('ip-q'); q.value = '8888888'; q.dispatchEvent(new w.Event('input', { bubbles: true })); await tick();
  assert.match(d.getElementById('ip-card').textContent, /Samsung A15/);
  assert.doesNotMatch(d.getElementById('ip-card').textContent, /Alpha/);
});

test('customer return of a serialized sale: the exact unit goes to inspection (stock unchanged); two units on one receipt asks which one came back', async () => {
  const dev = await boot(); const { w, d } = dev;
  await receive(dev, ['101010101010101', '202020202020202', '303030303030303']);
  w.eval("document.getElementById('ip-ov').classList.remove('on')");
  w.eval("addToCart('PH1'); addToCart('PH1'); currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '36000'");
  const pending = w.eval('checkoutCart()'); await waitPick(d);
  const rows = d.querySelectorAll('[data-ip-act="ppick"]'); rows[0].click(); await tick(); d.querySelectorAll('[data-ip-act="ppick"]')[1].click(); await tick();
  click(d, '[data-ip-act="pdone"]'); await pending; await tick(100);
  assert.equal(E(w, 'salesLog[0].serialUnits.length'), 2);
  assert.equal(E(w, "inventory.find(i => i.code === 'PH1').qty"), 1);
  const ref = E(w, 'salesLog[0].refNumber');
  // return ONE of the two: ambiguous -> the picker asks which
  w.eval(`restockReturnedItem(inventory.find(i => i.code === 'PH1'), 1, { sourceRefNumber: '${ref}' }, 'Returned Goods (restock)')`);
  await waitPick(d);
  assert.match(d.getElementById('ip-card').textContent, /Which unit came back/);
  d.querySelectorAll('[data-ip-act="ppick"]')[1].click(); await tick(); click(d, '[data-ip-act="pdone"]'); await tick(100);
  const st = E(w, "serialUnits.map(u => u.ids[0].value + ':' + u.status)");
  assert.equal(st.filter((x) => /awaiting_inspection/.test(x)).length, 1);
  assert.equal(st.filter((x) => /:sold/.test(x)).length, 1);
  assert.equal(E(w, "inventory.find(i => i.code === 'PH1').qty"), 1, 'returned stock is not sellable until inspected');
});
