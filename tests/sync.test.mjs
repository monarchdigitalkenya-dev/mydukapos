import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';

// --- client: conditional pull ---
for (const [app, key, fn] of [['index.html', 'pos_last_synced_at', 'pullState'], ['hotel/index.html', 'pos_last_synced_at', 'pullState'], ['water/index.html', 'aqua_last_synced_at', 'pullFromServer']]) {
  test(`${app}: pull sends ?since= and treats {unchanged} as up to date`, async () => {
    const urls = [];
    const fetch = (u) => { urls.push(String(u)); return Promise.resolve({ ok: true, status: 200, json: async () => ({ unchanged: true, updatedAt: 123 }) }); };
    const { w, d, close } = await boot(app, { storage: { [key]: '123' }, fetch, wait: 800 });
    urls.length = 0;
    await w.eval(fn + '()');
    assert.ok(urls.some((u) => u.includes('/api/pos-sync?since=123')), 'since param sent: ' + urls.join(','));
    assert.match(d.getElementById('sync-status').className, /sync-synced/);
    close();
  });
}

// --- server: the real pos-sync handler against an in-memory KV ---
test('pos-sync server: conditional GET, never-blank fields, no global-index read on unchanged pushes', async () => {
  const { onRequestGet, onRequestPost } = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);
  const store = new Map(); let reads = 0;
  const kv = { async get(k) { reads++; return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); }, async list() { return { keys: [], list_complete: true }; } };
  store.set('license:C1', JSON.stringify({ id: 'C1', type: 'permanent', slug: 'shop' }));
  store.set('license-index:v1', JSON.stringify([{ id: 'C1', slug: 'shop', type: 'permanent', businessName: 'Shop A' }]));
  const env = { mydukapos_kv: kv };
  const call = (fn, url, method = 'GET', body) => fn({ request: new Request('https://x.pages.dev' + url, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });

  const post1 = await (await call(onRequestPost, '/api/pos-sync?c=C1', 'POST', { updatedAt: Date.now(), businessName: 'Shop A', pwHash: 'h1', adminPwHash: 'h1', inventory: [{ code: '1', name: 'x', qty: 5, updatedAt: 1 }] })).json();
  const unchanged = await (await call(onRequestGet, '/api/pos-sync?c=C1&since=' + post1.updatedAt)).json();
  assert.equal(unchanged.unchanged, true);
  const full = await (await call(onRequestGet, '/api/pos-sync?c=C1&since=' + (post1.updatedAt - 1))).json();
  assert.equal(full.inventory.length, 1);

  await call(onRequestPost, '/api/pos-sync?c=C1', 'POST', { updatedAt: Date.now(), businessName: '', pwHash: '', adminPwHash: '', inventory: [] });
  const saved = JSON.parse(store.get('pos-data:state:C1'));
  assert.equal(saved.pwHash, 'h1', 'a fresh device must not blank the password hash');
  assert.equal(saved.businessName, 'Shop A');
  assert.equal(saved.inventory.length, 1);

  const before = reads;
  await call(onRequestPost, '/api/pos-sync?c=C1', 'POST', { updatedAt: Date.now(), businessName: 'Shop A' });
  assert.ok(reads - before <= 3, `unchanged-name push should not read the global index (reads: ${reads - before})`);
});
