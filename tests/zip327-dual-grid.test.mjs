import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 327: box-and-piece items were in the search results but NOT in the photo grid (renderItemImageGrid filtered dualUnit out).
// Now: ONE tile per item with a Box and a Piece button; each button deducts stock with the item's OWN conversion factor.
const APPS = ['index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];
const INV = JSON.stringify([
  { code: 'D1', type: 'item', name: 'Soda Crate', price: 600, wholesalePrice: 400, qty: 5, unit: 'box', dualUnit: true, unitsPerBox: 12, pieceCode: 'D1P', piecePrice: 60, pieceWholesalePrice: 33, pieceQty: 0, looseUnit: 'pcs', vatCategory: 'A', category: 'Drinks' },
  { code: 'D2', type: 'item', name: 'Tray of Eggs', price: 450, wholesalePrice: 300, qty: 3, unit: 'tray', dualUnit: true, unitsPerBox: 30, pieceCode: 'D2P', piecePrice: 16, pieceWholesalePrice: 11, pieceQty: 4, looseUnit: 'pcs', vatCategory: 'A', category: 'Drinks' },
  { code: 'P1', type: 'item', name: 'Plain Item', price: 100, wholesalePrice: 50, qty: 12, unit: 'pcs', vatCategory: 'A', category: 'Drinks' },
  { code: 'D3', type: 'item', name: 'Empty Box Item', price: 90, wholesalePrice: 50, qty: 0, unit: 'box', dualUnit: true, unitsPerBox: 6, pieceCode: 'D3P', piecePrice: 15, pieceWholesalePrice: 8, pieceQty: 0, looseUnit: 'pcs', vatCategory: 'A', category: 'Drinks' },
]);
const cells = (d, name) => [...d.querySelectorAll('#item-image-grid .item-grid-cell')].filter((c) => c.querySelector('.igc-name') && c.querySelector('.igc-name').textContent === name);
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.prompt = (m, d) => d; window.print = () => {}");

for (const app of APPS) {
  test(`${app}: a box-and-piece item is ONE tile in the photo grid with Box and Piece buttons (and plain items are unchanged)`, async () => {
    const b = await boot(app, { storage: { pos_inventory: INV }, wait: 800 });
    const { w, d, errors } = b; quiet(w);
    w.eval("renderItemImageGrid('')");
    assert.equal(cells(d, 'Soda Crate').length, 1, 'exactly one tile, not one per unit');
    assert.equal(cells(d, 'Tray of Eggs').length, 1);
    assert.equal(cells(d, 'Plain Item').length, 1, 'plain item still there');
    const t = cells(d, 'Soda Crate')[0];
    const btns = [...t.querySelectorAll('.igc-u')];
    assert.deepEqual(btns.map((x) => x.dataset.mode), ['box', 'piece']);
    assert.match(btns[0].textContent, /600\.00/, 'box price shown');
    assert.match(btns[1].textContent, /60\.00/, 'piece price shown');
    assert.equal(btns[1].disabled, false, 'pieces can be sold out of an unopened box');
    const empty = cells(d, 'Empty Box Item')[0];
    assert.ok(empty.classList.contains('out-of-stock'), 'both units out of stock -> the tile is greyed out');
    assert.match(empty.textContent, /Out of stock/);
    // search still finds it too
    assert.ok(w.eval("inventory.filter(p => posSearchHit(p, 'soda')).length") >= 1);
    // searching narrows the grid and keeps the dual tile
    w.eval("renderItemImageGrid('crate')");
    assert.equal(cells(d, 'Soda Crate').length, 1);
    assert.equal(cells(d, 'Plain Item').length, 0);
    assert.deepEqual(errors, []);
    b.close();
  });
}

test('index.html: Box and Piece buttons add the right line, price and stock deduction (12 per box comes from the item, not a global)', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: INV, pos_biz_name: 'Biz' }, wait: 800 });
  const { w, d, errors } = b; quiet(w);
  w.eval("renderItemImageGrid('')");
  const t = cells(d, 'Soda Crate')[0];
  t.querySelector('.igc-u[data-mode="piece"]').click();
  let line = JSON.parse(w.eval('JSON.stringify(Object.values(currentCart))'));
  assert.equal(line.length, 1);
  assert.equal(line[0].saleMode, 'piece');
  assert.equal(line[0].price, 60);
  w.eval("renderItemImageGrid('')");
  cells(d, 'Soda Crate')[0].querySelector('.igc-u[data-mode="box"]').click();
  line = JSON.parse(w.eval('JSON.stringify(Object.values(currentCart))'));
  assert.equal(line.length, 2, 'a box line and a piece line');
  assert.ok(line.some((l) => l.saleMode === 'box' && l.price === 600));
  w.eval("currentPaymentMethod = 'cash'");
  d.getElementById('cash-tendered-input').value = '2000';
  await w.eval('checkoutCart()');
  const p = JSON.parse(w.eval("JSON.stringify(inventory.find(x => x.code === 'D1'))"));
  // 5 boxes, 0 loose: 1 box sold (4 left); 1 piece opened a box (3 left) and 11 loose remain  -> 3 boxes + 11 pieces
  assert.equal(p.qty * p.unitsPerBox + p.pieceQty, 5 * 12 - 12 - 1, 'total pieces left = 60 - 12 (one box) - 1 (one piece)');
  assert.equal(w.eval('salesLog.length'), 1);
  // a second product with its OWN factor (30 per tray)
  w.eval("renderItemImageGrid('')");
  cells(d, 'Tray of Eggs')[0].querySelector('.igc-u[data-mode="piece"]').click();
  w.eval("currentPaymentMethod = 'cash'");
  d.getElementById('cash-tendered-input').value = '100';
  await w.eval('checkoutCart()');
  const e = JSON.parse(w.eval("JSON.stringify(inventory.find(x => x.code === 'D2'))"));
  assert.equal(e.qty * e.unitsPerBox + e.pieceQty, 3 * 30 + 4 - 1);
  assert.deepEqual(errors, []);
  b.close();
});

test('index.html: category tiles count box-and-piece items (they used to be skipped)', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: INV, pos_cat_tiles: 'true', pos_cat_plain: 'false' }, wait: 900 });
  const { w, d, errors } = b; quiet(w);
  w.eval("renderItemImageGrid('')");
  const tiles = [...d.querySelectorAll('#ctl-host .ctl-tile, #ctl-host .ctl-plain')];
  const drinks = tiles.find((t) => /Drinks/.test(t.getAttribute('aria-label') || ''));
  assert.ok(drinks, 'the Drinks category tile is drawn');
  assert.match(drinks.getAttribute('aria-label'), /4 items/, '3 box-and-piece items + 1 plain item');
  drinks.click();
  w.eval("renderItemImageGrid('')");
  assert.equal(d.querySelectorAll('#item-image-grid .item-grid-cell').length, 4, 'opening the category shows all four tiles');
  assert.equal(cells(d, 'Soda Crate').length, 1);
  assert.deepEqual(errors, []);
  b.close();
});
