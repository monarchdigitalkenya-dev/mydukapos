import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 160 - hotel category index safety net: the index used to be refreshed only by queuePush / a pull / hospCatTouch, so a code path that
// edited the inventory without any of them left the chips stale. The index now also validates the fields it was built from.
const INV = () => [
  { code: 'A1', type: 'item', name: 'Soda', category: 'Drinks', price: 100, qty: 10, unit: 'pcs' },
  { code: 'A2', type: 'item', name: 'Water', category: 'Drinks', price: 50, qty: 10, unit: 'pcs' },
  { code: 'A3', type: 'item', name: 'Crisps', category: 'Snacks', price: 60, qty: 10, unit: 'pcs' },
  { code: 'D1', type: 'service', name: 'Burger', category: 'Mains', price: 500, unit: 'pcs' },
];
const J = (w, js) => { const r = w.eval(`JSON.stringify(${js})`); return r === undefined ? undefined : JSON.parse(r); };
async function app() {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV()), pos_utensils: JSON.stringify([{ id: 'u1', name: 'Plates', qty: 4, category: 'Crockery' }]) }, wait: 1200 });
  b.w.eval("showToast = function () {}; window.confirm = () => true");
  return b;
}
const chips = (d, id) => [...d.querySelectorAll(`#${id} .hcat-chip`)].map((x) => x.textContent.replace(/\d+$/, '').trim());
const stale = (w) => w.eval('window.__hospCatDirty = false'); // pretend nobody flagged anything (what an un-flagged edit looks like)

test('edits that bypass queuePush / hospCatTouch never leave the category index stale', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("renderItemImageGrid('')");
  assert.deepEqual(chips(d, 'sc-cat-bar').filter((x) => x !== 'All').sort(), ['Drinks', 'Mains', 'Snacks']);
  const builds0 = J(w, 'window.__hospCatBuilds');
  // 1. a record's category edited in place
  w.eval("inventory.find(p => p.code === 'A3').category = 'Crisps and nuts'"); stale(w);
  assert.equal(J(w, "hospCatIndex().cats.has('cat-item-crisps-and-nuts')"), true, 'the new category name is seen');
  assert.equal(J(w, "hospCatIndex().cats.has('cat-item-snacks')"), false, 'the old one is gone');
  w.eval("renderItemImageGrid('')");
  assert.deepEqual(chips(d, 'sc-cat-bar').filter((x) => x !== 'All').sort(), ['Crisps and nuts', 'Drinks', 'Mains']);
  // 2. a record pushed straight into the array
  w.eval("inventory.push({ code: 'A9', type: 'item', name: 'Juice', category: 'Juices', price: 90, qty: 5, unit: 'pcs' })"); stale(w);
  assert.equal(J(w, "hospCatIndex().counts.get('cat-item-juices')"), 1);
  // 3. a record replaced by another object with the same length (length + array identity are unchanged)
  w.eval("inventory[0] = { code: 'A1', type: 'item', name: 'Soda', category: 'Juices', price: 100, qty: 10, unit: 'pcs' }"); stale(w);
  assert.equal(J(w, "hospCatIndex().counts.get('cat-item-juices')"), 2);
  assert.equal(J(w, "hospCatIndex().counts.get('cat-item-drinks')"), 1);
  // 4. a type change (Item -> Dish) and a categoryId change
  w.eval("inventory.find(p => p.code === 'A2').hospKind = 'dish'"); stale(w);
  assert.equal(J(w, "hospCatIndex().entries.get('A2').kind"), 'dish');
  w.eval("hospCatCreate('item', 'Cold'); inventory.find(p => p.code === 'A3').categoryId = hospCatsOf('item').find(c => c.name === 'Cold').id"); stale(w);
  assert.equal(J(w, "hospCatOfRecord(inventory.find(p => p.code === 'A3')).name"), 'Cold');
  // 5. a record marked deleted, a name edit (sorting / search use it), a utensil edit
  w.eval("inventory.find(p => p.code === 'A9')._deleted = true"); stale(w);
  assert.equal(J(w, "hospCatIndex().entries.has('A9')"), false);
  w.eval("inventory.find(p => p.code === 'D1').name = 'Zebra Burger'"); stale(w);
  assert.equal(J(w, "hospCatIndex().entries.get('D1').name"), 'Zebra Burger');
  w.eval("utensils[0].category = 'Glass'"); stale(w);
  assert.equal(J(w, "hospCatIndex().cats.has('cat-utensil-glass')"), true);
  // 6. a category record edited in place (rename / deactivate) without hospCatSave
  w.eval("hospCatCreate('item', 'Hot')"); stale(w);
  w.eval("hospCategories.find(c => c.name === 'Hot').name = 'Warm'"); stale(w);
  assert.ok(J(w, "hospCatsOf('item').some(c => c.name === 'Warm')") && !J(w, "hospCatsOf('item').some(c => c.name === 'Hot')"));
  w.eval("hospCategories.find(c => c.name === 'Warm').active = false"); stale(w);
  assert.equal(J(w, "hospCatsOf('item', true).some(c => c.name === 'Warm')"), false);
  assert.ok(J(w, 'window.__hospCatBuilds') > builds0, 'rebuilt when something changed');
  b.close();
});

test('the safety net is cheap: unchanged data (and quantity / price edits) never rebuild the index', async () => {
  const b = await app(); const { w } = b;
  w.eval('hospCatIndex()'); const n0 = J(w, 'window.__hospCatBuilds');
  for (let i = 0; i < 50; i++) w.eval('hospCatIndex()');
  w.eval("inventory[0].qty = 3; inventory[0].price = 111; inventory[1].qty -= 1"); stale(w);
  for (let i = 0; i < 20; i++) w.eval('hospCatIndex()');
  assert.equal(J(w, 'window.__hospCatBuilds'), n0, 'no rebuild for sales-type edits');
  // 5,000 records: validating the snapshot stays fast
  w.eval("inventory = []; for (let i = 0; i < 5000; i++) inventory.push({ code: 'X' + i, type: 'item', name: 'Thing ' + i, category: 'Cat ' + (i % 25), price: 10, qty: 5, unit: 'pcs' }); hospCatTouch(); hospCatIndex()");
  const t = w.eval("(() => { const s = performance.now(); for (let i = 0; i < 100; i++) hospCatIndex(); return (performance.now() - s) / 100; })()");
  assert.ok(t < 15, `validating 5,000 records took ${t} ms per call`);
  b.close();
});

test('category names and records sort naturally: case and accents ignored, numbers by value', async () => {
  const b = await app(); const { w } = b;
  w.eval("inventory = ['Soft 10', 'soft 2', 'Éclair', 'eclair b', 'Apple'].map((n, i) => ({ code: 'S' + i, type: 'item', name: n, category: n, price: 1, qty: 1, unit: 'pcs' })); hospCatTouch()");
  assert.deepEqual(J(w, "hospCatsOf('item').map(c => c.name)"), ['Apple', 'Éclair', 'eclair b', 'soft 2', 'Soft 10']);
  w.eval("hospCatOpenManager('item')");
  const names = J(w, "hospCatUiRecList().map(e => e.name)");
  assert.deepEqual(names, ['Apple', 'Éclair', 'eclair b', 'soft 2', 'Soft 10']);
  assert.equal(J(w, "hospCatNameCmp('a', 'A')"), 0);
  b.close();
});
