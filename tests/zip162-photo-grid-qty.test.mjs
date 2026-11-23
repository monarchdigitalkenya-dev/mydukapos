import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 162: every photo card (Sales Counter grid in all modules, the Hotel Orders menu) says how much is left: "12 left", "3.5 kg left",
// amber when at or under the low-stock threshold, nothing for unlimited services, no pill when Out (the card already says so),
// never negative, live after a sale, and a per-device switch ("Show quantity left on photo cards", default ON).
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];
const INV = JSON.stringify([
  { code: 'P1', type: 'item', name: 'Plenty', price: 100, wholesalePrice: 50, qty: 12, unit: 'pcs', vatCategory: 'A' },
  { code: 'K1', type: 'item', name: 'Flour', price: 120, wholesalePrice: 50, qty: 3.5, unit: 'kg', vatCategory: 'A' },   // 3.5 > 3 (threshold) -> not low
  { code: 'L1', type: 'item', name: 'Lowish', price: 60, wholesalePrice: 30, qty: 2, unit: 'pcs', vatCategory: 'A' },
  { code: 'Z1', type: 'item', name: 'Zero', price: 60, wholesalePrice: 30, qty: 0, unit: 'pcs', vatCategory: 'A' },
  { code: 'N1', type: 'item', name: 'Negative', price: 60, wholesalePrice: 30, qty: -4, unit: 'pcs', vatCategory: 'A' },
  { code: 'S1', type: 'service', name: 'Haircut', price: 500, unit: 'pcs', vatCategory: 'A' },
  { code: 'S2', type: 'service', name: 'Burger', price: 500, unit: 'pcs', vatCategory: 'A', recipe: [{ code: 'K1', qtyPerUnit: 0.5 }] },
]);
const cell = (d, name) => [...d.querySelectorAll('#item-image-grid .item-grid-cell')].find((c) => c.querySelector('.igc-name').textContent === name);
const pill = (d, name) => { const c = cell(d, name); return c ? c.querySelector('.igc-stock') : undefined; };
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.prompt = (m, d) => d; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }");

for (const app of APPS) {
  test(`${app}: photo cards show the quantity left (plain, decimal unit, low = amber, out = no pill, unlimited = nothing)`, async () => {
    const b = await boot(app, { storage: { pos_inventory: INV }, wait: 800 });
    const { w, d, errors } = b; quiet(w);
    w.eval("renderItemImageGrid('')");
    assert.equal(pill(d, 'Plenty').textContent, '12 left');
    assert.ok(!pill(d, 'Plenty').classList.contains('igc-stock-low'));
    assert.equal(pill(d, 'Flour').textContent, '3.5 kg left');
    assert.equal(pill(d, 'Lowish').textContent, '2 left');
    assert.ok(pill(d, 'Lowish').classList.contains('igc-stock-low'), 'at or under the low-stock threshold = amber');
    assert.equal(pill(d, 'Zero'), null, 'Out: no pill');
    assert.match(cell(d, 'Zero').querySelector('.igc-price').textContent, /Out of stock/);
    assert.ok(cell(d, 'Zero').querySelector('.igc-price').classList.contains('igc-out'), 'Out of stock is red');
    assert.equal(pill(d, 'Negative'), null, 'never a negative number');
    assert.doesNotMatch(cell(d, 'Negative').textContent, /-\d/);
    if (cell(d, 'Haircut')) assert.equal(pill(d, 'Haircut'), null, 'a service without a recipe is unlimited: nothing shown');
    assert.deepEqual(errors, []);
    b.close();
  });

  test(`${app}: the pill is live (a sale lowers it), and the Settings switch (default ON, per device) turns it off and on`, { timeout: 30000 }, async () => {
    const b = await boot(app, { storage: { pos_inventory: INV }, wait: 900 });
    const { w, d, errors } = b; quiet(w);
    const tg = d.getElementById('show-item-qty-left-toggle');
    assert.ok(tg, 'the toggle exists in Settings next to the Photo Grid one');
    assert.equal(w.eval('showItemQtyLeft'), true, 'default ON');
    assert.equal(tg.getAttribute('onchange'), 'setShowItemQtyLeft(this.checked)');
    w.eval("renderItemImageGrid('')");
    assert.equal(pill(d, 'Plenty').textContent, '12 left');
    w.eval("currentCart = {}; addToCart('P1'); currentCart['P1'].qty = 10; currentPaymentMethod = 'cash'");
    d.getElementById('cash-tendered-input').value = '100000';
    await w.eval('checkoutCart()'); await new Promise((r) => setTimeout(r, 80));
    w.eval("renderItemImageGrid('')");
    assert.equal(pill(d, 'Plenty').textContent, '2 left', 'after selling 10 of 12');
    assert.ok(pill(d, 'Plenty').classList.contains('igc-stock-low'));
    w.eval("setShowItemQtyLeft(false)");
    assert.equal(w.localStorage.getItem('pos_show_item_qty'), 'false');
    assert.equal(pill(d, 'Plenty'), null, 'off: no pills');
    w.eval("setShowItemQtyLeft(true)");
    assert.equal(w.localStorage.getItem('pos_show_item_qty'), 'true');
    assert.equal(pill(d, 'Plenty').textContent, '2 left');
    assert.deepEqual(errors, []);
    b.close();
  });

  test(`${app}: the switch is remembered on this device`, async () => {
    const b = await boot(app, { storage: { pos_inventory: INV, pos_show_item_qty: 'false' }, wait: 700 });
    const { w, d } = b; quiet(w);
    assert.equal(w.eval('showItemQtyLeft'), false);
    w.eval("renderItemImageGrid('')");
    assert.equal(pill(d, 'Plenty'), null);
    b.close();
  });
}

test('services / hotel: a recipe item shows how many the materials on hand can make', async () => {
  for (const app of ['services/index.html', 'hotel/index.html']) {
    const b = await boot(app, { storage: { pos_inventory: INV }, wait: 700 });
    const { w, d } = b; quiet(w);
    w.eval("renderItemImageGrid('')");
    const p = pill(d, 'Burger');
    assert.ok(p, app + ': the Burger card has a pill');
    assert.equal(p.textContent, '7 left', app + ': 3.5 kg / 0.5 kg each');   // getServiceAvailableQty
    b.close();
  }
});

test('hotel: the Orders menu cards carry the pill too, and it is gone when the switch is off', async () => {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: INV }, wait: 800 });
  const { w, d, errors } = b; quiet(w);
  w.eval('renderSvcMenu()');
  const btn = (n) => [...d.querySelectorAll('#svc-menu .svc-menu-btn')].find((x) => x.textContent.includes(n));
  assert.match(btn('Plenty').querySelector('.igc-stock').textContent, /^12 left$/);
  assert.match(btn('Flour').querySelector('.igc-stock').textContent, /^3\.5 kg left$/);
  assert.ok(btn('Lowish').querySelector('.igc-stock-low'));
  assert.equal(btn('Zero').querySelector('.igc-stock'), null);
  assert.match(btn('Zero').textContent, /out of stock/i);
  assert.equal(btn('Haircut').querySelector('.igc-stock'), null);
  w.eval('setShowItemQtyLeft(false)');
  assert.equal(d.querySelectorAll('#svc-menu .igc-stock').length, 0, 'the menu repaints without pills');
  assert.deepEqual(errors, []);
  b.close();
});

test('gridStockInfo: dual-unit shows boxes, variants use their own qty, pieces unit hidden', async () => {
  const b = await boot('index.html', { wait: 600 });
  const { w } = b;
  w.eval("inventory = [{ code: 'D', type: 'item', name: 'Box', price: 1, qty: 5, unit: 'box', dualUnit: true, pieceQty: 2, unitsPerBox: 10 }]");
  assert.equal(w.eval("gridStockInfo(inventory[0]).text"), '5 box left');
  assert.equal(w.eval("gridStockInfo({ code: 'V', variantId: 'x', name: 'v', qty: 4, unit: 'pcs' }).text"), '4 left');
  assert.equal(w.eval("gridStockInfo({ code: 'V', variantId: 'x', name: 'v', qty: -1, unit: 'pcs' }).level"), 'out');
  assert.equal(w.eval("gridStockInfo({ code: 'S', type: 'service', name: 's' })"), null);
  b.close();
});

test('production: a produced item shows how many the materials on hand can make', async () => {
  const inv = JSON.parse(INV); inv.push({ code: 'PR1', type: 'item', name: 'Loaf', price: 90, wholesalePrice: 40, unit: 'pcs', vatCategory: 'A', productionRecipe: [{ code: 'K1', qty: 0.5 }] });
  const b = await boot('production/index.html', { storage: { pos_inventory: JSON.stringify(inv) }, wait: 700 });
  const { w, d } = b; quiet(w);
  w.eval("renderItemImageGrid('')");
  assert.equal(pill(d, 'Loaf').textContent, '7 left');
  w.eval("inventory.find(i => i.code === 'K1').qty = 0.5");
  w.eval("renderItemImageGrid('')");
  assert.equal(pill(d, 'Loaf').textContent, '1 left');
  assert.ok(pill(d, 'Loaf').classList.contains('igc-stock-low'));
  b.close();
});
