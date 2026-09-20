import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';
const T = hasSqlite ? test : test.skip;

// A link that is PERMANENT lives in its own database: new permanent links start there, and a demo that becomes permanent is moved with its data.
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
async function setup(binding = true) {
  const kv = makeKV();
  kv.data.set('owner-session:tok', { value: '1' });
  const env = { mydukapos_kv: kv, ...(binding ? { SHOP_STORE: await makeBinding() } : {}) };
  const pending = [];
  const call = async (mod, url, body) => {
    const m = await load(mod);
    return m.onRequestPost({ request: new Request('https://x.pages.dev' + url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' } }), env, waitUntil: (p) => pending.push(p) });
  };
  return { kv, env, call, settle: () => Promise.all(pending), mode: (id) => kv.data.get('pos-data:mode:' + id)?.value };
}
const push = async (env, id, body) => (await load('pos-sync.js')).onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=' + id, { method: 'POST', body: JSON.stringify({ businessName: 'Biz', ...body }), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });
const pull = async (env, id, q = '') => (await (await load('pos-sync.js')).onRequestGet({ request: new Request('https://x.pages.dev/api/pos-sync?c=' + id + q), env })).json();

T('a NEW permanent link starts in its own database; a demo link does not', async () => {
  const s = await setup();
  const perm = await (await s.call('owner-clients.js', '/api/owner-clients', { type: 'permanent', label: 'Real Shop', product: 'shop' })).json();
  const demo = await (await s.call('owner-clients.js', '/api/owner-clients', { type: 'demo', label: 'Trial Shop', product: 'shop' })).json();
  assert.equal(s.mode(perm.client.id), 'do');
  assert.equal(s.mode(demo.client.id), undefined, 'demos stay single records');
  // and the shop works straight away
  assert.equal((await push(s.env, perm.client.id, { updatedAt: Date.now(), salesLog: [{ id: 'a', timestamp: new Date().toISOString() }] })).status, 200);
  assert.equal((await pull(s.env, perm.client.id, '&hot=all')).salesLog.length, 1);
  assert.equal(s.env.SHOP_STORE.stores.size >= 1, true, 'its own database exists');
});

T('a demo that becomes permanent is moved into the database WITH the data it already has', async () => {
  const s = await setup();
  const demo = await (await s.call('owner-clients.js', '/api/owner-clients', { type: 'demo', label: 'Trial Shop', product: 'shop' })).json();
  const id = demo.client.id;
  await push(s.env, id, { updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Bolt', qty: 5, updatedAt: 1 }], salesLog: [{ id: 's1', timestamp: new Date().toISOString() }, { id: 's2', timestamp: new Date(Date.now() - 400 * 86400000).toISOString() }], receiptFooterNotes: 'Thanks' });
  const blobBefore = s.kv.data.get('pos-data:state:' + id).value;
  assert.equal(s.mode(id), undefined);
  const res = await s.call('owner-confirm.js', '/api/owner-confirm', { c: id });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).client.type, 'permanent');
  await s.settle();                                                                // the move runs after the reply
  assert.equal(s.mode(id), 'do');
  assert.equal(s.kv.data.get('pos-data:state:' + id).value, blobBefore, 'old record kept as the rollback copy');
  const got = await pull(s.env, id, '&hot=all');
  assert.deepEqual(got.salesLog.map((x) => x.id).sort(), ['s1', 's2'], 'all history came with it');
  assert.equal(got.inventory[0].qty, 5);
  assert.equal(got.receiptFooterNotes, 'Thanks');
});

T('if the move fails the link is STILL made permanent and the shop simply stays a single record', async () => {
  const kv = makeKV(); kv.data.set('owner-session:tok', { value: '1' });
  const env = { mydukapos_kv: kv, SHOP_STORE: await makeBinding({ failOn: '/import' }) };
  const pending = [];
  const call = async (mod, url, body) => (await load(mod)).onRequestPost({ request: new Request('https://x.pages.dev' + url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' } }), env, waitUntil: (p) => pending.push(p) });
  const demo = await (await call('owner-clients.js', '/api/owner-clients', { type: 'demo', label: 'Trial', product: 'shop' })).json();
  await push(env, demo.client.id, { updatedAt: Date.now(), salesLog: [{ id: 'a', timestamp: new Date().toISOString() }] });
  const res = await call('owner-confirm.js', '/api/owner-confirm', { c: demo.client.id });
  assert.equal((await res.json()).client.type, 'permanent');
  await Promise.all(pending);
  assert.equal(kv.data.has('pos-data:mode:' + demo.client.id), false, 'no half-moved state');
  assert.equal((await pull(env, demo.client.id)).salesLog.length, 1, 'data untouched');
});

test('without the database binding nothing changes at all', async () => {
  const s = await setup(false);
  const perm = await (await s.call('owner-clients.js', '/api/owner-clients', { type: 'permanent', label: 'Real', product: 'shop' })).json();
  assert.equal(s.mode(perm.client.id), undefined);
  const demo = await (await s.call('owner-clients.js', '/api/owner-clients', { type: 'demo', label: 'Trial', product: 'shop' })).json();
  assert.equal((await s.call('owner-confirm.js', '/api/owner-confirm', { c: demo.client.id })).status, 200);
  await s.settle();
  assert.equal(s.mode(demo.client.id), undefined);
});
