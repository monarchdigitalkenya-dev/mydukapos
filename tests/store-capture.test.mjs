import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 153 — a captured delivery list restocks the STORE (not the branch inventory), and a store transfer lands in inventory exactly once.
test('Capture List -> Store sends the lines to the store endpoint and leaves this branch inventory alone', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify([{ code: 'A', type: 'item', name: 'Alpha', price: 10, wholesalePrice: 5, qty: 3, unit: 'pcs', vatCategory: 'A' }]) }, wait: 800 });
  const { w } = b;
  w.eval("showToast = function () {}; window.__calls = []; window.fetch = function (u, o) { window.__calls.push({ u: String(u), b: JSON.parse(o.body) }); return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) }); };");
  w.eval("captureListTarget = 'store'; captureReviewState = { commitTarget: 'store', sourceType: 'photo', items: [{ id: 1, code: '', name: 'Sugar', qty: '5', unitCost: '80', retail: '100', wholesale: '' }, { id: 2, code: 'A', name: 'Alpha', qty: '4', unitCost: '', retail: '', wholesale: '', matchedItemId: 'A' }] }; commitCaptureReview();");
  await new Promise((r) => setTimeout(r, 80));
  const c = JSON.parse(w.eval("JSON.stringify(window.__calls.filter(x => x.b.action === 'addFromCsv'))"));
  assert.equal(c.length, 1); assert.equal(c[0].b.action, 'addFromCsv');
  assert.deepEqual(c[0].b.items.map((x) => [x.name, x.qty]), [['Sugar', 5], ['Alpha', 4]]);
  assert.equal(c[0].b.items[0].wholesalePrice, 80);
  assert.equal(w.eval("inventory.find(i => i.code === 'A').qty"), 3, 'inventory untouched');
  b.close();
});

test('a store transfer is added to inventory once even if the reply is applied twice', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify([]) }, wait: 800 });
  const { w } = b;
  w.eval("showToast = function () {};");
  const t = { movementId: 'x-1', code: 'S1', name: 'Sugar', unit: 'kg', price: 100, qty: 5 };
  const r = JSON.parse(w.eval(`JSON.stringify([storeApplyWithdrawn(${JSON.stringify(t)}), storeApplyWithdrawn(${JSON.stringify(t)}), inventory.filter(i => i.code === 'S1').map(i => i.qty)])`));
  assert.deepEqual(r, [true, false, [5]]);
  b.close();
});
