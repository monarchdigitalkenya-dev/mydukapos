// zip 327 (issue 1): sales made on one device appear on the others - exactly once, offline or online, never across businesses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 100, openingStock: { qty: 100, costPrice: 50, date: '2026-01-01', setBy: 'x' }, unit: 'pcs', vatCategory: 'A' }];
const PRINTER = "showToast = function () {}; window.confirm = () => true; printerMode = 'system'; window.__relayWaitMs = 50; window.print = () => { window.dispatchEvent(new window.Event('afterprint')); };";
const settled = (d) => until(() => !d.w.eval('window.__pushQueued') && !(d.w.eval('window.__pushInFlight') > 0));
async function sell(t, n) { for (let i = 0; i < n; i++) { t.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); t.d.getElementById('cash-tendered-input').value = '1000'; await t.w.eval('checkoutCart()'); } }
const ids = (d) => JSON.parse(d.w.eval('JSON.stringify(salesLog.map(s => s.id))'));
const total = (d) => d.w.eval('salesLog.filter(s => !s.voided).reduce((n, s) => n + (s.cashAmount || 0), 0)');
const qty = (d) => d.w.eval("inventory.find(p => p.code === 'A').qty");
const mk = async (s, extra, w = 900) => { const d = await openDevice('index.html', s, extra, w, { indexedDB: new IDBFactory() }); d.w.eval(PRINTER); return d; };
const pull = async (d) => { await d.w.eval('pullState()'); await sleep(400); };

test('1. ten sales on device A appear on device B once each, with the same totals and stock', async () => {
  const s = makeServer({ d1: true });
  const a = await mk(s, { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' });
  await sell(a, 10); await a.w.eval('pushNow()'); await settled(a);
  const b = await openDevice('index.html', s, {}, 1800); b.w.eval(PRINTER);
  assert.equal(ids(b).length, 10); assert.equal(new Set(ids(b)).size, 10, 'no duplicates');
  assert.deepEqual(ids(b).sort(), ids(a).sort());
  assert.equal(total(b), total(a)); assert.equal(total(a), 1000 * 0 + 10 * 100);
  assert.equal(qty(b), 90); assert.equal(qty(a), 90);
  a.close(); b.close();
});

test('2. simultaneous sales on A and B: all sales kept, none duplicated, stock reduced by every sale', async () => {
  const s = makeServer({ d1: true });
  const a = await mk(s, { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' });
  await a.w.eval('pushNow()'); await settled(a);
  const b = await openDevice('index.html', s, {}, 1800); b.w.eval(PRINTER);
  await Promise.all([sell(a, 4), sell(b, 3)]);
  await Promise.all([a.w.eval('pushNow()'), b.w.eval('pushNow()')]); await settled(a); await settled(b); await sleep(300);
  await pull(a); await pull(b); await a.w.eval('pushNow()'); await b.w.eval('pushNow()'); await settled(a); await settled(b); await pull(a); await pull(b);
  const st = s.serverState();
  assert.equal(st.salesLog.length, 7); assert.equal(new Set(st.salesLog.map((x) => x.id)).size, 7);
  assert.equal(st.inventory.find((p) => p.code === 'A').qty, 93, 'server stock = 100 - 7');
  for (const d of [a, b]) { assert.equal(ids(d).length, 7, 'every device sees all 7'); assert.equal(qty(d), 93); }
  a.close(); b.close();
});

test('3. five sales made offline on A reach the server and B once, after reconnecting', async () => {
  const s = makeServer({ d1: true });
  const a = await mk(s, { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' });
  await a.w.eval('pushNow()'); await settled(a);
  const b = await openDevice('index.html', s, {}, 1800); b.w.eval(PRINTER);
  a.w.eval("Object.defineProperty(navigator,'onLine',{value:false,configurable:true})");
  await sell(a, 5);
  assert.equal(s.serverState().salesLog ? s.serverState().salesLog.length : 0, 0, 'nothing reached the server while offline');
  a.w.eval("Object.defineProperty(navigator,'onLine',{value:true,configurable:true})");
  await a.w.eval('pushNow()'); await settled(a); await sleep(300); await pull(b);
  assert.equal(s.serverState().salesLog.length, 5); assert.equal(ids(b).length, 5); assert.equal(qty(b), 95);
  await a.w.eval('pushNow()'); await settled(a); await pull(b);
  assert.equal(s.serverState().salesLog.length, 5, 'a second push does not add them again');
  a.close(); b.close();
});

test('4. the same sales sent again (retry) are not duplicated and stock is not deducted twice', async () => {
  const s = makeServer({ d1: true });
  const a = await mk(s, { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' });
  await sell(a, 3); await a.w.eval('pushNow()'); await settled(a);
  const sales = JSON.parse(a.w.eval('JSON.stringify(salesLog)')), moves = JSON.parse(a.w.eval('JSON.stringify(stockMovementLog)'));
  for (let i = 0; i < 3; i++) await a.w.eval('(async () => { window.__forcePush = true; await pushNow(); })()');
  await settled(a); await sleep(300);
  const st = s.serverState();
  assert.equal(st.salesLog.length, 3); assert.equal(st.stockMovementLog.length, moves.length);
  assert.equal(st.inventory.find((p) => p.code === 'A').qty, 97);
  const ledger = (await s.env.LEDGER_DB.prepare('SELECT sale_id, COUNT(*) n FROM ledger_sales GROUP BY sale_id').all()).results;
  assert.equal(ledger.length, 3); assert.ok(ledger.every((r) => Number(r.n) === 1), 'one ledger row per sale');
  a.close();
});

test('5. another business never receives these sales', async () => {
  const s = makeServer({ d1: true });
  const a = await mk(s, { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' });
  await sell(a, 2); await a.w.eval('pushNow()'); await settled(a);
  const other = makeServer({ d1: true });
  const c = await openDevice('index.html', other, {}, 1800);
  assert.equal(c.w.eval('salesLog.length'), 0); assert.equal(c.w.eval('inventory.length'), 0);
  const rows = (await other.env.LEDGER_DB.prepare('SELECT COUNT(*) n FROM ledger_sales').all()).results;
  assert.equal(Number(rows[0].n), 0, 'the other business ledger has no rows');
  a.close(); c.close();
});

test('6. report totals agree on every device and with the D1 ledger', async () => {
  const s = makeServer({ d1: true });
  const a = await mk(s, { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' });
  await sell(a, 6); await a.w.eval('pushNow()'); await settled(a);
  const b = await openDevice('index.html', s, {}, 1800); b.w.eval(PRINTER);
  await sell(b, 2); await b.w.eval('pushNow()'); await settled(b); await sleep(300); await pull(a);
  assert.equal(total(a), 800); assert.equal(total(b), 800);
  const led = (await s.env.LEDGER_DB.prepare("SELECT COALESCE(SUM(total),0) t, COUNT(*) n FROM ledger_sales WHERE status='COMPLETED'").all()).results[0];
  assert.equal(Number(led.t), 800); assert.equal(Number(led.n), 8);
  a.close(); b.close();
});
