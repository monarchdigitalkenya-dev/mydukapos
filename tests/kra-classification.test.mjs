import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Section 12/15 of the KRA/eTIMS audit spec: the old merged "Zero-rated /
// exempt" VAT category 'C' must split into distinct 'Z' (Zero-rated) and
// 'E' (Exempt) classifications, existing 'C' items must auto-migrate to
// 'Z' on load (never silently reclassified as Exempt), the tax rate for
// both must stay 0%, and every classification change must be logged.
const INV = JSON.stringify([
  { code: 'LEGACY1', type: 'item', name: 'Legacy Zero/Exempt Item', price: 100, wholesalePrice: 50, qty: 10, unit: 'pcs', vatCategory: 'C' },
  { code: 'STD1', type: 'item', name: 'Standard Item', price: 116, wholesalePrice: 60, qty: 10, unit: 'pcs', vatCategory: 'A' },
]);

for (const app of ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html']) {
test(`${app}: an existing category-C item is auto-migrated to Z (Zero-rated) on load, not silently dropped, and the change is logged on the item`, async () => {
  const b = await boot(app, { storage: { pos_inventory: INV }, wait: 900 });
  const { w } = b;
  const item = w.eval("inventory.find(p => p.code === 'LEGACY1')");
  assert.equal(item.vatCategory, 'Z', 'migrated to Zero-rated, not left as legacy C and not defaulted to Exempt');
  const history = w.eval("inventory.find(p => p.code === 'LEGACY1').kraClassificationHistory");
  assert.ok(Array.isArray(history) && history.length >= 1, 'the migration must leave a classification-history trail');
  assert.equal(history[0].previousValue, 'C');
  assert.equal(history[0].newValue, 'Z');
  assert.equal(history[0].source, 'migration');
  b.close();
});

test(`${app}: Zero-rated (Z), Exempt (E) and Non-VAT (N) all compute to 0% tax, distinctly from the merged legacy bucket`, async () => {
  const b = await boot(app, { storage: { pos_inventory: INV }, wait: 900 });
  const { w } = b;
  assert.equal(w.eval("vatRateForCategory('Z')"), 0);
  assert.equal(w.eval("vatRateForCategory('E')"), 0);
  assert.equal(w.eval("vatRateForCategory('N')"), 0);
  assert.equal(w.eval("vatRateForCategory('A')"), 16);
  assert.equal(w.eval("vatRateForCategory('B')"), 8);
  b.close();
});

test(`${app}: an item with no KRA class/eTIMS codes entered defaults to "Not yet classified", never invented`, async () => {
  const b = await boot(app, { storage: { pos_inventory: INV }, wait: 900 });
  const { w } = b;
  const item = w.eval("inventory.find(p => p.code === 'STD1')");
  assert.equal(item.kra, undefined, 'legacy item never had a kra block written to it, and none is invented just by loading');
  const defaults = w.eval('defaultKraClassification()');
  assert.equal(defaults.status, 'Not yet classified');
  assert.equal(defaults.kraClassCode, '');
  b.close();
});

test(`${app}: saveInventoryItem only marks KRA status Confirmed once both a class code and an eTIMS code are entered, and logs the change`, async () => {
  const b = await boot(app, { storage: { pos_inventory: INV }, wait: 900 });
  const { w } = b;
  w.document.getElementById('inv-name').value = 'Standard Item';
  w.document.getElementById('inv-code').value = 'STD1';
  w.document.getElementById('inv-price').value = '116';
  w.document.getElementById('inv-wholesale-price').value = '60';
  w.document.getElementById('inv-qty').value = '10';
  w.document.getElementById('inv-kra-class-code').value = '';
  w.document.getElementById('inv-kra-etims-code').value = '';
  w.eval('saveInventoryItem()');
  let item = w.eval("inventory.find(p => p.code === 'STD1')");
  assert.equal(item.kra.status, 'Not yet classified', 'blank codes must never auto-confirm a classification');

  // saveInventoryItem() clears the form on success (normal UX for "add
  // another"), so re-fill every field for this second, edit-in-place save.
  w.document.getElementById('inv-name').value = 'Standard Item';
  w.document.getElementById('inv-code').value = 'STD1';
  w.document.getElementById('inv-price').value = '116';
  w.document.getElementById('inv-wholesale-price').value = '60';
  w.document.getElementById('inv-qty').value = '10';
  w.document.getElementById('inv-kra-class-code').value = 'KRA-001';
  w.document.getElementById('inv-kra-etims-code').value = 'ET-001';
  w.eval('saveInventoryItem()');
  item = w.eval("inventory.find(p => p.code === 'STD1')");
  assert.equal(item.kra.status, 'Confirmed');
  assert.equal(item.kra.kraClassCode, 'KRA-001');
  assert.ok(item.kraClassificationHistory.some(h => h.source === 'manual'), 'the manual classification entry must be logged');
  b.close();
});
}
