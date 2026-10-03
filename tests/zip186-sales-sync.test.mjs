import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { boot, until } from './helpers.mjs';

// zip 186 (items 1 + 2): every sale ends up in Daily Sales, on every device of the shop.
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 500, unit: 'pcs', vatCategory: 'A' }];
const sale = (id, extra = {}) => ({ id, refNumber: 'R-' + id, timestamp: new Date().toISOString(), paymentMethod: 'cash', paid: true, servedBy: 'Jane', items: [{ code: 'A', name: 'Alpha', qty: 1, price: 100, unit: 'pcs' }], total: 100, ...extra });
const ids = (w) => JSON.parse(w.eval('JSON.stringify(salesLog.map(s => s.id))'));
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");
const rows = (t) => [...t.d.querySelectorAll('#daily-sales-table tbody tr')].filter((r) => !r.querySelector('.empty-state'));
const add = (w, s) => w.eval(`salesLog.push(${JSON.stringify(s)}); safeSetItem('pos_sales_log', JSON.stringify(salesLog)); queuePush()`);

test('owner whose OWN push is being refused still receives the employees\' new sales (and keeps his unsent one)', async () => {
  const s = makeServer();
  const owner = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(owner.w);
  const staff = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(staff.w);
  await owner.w.eval('pushNow()'); await owner.w.eval('pullState()'); await staff.w.eval('pullState()');
  // the employee sells; it reaches the server
  add(staff.w, sale('E1'));
  assert.equal(await staff.w.eval('pushNow()'), true);
  assert.ok(s.serverState().salesLog.some((x) => x.id === 'E1'));
  // from now on the server refuses this owner's pushes (a refusal that is not "busy")
  s.state.status = 400;
  add(owner.w, sale('O1'));
  await owner.w.eval('pushNow()');
  assert.equal(owner.w.eval('hasUnsyncedWork()'), true, 'the owner holds an unsent sale');
  owner.w.__stuckPullAt = 0;
  await owner.w.eval('pullState()');
  assert.deepEqual(ids(owner.w).sort(), ['E1', 'O1'], 'his screen has the employee sale AND his own unsent one');
  assert.ok(JSON.parse(deviceStorage(owner.w).pos_sales_log).some((x) => x.id === 'E1'), 'and it is stored on his device');
  // the server takes pushes again: his sale goes up, nothing duplicated
  s.state.status = null;
  owner.w.eval('window.__pushBackoffUntil = 0; window.__pushFails = 0');
  await owner.w.eval('syncRetryNow()'); await sleep(400);
  assert.deepEqual(s.serverState().salesLog.map((x) => x.id).sort(), ['E1', 'O1']);
  assert.deepEqual(ids(owner.w).sort(), ['E1', 'O1']);
  owner.close(); staff.close();
});

test('a sale record without an item list, a null entry and an item without a name do not stop Daily Sales from drawing (pulled from another device)', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  const st = s.serverState();
  st.salesLog = [sale('G1'), { id: 'BROKEN', timestamp: new Date().toISOString(), paymentMethod: 'cash' }, null, sale('G2', { items: [{ code: 'Z', qty: 1, price: 5 }] })];
  st.updatedAt = Date.now() + 5000;
  s.kv.data.set('pos-data:state:C1', { value: JSON.stringify(st) });
  await a.w.eval('pullState()');
  a.d.querySelector('.tab-link[data-tab="daily-sales-tab"]').click();
  await sleep(200);
  assert.deepEqual(ids(a.w).sort(), ['BROKEN', 'G1', 'G2']);
  assert.equal(rows(a).length, 3, 'all three are listed');
  a.close();
});

test('a null entry in the saved sales list does not stop the app starting', async () => {
  const t = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_sales_log: JSON.stringify([sale('K1'), null, { id: 'K2', timestamp: new Date().toISOString() }]) }, wait: 800 });
  quiet(t.w);
  assert.deepEqual(ids(t.w).sort(), ['K1', 'K2']);
  t.d.querySelector('.tab-link[data-tab="daily-sales-tab"]').click();
  t.w.eval('renderDailySales()');
  assert.equal(rows(t).length, 2);
  t.close();
});

test('Aqua POS: a sale pulled without items / site / payment method is listed (no crash), and a null entry in storage does not stop it starting', async () => {
  const s = makeServer();
  const w0 = await openDevice('water/index.html', s, { aqua_sales_log: JSON.stringify([null, { id: 'W0', timestamp: new Date().toISOString(), paymentMethod: 'cash', total: 10 }]) }); quiet(w0.w);
  assert.deepEqual(ids(w0.w), ['W0'], 'start-up kept the real record');
  await w0.w.eval('doPush()');
  const st = s.serverState();
  st.salesLog = [...(st.salesLog || []), { id: 'W1', timestamp: new Date().toISOString(), total: 10 }];
  st.updatedAt = Date.now() + 5000;
  s.kv.data.set('pos-data:state:C1', { value: JSON.stringify(st) });
  await w0.w.eval('pullFromServer()');
  assert.ok(ids(w0.w).includes('W1'), 'the pulled sale is in the list');
  const rec = JSON.parse(w0.w.eval("JSON.stringify(salesLog.find(s => s.id === 'W1'))"));
  assert.ok(Array.isArray(rec.items) && rec.paymentMethod && rec.siteId, 'made drawable: items, payment method and site filled in');
  w0.w.eval('renderDailySales()');
  w0.close();
});

test('closing the page right after a change whose push is still queued writes the lists again (and a failed write is retried)', async () => {
  const s = makeServer();
  s.state.down = true;
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  // an edit that only reached memory (as when a write failed): the exit hook saves it
  a.w.eval("inventory[0].qty = 321; window.__pushQueued = true");
  a.w.dispatchEvent(new a.w.Event('pagehide'));
  assert.equal(JSON.parse(deviceStorage(a.w).pos_inventory)[0].qty, 321);
  // nothing waiting: nothing is written
  a.w.eval("inventory[0].qty = 5; window.__pushQueued = false");
  a.w.dispatchEvent(new a.w.Event('pagehide'));
  assert.equal(JSON.parse(deviceStorage(a.w).pos_inventory)[0].qty, 321, 'an ordinary refresh writes nothing');
  a.close();
});
