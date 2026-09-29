import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecordsById } from '../functions/api/_merge.js';

test('a newer stock-only copy does not erase the photo or pour setup', () => {
  const server = [{ code: 'A1', name: 'Whisky', qty: 5, image: 'data:image/jpeg;base64,AAA', bottleMl: 750, shotMl: 25, updatedAt: 100 }];
  const stale = [{ code: 'A1', name: 'Whisky', qty: 4, image: null, updatedAt: 200 }];
  const [r] = mergeRecordsById(server, stale, false, 'inventory');
  assert.equal(r.qty, 4); assert.equal(r.image, 'data:image/jpeg;base64,AAA'); assert.equal(r.bottleMl, 750); assert.equal(r.shotMl, 25);
});
test('a newer record that states a new photo wins; older stays out', () => {
  const server = [{ code: 'A1', image: 'OLD', updatedAt: 300 }];
  const inc = [{ code: 'A1', image: 'NEW', updatedAt: 200 }];
  assert.equal(mergeRecordsById(server, inc, false, 'inventory')[0].image, 'OLD');
  assert.equal(mergeRecordsById([{ code: 'A1', image: 'OLD', updatedAt: 100 }], inc, false, 'inventory')[0].image, 'NEW');
});
test('other fields still follow newest-wins', () => {
  const [r] = mergeRecordsById([{ code: 'A1', price: 10, image: 'X', updatedAt: 100 }], [{ code: 'A1', price: 12, updatedAt: 200 }], false, 'inventory');
  assert.equal(r.price, 12); assert.equal(r.image, 'X');
});
