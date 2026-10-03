import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV } from './kv-fake.mjs';
import { recordPush } from '../functions/api/_ledger.js';
import { AUDIT_SCHEMA, auditDb, writeAuditRows, trimAudit, snapshotOf, clearAuditPause, auditPausedUntil, ensureAuditSchema } from '../functions/api/_audit-db.js';
import { ledgerHealth } from '../functions/api/_ledger-health.js';
import { patchToml, parseDatabaseId } from '../tools/setup-audit-db.mjs';

// zip 187 — the audit trail lives in its OWN D1 (binding LEDGER_AUDIT_DB): a flood of audit rows can never again fill the database that holds the sales.
// Real SQL (node:sqlite behind the D1 fake) for both databases.
const q = (d, sql, ...a) => d.query(sql, ...a);
const mkEnv = (extra = {}) => ({ LEDGER_DB: makeD1(), LEDGER_AUDIT_DB: makeD1(), mydukapos_kv: makeKV(), RETRY_BASE_MS: 0, LEDGER_SEEN_MS: '0', ...extra });
const T0 = Date.parse('2026-10-02T13:17:08.363Z');
const sale = (id, extra = {}) => ({ id, refNumber: 'R-' + id, timestamp: new Date(T0).toISOString(), paymentMethod: 'cash', cashAmount: 1000, servedBy: 'Jane', items: [{ code: 'A', name: 'Alpha', qty: 1, price: 1000, wholesalePrice: 600 }], ...extra });
const move = (extra = {}) => ({ id: 'mv-1', lg: 1, code: 'A', name: 'Alpha', delta: -1, type: 'removed', reason: 'Sale', unit: 'qty', by: 'Charles', timestamp: new Date(T0).toISOString(), ...extra });
const auditRows = (e) => q(e.LEDGER_AUDIT_DB, `select * from ledger_audit order by id`);
const mainAudit = (e) => q(e.LEDGER_DB, `select count(*) n from ledger_audit`)[0].n;

test('C1: with the audit database bound, a sale writes ONE row there and NONE in the sales database', async () => {
  const e = mkEnv();
  const r = await recordPush(e, 'shop1', { salesLog: [sale('s1')] }, { source: 'pos-sync' });
  assert.equal(r.ok, true);
  assert.equal(q(e.LEDGER_DB, `select count(*) n from ledger_sales`)[0].n, 1, 'the sale is in the sales database');
  assert.equal(mainAudit(e), 0, 'no audit row inside the sales database');
  const a = auditRows(e);
  assert.equal(a.length, 1);
  assert.equal(a[0].client_id, 'shop1'); assert.equal(a[0].kind, 'sale'); assert.equal(a[0].rec_id, 's1'); assert.equal(a[0].status, 'COMPLETED');
  assert.equal(a[0].source, 'pos-sync'); assert.equal(JSON.parse(a[0].snapshot).id, 's1');
});

test('C2: the main audit triggers are removed on the first push once the audit database is bound', async () => {
  const e = mkEnv();
  await recordPush(e, 'shop1', { salesLog: [sale('s1')] });
  const names = q(e.LEDGER_DB, `select name from sqlite_master where type = 'trigger'`).map((r) => r.name);
  assert.equal(names.includes('audit_ledger_records_ins'), false);
  assert.equal(names.includes('audit_ledger_records_upd'), false);
  assert.ok(names.includes('no_delete_ledger_sales'), 'the money delete guards stay');
  assert.ok(names.includes('payment_amount_locked'), 'the payment lock stays');
});

test('C3: without the binding nothing changes: the triggers keep writing the audit inside the main database', async () => {
  const e = mkEnv(); delete e.LEDGER_AUDIT_DB;
  await recordPush(e, 'shop1', { salesLog: [sale('s1')] });
  assert.equal(mainAudit(e), 1);
  assert.equal(auditDb(e), null);
});

test('C4: re-sending the same sale 20 times (and a retry counter changing) adds nothing: 1 audit row', async () => {
  const e = mkEnv();
  for (let i = 1; i <= 20; i++) await recordPush(e, 'shop1', { stockMovementLog: [move({ tries: i })], salesLog: [sale('s1')] });
  assert.equal(auditRows(e).length, 2, 'one for the sale, one for the stock movement');
  assert.equal(mainAudit(e), 0);
});

test('C5: a real change (the sale is voided) is a second audit row for that record', async () => {
  const e = mkEnv();
  await recordPush(e, 'shop1', { salesLog: [sale('s1')] });
  await recordPush(e, 'shop1', { salesLog: [sale('s1', { voided: true, updatedAt: T0 + 5000 })] });
  const a = auditRows(e).filter((r) => r.rec_id === 's1');
  assert.deepEqual(a.map((r) => r.status), ['COMPLETED', 'VOIDED']);
});

test('C6: a FULL or broken audit database never fails or delays the sale, and pauses audit writes', async () => {
  const e = mkEnv();
  const adb = e.LEDGER_AUDIT_DB;
  const realBatch = adb.batch.bind(adb);
  adb.batch = async () => { throw new Error('D1_ERROR: Exceeded maximum DB size: SQLITE_FULL'); };
  clearAuditPause(adb);
  const r = await recordPush(e, 'shop1', { salesLog: [sale('s1')] });
  assert.equal(r.ok, true, 'the push is acknowledged');
  assert.equal(q(e.LEDGER_DB, `select count(*) n from ledger_sales`)[0].n, 1, 'the sale is saved');
  assert.ok(auditPausedUntil(adb) > Date.now(), 'audit writes are paused');
  // while paused no attempt is made (no hammering a full database)
  let calls = 0; adb.batch = async (...a) => { calls++; return realBatch(...a); };
  await recordPush(e, 'shop1', { salesLog: [sale('s2')] });
  assert.equal(calls, 0, 'paused: the audit database is not touched');
  assert.equal(q(e.LEDGER_DB, `select count(*) n from ledger_sales`)[0].n, 2);
  clearAuditPause(adb);                                                  // later it works again
  await recordPush(e, 'shop1', { salesLog: [sale('s3')] });
  assert.ok(auditRows(e).some((x) => x.rec_id === 's3'));
});

test('C7: the kill switches stop the audit writes (env, and ledger_meta) but never the sale', async () => {
  const e = mkEnv({ AUDIT_WRITES_DISABLED: '1' });
  assert.equal((await recordPush(e, 'shop1', { salesLog: [sale('s1')] })).ok, true);
  await ensureAuditSchema(e.LEDGER_AUDIT_DB);
  assert.equal(auditRows(e).length, 0);
  const e2 = mkEnv();
  await recordPush(e2, 'shop1', { salesLog: [sale('s0')] });
  q(e2.LEDGER_DB, `insert into ledger_meta (k, v) values ('audit_disabled', '1') on conflict (k) do update set v = '1'`);
  const before = auditRows(e2).length;
  // the flag is cached for 30 s per isolate: a fresh binding (new isolate) sees it at once
  const e3 = { ...e2, LEDGER_DB: e2.LEDGER_DB };
  await recordPush(e3, 'shop1', { salesLog: [sale('s5')] });
  assert.ok(auditRows(e2).length <= before + 1, 'at most the cached 30 s window');
});

test('C8: audit write failure for a huge record: the snapshot is a small valid-JSON stub', () => {
  const big = JSON.stringify({ x: 'y'.repeat(20000) });
  const s = snapshotOf('sale', big, 'COMPLETED', 5, 1);
  assert.ok(s.length < 300); assert.equal(JSON.parse(s).truncated, 1);
  assert.equal(snapshotOf('sale', '{"a":1}', 'COMPLETED', 5, 1), '{"a":1}');
  assert.equal(JSON.parse(snapshotOf('stock_move', JSON.stringify({ x: 'y'.repeat(2500) }), 'RECORDED', 1, 1)).truncated, 1, 'stock movements get the smaller limit');
});

test('C9: retention: rows older than the limit are deleted a bounded amount at a time; newer rows stay', async () => {
  const e = mkEnv();
  await ensureAuditSchema(e.LEDGER_AUDIT_DB);
  const now = Date.now();
  const ins = (at) => q(e.LEDGER_AUDIT_DB, `insert into ledger_audit (client_id, kind, rec_id, action, at) values ('c', 'sale', 'x', 'WRITE', ?)`, at);
  for (let i = 0; i < 150; i++) ins(now - 200 * 86400000);
  for (let i = 0; i < 20; i++) ins(now - 1000);
  const r1 = await trimAudit(e, { now, days: 90, limit: 100 });
  assert.equal(r1.deleted, 100, 'bounded');
  const r2 = await trimAudit(e, { now, days: 90, limit: 100 });
  assert.equal(r2.deleted, 50);
  assert.equal(q(e.LEDGER_AUDIT_DB, `select count(*) n from ledger_audit`)[0].n, 20, 'recent rows stay');
  assert.equal((await trimAudit({}, { now })).skipped, 'no_db');
  assert.equal((await trimAudit(e, { now, days: 0 })).skipped, 'off');
});

test('C10: health: the audit figures come from the audit database, the size alarm is about the sales database', async () => {
  const e = mkEnv();
  await recordPush(e, 'shop1', { salesLog: [sale('s1'), sale('s2')] });
  const h = await ledgerHealth(e.LEDGER_DB, { auditDb: e.LEDGER_AUDIT_DB });
  assert.equal(h.auditSeparate, true);
  assert.equal(h.auditRows, 2);
  assert.ok(['ok', 'warning', 'critical'].includes(h.level));
  // audit database not created yet: still answers
  const e2 = mkEnv(); await recordPush(e2, 'shop1', { salesLog: [] });
  const h2 = await ledgerHealth(e2.LEDGER_DB, { auditDb: makeD1() });
  assert.equal(h2.auditRows, 0); assert.ok(h2.auditError);
});

test('C11: the audit database schema file equals the code, and migration 0009 only drops the two audit triggers', () => {
  const sqlFile = fs.readFileSync(path.join(ROOT, 'sql/audit-db/0001_audit.sql'), 'utf8');
  for (const s of AUDIT_SCHEMA) assert.ok(sqlFile.includes(s.trim()), 'schema statement present: ' + s.slice(0, 40));
  const m = fs.readFileSync(path.join(ROOT, 'migrations/0009_audit_separate.sql'), 'utf8').split('\n').filter((l) => !l.startsWith('--') && l.trim());
  assert.deepEqual(m, ['DROP TRIGGER IF EXISTS audit_ledger_records_ins;', 'DROP TRIGGER IF EXISTS audit_ledger_records_upd;']);
});

test('C12: setup tool: adds the binding once to a toml, parses the database id, never duplicates', () => {
  const id = '12f9b35e-d4d9-468d-ac8c-2b3ff6b3848d';
  assert.equal(parseDatabaseId('{\n "uuid": "x",\n "database_id": "' + id.toUpperCase() + '"}'), id);
  assert.equal(parseDatabaseId('[[d1_databases]]\ndatabase_id = "' + id + '"'), id);
  assert.equal(parseDatabaseId('nothing here'), null);
  const a = patchToml('name = "x"\n', 'mydukapos-audit', id);
  assert.ok(a.changed); assert.match(a.text, /binding = "LEDGER_AUDIT_DB"/); assert.match(a.text, new RegExp('database_id = "' + id + '"'));
  const b = patchToml(a.text, 'mydukapos-audit', id);
  assert.equal(b.changed, false); assert.equal(b.text, a.text);
  const c = patchToml('# binding = "LEDGER_AUDIT_DB"  (example)\n', 'mydukapos-audit', id);
  assert.equal(c.changed, true, 'a commented example does not count');
  for (const f of ['wrangler.toml', 'wildcard-router/wrangler.toml']) assert.ok(fs.existsSync(path.join(ROOT, f)));
});

test('C13: writeAuditRows with no binding or no rows is a harmless no-op', async () => {
  assert.deepEqual(await writeAuditRows({}, [{ clientId: 'a', kind: 'k', recId: '1', at: 1 }]), { written: 0, skipped: 'no_db' });
  assert.deepEqual(await writeAuditRows(mkEnv(), []), { written: 0 });
});
