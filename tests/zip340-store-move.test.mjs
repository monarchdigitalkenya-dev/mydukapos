import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './d1-fake.mjs';
import { makeKV } from './kv-fake.mjs';
import { handleStoreD1 } from '../functions/api/_store-d1.js';

// Zip 340: the Store's Move works four ways. Store -> inventory and Store -> branch use the existing withdraw (with a destination);
// Branch -> Store is a REQUEST the other branch confirms (requestFromBranch / pendingRequests / fulfilRequest / declineRequest).
const lic = { C1: { id: 'C1', branchGroupId: 'G', businessName: 'Main' }, C2: { id: 'C2', branchGroupId: 'G', businessName: 'Westlands' }, X9: { id: 'X9', branchGroupId: 'OTHER', businessName: 'Stranger' } };
const getLicense = async (_e, id) => lic[id] || null;
function setup() {
  const env = { LEDGER_DB: makeD1(), mydukapos_kv: makeKV() };
  const call = (who, body) => handleStoreD1(env, env.LEDGER_DB, { body, groupId: 'G', record: lic[who], getLicense, json: (b, s = 200) => ({ status: s, body: b }) });
  return { call };
}

test('Store -> another branch: the stock leaves the store at once and is in transit until that branch receives it', async () => {
  const { call } = setup();
  await call('C1', { action: 'addManual', item: { name: 'Paracetamol', code: 'PARA', qty: 40, unit: 'pcs', price: 100 } });
  const id = (await call('C1', { action: 'get' })).body.items[0].id;
  const r = await call('C1', { action: 'removeFromStore', idemKey: 'k1', destClientId: 'C2', items: [{ storeItemId: id, qty: 10 }] });
  assert.equal(r.body.items[0].qty, 30);
  const pend = (await call('C2', { action: 'pendingTransfers' })).body.transfers;
  assert.deepEqual(pend.map((t) => [t.name, t.qty]), [['Paracetamol', 10]], 'the other branch sees it waiting');
  const again = await call('C1', { action: 'removeFromStore', idemKey: 'k1', destClientId: 'C2', items: [{ storeItemId: id, qty: 10 }] });
  assert.equal(again.body.replay, true); assert.equal((await call('C1', { action: 'get' })).body.items[0].qty, 30, 'a retry takes nothing twice');
  const bad = await call('C1', { action: 'removeFromStore', idemKey: 'k2', destClientId: 'X9', items: [{ storeItemId: id, qty: 1 }] });
  assert.equal(bad.status, 400, 'a branch outside this business is refused');
  const tooMany = await call('C1', { action: 'removeFromStore', idemKey: 'k3', destClientId: 'C2', items: [{ storeItemId: id, qty: 999 }] });
  assert.equal(tooMany.status, 409); assert.equal((await call('C1', { action: 'get' })).body.items[0].qty, 30);
});

test('Branch -> Store: a request changes nothing until the asked branch sends; sending adds to the store once', async () => {
  const { call } = setup();
  await call('C1', { action: 'addManual', item: { name: 'Gauze', code: 'GZ', qty: 5, unit: 'pcs', price: 20 } });
  const gid = (await call('C1', { action: 'get' })).body.items[0].id;
  const rq = await call('C1', { action: 'requestFromBranch', idemKey: 'r1', fromClientId: 'C2', storeItemId: gid, name: 'Gauze', code: 'GZ', unit: 'pcs', qty: 6 });
  assert.equal(rq.body.requested, true);
  assert.equal((await call('C1', { action: 'get' })).body.items[0].qty, 5, 'a request moves nothing');
  const rq2 = await call('C1', { action: 'requestFromBranch', idemKey: 'r1', fromClientId: 'C2', name: 'Gauze', code: 'GZ', unit: 'pcs', qty: 6 });
  assert.equal(rq2.body.replay, true, 'the same request twice is one request');
  assert.equal((await call('C2', { action: 'pendingRequests' })).body.requests.length, 1, 'only the asked branch sees it');
  assert.equal((await call('C1', { action: 'pendingRequests' })).body.requests.length, 0, 'the asking branch does not');
  assert.equal((await call('C1', { action: 'requestFromBranch', idemKey: 'r2', fromClientId: 'X9', name: 'Gauze', qty: 1 })).status, 400, 'outside the business');
  assert.equal((await call('C1', { action: 'requestFromBranch', idemKey: 'r3', fromClientId: 'C1', name: 'Gauze', qty: 1 })).status, 400, 'not from itself');
  assert.equal((await call('C1', { action: 'requestFromBranch', idemKey: 'r4', fromClientId: 'C2', name: 'Gauze', qty: 0 })).status, 400, 'a zero quantity');

  const mid = (await call('C2', { action: 'pendingRequests' })).body.requests[0].movementId;
  assert.equal((await call('C1', { action: 'fulfilRequest', movementId: mid, qty: 6 })).status, 404, 'the asking branch cannot fulfil its own request');
  const done = await call('C2', { action: 'fulfilRequest', movementId: mid, qty: 4 });          // sends less than asked
  assert.equal(done.body.moved, true); assert.equal(done.body.qty, 4);
  assert.equal((await call('C1', { action: 'get' })).body.items[0].qty, 9, 'the store went up by what was sent');
  const twice = await call('C2', { action: 'fulfilRequest', movementId: mid, qty: 4 });
  assert.equal(twice.body.replay, true); assert.equal((await call('C1', { action: 'get' })).body.items[0].qty, 9, 'pressing Send again adds nothing');
  assert.equal((await call('C2', { action: 'pendingRequests' })).body.requests.length, 0, 'it is closed');
  const log = (await call('C1', { action: 'getLog' })).body.log;
  assert.ok(log.some((l) => l.action === 'branch_request'), 'the request is in the Store history');
});

test('a declined request closes without moving anything; it cannot be fulfilled afterwards', async () => {
  const { call } = setup();
  await call('C1', { action: 'requestFromBranch', idemKey: 'd1', fromClientId: 'C2', name: 'Soap', unit: 'pcs', qty: 3 });
  const mid = (await call('C2', { action: 'pendingRequests' })).body.requests[0].movementId;
  assert.equal((await call('C2', { action: 'declineRequest', movementId: mid })).body.declined, true);
  const r = await call('C2', { action: 'fulfilRequest', movementId: mid });
  assert.equal(r.status, 409);
  assert.equal((await call('C1', { action: 'get' })).body.items.length, 0);
});
