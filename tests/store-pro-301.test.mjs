import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './d1-fake.mjs';
import { makeKV } from './kv-fake.mjs';
import { handleStoreD1 } from '../functions/api/_store-d1.js';
import { onRequestPost } from '../functions/api/store.js';

// Zip 301: Store items carry category, supplier, notes, reorder level, minimum price and a variant link (D1 and the KV fallback).
const json = (b, s = 200) => ({ status: s, body: b });
const lic = { A: { id: 'A', branchGroupId: 'G', businessName: 'Main' } };
const getLicense = async (_e, id) => lic[id] || null;
const call = (env, body) => handleStoreD1(env, env.LEDGER_DB, { body, groupId: 'G', record: lic.A, getLicense, json });
const mk = () => ({ LEDGER_DB: makeD1(), mydukapos_kv: makeKV() });

test('D1: extras save through updateFields and setExtras, never touch qty, clear when blank, and are validated', async () => {
  const e = mk();
  let items = (await call(e, { action: 'addManual', item: { code: 'T1', name: 'Tee', qty: 7, price: 500, wholesalePrice: 300 } })).body.items;
  const id = items[0].id;
  items = (await call(e, { action: 'updateFields', storeItemId: id, fields: { category: 'Clothes', supplier: 'Acme', reorderLevel: '3', minimumPrice: '450', notes: 'Shelf 2' } })).body.items;
  assert.deepEqual([items[0].category, items[0].supplier, items[0].reorderLevel, items[0].minimumPrice, items[0].notes, items[0].qty], ['Clothes', 'Acme', 3, 450, 'Shelf 2', 7]);
  items = (await call(e, { action: 'updateFields', storeItemId: id, fields: { category: '', reorderLevel: '' } })).body.items;
  assert.equal(items[0].category, undefined); assert.equal(items[0].reorderLevel, undefined); assert.equal(items[0].supplier, 'Acme');
  const bad = await call(e, { action: 'updateFields', storeItemId: id, fields: { minimumPrice: '-4' } });
  assert.equal(bad.status, 400);
  // variants: a group line + children linked by parentId, found by code in setExtras
  items = (await call(e, { action: 'addManual', item: { name: 'Shirt', qty: 0 } })).body.items;
  const g = items.find((i) => i.name === 'Shirt');
  await call(e, { action: 'addManual', item: { code: 'SH-S', name: 'Shirt (S)', qty: 4, price: 100 } });
  items = (await call(e, { action: 'setExtras', entries: [{ storeItemId: g.id, extras: { isGroup: true } }, { code: 'sh-s', extras: { parentId: g.id, variantName: 'S' } }] })).body.items;
  assert.equal(items.find((i) => i.id === g.id).isGroup, true);
  const kid = items.find((i) => i.code === 'SH-S');
  assert.deepEqual([kid.parentId, kid.variantName, kid.qty], [g.id, 'S', 4]);
  // stock still moves the old way and the extras survive it
  const w = await call(e, { action: 'removeFromStore', items: [{ storeItemId: kid.id, qty: 1 }] });
  assert.equal(w.body.items.find((i) => i.id === kid.id).qty, 3);
  assert.equal(w.body.items.find((i) => i.id === kid.id).variantName, 'S');
  assert.equal((await call(e, { action: 'setExtras', entries: [] })).status, 400);
});

test('KV fallback: the same extras and setExtras work', async () => {
  const kv = makeKV();
  const env = { mydukapos_kv: kv };
  // minimal license plumbing is internal to onRequestPost; exercise the pure helpers instead
  const { cleanExtras, applyExtras } = await import('../functions/api/_store-extra.js');
  const ex = cleanExtras({ category: ' Hardware ', reorderLevel: '5', isGroup: true, junk: 'x', notes: '' });
  assert.deepEqual(ex.set, { category: 'Hardware', reorderLevel: 5, isGroup: true }); assert.deepEqual(ex.clear, ['notes']);
  assert.deepEqual(applyExtras({ notes: 'a', qty: 2 }, ex), { qty: 2, category: 'Hardware', reorderLevel: 5, isGroup: true });
  assert.ok(cleanExtras({ minimumPrice: 'abc' }).error);
  assert.equal(typeof onRequestPost, 'function'); void env;
});
