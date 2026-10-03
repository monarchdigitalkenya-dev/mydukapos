import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from './helpers.mjs';
import {
  parseArgs, chunkRanges, sql, sqlLit, guardIsSafePath, parseWranglerJson, isStorageFull, isTimeout, quoteArg, runPrune, dryRun, measure, checkBackup, guardFileText, GUARD_FILE,
} from '../tools/prune-audit.mjs';

// zip 186 — tools/prune-audit.mjs: the pure parts (arguments, chunking, SQL text) AND the whole prune flow against a REAL sqlite database that has the real migrations
// (0001 with its delete-guard trigger; 0007 for the "safe" path), driven through the same executor interface the wrangler-backed one implements.
process.removeAllListeners('warning'); process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });
const mig = (f) => fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8');

test('parseArgs: modes, numbers, defaults and mistakes', () => {
  const o = parseArgs(['--run', '--chunk', '50000', '--from-id=123', '--yes', '--global-dups', '--strategy', 'dups']);
  assert.deepEqual([o.mode, o.chunk, o.fromId, o.yes, o.globalDups, o.strategy, o.remote, o.db, o.minAgeMin, o.errors.length], ['run', 50000, 123, true, true, 'dups', true, 'mydukapos-ledger', 10, 0]);
  assert.equal(parseArgs(['--measure', '--local']).remote, false);
  assert.ok(parseArgs([]).errors.some((e) => /choose one of/.test(e)));
  assert.ok(parseArgs(['--run', '--dry-run']).errors.some((e) => /ONE of/.test(e)));
  assert.ok(parseArgs(['--run', '--chunk', 'abc']).errors.length);
  assert.ok(parseArgs(['--run', '--chunk', '10']).errors.length, 'chunk below 1000 refused');
  assert.ok(parseArgs(['--run', '--min-age-min', '3']).errors.length, 'the 10-minute floor cannot be lowered');
  assert.ok(parseArgs(['--run', '--from-id', '9', '--to-id', '3']).errors.length);
  assert.ok(parseArgs(['--run', '--db', 'x; drop']).errors.length, 'database name is validated');
  assert.ok(parseArgs(['--run', '--nope']).errors.length);
  assert.ok(parseArgs(['--run', '--strategy', 'all']).errors.length);
});

test('chunkRanges: inclusive, contiguous, resumable, covers exactly from..to', () => {
  assert.deepEqual(chunkRanges(1, 10, 4), [[1, 4], [5, 8], [9, 10]]);
  assert.deepEqual(chunkRanges(5, 5, 100000), [[5, 5]]);
  assert.deepEqual(chunkRanges(10, 5, 4), []);
  const r = chunkRanges(1, 21830116, 100000);
  assert.equal(r.length, 219); assert.deepEqual(r[0], [1, 100000]); assert.deepEqual(r[218], [21800001, 21830116]);
  for (let i = 1; i < r.length; i++) assert.equal(r[i][0], r[i - 1][1] + 1);
  assert.deepEqual(chunkRanges(21000001, 21830116, 100000)[0], [21000001, 21100000], 'resume from an id');
});

test('generated SQL: id-ranged, 10-minute floor, cmd.exe-safe characters, escaped literals', () => {
  const cut = 1790000000000;
  for (const strat of ['dups', 'retries', 'both']) {
    const d = sql.del(1, 100000, cut, strat);
    assert.match(d, /^DELETE FROM ledger_audit WHERE id BETWEEN 1 AND 100000 AND at < 1790000000000 AND id NOT IN \(SELECT MIN\(id\) FROM ledger_audit WHERE id BETWEEN 1 AND 100000 GROUP BY client_id, kind, rec_id, version, action/);
    if (strat === 'retries') assert.match(d, /> 1$/);
  }
  const all = [sql.bounds(), sql.topGroups(1, 9), sql.retryShare(1, 9), sql.dupShare(1, 9, cut), sql.count(1, 9, cut, 'both'), sql.del(1, 9, cut, 'both'), sql.hotGroups(1, 9), sql.guardSql(), sql.allTriggers(),
    sql.dropGuard(), sql.openFlag(), sql.closeFlag(), sql.readFlag(), sql.delGroup({ client_id: "o'x", kind: 'stock_move', rec_id: 'r1', version: 5, action: 'UPDATE' }, cut)];
  for (const s of all) assert.doesNotMatch(s, /["%^&|\r\n]/, 'safe inside cmd.exe "...": ' + s.slice(0, 60));
  assert.equal(sqlLit("a'b"), "'a''b'"); assert.equal(sqlLit(null), 'NULL'); assert.equal(sqlLit(7), '7');
  assert.throws(() => sql.del('1; DROP TABLE x', 2, cut, 'both'), /not a number/);
  assert.match(sql.delGroup({ client_id: "o'x", kind: 'k', rec_id: 'r', version: 5, action: 'UPDATE' }, cut), /client_id = 'o''x'/);
});

test('helpers: guard detection, wrangler JSON, error classes, quoting', () => {
  assert.equal(guardIsSafePath('CREATE TRIGGER no_delete_ledger_audit BEFORE DELETE ON ledger_audit BEGIN SELECT RAISE(ABORT, \'x\'); END'), false);
  assert.equal(guardIsSafePath("... WHEN COALESCE((SELECT v FROM ledger_meta WHERE k = 'audit_prune_open'), '0') ..."), true);
  const j = parseWranglerJson('\n ⛅️ wrangler\n[{"results":[{"n":3}],"success":true,"meta":{"changes":7,"size_after":123}}]\n');
  assert.deepEqual([j.results[0].n, j.changes, j.meta.size_after], [3, 7, 123]);
  assert.throws(() => parseWranglerJson('[{"error":"boom"}]'), /boom/);
  assert.throws(() => parseWranglerJson('nothing'), /no JSON/);
  assert.equal(isStorageFull(new Error('D1_ERROR: Exceeded maximum DB size [7500]')), true);
  assert.equal(isStorageFull(new Error('syntax error')), false);
  assert.equal(isTimeout(new Error('D1 DB execution timed out')), true);
  assert.equal(quoteArg("DELETE 'x'", true), '"DELETE \'x\'"'); assert.equal(quoteArg('a b', false), 'a b');
});

// ---- the flow, against a real sqlite ----
const NOW = Date.now();
function makeDb({ with0007 }) {
  const db = new DatabaseSync(':memory:');
  db.exec(mig('0001_ledger.sql')); if (with0007) db.exec(mig('0007_audit_idempotency.sql'));
  db.exec(`INSERT INTO ledger_meta (k, v) VALUES ('schema', '${with0007 ? 3 : 2}') ON CONFLICT (k) DO UPDATE SET v = excluded.v`);
  const ins = db.prepare(`INSERT INTO ledger_audit (client_id, kind, rec_id, action, version, amount, status, actor, source, at, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, 'Charles', 'pos-sync', ?, ?)`);
  const snap = (o) => JSON.stringify(o);
  const base = { by: 'Charles', code: '899', delta: -1, type: 'removed' };
  const old = NOW - 3600000;
  // ids 1..60: the SAME record re-sent 60 times (only tries differs) -> 59 removable
  for (let i = 1; i <= 60; i++) ins.run('T1', 'stock_move', 'hot', 'UPDATE', 111, 0, 'RECORDED', old + i, snap({ ...base, tries: i }));
  // ids 61..63: a REAL change history of another record: same version but different content / different version: all three must stay
  ins.run('T1', 'sale', 'S1', 'CREATE', 1, 500, 'COMPLETED', old, snap({ total: 500 }));
  ins.run('T1', 'sale', 'S1', 'UPDATE', 1, 500, 'COMPLETED', old + 1, snap({ total: 500, note: 'edited' }));
  ins.run('T1', 'sale', 'S1', 'UPDATE', 2, 400, 'VOIDED', old + 2, snap({ total: 500, voided: true }));
  // ids 64..66: another tenant, same rec id and content as 'hot' -> its own group, first one stays
  for (let i = 1; i <= 3; i++) ins.run('T2', 'stock_move', 'hot', 'UPDATE', 111, 0, 'RECORDED', old + i, snap({ ...base, tries: i }));
  // ids 67..71: FRESH rows (younger than 10 min) of a duplicated record: never deleted
  for (let i = 1; i <= 5; i++) ins.run('T1', 'stock_move', 'fresh', 'UPDATE', 5, 0, 'RECORDED', NOW - 60000 + i, snap({ ...base, tries: i }));
  return db;
}
const fakeExec = (db, hooks = {}) => ({
  log: [],
  async sql(s) {
    this.log.push(s);
    if (hooks.beforeSql) await hooks.beforeSql(s);
    if (/^\s*(select|with)/i.test(s)) { const rows = db.prepare(s).all(); return { results: rows, meta: {}, changes: 0 }; }
    const r = db.prepare(s).run(); return { results: [], meta: { changes: Number(r.changes) }, changes: Number(r.changes) };
  },
  async file(f) { if (hooks.beforeFile) await hooks.beforeFile(f); db.exec(fs.readFileSync(f, 'utf8')); return { results: [], meta: {}, changes: 0 }; },
});
const tmpBackup = (withFile = true) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')); if (withFile) fs.writeFileSync(path.join(d, 'schema.sql'), '-- x'); return d; };
const opts = (o = {}) => ({ ...parseArgs(['--run']), chunk: 25, yes: true, backupDir: tmpBackup(), ...o });
const sink = () => { const out = []; return { out, io: { log: (...a) => out.push(a.join(' ')), warn: (...a) => out.push(a.join(' ')), confirm: async () => 'YES' } }; };
const count = (db, w = '1=1') => db.prepare(`SELECT COUNT(*) n FROM ledger_audit WHERE ${w}`).get().n;
const guardExists = (db) => db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'no_delete_ledger_audit'`).get();

test('--dry-run counts what --run deletes and changes nothing', async () => {
  const db = makeDb({ with0007: true }); const { out } = sink();
  const d = await dryRun({ ...opts(), chunk: 1000 }, fakeExec(db), (m) => out.push(m));
  assert.equal(count(db), 71); assert.equal(d.would, 59 + 2, 'hot (59) + T2 hot (2); the real history and the fresh rows stay');
});

test('--measure is read-only and reports the busiest records and the removable share', async () => {
  const db = makeDb({ with0007: true }); const { out } = sink();
  const ex = fakeExec(db);
  const m = await measure({ ...opts(), chunk: 1000 }, ex, (x) => out.push(x));
  assert.equal(m.rows, 71); assert.equal(m.dup, 61);
  assert.ok(out.join('\n').includes('hot'));
  assert.ok(ex.log.every((s) => /^\s*SELECT/i.test(s)), 'only SELECTs');
  assert.equal(count(db), 71);
});

test('SAFE path (0007): flag opened and closed, duplicates removed chunk by chunk, history + other tenant + fresh rows kept, guard still blocks afterwards', async () => {
  const db = makeDb({ with0007: true }); const { out, io } = sink();
  const ex = fakeExec(db);
  const r = await runPrune(opts(), ex, io);
  assert.equal(r.path, 'safe'); assert.equal(r.ok, true);
  // chunk size 25 -> the 60-row group spans 3 chunks, each keeps its first row: 3 remain (59 - 57 = 2 removed less)... exactly: chunks 1-25, 26-50, 51-75
  assert.equal(count(db, `client_id = 'T1' AND rec_id = 'hot'`), 3, 'first row of the group in each chunk stays');
  assert.equal(count(db, `rec_id = 'S1'`), 3, 'real change history untouched');
  assert.equal(count(db, `client_id = 'T2'`), 1, 'T2 collapsed to its first row');
  assert.equal(count(db, `rec_id = 'fresh'`), 5, 'rows younger than 10 minutes are never deleted');
  assert.equal(db.prepare(`SELECT v FROM ledger_meta WHERE k = 'audit_prune_open'`).get().v, '0', 'flag closed again');
  assert.throws(() => db.exec('DELETE FROM ledger_audit'), /never deleted/, 'guard back in force');
  assert.ok(!ex.log.some((s) => /DROP TRIGGER/i.test(s)), 'the safe path never drops the trigger');
  assert.ok(out.join('\n').includes('SAFE path'));
});

test('--global-dups collapses a group that spans chunks to ONE row', async () => {
  const db = makeDb({ with0007: true }); const { io } = sink();
  const r = await runPrune({ ...opts(), globalDups: true }, fakeExec(db), io);
  assert.equal(r.ok, true);
  // hotGroups needs >= 50 rows in one chunk: use one big chunk pass for the global step by re-running with the whole range
  const db2 = makeDb({ with0007: true });
  const r2 = await runPrune({ ...opts(), chunk: 1000, globalDups: true }, fakeExec(db2), sink().io);
  assert.equal(r2.ok, true); assert.equal(count(db2, `client_id = 'T1' AND rec_id = 'hot'`), 1);
});

test('EMERGENCY path (no 0007): trigger SQL saved, trigger dropped, pruned, trigger re-created from the saved file and verified', async () => {
  const db = makeDb({ with0007: false }); const { out, io } = sink();
  const original = guardExists(db).sql;
  const o = opts(); const ex = fakeExec(db);
  const r = await runPrune(o, ex, io);
  assert.equal(r.path, 'emergency'); assert.equal(r.ok, true);
  const saved = fs.readFileSync(path.join(o.backupDir, GUARD_FILE), 'utf8');
  assert.match(saved, /CREATE TRIGGER no_delete_ledger_audit/); assert.match(saved, /financial records are never deleted/);
  assert.equal(guardExists(db).sql, original, 'identical trigger SQL after the run');
  assert.throws(() => db.exec('DELETE FROM ledger_audit'), /never deleted/);
  assert.ok(ex.log.some((s) => /DROP TRIGGER/.test(s)));
  assert.ok(out.join('\n').includes('EMERGENCY'));
  assert.ok(count(db) < 71);
});

test('EMERGENCY path: an error in the middle of the prune still re-creates the guard, and tells how to resume', async () => {
  const db = makeDb({ with0007: false }); const { out, io } = sink();
  let deletes = 0;
  const ex = fakeExec(db, { beforeSql: (s) => { if (/^DELETE/.test(s) && ++deletes === 2) throw new Error('network connection lost: boom'); } });
  const r = await runPrune(opts(), ex, io);
  assert.equal(r.ok, false); assert.ok(r.error);
  assert.ok(guardExists(db), 'guard re-created in the finally');
  assert.throws(() => db.exec('DELETE FROM ledger_audit'), /never deleted/);
  assert.match(out.join('\n'), /--from-id 26/);
});

test('EMERGENCY path: a Ctrl+C (stop request) finishes cleanly with the guard restored', async () => {
  const db = makeDb({ with0007: false }); const { out } = sink();
  let stop; let deletes = 0;
  const ex = fakeExec(db, { beforeSql: (s) => { if (/^DELETE/.test(s) && ++deletes === 1) stop(); } });
  const r = await runPrune(opts(), ex, { log: (m) => out.push(m), warn: (m) => out.push(m), onStop: (f) => { stop = f; } });
  assert.equal(r.stop, true); assert.ok(guardExists(db)); assert.equal(deletes, 1, 'stopped after the chunk in flight');
});

test('if the guard cannot be re-created the script says so loudly with the exact command', async () => {
  const db = makeDb({ with0007: false }); const { out, io } = sink();
  const ex = fakeExec(db, { beforeFile: () => { throw new Error('d1 is down'); } });
  const r = await runPrune(opts(), ex, io);
  assert.equal(r.guardStillMissing, true); assert.equal(r.ok, false);
  assert.match(out.join('\n'), /GUARD IS STILL MISSING[\s\S]*wrangler d1 execute mydukapos-ledger --remote --file=/);
});

test('preconditions: typed YES unless --yes; backup folder must exist and hold .sql files; no changes otherwise', async () => {
  let db = makeDb({ with0007: true }); let { io } = sink();
  let ex = fakeExec(db);
  let r = await runPrune({ ...opts(), yes: false }, ex, { ...io, confirm: async () => 'yes' });
  assert.equal(r.reason, 'not_confirmed'); assert.equal(count(db), 71);
  r = await runPrune({ ...opts(), yes: false }, ex, { ...io, confirm: async () => 'YES' });
  assert.equal(r.ok, true);
  db = makeDb({ with0007: true }); ex = fakeExec(db);
  r = await runPrune({ ...opts(), backupDir: path.join(os.tmpdir(), 'no-such-backup-dir-zz') }, ex, io);
  assert.equal(r.reason, 'no_backup'); assert.equal(ex.log.length, 0, 'not even a query was sent'); assert.equal(count(db), 71);
  r = await runPrune({ ...opts(), backupDir: tmpBackup(false) }, ex, io);
  assert.equal(r.reason, 'no_backup');
  assert.equal(checkBackup(tmpBackup()).ok, true);
});

test('SQLITE 7500 stops the run with the Time Travel advice; the flag / guard are still restored when possible', async () => {
  const db = makeDb({ with0007: true }); const { out, io } = sink();
  const ex = fakeExec(db, { beforeSql: (s) => { if (/^DELETE/.test(s)) throw new Error('D1_ERROR: Exceeded maximum DB size [7500]'); } });
  const r = await runPrune(opts(), ex, io);
  assert.equal(r.storageFull, true); assert.equal(r.ok, false);
  assert.match(out.join('\n'), /time-travel restore mydukapos-ledger --bookmark=/);
  assert.match(out.join('\n'), /0000005a-00000274-000050f8-0eab0f524911cea51e06be55e8214cef/);
  assert.equal(db.prepare(`SELECT v FROM ledger_meta WHERE k = 'audit_prune_open'`).get().v, '0');
});

test('resume: --from-id continues after a chunk boundary; strategy "retries" deletes only tries>1 non-first rows', async () => {
  const db = makeDb({ with0007: true });
  const r = await runPrune({ ...opts(), fromId: 26, chunk: 25, strategy: 'dups' }, fakeExec(db), sink().io);
  assert.equal(r.ok, true);
  assert.equal(count(db, `client_id = 'T1' AND rec_id = 'hot' AND id <= 25`), 25, 'ids before --from-id untouched');
  const db2 = makeDb({ with0007: true });
  const r2 = await runPrune({ ...opts(), chunk: 1000, strategy: 'retries' }, fakeExec(db2), sink().io);
  assert.equal(r2.ok, true);
  assert.equal(count(db2, `client_id = 'T1' AND rec_id = 'hot'`), 1);
  assert.equal(count(db2, `rec_id = 'S1'`), 3);
});

test('guardFileText round-trips a trigger SQL into a runnable statement', () => {
  const t = guardFileText([{ name: 'no_delete_ledger_audit', sql: "CREATE TRIGGER no_delete_ledger_audit BEFORE DELETE ON ledger_audit BEGIN SELECT RAISE(ABORT, 'x'); END" }]);
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE ledger_audit (id INTEGER)'); db.exec(t);
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'no_delete_ledger_audit'`).get());
});

// ---- tools/archive-audit.mjs ----
import zlib from 'node:zlib';
import { archive, parseArgs as parseArchiveArgs, selectSql, archiveFileName } from '../tools/archive-audit.mjs';
test('archive-audit: archives exactly what the prune would delete, gzip NDJSON + manifest, read-only, resumable', async () => {
  const db = makeDb({ with0007: true });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arch-')), 'audit');
  const ex = fakeExec(db);
  const r = await archive({ ...parseArchiveArgs([]), chunk: 1000, readSize: 20, out }, ex, { log() {} });
  assert.equal(r.rows, 61); assert.equal(r.files, 1);
  assert.ok(ex.log.every((s) => /^\s*SELECT/i.test(s)), 'only SELECTs');
  const f = path.join(out, archiveFileName(1, 71));
  const lines = zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 61); assert.deepEqual(Object.keys(lines[0]).slice(0, 4), ['id', 'client_id', 'kind', 'rec_id']);
  assert.ok(lines.every((l) => l.rec_id !== 'S1' && l.rec_id !== 'fresh'));
  const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(m.files[archiveFileName(1, 71)].rows, 61); assert.match(m.files[archiveFileName(1, 71)].sha256, /^[0-9a-f]{64}$/);
  const again = await archive({ ...parseArchiveArgs([]), chunk: 1000, readSize: 20, out }, fakeExec(db), { log() {} });
  assert.equal(again.files, 0, 'resumed: already archived');
  assert.equal(count(db), 71, 'nothing deleted');
  const all = await archive({ ...parseArchiveArgs(['--scope', 'all']), chunk: 1000, readSize: 30, out: path.join(out, 'all') }, fakeExec(db), { log() {} });
  assert.equal(all.rows, 66, 'scope all: every row older than 10 minutes');
  assert.ok(parseArchiveArgs(['--chunk', '5']).errors.length);
  assert.doesNotMatch(selectSql(1, 100, 1790000000000, 'dups', 'both', 0, 20000), /["%^&|]/);
});

// ---- the SQL files and the backup script ----
const stripComments = (t) => t.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const statements = (t) => stripComments(t).split(';').map((s) => s.trim()).filter(Boolean);
test('sql/incident/*.sql and tools/stock-reconcile.sql run cleanly against the real schema and never write', () => {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_ledger.sql', '0003_efficiency.sql', '0006_mpesa_claims.sql', '0007_audit_idempotency.sql']) db.exec(mig(f));
  db.exec(`CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)`);
  db.exec(`INSERT INTO ledger_records (client_id, kind, rec_id, version, ts, business_date, amount, status, data, created_at, updated_at) VALUES
    ('kw8mqf3dkt', 'stock_move', 'm1', 1, 1, 'd', 0, 'RECORDED', '{"code":"8991389410365","delta":-1,"reason":"Sale","type":"removed","unit":"qty","timestamp":"t"}', 1, 1)`);
  db.exec(`INSERT INTO store_items (group_id, item_id, code, name, qty, created_at, updated_at) VALUES ('G', 'i1', 'c1', 'N', 5, 1, 1)`);
  db.exec(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, qty, qty_before, qty_after, at) VALUES ('G', 'x1', 'ADD', 'i1', 2, 1, 3, 1)`);
  const before = db.prepare(`SELECT (SELECT COUNT(*) FROM ledger_audit) + (SELECT COUNT(*) FROM store_items) + (SELECT COUNT(*) FROM store_movements) + (SELECT COUNT(*) FROM ledger_records) AS n`).get().n;
  let ran = 0;
  for (const f of ['sql/incident/01_capture_triggers_and_schema.sql', 'sql/incident/02_sample_junk_A2.sql', 'sql/incident/03_distribution_A3.sql', 'sql/incident/04_row_counts.sql', 'sql/incident/05_stock_reconcile.sql', 'tools/stock-reconcile.sql']) {
    const sts = statements(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    assert.ok(sts.length >= 3, f);
    for (const s of sts) { assert.match(s, /^(SELECT|WITH)\b/i, f + ': read-only statement: ' + s.slice(0, 50)); db.prepare(s).all(); ran++; }
  }
  assert.ok(ran > 25);
  assert.equal(db.prepare(`SELECT (SELECT COUNT(*) FROM ledger_audit) + (SELECT COUNT(*) FROM store_items) + (SELECT COUNT(*) FROM store_movements) + (SELECT COUNT(*) FROM ledger_records) AS n`).get().n, before);
  // the warehouse query flags the item whose quantity (5) disagrees with its last movement (3)
  const sec4 = statements(fs.readFileSync(path.join(ROOT, 'tools/stock-reconcile.sql'), 'utf8')).find((s) => /signed_sum/.test(s));
  assert.equal(db.prepare(sec4).all().length, 1);
});

test('the commented correction template is valid SQL once its CAPS values are filled, and is fully commented out in the file', () => {
  const t = fs.readFileSync(path.join(ROOT, 'tools/stock-reconcile.sql'), 'utf8');
  const tpl = t.split('\n').filter((l) => /^--   (INSERT|UPDATE|    SELECT|    FROM)/.test(l) || /^--     (SELECT|FROM)/.test(l)).map((l) => l.replace(/^--\s{1,3}/, '')).join('\n');
  assert.match(tpl, /INSERT INTO store_movements/); assert.match(tpl, /UPDATE store_items/);
  assert.equal(statements(t).filter((s) => /^(INSERT|UPDATE|DELETE|DROP)/i.test(s)).length, 0, 'no executable write in the file');
  const db = new DatabaseSync(':memory:'); db.exec(mig('0001_ledger.sql'));
  db.exec(`INSERT INTO store_items (group_id, item_id, code, name, qty, created_at, updated_at) VALUES ('G', 'I', 'c', 'N', 5, 1, 1)`);
  const filled = tpl.replace(/NEWQTY/g, '3').replace(/GROUP-ITEM/g, 'G-I').replace(/'GROUP'/g, "'G'").replace(/'ITEM'/g, "'I'");
  db.exec(filled);
  assert.equal(db.prepare(`SELECT qty FROM store_items`).get().qty, 3);
  assert.equal(db.prepare(`SELECT qty, qty_before, qty_after FROM store_movements`).get().qty, -2);
});

test('tools/backup-all.cmd lists EVERY table of the migrations except ledger_audit, never exports ledger_audit data, and has CRLF line endings', () => {
  const t = fs.readFileSync(path.join(ROOT, 'tools/backup-all.cmd'), 'utf8');
  assert.ok(t.includes('\r\n') && !/[^\r]\n/.test(t), 'CRLF only (cmd labels need it)');
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_ledger.sql', '0002_crm.sql', '0003_efficiency.sql', '0004_crm_speed.sql', '0006_mpesa_claims.sql']) db.exec(mig(f));
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name);
  for (const name of tables) if (name !== 'ledger_audit') assert.match(t, new RegExp(`\\b${name}\\b`), name + ' is in the backup list');
  assert.ok(!/--table=ledger_audit\b/.test(t) && !/^\s+ledger_audit\b/m.test(t), 'ledger_audit data is never exported');
  assert.match(t, /--no-data --output=backup\\schema\.sql/); assert.match(t, /--table=%%T --output=backup\\%%T\.sql/);
  assert.match(t, /FAILED/); assert.match(t, /exit \/b 1/);
});
