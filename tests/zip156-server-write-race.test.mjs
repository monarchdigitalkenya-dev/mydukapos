import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';

// zip 156 (server) — DEFECT 1: the KV read-merge-write race.
// KV has no "write only if unchanged". Two devices saving within a few hundred ms each read the shop, added their own record and wrote it
// back: the LAST write won, the other device's sale was gone — and the post-write check only looks for the writer's OWN records, so the
// device whose record was overwritten later never noticed. Fix: (a) with the shop database bound, a shop moves into it from its FIRST push
// (the database takes saves one after the other, so nothing can be overwritten); (b) without it, the write is re-checked right before
// it lands and re-merged if another save arrived in between.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const sync = await load('functions/api/pos-sync.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = 'pos-data:state:C1';
const req = (m, b) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
const post = (env, b) => sync.onRequestPost({ request: req('POST', b), env, waitUntil() {} });
const get = async (env) => (await sync.onRequestGet({ request: req('GET'), env })).json();
const sale = (id) => ({ id, timestamp: new Date().toISOString(), items: [{ code: 'A', price: 10, qty: 1 }], updatedAt: Date.now() });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function newEnv(extra = {}) {
  const kv = makeKV(); seedShop(kv, 'C1');
  return { kv, env: { mydukapos_kv: kv, MIGRATE_SETTLE_MS: 10, ...extra } };
}
// KV with network-like latency
function slowKV(kv, { getMs = 20, putMs = 150 } = {}) {
  const g = kv.get.bind(kv), gm = kv.getWithMetadata.bind(kv), p = kv.put.bind(kv);
  kv.getWithMetadata = async (k) => { const r = await gm(k); await sleep(getMs); return r; };
  kv.get = async (k) => { const r = await g(k); await sleep(getMs); return r; };
  kv.put = async (k, v, o) => { await sleep(putMs); return p(k, v, o); };
}

test('DEFECT 1 (a): with the shop database bound, a shop moves into it from its FIRST push, and two saves at the same moment both survive', { skip: !hasSqlite }, async () => {
  const { kv, env } = newEnv({ SHOP_STORE: await makeBinding() });
  let r = await post(env, { businessName: 'B', inventory: [{ code: 'A', name: 'a', qty: 100, updatedAt: 1 }], updatedAt: Date.now() });
  assert.equal(r.status, 200);
  assert.equal(kv.data.get('pos-data:mode:C1').value, 'do', 'the shop is in its own database after the first push');
  slowKV(kv, { getMs: 20, putMs: 250 });
  const a = post(env, { salesLog: [sale('S-A')], updatedAt: Date.now() });
  await sleep(150);
  const b = post(env, { salesLog: [sale('S-B')], updatedAt: Date.now() });
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual([ra.status, rb.status], [200, 200]);
  const st = await get(env);
  assert.deepEqual(st.salesLog.map((x) => x.id).sort(), ['S-A', 'S-B'], 'neither device erased the other');
});

test('DEFECT 1 (a): if the move cannot be done the shop stays on KV, the push still succeeds, and the move is not retried within 6 hours', { skip: !hasSqlite }, async () => {
  const binding = await makeBinding({ failOn: '/import' });
  let imports = 0;
  const realGet = binding.get;
  binding.get = (id) => { const stub = realGet(id); return { fetch: (url, o) => { if (String(url).endsWith('/import')) imports++; return stub.fetch(url, o); } }; };
  const { kv, env } = newEnv({ SHOP_STORE: binding });
  let r = await post(env, { businessName: 'B', salesLog: [sale('S1')], updatedAt: Date.now() });
  assert.equal(r.status, 200, 'the till is still acknowledged');
  assert.notEqual(kv.data.get('pos-data:mode:C1') && kv.data.get('pos-data:mode:C1').value, 'do', 'still a single record');
  assert.equal(imports, 1, 'the move was tried once');
  r = await post(env, { salesLog: [sale('S2')], updatedAt: Date.now() });
  assert.equal(r.status, 200);
  assert.equal(imports, 1, 'not tried again inside the 6-hour guard');
  assert.deepEqual(JSON.parse(kv.data.get(STATE).value).salesLog.map((x) => x.id).sort(), ['S1', 'S2']);
  const guard = JSON.parse(kv.data.get('auto-db:C1').value);
  assert.ok(guard.error, 'the failure is recorded');
});

test('DEFECT 1 (a): a shop already moved is not moved again, and the old KV record is kept as the rollback copy', { skip: !hasSqlite }, async () => {
  const { kv, env } = newEnv();
  await post(env, { businessName: 'B', salesLog: [sale('S0')], updatedAt: Date.now() });     // first push with no database bound: a single record
  assert.ok(kv.data.get(STATE), 'single record exists');
  env.SHOP_STORE = await makeBinding();                                                       // the database gets bound later
  const r = await post(env, { salesLog: [sale('S1')], updatedAt: Date.now() });
  assert.equal(r.status, 200);
  assert.equal(kv.data.get('pos-data:mode:C1').value, 'do');
  assert.ok(kv.data.get(STATE), 'the old record is still there');
  assert.deepEqual((await get(env)).salesLog.map((x) => x.id).sort(), ['S0', 'S1'], 'the old sale came across with the move');
});

// The deterministic interleaving that used to lose a sale (no database bound):
//   A reads the shop; B reads the shop (same old copy); A writes and its own check passes; B then writes its merge of the OLD copy on top.
// B's second storage call is held until A has completely finished. Before the fix that call is B's write (which overwrites A); after the
// fix it is B's re-check of the shop, which sees A's save and merges again.
async function raceScenario({ env, kv, key, startA, startB }) {
  const als = new AsyncLocalStorage();
  const aRead = deferred(), bRead = deferred(), aDone = deferred();
  const gm = kv.getWithMetadata.bind(kv), pt = kv.put.bind(kv);
  let bCount = 0;
  kv.getWithMetadata = async (k) => {
    if (k !== key) return gm(k);
    const tag = als.getStore();
    if (tag === 'B') { bCount++; if (bCount === 2) await aDone.promise; const r = await gm(k); if (bCount === 1) bRead.resolve(); return r; }
    const r = await gm(k); if (tag === 'A') aRead.resolve(); return r;
  };
  kv.put = async (k, v, o) => {
    if (k !== key) return pt(k, v, o);
    const tag = als.getStore();
    if (tag === 'A') await bRead.promise;                       // A's write lands only after B has read the (old) shop
    if (tag === 'B') { bCount++; if (bCount === 2) await aDone.promise; }
    return pt(k, v, o);
  };
  const pa = als.run('A', () => startA());
  await aRead.promise;
  const pb = als.run('B', () => startB());
  const ra = await pa; aDone.resolve();
  const rb = await pb;
  return [ra, rb];
}

test('DEFECT 1 (b): no database bound — a save that landed between another device\'s read and its write is merged, not overwritten', async () => {
  const { kv, env } = newEnv();
  await post(env, { businessName: 'B', inventory: [{ code: 'A', name: 'a', qty: 100, updatedAt: 1 }], updatedAt: Date.now() });   // primes today's backup etc.
  const [ra, rb] = await raceScenario({ env, kv, key: STATE,
    startA: () => post(env, { salesLog: [sale('S-A')], updatedAt: Date.now() }),
    startB: () => post(env, { salesLog: [sale('S-B')], updatedAt: Date.now() }) });
  assert.deepEqual([ra.status, rb.status], [200, 200]);
  await sleep(600);
  const ids = JSON.parse(kv.data.get(STATE).value).salesLog.map((x) => x.id).sort();
  assert.deepEqual(ids, ['S-A', 'S-B'], 'both sales are on the server');
});

test('DEFECT 1 (b): a single device, or devices that do not overlap, behave exactly as before', async () => {
  const { kv, env } = newEnv();
  for (let i = 0; i < 4; i++) { const r = await post(env, { businessName: 'B', salesLog: [sale('S' + i)], updatedAt: Date.now() }); assert.equal(r.status, 200); }
  assert.deepEqual(JSON.parse(kv.data.get(STATE).value).salesLog.map((x) => x.id), ['S0', 'S1', 'S2', 'S3']);
});
