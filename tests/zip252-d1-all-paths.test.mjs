// zip 252 - the remaining D1 write paths (tabs -> ledger_bills, sale lines, repeat-send memory) ignore a time stamp alone, and still write real changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const MIN = 60000;
async function ledger(env = {}) {
  const { recordPush } = await load('functions/api/_ledger.js');
  const { correctClockDrift } = await load('functions/api/_merge.js');
  const db = makeD1();
  const e = { LEDGER_DB: db, LEDGER_SEEN_MS: '0', AUDIT_REC_RATE_PER_MIN: '0', ...env };
  const changes = () => db._db.prepare('SELECT total_changes() AS c').get().c;
  const push = async (body) => { const b = changes(); const r = await recordPush(e, 'shopA', correctClockDrift(body, Date.now()), { source: 'pos-sync' }); return { r, rows: changes() - b }; };
  return { db, push };
}
const mk = (t0, stamp) => ({
  tabs: Array.from({ length: 6 }, (_, i) => ({ id: 't' + i, billNo: 'B' + i, openedAt: new Date(t0).toISOString(), status: 'OPEN', label: 'Table ' + i, owner: 'Amina', updatedAt: stamp, orders: [{ entries: [{ price: 100, qty: 2 }] }] })),
  salesLog: Array.from({ length: 4 }, (_, i) => ({ id: 's' + i, timestamp: new Date(t0).toISOString(), updatedAt: stamp, total: 300, paymentMethod: 'cash', servedBy: 'Amina', items: [{ code: 'A', name: 'A', qty: 1, price: 100 }, { code: 'B', name: 'B', qty: 2, price: 100 }] })),
});

test('tabs: a stamp-only re-send does not rewrite ledger_bills; a real change (status, total) does', async () => {
  const { push, db } = await ledger();
  const t0 = Date.now() - 50 * MIN;
  await push({ ...mk(t0, t0), updatedAt: Date.now() });
  const again = await push({ tabs: mk(t0, t0 + 5 * MIN).tabs, updatedAt: Date.now() });
  assert.equal(again.rows, 0, 'time stamp alone: nothing written');
  const closed = mk(t0, t0 + 6 * MIN).tabs.map((t, i) => (i === 1 ? { ...t, status: 'CLOSED', closedAt: new Date(t0 + MIN).toISOString() } : t));
  const r = await push({ tabs: closed, updatedAt: Date.now() });
  assert.ok(r.rows >= 1);
  assert.equal(db._db.prepare("SELECT status FROM ledger_bills WHERE bill_id = 'B1'").get().status, 'CLOSED');
  assert.equal(db._db.prepare("SELECT status FROM ledger_bills WHERE bill_id = 'B2'").get().status, 'OPEN');
  const priced = mk(t0, t0 + 7 * MIN).tabs.map((t, i) => (i === 2 ? { ...t, orders: [{ entries: [{ price: 100, qty: 5 }] }] } : t));
  await push({ tabs: priced, updatedAt: Date.now() });
  assert.equal(db._db.prepare("SELECT total FROM ledger_bills WHERE bill_id = 'B2'").get().total, 500);
});

test('sale lines: a changed line is written, an identical one is not (header version bump from a drifted till)', async () => {
  const { push, db } = await ledger();
  const t0 = Date.now() - 50 * MIN;
  await push({ salesLog: mk(t0, t0).salesLog, updatedAt: Date.now() });
  const lines = () => db._db.prepare("SELECT qty, price FROM ledger_sale_items WHERE sale_id = 's0' ORDER BY line_no").all().map((x) => `${x.qty}x${x.price}`).join(',');
  assert.equal(lines(), '1x100,2x100');
  const edited = mk(t0, t0 + 3 * MIN).salesLog.map((s, i) => (i === 0 ? { ...s, items: [{ code: 'A', name: 'A', qty: 1, price: 100 }, { code: 'B', name: 'B', qty: 3, price: 100 }], total: 400 } : s));
  await push({ salesLog: edited, updatedAt: Date.now() });
  assert.equal(lines(), '1x100,3x100', 'the real line edit reached the table');
});

test('repeat-send memory: a stamp-only difference is a repeat, a content difference is not', async () => {
  const { push } = await ledger({ LEDGER_SEEN_MS: '300000' });
  const t0 = Date.now() - 50 * MIN;
  await push({ tabs: mk(t0, t0).tabs, updatedAt: Date.now() });
  const same = await push({ tabs: mk(t0, t0 + 9 * MIN).tabs, updatedAt: Date.now() });
  assert.equal(same.rows, 0);
  const changed = await push({ tabs: mk(t0, t0 + 9 * MIN).tabs.map((t, i) => (i === 0 ? { ...t, label: 'Moved' } : t)), updatedAt: Date.now() });
  assert.ok(changed.rows >= 1, 'a real change inside the memory window is still written');
});

test('LEDGER_STAMP_GUARD=0 restores the previous behaviour on the new paths too', async () => {
  const { push } = await ledger({ LEDGER_STAMP_GUARD: '0' });
  const t0 = Date.now() - 50 * MIN;
  await push({ tabs: mk(t0, t0).tabs, updatedAt: Date.now() });
  const again = await push({ tabs: mk(t0, t0 + 5 * MIN).tabs, updatedAt: Date.now() });
  assert.ok(again.rows >= 6, 'guard off: tabs rewritten as before');
});

test('edit back to the original after a stale copy is still written (the saving never swallows a real change)', async () => {
  const { push, db } = await ledger({ LEDGER_SEEN_MS: '300000' });
  const t0 = Date.now() - 50 * MIN;
  const tab = (stamp, extra = {}) => ({ ...mk(t0, stamp).tabs[0], ...extra });
  const status = () => db._db.prepare("SELECT status FROM ledger_bills WHERE bill_id = 'B0'").get().status;
  await push({ tabs: [tab(1000)], updatedAt: Date.now() });
  await push({ tabs: [tab(2000, { status: 'CLOSED' })], updatedAt: Date.now() });
  assert.equal(status(), 'CLOSED');
  await push({ tabs: [tab(1000)], updatedAt: Date.now() });            // an old copy arrives late: ignored
  assert.equal(status(), 'CLOSED');
  await push({ tabs: [tab(3000)], updatedAt: Date.now() });            // reopened with the original content and a newer stamp
  assert.equal(status(), 'OPEN');
});
