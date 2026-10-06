import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
// zip 224 — Archived status, per-line stock-take reasons, stock value by branch.
const INV = JSON.stringify([
  { code: 'C1', type: 'item', name: 'Cola 500ml', category: 'Drinks', price: 60, wholesalePrice: 40, qty: 8, unit: 'pcs' },
  { code: 'P1', type: 'item', name: 'Pens', category: 'Stationery', price: 20, wholesalePrice: 10, qty: 30, unit: 'pcs' },
]);
const open = () => boot('index.html', { storage: { pos_inventory: INV }, wait: 3000 });
test('A1: Archived hides an item from the till, stock take and Inventory (until "show archived") but keeps it and its value', async () => {
  const { w, d, errors, close } = await open();
  w.eval("inventory.find(p => p.code === 'C1').archived = true; inventory.find(p => p.code === 'C1').inactive = true");
  assert.equal(w.eval("isSellableProduct(inventory.find(p => p.code === 'C1'))"), false);
  assert.equal(w.eval("stockPillText(inventory.find(p => p.code === 'C1'))"), 'ARCHIVED');
  assert.ok(!JSON.parse(w.eval("JSON.stringify(stockTakeItems().map(p => p.code))")).includes('C1'));
  w.eval('window.__showArchived = false; renderInventoryTable()');
  assert.doesNotMatch(d.querySelector('#inventory-table tbody').textContent, /Cola 500ml/);
  w.eval('srShowArchived(true)');
  assert.match(d.querySelector('#inventory-table tbody').textContent, /Cola 500ml/);
  assert.ok(w.eval("inventory.some(p => p.code === 'C1')"), 'never deleted');
  assert.equal(w.eval("srValuationRows().reduce((n, r) => n + r.items, 0)"), 2, 'still counted in stock value');
  assert.deepEqual(errors, []); close();
});
test('A2: stock-take line reason is saved on the movement', async () => {
  const { w, errors, close } = await open();
  w.eval("stockTakeState().counts['C1'] = { qty: '5' }; stockTakeSetReason('C1', 'Damaged')");
  w.eval("stockTakeApply({ approved: true })");
  const mv = JSON.parse(w.eval("JSON.stringify(stockMovementLog.filter(m => m.code === 'C1' && m.kind === 'count'))"));
  assert.equal(mv.length, 1); assert.equal(mv[0].reason, 'Stock take — Damaged'); assert.equal(mv[0].delta, -3);
  assert.equal(w.eval("inventory.find(p => p.code === 'C1').qty"), 5);
  assert.equal(JSON.stringify(w.eval("stockTakeState().reasons")), '{}', 'reasons cleared after applying');
  assert.deepEqual(errors, []); close();
});
test('A3: stock value by branch - this branch from its stock, others from the loaded copy, "Load" when not loaded', async () => {
  const { w, errors, close } = await open();
  w.eval("branchesSummaryCache = { branches: [{ id: 'B0', name: 'Main', isSelf: true }, { id: 'B1', name: 'Town', isSelf: false }, { id: 'B2', name: 'Far', isSelf: false }] }");
  w.eval("branchDetailCache['B1'] = { inventory: [{ code: 'Z', type: 'item', name: 'Z', category: 'X', price: 100, wholesalePrice: 50, qty: 4 }] }");
  const r = JSON.parse(w.eval("JSON.stringify(srBranchValuation())"));
  assert.equal(r.length, 3);
  assert.equal(r[0].totals.cost, 8 * 40 + 30 * 10); assert.equal(r[1].totals.cost, 200); assert.equal(r[2].loaded, false);
  assert.deepEqual(errors, []); close();
});
