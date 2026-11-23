import baseTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { fakeDoState, hasSqlite } from './do-fake.mjs';
const test = hasSqlite ? baseTest : baseTest.skip;

// The per-shop SQLite Durable Object must behave EXACTLY like the single-blob KV backend for everything the apps rely on —
// so every scenario below runs against BOTH and compares — and must additionally do what the blob could not.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);

async function backends() {
  const { ShopStore } = await load('wildcard-router/shop-store.js');
  const sync = await load('functions/api/pos-sync.js');
  // legacy blob backend
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const req = (m, b) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
  const blob = {
    name: 'blob',
    push: async (b) => { await sync.onRequestPost({ request: req('POST', { businessName: 'Biz', ...b }), env, waitUntil() {} }); },
    state: async () => (await sync.onRequestGet({ request: req('GET'), env })).json(),
  };
  // database backend
  const store = new ShopStore(fakeDoState(), {});
  const db = {
    name: 'db', store,
    push: async (b) => { await (await store.fetch(new Request('https://s/push', { method: 'POST', body: JSON.stringify({ body: { businessName: 'Biz', ...b }, serverNow: Date.now() }) }))).json(); },
    state: async () => JSON.parse(store.stateText(null)),
  };
  return [blob, db];
}
// compare two states ignoring server-clock fields
const norm = (s) => JSON.parse(JSON.stringify(s, (k, v) => (k === 'updatedAt' && typeof v === 'number' && v > 1.7e12 && k !== 'x' ? undefined : v)));
// Each backend replays the scenario at its own wall-clock time, so compare CONTENT, not the timestamps the scenario itself stamped.
const strip = (s) => {
  const c = JSON.parse(JSON.stringify(s)); delete c.updatedAt; delete c._fieldTimes;
  if (c.logsReset) { delete c.logsReset.at; delete c.logsReset.floors; }      // wall-clock times of the two replays
  for (const v of Object.values(c)) if (Array.isArray(v)) v.forEach((r) => { if (r && typeof r === 'object') { delete r._qtySyncedAt; delete r.updatedAt; delete r.timestamp; if (r._srv) delete r._srv.at; if (r._ct) r._ct = Object.keys(r._ct); } });
  return c;
};
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function both(scenario) {
  const [a, b] = await backends();
  await scenario(a); await scenario(b);
  const sa = strip(await a.state()), sb = strip(await b.state());
  // arrays compared as id-keyed maps (order is insertion order in both, but be strict only on content)
  for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    if (Array.isArray(sa[k]) || Array.isArray(sb[k])) {
      const key = (r) => (r && (r.id ?? r.code ?? r.token)) ?? JSON.stringify(r);
      const ma = new Map((sa[k] || []).map((r) => [key(r), r])), mb = new Map((sb[k] || []).map((r) => [key(r), r]));
      assert.deepEqual([...mb.keys()].sort(), [...ma.keys()].sort(), `${k}: same records`);
      for (const [id, r] of ma) assert.deepEqual(mb.get(id), r, `${k}/${id}: same content`);
    } else assert.deepEqual(sb[k], sa[k], `${k}: same value`);
  }
  return [sa, sb];
}


test('DB == blob: a reset removes old sales and stock movements, rolls stock back, and blocks stale re-sends (full and voided-only)', async () => {
  const [a] = await both(async (s) => {
    const t0 = Date.now() - 60000;
    const sale = (id, ago, extra = {}) => ({ id, total: 10, timestamp: new Date(Date.now() - ago).toISOString(), ...extra });
    const mv = (id, ago) => ({ id, code: 'A', name: 'Bolt', delta: -1, type: 'removed', timestamp: new Date(Date.now() - ago).toISOString(), reason: 'sale' });
    await s.push({ updatedAt: t0, inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 8, openingStock: { qty: 10, costPrice: 5, date: '2026-01-01', setBy: 'x' }, updatedAt: t0 }], salesLog: [sale('s1', 50000), sale('s2', 40000, { voided: true })], stockMovementLog: [mv('m1', 50000), mv('m2', 40000)] });
    await wait(20);
    // voided-only reset: only the voided sale goes
    await s.push({ updatedAt: Date.now(), _logsReset: { id: 'rv1', at: Date.now() - 1, fields: ['salesLog'], voided: true } });
    await wait(20);
    let st = await s.state();
    assert.deepEqual((st.salesLog || []).map((r) => r.id).sort(), ['s1']);
    assert.equal(st.logsReset.id, 'rv1');
    // a stale device re-sends the voided sale: it must not come back
    await s.push({ updatedAt: Date.now(), salesLog: [sale('s2', 40000, { voided: true })] });
    await wait(20);
    assert.deepEqual(((await s.state()).salesLog || []).map((r) => r.id).sort(), ['s1']);
    // full reset
    await s.push({ updatedAt: Date.now(), _logsReset: { id: 'rf1', at: Date.now() - 1, fields: ['salesLog', 'stockMovementLog'], rollbackStock: true } });
    await wait(20);
    st = await s.state();
    assert.equal((st.salesLog || []).length, 0); assert.equal((st.stockMovementLog || []).length, 0);
    assert.equal(st.inventory.find((i) => i.code === 'A').qty, 10);
    assert.equal(st.logsReset.n, 2);
    // a stale device re-sends everything old: nothing comes back; a NEW sale does
    await s.push({ updatedAt: Date.now(), salesLog: [sale('s1', 50000), sale('s9', -5)], stockMovementLog: [mv('m1', 50000)] });
    await wait(20);
    st = await s.state();
    assert.deepEqual((st.salesLog || []).map((r) => r.id), ['s9']);
    assert.equal((st.stockMovementLog || []).length, 0);
    // repeating the same instruction changes nothing
    await s.push({ updatedAt: Date.now(), _logsReset: { id: 'rf1', at: Date.now() - 1, fields: ['salesLog', 'stockMovementLog'], rollbackStock: true } });
    await wait(20);
    assert.deepEqual((((await s.state()).salesLog) || []).map((r) => r.id), ['s9']);
  });
  assert.equal(a.logsReset.n, 2);
});
