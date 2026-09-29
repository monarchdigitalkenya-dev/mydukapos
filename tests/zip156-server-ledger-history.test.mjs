import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';

// zip 156 (server):
//   DEFECT 8  the D1 ledger was written from the RAW push, so a void made on a till whose clock is slow carried an older version than the sale
//             and D1 ignored it while the shop's own copy (which corrects the clock) showed the sale voided
//   DEFECT 9  /api/history returned deleted-record tombstones (`_deleted`), which every other read strips
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const sync = await load('functions/api/pos-sync.js');
const history = await load('functions/api/history.js');
const req = (m, b, q = '') => new Request('https://x.pages.dev/api/pos-sync?c=C1' + q, { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
const newEnv = (extra = {}) => { const kv = makeKV(); seedShop(kv, 'C1'); return { kv, env: { mydukapos_kv: kv, MIGRATE_SETTLE_MS: 10, ...extra } }; };
const post = (env, b) => sync.onRequestPost({ request: req('POST', b), env, waitUntil() {} });
const get = async (env) => (await sync.onRequestGet({ request: req('GET'), env })).json();
const hist = async (env, col = 'salesLog') => (await history.onRequestGet({ request: new Request(`https://x.pages.dev/api/history?c=C1&col=${col}&from=0&limit=100`), env })).json();

test('DEFECT 8: a void made on a till whose clock is 10 minutes slow reaches the D1 ledger (the clock is corrected before D1 sees it)', async () => {
  const { env } = newEnv({ LEDGER_DB: makeD1() });
  const now = Date.now();
  const sale = { id: 'S1', timestamp: new Date(now - 60000).toISOString(), items: [{ code: 'A', price: 100, qty: 1 }], paymentMethod: 'cash', updatedAt: now - 60000 };
  await post(env, { businessName: 'B', salesLog: [sale], updatedAt: now - 60000 });
  const slow = -600000;
  const r = await post(env, { salesLog: [{ ...sale, voided: true, voidedAt: new Date(now - 30000 + slow).toISOString(), updatedAt: now - 30000 + slow }], updatedAt: now - 30000 + slow + 1 });
  assert.equal(r.status, 200);
  const kvSale = (await get(env)).salesLog[0];
  const row = await env.LEDGER_DB.prepare("select status from ledger_sales where sale_id='S1'").first();
  assert.equal(!!kvSale.voided, true, 'the shop copy is voided');
  assert.equal(row.status, 'VOIDED', 'and so is the D1 ledger');
});

test('DEFECT 8: an old copy re-sent by a slow-clock till still cannot undo a void in D1', async () => {
  const { env } = newEnv({ LEDGER_DB: makeD1() });
  const now = Date.now();
  const sale = { id: 'S2', timestamp: new Date(now - 60000).toISOString(), items: [{ code: 'A', price: 100, qty: 1 }], paymentMethod: 'cash', updatedAt: now - 60000 };
  await post(env, { businessName: 'B', salesLog: [{ ...sale, voided: true, updatedAt: now - 10000 }], updatedAt: now - 10000 });
  await post(env, { salesLog: [{ ...sale, updatedAt: now - 60000 - 600000 }], updatedAt: now - 600000 });
  const row = await env.LEDGER_DB.prepare("select status from ledger_sales where sale_id='S2'").first();
  assert.equal(row.status, 'VOIDED');
});

for (const mode of ['single record', 'shop database']) {
  test(`DEFECT 9 (${mode}): /api/history does not return deleted-record tombstones`, { skip: mode === 'shop database' && !hasSqlite }, async () => {
    const { kv, env } = newEnv();
    if (mode === 'shop database') { env.SHOP_STORE = await makeBinding(); await kv.put('pos-data:mode:C1', 'do'); }
    const t = Date.now();
    const s = (id) => ({ id, timestamp: new Date(t - 1000).toISOString(), items: [{ code: 'A', price: 1, qty: 1 }], updatedAt: t - 1000 });
    await post(env, { businessName: 'B', salesLog: [s('K1'), s('K2')], updatedAt: t });
    await new Promise((r) => setTimeout(r, 5));
    await post(env, { salesLog: [{ id: 'K2', timestamp: new Date(t - 1000).toISOString(), _deleted: true, updatedAt: Date.now() }], updatedAt: Date.now() });
    const h = await hist(env);
    assert.deepEqual(h.records.map((x) => x.id), ['K1'], 'only the live sale');
    assert.deepEqual((await get(env)).salesLog.map((x) => x.id), ['K1'], 'same as the normal read');
  });
}
