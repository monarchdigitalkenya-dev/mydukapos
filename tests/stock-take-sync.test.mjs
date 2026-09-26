import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';
import { ledgerIntegrity } from '../functions/api/_merge.js';

// The stock-take data-integrity bug (zip 118), end to end: REAL apps (jsdom) talking to the REAL pos-sync server code.
//   A — a stock take reverted after a refresh / on another device / after a sync (a stale till's number won the merge);
//   B — stock added again and again (100 -> 120 -> 140 -> 160) when the same change was replayed.
// Fixed by the stock ledger: see applyStockLedger (functions/api/_merge.js) and logStockCount / reconcileLocalStockChanges
// (src/shared/functions.js). One logical action = one stock change, whatever is refreshed, retried or re-synced.
const ITEMS = [
  { code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 100, unit: 'pcs', vatCategory: 'A' },
  { code: 'B', type: 'item', name: 'Beta', price: 10, wholesalePrice: 5, qty: 30, unit: 'pcs', vatCategory: 'A' },
];
const qty = (w, c = 'A') => w.eval(`inventory.find(p => p.code === '${c}').qty`);
const quiet = (w) => w.eval('showToast = function () {}; window.confirm = () => true');
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0), 8000);
const srv = (s, c = 'A') => s.serverState().inventory.find((p) => p.code === c).qty;
const counts = (s) => (s.serverState().stockMovementLog || []).filter((m) => m.kind === 'count');
const sell = async (dev, code = 'A', n = 1) => {            // the same bookkeeping the checkout does: movement + qty, both saved
  dev.w.eval(`(function(){const p=inventory.find(x=>x.code==='${code}'); p.qty-=${n}; logStockMovement('${code}',p.name,-${n},'Sale'); safeSetItem('pos_inventory', JSON.stringify(inventory)); safeSetItem('pos_stock_movement_log', JSON.stringify(stockMovementLog)); queuePush();})()`);
  await settled(dev);
};
const stockTake = async (dev, code, n) => { dev.w.eval(`stockTakeSet('${code}','qty','${n}'); stockTakeApplyOne('${code}')`); await settled(dev); };
const refresh = async (dev, s, wait = 900) => { const st = deviceStorage(dev.w); dev.close(); const n = await openDevice('index.html', s, st, wait); quiet(n.w); return n; };
// records every push body the server receives, so a test can replay them (retries / resync)
// (devices already open are switched to the recording fetch too; `send` replays a body WITHOUT recording it again)
function recording(s, ...devs) {
  const bodies = [];
  const f = s.fetch;
  s.fetch = async (url, opts = {}) => { if ((opts.method || 'GET').toUpperCase() === 'POST' && String(url).includes('pos-sync')) bodies.push(opts.body); return f(url, opts); };
  devs.forEach((d) => { d.w.fetch = s.fetch; });
  bodies.send = (b) => f('https://shop.mydukapos.store/api/pos-sync', { method: 'POST', body: b });
  return bodies;
}
async function shop() {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');      // the server stamps its figures; the app switches the ledger on
  assert.equal(a.w.eval('stockLedgerOn()'), true, 'the server told the app it applies movements once');
  return { s, a };
}

test('TEST 1, 2, 9, 10 — stock take 100 -> 120 stays 120 after 20 refreshes, logout/login and a browser/device restart', async () => {
  const { s, a: a0 } = await shop();
  let a = a0;
  await stockTake(a, 'A', 120);
  assert.equal(qty(a.w), 120); assert.equal(srv(s), 120);
  for (let i = 0; i < 20; i++) {
    a = await refresh(a, s, 500);
    assert.equal(qty(a.w), 120, `refresh ${i + 1} on the device`);
    assert.equal(srv(s), 120, `refresh ${i + 1} on the server — never 140, 160, 180`);
  }
  // browser closed and reopened / device restarted: nothing in memory survives, only what was saved
  a.w.eval("localStorage.removeItem('pos_dirty_seq'); localStorage.removeItem('pos_acked_seq')");
  a = await refresh(a, s, 1500);
  assert.equal(qty(a.w), 120); assert.equal(srv(s), 120);
  assert.equal(counts(s).length, 1, 'one stock-take movement');
  assert.deepEqual([counts(s)[0]._srv.before, counts(s)[0]._srv.after, counts(s)[0]._srv.applied], [100, 120, true], 'the audit shows 100 -> 120 once');
  a.close();
});

test('TEST 3, 5 — the same push (a retry, a resync) sent again and again changes nothing', async () => {
  const { s, a } = await shop();
  const bodies = recording(s, a);
  await stockTake(a, 'A', 120);
  await sell(a, 'B', 2);
  assert.ok(bodies.length >= 2, 'the device\'s real pushes were recorded');
  const before = JSON.stringify(s.serverState().inventory.map((p) => [p.code, p.qty]));
  const recorded = bodies.slice();
  for (let round = 0; round < 3; round++) for (const b of recorded) await bodies.send(b);
  assert.equal(JSON.stringify(s.serverState().inventory.map((p) => [p.code, p.qty])), before);
  assert.equal(srv(s), 120); assert.equal(srv(s, 'B'), 28);
  assert.equal(counts(s).length, 1);
  a.close();
});

test('TEST 4 — a stock take made OFFLINE syncs once on reconnect: one count, one stock change, one audit entry', async () => {
  const { s, a } = await shop();
  s.state.down = true;
  a.w.eval("stockTakeSet('A','qty','120'); stockTakeApplyOne('A')");
  await sleep(400);
  assert.equal(qty(a.w), 120, 'the device shows the count at once');
  assert.equal(srv(s), 100, 'the server has not seen it yet');
  assert.match(a.d.getElementById('stock-take-history').textContent, /waiting to sync/);
  s.state.down = false;
  await a.w.eval('flushThenPull()');
  await a.w.eval('flushThenPull()');                              // reconnect events often fire twice
  assert.equal(srv(s), 120); assert.equal(qty(a.w), 120);
  assert.equal(counts(s).length, 1);
  a.w.eval('renderStockTakeHistory()');
  assert.match(a.d.getElementById('stock-take-history').textContent, /1 updated of 1 counted/);
  a.close();
});

test('TEST 6, 7 — another device sees the count; a STALE device selling or editing can no longer put the old number back', async () => {
  const { s, a } = await shop();
  const b = await openDevice('index.html', s, deviceStorage(a.w), 1200); quiet(b.w);
  assert.equal(qty(b.w), 100);
  await stockTake(a, 'A', 120);
  // B never pulled: it still shows 100. It sells one — before the fix its "99" won and the count was lost.
  await sell(b, 'A', 1);
  assert.equal(srv(s), 119, '120 - 1, not 99');
  b.w.eval("updateInventoryField('A', 'price', '150')");         // B edits the price from its stale copy
  await settled(b);
  assert.equal(srv(s), 119, 'its stale quantity is still ignored');
  assert.equal(s.serverState().inventory.find((p) => p.code === 'A').price, 150, 'its real edit goes through');
  await b.w.eval('pullState()'); await a.w.eval('pullState()');
  assert.equal(qty(b.w), 119); assert.equal(qty(a.w), 119);
  const b2 = await refresh(b, s, 1200);
  assert.equal(qty(b2.w), 119, 'device B after a refresh');
  a.close(); b2.close();
});

test('TEST 8 — two devices count the same item at about the same time: the later count stands, nothing stacks or vanishes', async () => {
  const { s, a } = await shop();
  const b = await openDevice('index.html', s, deviceStorage(a.w), 1200); quiet(b.w);
  s.state.down = true;                                             // both count while the other's count can't reach them
  a.w.eval("stockTakeSet('A','qty','120'); stockTakeApplyOne('A')");
  await sleep(20);
  b.w.eval("stockTakeSet('A','qty','118'); stockTakeApplyOne('A')");
  await sleep(300);
  s.state.down = false;
  await b.w.eval('flushThenPull()');                               // the LATER count arrives first ...
  await a.w.eval('flushThenPull()');                               // ... the earlier one second
  await a.w.eval('pullState()'); await b.w.eval('pullState()');
  assert.equal(srv(s), 118, 'the later physical count');
  assert.equal(qty(a.w), 118); assert.equal(qty(b.w), 118);
  const c = counts(s);
  assert.equal(c.length, 2, 'both counts are kept for the audit');
  assert.equal(c.filter((m) => m._srv.applied === false).length, 1, 'the older one is marked as superseded, not applied on top');
  a.w.eval('renderStockTakeHistory()');
  assert.match(a.d.getElementById('stock-take-history').textContent, /superseded by a later count/);
  a.close(); b.close();
});

test('TEST 11 — five tills selling while a stock take happens: final stock is exact, no lost sale, no duplicated adjustment', async () => {
  const { s, a } = await shop();
  const tills = [a];
  for (let i = 0; i < 4; i++) { const t = await openDevice('index.html', s, deviceStorage(a.w), 800); quiet(t.w); tills.push(t); }
  await stockTake(a, 'A', 120);                                   // counted at this moment: 120
  let sold = 0;
  for (let round = 0; round < 3; round++) {
    for (const t of tills) { await sell(t, 'A', 1); sold++; }       // each till sells from whatever (possibly stale) number it shows
  }
  const refreshed = [];
  for (const t of tills) refreshed.push(await refresh(t, s, 700));  // everyone refreshes (re-sending everything they hold)
  for (const t of refreshed) await t.w.eval('pullState()');
  assert.equal(srv(s), 120 - sold);
  refreshed.forEach((t, i) => assert.equal(qty(t.w), 120 - sold, `till ${i + 1}`));
  assert.equal(counts(s).length, 1);
  assert.equal(s.serverState().stockMovementLog.filter((m) => m.reason === 'Sale').length, sold, 'every sale is one movement');
  const integrity = ledgerIntegrity(s.serverState());
  assert.ok(integrity.ok, 'PHASE 19: database, history and figures agree ' + JSON.stringify(integrity.problems));
  refreshed.forEach((t) => t.close());
});

test('a stock change a screen forgot to itemise is still delivered exactly once (safety net), and never invented', async () => {
  const { s, a: a0 } = await shop();
  let a = a0;
  a.w.eval("(function(){const p=inventory.find(x=>x.code==='B'); p.qty = 25; safeSetItem('pos_inventory', JSON.stringify(inventory)); queuePush();})()");
  await settled(a);
  assert.equal(srv(s, 'B'), 25);
  for (let i = 0; i < 3; i++) { a = await refresh(a, s, 600); await a.w.eval('pushNow()'); }
  assert.equal(srv(s, 'B'), 25);
  const corr = s.serverState().stockMovementLog.filter((m) => /not itemised/.test(m.reason));
  assert.equal(corr.length, 1); assert.equal(corr[0].delta, -5);
  a.close();
});

test('pharmacy: a stock take on a batch-tracked item moves its batches too, so the next sale does not undo the count', async () => {
  const s = makeServer();
  const inv = [{ code: 'D', type: 'item', name: 'Drug', price: 50, wholesalePrice: 20, qty: 10, unit: 'pcs', vatCategory: 'A',
    batches: [{ id: 'b1', batchNumber: 'X', expiryDate: '2027-01-01', qty: 4 }, { id: 'b2', batchNumber: 'Y', expiryDate: '2028-01-01', qty: 6 }] }];
  const a = await openDevice('pharmacy/index.html', s, { pos_inventory: JSON.stringify(inv) });
  quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  a.w.eval("stockTakeSet('D','qty','15'); stockTakeApplyOne('D')");
  await settled(a);
  assert.equal(a.w.eval("inventory.find(p => p.code === 'D').batches.reduce((s, b) => s + b.qty, 0)"), 15, 'batches follow the count on the device');
  assert.equal(srv(s, 'D'), 15);
  assert.equal(s.serverState().inventory[0].batches.reduce((t, b) => t + b.qty, 0), 15, 'and on the server');
  a.close();
});

test('PHASE 11/13/19 — the stock-take report prints every column, and "Check stock" confirms device = server = history', async () => {
  const { s, a } = await shop();
  const b = await openDevice('index.html', s, deviceStorage(a.w), 1000); quiet(b.w);
  await stockTake(a, 'A', 120);
  await sell(b, 'A', 1);                                          // stale till sells
  await a.w.eval('pullState()');
  a.w.eval('window.print = () => { window.__printed = document.getElementById("aqua-pos-print-area").innerHTML; }');
  const id = a.w.eval('stockTakeHistoryFromLog()[0].id');
  a.w.eval(`printStockTakeReport('${id}')`);
  const printed = a.w.__printed || '';
  for (const col of ['Was', 'Counted', 'Adjustment', 'Now', 'Alpha', '100', '120', '+20', 'applied', String(id)]) assert.ok(printed.includes(col), `report shows ${col}`);
  const r = await a.w.eval('stockIntegrityCheck("stock-integrity-result")');
  assert.equal(r.ok, true); assert.equal(r.differ.length, 0);
  assert.match(a.d.getElementById('stock-integrity-result').textContent, /match the server/);
  a.close(); b.close();
});
