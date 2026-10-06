import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeD1 } from './d1-fake.mjs';
import { ensureCashSchema, handleCash, CashError } from '../functions/api/_cash.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function rig() { const db = makeD1(); await ensureCashSchema(db); return db; }
const call = (db, c, body) => handleCash({ db, c, body });
const fails = async (p, code) => { try { await p; assert.fail('expected ' + code); } catch (e) { assert.ok(e instanceof CashError, String(e)); assert.equal(e.code, code); return e; } };
const reg = { site: '', device: 'dev_abc123' };

test('K1: open with a counted float; the opener, time, device and float are recorded', async () => {
  const db = await rig();
  assert.equal((await call(db, 'A', { action: 'status', ...reg })).session, null);
  const r = await call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_000001', openingFloat: 5000, by: 'John', byId: 's1', deviceName: 'Till 1' });
  assert.equal(r.session.status, 'open'); assert.equal(r.session.openingFloat, 5000); assert.equal(r.session.openedBy, 'John'); assert.equal(r.session.deviceName, 'Till 1');
  const st = await call(db, 'A', { action: 'status', ...reg });
  assert.equal(st.session.id, 'sess_000001', 'another employee on the same device sees the SAME session (no second float)');
});

test('K2: one open session per register — a second open is refused and hands back the running one; a resend is harmless', async () => {
  const db = await rig();
  await call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_000001', openingFloat: 5000, by: 'John' });
  const e = await fails(call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_000002', openingFloat: 100, by: 'Mary' }), 'already_open');
  assert.equal(e.extra.session.id, 'sess_000001'); assert.equal(e.extra.session.openingFloat, 5000);
  const again = await call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_000001', openingFloat: 5000, by: 'John' });
  assert.equal(again.replay, true);
  const n = await db.prepare('SELECT COUNT(*) n FROM cash_sessions').first(); assert.equal(n.n, 1);
});

test('K3: bad floats are refused (negative, text, empty)', async () => {
  const db = await rig();
  for (const v of [-1, 'abc', '', null, undefined]) await fails(call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_00000' + String(v).length, openingFloat: v, by: 'J' }), 'bad_amount');
  assert.equal((await call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_zero00', openingFloat: 0, by: 'J' })).session.openingFloat, 0, 'zero float is allowed');
});

test('K4: close = expected from float + cash sales + cash in - refunds - expenses; difference is counted - expected', async () => {
  const db = await rig();
  await call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_000001', openingFloat: 5000, by: 'John' });
  await call(db, 'A', { action: 'move', sessionId: 'sess_000001', moveId: 'mv_000001', kind: 'payout', amount: 150, note: 'tea', by: 'Mary' });
  await call(db, 'A', { action: 'move', sessionId: 'sess_000001', moveId: 'mv_000002', kind: 'refund', amount: 500, by: 'Mary' });
  await call(db, 'A', { action: 'move', sessionId: 'sess_000001', moveId: 'mv_000003', kind: 'cash_in', amount: 1000, by: 'Mary' });
  const dup = await call(db, 'A', { action: 'move', sessionId: 'sess_000001', moveId: 'mv_000003', kind: 'cash_in', amount: 1000, by: 'Mary' });
  assert.equal(dup.session.moves.length, 3, 'a resent movement is not counted twice');
  const r = await call(db, 'A', { action: 'close', sessionId: 'sess_000001', counted: 25350, by: 'Boss', snapshot: { cashSales: 20000, nonCashSales: 7000, salesCount: 12, refunds: 0, expenses: 0 } });
  // 5000 + 20000 + 1000 - 500 - 150 = 25350
  assert.equal(r.session.expected, 25350); assert.equal(r.session.difference, 0); assert.equal(r.session.status, 'closed'); assert.equal(r.session.closedBy, 'Boss');
  assert.equal(r.session.refunds, 500); assert.equal(r.session.expenses, 150); assert.equal(r.session.nonCashSales, 7000);
});

test('K5: short and over are signed correctly; the spec example (5,000 + 20,000 - 500 - 150 = 24,350)', async () => {
  const db = await rig();
  await call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_000001', openingFloat: 5000, by: 'John' });
  const r = await call(db, 'A', { action: 'close', sessionId: 'sess_000001', counted: 24150, by: 'Boss', snapshot: { cashSales: 20000, refunds: 500, expenses: 150 } });
  assert.equal(r.session.expected, 24350); assert.equal(r.session.difference, -200, 'short 200');
  await call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_000002', openingFloat: 100, by: 'J' });
  const o = await call(db, 'A', { action: 'close', sessionId: 'sess_000002', counted: 400, by: 'Boss', snapshot: { cashSales: 200 } });
  assert.equal(o.session.difference, 100, 'over 100');
});

test('K6: a closed session is final — no more movements, no second close, the numbers cannot be changed, not even by SQL', async () => {
  const db = await rig();
  await call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_000001', openingFloat: 5000, by: 'John' });
  const c1 = await call(db, 'A', { action: 'close', sessionId: 'sess_000001', counted: 5000, by: 'Boss', snapshot: {} });
  await fails(call(db, 'A', { action: 'move', sessionId: 'sess_000001', moveId: 'mv_000009', kind: 'payout', amount: 10, by: 'x' }), 'closed');
  const c2 = await call(db, 'A', { action: 'close', sessionId: 'sess_000001', counted: 1, by: 'Hacker', snapshot: { cashSales: 99999 } });
  assert.equal(c2.replay, true); assert.equal(c2.session.closedBy, 'Boss'); assert.equal(c2.session.counted, 5000); assert.equal(c2.session.closedAt, c1.session.closedAt);
  await assert.rejects(db.prepare(`UPDATE cash_sessions SET counted_cents = 1 WHERE session_id = 'sess_000001'`).run(), /can not be changed/);
  await assert.rejects(db.prepare(`DELETE FROM cash_sessions`).run(), /kept permanently/);
  await assert.rejects(db.prepare(`DELETE FROM cash_audit`).run(), /append-only/);
});

test('K7: a new session needs a NEW counted float — the previous closing amount is never carried over', async () => {
  const db = await rig();
  await call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_000001', openingFloat: 5000, by: 'John' });
  await call(db, 'A', { action: 'close', sessionId: 'sess_000001', counted: 18000, by: 'Boss', snapshot: { cashSales: 13000 } });
  assert.equal((await call(db, 'A', { action: 'status', ...reg })).session, null, 'after closing there is no active session');
  await fails(call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_000002', by: 'Mary' }), 'bad_amount');   // no float typed = refused
  const n = await call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_000002', openingFloat: 5000, by: 'Mary' });
  assert.equal(n.session.openingFloat, 5000);
});

test('K8: shops (branches) and devices are isolated', async () => {
  const db = await rig();
  await call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_000001', openingFloat: 5000, by: 'John' });
  assert.equal((await call(db, 'B', { action: 'status', ...reg })).session, null, 'another shop sees nothing');
  await call(db, 'B', { action: 'open', ...reg, sessionId: 'sess_000003', openingFloat: 7, by: 'Zed' });   // same device id in another shop: allowed, separate
  await fails(call(db, 'B', { action: 'close', sessionId: 'sess_000001', counted: 1, by: 'Zed' }), 'not_found');
  await fails(call(db, 'B', { action: 'move', sessionId: 'sess_000001', moveId: 'mv_000001', kind: 'payout', amount: 5, by: 'Zed' }), 'not_found');
  await fails(call(db, 'B', { action: 'detail', sessionId: 'sess_000001' }), 'not_found');
  assert.equal((await call(db, 'B', { action: 'history' })).sessions.length, 1);
  const other = await call(db, 'A', { action: 'open', site: '', device: 'dev_second1', sessionId: 'sess_000004', openingFloat: 1, by: 'P' });
  assert.equal(other.session.device, 'dev_second1', 'a second device in the same shop has its own drawer');
  const s2 = await call(db, 'A', { action: 'open', site: 'north', device: 'dev_abc123', sessionId: 'sess_000005', openingFloat: 2, by: 'P' });
  assert.equal(s2.session.site, 'north', 'a different site on the same device id is a different register');
});

test('K9: history and detail carry the audit trail (who opened, moved, closed)', async () => {
  const db = await rig();
  await call(db, 'A', { action: 'open', ...reg, sessionId: 'sess_000001', openingFloat: 5000, by: 'John' });
  await call(db, 'A', { action: 'move', sessionId: 'sess_000001', moveId: 'mv_000001', kind: 'payout', amount: 50, by: 'Mary' });
  await call(db, 'A', { action: 'close', sessionId: 'sess_000001', counted: 4950, by: 'Boss', snapshot: {} });
  const d = await call(db, 'A', { action: 'detail', sessionId: 'sess_000001' });
  assert.deepEqual(d.session.audit.map((a) => a.action + ':' + a.by), ['open:John', 'move:Mary', 'close:Boss']);
  const h = await call(db, 'A', { action: 'history', limit: 5 });
  assert.equal(h.sessions[0].difference, 0);
});

test('K10: migrations/0013_cash_register.sql matches the schema module and applies cleanly twice', async () => {
  const { cashMigrationText } = await import(pathToFileURL(path.join(ROOT, 'tools/gen-migration.mjs')).href);
  const file = fs.readFileSync(path.join(ROOT, 'migrations/0013_cash_register.sql'), 'utf8'); assert.equal(file, cashMigrationText());
  const { DatabaseSync } = await import('node:sqlite'); const d = new DatabaseSync(':memory:'); d.exec(file); d.exec(file);
  assert.ok(d.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'cash_%'").get().n >= 8);
});
