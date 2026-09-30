import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { ROOT, boot, until } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// zip 158 - sync leftovers from the zip 156 audit:
//   2a  unsent / open trade credits, attendance and admin-activity records were archived (device) or their later edit dropped (server)
//   2b  a record edited in a field the "version" did not cover was taken for "already on the server" and never sent
//   2c  page code that runs after the window was closed (an unhandled rejection in the chaos test)
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const sync = await load('functions/api/pos-sync.js');
const ss = await load('functions/api/_state-store.js');
const merge = await load('functions/api/_merge.js');
const DAY = 86400000;
const STATE = 'pos-data:state:C1';
const newEnv = (extra = {}) => { const kv = makeKV(); seedShop(kv, 'C1'); return { kv, env: { mydukapos_kv: kv, ...extra } }; };
const req = (m, b) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
const post = (env, b) => sync.onRequestPost({ request: req('POST', b), env, waitUntil() {} });
const live = (kv) => JSON.parse(kv.data.get(STATE).value);
const iso = (ageDays) => new Date(Date.now() - ageDays * DAY).toISOString();

/* ---------------- 2a, server ---------------- */
test('2a server: still-open trade credits and shifts are never archived, settled / clocked-out old ones are', () => {
  const now = Date.now();
  const st = {
    tradeCredits: [
      { id: 'T-open', timestamp: iso(300), amount: 900, status: 'open', settledAt: null },
      { id: 'T-done', timestamp: iso(300), amount: 400, status: 'settled', settledAt: iso(299) },
    ],
    attendanceLog: [
      { id: 'A-open', clockIn: iso(300), clockOut: null },
      { id: 'A-done', clockIn: iso(300), clockOut: iso(300) },
    ],
    adminActivityLog: [{ id: 'X1', timestamp: iso(300) }],
  };
  const { keep, old, moved } = ss.splitOldHistory(st, now - 90 * DAY);
  assert.deepEqual(keep.tradeCredits.map((r) => r.id), ['T-open']);
  assert.deepEqual(keep.attendanceLog.map((r) => r.id), ['A-open']);
  assert.deepEqual(old.tradeCredits.map((r) => r.id), ['T-done']);
  assert.deepEqual(old.attendanceLog.map((r) => r.id), ['A-done']);
  assert.equal(moved, 3);
});

async function archivedCredits() {
  const { kv, env } = newEnv({ SYNC_MAX_BYTES: '14000', SYNC_AUTO_COMPRESS_BYTES: 'off' });
  const now = Date.now();
  const credit = (i, ageDays) => ({ id: 'T' + i, timestamp: iso(ageDays), partyName: 'P' + i + 'x'.repeat(40), direction: 'they_owe', amount: 100, status: 'settled', settledAt: iso(ageDays - 1) });
  const shift = (i, ageDays) => ({ id: 'A' + i, personKey: 'p', personName: 'n' + 'x'.repeat(30), clockIn: iso(ageDays), clockOut: iso(ageDays - 0.3) });
  const credits = [], shifts = [];
  for (let i = 0; i < 60; i++) { credits.push(credit(i, i < 40 ? 200 : 1)); shifts.push(shift(i, i < 40 ? 200 : 1)); }
  assert.equal((await post(env, { businessName: 'B', tradeCredits: credits, attendanceLog: shifts, updatedAt: Date.now() })).status, 200);
  assert.equal((await post(env, { businessName: 'B', tradeCredits: [credit(100, 0)], updatedAt: Date.now() })).status, 200);
  const st = live(kv);
  assert.ok(st._archiveCutoff, 'the shop archived itself');
  assert.equal(st.tradeCredits.some((x) => x.id === 'T0'), false, 'T0 is in the archive');
  assert.equal(st.attendanceLog.some((x) => x.id === 'A0'), false, 'A0 is in the archive');
  return { kv, env, now, credit, shift };
}

test('2a server: a trade credit / shift edited AFTER it was archived (no updatedAt on these lists) is stored, a stale old copy is still dropped', async () => {
  const { kv, env, credit, shift } = await archivedCredits();
  // a stale copy re-sent by a device that never pulled the archive: dropped
  await post(env, { businessName: 'B', tradeCredits: [credit(0, 200)], attendanceLog: [shift(0, 200)], updatedAt: Date.now() });
  assert.equal(live(kv).tradeCredits.some((x) => x.id === 'T0'), false, 'the old copy did not come back');
  assert.equal(live(kv).attendanceLog.some((x) => x.id === 'A0'), false);
  // an old credit that was still open when it was archived is settled now; an old shift is clocked out now: no updatedAt on either
  const paid = { ...credit(1, 200), status: 'settled', settledAt: new Date().toISOString() };
  const out = { ...shift(1, 200), clockOut: new Date().toISOString() };
  const r = await post(env, { businessName: 'B', tradeCredits: [paid], attendanceLog: [out], updatedAt: Date.now() });
  assert.equal(r.status, 200);
  const st = live(kv);
  assert.ok(st.tradeCredits.find((x) => x.id === 'T1' && x.settledAt === paid.settledAt), 'the settlement is stored (was dropped with a 200)');
  assert.ok(st.attendanceLog.find((x) => x.id === 'A1' && x.clockOut === out.clockOut), 'the clock-out is stored (was dropped with a 200)');
  // ...and it also works when the device clock is a few minutes slow
  const slow = -400000;
  const paid2 = { ...credit(2, 200), settledAt: new Date(Date.now() + slow).toISOString() };
  await post(env, { businessName: 'B', tradeCredits: [paid2], updatedAt: Date.now() + slow });
  assert.ok(live(kv).tradeCredits.find((x) => x.id === 'T2' && x.settledAt === paid2.settledAt), 'stored with a slow clock too');
});

test('2a server: a stale OPEN copy can never undo a settlement / clock-out (merge only moves forward), in the KV store and the shop database', async () => {
  const { kv, env } = newEnv();
  const open = { id: 'T1', timestamp: iso(3), partyName: 'Acme', amount: 500, status: 'open', settledAt: null };
  const settled = { ...open, status: 'settled', settledAt: iso(1) };
  await post(env, { businessName: 'B', tradeCredits: [open], attendanceLog: [{ id: 'A1', clockIn: iso(1), clockOut: null }], updatedAt: Date.now() });
  await post(env, { businessName: 'B', tradeCredits: [settled], attendanceLog: [{ id: 'A1', clockIn: iso(1), clockOut: iso(0.5) }], updatedAt: Date.now() });
  // a till that has not pulled yet sends its whole list on its first push: its old open copies arrive last
  await post(env, { businessName: 'B', tradeCredits: [open], attendanceLog: [{ id: 'A1', clockIn: iso(1), clockOut: null }], updatedAt: Date.now() });
  const st = live(kv);
  assert.equal(st.tradeCredits[0].status, 'settled', 'the debt stays settled');
  assert.ok(st.tradeCredits[0].settledAt);
  assert.ok(st.attendanceLog[0].clockOut, 'the shift stays clocked out');
  // the same rule as a plain function (the shop database uses it too)
  assert.equal(merge.mergeProgressRecord('tradeCredits', settled, open), settled);
  assert.equal(merge.mergeProgressRecord('tradeCredits', open, settled), settled);
  assert.equal(merge.mergeProgressRecord('attendanceLog', { id: 'a', clockOut: 5 }, { id: 'a', clockOut: null }).clockOut, 5);
});

/* ---------------- 2a, device ---------------- */
test('2a device: the archive moves only records the server acknowledged; an unsent or open one stays in the list', async () => {
  const { w, close } = await boot('index.html', { indexedDB: new IDBFactory(), wait: 300 });
  const credit = (id, age, extra) => ({ id, timestamp: iso(age), partyName: 'P', direction: 'i_owe', amount: 10, status: 'settled', settledAt: iso(age - 1), ...extra });
  const list = [
    credit('sent-old', 300), credit('unsent-old', 300),                      // both settled, only one was acknowledged
    credit('open-old', 300, { status: 'open', settledAt: null }),          // still owed: live data
    credit('recent', 1),
  ];
  w.eval(`tradeCredits = ${JSON.stringify(list)}`);
  w.eval(`attendanceLog = ${JSON.stringify([
    { id: 'shift-old', clockIn: iso(300), clockOut: iso(300) }, { id: 'shift-unsent', clockIn: iso(300), clockOut: iso(300) },
    { id: 'shift-open', clockIn: iso(300), clockOut: null },
  ])}`);
  w.eval(`adminActivityLog = ${JSON.stringify([{ id: 'act-old', timestamp: iso(300) }, { id: 'act-unsent', timestamp: iso(300) }])}`);
  // what the server has acknowledged (as a pull / an accepted push would have recorded it)
  w.eval("ackServerRecords('tradeCredits', tradeCredits.filter(r => r.id === 'sent-old' || r.id === 'open-old')); ackServerRecords('attendanceLog', attendanceLog.filter(r => r.id === 'shift-old' || r.id === 'shift-open')); ackServerRecords('adminActivityLog', adminActivityLog.filter(r => r.id === 'act-old'))");
  w.eval("window.__LOG_KEYS = window.__LOG_KEYS || {}");
  assert.equal(await w.eval("storageAutoArchive('write-failed')"), true);
  const ids = (n) => JSON.parse(w.eval(`JSON.stringify(${n}.map(r => r.id))`));
  assert.deepEqual(ids('tradeCredits').sort(), ['open-old', 'recent', 'unsent-old'], 'only the acknowledged settled credit moved');
  assert.deepEqual(ids('attendanceLog').sort(), ['shift-open', 'shift-unsent']);
  assert.deepEqual(ids('adminActivityLog'), ['act-unsent']);
  // an edit after the acknowledgement makes it "unsent" again
  w.eval("ackServerRecords('tradeCredits', tradeCredits.filter(r => r.id === 'unsent-old'))");
  w.eval("tradeCredits.find(r => r.id === 'unsent-old').description = 'edited after the last push'");
  w.eval("window.__resetAutoArchiveThrottle()");
  await w.eval("storageAutoArchive('write-failed')");
  assert.ok(ids('tradeCredits').includes('unsent-old'), 'edited after the acknowledgement: not sent yet, so it stays');
  close();
});

/* ---------------- 2b ---------------- */
const INV = JSON.stringify([{ code: 'A1', type: 'item', name: 'Tea', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }]);
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");

test('2b: the record version covers the whole record, not a few fields (same string on the device and the server)', async () => {
  const { w, close } = await boot('index.html', { wait: 200 });
  const base = { id: 's1', timestamp: '2026-09-01T10:00:00.000Z', paymentMethod: 'cash', customerName: 'Amina', note: 'a', items: [{ code: 'A1', name: 'Tea', price: 100, qty: 2 }], updatedAt: 111, tries: 3, ctx: { x: 1 } };
  const dev = (r) => w.eval(`salesJournalSig(${JSON.stringify(r)})`);
  assert.equal(dev(base), merge.businessSig(base), 'device and server compute the same version');
  for (const change of [{ customerName: 'Amina K' }, { paymentMethod: 'mpesa' }, { note: 'b' }, { items: [{ code: 'A2', name: 'Sugar', price: 100, qty: 2 }] }, { deliveryStatus: 'Delivered' }]) {
    const changed = { ...base, ...change };
    assert.notEqual(merge.businessSig(changed), merge.businessSig(base), 'server version changes with ' + Object.keys(change)[0]);
    assert.notEqual(dev(changed), dev(base), 'device version changes with ' + Object.keys(change)[0]);
    assert.equal(dev(changed), merge.businessSig(changed));
  }
  // bookkeeping the server stamps / re-stamps never changes the version, and key order does not either
  const same = { updatedAt: 999, tries: 9, dev: 'd', till: 2, ctx: { y: 2 }, _srv: { applied: true }, ...Object.fromEntries(Object.entries(base).reverse()) };
  assert.equal(merge.businessSig(same), merge.businessSig(base));
  assert.equal(dev(same), dev(base));
  close();
});

test('2b: a sale edited offline in a field the old version did not cover (customer name) reaches the server after a restart', async () => {
  const s = makeServer();
  let a = await openDevice('index.html', s, { pos_inventory: INV }); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  a.w.eval("currentPaymentMethod = 'cash'; addToCart('A1'); document.getElementById('cash-tendered-input').value = '1000'");
  await a.w.eval('checkoutCart()');
  await until(() => !a.w.eval('window.__pushQueued') && !(a.w.eval('window.__pushInFlight') > 0), 8000);
  await a.w.eval('pushNow()');
  const id = a.w.eval('salesLog[0].id');
  assert.ok(!s.serverState().salesLog.find((x) => x.id === id).customerName);
  // the app is closed; while it is closed (or offline) the sale is edited on the device - nothing else about it changes
  const st = deviceStorage(a.w); a.close();
  const sales = JSON.parse(st.pos_sales_log);
  sales.find((x) => x.id === id).customerName = 'Amina Wanjiru';
  st.pos_sales_log = JSON.stringify(sales);
  a = await openDevice('index.html', s, st, 400); quiet(a.w);
  for (let i = 0; i < 3; i++) { a.w.eval('window.__pushBackoffUntil = 0'); try { await a.w.eval('flushThenPull()'); } catch (e) { /* retried */ } await sleep(60); }
  assert.equal(s.serverState().salesLog.find((x) => x.id === id).customerName, 'Amina Wanjiru', 'the edit reached the server (it was taken for "already there")');
  a.close();
});

test('2b: a shop whose records the device already holds unchanged does not send them again (the check still works)', async () => {
  const s = makeServer();
  let a = await openDevice('index.html', s, { pos_inventory: INV }); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  for (let i = 0; i < 3; i++) { a.w.eval("currentPaymentMethod = 'cash'; addToCart('A1'); document.getElementById('cash-tendered-input').value = '1000'"); await a.w.eval('checkoutCart()'); }
  await until(() => !a.w.eval('window.__pushQueued') && !(a.w.eval('window.__pushInFlight') > 0), 8000);
  await a.w.eval('pushNow()');
  const st = deviceStorage(a.w); a.close();
  a = await openDevice('index.html', s, st, 400); quiet(a.w);
  await until(() => !a.w.eval('window.__pushInFlight') && !a.w.eval('window.__pullInFlight') && !a.w.eval('window.__pushQueued'), 8000);   // the start-up sync is over
  const bodies = [];
  const realFetch = a.w.fetch; a.w.fetch = (u, o) => { if (String(u).includes('/api/pos-sync') && o && o.method === 'POST') bodies.push(JSON.parse(o.body)); return realFetch(u, o); };
  a.w.eval('window.__pushBackoffUntil = 0'); await a.w.eval('flushThenPull()');
  a.w.eval('markLocalDirty && markLocalDirty()'); a.w.eval('window.__pushBackoffUntil = 0'); await a.w.eval('pushNow()');
  const carried = bodies.flatMap((b) => [...(b.salesLog || []), ...(b.stockMovementLog || [])]);
  assert.equal(carried.length, 0, 'nothing that the server already holds in the same version is uploaded again: ' + carried.length);
  a.close();
});

test('2b: a journal entry written as "synced" by the older, narrower version is not trusted: it is asked about again', async () => {
  const idb = new IDBFactory();
  const s = makeServer();
  let a = await openDevice('index.html', s, { pos_inventory: INV }, 400, { indexedDB: idb }); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  a.w.eval("currentPaymentMethod = 'cash'; addToCart('A1'); document.getElementById('cash-tendered-input').value = '1000'");
  await a.w.eval('checkoutCart()');
  await until(() => !a.w.eval('window.__pushQueued') && !(a.w.eval('window.__pushInFlight') > 0), 8000);
  await a.w.eval('pushNow()');
  const id = a.w.eval('salesLog[0].id');
  await until(() => a.w.eval(`salesSyncStatus('${id}') === 'synced'`), 5000);
  // rewrite that journal row the way the older release wrote it (no content hash), as "synced"
  await a.w.eval(`new Promise((res, rej) => { const rq = indexedDB.open('pos_sales_journal', 1); rq.onsuccess = () => { const db = rq.result; const tx = db.transaction('records', 'readwrite'); const st = tx.objectStore('records'); const g = st.getAll(); g.onsuccess = () => { g.result.forEach((r) => { if (r.sig) { r.sig = r.sig.replace(/\\|c[0-9a-z]+\\.[0-9a-z]+$/, ''); st.put(r); } }); }; tx.oncomplete = () => res(1); tx.onerror = () => rej(tx.error); }; })`);
  const st = deviceStorage(a.w); a.close();
  const sales = JSON.parse(st.pos_sales_log); sales.find((x) => x.id === id).note = 'edited while the app was closed'; st.pos_sales_log = JSON.stringify(sales);
  a = await openDevice('index.html', s, st, 600, { indexedDB: idb }); quiet(a.w);
  for (let i = 0; i < 3; i++) { a.w.eval('window.__pushBackoffUntil = 0'); try { await a.w.eval('flushThenPull()'); } catch (e) { /* retried */ } await sleep(80); }
  assert.equal(s.serverState().salesLog.find((x) => x.id === id).note, 'edited while the app was closed', 'the edit is sent, not skipped as "already synced"');
  a.close();
});

/* ---------------- 2c ---------------- */
test('2c: flushThenPull on a page that was closed while the push / pull was on its way ends there (nothing chained on it runs without a document)', async () => {
  for (const app of ['index.html', 'hotel/index.html', 'water/index.html']) {
    const s = makeServer();
    const d = await openDevice(app, s, {}, 300, { closeDelayMs: 60000 });
    const isWater = app.startsWith('water');
    const stub = isWater ? 'doPush = () => new Promise((r) => { window.__release = r; })' : 'pushNow = () => new Promise((r) => { window.__release = r; })';
    d.w.eval(stub);
    let outcome = 'pending';
    d.w.eval('flushThenPull()').then(() => { outcome = 'resolved'; }, (e) => { outcome = 'rejected: ' + e.message; });
    d.w.close();                                   // the window goes away while the push is on its way...
    d.w.__release && d.w.__release();              // ...and the push "answers" afterwards
    await sleep(150);
    assert.equal(outcome, 'pending', app + ': the chain ended with the page (was: ' + outcome + ')');
  }
});

test('2c: after a device is closed no answer reaches its page (the harness behaves like a browser that stopped the page): no unhandled rejection', async () => {
  const s = makeServer();
  const bad = [];
  const onRej = (e) => bad.push(String(e && e.message || e));
  process.on('unhandledRejection', onRej);
  try {
    let release; const gate = new Promise((r) => { release = r; });
    const held = [];
    const fetchHeld = (url, opts) => { const p = gate.then(() => s.fetch(url, opts)); held.push(p); return p; };
    const d = await openDevice('index.html', s, { pos_inventory: INV }, 350, { fetch: fetchHeld });   // the start-up requests are waiting on the line
    d.close();                                                                                          // the window goes away under them
    release();
    await Promise.allSettled(held); await sleep(400);
  } finally { process.off('unhandledRejection', onRej); }
  assert.deepEqual(bad, [], 'nothing threw after the close: ' + bad.join(' | '));
});

// A void / un-void / delivery step is stamped, so the server keeps it over a stale copy another till still holds (2b made every content difference visible to the sync, so
// a stale copy is now sent; the newer edit must win the merge).
for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hospital/index.html', 'water/index.html']) {
  test(`2b ${app}: voiding and un-voiding a sale stamps updatedAt, and the merge keeps the void over an older copy`, async () => {
    const key = app.startsWith('water') ? 'aqua_sales_log' : 'pos_sales_log';
    const sale = { id: 'S1', refNumber: 'R1', timestamp: new Date().toISOString(), paymentMethod: 'cash', paid: true, items: [], cashAmount: 0 };
    const b = await boot(app, { storage: { [key]: JSON.stringify([sale]) }, wait: 900 });
    b.w.eval("showToast = function () {}; window.confirm = () => true");
    const before = Date.now();
    b.w.eval("pendingVoidSaleSource = 'sales'; pendingVoidReason = 'x'; performVoidSale('S1')");
    const voided = JSON.parse(b.w.eval("JSON.stringify(salesLog.find(s => s.id === 'S1'))"));
    assert.equal(voided.voided, true);
    assert.ok(voided.updatedAt >= before, 'stamped');
    const merged = merge.mergeRecordsById([voided], [{ ...sale }], false, 'salesLog');
    assert.equal(merged[0].voided, true, 'an older, un-voided copy from a stale till does not bring the sale back');
    b.close();
  });
}
