import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { recordPush, ensureLedgerSchema, stripVolatile, clearRecRate } from '../functions/api/_ledger.js';
import { audit0007MigrationText } from '../tools/gen-migration.mjs';
import { LEDGER_SCHEMA_VERSION } from '../functions/api/_ledger-schema.js';
import { isStorageFull } from '../functions/api/_retry.js';

// zip 186 — INCIDENT: a sync retry storm (the client stamps a growing `tries` counter INTO a pending stock movement, so every resend looked "changed") wrote
// 21.8M ledger_audit rows and filled the 10 GB D1 database. These tests run the REAL SQL (node:sqlite behind the D1 fake): resend idempotency, the quiet audit
// triggers, the delete guard with its prune flag, the kill switch, the per-record rate guard, permanent / storage-full answers, and migration 0007 itself.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const q = (e, sql, ...a) => e.LEDGER_DB.query(sql, ...a);
const mkEnv = (extra = {}) => ({ LEDGER_DB: makeD1(), mydukapos_kv: makeKV(), RETRY_BASE_MS: 0, ...extra });
const T0 = Date.parse('2026-10-02T13:17:08.363Z');
const move = (extra = {}) => ({ id: '1790947028363-b7nq9rpt9k', lg: 1, code: '8991389410365', name: 'Photo Frame A4 MK', delta: -1, type: 'removed', reason: 'Sale', unit: 'qty', by: 'Charles', timestamp: new Date(T0).toISOString(), dev: 'dev_x', till: 1, ...extra });
const audits = (e) => q(e, `select * from ledger_audit where kind = 'stock_move' order by id`);
const sale = (id, extra = {}) => ({ id, refNumber: 'R-' + id, timestamp: new Date(T0).toISOString(), paymentMethod: 'cash', cashAmount: 1000, servedBy: 'Jane', items: [{ code: 'A', name: 'Alpha', qty: 2, price: 500, wholesalePrice: 300 }], ...extra });

test('B1: a stock movement re-sent 50 times with only `tries` changing = exactly 1 audit row, 1 stored record, every response ok', async () => {
  const e = mkEnv({ LEDGER_SEEN_MS: '0' });                              // seen-cache OFF: the database itself must absorb the resends
  const replies = [];
  for (let i = 1; i <= 50; i++) replies.push(await recordPush(e, 'kw8mqf3dkt', { stockMovementLog: [move({ tries: i })] }, { source: 'pos-sync' }));
  assert.ok(replies.every((r) => r.ok === true), 'all responses ok');
  assert.equal(replies[0].duplicate, undefined, 'the first send is a real write');
  assert.ok(replies.slice(1).every((r) => r.duplicate === true && r.unchanged === 1), 'every resend is flagged duplicate');
  assert.equal(audits(e).length, 1, 'ONE audit row');
  assert.equal(q(e, `select count(*) n from ledger_records where kind = 'stock_move'`)[0].n, 1);
  const stored = JSON.parse(q(e, `select data from ledger_records where kind = 'stock_move'`)[0].data);
  assert.equal('tries' in stored, false, 'the volatile counter is not stored');
  assert.equal(JSON.parse(audits(e)[0].snapshot).delta, -1);
});

test('B1: the same with the seen-cache ON (default), and a different tenant with the same id is its own record', async () => {
  const e = mkEnv();
  for (let i = 1; i <= 50; i++) assert.equal((await recordPush(e, 'A', { stockMovementLog: [move({ tries: i })] })).ok, true);
  assert.equal(audits(e).length, 1);
  await recordPush(e, 'B', { stockMovementLog: [move({ tries: 7 })] });
  assert.equal(audits(e).length, 2, 'tenant B has its own record and audit row');
  assert.deepEqual(audits(e).map((r) => r.client_id).sort(), ['A', 'B']);
});

test('B1: a row stored BEFORE the fix (its data still carries tries) is not re-audited by a resend', async () => {
  const e = mkEnv({ LEDGER_SEEN_MS: '0' });
  await ensureLedgerSchema(e.LEDGER_DB);
  const old = { ...move(), tries: 1382 };
  const canon = JSON.stringify(Object.fromEntries(Object.entries(old).sort(([a], [b]) => (a < b ? -1 : 1))));
  q(e, `insert into ledger_records (client_id, kind, rec_id, version, ts, business_date, amount, status, actor, source, data, created_at, updated_at) values ('C', 'stock_move', ?, 5, 5, '2026-10-02', 0, 'RECORDED', 'Charles', 'pos-sync', ?, 1, 1)`, old.id, canon);
  const before = q(e, `select count(*) n from ledger_audit`)[0].n;
  const r = await recordPush(e, 'C', { stockMovementLog: [{ ...move(), updatedAt: undefined, tries: 1390 }] });
  assert.equal(r.ok, true);
  assert.equal(q(e, `select count(*) n from ledger_audit`)[0].n, before, 'no new audit row');
});

test('B1: a REAL change (the quantity) is one UPDATE and one audit row; a second identical send adds nothing', async () => {
  const e = mkEnv({ LEDGER_SEEN_MS: '0' });
  await recordPush(e, 'C', { stockMovementLog: [move({ tries: 1 })] });
  const r2 = await recordPush(e, 'C', { stockMovementLog: [move({ tries: 2, delta: -2, updatedAt: T0 + 1000 })] });
  assert.equal(r2.ok, true); assert.equal(r2.duplicate, undefined);
  const rows = audits(e);
  assert.deepEqual(rows.map((r) => r.action), ['CREATE', 'UPDATE']);
  await recordPush(e, 'C', { stockMovementLog: [move({ tries: 3, delta: -2, updatedAt: T0 + 1000 })] });
  assert.equal(audits(e).length, 2);
});

test('B1: stripVolatile removes only the retry counters, at the top level, and returns the same object when there is nothing to strip', () => {
  const a = { id: 1, tries: 4, retryCount: 2, items: [{ tries: 9 }], till: 3 };
  assert.deepEqual(stripVolatile(a), { id: 1, items: [{ tries: 9 }], till: 3 });
  const b = { id: 1 }; assert.equal(stripVolatile(b), b);
});

test('B1: stock is applied exactly once per movement id however many times it is re-sent (KV shop + D1 ledger through pos-sync)', async () => {
  const sync = await load('functions/api/pos-sync.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), RETRY_BASE_MS: 0 };
  const req = (m, b) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
  const push = async (b) => { const r = await sync.onRequestPost({ request: req('POST', { businessName: 'Biz', updatedAt: Date.now(), ...b }), env, waitUntil() {} }); return { status: r.status, body: await r.json() }; };
  const inv = [{ code: '8991389410365', type: 'item', name: 'Photo Frame A4 MK', price: 10, qty: 10, unit: 'pcs', updatedAt: Date.now() }];
  assert.equal((await push({ inventory: inv })).status, 200);
  const outs = [];
  for (let i = 1; i <= 50; i++) outs.push(await push({ inventory: inv, stockMovementLog: [{ ...move({ id: 'mv-once-1' }), tries: i }] }));
  assert.ok(outs.every((o) => o.status === 200 && o.body.ok === true), 'every response is 200 ok');
  assert.ok(outs.slice(1).some((o) => o.body.duplicate === true), 'the duplicate hint is ADDED to the reply');
  const st = await (await sync.onRequestGet({ request: req('GET'), env })).json();
  assert.equal(st.inventory.find((r) => r.code === '8991389410365').qty, 9, 'stock changed ONCE (10 - 1)');
  assert.equal((st.stockMovementLog || []).filter((m) => m.id === 'mv-once-1').length, 1);
  assert.equal(audits(env).length, 1, 'and exactly one audit row');
});

test('B2: the delete guard still blocks deleting ledger_records / ledger_audit / money tables', async () => {
  const e = mkEnv();
  await recordPush(e, 'C', { salesLog: [sale('s1')], stockMovementLog: [move()] });
  e.LEDGER_DB._db.exec(`insert into store_items (group_id, item_id, name, qty, created_at, updated_at) values ('G', 'i1', 'N', 1, 1, 1)`);
  for (const sql of ['delete from ledger_records', 'delete from ledger_audit', 'delete from ledger_sales', 'delete from ledger_payments', 'delete from store_items', 'update ledger_audit set amount = 1'])
    assert.throws(() => e.LEDGER_DB._db.exec(sql), /never deleted|append-only/i, sql);
});

test('B2: flag absent or 0 blocks every audit delete', async () => {
  const e = mkEnv();
  const db = e.LEDGER_DB._db;
  await recordPush(e, 'C', { stockMovementLog: [move()] }, { now: Date.now() - 3600000 });
  assert.throws(() => db.exec('delete from ledger_audit'), /never deleted/, 'flag absent: blocked');
  db.exec(`insert into ledger_meta (k, v) values ('audit_prune_open', '0') on conflict (k) do update set v = '0'`);
  assert.throws(() => db.exec('delete from ledger_audit'), /never deleted/, 'flag 0: blocked');
});

test('B2: flag open: old audit rows are deletable, a row newer than 10 minutes is refused, nothing else is deletable', async () => {
  const e = mkEnv();
  const db = e.LEDGER_DB._db;
  await recordPush(e, 'C', { stockMovementLog: [move()], salesLog: [sale('s1')] }, { now: Date.now() - 3600000 });
  await recordPush(e, 'C', { stockMovementLog: [move({ id: 'fresh-1' })] });
  db.exec(`insert into store_movements (group_id, movement_id, kind, at) values ('G', 'm1', 'ADD', 1)`);
  db.exec(`insert into ledger_meta (k, v) values ('audit_prune_open', '1') on conflict (k) do update set v = '1'`);
  db.exec(`delete from ledger_audit where rec_id = '${move().id}'`);
  assert.equal(q(e, `select count(*) n from ledger_audit where rec_id = '${move().id}'`)[0].n, 0, 'the hour-old row is gone');
  assert.throws(() => db.exec(`delete from ledger_audit where rec_id = 'fresh-1'`), /never deleted/, 'a fresh row is protected even with the flag open');
  for (const sql of ['delete from ledger_records', 'delete from ledger_sales', 'delete from ledger_payments', 'delete from store_movements']) assert.throws(() => db.exec(sql), /never deleted/, sql + ' (flag open)');
  assert.throws(() => db.exec(`update ledger_audit set amount = 5`), /append-only/, 'still append-only');
  db.exec(`update ledger_meta set v = '0' where k = 'audit_prune_open'`);
  assert.throws(() => db.exec(`delete from ledger_audit where rec_id = 'fresh-1'`), /never deleted/);
});

test('B5: kill switch: with ledger_meta audit_disabled=1 records are saved but no audit rows are written; the env var mirrors itself in', async () => {
  const e = mkEnv({ LEDGER_SEEN_MS: '0' });
  await ensureLedgerSchema(e.LEDGER_DB);
  q(e, `insert into ledger_meta (k, v) values ('audit_disabled', '1') on conflict (k) do update set v = '1'`);
  const r = await recordPush(e, 'C', { salesLog: [sale('k1')], stockMovementLog: [move()] });
  assert.equal(r.ok, true);
  assert.equal(q(e, 'select count(*) n from ledger_sales')[0].n, 1, 'the sale is saved');
  assert.equal(q(e, 'select count(*) n from ledger_records')[0].n, 2, 'the records are saved');
  assert.equal(q(e, 'select count(*) n from ledger_audit')[0].n, 0, 'no audit rows');
  q(e, `update ledger_meta set v = '0' where k = 'audit_disabled'`);
  await recordPush(e, 'C', { stockMovementLog: [move({ id: 'after-1' })] });
  assert.equal(q(e, 'select count(*) n from ledger_audit')[0].n, 1, 'switch off: auditing resumes');
  // env var AUDIT_WRITES_DISABLED mirrors into the table (one way: only ON)
  const e2 = mkEnv({ AUDIT_WRITES_DISABLED: '1' });
  await recordPush(e2, 'C', { stockMovementLog: [move({ id: 'env-1' })] });
  assert.equal(q(e2, `select v from ledger_meta where k = 'audit_disabled'`)[0].v, '1');
  assert.equal(q(e2, 'select count(*) n from ledger_audit')[0].n, 0);
  assert.equal(q(e2, 'select count(*) n from ledger_records')[0].n, 1);
});

test('B3: audit snapshots stay small: a normal record keeps its full snapshot, an oversize one gets a small valid-JSON stub', async () => {
  const e = mkEnv();
  await recordPush(e, 'C', { stockMovementLog: [move()], expenses: [{ id: 'x1', amount: 50, note: 'y'.repeat(20000), timestamp: new Date(T0).toISOString() }] });
  const small = q(e, `select snapshot from ledger_audit where kind = 'stock_move'`)[0].snapshot;
  assert.equal(JSON.parse(small).code, '8991389410365');
  const big = q(e, `select snapshot from ledger_audit where kind = 'expense'`)[0].snapshot;
  assert.ok(big.length < 300, 'stub, not 20 KB: ' + big.length);
  assert.deepEqual([JSON.parse(big).truncated, JSON.parse(big).kind, JSON.parse(big).amount], [1, 'expense', 50]);
  assert.ok(JSON.parse(big).len > 20000);
});

test('B4: a record that really CHANGES more than the per-minute limit is refused (429 record_rate); no-op resends never count', async () => {
  const e = mkEnv({ AUDIT_REC_RATE_PER_MIN: '5', LEDGER_SEEN_MS: '0' });
  for (let i = 0; i < 40; i++) assert.equal((await recordPush(e, 'R', { stockMovementLog: [move({ id: 'same', tries: i })] })).ok, true, 'no-op resends are never limited');
  clearRecRate(e.LEDGER_DB);
  let refused = null;
  const ok = [];
  for (let i = 1; i <= 12; i++) {
    const r = await recordPush(e, 'R', { stockMovementLog: [move({ id: 'flap', delta: -i, updatedAt: T0 + i })] });
    if (r.ok) ok.push(i); else { refused = r; break; }
  }
  assert.deepEqual(ok, [1, 2, 3, 4, 5], 'five changing writes pass');
  assert.equal(refused.code, 'record_rate'); assert.equal(refused.status, 429); assert.ok(refused.retryAfter >= 1 && refused.retryAfter <= 60);
  // another record, another tenant: unaffected
  assert.equal((await recordPush(e, 'R', { stockMovementLog: [move({ id: 'other' })] })).ok, true);
  assert.equal((await recordPush(e, 'S', { stockMovementLog: [move({ id: 'flap', delta: -9, updatedAt: T0 + 99 })] })).ok, true);
  // inside a bigger push the flapping record is left out and reported, the rest is written
  const mixed = await recordPush(e, 'R', { stockMovementLog: [move({ id: 'flap', delta: -50, updatedAt: T0 + 500 })], expenses: [{ id: 'e9', amount: 10, timestamp: new Date(T0).toISOString() }] });
  assert.equal(mixed.ok, true); assert.equal(mixed.rateLimited.length, 1);
  assert.equal(q(e, `select count(*) n from ledger_records where client_id = 'R' and rec_id = 'e9'`)[0].n, 1);
  clearRecRate(e.LEDGER_DB);
});

test('B4: an item that can never be stored is a terminal 422 {permanent:true}; next to good items it is only reported', async () => {
  const e = mkEnv();
  const bad = { id: 'z'.repeat(300), amount: 5, timestamp: new Date(T0).toISOString() };
  const r = await recordPush(e, 'C', { expenses: [bad] });
  assert.deepEqual([r.ok, r.permanent, r.status, r.code], [false, true, 422, 'bad_record']);
  const r2 = await recordPush(e, 'C', { expenses: [bad, { id: 'good', amount: 5, timestamp: new Date(T0).toISOString() }] });
  assert.equal(r2.ok, true); assert.equal(r2.rejected.length, 1);
  assert.equal(q(e, `select count(*) n from ledger_records where rec_id = 'good'`)[0].n, 1);
  const sync = await load('functions/api/pos-sync.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  const res = await sync.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ businessName: 'B', updatedAt: Date.now(), expenses: [bad] }), headers: { 'content-type': 'application/json' } }), env: { mydukapos_kv: kv, LEDGER_DB: makeD1() }, waitUntil() {} });
  assert.equal(res.status, 422); const j = await res.json(); assert.deepEqual([j.ok, j.permanent], [false, true]);
});

test('B6: a full database (SQLITE 7500) answers 507 {ok:false, code:storage_full, retryAfter:300}, is never retried, and the sale stays on the till', async () => {
  assert.equal(isStorageFull(new Error('D1_ERROR: Exceeded maximum DB size [7500]: SQLITE_FULL')), true);
  assert.equal(isStorageFull(new Error('UNIQUE constraint failed: x 7500')), false);
  const sync = await load('functions/api/pos-sync.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  const d1 = makeD1();
  await ensureLedgerSchema(d1);
  let calls = 0;
  const realBatch = d1.batch.bind(d1);
  d1.batch = async (st) => { calls++; throw new Error('D1_ERROR: Exceeded maximum DB size [7500]'); };
  const res = await sync.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ businessName: 'B', updatedAt: Date.now(), salesLog: [sale('f1')] }), headers: { 'content-type': 'application/json' } }), env: { mydukapos_kv: kv, LEDGER_DB: d1, RETRY_BASE_MS: 0 }, waitUntil() {} });
  assert.equal(res.status, 507); assert.equal(res.headers.get('Retry-After'), '300');
  const j = await res.json(); assert.deepEqual([j.ok, j.code, j.retryAfter], [false, 'storage_full', 300]);
  assert.equal(calls, 1, 'tried once, not retried');
  d1.batch = realBatch;
});

test('B2/H: migration 0007 equals the generator, executes cleanly on top of 0001 (+0003, 0006), is re-runnable, and the bootstrap then skips the old noisy triggers', async () => {
  const file = fs.readFileSync(path.join(ROOT, 'migrations/0007_audit_idempotency.sql'), 'utf8');
  assert.equal(file, audit0007MigrationText(), 'migrations/0007 is exactly what the code generates');
  const e = mkEnv();
  const db = e.LEDGER_DB._db;
  for (const f of ['0001_ledger.sql', '0003_efficiency.sql', '0006_mpesa_claims.sql']) db.exec(fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8'));
  const trig = () => Object.fromEntries(q(e, `select name, sql from sqlite_master where type = 'trigger' and tbl_name in ('ledger_audit', 'ledger_records')`).map((r) => [r.name, r.sql]));
  assert.ok(!/audit_prune_open/.test(trig().no_delete_ledger_audit), '0001 alone: the old guard');
  db.exec(file); db.exec(file);                                         // twice: re-runnable
  const t = trig();
  assert.ok(/audit_prune_open/.test(t.no_delete_ledger_audit) && /financial records are never deleted/.test(t.no_delete_ledger_audit));
  assert.ok(/audit_disabled/.test(t.audit_ledger_records_ins) && /audit_disabled/.test(t.audit_ledger_records_upd));
  assert.ok(t.no_update_ledger_audit, 'append-only update guard kept');
  assert.equal(q(e, `select v from ledger_meta where k = 'schema'`)[0].v, String(LEDGER_SCHEMA_VERSION));
  assert.equal(q(e, `select count(*) n from sqlite_master where type = 'index' and tbl_name = 'ledger_audit' and sql like '%UNIQUE%'`)[0].n, 0, 'no unique index on ledger_audit');
  // the runtime bootstrap does not touch it any more, and a full push still works end to end
  await recordPush(e, 'C', { stockMovementLog: [move({ tries: 1 }), move({ tries: 2 })] });
  assert.equal(q(e, 'select count(*) n from ledger_audit')[0].n, 1);
  assert.equal(trig().no_delete_ledger_audit, t.no_delete_ledger_audit);
});

test('B2: a database still on schema 2 (old triggers, no 0007) is upgraded by the bootstrap to the same quiet triggers', async () => {
  const e = mkEnv({ LEDGER_SEEN_MS: '0' });
  const db = e.LEDGER_DB._db;
  db.exec(fs.readFileSync(path.join(ROOT, 'migrations/0001_ledger.sql'), 'utf8'));
  db.exec(`insert into ledger_meta (k, v) values ('schema', '2')`);
  await recordPush(e, 'C', { stockMovementLog: [move({ tries: 1 })] });
  await recordPush(e, 'C', { stockMovementLog: [move({ tries: 2 })] });
  assert.equal(q(e, 'select count(*) n from ledger_audit')[0].n, 1);
  assert.match(q(e, `select sql from sqlite_master where name = 'no_delete_ledger_audit'`)[0].sql, /audit_prune_open/);
});

// ---- D: health reading, endpoint protection, watchdog ----
import { ledgerHealth, classify, saveAlert, readAlert } from '../functions/api/_ledger-health.js';
import { ledgerSizeWatchdog } from '../wildcard-router/worker.js';
test('D: ledgerHealth is cheap and correct: rows from the id range, rate from one probe, top records over the newest ids, flags; no full scan', async () => {
  const e = mkEnv({ LEDGER_SEEN_MS: '0' });
  const db = e.LEDGER_DB;
  await ensureLedgerSchema(db);
  const now = Date.now();
  const ins = db._db.prepare(`INSERT INTO ledger_audit (client_id, kind, rec_id, action, version, at, snapshot) VALUES (?, 'stock_move', ?, 'UPDATE', 1, ?, '{}')`);
  for (let i = 0; i < 300; i++) ins.run(i % 3 ? 'A' : 'B', i % 5 ? 'hot' : 'cool' + i, now - (300 - i) * 1000);
  const h = await ledgerHealth(db, { now, sample: 100 });
  assert.equal(h.auditRows, 300); assert.equal(h.auditMaxId, 300);
  assert.ok(h.ratePerMin >= 55 && h.ratePerMin <= 65, 'about 60 rows/min: ' + h.ratePerMin);
  assert.equal(h.topRecords[0].rec_id, 'hot'); assert.ok(h.topRecords.length <= 5);
  assert.equal(h.level, 'ok'); assert.equal(h.flags.schema, String(LEDGER_SCHEMA_VERSION));
  assert.ok(h.ms < 500);
  q(e, `insert into ledger_meta (k, v) values ('audit_disabled', '1') on conflict (k) do update set v = '1'`);
  const h2 = await ledgerHealth(db, { now });
  assert.equal(h2.auditDisabled, true); assert.equal(h2.level, 'warning');
  assert.equal(classify({ pctOfCap: 61 }).level, 'warning'); assert.equal(classify({ pctOfCap: 85 }).level, 'critical');
  assert.equal(classify({ pctOfCap: 10, ratePerMin: 9000 }).level, 'warning');
  await saveAlert(db, h2); assert.equal((await readAlert(db)).level, 'warning');
  const issued = []; for (const s of ['SELECT MIN(id)', 'SELECT MAX(id)']) issued.push(s);
  const empty = await ledgerHealth(mkEnv().LEDGER_DB, { now }).catch((x) => x);
  assert.ok(empty instanceof Error, 'a database without the tables fails loudly instead of reporting health');
});

test('D: GET/POST /api/ledger-health need the owner session; the watchdog is inert without a LEDGER_DB and writes ledger_meta size_alert with one', async () => {
  const mod = await load('functions/api/ledger-health.js');
  const env = { mydukapos_kv: makeKV(), LEDGER_DB: makeD1() };
  const get = await mod.onRequestGet({ request: new Request('https://x/api/ledger-health'), env });
  assert.equal(get.status, 401);
  const post = await mod.onRequestPost({ request: new Request('https://x/api/ledger-health', { method: 'POST', body: JSON.stringify({ audit: 'off' }) }), env });
  assert.equal(post.status, 401);
  assert.equal(q(env, `select count(*) n from sqlite_master where name = 'ledger_meta'`)[0].n, 0, 'an unauthorised call touched nothing');
  assert.deepEqual(await ledgerSizeWatchdog({}), { skipped: 'no_db' });
  const e = mkEnv(); await ensureLedgerSchema(e.LEDGER_DB);
  const r = await ledgerSizeWatchdog(e);
  assert.equal(r.level, 'ok'); assert.ok(JSON.parse(q(e, `select v from ledger_meta where k = 'size_alert'`)[0].v).at);
  assert.ok(await e.mydukapos_kv.get('ledger:size-alert'));
  // a full database cannot take the alert row: the watchdog still returns, never throws
  const full = mkEnv(); await ensureLedgerSchema(full.LEDGER_DB);
  const realPrep = full.LEDGER_DB.prepare;
  full.LEDGER_DB.prepare = (s) => { if (/INSERT INTO ledger_meta/.test(s)) throw new Error('D1_ERROR: Exceeded maximum DB size [7500]'); return realPrep(s); };
  assert.equal((await ledgerSizeWatchdog(full)).level, 'ok');
});

test('D/B5: with an owner session GET returns the reading and POST flips the audit kill switch (and the triggers obey it)', async () => {
  const mod = await load('functions/api/ledger-health.js');
  const kv = makeKV(); await kv.put('owner-session:tok123', '1');
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1() };
  await ensureLedgerSchema(env.LEDGER_DB);
  await recordPush(env, 'C', { stockMovementLog: [move()] });
  const hdr = { Authorization: 'Bearer tok123' };
  const g = await mod.onRequestGet({ request: new Request('https://x/api/ledger-health', { headers: hdr }), env });
  assert.equal(g.status, 200); const gj = await g.json();
  assert.equal(gj.ok, true); assert.equal(gj.auditRows, 1); assert.ok(Array.isArray(gj.topRecords));
  const off = await mod.onRequestPost({ request: new Request('https://x/api/ledger-health', { method: 'POST', headers: hdr, body: JSON.stringify({ audit: 'off' }) }), env });
  assert.equal((await off.json()).audit, 'off');
  await recordPush(env, 'C', { stockMovementLog: [move({ id: 'while-off' })] });
  assert.equal(audits(env).length, 1, 'no audit row while off');
  assert.equal(q(env, `select count(*) n from ledger_records where rec_id = 'while-off'`)[0].n, 1, 'but the record is saved');
  const bad = await mod.onRequestPost({ request: new Request('https://x/api/ledger-health', { method: 'POST', headers: hdr, body: JSON.stringify({ audit: 'maybe' }) }), env });
  assert.equal(bad.status, 400);
  await mod.onRequestPost({ request: new Request('https://x/api/ledger-health', { method: 'POST', headers: hdr, body: JSON.stringify({ audit: 'on' }) }), env });
  await recordPush(env, 'C', { stockMovementLog: [move({ id: 'after-on' })] });
  assert.equal(audits(env).length, 2);
});
