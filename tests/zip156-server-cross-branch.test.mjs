import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';
import { makeD1 } from './d1-fake.mjs';

// zip 156 (server) — DEFECT 2: a cross-branch sale changed the target branch's stock number IN PLACE with no stock movement.
// With the stock ledger the server ignores a device's plain number, so the deduction was either discarded (shop database) or — on a
// single-record shop — put on the number without a movement, so the target till's "change that was not itemised" safety net logged the same
// deduction again and it was applied twice. Now the sale carries one movement per item (id xb-<saleId>:<code>), applied exactly once by
// the ledger; a repeated saleId is a no-op; and on a single-record shop the write goes through the same merge / re-check as pos-sync.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const sync = await load('functions/api/pos-sync.js');
const xb = await load('functions/api/cross-branch-sale.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function world() {
  const kv = makeKV();
  seedShop(kv, 'C1', { branchGroupId: 'G1', label: 'Branch One' });
  seedShop(kv, 'C2', { branchGroupId: 'G1', label: 'Branch Two' });
  kv.data.set('branch-group:G1', { value: JSON.stringify(['C1', 'C2']) });
  return { kv, env: { mydukapos_kv: kv, MIGRATE_SETTLE_MS: 10 } };
}
const syncReq = (c, m, b) => new Request(`https://x.pages.dev/api/pos-sync?c=${c}`, { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
const push = (env, c, b) => sync.onRequestPost({ request: syncReq(c, 'POST', b), env, waitUntil() {} });
const pull = async (env, c) => (await sync.onRequestGet({ request: syncReq(c, 'GET'), env })).json();
const sell = async (env, body) => {
  const res = await xb.onRequestPost({ request: new Request('https://x.pages.dev/api/cross-branch-sale?c=C1', { method: 'POST', body: JSON.stringify({ action: 'sellBatch', targetClientId: 'C2', paymentMethod: 'cash', servedBy: 'Jane', ...body }), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });
  return { status: res.status, body: await res.json() };
};
const seedTarget = (env) => push(env, 'C2', { businessName: 'B2', inventory: [{ code: 'A', name: 'Alpha', qty: 10, price: 5, updatedAt: 1 }, { code: 'D', name: 'Dual', qty: 4, pieceQty: 6, dualUnit: true, price: 50, piecePrice: 5, updatedAt: 1 }], salesLog: [], updatedAt: Date.now() });

for (const mode of ['single record', 'shop database']) {
  const opts = { skip: mode === 'shop database' && !hasSqlite };
  test(`DEFECT 2 (${mode}): the target branch's stock comes off exactly once, through a movement the ledger applies`, opts, async () => {
    const { kv, env } = world();
    if (mode === 'shop database') { env.SHOP_STORE = await makeBinding(); await kv.put('pos-data:mode:C2', 'do'); }
    await seedTarget(env);
    const r = await sell(env, { saleId: 'abcdefgh12', items: [{ itemCode: 'A', qty: 3 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let st = await pull(env, 'C2');
    assert.equal(st.inventory.find((p) => p.code === 'A').qty, 7, '10 - 3');
    const mv = st.stockMovementLog.filter((m) => m.id === 'xb-abcdefgh12:A');
    assert.equal(mv.length, 1, 'one movement for the item');
    assert.equal(mv[0].delta, -3); assert.equal(mv[0].code, 'A');
    assert.equal(mv[0]._srv && mv[0]._srv.applied, true, 'the ledger applied it');
    assert.equal(st.salesLog.filter((s) => s.id === 'xb-abcdefgh12').length, 1, 'the sale is in the target branch\'s books');

    // the same saleId again (a double tap / a retry after a lost answer): nothing more happens
    const again = await sell(env, { saleId: 'abcdefgh12', items: [{ itemCode: 'A', qty: 3 }] });
    assert.equal(again.status, 200); assert.equal(again.body.repeated, true);
    st = await pull(env, 'C2');
    assert.equal(st.inventory.find((p) => p.code === 'A').qty, 7, 'still 7');
    assert.equal(st.stockMovementLog.filter((m) => m.id === 'xb-abcdefgh12:A').length, 1);
    assert.equal(st.salesLog.filter((s) => s.id === 'xb-abcdefgh12').length, 1);

    // the target branch's own till syncs (a stale copy of the item, and it re-sends the movement it pulled): stock is not touched again
    const pulled = st.stockMovementLog.filter((m) => m.id === 'xb-abcdefgh12:A');
    await push(env, 'C2', { inventory: [{ code: 'A', name: 'Alpha', qty: 10, price: 5, updatedAt: Date.now() }], stockMovementLog: pulled, updatedAt: Date.now() });
    st = await pull(env, 'C2');
    assert.equal(st.inventory.find((p) => p.code === 'A').qty, 7, 'a stale copy / a re-sent movement changes nothing');
  });

  test(`DEFECT 2 (${mode}): a piece sale of a dual-unit item comes off the loose pieces; two lines of one item add up; stock is checked on the total`, opts, async () => {
    const { kv, env } = world();
    if (mode === 'shop database') { env.SHOP_STORE = await makeBinding(); await kv.put('pos-data:mode:C2', 'do'); }
    await seedTarget(env);
    let r = await sell(env, { saleId: 'piece-sale-1', items: [{ itemCode: 'D', qty: 2, saleMode: 'piece' }, { itemCode: 'A', qty: 2 }, { itemCode: 'A', qty: 1 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let st = await pull(env, 'C2');
    const d = st.inventory.find((p) => p.code === 'D'), a = st.inventory.find((p) => p.code === 'A');
    assert.deepEqual([d.qty, d.pieceQty], [4, 4], 'pieces come off pieceQty, boxes untouched');
    assert.equal(a.qty, 7, 'two lines of A (2 + 1) both came off');
    r = await sell(env, { saleId: 'too-much-01', items: [{ itemCode: 'A', qty: 5 }, { itemCode: 'A', qty: 5 }] });
    assert.equal(r.status, 409, 'each line fits (5 <= 7) but together they do not');
    st = await pull(env, 'C2');
    assert.equal(st.inventory.find((p) => p.code === 'A').qty, 7, 'nothing came off');
    assert.equal(st.salesLog.filter((s) => s.id === 'xb-too-much-01').length, 0, 'no sale recorded');
  });
}

test('DEFECT 2 (single record): a device save that lands while a cross-branch sale is being written is not overwritten (and vice versa)', async () => {
  const { kv, env } = world();
  await seedTarget(env);
  const KEY = 'pos-data:state:C2';
  const als = new AsyncLocalStorage();
  const aRead = deferred(), bRead = deferred(), aDone = deferred();
  const gm = kv.getWithMetadata.bind(kv), pt = kv.put.bind(kv);
  let bCount = 0;
  kv.getWithMetadata = async (k) => {
    if (k !== KEY) return gm(k);
    const tag = als.getStore();
    if (tag === 'B') { bCount++; if (bCount === 2) await aDone.promise; const r = await gm(k); if (bCount === 1) bRead.resolve(); return r; }
    const r = await gm(k); if (tag === 'A') aRead.resolve(); return r;
  };
  kv.put = async (k, v, o) => {
    if (k !== KEY) return pt(k, v, o);
    const tag = als.getStore();
    if (tag === 'A') await bRead.promise;
    if (tag === 'B') { bCount++; if (bCount === 2) await aDone.promise; }
    return pt(k, v, o);
  };
  // A = the target branch's own till saving a sale; B = the cross-branch sale from the other branch
  const pa = als.run('A', () => push(env, 'C2', { salesLog: [{ id: 'S-A', timestamp: new Date().toISOString(), items: [{ code: 'A', price: 5, qty: 1 }], updatedAt: Date.now() }], updatedAt: Date.now() }));
  await aRead.promise;
  const pb = als.run('B', () => sell(env, { saleId: 'race-sale-1', items: [{ itemCode: 'A', qty: 2 }] }));
  await pa; aDone.resolve();
  const rb = await pb;
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  await sleep(600);
  const st = JSON.parse(kv.data.get(KEY).value);
  const ids = st.salesLog.map((s) => s.id).sort();
  assert.deepEqual(ids, ['S-A', 'xb-race-sale-1'], 'the branch\'s own sale and the cross-branch sale are both there');
  assert.equal(st.inventory.find((p) => p.code === 'A').qty, 8, '10 - 2 (the till\'s own sale carried no movement)');
});

test('DEFECT 2: with the D1 ledger, the sale (and its stock movement) is recorded once for the target branch, and a repeated saleId adds nothing', async () => {
  const { env } = world();
  env.LEDGER_DB = makeD1();
  await seedTarget(env);
  const r = await sell(env, { saleId: 'ledger-sale-1', items: [{ itemCode: 'A', qty: 3 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await sell(env, { saleId: 'ledger-sale-1', items: [{ itemCode: 'A', qty: 3 }] });
  const rows = await env.LEDGER_DB.prepare("select sale_id, total, status from ledger_sales where client_id = 'C2' and sale_id = 'xb-ledger-sale-1'").all();
  assert.equal(rows.results.length, 1);
  assert.deepEqual([rows.results[0].total, rows.results[0].status], [15, 'COMPLETED']);
  const st = await pull(env, 'C2');
  assert.equal(st.inventory.find((p) => p.code === 'A').qty, 7);
});
