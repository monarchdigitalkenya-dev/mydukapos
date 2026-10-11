// zip 251 - COST INCIDENT: a till whose clock is behind the server made every re-sent record "newer" on every push, so the shop database (Durable Object
// SQLite) and the D1 ledger rewrote every record of every whole-list collection on every push. These tests run the REAL ShopStore and the REAL recordPush.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';

const test = baseTest;
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);

// A Durable Object SQL stand-in that counts the rows each INSERT / UPDATE / DELETE changed.
function countingState() {
  const db = new DatabaseSync(':memory:');
  const counts = {};
  const sql = {
    exec(q, ...b) {
      const st = db.prepare(q);
      if (/^\s*(select|with|pragma)/i.test(q)) { const rows = st.all(...b); return { toArray: () => rows }; }
      const r = st.run(...b);
      const m = /^\s*(insert|update|delete)\s+(?:into\s+|from\s+)?(\w+)/i.exec(q);
      if (m && Number(r.changes) > 0) counts[m[1].toUpperCase() + ' ' + m[2]] = (counts[m[1].toUpperCase() + ' ' + m[2]] || 0) + Number(r.changes);
      return { toArray: () => [] };
    },
  };
  return { counts, reset() { for (const k of Object.keys(counts)) delete counts[k]; }, storage: { sql, transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } } };
}
const total = (c) => Object.values(c).reduce((a, b) => a + b, 0);
const MIN = 60000;

async function shop(env = {}) {
  const { ShopStore } = await load('wildcard-router/shop-store.js');
  const st = countingState();
  const store = new ShopStore(st, env);
  return { store, st };
}
function lists(deviceNow) {
  const t = deviceNow - 5 * MIN;
  return {
    inventory: Array.from({ length: 60 }, (_, i) => ({ code: 'P' + i, name: 'Item ' + i, qty: 10, price: 100 + i, updatedAt: t })),
    customers: Array.from({ length: 20 }, (_, i) => ({ id: 'c' + i, name: 'Cust ' + i, updatedAt: t })),
    staff: [{ id: 'u1', name: 'Amina', updatedAt: t }],
  };
}
// one device cycle: push the whole lists, then take the server's copy back (what every pull does)
function cycle(store, cur, driftMs, edit) {
  const body = { businessName: 'Shop', ...JSON.parse(JSON.stringify(cur)), updatedAt: Date.now() + driftMs, _till: 'dev-A' };
  if (edit) edit(body);
  store.push(body, Date.now());
  const echo = JSON.parse(store.stateText(null));
  return { inventory: echo.inventory, customers: echo.customers, staff: echo.staff };
}

test('shop database: a till 10 minutes BEHIND no longer rewrites every record on every push', async () => {
  const { store, st } = await shop();
  const drift = -10 * MIN;
  let cur = lists(Date.now() + drift);
  cur = cycle(store, cur, drift);                                  // first push creates the rows
  const stamp0 = cur.inventory[0].updatedAt;
  for (let n = 0; n < 5; n++) {
    st.reset();
    cur = cycle(store, cur, drift);
    assert.equal(st.counts['UPDATE records'] || 0, 0, `push ${n + 2}: no record row may be rewritten for a time stamp alone`);
    assert.ok(total(st.counts) <= 4, `push ${n + 2}: only the shop's own bookkeeping rows may change (got ${JSON.stringify(st.counts)})`);
  }
  assert.equal(cur.inventory[0].updatedAt, stamp0, 'the stored time stamp must not walk into the future');
});

test('shop database: the old behaviour is still there behind SYNC_STAMP_GUARD=0 (the switch works, and the test above is not vacuous)', async () => {
  const { store, st } = await shop({ SYNC_STAMP_GUARD: '0' });
  const drift = -10 * MIN;
  let cur = lists(Date.now() + drift);
  cur = cycle(store, cur, drift);
  st.reset();
  cur = cycle(store, cur, drift);
  assert.equal(st.counts['UPDATE records'], 81, 'guard off: all 81 records are rewritten, as before this fix');
});

test('shop database: a REAL edit from a drifted till is still stored, and only that record is written', async () => {
  const { store, st } = await shop();
  const drift = -10 * MIN;
  let cur = lists(Date.now() + drift);
  cur = cycle(store, cur, drift);
  st.reset();
  cur = cycle(store, cur, drift, (b) => { const it = b.inventory.find((x) => x.code === 'P7'); it.price = 999; it.updatedAt = Date.now() + drift; });
  assert.equal(cur.inventory.find((x) => x.code === 'P7').price, 999, 'the edit reached the shop');
  assert.equal(st.counts['UPDATE records'], 1, 'exactly the edited record was written');
});

test('shop database: a till with a CORRECT clock behaves exactly as before (edit stored, resend free)', async () => {
  const { store, st } = await shop();
  let cur = lists(Date.now());
  cur = cycle(store, cur, 0);
  st.reset();
  cur = cycle(store, cur, 0);
  assert.equal(st.counts['UPDATE records'] || 0, 0);
  st.reset();
  cur = cycle(store, cur, 0, (b) => { const c = b.customers[3]; c.name = 'Renamed'; c.updatedAt = Date.now(); });
  assert.equal(cur.customers[3].name, 'Renamed');
  assert.equal(st.counts['UPDATE records'], 1);
});

test('shop database: a deletion (tombstone) and a stamp-only difference are told apart', async () => {
  const { sameExceptStamp } = await load('wildcard-router/shop-store.js');
  assert.equal(sameExceptStamp('{"id":"a","n":1,"updatedAt":5}', '{"updatedAt":99,"n":1,"id":"a"}'), true, 'same record, other stamp and key order');
  assert.equal(sameExceptStamp('{"id":"a","n":1,"updatedAt":5}', '{"id":"a","n":2,"updatedAt":5}'), false, 'content differs');
  assert.equal(sameExceptStamp('{"id":"a","updatedAt":5}', '{"id":"a","_deleted":true,"updatedAt":9}'), false, 'a tombstone is a real change');
  assert.equal(sameExceptStamp('{"id":"a","v":[{"x":1}],"updatedAt":5}', '{"id":"a","v":[{"x":2}],"updatedAt":6}'), false, 'nested content differs');
  assert.equal(sameExceptStamp('not json', '{"id":"a"}'), false, 'unreadable stored text is never skipped');
});

test('shop database: /stats reports the guard, the drifted device and records already stamped in the future', async () => {
  const { store } = await shop();
  const drift = -10 * MIN;
  let cur = lists(Date.now() + drift);
  cur = cycle(store, cur, drift);
  cur = cycle(store, cur, drift);
  const s = store.stats();
  assert.equal(s.guard.on, true);
  assert.equal(s.guard.pushes, 2);
  assert.ok(s.guard.timestampOnlySkipped >= 81);
  assert.ok(s.guard.driftedDevices['dev-A'] && s.guard.driftedDevices['dev-A'].offsetMs > 9 * MIN);
  assert.equal(s.guard.futureStamped, 0);
  store.sql.exec("UPDATE records SET upd = ? WHERE col = 'inventory' AND rk = 'code:P1'", Date.now() + 5 * 86400000);
  assert.equal(store.stats().guard.futureStamped, 1);
});

// ---------------------------------------------------------------- D1 ledger
async function ledger(env = {}) {
  const { recordPush } = await load('functions/api/_ledger.js');
  const { correctClockDrift } = await load('functions/api/_merge.js');
  const db = makeD1();
  const e = { LEDGER_DB: db, LEDGER_SEEN_MS: '0', AUDIT_REC_RATE_PER_MIN: '0', ...env };
  const changes = () => db._db.prepare('SELECT total_changes() AS c').get().c;
  const push = async (body) => { const before = changes(); const r = await recordPush(e, 'shopA', correctClockDrift(body, Date.now()), { source: 'pos-sync' }); return { r, rows: changes() - before }; };
  return { db, push };
}
function money(deviceNow) {
  const t = deviceNow - 50 * MIN;
  return {
    bills: Array.from({ length: 12 }, (_, i) => ({ id: 'b' + i, customerName: 'C' + i, total: 500 + i, amount: 500 + i, timestamp: new Date(t).toISOString(), updatedAt: t })),
    debts: Array.from({ length: 8 }, (_, i) => ({ id: 'd' + i, customerName: 'D' + i, amount: 200 + i, timestamp: new Date(t).toISOString(), updatedAt: t })),
  };
}
const shiftBack = (list, ms) => list.map((r) => ({ ...r, updatedAt: r.updatedAt + ms }));

test('D1 ledger: re-sending whole lists from a clock 10 minutes behind writes nothing after the first push', async () => {
  const { push, db } = await ledger();
  const drift = -10 * MIN;
  const m = money(Date.now() + drift);
  const first = await push({ ...JSON.parse(JSON.stringify(m)), updatedAt: Date.now() + drift, _dev: { app: 'shop' } });
  assert.ok(first.rows > 0);
  for (let n = 0; n < 4; n++) {
    const r = await push({ bills: shiftBack(m.bills, (n + 1) * 10 * MIN), debts: shiftBack(m.debts, (n + 1) * 10 * MIN), updatedAt: Date.now() + drift, _dev: { app: 'shop' } });   // stamps keep walking, as the client re-sent them
    assert.equal(r.rows, 0, `push ${n + 2}: a time stamp alone must not touch D1`);
    assert.equal(r.r.duplicate, true, 'reported as a pure re-send');
  }
  assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM ledger_records').get().n, 20);
});

test('D1 ledger: a real change from a drifted till is still written (amount, status), with its audit row', async () => {
  const { push, db } = await ledger();
  const drift = -10 * MIN;
  const m = money(Date.now() + drift);
  await push({ ...JSON.parse(JSON.stringify(m)), updatedAt: Date.now() + drift });
  const bills = shiftBack(m.bills, 10 * MIN);
  bills[2] = { ...bills[2], total: 777, amount: 777, updatedAt: Date.now() + drift };
  const r = await push({ bills, debts: shiftBack(m.debts, 10 * MIN), updatedAt: Date.now() + drift });
  assert.ok(r.rows >= 1, 'the edited bill was written');
  const row = db._db.prepare("SELECT amount FROM ledger_records WHERE rec_id = 'b2'").get();
  assert.equal(row.amount, 777);
  const untouched = db._db.prepare("SELECT amount FROM ledger_records WHERE rec_id = 'b3'").get();
  assert.equal(untouched.amount, 503);
});

test('D1 ledger: a correct-clock edit and a status change are written as before', async () => {
  const { push, db } = await ledger();
  const m = money(Date.now());
  await push({ ...JSON.parse(JSON.stringify(m)), updatedAt: Date.now() });
  const again = await push({ bills: m.bills, debts: m.debts, updatedAt: Date.now() });
  assert.equal(again.rows, 0);
  const paid = m.bills.map((b, i) => (i === 0 ? { ...b, paid: true, settledAt: Date.now(), updatedAt: Date.now() } : b));
  const r = await push({ bills: paid, debts: m.debts, updatedAt: Date.now() });
  assert.ok(r.rows >= 1);
  assert.equal(db._db.prepare("SELECT status FROM ledger_records WHERE rec_id = 'b0'").get().status, 'PAID');
});

test('D1 ledger: LEDGER_STAMP_GUARD=0 brings the old comparison back (the switch works)', async () => {
  const { push } = await ledger({ LEDGER_STAMP_GUARD: '0' });
  const drift = -10 * MIN;
  const m = money(Date.now() + drift);
  await push({ ...JSON.parse(JSON.stringify(m)), updatedAt: Date.now() + drift });
  const r = await push({ bills: shiftBack(m.bills, 10 * MIN), debts: shiftBack(m.debts, 10 * MIN), updatedAt: Date.now() + drift });
  assert.ok(r.rows >= 20, 'guard off: all 20 records are rewritten again');
});
