import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKV, seedShop } from './kv-fake.mjs';
import { SHARED_DEMOS, ensureSharedDemo } from '../functions/api/_shared-demos.js';
import { onRequestPost as syncPost } from '../functions/api/pos-sync.js';
import { onRequestPost as mediaPost } from '../functions/api/media.js';

// zip 327 (issues 4, 5, 6, 8): the server keeps NOTHING from a shared demo - no state, no uploaded picture - so there is nothing for an hourly server job to restore
// and no visitor upload to clean up. These tests pin that down; a future change that lets a demo write would fail here.
const mk = async () => { const kv = makeKV(); seedShop(kv, 'REAL1', { type: 'permanent', createdAt: Date.UTC(2026, 9, 20) }); const env = { mydukapos_kv: kv, MEDIA: { puts: [], async put(k) { this.puts.push(k); }, async get() { return null; }, async delete() {} } }; await ensureSharedDemo(env, SHARED_DEMOS.find((d) => d.key === 'retail')); return env; };
const req = (p, id, body) => new Request('https://x.pages.dev' + p + '?c=' + id, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

test('a shared demo refuses a picture upload and stores no media', async () => {
  const env = await mk();
  const res = await mediaPost({ request: req('/api/media', 'demo_retail', { k: 'p', id: 'abc123', data: 'data:image/png;base64,AAAA', type: 'image/png' }), env, waitUntil() {} });
  assert.ok(res.status >= 400, 'status ' + res.status);
  assert.equal(env.MEDIA.puts.length, 0, 'nothing reached the media store');
});

test('a shared demo push is acknowledged but nothing is stored (so a restore has nothing server-side to undo)', async () => {
  const env = await mk();
  const before = env.mydukapos_kv.data.get('pos-data:state:demo_retail').value;
  const res = await syncPost({ request: req('/api/pos-sync', 'demo_retail', { updatedAt: Date.now(), inventory: [{ code: 'ZZ', name: 'Visitor product', price: 1, qty: 1, updatedAt: Date.now() }], _logsReset: { id: 'x', at: Date.now() - 1, fields: ['salesLog'] } }), env, waitUntil() {} });
  const out = await res.json();
  assert.equal(out.demo, true); assert.equal(out.stored, false);
  assert.equal(env.mydukapos_kv.data.get('pos-data:state:demo_retail').value, before, 'the sample is byte-for-byte unchanged');
});

test('a shared demo refuses the reset-app wipe too', async () => {
  const env = await mk();
  const before = env.mydukapos_kv.data.get('pos-data:state:demo_retail').value;
  const res = await syncPost({ request: req('/api/pos-sync', 'demo_retail', { _wipeApp: { id: 'w1', confirm: 'Anything' } }), env, waitUntil() {} });
  assert.equal(env.mydukapos_kv.data.get('pos-data:state:demo_retail').value, before);
  assert.ok(res.status < 500);
});
