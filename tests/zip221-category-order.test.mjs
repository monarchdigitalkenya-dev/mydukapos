import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 221 - the order of categories: standard, my own order (move up / down), A-Z, Z-A, most items, best selling; shop-wide.
const INV = JSON.stringify([
  { code: 'A1', type: 'item', name: 'Apple', category: 'Fruit', price: 10, wholesalePrice: 5, qty: 9, unit: 'pcs' },
  { code: 'A2', type: 'item', name: 'Pear', category: 'Fruit', price: 10, wholesalePrice: 5, qty: 9, unit: 'pcs' },
  { code: 'A3', type: 'item', name: 'Plum', category: 'Fruit', price: 10, wholesalePrice: 5, qty: 9, unit: 'pcs' },
  { code: 'B1', type: 'item', name: 'Bread', category: 'Bakery', price: 10, wholesalePrice: 5, qty: 9, unit: 'pcs' },
  { code: 'D1', type: 'item', name: 'Cola', category: 'Drinks', price: 10, wholesalePrice: 5, qty: 9, unit: 'pcs' },
  { code: 'D2', type: 'item', name: 'Juice', category: 'Drinks', price: 10, wholesalePrice: 5, qty: 9, unit: 'pcs' },
]);
const SALES = JSON.stringify([{ id: 's1', timestamp: new Date().toISOString(), items: [{ code: 'B1', qty: 50, price: 10 }, { code: 'D1', qty: 5, price: 10 }] }]);
const names = (w) => JSON.parse(w.eval("JSON.stringify(__catTiles.categories().map(c => c.label))"));

test('O1: every order mode lines the categories up as asked, and the choice is saved + travels with the shop settings', async () => {
  const { w, d, close } = await boot('index.html', { storage: { pos_inventory: INV, pos_sales_log: SALES }, wait: 3500 });
  w.eval("showToast = function () {}");
  assert.deepEqual(names(w), ['Bakery', 'Drinks', 'Fruit'], 'standard = A to Z, as before');
  w.eval("__catTiles.setOrderMode('name-desc')"); assert.deepEqual(names(w), ['Fruit', 'Drinks', 'Bakery']);
  w.eval("__catTiles.setOrderMode('items')"); assert.deepEqual(names(w), ['Fruit', 'Drinks', 'Bakery'], '3 / 2 / 1 items');
  w.eval("__catTiles.setOrderMode('sales')"); assert.deepEqual(names(w), ['Bakery', 'Drinks', 'Fruit'], 'bread sold most, then cola');
  w.eval("__catTiles.setOrderMode('manual')");
  // move Fruit to the top with the panel's own buttons
  const click = (k, dd) => { const b = [...d.querySelectorAll('#ctl-panel [data-ctl-act="mv"]')].find((x) => decodeURIComponent(x.getAttribute('data-k')) === k && x.getAttribute('data-d') === String(dd)); assert.ok(b, 'button for ' + k); b.click(); };
  click('Fruit', -1); click('Fruit', -1);
  assert.equal(names(w)[0], 'Fruit');
  assert.deepEqual(JSON.parse(w.eval("JSON.stringify(__catTiles.order().manual)")).slice(0, 1), ['Fruit']);
  const saved = JSON.parse(w.eval("localStorage.getItem('pos_category_order') || localStorage.getItem('pos_cat_order')"));
  assert.equal(saved.mode, 'manual');
  assert.equal(JSON.parse(w.eval("JSON.stringify(collectSyncPayload().catOrder)")).mode, 'manual', 'sent to the server with the shop settings');
  // another device receives it
  w.eval("localStorage.removeItem('pos_cat_order')"); assert.equal(names(w)[0], 'Bakery');
  close();
});
