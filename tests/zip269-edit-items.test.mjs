import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 269 - editing an item that is already in inventory: start / stop selling by the piece, and re-saving an item keeps its history.
const INV = JSON.stringify([
  { code: 'SDA', type: 'item', name: 'Soda crate', category: 'Soft drinks', price: 480, wholesalePrice: 360, qty: 10, unit: 'pcs', vatCategory: 'A', costMethod: 'last', purchases: [{ id: 'p1', at: '2026-10-01T08:00:00Z', ref: 'R1', supplier: 'S', invQty: 10, invUnit: 'pcs', purchaseQty: 10, purchaseUnit: 'pcs', totalCost: 3600, effUnitCost: 360 }], offer: { type: 'percent', value: 10, endAt: Date.now() + 86400000 } },
  { code: 'BRG', type: 'service', name: 'Beef Burger', category: 'Mains', price: 650, wholesalePrice: 0, unit: 'pcs', vatCategory: 'A', offer: { type: 'percent', value: 5, endAt: Date.now() + 86400000 }, sizes: [{ id: 's1', name: 'Large', price: 900, factor: 1.5 }] },
]);
const J = (w, e) => JSON.parse(w.eval(`JSON.stringify(${e})`));
async function app() {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: INV }, wait: 1400 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.print = () => {}");
  return b;
}

test('an existing item can start being sold by the piece, from the edit window, keeping its stock and history', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("openInventoryEditModal('SDA')");
  assert.equal(d.getElementById('inv-edit-dual-toggle-group').style.display, 'block', 'offered for a plain stock item');
  assert.equal(d.getElementById('inv-edit-dual-toggle').checked, false);
  w.eval("invEditToggleDual(true)");
  assert.equal(d.getElementById('inv-edit-dual-setup').style.display, 'block');
  d.getElementById('inv-edit-dual-n').value = '1'; w.eval('invEditDualSave()');
  assert.match(d.getElementById('inv-edit-dual-err').textContent, /2 or more/, 'a box must hold at least 2 pieces');
  d.getElementById('inv-edit-dual-n').value = '24'; w.eval('invEditDualSave()');
  const p = J(w, "inventory.find(x => x.code === 'SDA')");
  assert.deepEqual([p.dualUnit, p.unitsPerBox, p.piecePrice, p.pieceQty, p.qty], [true, 24, 20, 0, 10], 'default piece price = box price / pieces; stock stays as boxes');
  assert.equal(p.pieceWholesalePrice, 15); assert.equal(p.purchases.length, 1, 'purchase history untouched'); assert.ok(p.offer, 'offer untouched');
  assert.equal(d.getElementById('inv-edit-dual-block').style.display, 'block', 'the usual box / piece fields appear');
  // stop selling by the piece (no loose pieces left)
  w.eval("invEditToggleDual(false)");
  const q = J(w, "inventory.find(x => x.code === 'SDA')");
  assert.equal(q.dualUnit, undefined); assert.equal(q.purchases.length, 1); assert.equal(q.qty, 10);
  // loose pieces in stock block turning it off
  w.eval("invEditToggleDual(true); document.getElementById('inv-edit-dual-n').value = '6'; invEditDualSave(); inventory.find(x => x.code === 'SDA').pieceQty = 3; invEditToggleDual(false)");
  assert.equal(J(w, "inventory.find(x => x.code === 'SDA').dualUnit"), true, 'refused while 3 loose pieces are in stock');
  assert.ok(J(w, 'window.__toasts').some((t) => /ERR .*loose piece/.test(t)));
  b.close();
});

test('re-saving a dish or an item from the form keeps what the form does not show (purchase history, offer, cost method) and sizes can be removed', async () => {
  const b = await app(); const { w, d } = b;
  // dish: load it for editing, remove its sizes, save
  w.eval("editService('BRG'); dishSizesDraft = []; renderDishSizes(); saveInventoryItem()");
  const dish = J(w, "inventory.find(x => x.code === 'BRG')");
  assert.ok(dish.offer, 'the quick-sale offer survived the edit'); assert.equal(dish.sizes, undefined, 'sizes removed on purpose stay removed'); assert.equal(dish.price, 650);
  w.eval("setAddItemType('item')");   // item: saved again with the same code
  w.eval(`document.getElementById('inv-code').value = 'SDA'; document.getElementById('inv-name').value = 'Soda crate'; document.getElementById('inv-price').value = '500'; document.getElementById('inv-wholesale-price').value = '360'; document.getElementById('inv-qty').value = '10'; saveInventoryItem()`);
  const it = J(w, "inventory.find(x => x.code === 'SDA')");
  assert.equal(it.price, 500, "the typed price is applied: " + JSON.stringify(J(w, "window.__toasts")));
  assert.equal(it.purchases && it.purchases.length, 1, 'purchase history kept'); assert.equal(it.costMethod, 'last'); assert.ok(it.offer);
  b.close();
});
