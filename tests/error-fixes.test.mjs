import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';

// Errors reported by real shops (Owner Console -> Errors):
//   "Cannot read properties of undefined (reading 'length')"  — the barcode-scanner keydown handler received a keydown with no `key`
//   "Cannot read properties of undefined (reading 'toFixed')" — an item saved without a price reached a place that shows its price
for (const app of APPS) {
  test(`${app}: a keydown event with no key (some keyboards and autofill send them) does not throw, and the scanner still reads real keys`, async () => {
    const { w, d, errors, close } = await boot(app, { wait: 1200 });
    d.dispatchEvent(new w.Event('keydown', { bubbles: true }));                               // an Event, not a KeyboardEvent: key is undefined
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: '5', bubbles: true }));
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    assert.deepEqual(errors, []);
    close();
  });
}

test('Shop: an item saved WITHOUT a price can be searched, added to the cart, listed and sold as 0 without any error', async () => {
  const inv = [{ code: 'X1', type: 'item', name: 'Mystery Item', qty: 5, unit: 'pcs', vatCategory: 'A' },
    { code: 'X2', type: 'item', name: 'Mystery Box', qty: 5, unit: 'box', vatCategory: 'A', dualUnit: true, unitsPerBox: 6, pieceQty: 0 }];
  const { w, d, errors, close } = await boot('index.html', { storage: { pos_inventory: JSON.stringify(inv) }, wait: 1500 });
  assert.equal(w.eval("getEffectivePrice({ name: 'no price' })"), 0);
  assert.equal(w.eval("getEffectivePrice({ name: 'no price', offer: { type: 'percent', value: 10 } })"), 0);
  w.eval("liveSearch('Mystery')");
  assert.match(d.getElementById('search-results').textContent, /Mystery Item/);
  w.eval("addToCart('X1'); renderCart(); renderInventoryTable(); renderAllViews && renderAllViews()");
  assert.equal(Number(w.eval('cartTotal()')), 0);
  assert.deepEqual(errors, []);
  close();
});
