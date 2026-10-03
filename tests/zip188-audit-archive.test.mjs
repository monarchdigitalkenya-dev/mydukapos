import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { makeD1 } from './d1-fake.mjs';
import { ensureAuditSchema, auditMaintenance, auditArchiveStatus } from '../functions/api/_audit-db.js';
import { auditMonthly, parseArgs } from '../tools/audit-monthly.mjs';

// zip 188 — monthly archive-then-prune of the separate audit database.
const DAY = 86400000;
const NOW = Date.parse('2026-11-01T03:00:00Z');
const r2fake = () => { const m = new Map(); return { m, fail: false, shortHead: false,
  async put(k, v, o) { if (this.fail) throw new Error('R2 down'); m.set(k, { v: new Uint8Array(v), o }); },
  async head(k) { const x = m.get(k); return x ? { size: x.v.length - (this.shortHead ? 1 : 0) } : null; } }; };
async function seed(n, old = n, at = NOW - 200 * DAY) {
  const db = makeD1(); await ensureAuditSchema(db);
  for (let i = 0; i < n; i++) await db.prepare(`insert into ledger_audit (client_id, kind, rec_id, action, at, snapshot) values ('c','sale',?,?,?,?)`).bind('r' + i, 'WRITE', i < old ? at : NOW - 1000, '{"i":' + i + '}').run();
  return db;
}
const count = async (db) => (await db.prepare('select count(*) n from ledger_audit').first()).n;
const gunzip = (u8) => zlib.gunzipSync(Buffer.from(u8)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('D1: old rows are archived to R2 (verified) and only then deleted; recent rows stay', async () => {
  const db = await seed(30, 25), r2 = r2fake();
  const r = await auditMaintenance({ LEDGER_AUDIT_DB: db, AUDIT_ARCHIVE: r2 }, { now: NOW, rows: 10 });
  assert.equal(r.archived, 25); assert.equal(r.deleted, 25); assert.equal(r.files, 3);
  assert.equal(await count(db), 5);
  const keys = [...r2.m.keys()]; assert.equal(keys.length, 3);
  assert.ok(keys.every((k) => /^audit-archive\/2026-11\/ledger_audit_\d+-\d+\.ndjson\.gz$/.test(k)));
  const all = keys.flatMap((k) => gunzip(r2.m.get(k).v)); assert.equal(all.length, 25);
  assert.deepEqual(Object.keys(all[0]).sort(), ['action', 'actor', 'amount', 'at', 'client_id', 'id', 'kind', 'rec_id', 'snapshot', 'source', 'status', 'version']);
  assert.equal(r2.m.get(keys[0]).o.customMetadata.rows, '10');
});

test('D2: monthly gate: a second firing the same month does nothing; next month runs; backlog continues at once', async () => {
  const db = await seed(30, 30), r2 = r2fake(), env = { LEDGER_AUDIT_DB: db, AUDIT_ARCHIVE: r2 };
  const a = await auditMaintenance(env, { now: NOW, rows: 10, maxFiles: 2 });
  assert.equal(a.archived, 20); assert.equal(a.backlog, true);
  const b = await auditMaintenance(env, { now: NOW + 6 * 3600000, rows: 10, maxFiles: 2 });
  assert.equal(b.archived, 10, 'backlog is worked off at the next firing'); assert.equal(b.backlog, false);
  const c = await auditMaintenance(env, { now: NOW + 12 * 3600000, rows: 10 });
  assert.equal(c.skipped, 'done_this_month');
  await db.prepare(`insert into ledger_audit (client_id, kind, rec_id, action, at) values ('c','sale','z','WRITE',?)`).bind(NOW - 150 * DAY).run();
  const d = await auditMaintenance(env, { now: NOW + 40 * DAY, rows: 10 });
  assert.equal(d.archived, 1, 'next month it runs again');
  const st = await auditArchiveStatus(env); assert.equal(st.bucket, true); assert.equal(st.month, '2026-12');
});

test('D3: R2 failure or a size mismatch deletes NOTHING and retries next firing', async () => {
  const db = await seed(12, 12), r2 = r2fake(), env = { LEDGER_AUDIT_DB: db, AUDIT_ARCHIVE: r2 };
  r2.fail = true;
  const a = await auditMaintenance(env, { now: NOW, rows: 10 });
  assert.match(a.error, /R2 down/); assert.equal(await count(db), 12);
  r2.fail = false; r2.shortHead = true;
  const b = await auditMaintenance(env, { now: NOW + 1000, rows: 10 });
  assert.match(b.error, /verify failed/); assert.equal(await count(db), 12);
  r2.shortHead = false;
  const c = await auditMaintenance(env, { now: NOW + 2000, rows: 10 });
  assert.equal(c.deleted, 12); assert.equal(await count(db), 0);
});

test('D4: without the bucket it falls back to the plain retention trim; no db / days off are no-ops', async () => {
  const db = await seed(10, 10);
  const r = await auditMaintenance({ LEDGER_AUDIT_DB: db }, { now: NOW });
  assert.equal(r.note, 'no_archive_bucket'); assert.equal(r.deleted, 10); assert.equal(r.archived, 0);
  assert.equal((await auditMaintenance({}, { now: NOW })).skipped, 'no_db');
  assert.equal((await auditMaintenance({ LEDGER_AUDIT_DB: await seed(2, 2), AUDIT_ARCHIVE: r2fake() }, { now: NOW, days: 0 })).skipped, 'off');
});

test('D5: owner tool: dry run changes nothing; --run archives, verifies the file, then deletes; corrupt file stops before delete', async () => {
  const db = await seed(25, 20);
  const exec = { sql: async (s) => { const st = db.prepare(s); const r = /^\s*select/i.test(s) ? await st.all() : await st.run(); return { results: /^\s*select/i.test(s) ? r.results : [{ meta: r.meta }] }; } };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'am-')); const logs = [];
  const o = parseArgs(['--rows', '100', '--out', out]); assert.deepEqual(o.errors, []);
  const dry = await auditMonthly(o, exec, { now: NOW, log: (m) => logs.push(m) });
  assert.equal(dry.rows, 20); assert.equal(await count(db), 25);
  const run = await auditMonthly({ ...o, run: true, rows: 8 }, exec, { now: NOW, log: () => {} });
  assert.equal(run.rows, 20); assert.equal(run.files, 3); assert.equal(run.deleted, 20); assert.equal(await count(db), 5);
  const dir = path.join(out, '2026-11'); const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(Object.keys(mf.files).length, 3);
  const rows = Object.keys(mf.files).flatMap((n) => zlib.gunzipSync(fs.readFileSync(path.join(dir, n))).toString().split('\n').filter(Boolean));
  assert.equal(rows.length, 20);
  const db2 = await seed(5, 5); const exec2 = { sql: exec.sql };
  const badFs = { ...fs, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, existsSync: fs.existsSync, readFileSync: (f, e) => { const b = fs.readFileSync(f, e); return e ? b : (String(f).endsWith('.gz') ? Buffer.from('corrupt') : b); } };
  const execBad = { sql: async (s) => { const st = db2.prepare(s); const r = /^\s*select/i.test(s) ? await st.all() : await st.run(); return { results: /^\s*select/i.test(s) ? r.results : [{ meta: r.meta }] }; } };
  await assert.rejects(auditMonthly({ ...o, run: true, out: fs.mkdtempSync(path.join(os.tmpdir(), 'am-')) }, execBad, { now: NOW, fs: badFs, log: () => {} }), /verify failed|incorrect|header/i);
  assert.equal(await count(db2), 5, 'nothing deleted after a failed verify');
  assert.ok(parseArgs(['--days', '0']).errors.length && parseArgs(['--nope']).errors.length && parseArgs(['--db', 'x;drop']).errors.length);
});

test('D6: router cron calls auditMaintenance; toml has the R2 block commented; cmd + docs mention the monthly flow', () => {
  const w = fs.readFileSync('wildcard-router/worker.js', 'utf8');
  assert.match(w, /auditMaintenance\(env\)/);
  const t = fs.readFileSync('wildcard-router/wrangler.toml', 'utf8');
  assert.match(t, /^# binding = "AUDIT_ARCHIVE"/m); assert.doesNotMatch(t, /^binding = "AUDIT_ARCHIVE"/m);
  assert.ok(fs.existsSync('tools/audit-monthly.cmd'));
});
