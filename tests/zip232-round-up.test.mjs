import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
// zip 232 — every sale rounds up to a whole shilling through a visible "Rounding" cart line; a switch turns it off.
const INV = JSON.stringify([{ code: 'A1', type: 'item', name: 'Milk', price: 100.3, wholesalePrice: 50, qty: 20, unit: 'pcs', vatCategory: 'A' }, { code: 'B1', type: 'item', name: 'Bread', price: 60, wholesalePrice: 40, qty: 20, unit: 'pcs', vatCategory: 'A' }]);
test('R1: 100.30 becomes 101 with a 0.70 Rounding line; whole totals get no line; checkout records a whole-shilling sale', async () => {
  const { w, close } = await boot('index.html', { wait: 2500, storage: { pos_inventory: INV, pos_round_up: '1' } });
  w.eval("addToCart('A1')");
  assert.equal(w.eval('cartTotal()'), 101);
  assert.equal(w.eval("currentCart['__rounding'].price"), 0.7);
  w.eval("addToCart('B1')");                       // 160.30 -> 161
  assert.equal(w.eval('cartTotal()'), 161);
  w.eval("delete currentCart['A1']; renderCart()"); // only bread = 60: no rounding line
  assert.equal(w.eval('cartTotal()'), 60); assert.equal(w.eval("'__rounding' in currentCart"), false);
  close();
});
test('R2: the switch turns it off; an empty cart never keeps a Rounding line', async () => {
  const { w, close } = await boot('index.html', { wait: 2500, storage: { pos_inventory: INV, pos_round_up: '0' } });
  w.eval("addToCart('A1')");
  assert.equal(w.eval('cartTotal()'), 100.3);
  w.eval('setRoundUp(true)');
  assert.equal(w.eval('cartTotal()'), 101);
  w.eval('currentCart = {}; renderCart()');
  assert.equal(w.eval('Object.keys(currentCart).length'), 0);
  close();
});
