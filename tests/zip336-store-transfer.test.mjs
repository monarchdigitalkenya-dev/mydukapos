// zip 336: Store <-> Inventory without duplicate items (server side, real SQL on node:sqlite): canonical store line, batches carried through the
// Store, idempotent retries, concurrent withdrawals, the Store check and the audited merge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './d1-fake.mjs';
import { makeKV } from './kv-fake.mjs';
import { handleStoreD1 } from '../functions/api/_store-d1.js';

const json = (b, s = 200) => ({ status: s, body: b });
const lic = { A: { id: 'A', branchGroupId: 'G', businessName: 'Main' }, B: { id: 'B', branchGroupId: 'G', businessName: 'Branch B' } };
const getLicense = async (_e, id) => lic[id] || null;
const mk = () => ({ LEDGER_DB: makeD1(), mydukapos_kv: makeKV() });
const call = (env, who, body, hdr = {}) => handleStoreD1(env, env.LEDGER_DB, { body, groupId: 'G', record: lic[who], getLicense, json, request: new Request('https://x/api/store', { method: 'POST', headers: hdr }), cors: {} });
const items = async (e) => (await call(e, 'A', { action: 'get' })).body.items;

test('Test A (server) - a deposit WITH a code finds the Store\'s code-less line of the same name: no second "Hospital gloves" line', async () => {
  const e = mk();
  await call(e, 'A', { action: 'addManual', item: { name: 'Hospital gloves', unit: 'bags', qty: 10 } });           // the Store's own line, no code
  // Inventory -> Store: 5 bags of the branch's item 00012 (every inventory item has a code)
  const r = await call(e, 'A', { action: 'depositFromBranch', idemKey: 'mv-1', items: [{ code: '00012', name: 'Hospital gloves', unit: 'bags', qty: 5 }] });
  assert.equal(r.status, 200);
  let list = await items(e);
  assert.equal(list.length, 1, 'still ONE store line');
  assert.deepEqual([list[0].qty, list[0].code], [15, '00012'], '10 + 5, and the line now carries the item code');
  // the retry of the same move (lost reply) changes nothing
  const again = await call(e, 'A', { action: 'depositFromBranch', idemKey: 'mv-1', items: [{ code: '00012', name: 'Hospital gloves', unit: 'bags', qty: 5 }] });
  assert.equal(again.body.replay, true);
  assert.equal((await items(e))[0].qty, 15);
  // Store -> Inventory 3 bags: one transfer, IN_TRANSIT to the branch, its item code on it (so the till matches it by code)
  const w = await call(e, 'A', { action: 'removeFromStore', idemKey: 'w-1', items: [{ storeItemId: list[0].id, qty: 3 }] });
  assert.equal(w.body.withdrawn.length, 1);
  assert.deepEqual([w.body.withdrawn[0].code, w.body.withdrawn[0].qty, w.body.withdrawn[0].status], ['00012', 3, 'IN_TRANSIT']);
  const w2 = await call(e, 'A', { action: 'removeFromStore', idemKey: 'w-1', items: [{ storeItemId: list[0].id, qty: 3 }] });
  assert.equal(w2.body.replay, true, 'a retried withdrawal returns the first one');
  assert.equal(w2.body.withdrawn[0].movementId, w.body.withdrawn[0].movementId);
  list = await items(e);
  assert.equal(list[0].qty, 12, 'taken ONCE');
  const log = (await call(e, 'A', { action: 'getLog' })).body.log;
  assert.equal(log.filter((l) => l.action === 'withdraw').length, 1, 'one movement for the withdrawal');
  assert.equal(log.filter((l) => l.action === 'moved_in').length, 1, 'one movement for the deposit');
});

test('a deposit can name the store line it goes to (the till remembers it); a store line with a DIFFERENT code is not merged by name', async () => {
  const e = mk();
  await call(e, 'A', { action: 'addManual', item: { code: 'G-STORE', name: 'Hospital gloves', unit: 'bags', qty: 10 } });
  const st = (await items(e))[0];
  await call(e, 'A', { action: 'depositFromBranch', idemKey: 'mv-2', items: [{ code: '00012', name: 'Hospital gloves', unit: 'bags', qty: 5, storeItemId: st.id }] });
  let list = await items(e);
  assert.equal(list.length, 1);
  assert.equal(list[0].qty, 15);
  assert.equal(list[0].code, 'G-STORE', 'the line keeps its own code');
  // without a chosen line, a different code is a different product as far as the server knows: kept apart and reported by the Store check
  await call(e, 'A', { action: 'depositFromBranch', idemKey: 'mv-3', items: [{ code: 'OTHER-9', name: 'Hospital gloves', unit: 'bags', qty: 1 }] });
  list = await items(e);
  assert.equal(list.length, 2);
  const chk = (await call(e, 'A', { action: 'reconcile' })).body;
  assert.equal(chk.duplicates.length, 1, 'the Store check lists the two look-alike lines');
  assert.equal(chk.duplicates[0].length, 2);
});

test('batches travel through the Store: deposit with lots, withdraw takes the earliest-expiring usable batch first and hands the lots back', async () => {
  const e = mk();
  const lots = [{ id: 'L-old', b: 'A1', e: '2027-01-31', c: 5, r: 1, q: 4 }, { id: 'L-new', b: 'B2', e: '2027-09-30', c: 6, r: 2, q: 6 }];
  await call(e, 'A', { action: 'depositFromBranch', idemKey: 'mv-l', items: [{ code: 'AMX', name: 'Amoxicillin', unit: 'caps', qty: 10, lots }] });
  const it = (await items(e))[0];
  assert.equal(it.lots.length, 2);
  const w = await call(e, 'A', { action: 'removeFromStore', idemKey: 'w-l', items: [{ storeItemId: it.id, qty: 5 }] });
  assert.deepEqual(w.body.withdrawn[0].lots.map((l) => [l.id, l.q, l.c, l.e]), [['L-old', 4, 5, '2027-01-31'], ['L-new', 1, 6, '2027-09-30']]);
  const after = (await items(e))[0];
  assert.deepEqual(after.lots.map((l) => [l.id, l.q]), [['L-new', 5]]);
  // the branch picks it up later (pendingTransfers) with the same lots
  const pend = (await call(e, 'A', { action: 'pendingTransfers' })).body.transfers;
  assert.equal(pend[0].lots.length, 2);
  // cancelling in transit puts the stock AND the batches back, once
  await call(e, 'A', { action: 'cancelTransfer', movementId: w.body.withdrawn[0].movementId });
  await call(e, 'A', { action: 'cancelTransfer', movementId: w.body.withdrawn[0].movementId });
  const back = (await items(e))[0];
  assert.equal(back.qty, 10);
  assert.deepEqual(back.lots.map((l) => [l.id, l.q]).sort(), [['L-new', 6], ['L-old', 4]]);
});

test('Test H (server) - two withdrawals at the same moment cannot both take the last units (nothing partial, nothing twice)', async () => {
  const e = mk();
  await call(e, 'A', { action: 'addManual', item: { code: 'C1', name: 'Gauze', qty: 5 } });
  const id = (await items(e))[0].id;
  const [r1, r2] = await Promise.all([
    call(e, 'A', { action: 'removeFromStore', idemKey: 'a', items: [{ storeItemId: id, qty: 4 }] }),
    call(e, 'B', { action: 'removeFromStore', idemKey: 'b', items: [{ storeItemId: id, qty: 4 }] }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal((await items(e))[0].qty, 1);
  // with batches, the batch rows obey the same rule
  await call(e, 'A', { action: 'depositFromBranch', idemKey: 'mv-z', items: [{ code: 'Z', name: 'Z', qty: 3, lots: [{ id: 'z1', q: 3, c: 1, e: '2027-01-01' }] }] });
  const zid = (await items(e)).find((x) => x.code === 'Z').id;
  const both = await Promise.all([call(e, 'A', { action: 'removeFromStore', idemKey: 'z-a', items: [{ storeItemId: zid, qty: 2 }] }), call(e, 'B', { action: 'removeFromStore', idemKey: 'z-b', items: [{ storeItemId: zid, qty: 2 }] })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  const z = (await items(e)).find((x) => x.code === 'Z');
  assert.deepEqual([z.qty, z.lots[0].q], [1, 1]);
});

test('linkCode gives a code-less store line the inventory code it was matched to - once, never a code another line uses', async () => {
  const e = mk();
  await call(e, 'A', { action: 'addManual', item: { name: 'Syringe 5ml', qty: 3 } });
  await call(e, 'A', { action: 'addManual', item: { code: 'SY10', name: 'Syringe 10ml', qty: 3 } });
  const s5 = (await items(e)).find((x) => x.name === 'Syringe 5ml');
  assert.equal((await call(e, 'A', { action: 'linkCode', storeItemId: s5.id, code: 'SY10' })).body.ok, false, 'a code in use is refused');
  assert.equal((await call(e, 'A', { action: 'linkCode', storeItemId: s5.id, code: 'SY5' })).body.linked, true);
  assert.equal((await call(e, 'A', { action: 'linkCode', storeItemId: s5.id, code: 'OTHER' })).body.linked, false, 'only a line with no code');
  assert.equal((await items(e)).find((x) => x.name === 'Syringe 5ml').code, 'SY5');
});

test('merging two look-alike store lines: a preview first, then (manager) one audited move; idempotent; archived line kept', async () => {
  const e = mk();
  await call(e, 'A', { action: 'addManual', item: { code: 'G1', name: 'Gloves', unit: 'bags', qty: 4 } });
  await call(e, 'A', { action: 'addManual', item: { code: 'G2', name: 'Gloves', unit: 'bags', qty: 6 } });
  const [g1, g2] = (await items(e)).sort((a, b) => a.code.localeCompare(b.code));
  const pv = await call(e, 'A', { action: 'mergeItems', fromId: g2.id, intoId: g1.id });
  assert.equal(pv.body.preview.after.qty, 10);
  assert.equal((await items(e)).length, 2, 'a preview changes nothing');
  assert.equal((await call(e, 'A', { action: 'mergeItems', fromId: g2.id, intoId: g1.id, confirm: true, reason: '' })).status, 400, 'a reason is required');
  // the shop in this test has no password set, so the server-side proof passes as "unprotected" (a shop WITH a password needs it: see zip336-cost-control)
  const m = await call(e, 'A', { action: 'mergeItems', fromId: g2.id, intoId: g1.id, confirm: true, reason: 'same gloves, two codes', idemKey: 'mg1' });
  assert.equal(m.status, 200);
  assert.deepEqual(m.body.items.map((x) => [x.code, x.qty]), [['G1', 10]]);
  const again = await call(e, 'A', { action: 'mergeItems', fromId: g2.id, intoId: g1.id, confirm: true, reason: 'same gloves, two codes', idemKey: 'mg1' });
  assert.notEqual(again.status, 200, 'the archived line cannot be merged again');
  const log = (await call(e, 'A', { action: 'getLog' })).body.log;
  assert.ok(log.some((l) => l.action === 'merge_out') && log.some((l) => l.action === 'merge_in'));
});
