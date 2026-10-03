import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep, closeWhenIdle } from './e2e-harness.mjs';

// zip 201: the "I refreshed and the stock went back" / "stock keeps adding itself" family, driven end to end.
const ITEMS = () => [
  { code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 100, unit: 'pcs', vatCategory: 'A' },
  { code: 'B', type: 'item', name: 'Beta', price: 200, wholesalePrice: 80, qty: 50, unit: 'pcs', vatCategory: 'A' },
];
const quiet = (w) => w.eval('showToast = function () {}; window.confirm = () => true; window.print = () => {}');
const qty = (w, c) => w.eval(`inventory.find(p => p.code === '${c}').qty`);
async function sellOne(dev, code) {
  dev.w.eval(`addToCart('${code}'); currentPaymentMethod = 'cash'`);
  dev.d.getElementById('cash-tendered-input').value = '100000';
  await dev.w.eval('checkoutCart()');
}
async function restock(dev, code, n) {
  dev.w.eval(`restockDraft = [{ rowId: 1, code: '${code}', name: '', unit: 'pcs', qty: '${n}', cost: '40', sellPrice: '', wholesaleSell: '' }]`);
  try { await dev.w.eval('completeRestock()'); } catch (e) { /* sync */ }
}
async function settle(dev) { try { await dev.w.eval('pushNow()'); await dev.w.eval('pullState()'); } catch (e) { /* offline */ } await sleep(150); }
const srvQty = (s, c) => ((s.serverState().inventory || []).find((p) => p.code === c) || {}).qty;
const reopen = async (dev, s, extra) => { const st = deviceStorage(dev.w); await closeWhenIdle(dev); const d = await openDevice('index.html', s, st, 900, extra); quiet(d.w); return d; };

test('1. sale then refresh x3: stock stays reduced, never reverts, never double-deducts', async () => {
  const s = makeServer(); let a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS()) }); quiet(a.w);
  await sellOne(a, 'A'); assert.equal(qty(a.w, 'A'), 99);
  for (let i = 0; i < 3; i++) { a = await reopen(a, s); assert.equal(qty(a.w, 'A'), 99, 'after refresh ' + (i + 1)); }
  await settle(a); assert.equal(qty(a.w, 'A'), 99); assert.equal(srvQty(s, 'A'), 99);
  a = await reopen(a, s); assert.equal(qty(a.w, 'A'), 99); await closeWhenIdle(a);
});

test('2. restock then refresh BEFORE the push: stock kept, then added exactly once on the server', async () => {
  const s = makeServer(); let a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS()) }); quiet(a.w);
  await settle(a); await restock(a, 'A', 10); assert.equal(qty(a.w, 'A'), 110);
  a = await reopen(a, s); assert.equal(qty(a.w, 'A'), 110, 'kept after immediate refresh');
  for (let i = 0; i < 4; i++) { await settle(a); a = await reopen(a, s); }
  assert.equal(qty(a.w, 'A'), 110, 'never keeps adding itself'); assert.equal(srvQty(s, 'A'), 110);
  await closeWhenIdle(a);
});

test('3. offline sale + restock, many offline refreshes, then online: server gets each exactly once', async () => {
  const s = makeServer(); let a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS()) }); quiet(a.w);
  await settle(a); s.state.down = true;
  await sellOne(a, 'A'); await restock(a, 'B', 20);
  for (let i = 0; i < 3; i++) { a = await reopen(a, s); assert.equal(qty(a.w, 'A'), 99); assert.equal(qty(a.w, 'B'), 70); }
  s.state.down = false; await settle(a); await settle(a);
  assert.equal(qty(a.w, 'A'), 99); assert.equal(qty(a.w, 'B'), 70);
  assert.equal(srvQty(s, 'A'), 99); assert.equal(srvQty(s, 'B'), 70);
  for (let i = 0; i < 3; i++) { await settle(a); a = await reopen(a, s); }
  assert.equal(srvQty(s, 'A'), 99); assert.equal(srvQty(s, 'B'), 70); assert.equal(qty(a.w, 'B'), 70);
  await closeWhenIdle(a);
});

test('4. two devices sell and restock at once, offline then online: both end on the same, correct numbers', async () => {
  const s = makeServer(); let a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS()) }); quiet(a.w);
  await settle(a); let b = await openDevice('index.html', s, deviceStorage(a.w)); quiet(b.w); await settle(b);
  s.state.down = true;
  await sellOne(a, 'A'); await sellOne(a, 'A'); await restock(b, 'A', 7); await sellOne(b, 'B');
  s.state.down = false;
  for (let i = 0; i < 3; i++) { await settle(a); await settle(b); }
  assert.equal(srvQty(s, 'A'), 105); assert.equal(srvQty(s, 'B'), 49);
  assert.equal(qty(a.w, 'A'), 105); assert.equal(qty(b.w, 'A'), 105); assert.equal(qty(a.w, 'B'), 49); assert.equal(qty(b.w, 'B'), 49);
  a = await reopen(a, s); b = await reopen(b, s);
  assert.equal(qty(a.w, 'A'), 105); assert.equal(qty(b.w, 'B'), 49);
  await closeWhenIdle(a); await closeWhenIdle(b);
});

test('5. repeated sync cycles with nothing new change nothing (no drift)', async () => {
  const s = makeServer(); const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS()) }); quiet(a.w);
  await sellOne(a, 'A'); await restock(a, 'B', 5); await settle(a);
  for (let i = 0; i < 8; i++) await settle(a);
  assert.equal(qty(a.w, 'A'), 99); assert.equal(qty(a.w, 'B'), 55); assert.equal(srvQty(s, 'A'), 99); assert.equal(srvQty(s, 'B'), 55);
  await closeWhenIdle(a);
});

test('6. a manual stock edit survives refresh and reaches the other device', async () => {
  const s = makeServer(); let a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS()) }); quiet(a.w);
  await settle(a); let b = await openDevice('index.html', s, deviceStorage(a.w)); quiet(b.w);
  a.w.eval("updateInventoryField('A', 'qty', 120)"); await settle(a);
  assert.equal(qty(a.w, 'A'), 120); a = await reopen(a, s); assert.equal(qty(a.w, 'A'), 120, 'edit kept after refresh');
  await settle(b); assert.equal(qty(b.w, 'A'), 120, 'other device got the edit');
  await closeWhenIdle(a); await closeWhenIdle(b);
});

test('7. a sale made on A is not undone when an older copy of the shop (B, opened earlier) syncs afterwards', async () => {
  const s = makeServer(); const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS()) }); quiet(a.w);
  await settle(a); const b = await openDevice('index.html', s, deviceStorage(a.w)); quiet(b.w);
  await sellOne(a, 'A'); await settle(a); await settle(b); await settle(b);
  assert.equal(qty(b.w, 'A'), 99); assert.equal(srvQty(s, 'A'), 99);
  await closeWhenIdle(a); await closeWhenIdle(b);
});

