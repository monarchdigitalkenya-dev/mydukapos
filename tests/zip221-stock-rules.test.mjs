import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 221 - per-item stock rules, OUT OF STOCK, Active/Inactive, Adjust stock with reasons, valuation by category, rename keeps the item.
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const INV = JSON.stringify([
  { code: 'C1', type: 'item', name: 'Cola 500ml', category: 'Drinks', price: 60, wholesalePrice: 40, qty: 8, unit: 'pcs', minStock: 10, reorderLevel: 15, reorderQty: 50 },
  { code: 'P1', type: 'item', name: 'Pens', category: 'Stationery', price: 20, wholesalePrice: 10, qty: 3, unit: 'pcs' },
  { code: 'S1', type: 'service', name: 'Fried Rice', category: 'Meals', price: 300, wholesalePrice: 100, qty: null, unit: '', image: IMG, minStock: 2, recipe: null, comboItems: null },
]);
const open = (app) => boot(app, { storage: { pos_inventory: INV }, wait: 3000 });
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));

test('R1: each item has its own minimum; OUT OF STOCK stays in Inventory and comes back IN STOCK; no own minimum = shop default', async () => {
  const { w, close } = await open('index.html');
  assert.equal(w.eval("stockPillText(inventory.find(p => p.code === 'C1'))"), 'LOW STOCK');         // 8 <= 10
  assert.equal(w.eval("stockPillText(inventory.find(p => p.code === 'P1'))"), 'LOW STOCK');         // 3 <= shop default 3
  w.eval("inventory.find(p => p.code === 'C1').qty = 0");
  assert.equal(w.eval("stockPillText(inventory.find(p => p.code === 'C1'))"), 'OUT OF STOCK');
  assert.ok(w.eval("inventory.some(p => p.code === 'C1')"), 'item is still there');
  w.eval("renderInventoryTable()");
  assert.match(w.eval("document.getElementById('inventory-table-body') ? document.getElementById('inventory-table-body').textContent : document.body.textContent"), /OUT OF STOCK/);
  w.eval("inventory.find(p => p.code === 'C1').qty = 50");
  assert.equal(w.eval("stockPillText(inventory.find(p => p.code === 'C1'))"), 'IN STOCK');
  w.eval("inventory.find(p => p.code === 'C1').minStock = 60");   // alert level above the quantity
  assert.equal(w.eval("stockPillText(inventory.find(p => p.code === 'C1'))"), 'LOW STOCK');
  close();
});

test('R2: reorder level + order quantity drive the low-stock list and the recommended order; Inactive items are not chased', async () => {
  const { w, close } = await open('index.html');
  w.eval("inventory.find(p => p.code === 'C1').qty = 14");      // above min 10, at/below reorder level 15
  assert.equal(w.eval("stockIsLow(inventory.find(p => p.code === 'C1'))"), false);
  assert.ok(J(w, "lowStockItems().map(p => p.code)").includes('C1'));
  assert.equal(w.eval("stockRecommendedQty(inventory.find(p => p.code === 'C1'))"), 50);
  assert.match(w.eval("stockRuleHint(inventory.find(p => p.code === 'C1'))"), /recommended order: 50/);
  w.eval("inventory.find(p => p.code === 'C1').inactive = true");
  assert.ok(!J(w, "lowStockItems().map(p => p.code)").includes('C1'));
  assert.equal(w.eval("stockPillText(inventory.find(p => p.code === 'C1'))"), 'INACTIVE');
  close();
});

test('R3: Adjust stock records the reason in the movement log, refuses more than is in stock, and an Inactive item cannot be sold', async () => {
  const { w, close } = await open('index.html'); w.eval("showToast = function () {}");
  const r = J(w, "srApplyAdjustment('C1', 'out', 3, 'Damaged', 'crate dropped')");
  assert.deepEqual([r.ok, r.delta, r.qty], [true, -3, 5]);
  const m = J(w, "stockMovementLog.filter(x => x.code === 'C1').pop()");
  assert.equal(m.delta, -3); assert.match(m.reason, /Stock adjustment — Damaged: crate dropped/);
  assert.equal(J(w, "srApplyAdjustment('C1', 'out', 99, 'Lost', '')").ok, false);
  assert.equal(w.eval("inventory.find(p => p.code === 'C1').qty"), 5, 'refused = unchanged');
  assert.equal(J(w, "srApplyAdjustment('C1', 'in', 4, 'Found stock', '')").qty, 9);
  assert.equal(J(w, "srApplyAdjustment('C1', 'in', 0, 'Found stock', '')").ok, false);
  w.eval("inventory.find(p => p.code === 'P1').inactive = true; currentCart = {}; addToCart('P1')");
  assert.equal(w.eval("Object.keys(currentCart).length"), 0, 'an Inactive item is not added to the sale');
  close();
});

test('R4: stock value by category uses the Cost Price, never the selling price', async () => {
  const { w, close } = await open('index.html');
  const rows = J(w, 'srValuationRows()'); const d = rows.find((r) => r.cat === 'Drinks');
  assert.equal(d.cost, 8 * 40); assert.equal(d.retail, 8 * 60);
  assert.ok(rows.find((r) => r.cat === 'Stationery'));
  assert.ok(!rows.find((r) => r.cat === 'Meals'), 'a service is not stock');
  close();
});

for (const app of ['index.html', 'hotel/index.html']) {
  test(`${app}: renaming a dish / service from the Add Item form keeps the same item - photo, code, own stock rule - and makes no duplicate`, async () => {
    const { w, d, close } = await open(app); w.eval("showToast = function () {}");
    w.eval("editService('S1')");
    assert.match(d.getElementById('svc-edit-banner').textContent, /Editing Fried Rice/);
    d.getElementById('inv-name').value = 'Special Fried Rice';
    w.eval('saveInventoryItem()');
    const all = J(w, "inventory.filter(p => p.type === 'service')");
    assert.equal(all.length, 1, 'no duplicate left behind');
    assert.equal(all[0].name, 'Special Fried Rice'); assert.equal(all[0].code, 'S1', 'same code'); assert.equal(all[0].image, IMG, 'photo kept'); assert.equal(all[0].minStock, 2, 'own stock rule kept');
    assert.notEqual(d.getElementById('svc-edit-banner').style.display, 'flex', 'edit mode ends after saving');
    // a NEW dish typed afterwards is a new item, not a rename of the old one
    w.eval("setAddItemType('service')");
    d.getElementById('inv-name').value = 'Pilau'; d.getElementById('inv-price').value = '250';
    w.eval('saveInventoryItem()');
    assert.equal(J(w, "inventory.filter(p => p.type === 'service').length"), 2);
    assert.equal(J(w, "inventory.find(p => p.code === 'S1').name"), 'Special Fried Rice');
    close();
  });
}
