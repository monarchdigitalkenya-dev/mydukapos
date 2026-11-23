import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../tools/measure-hot-paths.mjs';
import { hasSqlite } from './do-fake.mjs';

// zip 306 (cost item 2): KV writes cost $5 per million, so a permanent shop must not write its data to KV on every sale. A permanent shop still
// kept as a single KV record moves into its own database at its first push (zip 156), and from then on a sale writes nothing to KV.
const URL_SUB = 'https://shopc1.mydukapos.store/api/pos-sync';
const sale = (id) => ({ id, refNumber: 'R-' + id, timestamp: new Date().toISOString(), paymentMethod: 'cash', cashAmount: 100, items: [{ code: 'A', name: 'Alpha', qty: 1, price: 100 }] });

test('a permanent shop on KV moves to its own database at its first push; later sales write no shop data to KV', { skip: !hasSqlite }, async () => {
  const s = await setup({ mode: 'kv', type: 'permanent' });
  const push = (body) => s.call('pos-sync.js', 'onRequestPost', URL_SUB, { method: 'POST', body: { businessName: 'Biz', updatedAt: Date.now(), ...body } });
  await push({ inventory: [{ code: 'A', name: 'Alpha', qty: 50, price: 100, updatedAt: Date.now() }] });
  assert.equal(s.kvRaw.data.get('pos-data:mode:C1')?.value, 'do', 'moved into its own database');
  s.reset();
  for (let i = 0; i < 5; i++) await push({ salesLog: [sale('s' + i)], stockMovementLog: [{ id: 'm' + i, code: 'A', delta: -1, type: 'removed', reason: 'sale', timestamp: new Date().toISOString() }] });
  const stateWrites = s.kv.counts.keys.filter((k) => k.startsWith('put pos-data:state:')).length;
  assert.equal(stateWrites, 0, 'no shop-data writes to KV for 5 sales');
});
