import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV } from './kv-fake.mjs';
import * as odb from '../functions/api/_owner-db.js';
import { patchToml, parseDatabaseId } from '../tools/setup-owner-db.mjs';

// zip 187 — the OWNER database (binding OWNER_DB): a best-effort READ MODEL of the Owner Console list. KV stays the source of truth.
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const q = (d, sql, ...a) => d.query(sql, ...a);
const mkEnv = (extra = {}) => { const kv = makeKV(); kv.data.set('owner-session:tok', { value: '1' }); return { OWNER_DB: makeD1(), mydukapos_kv: kv, OWNER_LEGACY_INCOME_FORMS: '1', RETRY_BASE_MS: 0, OWNER_DB_PAUSE_MS: '300000', ...extra }; };
const noDb = () => { const e = mkEnv(); delete e.OWNER_DB; return e; };
const kvIndex = (e) => JSON.parse(e.mydukapos_kv.data.get('license-index:v1')?.value || '[]');
const rows = (e) => q(e.OWNER_DB, `select * from owner_clients order by id`);
const dirty = (e) => e.mydukapos_kv.data.has('owner-db:dirty:v1');
const req = (method, body, url = 'https://x.pages.dev/api/x') => new Request(url, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' } });
async function lock(e, body) { const m = await load('owner-lock.js'); const r = await m.onRequestPost({ request: req('POST', body), env: e }); return { status: r.status, body: await r.json() }; }
async function list(e, qs = '') { const m = await load('owner-clients.js'); const r = await m.onRequestGet({ request: req('GET', null, 'https://x.pages.dev/api/owner-clients' + qs), env: e }); return { status: r.status, body: await r.json() }; }
const strip = (b) => { const c = JSON.parse(JSON.stringify(b)); delete c.serverNow; for (const x of c.clients) delete x.remainingMs; return c; };
async function rebuild(e) { const r = await odb.rebuildOwnerDb(e); assert.equal(r.ok, true, JSON.stringify(r)); return r; }
// the KV index read is counted: a D1-served list must not read it
function spyIndexReads(e) { const kv = e.mydukapos_kv; const get = kv.get.bind(kv); const st = { n: 0 }; kv.get = async (k) => { if (k === 'license-index:v1') st.n++; return get(k); }; return st; }

test('D1: the schema file and the migration equal the code', () => {
  const norm = (t) => t.split('\n').filter((l) => !l.startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);
  for (const f of ['sql/owner-db/0001_owner.sql', 'migrations-owner/0001_owner.sql']) {
    assert.deepEqual(norm(fs.readFileSync(path.join(ROOT, f), 'utf8')), odb.OWNER_SCHEMA.map((s) => s.trim()), f);
  }
  assert.ok(odb.OWNER_SCHEMA.join('\n').includes('summary_json'));
});

test('D2: write-through for create, lock, rename, delete, restore, businessName and purge (rows equal the KV index)', async () => {
  const e = mkEnv();
  const lic = await load('_license.js');
  const a = await lic.createClient(e, 'permanent', 'Alpha Shop', 'shop');
  const b = await lic.createClient(e, 'demo', 'Beta Hotel', 'hotel');
  const same = () => { const k = kvIndex(e); const r = rows(e); assert.equal(r.length, k.length); for (const x of k) assert.deepEqual(JSON.parse(r.find((y) => y.id === x.id).summary_json), x); };
  same();
  assert.equal(rows(e).find((r) => r.id === a.id).slug, 'alpha-shop');
  assert.equal(rows(e).find((r) => r.id === b.id).type, 'demo');
  assert.equal((await lock(e, { c: a.id, action: 'lock' })).status, 200); same();
  assert.equal(rows(e).find((r) => r.id === a.id).locked, 1);
  await lock(e, { c: a.id, action: 'unlock' }); assert.equal(rows(e).find((r) => r.id === a.id).locked, 0);
  await lock(e, { c: a.id, action: 'edit', label: 'Alpha Renamed' }); same();
  assert.equal(rows(e).find((r) => r.id === a.id).label, 'Alpha Renamed');
  await lic.updateIndexBusinessName(e, a.id, 'Alpha Ltd'); same();
  assert.equal(rows(e).find((r) => r.id === a.id).business_name, 'Alpha Ltd');
  assert.equal((await lock(e, { c: b.id, action: 'delete' })).status, 200); same();
  assert.ok(rows(e).find((r) => r.id === b.id).trashed_at > 0);
  await lock(e, { c: b.id, action: 'restore' }); same();
  assert.equal(rows(e).find((r) => r.id === b.id).trashed_at, null);
  // purge: trash it, age it past 30 days in KV, sweep
  await lic.deleteClient(e, b.id);
  const idx = kvIndex(e); idx.find((x) => x.id === b.id).deletedAt = Date.now() - 31 * 86400000;
  e.mydukapos_kv.data.set('license-index:v1', { value: JSON.stringify(idx) });
  assert.equal(await lic.purgeExpiredTrash(e), 1);
  assert.equal(rows(e).some((r) => r.id === b.id), false, 'purged row is gone');
  assert.equal(rows(e).length, kvIndex(e).length);
  assert.equal(dirty(e), false, 'no failure -> no dirty flag');
});

test('D3: with no OWNER_DB everything behaves as before (no D1 calls, no extra KV keys, same results)', async () => {
  const e = noDb(), f = mkEnv();
  const lic = await load('_license.js');
  const keysBefore = [...e.mydukapos_kv.data.keys()];
  const a = await lic.createClient(e, 'permanent', 'Solo', 'shop');
  await lock(e, { c: a.id, action: 'lock' }); await lock(e, { c: a.id, action: 'delete' });
  await lock(e, { c: a.id, action: 'restore' });
  const extra = [...e.mydukapos_kv.data.keys()].filter((k) => !keysBefore.includes(k)).sort();
  assert.deepEqual(extra, ['license-index:v1', 'license:' + a.id, 'slug:solo'].sort(), 'only the usual KV keys');
  assert.equal(odb.ownerDb(e), null);
  assert.equal(await odb.ownerDbRead(e, {}), null);
  assert.deepEqual(await odb.mirrorClient(e, { id: 'x' }), { written: 0, skipped: 'no_db' });
  const l = await list(e); assert.equal(l.status, 200); assert.equal(l.body.clients.length, 1); assert.equal(l.body.clients[0].locked, true, 'locked earlier, and the list shows it');
  assert.deepEqual(await odb.ownerDbStatus(e), { bound: false, healthy: false });
  // the same actions WITH the binding leave the same KV keys behind
  const b = await lic.createClient(f, 'permanent', 'Solo', 'shop');
  await lock(f, { c: b.id, action: 'lock' });
  assert.ok([...f.mydukapos_kv.data.keys()].every((k) => !k.startsWith('owner-db')), 'KV is never polluted by a healthy mirror');
});

test('D4: a failing OWNER_DB never fails or undoes the KV write, pauses the mirror, flags KV, and reads fall back to KV', async () => {
  const e = mkEnv();
  const lic = await load('_license.js');
  const a = await lic.createClient(e, 'permanent', 'First', 'shop');
  await rebuild(e);
  const c1 = await list(e); assert.equal(c1.body.clients.length, 1);
  const realBatch = e.OWNER_DB.batch.bind(e.OWNER_DB);
  e.OWNER_DB._state.failOnSql = /INSERT INTO owner_clients/;
  const b = await lic.createClient(e, 'permanent', 'Second', 'shop');          // D1 write fails
  assert.ok(await lic.getLicense(e, b.id), 'the licence record is saved');
  assert.equal(kvIndex(e).length, 2, 'the KV index has it');
  assert.ok(dirty(e), 'KV flag says the mirror is behind');
  assert.ok(odb.ownerPausedUntil(e.OWNER_DB) > Date.now(), 'paused');
  e.OWNER_DB._state.failOnSql = null;
  // paused: no attempt, still no failure
  const callsBefore = e.OWNER_DB._state.calls;
  const c = await lic.createClient(e, 'permanent', 'Third', 'shop');
  assert.equal(e.OWNER_DB._state.calls, callsBefore, 'paused: D1 is not touched');
  assert.equal(kvIndex(e).length, 3);
  // stale D1 must NOT hide the new clients: the list falls back to KV
  const sp = spyIndexReads(e);
  const l = await list(e);
  assert.equal(l.body.clients.length, 3);
  assert.ok(sp.n >= 1, 'served from KV');
  assert.deepEqual(l.body.clients.map((x) => x.id).sort(), [a.id, b.id, c.id].sort());
  // the rebuild heals: dirty flag cleared, D1 serves again
  const r = await rebuild(e);
  assert.equal(r.rows, 3); assert.equal(dirty(e), false);
  const sp2 = spyIndexReads(e);
  const l2 = await list(e); assert.equal(l2.body.clients.length, 3); assert.equal(sp2.n, 0, 'served from D1 (no KV index read)');
  void realBatch;
});

test('D5: a hanging OWNER_DB is cut off by the timeout and does not fail the KV write', async () => {
  const e = mkEnv({ OWNER_DB_TIMEOUT_MS: '30' });
  const lic = await load('_license.js');
  e.OWNER_DB.prepare = ((p) => (sql) => { const s = p(sql); if (/INSERT INTO owner_clients/.test(sql)) return { ...s, bind: () => ({ run: () => new Promise(() => {}) }) }; return s; })(e.OWNER_DB.prepare);
  const t0 = Date.now();
  const a = await lic.createClient(e, 'permanent', 'Hang', 'shop');
  assert.ok(Date.now() - t0 < 1500);
  assert.ok(await lic.getLicense(e, a.id)); assert.ok(dirty(e));
});

test('D6: not healthy (never rebuilt) = KV reads; after the rebuild = D1 reads; kill switches force KV', async () => {
  const e = mkEnv();
  const lic = await load('_license.js');
  await lic.createClient(e, 'permanent', 'One', 'shop');
  assert.equal(await odb.mirrorHealthy(e), false, 'no synced_at yet');
  assert.equal(await odb.ownerDbRead(e, {}), null);
  await rebuild(e);
  assert.equal(await odb.mirrorHealthy(e), true);
  assert.ok(await odb.ownerDbRead(e, {}));
  assert.equal(await odb.ownerDbRead({ ...e, OWNER_DB_READS_DISABLED: '1' }, {}), null);
  assert.equal(await odb.ownerDbRead({ ...e, OWNER_DB_DISABLED: '1' }, {}), null);
  // a broken meta table also means KV
  const e2 = { ...e, OWNER_DB: makeD1() };
  assert.equal(await odb.ownerDbRead(e2, {}), null, 'tables do not exist -> null, no throw');
  // writes while the kill switch is on mark the mirror behind, so switching it off cannot serve stale rows
  const off = { ...e, OWNER_DB_DISABLED: '1' };
  await lic.createClient(off, 'permanent', 'Two', 'shop');
  assert.equal(dirty(e), true); assert.equal(await odb.ownerDbRead(e, {}), null);
});

test('D7: drift detection (missing, extra, different) and rebuild repairs it', async () => {
  const e = mkEnv();
  const lic = await load('_license.js');
  const a = await lic.createClient(e, 'permanent', 'A', 'shop'), b = await lic.createClient(e, 'permanent', 'B', 'shop'), c = await lic.createClient(e, 'permanent', 'C', 'shop');
  await rebuild(e);
  assert.equal((await odb.ownerDbStatus(e)).drift, 0);
  q(e.OWNER_DB, `delete from owner_clients where id = ?`, a.id);
  q(e.OWNER_DB, `insert into owner_clients (id, updated_at, summary_json) values ('ghost', 1, '{"id":"ghost"}')`);
  q(e.OWNER_DB, `update owner_clients set summary_json = replace(summary_json, '"B"', '"Zed"') where id = ?`, b.id);
  const s = await odb.ownerDbStatus(e);
  assert.equal(s.bound, true); assert.equal(s.rows, 3); assert.equal(s.kvRows, 3);
  assert.deepEqual(s.driftDetail.missing, [a.id]); assert.deepEqual(s.driftDetail.extra, ['ghost']); assert.deepEqual(s.driftDetail.different, [b.id]);
  assert.equal(s.drift, 3);
  const r = await rebuild(e);
  assert.equal(r.rows, 3);
  const s2 = await odb.ownerDbStatus(e);
  assert.equal(s2.drift, 0); assert.equal(s2.healthy, true); assert.ok(s2.syncedAt > 0);
  assert.equal(rows(e).some((x) => x.id === 'ghost'), false);
  void c;
  // idempotent
  const r2 = await rebuild(e); assert.equal(r2.rows, 3);
});

test('D8: a big rebuild is batched; a count mismatch (duplicate ids in the KV index) leaves reads on KV', async () => {
  const e = mkEnv();
  const idx = []; for (let i = 0; i < 230; i++) idx.push({ id: 'id' + i, slug: 's' + i, label: 'L' + i, type: 'permanent', product: 'shop', createdAt: 1000 + i });
  e.mydukapos_kv.data.set('license-index:v1', { value: JSON.stringify(idx) });
  const r = await rebuild(e); assert.equal(r.rows, 230);
  assert.equal(await odb.mirrorHealthy(e), true);
  idx.push({ id: 'id5', slug: 's5', label: 'dup', type: 'permanent', createdAt: 5 });
  e.mydukapos_kv.data.set('license-index:v1', { value: JSON.stringify(idx) });
  const bad = await odb.rebuildOwnerDb(e);
  assert.equal(bad.ok, false); assert.equal(bad.error, 'count_mismatch');
  assert.equal(await odb.mirrorHealthy(e), false, 'not marked synced');
});

test('D9: the console response is IDENTICAL from D1 and from KV (list, search, trash, person ledger)', async () => {
  const e = mkEnv();
  const lic = await load('_license.js');
  const realNow = Date.now; let t = 1_800_000_000_000; Date.now = () => (t += 7);
  try {
    const a = await lic.createClient(e, 'permanent', 'Acme Hardware', 'shop');
    const b = await lic.createClient(e, 'demo', 'Bravo Bar', 'hotel');
    const c = await lic.createClient(e, 'permanent', 'Clinic One', 'hospital');
    const d = await lic.createClient(e, 'permanent', 'Dead Shop', 'shop');
    await lock(e, { c: c.id, action: 'lock' });
    await lock(e, { c: a.id, action: 'recordRevenue', agreedAmount: 5000, paidAmount: 2000 });
    await lock(e, { c: a.id, action: 'remind', message: 'please pay' });
    await lic.updateIndexBusinessName(e, b.id, 'Bravo Ltd');
    await lock(e, { c: d.id, action: 'delete' });
    await lock(e, { c: a.id, action: 'recordGroupIncome', groupKey: 'jane doe', groupLabel: 'Jane Doe', agreedAmount: 1000, paidAmount: 500, note: 'x' });
    await lock(e, { c: a.id, action: 'recordGroupIncome', groupKey: 'jane doe', groupLabel: 'Jane Doe', agreedAmount: 300, paidAmount: 300, method: 'cash' });
    await lock(e, { c: a.id, action: 'recordGroupIncome', groupKey: 'bob', groupLabel: 'Bob', agreedAmount: 100 });
    await rebuild(e);
    for (const qs of ['', '?q=acme', '?q=BAR', '?trash=1', '?trash=1&q=dead', '?q=nomatch', '?q=%20ONE%20']) {
      const kvOnly = await list({ ...e, OWNER_DB_READS_DISABLED: '1' }, qs);
      const sp = spyIndexReads(e);
      const viaDb = await list(e, qs);
      assert.ok(sp.n <= (qs.includes('trash') ? 1 : 0), 'D1 served ' + qs + ' (the Trash tab sweep reads the index once, as before)');
      assert.equal(viaDb.status, 200);
      assert.deepEqual(strip(viaDb.body), strip(kvOnly.body), 'identical for "' + qs + '"');
    }
    const all = await list(e);
    assert.deepEqual(Object.keys(all.body.groupIncome), ['jane doe', 'bob']);
    assert.equal(all.body.groupIncome['jane doe'].entries.length, 2);
    assert.deepEqual(Object.keys(all.body).sort(), ['clients', 'groupIncome', 'products', 'rootDomain', 'serverNow']);
  } finally { Date.now = realNow; }
});

test('D10: person ledger: per-person rows follow writes; reset clears them; the single KV doc is still written', async () => {
  const e = mkEnv();
  const lic = await load('_license.js');
  const a = await lic.createClient(e, 'permanent', 'Ledger', 'shop');
  await lock(e, { c: a.id, action: 'recordGroupIncome', groupKey: 'p1', groupLabel: 'P1', agreedAmount: 10, paidAmount: 5 });
  await lock(e, { c: a.id, action: 'recordGroupIncome', groupKey: 'p2', groupLabel: 'P2', agreedAmount: 20, paidAmount: 20 });
  await lock(e, { c: a.id, action: 'recordGroupIncome', groupKey: 'p1', groupLabel: 'P1', agreedAmount: 7, paidAmount: 7 });
  const r = q(e.OWNER_DB, `select * from owner_group_income order by person_key`);
  assert.deepEqual(r.map((x) => x.person_key), ['p1', 'p2']);
  assert.equal(JSON.parse(r[0].data_json).entries.length, 2);
  assert.deepEqual(JSON.parse(e.mydukapos_kv.data.get('owner-group-income:v1').value).p1.entries.length, 2, 'KV doc still the truth');
  const res = await lock(e, { action: 'resetAllIncome', c: a.id });
  assert.equal(res.status, 200);
  assert.equal(q(e.OWNER_DB, `select count(*) n from owner_group_income`)[0].n, 0);
  assert.equal(e.mydukapos_kv.data.has('owner-group-income:v1'), false);
});

test('D11: no secret fields reach D1 (rows scanned; secret-looking keys in an index entry are dropped)', async () => {
  const e = mkEnv();
  const lic = await load('_license.js');
  const a = await lic.createClient(e, 'permanent', 'Secretive', 'shop');
  // the owner account record, with its hash, is KV-only
  e.mydukapos_kv.data.set('owner-account:v1', { value: JSON.stringify({ ownerClientId: a.id, passwordHash: 'H'.repeat(64), salt: 'S', identifier: 'o@x.com' }) });
  const idx = kvIndex(e);
  idx.push({ id: 'evil', slug: 'evil', type: 'permanent', label: 'Evil', createdAt: 5, passwordHash: 'abc', pinHash: 'def', token: 'tok', apiSecret: 'sss', pin: '1234' });
  e.mydukapos_kv.data.set('license-index:v1', { value: JSON.stringify(idx) });
  await lock(e, { c: a.id, action: 'lock' });
  await rebuild(e);
  await odb.mirrorClient(e, idx[idx.length - 1]);
  const dump = JSON.stringify([rows(e), q(e.OWNER_DB, `select * from owner_meta`), q(e.OWNER_DB, `select * from owner_group_income`)]);
  assert.ok(!/passwordHash|pinHash|"token"|apiSecret|"pin"|HHHHHHHH|abc|def|sss|1234|o@x\.com/i.test(dump.replace(/"id":"[^"]*"/g, '')), 'no secret value or key stored');
  for (const r of rows(e)) for (const k of Object.keys(JSON.parse(r.summary_json))) assert.ok(!/hash|pin|token|password|secret|salt/i.test(k), 'key ' + k);
  const cols = q(e.OWNER_DB, `pragma table_info(owner_clients)`).map((c) => c.name);
  assert.ok(!cols.some((c) => /hash|pin|token|password|secret/i.test(c)));
  assert.equal((await list(e)).body.clients.some((c) => c.id === 'evil'), true, 'the console still shows it (KV-shaped entry without the secrets)');
});

test('D12: search filter: % and _ and backslash are literals, case-insensitive, same results as KV', async () => {
  const e = mkEnv();
  const idx = [
    { id: '1', slug: 'a-b', label: 'a%b', type: 'permanent', createdAt: 10 },
    { id: '2', slug: 'axb', label: 'axb', type: 'permanent', createdAt: 20 },
    { id: '3', slug: 'under', label: 'my_shop', type: 'permanent', createdAt: 30 },
    { id: '4', slug: 'plain', label: 'myXshop', type: 'permanent', createdAt: 40 },
    { id: '5', slug: 'back', label: 'c:\\dir', type: 'permanent', createdAt: 50 },
    { id: '6', slug: 'hundred', label: '100% Sure', type: 'permanent', createdAt: 60 },
    { id: '7', slug: 'caps', label: 'LOUD NAME', type: 'permanent', createdAt: 70 },
  ];
  e.mydukapos_kv.data.set('license-index:v1', { value: JSON.stringify(idx) });
  await rebuild(e);
  const ids = async (qq, env) => (await list(env, '?q=' + encodeURIComponent(qq))).body.clients.map((c) => c.id);
  const kvEnv = { ...e, OWNER_DB_READS_DISABLED: '1' };
  const expect = { 'a%b': ['1'], '%': ['1', '6'].reverse(), '_': ['3'], 'my_s': ['3'], '\\': ['5'], 'loud': ['7'], 'NAME': ['7'], 'a_b': [], '100%': ['6'], '%%': [], 'zzz': [] };
  for (const [needle, want] of Object.entries(expect)) {
    const sp = spyIndexReads(e);
    const viaDb = await ids(needle, e);
    assert.equal(sp.n, 0, 'D1 served ' + needle);
    assert.deepEqual(viaDb, await ids(needle, kvEnv), 'same as KV for ' + JSON.stringify(needle));
    assert.deepEqual(viaDb, want, 'literal match for ' + JSON.stringify(needle));
  }
  assert.equal(await odb.ownerDbRead(e, { q: 'caf\u00e9' }), null, 'non-ASCII needle is left to KV');
  // slug matches too, and newest-first order
  assert.deepEqual(await ids('a', e), await ids('a', kvEnv));
});

test('D13: trash filter: live and trash lists are disjoint, trash newest-deleted first, from D1 as from KV', async () => {
  const e = mkEnv();
  const lic = await load('_license.js');
  const x = await lic.createClient(e, 'permanent', 'X', 'shop'), y = await lic.createClient(e, 'permanent', 'Y', 'shop'), z = await lic.createClient(e, 'permanent', 'Z', 'shop');
  await lic.deleteClient(e, x.id); await new Promise((r) => setTimeout(r, 5)); await lic.deleteClient(e, y.id);
  await rebuild(e);
  const live = await odb.ownerDbRead(e, {}), trash = await odb.ownerDbRead(e, { trashOnly: true });
  assert.deepEqual(live.summaries.map((s) => s.id), [z.id]);
  assert.deepEqual(trash.summaries.map((s) => s.id), [y.id, x.id]);
  assert.deepEqual(trash.summaries, await lic.listClientSummaries(e, { trashOnly: true }));
  assert.deepEqual(live.summaries, await lic.listClientSummaries(e, {}));
  // an entry flagged deleted with no timestamp is still Trash (same test as KV)
  const idx = kvIndex(e); idx.push({ id: 'odd', slug: 'odd', type: 'permanent', deleted: true, createdAt: 1 });
  e.mydukapos_kv.data.set('license-index:v1', { value: JSON.stringify(idx) }); await rebuild(e);
  assert.deepEqual((await odb.ownerDbRead(e, { trashOnly: true })).summaries.map((s) => s.id), (await lic.listClientSummaries(e, { trashOnly: true })).map((s) => s.id));
  // legacy id-only index entries survive
  await new Promise((r) => setTimeout(r, 5));
  e.mydukapos_kv.data.set('license-index:v1', { value: JSON.stringify(['legacy1']) }); await rebuild(e);
  assert.deepEqual((await odb.ownerDbRead(e, {})).summaries, [{ id: 'legacy1' }]);
});

test('D14: the owner-db route: owner session required; GET status; POST rebuild; unbound answers clearly', async () => {
  const m = await load('owner-db.js');
  const e = mkEnv();
  const lic = await load('_license.js');
  await lic.createClient(e, 'permanent', 'Route', 'shop');
  const anon = new Request('https://x.pages.dev/api/owner-db', { method: 'GET' });
  assert.equal((await m.onRequestGet({ request: anon, env: e })).status, 401);
  assert.equal((await m.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-db', { method: 'POST', body: '{"action":"rebuild"}' }), env: e })).status, 401);
  const g = await (await m.onRequestGet({ request: req('GET'), env: e })).json();
  assert.equal(g.bound, true); assert.equal(g.healthy, false); assert.equal(g.kvRows, 1); assert.equal(g.drift, 0, 'write-through already mirrored it'); assert.equal(g.syncedAt, null);
  assert.equal((await m.onRequestPost({ request: req('POST', { action: 'nope' }), env: e })).status, 400);
  const p = await m.onRequestPost({ request: req('POST', { action: 'rebuild' }), env: e });
  const pb = await p.json();
  assert.equal(p.status, 200); assert.equal(pb.ok, true); assert.equal(pb.status.healthy, true); assert.equal(pb.status.drift, 0); assert.equal(pb.rows, 1);
  const u = noDb(); u.mydukapos_kv.data.set('owner-session:tok', { value: '1' });
  const ur = await m.onRequestPost({ request: req('POST', { action: 'rebuild' }), env: u });
  assert.equal(ur.status, 409);
  assert.deepEqual(await (await m.onRequestGet({ request: req('GET'), env: u })).json(), { bound: false, healthy: false });
});

test('D15: setup tool: adds the OWNER_DB binding once, never duplicates, ignores a commented example', () => {
  const id = '22f9b35e-d4d9-468d-ac8c-2b3ff6b3848d';
  assert.equal(parseDatabaseId('database_id = "' + id + '"'), id);
  const a = patchToml('name = "x"\n', 'mydukapos-owner', id);
  assert.ok(a.changed); assert.match(a.text, /binding = "OWNER_DB"/); assert.match(a.text, /database_name = "mydukapos-owner"/);
  const b = patchToml(a.text, 'mydukapos-owner', id); assert.equal(b.changed, false); assert.equal(b.text, a.text);
  assert.equal(patchToml('# binding = "OWNER_DB"  (example)\n', 'mydukapos-owner', id).changed, true);
  assert.equal(patchToml('[[d1_databases]]\nbinding = "LEDGER_AUDIT_DB"\n', 'mydukapos-owner', id).changed, true, 'other bindings do not count');
});

test('D16: licence and login code never read OWNER_DB (static check) and shop paths work with a dead OWNER_DB', async () => {
  const src = (f) => fs.readFileSync(path.join(ROOT, 'functions/api', f), 'utf8');
  const lic = src('_license.js').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.equal((lic.match(/OWNER_DB/g) || []).length, 0, '_license.js does not name OWNER_DB');
  assert.deepEqual([...lic.matchAll(/mirror\w+\(/g)].map((m) => m[0]).sort(), ['mirrorClient(', 'mirrorClient(', 'mirrorRemove('], 'only the three write-through hooks');
  for (const f of ['license-status.js', 'owner-auth.js', '_owner-auth.js', 'pos-sync.js']) if (fs.existsSync(path.join(ROOT, 'functions/api', f))) assert.ok(!/_owner-db\.js/.test(src(f)), f + ' does not import the read model');
  const e = mkEnv();
  const l = await load('_license.js');
  const a = await l.createClient(e, 'permanent', 'Live', 'shop');
  e.OWNER_DB = { prepare() { throw new Error('dead'); }, batch() { throw new Error('dead'); } };
  const r = await l.requireValidLicense(new Request('https://x.pages.dev/api/x?c=' + a.id), e);
  assert.equal(r.valid, true);
  await l.saveLicense(e, { ...a, locked: true });
  assert.equal(l.evaluateLicense(await l.getLicense(e, a.id)).reason, 'locked');
});
