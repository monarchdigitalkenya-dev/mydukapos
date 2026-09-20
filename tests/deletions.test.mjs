import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { fakeDoState, hasSqlite } from './do-fake.mjs';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// "I cleared a bill, refreshed, and it came back." A record a person DELETES must stay deleted on every device, and a stale copy must not bring it back.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function backends() {
  const sync = await load('functions/api/pos-sync.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const req = (m, b) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
  const out = [{ name: 'blob', push: async (b) => { await sync.onRequestPost({ request: req('POST', { businessName: 'Biz', ...b }), env, waitUntil() {} }); }, state: async () => (await sync.onRequestGet({ request: req('GET'), env })).json() }];
  if (hasSqlite) {
    const { ShopStore } = await load('wildcard-router/shop-store.js');
    const store = new ShopStore(fakeDoState(), {});
    out.push({ name: 'db', store, push: async (b) => { await store.fetch(new Request('https://s/push', { method: 'POST', body: JSON.stringify({ body: { businessName: 'Biz', ...b }, serverNow: Date.now() }) })); }, state: async () => JSON.parse(store.stateText(120)) });
  }
  return out;
}

test('a deleted record stays deleted: tombstone beats an older copy, loses to a newer one, and devices never receive it (both storage backends)', async () => {
  for (const b of await backends()) {
    const t = Date.now();
    await b.push({ updatedAt: t, bills: [{ id: 'b1', customerName: 'Ann', updatedAt: t - 100 }, { id: 'b2', customerName: 'Bob', updatedAt: t - 100 }], inventory: [{ code: 'A', qty: 1, updatedAt: t - 100 }] });
    await wait();
    await b.push({ updatedAt: Date.now(), bills: [{ id: 'b1', _deleted: true, updatedAt: Date.now() }], inventory: [{ code: 'A', _deleted: true, updatedAt: Date.now() }] });     // deleted on device A
    let st = await b.state();
    assert.deepEqual(st.bills.map((x) => x.id), ['b2'], b.name + ': the deleted bill is gone from what devices receive');
    assert.deepEqual(st.inventory, [], b.name + ': an emptied list is sent as an EMPTY list (so devices clear it), not omitted');
    await wait();
    await b.push({ updatedAt: Date.now(), bills: [{ id: 'b1', customerName: 'Ann', updatedAt: Date.now() - 500 }], inventory: [{ code: 'A', qty: 1, updatedAt: Date.now() - 500 }] });   // stale device pushes its old copies
    st = await b.state();
    assert.deepEqual(st.bills.map((x) => x.id), ['b2'], b.name + ': a stale copy does not bring it back');
    assert.deepEqual(st.inventory, [], b.name + ': ...nor the item');
    await wait();
    await b.push({ updatedAt: Date.now(), inventory: [{ code: 'A', qty: 9, name: 'Re-added', updatedAt: Date.now() }] });       // the same code deliberately added again later
    st = await b.state();
    assert.equal(st.inventory[0].qty, 9, b.name + ': a NEWER record with the same key replaces the tombstone');
  }
});

test('database created before tombstones existed is upgraded in place', async () => {
  if (!hasSqlite) return;
  const state = fakeDoState();
  state.storage.sql.exec("CREATE TABLE records (col TEXT NOT NULL, rk TEXT NOT NULL, ts INTEGER NOT NULL DEFAULT 0, upd INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL, seq INTEGER NOT NULL, code TEXT, json TEXT NOT NULL, PRIMARY KEY (col, rk))");
  state.storage.sql.exec("CREATE TABLE core (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  state.storage.sql.exec("INSERT INTO records (col, rk, ts, upd, pos, seq, code, json) VALUES ('bills', 'id:b1', 0, 1, 1, 1, NULL, '{\"id\":\"b1\",\"updatedAt\":1}')");
  const { ShopStore } = await load('wildcard-router/shop-store.js');
  const store = new ShopStore(state, {});                         // must not throw
  assert.deepEqual(JSON.parse(store.stateText(null)).bills.map((x) => x.id), ['b1'], 'old rows still read');
  store.push({ bills: [{ id: 'b1', _deleted: true, updatedAt: Date.now() }] }, Date.now());
  assert.deepEqual(JSON.parse(store.stateText(null)).bills, []);
});

const ITEMS = [{ code: '00001', type: 'item', name: 'Widget', price: 100, qty: 50, unit: 'pcs', vatCategory: 'A' }, { code: '00002', type: 'item', name: 'Gadget', price: 30, qty: 10, unit: 'pcs', vatCategory: 'A' }];
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true");
// A busy machine (the whole suite runs in parallel) can be many times slower than a quiet one, so nothing below waits a fixed time for
// a timer: pushes and pulls are awaited directly, and the few things that are asynchronous are polled for.
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(50); } return false; };
const settle = async (dev) => { await dev.w.eval('flushThenPull()'); };
const CASES = [
  ['a bill that is fully settled and removed from the open bills', 'bills', "bills.splice(bills.findIndex(b => b.id === 'X1'), 1); queuePush()", 'X1'],
  ['a debt row', 'debts', "deleteDebtRow('X1')", 'X1'],
  ['a supplier', 'suppliers', "removeSupplier('X1')", 'X1'],
  ['an inventory item', 'inventory', "deleteInventoryItem('X1')", 'X1'],
  ['a delivery zone', 'deliveryZones', "removeDeliveryZone('X1')", 'X1'],
  ['a recurring expense', 'recurringExpenses', "removeRecurringExpense('X1')", 'X1'],
  ['an offer', 'offers', "deleteOffer('X1')", 'X1'],
];
const seedRecords = { bills: { id: 'X1', customerName: 'Ann', items: [{ code: '00001', name: 'Widget', qty: 1, price: 100 }], amountPaid: 0, timestamp: new Date().toISOString(), updatedAt: 1 }, debts: { id: 'X1', name: 'Debtor', amount: 5, payments: [], updatedAt: 1 }, suppliers: { id: 'X1', name: 'Sup', updatedAt: 1 }, inventory: { code: 'X1', type: 'item', name: 'Doomed', price: 5, qty: 3, unit: 'pcs', vatCategory: 'A', updatedAt: 1 }, deliveryZones: { id: 'X1', name: 'Zone', fee: 10, updatedAt: 1 }, recurringExpenses: { id: 'X1', name: 'Rent', amount: 5, updatedAt: 1 }, offers: { id: 'X1', name: 'Off', type: 'percent', value: 5, active: true, updatedAt: 1 } };
const keyField = (col) => (col === 'inventory' ? 'code' : 'id');
const has = (dev, col) => dev.w.eval(`typeof ${col} !== 'undefined' && ${col}.some(x => String(x.${keyField(col)}) === 'X1')`);
const LS_KEY = { inventory: 'pos_inventory', recurringExpenses: 'pos_recurring_expenses', deliveryZones: 'pos_delivery_zones' };
const lsKey = (col) => LS_KEY[col] || 'pos_' + col.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());

for (const [label, col, del] of CASES) {
  test(`shop app: ${label} stays deleted for the other till, a stale till, a brand-new device and after a refresh`, { timeout: 240000 }, async () => {
    const s = makeServer();
    const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }, 2500); quiet(a.w);
    a.w.eval(`${col}.push(${JSON.stringify(seedRecords[col])}); safeSetItem('${lsKey(col)}', JSON.stringify(${col}))`);
    await a.w.eval('pushNow()'); await a.w.eval('pullState()');
    const store0 = deviceStorage(a.w);
    const b = await openDevice('index.html', s, store0, 2500); quiet(b.w);           // till B: synced, has the record
    const stale = await openDevice('index.html', s, store0, 2500); quiet(stale.w);    // till C: will stay stale
    await settle(b); await settle(stale);
    assert.equal(has(b, col), true, 'B starts with the record');
    // A deletes it
    a.w.eval(del);
    await a.w.eval('pushNow()');
    assert.ok(await until(() => /"_deleted":true/.test(JSON.stringify(s.serverState()[col]))), 'the server holds a tombstone');
    // B syncs: gone
    await settle(b);
    assert.equal(has(b, col), false, 'gone on the other till');
    // the STALE till pushes something else with its old copy of the list
    stale.w.eval("paymentDetails = 'Till 77'; safeSetItem('pos_payment_details', paymentDetails)");
    await stale.w.eval('pushNow()');
    assert.match(JSON.stringify(s.serverState()[col]), /"_deleted":true/, 'still deleted on the server');
    // A syncs after the stale push: still gone
    await settle(a);
    assert.equal(has(a, col), false, 'A does not get it back');
    // refresh A
    const a2 = await openDevice('index.html', s, deviceStorage(a.w), 2500); quiet(a2.w);
    await settle(a2);
    assert.equal(has(a2, col), false, 'gone after a refresh');
    // a brand-new device
    const fresh = await openDevice('index.html', s, {}, 2500); quiet(fresh.w);
    await settle(fresh);
    assert.equal(has(fresh, col), false, 'a brand-new device never sees it');
    for (const d of [a, b, stale, a2, fresh]) d.close();
  });
}

test('a refresh right after deleting (before the push fires) still deletes it', { timeout: 120000 }, async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }, 2500); quiet(a.w);
  a.w.eval("suppliers.push({ id: 'X1', name: 'Sup', updatedAt: 1 }); safeSetItem('pos_suppliers', JSON.stringify(suppliers))");
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  assert.ok(await until(() => { try { return /X1/.test(a.w.localStorage.getItem('sync_key_ack_v1:' + a.w.location.pathname) || ''); } catch (e) { return false; } }, 15000), 'the record list is saved for the next page load');
  a.w.eval("removeSupplier('X1')");
  const store = deviceStorage(a.w); a.close();                                                // refreshed before the push ever left
  const b = await openDevice('index.html', s, store, 2500); quiet(b.w);
  await settle(b);
  assert.equal(b.w.eval("suppliers.some(x => x.id === 'X1')"), false);
  assert.ok(await until(() => /"_deleted":true/.test(JSON.stringify(s.serverState().suppliers))), 'the delete reached the server on the first sync after the refresh');
  b.close();
});

test('safety net: a list that suddenly loses most of its records is treated as replaced, never turned into mass deletions', { timeout: 120000 }, async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }, 2500); quiet(a.w);
  a.w.eval("for (let i = 0; i < 60; i++) suppliers.push({ id: 'S' + i, name: 'Sup ' + i, updatedAt: 1 })");
  await a.w.eval('pushNow()');
  a.w.eval("suppliers = suppliers.slice(0, 5)");                                              // 55 of 60 vanish at once (not a person deleting)
  await a.w.eval('pushNow()');
  assert.doesNotMatch(JSON.stringify(s.serverState().suppliers), /"_deleted":true/, 'no tombstones were sent');
  assert.equal(s.serverState().suppliers.length, 60);
  a.close();
});
