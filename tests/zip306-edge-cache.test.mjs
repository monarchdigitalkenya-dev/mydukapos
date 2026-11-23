import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { countKV } from './ops-count.mjs';

// zip 306: the licence and subdomain lookups are kept in Cloudflare's free edge cache (shared by every Worker instance in a data centre), so a
// freshly started instance no longer reads them from KV. A change made by the owner is seen at once, and not-found is never kept.
const lic = await import(pathToFileURL(path.join(ROOT, 'functions/api/_license.js')).href);

function fakeCaches() {
  const store = new Map();
  const c = {
    store,
    async match(u) { const e = store.get(String(u)); return e ? new Response(e.body, { headers: e.headers }) : undefined; },
    async put(u, res) { store.set(String(u), { body: await res.text(), headers: Object.fromEntries(res.headers) }); },
    async delete(u) { return store.delete(String(u)); },
  };
  return c;
}
const flush = () => new Promise((r) => setTimeout(r, 5));

test('a new Worker instance takes the licence from the edge cache, not KV', async (t) => {
  const cache = fakeCaches(); globalThis.caches = { default: cache }; t.after(() => { delete globalThis.caches; });
  const raw = makeKV(); seedShop(raw, 'C1');
  const k = countKV(raw); const env = { mydukapos_kv: k.kv };
  const first = await lic.getLicenseCached(env, 'C1'); await flush();
  assert.equal(first.id, 'C1'); assert.equal(k.counts.get, 1, 'first ever read goes to KV');
  lic.clearLicenseCache(env); k.reset();                                   // "a new instance": its memory is empty
  const again = await lic.getLicenseCached(env, 'C1');
  assert.equal(again.id, 'C1'); assert.equal(k.counts.get, 0, 'answered by the edge cache');
});

test('an owner change is seen at once in that data centre (the new value replaces the cached one)', async (t) => {
  const cache = fakeCaches(); globalThis.caches = { default: cache }; t.after(() => { delete globalThis.caches; });
  const raw = makeKV(); seedShop(raw, 'C1');
  const env = { mydukapos_kv: raw };
  await lic.getLicenseCached(env, 'C1'); await flush();
  const rec = await lic.getLicense(env, 'C1'); rec.locked = true;
  await lic.saveLicense(env, rec); await flush();
  lic.clearLicenseCache(env);
  assert.equal((await lic.getLicenseCached(env, 'C1')).locked, true);
});

test('not-found is never kept, an old entry is ignored, and EDGE_CACHE_MS=0 switches it off', async (t) => {
  const cache = fakeCaches(); globalThis.caches = { default: cache }; t.after(() => { delete globalThis.caches; });
  const raw = makeKV(); const env = { mydukapos_kv: raw };
  assert.equal(await lic.getLicenseCached(env, 'NEW'), null); await flush();
  assert.equal(cache.store.size, 0, 'a missing licence is not cached');
  seedShop(raw, 'NEW'); lic.clearLicenseCache(env);
  assert.equal((await lic.getLicenseCached(env, 'NEW')).id, 'NEW', 'a link created a moment ago is found');
  await flush();
  // an entry older than the window is not used
  for (const [, e] of cache.store) e.headers['x-at'] = String(Date.now() - 60000);
  const k = countKV(raw); const env2 = { mydukapos_kv: k.kv };
  await lic.getLicenseCached(env2, 'NEW');
  assert.equal(k.counts.get, 1, 'stale edge entry -> KV');
  // switched off
  const k3 = countKV(raw); const env3 = { mydukapos_kv: k3.kv, EDGE_CACHE_MS: '0' };
  await lic.getLicenseCached(env3, 'NEW'); lic.clearLicenseCache(env3); await lic.getLicenseCached(env3, 'NEW');
  assert.equal(k3.counts.get, 2, 'off: every new instance reads KV as before');
});

test('without a Cache API (local dev / tests) nothing changes', async () => {
  delete globalThis.caches;
  const raw = makeKV(); seedShop(raw, 'C1');
  const k = countKV(raw); const env = { mydukapos_kv: k.kv };
  await lic.getLicenseCached(env, 'C1'); lic.clearLicenseCache(env); await lic.getLicenseCached(env, 'C1');
  assert.equal(k.counts.get, 2);
});
