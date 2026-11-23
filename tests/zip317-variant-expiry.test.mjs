import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 317: a variant has its own expiry date (Add New Items, the edit variants window, the Inventory list, the expiry alerts, the products & variants file).
// Also: saving in the edit variants window used to rebuild each variant from the fields on screen, wiping its attributes, barcode, photo, reorder level, active.
const E = (w, code) => JSON.parse(w.eval(`JSON.stringify(${code})`));
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.alert = () => {}");
const inDays = (n) => { const d = new Date(Date.now() + n * 86400000); return d.toISOString().slice(0, 10); };

test('Add New Items: each variant takes its own expiry date (optional); it is saved, listed in Inventory, and dated variants show in the expiry alerts', async () => {
  const { w, d, close } = await boot('index.html', { storage: { pos_inventory: '[]' }, wait: 900 });
  try {
    quiet(w);
    d.getElementById('inv-name').value = 'Fresh Milk'; d.getElementById('inv-code').value = 'MILK'; d.getElementById('inv-price').value = '60'; d.getElementById('inv-wholesale-price').value = '45';
    d.getElementById('inv-has-variants').checked = true; w.eval('toggleVariantsBuilder()');
    w.eval(`variantsDraft.length = 0;
      variantsDraft.push({ id: 'v1', name: '500ml', code: 'MILK-500', price: '60', wholesaleSellingPrice: '', wholesalePrice: '', minimumPrice: '', qty: '10', dualUnit: false, unitsPerBox: '', pieceCode: '', piecePrice: '', pieceWholesalePrice: '', pieceQty: '', expiryDate: '${inDays(3)}' });
      variantsDraft.push({ id: 'v2', name: '1L', code: 'MILK-1L', price: '110', wholesaleSellingPrice: '', wholesalePrice: '', minimumPrice: '', qty: '5', dualUnit: false, unitsPerBox: '', pieceCode: '', piecePrice: '', pieceWholesalePrice: '', pieceQty: '', expiryDate: '' });
      renderVariantRows();`);
    assert.ok(d.querySelectorAll('#variant-rows input[type="date"]').length === 2, 'an expiry box on every variant row');
    w.eval('saveInventoryItem()');
    const milk = E(w, "inventory.find(p => p.code === 'MILK')");
    assert.ok(milk && milk.hasVariants, 'saved with its variants');
    assert.equal(milk.variants.find((v) => v.code === 'MILK-500').expiryDate, inDays(3));
    assert.equal(milk.variants.find((v) => v.code === 'MILK-1L').expiryDate, undefined, 'empty = does not expire');
    // the alerts list the dated variant by name
    const exp = E(w, 'getExpiringItems().map(x => [x.name, x.code, x.daysLeft])');
    assert.deepEqual(exp, [['Fresh Milk — 500ml', 'MILK-500', 3]]);
    // the Inventory list shows it under the variant
    w.eval('renderInventoryTable()');
    const tag = d.querySelector('#inventory-table .inv-var-exp');
    assert.ok(tag, 'an expiry tag on the variant row'); assert.ok(tag.classList.contains('soon'), 'amber: expiring soon');
  } finally { close(); }
});

test('the edit variants window: set, change and clear a variant expiry - and nothing else on the variant is lost', async () => {
  const inv = [{ code: 'SWT', type: 'item', name: 'Sweater', category: 'Uniforms', price: 900, qty: 7, unit: 'pcs', vatCategory: 'A', hasVariants: true, variants: [
    { id: 'a', name: 'Blue / 28', code: 'SWT-B28', attrs: { Colour: 'Blue', Size: '28' }, barcode: '200000000028', image: 'https://x/b.jpg', reorderLevel: 3, active: true, price: 900, wholesalePrice: 600, wholesaleSellingPrice: 850, minimumPrice: 880, qty: 4 },
    { id: 'b', name: 'Blue / 30', code: 'SWT-B30', attrs: { Colour: 'Blue', Size: '30' }, price: 950, wholesalePrice: 630, qty: 3, expiryDate: '2027-01-31' }] }];
  const { w, d, close } = await boot('index.html', { storage: { pos_inventory: JSON.stringify(inv) }, wait: 900 });
  try {
    quiet(w);
    w.eval("openVariantsModal('SWT')");
    const boxes = d.querySelectorAll('#variants-view-list input[type="date"]');
    assert.equal(boxes.length, 2, 'an expiry box per variant'); assert.equal(boxes[1].value, '2027-01-31', 'the saved date is shown');
    w.eval("updateVariantsModalField('a', 'expiryDate', '2026-12-15'); updateVariantsModalField('b', 'expiryDate', ''); saveVariantsModal()");
    const vs = E(w, "inventory.find(p => p.code === 'SWT').variants");
    const a = vs.find((v) => v.id === 'a'), b = vs.find((v) => v.id === 'b');
    assert.equal(a.expiryDate, '2026-12-15'); assert.equal(b.expiryDate, undefined, 'cleared');
    assert.deepEqual(a.attrs, { Colour: 'Blue', Size: '28' }, 'attributes kept'); assert.equal(a.barcode, '200000000028', 'barcode kept');
    assert.equal(a.image, 'https://x/b.jpg', 'photo kept'); assert.equal(a.reorderLevel, 3, 'reorder level kept'); assert.equal(a.active, true);
    assert.equal(a.minimumPrice, 880); assert.equal(a.wholesaleSellingPrice, 850);
    // a bad date is refused with a message, nothing saved
    w.eval("openVariantsModal('SWT'); updateVariantsModalField('a', 'expiryDate', '15/12/2026'); saveVariantsModal()");
    assert.match(d.getElementById('variants-view-modal-error').textContent, /valid expiry date/);
    assert.equal(E(w, "inventory.find(p => p.code === 'SWT').variants.find(v => v.id === 'a').expiryDate"), '2026-12-15');
  } finally { close(); }
});

test('the products & variants file carries each variant expiry both ways', async () => {
  const { w, close } = await boot('index.html', { storage: { pos_inventory: '[]' }, wait: 900 });
  try {
    const shop = [{ code: 'MILK', name: 'Fresh Milk', unit: 'pcs', vatCategory: 'A', qty: 15, hasVariants: true, variants: [
      { id: 'v1', code: 'MILK-500', name: '500ml', attrs: { Size: '500ml' }, price: 60, wholesalePrice: 45, qty: 10, expiryDate: '2026-11-30' },
      { id: 'v2', code: 'MILK-1L', name: '1L', attrs: { Size: '1L' }, price: 110, wholesalePrice: 85, qty: 5 }] }];
    const rows = E(w, `catalogueExportRows(${JSON.stringify(shop)})`);
    const col = rows[0].indexOf('Expiry date');
    assert.deepEqual(rows.slice(1).map((r) => r[col]), ['2026-11-30', ''], 'each variant row has its own expiry');
    // round trip into an empty shop keeps it; an update file changes one variant only
    w.eval('window.__inv = []');
    E(w, `catalogueApply(cataloguePlan(${JSON.stringify(rows)}, { inventory: [], policy: 'both', opening: true }), { inventory: window.__inv }, { importId: 'x' })`);
    assert.deepEqual(E(w, 'catalogueExportRows(window.__inv)'), rows);
    const upd = [['Product SKU', 'Variant SKU', 'Expiry date'], ['MILK', 'MILK-1L', '31/12/2026']];
    E(w, `catalogueApply(cataloguePlan(${JSON.stringify(upd)}, { inventory: window.__inv, policy: 'update' }), { inventory: window.__inv }, { importId: 'u' })`);
    const vs = E(w, "window.__inv[0].variants.map(v => [v.code, v.expiryDate || ''])");
    assert.deepEqual(vs, [['MILK-500', '2026-11-30'], ['MILK-1L', '2026-12-31']]);
    assert.equal(E(w, 'window.__inv[0].qty'), 15, 'stock untouched');
  } finally { close(); }
});
