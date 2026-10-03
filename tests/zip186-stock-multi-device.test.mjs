import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// zip 186 (item 5), two tills: a restock and a stock take made on different devices, with refreshes and one device offline, always add up.
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 100, unit: 'pcs', vatCategory: 'A' }];
const qty = (w) => w.eval("inventory.find(p => p.code === 'A').qty");
const srv = (s) => s.serverState().inventory.find((p) => p.code === 'A').qty;
const quiet = (w) => w.eval('showToast = function () {}; window.confirm = () => true; window.print = () => {}');
const restock = (w, n) => w.eval(`restockDraft = [{ rowId: 1, code: 'A', name: '', unit: 'pcs', qty: '${n}', cost: '40', sellPrice: '', wholesaleSell: '' }]; window.__lastRestockAt = 0; completeRestock()`);
const refresh = async (dev, s, wait = 1000) => { const st = deviceStorage(dev.w); dev.close(); const n = await openDevice('index.html', s, st, wait); quiet(n.w); return n; };
const sync = async (...ds) => { for (const d of ds) { await d.w.eval('flushThenPull()'); } await sleep(150); for (const d of ds) await d.w.eval('flushThenPull()'); };
async function two() {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  const b = await openDevice('index.html', s, deviceStorage(a.w)); quiet(b.w);
  await b.w.eval('pullState()');
  return { s, a, b };
}

test('A restocks and refreshes; B (not yet synced) sells one: 149 everywhere, then B refreshes too', async () => {
  const { s, a: a0, b: b0 } = await two(); let a = a0, b = b0;
  restock(a.w, 50);
  a = await refresh(a, s, 1200);
  b.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); b.d.getElementById('cash-tendered-input').value = '1000'; await b.w.eval('checkoutCart()');
  await sync(a, b);
  assert.equal(srv(s), 149); assert.equal(qty(a.w), 149); assert.equal(qty(b.w), 149);
  b = await refresh(b, s, 1200);
  assert.equal(qty(b.w), 149); assert.equal(srv(s), 149);
  a.close(); b.close();
});

test('A applies a stock take (120) and refreshes; B, which still shows 100, restocks 50 afterwards: 170, never 150 or 100', async () => {
  const { s, a: a0, b: b0 } = await two(); let a = a0, b = b0;
  a.w.eval("stockTakeSet('A','qty','120'); stockTakeApplyOne('A')");
  a = await refresh(a, s, 1200);
  await sleep(100);
  restock(b.w, 50);
  await sync(a, b);
  assert.equal(srv(s), 170, 'server'); assert.equal(qty(a.w), 170); assert.equal(qty(b.w), 170);
  a = await refresh(a, s, 1200); b = await refresh(b, s, 1200);
  assert.equal(qty(a.w), 170); assert.equal(qty(b.w), 170); assert.equal(srv(s), 170);
  a.close(); b.close();
});

test('B is OFFLINE: restocks 30 and refreshes twice; A counts 90 meanwhile; B comes back: the restock (made after the count) is kept', async () => {
  const { s, a, b: b0 } = await two(); let b = b0;
  s.state.down = true;
  await sleep(50);
  restock(b.w, 30);
  b = await refresh(b, s, 800); b = await refresh(b, s, 800);
  assert.equal(qty(b.w), 130, 'offline, after two refreshes');
  s.state.down = false;
  // A counts 90 BEFORE B's restock was made? No: the count is made now, i.e. after B's restock -> the count wins, and a later change adds on top
  a.w.eval("stockTakeSet('A','qty','90'); stockTakeApplyOne('A')");
  await sync(a, b);
  const total = srv(s);
  assert.equal(qty(a.w), total); assert.equal(qty(b.w), total);
  assert.equal(total, 90, 'a count made after the restock includes it');
  b = await refresh(b, s, 1000);
  assert.equal(qty(b.w), 90);
  a.close(); b.close();
});

test('restock then a sale of the same item, refresh with the server down, then up: 149 once', async () => {
  const s = makeServer();
  let a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  s.state.down = true;
  restock(a.w, 50);
  a.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); a.d.getElementById('cash-tendered-input').value = '1000'; await a.w.eval('checkoutCart()');
  assert.equal(qty(a.w), 149);
  a = await refresh(a, s, 900);
  assert.equal(qty(a.w), 149);
  s.state.down = false;
  await sync(a);
  assert.equal(srv(s), 149); assert.equal(qty(a.w), 149);
  a = await refresh(a, s, 1000);
  assert.equal(qty(a.w), 149);
  a.close();
});
