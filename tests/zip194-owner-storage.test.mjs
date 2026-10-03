import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { ROOT, APPS, boot, until } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV } from './kv-fake.mjs';
import { ensureLedgerSchema } from '../functions/api/_ledger.js';
import { ensureAuditSchema } from '../functions/api/_audit-db.js';
import { ensureOwnerSchema } from '../functions/api/_owner-db.js';
import * as sr from '../functions/api/_storage-report.js';

// zip 194 — Owner Console: Storage -> Databases (monitor each database + cleanup + backups). Endpoint: functions/api/owner-databases.js.
const DAY = 86400000;
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const req = (method, body, auth = true) => new Request('https://x.pages.dev/api/owner-databases', { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', ...(auth ? { Authorization: 'Bearer tok' } : {}) } });
const gunzip = (u8) => zlib.gunzipSync(Buffer.from(u8)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// an R2 stand-in with put / head / list / delete
function r2fake() {
  const m = new Map();
  return {
    m, failPut: false, shortHead: false,
    async put(k, v, o) { if (this.failPut) throw new Error('R2 down'); m.set(k, { v: new Uint8Array(v), o }); },
    async head(k) { const x = m.get(k); return x ? { size: x.v.length - (this.shortHead ? 1 : 0) } : null; },
    async delete(k) { m.delete(k); },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0, slice = keys.slice(start, start + limit);
      return { objects: slice.map((key) => ({ key, size: m.get(key).v.length })), truncated: start + limit < keys.length, cursor: start + limit < keys.length ? String(start + limit) : undefined };
    },
  };
}

async function mkEnv({ audit = true, owner = true, r2 = true, kv = true } = {}) {
  const env = { RETRY_BASE_MS: 0 };
  if (kv) { env.mydukapos_kv = makeKV(); env.mydukapos_kv.data.set('owner-session:tok', { value: '1' }); }
  env.LEDGER_DB = makeD1(); await ensureLedgerSchema(env.LEDGER_DB);
  if (audit) { env.LEDGER_AUDIT_DB = makeD1(); await ensureAuditSchema(env.LEDGER_AUDIT_DB); }
  if (owner) { env.OWNER_DB = makeD1(); await ensureOwnerSchema(env.OWNER_DB); }
  if (r2) env.AUDIT_ARCHIVE = r2fake();
  return env;
}
const count = async (db, t) => (await db.prepare(`select count(*) n from ${t}`).first()).n;

// money rows that must survive every cleanup
async function seedMoney(env) {
  const db = env.LEDGER_DB, now = Date.now(), old = now - 800 * DAY;
  for (let i = 0; i < 5; i++) await db.prepare(`insert into ledger_records (client_id, kind, rec_id, version, ts, business_date, amount, status, data, created_at, updated_at) values ('C1','sale',?,1,?,?,?, 'PAID','{"i":1}',?,?)`).bind('s' + i, old, '2024-01-01', 100 + i, old, old).run();
  await db.prepare(`insert into store_items (group_id, item_id, code, name, qty, created_at, updated_at) values ('G','i1','c1','Cement',10,?,?)`).bind(old, old).run();
  return { records: await count(db, 'ledger_records'), items: await count(db, 'store_items') };
}
async function seedBatches(env, nOld, nNew = 2, ageDays = 800) {
  const now = Date.now();
  for (let i = 0; i < nOld; i++) await env.LEDGER_DB.prepare(`insert into ledger_batches (batch_id, client_id, at, records, source) values (?, 'C1', ?, 1, 'till')`).bind('old' + i, now - ageDays * DAY).run();
  for (let i = 0; i < nNew; i++) await env.LEDGER_DB.prepare(`insert into ledger_batches (batch_id, client_id, at, records, source) values (?, 'C1', ?, 1, 'till')`).bind('new' + i, now - 1000).run();
}
async function seedAudit(env, nOld, nNew = 3, ageDays = 200) {
  const now = Date.now();
  for (let i = 0; i < nOld + nNew; i++) await env.LEDGER_AUDIT_DB.prepare(`insert into ledger_audit (client_id, kind, rec_id, action, at, snapshot) values ('C1','sale',?, 'WRITE', ?, '{}')`).bind('r' + i, i < nOld ? now - ageDays * DAY : now - 1000).run();
}

test('A1: owner session is required for the report and for every action', async () => {
  const env = await mkEnv();
  const m = await load('owner-databases.js');
  assert.equal((await m.onRequestGet({ request: req('GET', null, false), env })).status, 401);
  for (const action of ['save-settings', 'cleanup', 'backup-now']) assert.equal((await m.onRequestPost({ request: req('POST', { action }, false), env })).status, 401, action);
  assert.equal((await m.onRequestPost({ request: req('POST', { action: 'nope' }), env })).status, 400);
});

test('A2: the report lists every store honestly: measured numbers, null + reason for what cannot be measured', async () => {
  const env = await mkEnv();
  await seedMoney(env); await seedAudit(env, 4, 3); await seedBatches(env, 2);
  env.mydukapos_kv.data.set('pos-data:state:C1', { value: '{}', metadata: { bytes: 1234 } });
  env.mydukapos_kv.data.set('pos-data:backup:C1:2026-01-01', { value: '{}' });
  const m = await load('owner-databases.js');
  const res = await m.onRequestGet({ request: req('GET'), env });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.ok, true);
  const by = Object.fromEntries(r.stores.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(by), ['ledger', 'audit', 'owner', 'kv', 'shop_store', 'r2:AUDIT_ARCHIVE', 'r2:DB_BACKUPS', 'r2:MEDIA']);
  // D1: a real size, a limit and a percentage that agree
  for (const id of ['ledger', 'audit', 'owner']) {
    assert.ok(by[id].bound && by[id].sizeBytes > 0, id + ' size'); assert.equal(by[id].limitBytes, 10 * 1e9);
    assert.equal(by[id].pctUsed, Math.round((by[id].sizeBytes / (10 * 1e9)) * 1000) / 10);
    assert.ok(by[id].sizeSource);
  }
  const t = Object.fromEntries(by.ledger.tables.map((x) => [x.name, x]));
  assert.equal(t.ledger_records.rows, 5); assert.equal(t.store_items.rows, 1); assert.equal(t.ledger_batches.rows, 4);
  assert.ok('ledger_meta' in t && 'ledger_sales' in t);
  const at = Object.fromEntries(by.audit.tables.map((x) => [x.name, x]));
  assert.equal(at.ledger_audit.rows, 7); assert.equal(at.ledger_audit.rowsIsEstimate, true, 'the audit table is never COUNT(*)ed: an id-range upper bound');
  assert.equal(by.owner.tables.find((x) => x.name === 'owner_clients').rows, 0);
  // KV: counts only; its size is NOT invented
  assert.equal(by.kv.sizeBytes, null); assert.match(by.kv.sizeReason, /does not tell a Worker/);
  assert.equal(by.kv.groups.find((g) => g.prefix === 'pos-data:state:').keys, 1);
  assert.equal(by.kv.groups.find((g) => g.prefix === 'pos-data:state:').bytesKnown, 1234);
  assert.equal(by.kv.groups.find((g) => g.prefix === 'pos-data:backup:').keys, 1);
  // unbound things say so
  assert.equal(by.shop_store.bound, false); assert.equal(by.shop_store.sizeBytes, null); assert.match(by.shop_store.sizeReason, /not bound/);
  assert.equal(by['r2:MEDIA'].bound, false); assert.equal(by['r2:MEDIA'].sizeBytes, null);
  assert.equal(by['r2:AUDIT_ARCHIVE'].bound, true); assert.equal(by['r2:AUDIT_ARCHIVE'].sizeBytes, 0);
  // retention categories, last cleanup, backups
  assert.deepEqual(r.categories.map((c) => c.id), ['audit', 'batches', 'shop_backups', 'temp']);
  assert.equal(r.categories.find((c) => c.id === 'audit').days, 90); assert.equal(r.categories.find((c) => c.id === 'temp').editable, false);
  assert.equal(r.categories.find((c) => c.id === 'audit').archivedFirst, true);
  assert.equal(r.lastCleanup, null); assert.equal(r.backups.configured, true); assert.equal(r.backups.last, null);
  assert.equal(r.settings.limitGb, 10);
});

test('A3: without bindings the report still answers: null + reason, archivedFirst false, nothing invented', async () => {
  const env = await mkEnv({ audit: false, owner: false, r2: false });
  const m = await load('owner-databases.js');
  const r = await (await m.onRequestGet({ request: req('GET'), env })).json();
  const by = Object.fromEntries(r.stores.map((s) => [s.id, s]));
  assert.equal(by.audit.bound, false); assert.equal(by.audit.sizeBytes, null); assert.match(by.audit.sizeReason, /LEDGER_AUDIT_DB/);
  assert.equal(by.owner.bound, false); assert.equal(by.owner.tables.length, 0);
  assert.equal(r.categories.find((c) => c.id === 'audit').available, false);
  assert.equal(r.backups.configured, false); assert.match(r.backups.runsReason, /no R2 bucket/);
  // a D1 that cannot report its size -> null + reason
  const odd = { prepare: () => ({ all: async () => ({ results: [], meta: {} }), first: async () => { throw new Error('no pragma'); }, bind() { return this; } }) };
  const rep = await sr.buildReport({ mydukapos_kv: env.mydukapos_kv, LEDGER_DB: odd });
  const l = rep.stores.find((s) => s.id === 'ledger');
  assert.equal(l.sizeBytes, null); assert.match(l.sizeReason, /did not report its size/); assert.equal(l.pctUsed, null);
});

test('B1: save-settings round trip (stored in ledger_meta and mirrored in KV), validation, and it survives a missing KV', async () => {
  const env = await mkEnv();
  const m = await load('owner-databases.js');
  const post = async (b) => { const r = await m.onRequestPost({ request: req('POST', b), env }); return { status: r.status, body: await r.json() }; };
  const ok = await post({ action: 'save-settings', limitGb: 0.5, retention: { audit: 365, batches: 200, shop_backups: 21 }, autoCleanup: false });
  assert.equal(ok.status, 200); assert.deepEqual(ok.body.savedIn.sort(), ['kv', 'ledger_meta']);
  const rep = await (await m.onRequestGet({ request: req('GET'), env })).json();
  assert.equal(rep.settings.limitGb, 0.5); assert.deepEqual(rep.settings.retention, { audit: 365, batches: 200, shop_backups: 21 }); assert.equal(rep.settings.autoCleanup, false);
  assert.equal(rep.limit.bytes, 0.5e9); assert.equal(rep.stores.find((s) => s.id === 'ledger').limitBytes, 0.5e9);
  assert.ok(JSON.parse((await env.LEDGER_DB.prepare(`select v from ledger_meta where k='storage_settings'`).first()).v).retention.audit === 365);
  const noKv = { ...env }; delete noKv.mydukapos_kv;
  assert.equal((await sr.loadSettings(noKv)).retention.audit, 365, 'the router (no KV) reads the same setting from ledger_meta');
  assert.equal(await sr.configuredAuditDays(noKv), 365);
  // validation
  assert.equal((await post({ action: 'save-settings', limitGb: 'abc' })).status, 400);
  assert.equal((await post({ action: 'save-settings', limitGb: 0 })).status, 400);
  assert.equal((await post({ action: 'save-settings', retention: { audit: 3 } })).status, 400, 'below the floor');
  assert.equal((await post({ action: 'save-settings', retention: { audit: 12.5 } })).status, 400);
  assert.equal((await post({ action: 'save-settings', retention: { temp: 5 } })).status, 400, 'temporary data is not editable');
  assert.equal((await post({ action: 'save-settings', retention: { sales: 5 } })).status, 400, 'there is no way to name a money table');
  assert.equal((await sr.loadSettings(env)).retention.audit, 365, 'rejected requests changed nothing');
  // newer copy wins when ledger_meta is stale (e.g. the main database was full when saving)
  await env.LEDGER_DB.prepare(`update ledger_meta set v = ? where k = 'storage_settings'`).bind(JSON.stringify({ limitGb: 7, retention: { audit: 30 }, at: 1 })).run();
  assert.equal((await sr.loadSettings(env)).limitGb, 0.5);
});

test('B2: cleanup archives to R2 (verified) then removes old audit + push-log rows; sales, inventory, payments untouched', async () => {
  const env = await mkEnv();
  const before = await seedMoney(env); await seedAudit(env, 6, 3); await seedBatches(env, 5, 2);
  const pay = await count(env.LEDGER_DB, 'ledger_payments');
  const m = await load('owner-databases.js');
  const res = await m.onRequestPost({ request: req('POST', { action: 'cleanup' }), env });
  assert.equal(res.status, 200);
  const { ok, result } = await res.json();
  assert.equal(ok, true); assert.equal(result.errors.length, 0);
  const by = Object.fromEntries(result.results.map((x) => [x.id, x]));
  assert.deepEqual([by.audit.archived, by.audit.removed], [6, 6]);
  assert.deepEqual([by.batches.archived, by.batches.removed], [5, 5]);
  assert.equal(result.archived, 11); assert.equal(result.removed, 11);
  assert.equal(await count(env.LEDGER_AUDIT_DB, 'ledger_audit'), 3);
  assert.equal(await count(env.LEDGER_DB, 'ledger_batches'), 2, 'recent push-log rows stay');
  // archived rows are really in R2
  const keys = [...env.AUDIT_ARCHIVE.m.keys()];
  const a = keys.filter((k) => k.startsWith('audit-archive/')).flatMap((k) => gunzip(env.AUDIT_ARCHIVE.m.get(k).v));
  const b = keys.filter((k) => k.startsWith('db-archive/ledger_batches/')).flatMap((k) => gunzip(env.AUDIT_ARCHIVE.m.get(k).v));
  assert.equal(a.length, 6); assert.equal(b.length, 5); assert.ok(b.every((x) => x.batch_id.startsWith('old')));
  // money untouched
  assert.equal(await count(env.LEDGER_DB, 'ledger_records'), before.records);
  assert.equal(await count(env.LEDGER_DB, 'store_items'), before.items);
  assert.equal(await count(env.LEDGER_DB, 'ledger_payments'), pay);
  assert.equal((await env.LEDGER_DB.prepare(`select sum(amount) s from ledger_records`).first()).s, 510);
  // the result is kept as "last cleanup" and is what the report shows
  const rep = await (await m.onRequestGet({ request: req('GET'), env })).json();
  assert.equal(rep.lastCleanup.trigger, 'manual'); assert.equal(rep.lastCleanup.archived, 11); assert.equal(rep.lastCleanup.removed, 11);
});

test('B3: R2 failure or a size mismatch deletes NOTHING and reports the real error', async () => {
  const env = await mkEnv();
  await seedBatches(env, 4); await seedAudit(env, 4, 1);
  env.AUDIT_ARCHIVE.failPut = true;
  const a = await sr.runCleanup(env);
  assert.equal(a.ok, false); assert.match(a.errors.join(' '), /R2 down/);
  assert.equal(await count(env.LEDGER_DB, 'ledger_batches'), 6); assert.equal(await count(env.LEDGER_AUDIT_DB, 'ledger_audit'), 5);
  env.AUDIT_ARCHIVE.failPut = false; env.AUDIT_ARCHIVE.shortHead = true;
  const b = await sr.runCleanup(env);
  assert.match(b.errors.join(' '), /verify failed/);
  assert.equal(await count(env.LEDGER_DB, 'ledger_batches'), 6); assert.equal(await count(env.LEDGER_AUDIT_DB, 'ledger_audit'), 5);
});

test('B4: without an archive bucket only the existing audit trim runs; the push log is left alone (nothing deleted unarchived beyond that)', async () => {
  const env = await mkEnv({ r2: false });
  await seedBatches(env, 4); await seedAudit(env, 4, 1);
  const r = await sr.runCleanup(env);
  const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.equal(by.audit.removed, 4); assert.equal(by.audit.archived, 0); assert.match(by.audit.note, /without an archive/);
  assert.match(by.batches.skipped, /no archive bucket/); assert.equal(by.batches.removed, 0);
  assert.equal(await count(env.LEDGER_DB, 'ledger_batches'), 6);
  assert.equal(await count(env.LEDGER_AUDIT_DB, 'ledger_audit'), 1);
});

test('B5: retention days come from the saved settings (a longer period keeps rows); shop backup copies prune by their date, markers and state records stay', async () => {
  const env = await mkEnv();
  await seedAudit(env, 5, 1, 200); await seedBatches(env, 3, 1, 800);
  await sr.saveSettings(env, { retention: { audit: 365, batches: 1000 } });
  const r1 = await sr.runCleanup(env);
  assert.equal(r1.removed, 0, 'rows are younger than the chosen retention');
  assert.equal(await count(env.LEDGER_AUDIT_DB, 'ledger_audit'), 6);
  await sr.saveSettings(env, { retention: { audit: 100, batches: 700, shop_backups: 14 } });
  const kv = env.mydukapos_kv, today = new Date().toISOString().slice(0, 10), old = new Date(Date.now() - 40 * DAY).toISOString().slice(0, 10), mid = new Date(Date.now() - 5 * DAY).toISOString().slice(0, 10);
  for (const k of [`pos-data:backup:C1:${old}`, `pos-data:backup:C1:${mid}`, `pos-data:backup:C1:${today}`, 'pos-data:backup:C1:last-date', `pos-data:backup:C2:pre-restore-${Date.now() - 40 * DAY}`, `pos-data:backup:C2:pre-restore-${Date.now() - DAY}`, 'pos-data:state:C1', 'license:C1']) kv.data.set(k, { value: 'x' });
  const r2 = await sr.runCleanup(env);
  const by = Object.fromEntries(r2.results.map((x) => [x.id, x]));
  assert.equal(by.audit.removed, 5); assert.equal(by.batches.removed, 3); assert.equal(by.shop_backups.removed, 2);
  const left = [...kv.data.keys()].filter((k) => !k.startsWith('owner-')).sort();
  assert.deepEqual(left, [`pos-data:backup:C1:${mid}`, `pos-data:backup:C1:${today}`, 'pos-data:backup:C1:last-date', `pos-data:backup:C2:pre-restore-${[...kv.data.keys()].find((k) => k.includes('C2:pre-restore') && Number(k.split('-').pop()) > Date.now() - 2 * DAY).split('-').pop()}`, 'license:C1', 'pos-data:state:C1'].sort());
  const auto = await sr.runCleanup(env, { trigger: 'automatic' });
  assert.equal(auto.trigger, 'automatic');
  assert.equal(auto.results.find((x) => x.id === 'audit').skipped, 'already done this month', 'the automatic run keeps the existing monthly audit gate');
});

test('C1: backup-now copies the small databases to R2 (verified), keeps the last 8, skips what is too big and says why; 409 without a bucket', async () => {
  const env = await mkEnv();
  await seedMoney(env);
  await env.OWNER_DB.prepare(`insert into owner_clients (id, slug, label, business_name, updated_at, summary_json) values ('c1','a','A','A',1,'{}')`).run();
  const m = await load('owner-databases.js');
  const res = await m.onRequestPost({ request: req('POST', { action: 'backup-now' }), env });
  assert.equal(res.status, 200);
  const { ok, backup } = await res.json();
  assert.equal(ok, true); assert.equal(backup.ok, true); assert.ok(backup.rows >= 7); assert.ok(backup.bytes > 0);
  const k = [...env.AUDIT_ARCHIVE.m.keys()].filter((x) => x.startsWith('db-backups/'));
  assert.equal(k.length, 2);
  const led = gunzip(env.AUDIT_ARCHIVE.m.get(k.find((x) => x.endsWith('/ledger.ndjson.gz'))).v);
  assert.equal(led.filter((x) => x.t === 'ledger_records').length, 5); assert.equal(led.filter((x) => x.t === 'store_items').length, 1);
  assert.ok(!led.some((x) => x.t === 'ledger_audit'), 'the audit table has its own monthly archive');
  const rep = await (await m.onRequestGet({ request: req('GET'), env })).json();
  assert.equal(rep.backups.last.ok, true); assert.equal(rep.backups.runs.length, 1);
  // keep 8
  let t = Date.now();
  for (let i = 1; i <= 10; i++) await sr.backupNow(env, { now: t + i * 1000 });
  const runs = await sr.backupStatus(env);
  assert.equal(runs.runs.length, 8);
  // too big: skipped with the reason, flagged partial, not "OK"
  const e2 = await mkEnv(); await seedMoney(e2); e2.BACKUP_MAX_ROWS = '3';
  const big = await sr.backupNow(e2);
  assert.equal(big.ok, false); assert.match(big.dbs.find((d) => d.name === 'ledger').skipped, /more than one request can copy/);
  assert.equal(big.partial, true); assert.match(big.error, /ledger: .*more than one request/);
  // R2 refuses -> the real error, no state of success
  const e3 = await mkEnv(); e3.AUDIT_ARCHIVE.failPut = true;
  const bad = await sr.backupNow(e3);
  assert.equal(bad.ok, false); assert.match(bad.error, /R2 down/);
  // no bucket
  const e4 = await mkEnv({ r2: false });
  const none = await load('owner-databases.js').then((mm) => mm.onRequestPost({ request: req('POST', { action: 'backup-now' }), env: e4 }));
  assert.equal(none.status, 409); assert.match((await none.json()).error, /No R2 bucket/);
});

test('D1: cron: automatic cleanup at most once a day (marker), off switch honoured, weekly backup on Sundays only, never throws', async () => {
  const env = await mkEnv();
  await seedAudit(env, 3, 1); await seedBatches(env, 2);
  let sun = Date.parse('2026-11-01T04:40:00Z'); while (new Date(sun).getUTCDay() !== 0) sun += DAY;
  const a = await sr.scheduledStorageJobs(env, { now: sun });
  assert.equal(a.cleanup.trigger, 'automatic'); assert.equal(a.cleanup.removed, 5);
  assert.ok(a.backup && a.backup.trigger === 'automatic', 'Sunday: weekly backup');
  const b = await sr.scheduledStorageJobs(env, { now: sun + 6 * 3600000 });
  assert.match(b.cleanup.skipped, /last 20 hours/); assert.equal(b.backup, undefined, 'one backup a week');
  const c = await sr.scheduledStorageJobs(env, { now: sun + DAY + 3600000 });
  assert.equal(c.cleanup.trigger, 'automatic', 'next day it runs again'); assert.equal(c.backup, undefined, 'Monday: no backup');
  await sr.saveSettings(env, { autoCleanup: false, autoBackup: false });
  const d = await sr.scheduledStorageJobs(env, { now: sun + 9 * DAY });
  assert.match(d.cleanup.skipped, /switched off/); assert.equal(d.backup, undefined);
  // a broken database never throws out of the cron
  const broken = { LEDGER_DB: { prepare() { throw new Error('boom'); } }, mydukapos_kv: makeKV() };
  const e = await sr.scheduledStorageJobs(broken, { now: sun });
  assert.ok(typeof e === 'object');
  // the router's own scheduled() hook calls it and honours the saved audit retention
  const w = await import(pathToFileURL(path.join(ROOT, 'wildcard-router/worker.js')).href);
  const env2 = await mkEnv(); await seedAudit(env2, 3, 1, 200);
  await sr.saveSettings(env2, { retention: { audit: 365 }, autoCleanup: false });
  await w.ledgerSizeWatchdog(env2);
  assert.equal(await count(env2.LEDGER_AUDIT_DB, 'ledger_audit'), 4, 'the cron honours the owner-chosen 365 days (not the 90-day default)');
  const env3 = await mkEnv(); await seedAudit(env3, 3, 1, 200);
  await sr.saveSettings(env3, { retention: { audit: 100 }, autoCleanup: false });
  await w.ledgerSizeWatchdog(env3);
  assert.equal(await count(env3.LEDGER_AUDIT_DB, 'ledger_audit'), 1, 'and a shorter period applies too');
});

test('E1: staff / shop apps never contain the owner Databases feature', () => {
  for (const app of APPS) {
    const html = fs.readFileSync(path.join(ROOT, app), 'utf8');
    assert.ok(!/owner-databases|dbsApi|loadDatabases/.test(html), app);
  }
  const shared = fs.readdirSync(path.join(ROOT, 'src/shared/blocks')).filter((f) => f.endsWith('.html')).map((f) => fs.readFileSync(path.join(ROOT, 'src/shared/blocks', f), 'utf8')).join('\n') + fs.readFileSync(path.join(ROOT, 'src/shared/functions.js'), 'utf8');
  assert.ok(!/owner-databases/.test(shared));
});

test('F1: Owner Console: the Databases card renders what the endpoint says, saves, cleans and backs up for real', async () => {
  const env = await mkEnv();
  await seedMoney(env); await seedAudit(env, 4, 2); await seedBatches(env, 3);
  const m = await load('owner-databases.js');
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('/api/owner-databases')) return { ok: false, status: 404, json: async () => ({}) };
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, body });
    const request = new Request('https://x.pages.dev/api/owner-databases', { method, body: opts.body, headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' } });
    return method === 'GET' ? m.onRequestGet({ request, env }) : m.onRequestPost({ request, env });
  };
  const { w, d, errors, close } = await boot('owner/index.html', { fetch, wait: 900 });
  await w.eval('loadDatabases()');
  const cards = [...d.querySelectorAll('#dbs-stores .dbs-card')];
  assert.equal(cards.length, 8);
  const txt = (i) => cards[i].textContent;
  assert.match(txt(0), /Sales ledger \(D1\)/); assert.match(txt(0), /of 10\.00 GB, 0\.\d%/); assert.match(txt(0), /ledger_records.*5/s);
  assert.equal(cards[0].querySelectorAll('.dbs-bar').length, 1);
  assert.match(txt(1), /ledger_audit/); assert.match(txt(3), /Size: not measurable — Cloudflare does not tell a Worker/);
  assert.match(txt(4), /not bound/); assert.match(txt(4), /Size: not measurable/);
  const inputs = [...d.querySelectorAll('#dbs-retention input[data-cat]')];
  assert.deepEqual(inputs.map((i) => i.dataset.cat), ['audit', 'batches', 'shop_backups']);
  assert.deepEqual(inputs.map((i) => i.value), ['90', '365', '30']);
  assert.match(d.getElementById('dbs-retention').textContent, /expires by itself/);
  assert.equal(d.getElementById('dbs-last').textContent, 'Last cleanup: never run.');
  assert.match(d.getElementById('dbs-backup-last').textContent, /Last backup: none yet/);
  // save
  inputs[0].value = '120'; d.getElementById('dbs-limit').value = '0.5';
  await w.eval('dbsSave()');
  const save = calls.find((c) => c.body && c.body.action === 'save-settings');
  assert.deepEqual(save.body, { action: 'save-settings', limitGb: 0.5, retention: { audit: 120, batches: 365, shop_backups: 30 }, autoCleanup: true, autoBackup: true });
  assert.match(d.getElementById('dbs-msg').textContent, /Settings saved/);
  assert.equal(d.querySelector('#dbs-retention input[data-cat="audit"]').value, '120', 'reloaded from the server');
  assert.equal(d.getElementById('dbs-limit').value, '0.5');
  assert.match(d.getElementById('dbs-stores').textContent, /of 500\.0 MB/);
  // a bad value shows the REAL error from the server
  d.querySelector('#dbs-retention input[data-cat="audit"]').value = '2';
  await w.eval('dbsSave()');
  assert.match(d.getElementById('dbs-msg').textContent, /Not saved: .*between 7 and 3650/);
  assert.equal(d.getElementById('dbs-msg').className.includes('err'), true);
  // cleanup (audit rows are 200 days old, retention 120)
  await w.eval('loadDatabases()');
  w.confirm = () => true;
  await w.eval('dbsCleanup()');
  const msg = d.getElementById('dbs-msg').textContent;
  assert.match(msg, /Cleanup finished: 7 archived, 7 removed/);
  assert.match(msg, /Audit log.*4 archived, 4 removed/); assert.match(msg, /push log.*3 archived, 3 removed/i);
  assert.match(d.getElementById('dbs-last').textContent, /^Last cleanup \d{4}-\d\d-\d\d \d\d:\d\d UTC \(manual\): 7 archived, 7 removed$/);
  assert.equal(await count(env.LEDGER_DB, 'ledger_records'), 5, 'sales untouched');
  // the real error of a failing cleanup
  await seedBatches(env, 2, 0); env.AUDIT_ARCHIVE.failPut = true;
  await w.eval('dbsCleanup()');
  assert.match(d.getElementById('dbs-msg').textContent, /ERROR — R2 down/); assert.equal(d.getElementById('dbs-msg').className.includes('err'), true);
  env.AUDIT_ARCHIVE.failPut = false;
  // backup
  await w.eval('dbsBackup()');
  assert.match(d.getElementById('dbs-backup-msg').textContent, /Backup OK/);
  assert.match(d.getElementById('dbs-backup-last').textContent, /^Last backup \d{4}-\d\d-\d\d \d\d:\d\d UTC \(manual\) - OK, \d+ rows, .+/);
  assert.match(d.getElementById('dbs-backup-runs').textContent, /In R2: \d{8}T\d{6}Z/);
  assert.deepEqual(errors, []);
  close();
});

test('F2: Owner Console: an endpoint failure is shown, never hidden; a store that is not measurable stays "not measurable"', async () => {
  const fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'The report could not be built: D1 down' }) });
  const { w, d, errors, close } = await boot('owner/index.html', { fetch, wait: 900 });
  await w.eval('loadDatabases()');
  assert.match(d.getElementById('dbs-msg').textContent, /Could not load the database report: The report could not be built: D1 down/);
  assert.equal(d.querySelectorAll('#dbs-stores .dbs-card').length, 0, 'no invented cards');
  assert.deepEqual(errors, []);
  close();
});
