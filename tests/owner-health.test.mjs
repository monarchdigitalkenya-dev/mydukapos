import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// #10/#11/#12 (zip 120): the Owner Console health check across every paying shop, on demand and as the daily job.
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
async function setup() {
  const kv = makeKV();
  kv.data.set('owner-session:tok', { value: '1' });
  seedShop(kv, 'GOOD'); seedShop(kv, 'BAD');
  const env = { mydukapos_kv: kv, ROUTER_SHARED_SECRET: 'rs' };
  const mv = (id, sv, before, after) => ({ id, code: 'A', delta: after - before, unit: 'qty', _srv: { applied: true, before, after, sv } });
  kv.data.set('pos-data:state:GOOD', { value: JSON.stringify({ inventory: [{ code: 'A', qty: 119 }], stockMovementLog: [mv('m1', 1, 100, 120), mv('m2', 2, 120, 119)], deviceRegistry: { d1: { v: 'zip-120', lastSeen: Date.now(), till: 1 } } }) });
  kv.data.set('pos-data:state:BAD', { value: JSON.stringify({ inventory: [{ code: 'A', qty: 140 }, { code: 'B', qty: -2 }], stockMovementLog: [mv('m1', 1, 100, 120), mv('m1', 2, 120, 140)], deviceRegistry: { d1: { v: 'zip-120', lastSeen: Date.now() }, d2: { v: 'zip-119', lastSeen: Date.now() - 5 * 86400000 } } }) });
  const m = await load('owner-health.js');
  const get = async (q, headers = { Authorization: 'Bearer tok' }) => { const r = await m.onRequestGet({ request: new Request('https://x.pages.dev/api/owner-health' + q, { headers }), env }); return { status: r.status, body: await r.json() }; };
  const post = async (b) => (await m.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-health', { method: 'POST', body: JSON.stringify(b), headers: { Authorization: 'Bearer tok' } }), env })).json();
  return { kv, env, get, post };
}

test('owner only: each shop\'s stock integrity, below-zero items, device releases and silent devices, pairing mode', async () => {
  const { get } = await setup();
  assert.equal((await get('', {})).status, 401);
  const { body } = await get('?offset=0&limit=25');
  const good = body.shops.find((s) => s.id === 'GOOD'), bad = body.shops.find((s) => s.id === 'BAD');
  assert.equal(good.integrity.ok, true); assert.deepEqual(good.problems, []);
  assert.equal(bad.integrity.ok, false);
  assert.equal(bad.belowZero, 1);
  assert.equal(bad.devices.n, 2); assert.equal(bad.devices.olderRelease, 1); assert.equal(bad.devices.silent, 1);
  assert.match(bad.problems.join(' '), /stock history/); assert.match(bad.problems.join(' '), /below zero/); assert.match(bad.problems.join(' '), /older app release/);
  assert.equal(bad.pairing, 'open');
});

test('the daily job: only with the router\'s secret; stores the result; the owner can switch a shop\'s pairing', async () => {
  const { kv, get, post } = await setup();
  assert.equal((await get('?cron=1', { 'X-Router-Secret': 'wrong' })).status, 401);
  const r = await get('?cron=1', { 'X-Router-Secret': 'rs' });
  assert.equal(r.body.total, 2); assert.equal(r.body.bad, 1);
  assert.equal(r.body.emailed, false, 'no email service configured in the test: nothing sent, nothing broken');
  assert.equal(JSON.parse(kv.data.get('owner-health:last').value).bad, 1);
  assert.equal((await post({ action: 'mode', clientId: 'BAD', mode: 'paired' })).mode, 'paired');
  assert.equal((await get('')).body.shops.find((s) => s.id === 'BAD').pairing, 'paired');
});
