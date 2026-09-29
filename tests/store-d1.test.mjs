import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './d1-fake.mjs';
import { makeKV } from './kv-fake.mjs';
import { handleStoreD1 } from '../functions/api/_store-d1.js';

const json = (b, s = 200) => ({ status: s, body: b });
const lic = { A: { id: 'A', branchGroupId: 'G', businessName: 'Main' }, B: { id: 'B', branchGroupId: 'G', businessName: 'Branch B' }, X: { id: 'X', businessName: 'Outsider' } };
const getLicense = async (_e, id) => lic[id] || null;
const call = (env, who, body) => handleStoreD1(env, env.LEDGER_DB, { body, groupId: 'G', record: lic[who], getLicense, json });
const mk = () => ({ LEDGER_DB: makeD1(), mydukapos_kv: makeKV() });
const add = async (e, item) => (await call(e, 'A', { action: 'addManual', item })).body.items;

test('adds merge by code, then by name; no duplicate rows', async () => {
  const e = mk();
  await add(e, { code: 'C1', name: 'Sugar', qty: 5, unit: 'kg', price: 100 });
  await add(e, { code: 'c1', name: 'Sugar', qty: 3 });
  await add(e, { name: 'Salt', qty: 2 }); const items = await add(e, { name: 'SALT', qty: 1 });
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.code === 'C1').qty, 8);
  assert.equal(items.find((i) => i.name === 'Salt').qty, 3);
});

test('withdraw goes to zero and the item is KEPT; the transfer names its destination and is IN_TRANSIT', async () => {
  const e = mk();
  const [it] = await add(e, { code: 'C1', name: 'Sugar', qty: 5, price: 120 });
  const r = await call(e, 'A', { action: 'removeFromStore', destClientId: 'B', idemKey: 'k1', items: [{ storeItemId: it.id, qty: 5 }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.items[0].qty, 0, 'zero stock is not deleted');
  assert.deepEqual([r.body.withdrawn[0].destClientId, r.body.withdrawn[0].destLabel, r.body.withdrawn[0].status, r.body.withdrawn[0].price], ['B', 'Branch B', 'IN_TRANSIT', 120]);
  const log = (await call(e, 'A', { action: 'getLog' })).body.log;
  assert.ok(log.some((l) => l.action === 'withdraw' && /Branch B/.test(l.detail)));
});

test('over-withdrawal takes NOTHING (all-or-nothing) and concurrent withdrawals cannot both win', async () => {
  const e = mk();
  const [a, b] = [await add(e, { code: 'A1', name: 'A', qty: 5 }), null];
  const items = await add(e, { code: 'B1', name: 'B', qty: 5 });
  const ia = items.find((i) => i.code === 'A1'), ib = items.find((i) => i.code === 'B1');
  const bad = await call(e, 'A', { action: 'removeFromStore', items: [{ storeItemId: ia.id, qty: 2 }, { storeItemId: ib.id, qty: 9 }] });
  assert.equal(bad.status, 409);
  assert.deepEqual(bad.body.items.map((i) => i.qty).sort(), [5, 5], 'the valid line was rolled back too');
  const rs = await Promise.all([1, 2, 3].map((n) => call(e, 'A', { action: 'removeFromStore', idemKey: 'c' + n, items: [{ storeItemId: ia.id, qty: 3 }] })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal((await call(e, 'A', { action: 'get' })).body.items.find((i) => i.id === ia.id).qty, 2);
});

test('a retried withdrawal (same idemKey) does not take the stock twice', async () => {
  const e = mk(); const [it] = await add(e, { name: 'Rice', qty: 10 });
  const b = { action: 'removeFromStore', idemKey: 'same', items: [{ storeItemId: it.id, qty: 4 }] };
  const r1 = await call(e, 'A', b), r2 = await call(e, 'A', b);
  assert.equal(r2.body.replay, true);
  assert.equal(r2.body.withdrawn[0].movementId, r1.body.withdrawn[0].movementId);
  assert.equal(r2.body.items[0].qty, 6);
});

test('receive is idempotent and destination-only; cancel returns stock once and not after receipt', async () => {
  const e = mk(); const [it] = await add(e, { name: 'Oil', qty: 10 });
  const w = (await call(e, 'A', { action: 'removeFromStore', destClientId: 'B', items: [{ storeItemId: it.id, qty: 4 }] })).body.withdrawn[0];
  assert.equal((await call(e, 'B', { action: 'pendingTransfers' })).body.transfers.length, 1);
  assert.equal((await call(e, 'A', { action: 'pendingTransfers' })).body.transfers.length, 0);
  assert.deepEqual((await call(e, 'A', { action: 'receive', movementIds: [w.movementId] })).body.received, [], 'not the destination');
  for (let i = 0; i < 2; i++) assert.deepEqual((await call(e, 'B', { action: 'receive', movementIds: [w.movementId] })).body.received, [w.movementId]);
  assert.equal((await call(e, 'B', { action: 'pendingTransfers' })).body.transfers.length, 0);
  assert.equal((await call(e, 'A', { action: 'cancelTransfer', movementId: w.movementId })).status, 409);
  const w2 = (await call(e, 'A', { action: 'removeFromStore', items: [{ storeItemId: it.id, qty: 6 }] })).body.withdrawn[0];
  assert.equal((await call(e, 'A', { action: 'cancelTransfer', movementId: w2.movementId })).body.items[0].qty, 6);
  assert.equal((await call(e, 'A', { action: 'cancelTransfer', movementId: w2.movementId })).status, 409);
  assert.equal((await call(e, 'A', { action: 'get' })).body.items[0].qty, 6, 'returned exactly once');
});

test('destination outside the branch group is refused; delete archives and history remains', async () => {
  const e = mk(); const [it] = await add(e, { name: 'Tea', qty: 3 });
  assert.equal((await call(e, 'A', { action: 'removeFromStore', destClientId: 'X', items: [{ storeItemId: it.id, qty: 1 }] })).status, 400);
  assert.equal((await call(e, 'A', { action: 'deleteItem', storeItemId: it.id })).body.items.length, 0);
  assert.throws(() => e.LEDGER_DB.query(`delete from store_items`), /never deleted/);
  assert.throws(() => e.LEDGER_DB.query(`delete from store_movements`), /never deleted/);
  assert.ok((await call(e, 'A', { action: 'getLog' })).body.log.some((l) => l.action === 'delete'));
});

test('one-time KV import keeps items and history; running twice does not double', async () => {
  const e = mk();
  await e.mydukapos_kv.put('store:G', JSON.stringify([{ id: 'old1', code: 'Z', name: 'Zed', unit: 'pcs', price: 5, qty: 7 }]));
  await e.mydukapos_kv.put('store-log:G', JSON.stringify([{ id: 'l1', timestamp: '2026-01-01T00:00:00Z', action: 'add', itemName: 'Zed', detail: 'Added' }]));
  await call(e, 'A', { action: 'get' });
  const g = (await call(e, 'B', { action: 'get' })).body.items;
  assert.deepEqual(g.map((i) => [i.id, i.qty]), [['old1', 7]]);
  assert.equal((await call(e, 'A', { action: 'getLog' })).body.log.filter((l) => l.id === 'legacy-l1').length, 1);
});

test('setQty and updateFields keep history; code collisions are refused', async () => {
  const e = mk(); await add(e, { code: 'P', name: 'P', qty: 1 }); const items = await add(e, { code: 'Q', name: 'Q', qty: 1 });
  const q = items.find((i) => i.code === 'Q');
  assert.equal((await call(e, 'A', { action: 'updateFields', storeItemId: q.id, fields: { code: 'p' } })).status, 400);
  assert.equal((await call(e, 'A', { action: 'setQty', storeItemId: q.id, qty: 0 })).body.items.find((i) => i.id === q.id).qty, 0);
  const log = (await call(e, 'A', { action: 'getLog' })).body.log;
  assert.ok(log.some((l) => l.action === 'qty_change' && l.qtyBefore === 1 && l.qtyAfter === 0));
});
