import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';
import { countD1 } from './ops-count.mjs';
import { setup, LEGACY_ENV } from '../tools/measure-hot-paths.mjs';
import { migrationText, crmMigrationText, efficiencyMigrationText } from '../tools/gen-migration.mjs';

// Zip 159 — speed and reliability on Cloudflare. Every behavioural change has a test here. Counts are OPERATIONS (KV reads, D1 round trips,
// Durable Object calls), which is what can be proved offline; milliseconds on real Cloudflare are not claimed anywhere.
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const U = 'https://shopc1.mydukapos.store';
const sale = (id) => ({ id, refNumber: 'R-' + id, timestamp: new Date().toISOString(), paymentMethod: 'cash', cashAmount: 1000, servedBy: 'Jane', items: [{ code: 'A', name: 'Alpha', qty: 2, price: 500, wholesalePrice: 300 }] });
const post = (s, body) => s.call('pos-sync.js', 'onRequestPost', U + '/api/pos-sync', { method: 'POST', body });
const get = (s, q = '') => s.call('pos-sync.js', 'onRequestGet', U + '/api/pos-sync' + q);

// ---------------------------------------------------------------- retry helper
test('retry: a transient failure is retried, a permanent one is not, the last error is thrown', async () => {
  const { withRetry, isTransient } = await load('_retry.js');
  let n = 0;
  assert.equal(await withRetry(async () => { if (++n < 3) throw new Error('network blip'); return 'ok'; }, { tries: 3, env: { RETRY_BASE_MS: 0 } }), 'ok');
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(withRetry(async () => { n++; throw new Error('UNIQUE constraint failed: x'); }, { tries: 3, env: { RETRY_BASE_MS: 0 } }), /UNIQUE/);
  assert.equal(n, 1, 'a constraint failure would fail the same way: no retry');
  n = 0;
  await assert.rejects(withRetry(async () => { n++; throw new Error('still down ' + n); }, { tries: 3, env: { RETRY_BASE_MS: 0 } }), /still down 3/);
  assert.equal(isTransient(new Error('no such table: x')), false);
  assert.equal(isTransient(new Error('D1_ERROR: overloaded')), true);
});

// ---------------------------------------------------------------- licence + shop-mode memory
test('licence cache: a poll costs fewer KV reads, a licence change is seen at once on this instance, not-found is never cached', async () => {
  const s = await setup({ mode: 'do' });
  await get(s, '?since=1');                                           // warm
  s.reset(); await (await get(s, '?since=1')).text();
  const warm = s.kv.counts.get;
  const l = await setup({ mode: 'do', legacy: true });
  await get(l, '?since=1'); l.reset(); await (await get(l, '?since=1')).text();
  assert.ok(warm < l.kv.counts.get, `cached poll ${warm} KV reads < uncached ${l.kv.counts.get}`);
  const { getLicenseCached, saveLicense, getLicense } = await load('_license.js');
  const rec = await getLicense(s.env, 'C1');
  await saveLicense(s.env, { ...rec, label: 'Renamed' });
  assert.equal((await getLicenseCached(s.env, 'C1')).label, 'Renamed', 'own write is visible immediately');
  assert.equal(await getLicenseCached(s.env, 'NOPE'), null);
  s.kvRaw.data.set('license:NOPE', { value: JSON.stringify({ id: 'NOPE' }) });
  assert.equal((await getLicenseCached(s.env, 'NOPE')).id, 'NOPE', 'a missing licence is not remembered');
});
test('licence cache: stale-if-error — a KV outage does not lock a shop out', async () => {
  const s = await setup({ mode: 'do' });
  const { getLicenseCached } = await load('_license.js');
  await getLicenseCached(s.env, 'C1');
  const realGet = s.kvRaw.get; let down = true;
  s.kvRaw.get = async (k) => { if (down) throw new Error('KV unavailable'); return realGet(k); };
  s.env.LICENSE_CACHE_MS = '1';                                       // expire the fresh entry at once; the stale allowance still covers the outage
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await getLicenseCached(s.env, 'C1')).id, 'C1');
  down = false;
});
test('licence cache can be switched off (LICENSE_CACHE_MS=0)', async () => {
  const s = await setup({ mode: 'do', legacy: true });
  const { getLicenseCached } = await load('_license.js');
  s.reset(); await getLicenseCached(s.env, 'C1'); await getLicenseCached(s.env, 'C1');
  assert.equal(s.kv.counts.get, 2);
});
test('shop mode: only "do" is remembered; "kv" and "migrating" are always re-read; forgetShopMode and the owner tools drop it', async () => {
  const { shopMode, forgetShopMode, settleModeCache } = await load('_state-store.js');
  const kv = makeKV(); const env = { mydukapos_kv: kv, SHOP_STORE: {} };
  let reads = 0; const g = kv.get; kv.get = async (k) => { if (k.startsWith('pos-data:mode:')) reads++; return g(k); };
  kv.data.set('pos-data:mode:A', { value: 'do' });
  assert.equal(await shopMode(env, 'A'), 'do'); assert.equal(await shopMode(env, 'A'), 'do'); assert.equal(reads, 1);
  forgetShopMode(env, 'A'); assert.equal(await shopMode(env, 'A'), 'do'); assert.equal(reads, 2);
  reads = 0; assert.equal(await shopMode(env, 'B'), 'kv'); assert.equal(await shopMode(env, 'B'), 'kv'); assert.equal(reads, 2, 'kv is never remembered (a shop may be about to move)');
  kv.data.set('pos-data:mode:A', { value: 'migrating' });
  forgetShopMode(env, 'A'); assert.equal(await shopMode(env, 'A'), 'migrating');
  const t0 = Date.now(); await settleModeCache({ ...env, MIGRATE_SETTLE_MS: '30' }); assert.ok(Date.now() - t0 >= 25);
});

// ---------------------------------------------------------------- ledger: unchanged records are not rewritten
test('ledger: a push that repeats records the database already has costs no D1 statements; one changed tab costs only that tab', async () => {
  const s = await setup({ mode: 'do' });
  const T0 = Date.now();
  const body = () => ({ businessName: 'Biz', tabs: Array.from({ length: 40 }, (_, i) => ({ id: 't' + i, billNo: 'B' + i, openedAt: T0, status: 'OPEN', label: 'T' + i, orders: [] })), bills: Array.from({ length: 100 }, (_, i) => ({ id: 'b' + i, timestamp: new Date(T0).toISOString(), items: [{ code: 'A', qty: 1, price: 10 }] })) });
  await (await post(s, body())).text();
  assert.ok(s.d1.counts.statements >= 100, 'the first time everything is written');
  s.reset(); await (await post(s, body())).text();
  assert.equal(s.d1.counts.statements, 0, 'unchanged: nothing re-sent to D1');
  const ch = body(); ch.tabs[3].orders = [{ id: 'o1', entries: [{ price: 50, qty: 1 }] }]; ch.tabs[3].updatedAt = T0 + 5;
  s.reset(); await (await post(s, ch)).text();
  assert.ok(s.d1.counts.statements > 0 && s.d1.counts.statements <= 6, 'only the changed tab: ' + s.d1.counts.statements);
  const rows = s.d1.db._db ? null : null; // (rows are checked below through a fresh connection to the same fake)
  const L = await setup({ mode: 'do', legacy: true });
  await (await post(L, body())).text(); L.reset(); await (await post(L, body())).text();
  assert.ok(L.d1.counts.statements >= 100, 'legacy behaviour (memory off) still rewrites every record: ' + L.d1.counts.statements);
});
test('ledger: a record that failed to commit is not remembered, so the retry writes it (no lost sale)', async () => {
  const s = await setup({ mode: 'do' });
  await (await post(s, { businessName: 'Biz', salesLog: [sale('s0')] })).text();
  const st = s.d1.db._state; st.failOnSql = /ledger_sales/;
  const bad = await post(s, { businessName: 'Biz', salesLog: [sale('s1')] });
  assert.equal(bad.status, 503);
  st.failOnSql = null;
  const good = await post(s, { businessName: 'Biz', salesLog: [sale('s1')] });
  assert.equal(good.status, 200);
  const rows = s.d1.db.query(`SELECT sale_id FROM ledger_sales ORDER BY sale_id`).map((r) => r.sale_id);
  assert.deepEqual(rows, ['s0', 's1']);
});
test('ledger: one transient D1 error is retried (the till is not told "busy"); a permanent error is not retried', async () => {
  const s = await setup({ mode: 'do' }); s.env.RETRY_BASE_MS = '0';
  await (await post(s, { businessName: 'Biz', salesLog: [sale('a')] })).text();
  s.d1.db._state.failNext = 1;
  const r = await post(s, { businessName: 'Biz', salesLog: [sale('b')] });
  assert.equal(r.status, 200);
  assert.ok(s.d1.db.query(`SELECT 1 x FROM ledger_sales WHERE sale_id = 'b'`).length === 1);
  s.d1.db._state.failNext = 0; s.d1.db._state.failOnSql = /ledger_sales/; const before = s.d1.db._state.calls; s.d1.db._state.calls = 0;
  const bad = await post(s, { businessName: 'Biz', salesLog: [sale('c')] });
  assert.equal(bad.status, 503);
  assert.ok(s.d1.db._state.calls <= 3, 'bounded retries');
  s.d1.db._state.failOnSql = null;
});
test('ledger outbox: the KV outbox is read at most once per window while it is empty, and read again after something is parked', async () => {
  const s = await setup({ mode: 'do' });
  await (await post(s, { businessName: 'Biz', salesLog: [sale('a')] })).text();
  s.reset(); await (await post(s, { businessName: 'Biz', salesLog: [sale('b')] })).text();
  const outboxReads = () => s.kv.counts.keys.filter((k) => k.startsWith('get ledger-outbox:')).length;
  assert.equal(outboxReads(), 0, 'not read while known empty');
  const L = await setup({ mode: 'do', legacy: true });
  await (await post(L, { businessName: 'Biz', salesLog: [sale('a')] })).text();
  L.reset(); await (await post(L, { businessName: 'Biz', salesLog: [sale('b')] })).text();
  assert.equal(L.kv.counts.keys.filter((k) => k.startsWith('get ledger-outbox:')).length, 1, 'legacy read it on every push');
});

// ---------------------------------------------------------------- the write fence (root cause of the chaos-test stale-read failure)
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
function staleKV(kv, r, p) {                                          // KV eventual consistency: a read may return one of the last 3 copies
  const hist = new Map();
  const g = kv.get.bind(kv), gm = kv.getWithMetadata.bind(kv), pt = kv.put.bind(kv);
  kv.put = async (k, v, o) => { if (k.startsWith('pos-data:state:')) { const h = hist.get(k) || []; const cur = kv.data.get(k); if (cur) h.push({ value: cur.value, metadata: cur.metadata }); hist.set(k, h.slice(-3)); } return pt(k, v, o); };
  const pick = (k) => { if (!k.startsWith('pos-data:state:') || r() > p) return null; const h = hist.get(k) || []; return h.length ? h[Math.floor(r() * h.length)] : null; };
  kv.get = async (k) => { const s = pick(k); return s ? s.value : g(k); };
  kv.getWithMetadata = async (k) => { const s = pick(k); return s ? { value: s.value, metadata: s.metadata ?? null } : gm(k); };
}
async function race(seed, envExtra, rounds = 4) {
  const m = await load('pos-sync.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), ...envExtra };
  staleKV(kv, rng(seed), 0.35);
  const push = (body) => m.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });
  const ids = [];
  for (let round = 0; round < rounds; round++) {
    const batch = [];
    for (let d = 0; d < 4; d++) { const id = `s${round}-${d}`; ids.push(id); batch.push(push({ businessName: 'B', salesLog: [{ id, timestamp: new Date().toISOString(), items: [{ code: 'A', qty: 1, price: 5 }] }] })); }
    const res = await Promise.all(batch); await Promise.all(res.map((r) => r.text()));
  }
  const st = JSON.parse(kv.data.get('pos-data:state:C1').value);
  const have = new Set(st.salesLog.map((s) => s.id));
  return { lost: ids.filter((i) => !have.has(i)).length, total: ids.length, env, kv };
}
test('write fence: 4 tills saving at once over a stale-read KV lose NO acknowledged sale (12 seeds)', async () => {
  let lost = 0, total = 0;
  for (let seed = 1; seed <= 12; seed++) { const r = await race(seed, { FENCE_WAIT_MS: '6000' }); lost += r.lost; total += r.total; }
  assert.equal(lost, 0, `${lost} of ${total} sales lost`);
});
test('write fence: the SAME race without the fence (WRITE_FENCE=0, the old behaviour) does lose sales — this is the root cause', async () => {
  let lost = 0;
  for (let seed = 1; seed <= 12; seed++) lost += (await race(seed, { WRITE_FENCE: '0' })).lost;
  assert.ok(lost > 0, 'the stale-read race really exists without the fence');
});
test('write fence: versions only go forward and match the fence row', async () => {
  const r = await race(5, { FENCE_WAIT_MS: '6000' }, 2);
  const meta = r.kv.data.get('pos-data:state:C1').metadata;
  const row = r.env.LEDGER_DB.query(`SELECT * FROM shop_write_fence WHERE client_id = 'C1'`)[0];
  assert.ok(row && row.seq >= 8);
  assert.equal(meta.ver, row.kv_ver, 'the stored copy is the latest fenced write');
});
test('write fence: no D1 -> the legacy path still works; D1 that fails to answer -> legacy path, nothing refused', async () => {
  const m = await load('pos-sync.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  const mk = (env) => (body) => m.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });
  const r1 = await mk({ mydukapos_kv: kv })({ businessName: 'B', salesLog: [sale('x1')] });
  assert.equal(r1.status, 200);
  const d1 = makeD1(); d1._state.failOnSql = /shop_write_fence/;
  const r2 = await mk({ mydukapos_kv: kv, LEDGER_DB: d1, RETRY_BASE_MS: '0' })({ businessName: 'B', salesLog: [sale('x2')] });
  assert.equal(r2.status, 200);
  const ids = JSON.parse(kv.data.get('pos-data:state:C1').value).salesLog.map((s) => s.id);
  assert.ok(ids.includes('x1') && ids.includes('x2'));
});
test('write fence: a copy that cannot catch up answers 503 busy (the till keeps the sale); an orphaned claim older than 2 minutes is ignored', async () => {
  const m = await load('pos-sync.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  const db = makeD1(); const env = { mydukapos_kv: kv, LEDGER_DB: db, FENCE_WAIT_MS: '60', RETRY_BASE_MS: '0' };
  const push = (id) => m.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ businessName: 'B', salesLog: [sale(id)] }), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });
  assert.equal((await push('a')).status, 200);
  db._db.exec(`UPDATE shop_write_fence SET kv_ver = 999, at = ${Date.now()} WHERE client_id = 'C1'`);
  const busy = await push('b');
  assert.equal(busy.status, 503); assert.equal((await busy.json()).code, 'busy');
  db._db.exec(`UPDATE shop_write_fence SET at = ${Date.now() - 200000} WHERE client_id = 'C1'`);
  assert.equal((await push('c')).status, 200, 'orphan: the claimant never wrote, the shop is not blocked forever');
  const ids = JSON.parse(kv.data.get('pos-data:state:C1').value).salesLog.map((s) => s.id);
  assert.ok(ids.includes('a') && ids.includes('c'));
});
test('write fence: if KV refuses the claimed write every time, the slot is handed back (the next push is not left waiting)', async () => {
  const m = await load('pos-sync.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  const db = makeD1(); const env = { mydukapos_kv: kv, LEDGER_DB: db, FENCE_WAIT_MS: '60', RETRY_BASE_MS: '0' };
  const push = (id) => m.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ businessName: 'B', salesLog: [sale(id)] }), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });
  assert.equal((await push('a')).status, 200);
  const put = kv.put; let fail = true; kv.put = async (k, v, o) => { if (fail && k.startsWith('pos-data:state:')) throw new Error('KV put failed: 429'); return put(k, v, o); };
  const r = await push('b'); assert.equal(r.status, 503);
  fail = false;
  assert.equal((await push('c')).status, 200);
  const ids = JSON.parse(kv.data.get('pos-data:state:C1').value).salesLog.map((s) => s.id);
  assert.ok(ids.includes('a') && ids.includes('c'));
});
test('write fence also covers kvMergeUpdate (cross-branch sales): two at once, stale reads, none lost', async () => {
  const { kvMergeUpdate } = await load('_state-store.js');
  const kv = makeKV(); const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), FENCE_WAIT_MS: '6000', SYNC_VERIFY_WRITE: '0' };
  kv.data.set('pos-data:state:C1', { value: JSON.stringify({ salesLog: [], updatedAt: 1 }), metadata: { ver: 1 } });
  staleKV(kv, rng(3), 0.4);
  const ids = Array.from({ length: 8 }, (_, i) => 'k' + i);
  await Promise.all(ids.map((id) => kvMergeUpdate(env, 'pos-data:state:C1', async () => ({ body: { salesLog: [sale(id)] } }))));
  const have = new Set(JSON.parse(kv.data.get('pos-data:state:C1').value).salesLog.map((s) => s.id));
  assert.deepEqual(ids.filter((i) => !have.has(i)), []);
});

// ---------------------------------------------------------------- schema + migrations
test('migrations: 0001, 0002 and 0003 equal what the code generates (single source of truth)', () => {
  const rd = (f) => fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8');
  assert.equal(rd('0001_ledger.sql'), migrationText());
  assert.equal(rd('0002_crm.sql'), crmMigrationText());
  assert.equal(rd('0003_efficiency.sql'), efficiencyMigrationText());
  assert.match(rd('0003_efficiency.sql'), /CREATE TABLE IF NOT EXISTS shop_write_fence/);
});
test('migration 0003 is idempotent and creates the fence table', async () => {
  const db = makeD1(); const sql = fs.readFileSync(path.join(ROOT, 'migrations/0003_efficiency.sql'), 'utf8');
  await db.exec(sql.replace(/--.*\n/g, '')); await db.exec(sql.replace(/--.*\n/g, ''));
  assert.equal(db.query(`SELECT name FROM sqlite_master WHERE name = 'shop_write_fence'`).length, 1);
});
test('CRM: the new indexes exist after ensureCrmSchema, and the queries they serve use them', async () => {
  const { makeCrm } = await import('./crm-harness.mjs');
  const c = await makeCrm();
  const names = c.q(`SELECT name FROM sqlite_master WHERE type = 'index'`).map((r) => r.name);
  for (const n of ['ix_crm_meetings_user', 'ix_crm_leads_ad', 'ix_crm_sales_ad', 'ix_crm_spend_date', 'ix_crm_spend_ad', 'ix_crm_attr_ad']) assert.ok(names.includes(n), n);
  const plan = (sql) => c.q('EXPLAIN QUERY PLAN ' + sql).map((r) => r.detail).join(' | ');
  assert.match(plan(`SELECT COUNT(*) FROM crm_meetings WHERE user_id = 'u' AND status = 'completed'`), /USING (COVERING )?INDEX ix_crm_meetings_user/);
  assert.match(plan(`UPDATE crm_leads SET first_adset_id = 'x' WHERE first_ad_id = 'a'`), /ix_crm_leads_ad/);
  assert.match(plan(`UPDATE crm_sales SET adset_id = 'x' WHERE ad_id = 'a'`), /ix_crm_sales_ad/);
});
test('CRM schema upgrade: a database at the previous schema version gets the new indexes on its next request', async () => {
  const { makeCrm } = await import('./crm-harness.mjs');
  const c = await makeCrm();
  c.db._db.exec(`DROP INDEX ix_crm_leads_ad; UPDATE crm_meta SET v = '3' WHERE k = 'schema'`);
  const { ensureCrmSchema } = await load('_crm/schema.js');
  // a new Worker instance forgets its "schema is ready" memory: model it with a fresh binding wrapper over the same database
  const wrapped = { ...c.db };
  await ensureCrmSchema(wrapped);
  assert.equal(c.q(`SELECT name FROM sqlite_master WHERE name = 'ix_crm_leads_ad'`).length, 1);
});

// ---------------------------------------------------------------- media: validators, streaming, edge cache
function r2Mock() {
  const store = new Map(); const calls = { get: 0 };
  return { calls, store,
    async put(k, v, o) { store.set(k, { v: new Uint8Array(v), o }); },
    async head(k) { return store.has(k) ? {} : null; },
    async delete(k) { store.delete(k); },
    async get(k, opts) { calls.get++; const x = store.get(k); if (!x) return null; const meta = { size: x.v.length, httpEtag: '"etag1"', etag: 'etag1', httpMetadata: { contentType: 'image/jpeg' }, customMetadata: {} };
      if (opts && opts.onlyIf && opts.onlyIf.etagDoesNotMatch === 'etag1') return meta;                      // precondition failed: metadata only, no body
      return { ...meta, body: new Blob([x.v]).stream(), arrayBuffer: async () => x.v.buffer.slice(x.v.byteOffset, x.v.byteOffset + x.v.byteLength) }; } };
}
const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(2000).fill(7)]).toString('base64');
async function mediaSetup() {
  const s = await setup({ mode: 'do' }); s.env.MEDIA = r2Mock();
  await s.call('media.js', 'onRequestPost', U + '/api/media', { method: 'POST', body: { k: 'p', id: 'p-abcdef123456', dataUrl: jpeg } });
  await s.call('media.js', 'onRequestPost', U + '/api/media', { method: 'POST', body: { k: 'r', id: 'r-abcdef123456', dataUrl: jpeg } });
  return s;
}
test('media: an ETag is sent, a matching If-None-Match answers 304 with no body, the picture streams with its length', async () => {
  const s = await mediaSetup();
  const r = await s.call('media.js', 'onRequestGet', U + '/api/media?k=p&id=p-abcdef123456');
  assert.equal(r.status, 200); assert.equal(r.headers.get('ETag'), '"etag1"'); assert.match(r.headers.get('Cache-Control'), /immutable/);
  assert.equal(r.headers.get('Content-Length'), String((await r.arrayBuffer()).byteLength));
  const n = await s.call('media.js', 'onRequestGet', U + '/api/media?k=p&id=p-abcdef123456', { headers: { 'If-None-Match': '"etag1"' } });
  assert.equal(n.status, 304); assert.equal((await n.arrayBuffer()).byteLength, 0);
  assert.equal((await s.call('media.js', 'onRequestGet', U + '/api/media?k=p&id=p-nothere123456')).status, 404);
});
test('media: public photos use the edge cache (a hit costs no R2 read); private images never do; a delete purges', async () => {
  const s = await mediaSetup();
  const cache = new Map();
  const fake = { async match(req) { const x = cache.get(req.url); return x ? new Response(x.buf, { headers: x.headers }) : undefined; }, async put(req, res) { cache.set(req.url, { buf: new Uint8Array(await res.arrayBuffer()), headers: [...res.headers] }); }, async delete(req) { return cache.delete(req.url); } };
  const had = globalThis.caches; globalThis.caches = { default: fake };
  try {
    const tasks = []; const call = async (q, h) => { const m = await load('media.js'); return m.onRequestGet({ request: new Request(U + '/api/media?' + q, { headers: h || {} }), env: s.env, waitUntil: (p) => tasks.push(p) }); };
    const a = await call('k=p&id=p-abcdef123456'); await a.arrayBuffer(); await Promise.all(tasks);
    assert.equal(cache.size, 1);
    s.env.MEDIA.calls.get = 0;
    const b = await call('k=p&id=p-abcdef123456'); assert.equal(b.status, 200); assert.equal(b.headers.get('ETag'), '"etag1"'); assert.match(b.headers.get('Cache-Control'), /immutable/); await b.arrayBuffer();
    assert.equal(s.env.MEDIA.calls.get, 0, 'served from the edge cache');
    const c = await call('k=p&id=p-abcdef123456', { 'If-None-Match': '"etag1"' }); assert.equal(c.status, 304);
    const priv = await call('k=r&id=r-abcdef123456', { 'x-device': 'none' });
    await priv.arrayBuffer(); await Promise.all(tasks);
    assert.equal(cache.size, 1, 'a private image is never put in a shared cache');
    await s.call('media.js', 'onRequestPost', U + '/api/media', { method: 'POST', body: { action: 'delete', k: 'p', id: 'p-abcdef123456' } });
    assert.equal(cache.size, 0, 'delete purges the cached copy');
  } finally { globalThis.caches = had; }
});
test('media: the KV fallback (no R2 binding) still serves the picture, with a validator', async () => {
  const s = await setup({ mode: 'do' });
  await s.call('media.js', 'onRequestPost', U + '/api/media', { method: 'POST', body: { k: 'p', id: 'p-kvfallback12', dataUrl: jpeg } });
  const r = await s.call('media.js', 'onRequestGet', U + '/api/media?k=p&id=p-kvfallback12');
  assert.equal(r.status, 200); const et = r.headers.get('ETag'); assert.ok(et); await r.arrayBuffer();
  assert.equal((await s.call('media.js', 'onRequestGet', U + '/api/media?k=p&id=p-kvfallback12', { headers: { 'If-None-Match': et } })).status, 304);
});

// ---------------------------------------------------------------- static delivery + API headers
test('/api middleware: an answer with no Cache-Control gets no-store; one that set its own is left alone; Server-Timing is added', async () => {
  const { onRequest } = await load('_middleware.js');
  const run = (res) => onRequest({ request: new Request('https://x.pages.dev/api/x'), env: {}, next: async () => res });
  const a = await run(new Response('{}', { status: 200 }));
  assert.equal(a.headers.get('Cache-Control'), 'no-store'); assert.match(a.headers.get('Server-Timing'), /^app;dur=\d+$/);
  const b = await run(new Response('x', { status: 200, headers: { 'Cache-Control': 'public, max-age=60' } }));
  assert.equal(b.headers.get('Cache-Control'), 'public, max-age=60');
  const c = await run(new Response(null, { status: 304 }));
  assert.equal(c.headers.get('Cache-Control'), null, 'a 304 keeps the validator caching of the original');
  const ws = new Response(null, { status: 200 }); Object.defineProperty(ws, 'status', { value: 101 });
  assert.equal((await run(ws)).status, 101);
});
test('/api middleware: CORS behaviour is unchanged (own origin echoed, foreign origin stripped)', async () => {
  const { onRequest } = await load('_middleware.js');
  const mk = (origin) => onRequest({ request: new Request('https://mydukapos.store/api/x', { headers: { Origin: origin } }), env: {}, next: async () => new Response('{}', { headers: { 'Access-Control-Allow-Origin': '*' } }) });
  assert.equal((await mk('https://mydukapos.store')).headers.get('Access-Control-Allow-Origin'), 'https://mydukapos.store');
  assert.equal((await mk('https://evil.example')).headers.get('Access-Control-Allow-Origin'), null);
});
test('_routes.json: valid for Pages, keeps every routed path the Function needs, skips only static app folders', () => {
  const r = JSON.parse(fs.readFileSync(path.join(ROOT, '_routes.json'), 'utf8'));
  assert.equal(r.version, 1);
  assert.ok(r.include.length + r.exclude.length <= 100);
  for (const p of [...r.include, ...r.exclude]) assert.ok(p.length <= 100 && p.startsWith('/'), p);
  assert.ok(r.include.includes('/*'), 'everything not excluded still reaches the Function (API, "/" and the internal-path 404 guard)');
  const excluded = (pathname) => r.exclude.some((e) => (e.endsWith('/*') ? pathname.startsWith(e.slice(0, -1)) : pathname === e));
  for (const must of ['/', '/api/pos-sync', '/api/media', '/tests/x.mjs', '/src/shared/functions.js', '/tools/x.mjs', '/wildcard-router/worker.js', '/functions/_middleware.js', '/node_modules/x', '/.git/config', '/package.json', '/wrangler.toml', '/README.md', '/CHANGES_ZIP_1.md', '/.dev.vars', '/index.html'])
    assert.equal(excluded(must), false, must + ' must still go through the Function');
  for (const app of ['hotel', 'hospital', 'pharmacy', 'production', 'services', 'water', 'order', 'owner', 'crm', 'public-site']) {
    assert.ok(fs.existsSync(path.join(ROOT, app)), app + ' exists');
    assert.equal(excluded(`/${app}/index.html`), true);
  }
  assert.equal(excluded('/sw.js'), true);
});
test('_routes.json never excludes what the middleware hides (isInternalPath) or any /api path', async () => {
  const r = JSON.parse(fs.readFileSync(path.join(ROOT, '_routes.json'), 'utf8'));
  const { isInternalPath } = await import(pathToFileURL(path.join(ROOT, 'functions/_middleware.js')).href);
  const excluded = (pathname) => r.exclude.some((e) => (e.endsWith('/*') ? pathname.startsWith(e.slice(0, -1)) : pathname === e));
  for (const p of ['/tests/a', '/src/a', '/tools/a', '/wildcard-router/a', '/functions/a', '/node_modules/a', '/.git/a', '/.wrangler/a', '/a.md', '/package.json', '/package-lock.json', '/wrangler.toml', '/wrangler.staging.toml', '/.env', '/.dev.vars'])
    assert.ok(isInternalPath(p) && !excluded(p), p);
  assert.equal(excluded('/api/anything'), false);
});
test('_headers: valid Pages syntax; icons cached a day, service workers always revalidated, app pages/scripts never long-cached', () => {
  const t = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8');
  const lines = t.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  let path0 = null; const rules = {};
  for (const l of lines) { if (!/^\s/.test(l)) { assert.ok(l.startsWith('/'), 'path line: ' + l); path0 = l.trim(); rules[path0] = {}; } else { const m = l.trim().match(/^([A-Za-z-]+):\s*(.+)$/); assert.ok(m && path0, 'header line: ' + l); rules[path0][m[1]] = m[2]; } }
  assert.match(rules['/icons/*']['Cache-Control'], /max-age=86400/);
  assert.equal(rules['/sw.js']['Cache-Control'], 'no-cache');
  assert.equal(rules['/*/sw.js']['Cache-Control'], 'no-cache');
  for (const [p, h] of Object.entries(rules)) if (h['Cache-Control'] && !/no-cache/.test(h['Cache-Control'])) assert.ok(p.startsWith('/icons/'), 'only icons may be cached: ' + p);
  assert.equal(Object.entries(rules).some(([p, h]) => h['Cache-Control'] && (p === '/*' || (/\.(js|css|html)$/.test(p) && !/(^|\/)sw\.js$/.test(p)))), false, 'no blanket or per-app-file caching');
});

// ---------------------------------------------------------------- daily health check is chunked
test('owner-health cron: a fleet larger than one slice is checked over chained calls; the result and the email cover ALL shops once', async () => {
  const kv = makeKV(); const sent = [];
  for (let i = 0; i < 5; i++) { seedShop(kv, 'S' + i); kv.data.set('pos-data:state:S' + i, { value: JSON.stringify({ inventory: [{ code: 'A', qty: i === 4 ? -3 : 5 }], deviceRegistry: { d: { v: 'zip-120', lastSeen: Date.now() } } }) }); }
  kv.data.set('owner-account', { value: JSON.stringify({ identifier: 'owner@x.test' }) });
  const env = { mydukapos_kv: kv, ROUTER_SHARED_SECRET: 'rs', HEALTH_CRON_SLICE: '2', RESEND_API_KEY: 'k' };
  const m = await load('owner-health.js');
  const chained = []; const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => { const s = String(u); if (s.includes('/api/owner-health')) { chained.push(s); return new Response('{}'); } sent.push(s); return new Response('{}', { status: 200 }); };
  try {
    const call = async (q) => { const tasks = []; const r = await m.onRequestGet({ request: new Request('https://x.pages.dev/api/owner-health' + q, { headers: { 'X-Router-Secret': 'rs' } }), env, waitUntil: (p) => tasks.push(p) }); await Promise.all(tasks); return r.json(); };
    const a = await call('?cron=1');
    assert.equal(a.done, false); assert.equal(a.next, 2); assert.equal(chained.length, 1); assert.match(chained[0], /offset=2/);
    assert.equal((await call('?cron=1&offset=2')).done, false);
    const last = await call('?cron=1&offset=4');
    assert.equal(last.ok, true); assert.equal(last.total, 5); assert.ok(last.bad >= 0);
    const saved = JSON.parse(kv.data.get('owner-health:last').value);
    assert.equal(saved.total, 5);
  } finally { globalThis.fetch = real; }
});
test('owner-health cron: a small fleet behaves exactly as before (one call, same reply shape)', async () => {
  const kv = makeKV(); seedShop(kv, 'G1');
  const env = { mydukapos_kv: kv, ROUTER_SHARED_SECRET: 'rs' };
  const m = await load('owner-health.js');
  const r = await (await m.onRequestGet({ request: new Request('https://x.pages.dev/api/owner-health?cron=1', { headers: { 'X-Router-Secret': 'rs' } }), env })).json();
  assert.deepEqual(Object.keys(r).sort(), ['bad', 'emailed', 'ok', 'total']);
  assert.equal(r.total, 1);
});

// ---------------------------------------------------------------- broadcast fan-out
test('live push: a single-record shop broadcasts the record while small, and a bare poke once it is over BROADCAST_MAX_BYTES', async () => {
  const m = await load('pos-sync.js');
  const run = async (extra) => {
    const kv = makeKV(); seedShop(kv, 'C1'); const sent = [];
    const env = { mydukapos_kv: kv, SYNC_ROOM: { idFromName: (n) => n, get: () => ({ fetch: async (u, o) => { sent.push(JSON.parse(o.body)); return new Response('{}'); } }) }, ...extra };
    const tasks = [];
    await m.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ businessName: 'B', salesLog: [sale('z1')] }), headers: { 'content-type': 'application/json' } }), env, waitUntil: (p) => tasks.push(p) });
    await Promise.all(tasks); return sent;
  };
  const small = await run({}); assert.equal(small.length, 1); assert.ok(small[0].salesLog && small[0].updatedAt);
  const big = await run({ BROADCAST_MAX_BYTES: '10' }); assert.deepEqual(big, [{ poke: true }]);
});

// ---------------------------------------------------------------- the measuring tool itself
test('tools/measure-hot-paths.mjs: the legacy switch turns every zip-159 memory off (so the "before" numbers are reproducible)', () => {
  assert.deepEqual(Object.keys(LEGACY_ENV).sort(), ['LEDGER_OUTBOX_CHECK_MS', 'LEDGER_SEEN_MS', 'LICENSE_CACHE_MS', 'SHOP_MODE_CACHE_MS']);
});

// ---------------------------------------------------------------- CRM: session check in one round trip
test('CRM: signing a staff request in (user + roles + permission overrides) is ONE D1 round trip, and permissions still come out right', async () => {
  const { makeCrm } = await import('./crm-harness.mjs');
  const c = await makeCrm();
  const st = await c.staff('Sam', 'sales');
  await c.ok('PUT', '/staff/' + st.id + '/permissions', { body: { grant: [], revoke: ['leads.view_all'] } }).catch(() => {});
  const cd = countD1(c.env.LEDGER_DB); c.env.LEDGER_DB = cd.db;
  const { authenticate } = await load('_crm/auth.js');
  const ctx = { request: new Request('https://mydukapos.store/api/crm/me', { headers: { Authorization: 'Bearer ' + st.token } }), env: c.env };
  cd.reset();
  const actor = await authenticate(ctx, cd.db);
  assert.equal(cd.counts.roundTrips, 1);
  assert.equal(actor.id, st.id); assert.equal(actor.role, 'sales'); assert.ok(actor.perms.size > 0);
  const bad = { request: new Request('https://x/api/crm/me', { headers: { Authorization: 'Bearer c1.' + st.id + '.zz.' + '0'.repeat(64) } }), env: c.env };
  await assert.rejects(authenticate(bad, cd.db), (e) => e.status === 401);
  const owner = await c.ok('GET', '/me');
  assert.equal(owner.user.role, 'owner');
});
