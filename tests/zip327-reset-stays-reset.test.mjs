// zip 327: a reset stays reset - on the same device after a sync, after a reopen, on a NEW device, and against a device that was offline holding old sales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 50, openingStock: { qty: 50, costPrice: 50, date: '2026-01-01', setBy: 'x' }, unit: 'pcs', vatCategory: 'A' }];
const PRINTER = "showToast = function () {}; window.confirm = () => true; printerMode = 'system'; window.__relayWaitMs = 50; window.print = () => { window.dispatchEvent(new window.Event('afterprint')); };";
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0));
async function sell(t, n) { for (let i = 0; i < n; i++) { t.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); t.d.getElementById('cash-tendered-input').value = '1000'; await t.w.eval('checkoutCart()'); } }
const loc = (d) => [d.w.eval("inventory.find(p=>p.code==='A').qty"), d.w.eval('salesLog.length'), d.w.eval('stockMovementLog.length')];
const srv = (s) => { const st = s.serverState(); return [st.inventory.find((p) => p.code === 'A').qty, (st.salesLog || []).length, (st.stockMovementLog || []).length]; };

test('reset: stock back to opening, sales and movements gone - and they stay gone after sync, on a new device', async () => {
  const s = makeServer({ d1: true });
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' }, 900, { indexedDB: new IDBFactory() });
  a.w.eval(PRINTER); await sell(a, 3); await a.w.eval('pushNow()'); await settled(a);
  assert.deepEqual(loc(a), [47, 3, 3]); assert.deepEqual(srv(s), [47, 3, 3]);
  a.w.eval('performResetExceptInventory()');
  assert.deepEqual(loc(a), [50, 0, 0]);
  await settled(a); await sleep(400);
  assert.deepEqual(loc(a), [50, 0, 0], 'this device after the sync');
  assert.deepEqual(srv(s), [50, 0, 0], 'the server');
  assert.equal(a.w.eval('window.logsResetPending ? !!logsResetPending() : null'), false, 'the instruction was delivered');
  const b = await openDevice('index.html', s, {}, 1800);
  assert.deepEqual(loc(b), [50, 0, 0], 'a brand new device');
  // a sale made AFTER the reset is kept everywhere
  a.w.eval(PRINTER); await sell(a, 1); await a.w.eval('pushNow()'); await settled(a); await sleep(300);
  assert.deepEqual(srv(s), [49, 1, 1]);
  a.close(); b.close();
});

test('an offline device that still holds old sales cannot bring them back, and clears them when it syncs', async () => {
  const s = makeServer({ d1: true });
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' }, 900, { indexedDB: new IDBFactory() });
  a.w.eval(PRINTER); await sell(a, 2); await a.w.eval('pushNow()'); await settled(a);
  const b = await openDevice('index.html', s, {}, 1500);
  assert.equal(b.w.eval('salesLog.length'), 2);
  a.w.eval('performResetExceptInventory()'); await settled(a); await sleep(300);
  assert.deepEqual(srv(s), [50, 0, 0]);
  // b still holds the two old sales; it syncs now
  await b.w.eval('pushNow()'); await settled(b); await sleep(400);
  assert.deepEqual(srv(s), [50, 0, 0], 'the server did not take the old sales back');
  assert.equal(b.w.eval('salesLog.length'), 0, 'the other device cleared its old copy');
  assert.equal(b.w.eval("inventory.find(p=>p.code==='A').qty"), 50);
  a.close(); b.close();
});

test('D1 ledger: reset marks the covered sales REMOVED so reports stop counting them', async () => {
  const s = makeServer({ d1: true });
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' }, 900, { indexedDB: new IDBFactory() });
  a.w.eval(PRINTER); await sell(a, 2); await a.w.eval('pushNow()'); await settled(a);
  a.w.eval('performResetExceptInventory()'); await settled(a); await sleep(300);
  const q = async (sql) => ((await s.env.LEDGER_DB.prepare(sql).all()).results) || [];
  const sales = await q("SELECT status, COUNT(*) AS n FROM ledger_sales GROUP BY status");
  assert.deepEqual(sales.map((r) => [r.status, Number(r.n)]), [['REMOVED', 2]]);
  const pays = await q("SELECT status, COUNT(*) AS n FROM ledger_payments GROUP BY status");
  assert.ok(pays.every((r) => r.status === 'REVERSED'), JSON.stringify(pays));
  // the sale is still there (money rows are never deleted) and a NEW sale after the reset counts
  a.w.eval(PRINTER); await sell(a, 1); await a.w.eval('pushNow()'); await settled(a);
  const after = await q("SELECT status, COUNT(*) AS n FROM ledger_sales GROUP BY status ORDER BY status");
  assert.deepEqual(after.map((r) => [r.status, Number(r.n)]), [['COMPLETED', 1], ['REMOVED', 2]]);
  a.close();
});

test('Reset app: the SERVER forgets the shop (name checked there), another device clears itself, an offline/refused reset claims nothing', async () => {
  const s = makeServer({ d1: true });
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' }, 900, { indexedDB: new IDBFactory() });
  a.w.eval(PRINTER); await sell(a, 2); await a.w.eval('pushNow()'); await settled(a);
  assert.equal(s.serverState().businessName, 'Biz', 'the stored name the server checks against');
  const b = await openDevice('index.html', s, {}, 1500);
  assert.equal(b.w.eval('salesLog.length'), 2);
  // a wrong name is refused by the SERVER and changes nothing
  const bad = await a.w.eval("resetAppOnServer('Wrong name', 'Own')");
  assert.equal(bad.ok, false);
  assert.equal(srv(s)[1], 2, 'nothing was wiped');
  // offline: not claimed
  s.state.down = true;
  const off = await a.w.eval("resetAppOnServer('Biz', 'Own')");
  assert.equal(off.ok, false); assert.match(off.error, /not|could not|offline/i);
  s.state.down = false;
  // the real one
  const ok = await a.w.eval("resetAppOnServer('Biz', 'Own')");
  assert.equal(ok.ok, true);
  const st = s.serverState();
  assert.equal(st.businessName, 'Biz'); assert.ok(st.wiped && st.wiped.id); assert.equal((st.salesLog || []).length, 0); assert.equal((st.inventory || []).length, 0);
  const rows = ((await s.env.LEDGER_DB.prepare('SELECT status, COUNT(*) AS n FROM ledger_sales GROUP BY status').all()).results) || [];
  assert.deepEqual(rows.map((r) => [r.status, Number(r.n)]), [['REMOVED', 2]]);
  // device b (offline-stale, still holding data) learns of it on its next pull and clears itself
  await b.w.eval('pullState()'); await sleep(600);
  assert.equal(b.w.eval("localStorage.getItem('pos_wiped_id')"), st.wiped.id);
  assert.deepEqual(JSON.parse(b.w.eval("localStorage.getItem('pos_inventory') || '[]'")), [], 'the other device cleared its old inventory');
  assert.equal(b.w.eval("localStorage.getItem('pos_biz_name')"), 'Biz');
  // and a stale push of the old inventory / sales cannot bring them back
  await b.w.eval('pushNow()').catch(() => {}); await sleep(300);
  assert.equal((s.serverState().salesLog || []).length, 0);
  a.close(); b.close();
});
