import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Water/Aqua POS tax-engine parity. Same VAT category split as every
// other module: legacy 'C' (merged Zero-rated/Exempt) auto-migrates to
// 'Z', and Z/E/N all compute to 0% while staying distinct classifications.
//
// Per-item KRA/eTIMS classification, the classification assistant and
// eTIMS submission validation (below) are also covered here rather than
// in kra-classification.test.mjs / kra-assistant.test.mjs /
// etims-validation.test.mjs, because Aqua POS's own "edit-product-*"
// field ids and "products" catalogue array (rather than the other
// modules' shared "inv-*" Add/Edit Item form and "inventory" array) need
// their own fixtures and DOM ids throughout. X/Z Reports and the Audit
// tab remain separate follow-up work given water's different Reports
// architecture (no shared Reports tab).
const PRODUCTS = JSON.stringify([
  { code: 'LEGACY1', category: 'bottled', name: 'Legacy Zero/Exempt Bottle', sizeML: 500, price: 50, wholesalePrice: 30, qty: 10, vatCategory: 'C' },
  { code: 'STD1', category: 'bottled', name: 'Standard Bottle', sizeML: 500, price: 58, wholesalePrice: 30, qty: 10, vatCategory: 'A' },
]);
const REFILL_SIZES = JSON.stringify([
  { id: 'size-1', sizeML: 20000, label: '20L', price: 100, cost: 0, vatCategory: 'C' },
]);

test('water/index.html: an existing category-C product is auto-migrated to Z (Zero-rated) on load', async () => {
  const b = await boot('water/index.html', { storage: { aqua_products: PRODUCTS }, wait: 900 });
  const { w } = b;
  const p = w.eval("products.find(p => p.code === 'LEGACY1')");
  assert.equal(p.vatCategory, 'Z', 'migrated to Zero-rated, not left as legacy C and not defaulted to Exempt');
  b.close();
});

test('water/index.html: an existing category-C refill size is also auto-migrated to Z', async () => {
  const b = await boot('water/index.html', { storage: { aqua_refill_sizes: REFILL_SIZES }, wait: 900 });
  const { w } = b;
  const s = w.eval("refillSizes.find(s => s.id === 'size-1')");
  assert.equal(s.vatCategory, 'Z');
  b.close();
});

test('water/index.html: Zero-rated (Z), Exempt (E) and Non-VAT (N) all compute to 0% tax, distinctly from the merged legacy bucket', async () => {
  const b = await boot('water/index.html', { storage: {}, wait: 900 });
  const { w } = b;
  assert.equal(w.eval("vatRateForCategory('Z')"), 0);
  assert.equal(w.eval("vatRateForCategory('E')"), 0);
  assert.equal(w.eval("vatRateForCategory('N')"), 0);
  assert.equal(w.eval("vatRateForCategory('A')"), 16);
  assert.equal(w.eval("vatRateForCategory('B')"), 8);
  b.close();
});

test('water/index.html: updateProductField accepts the new Z/E/N categories and still tolerates a legacy C by treating it as Zero-rated', async () => {
  const b = await boot('water/index.html', { storage: { aqua_products: PRODUCTS }, wait: 900 });
  const { w } = b;
  w.eval("updateProductField('STD1', 'vatCategory', 'E')");
  assert.equal(w.eval("products.find(p => p.code === 'STD1').vatCategory"), 'E');
  w.eval("updateProductField('STD1', 'vatCategory', 'C')");
  assert.equal(w.eval("products.find(p => p.code === 'STD1').vatCategory"), 'Z', 'a legacy C value submitted later is still normalized to Z, never left as C');
  b.close();
});

test('water/index.html: a product with no KRA classification yet defaults to "Not yet classified", never invented', async () => {
  const b = await boot('water/index.html', { storage: { aqua_products: PRODUCTS }, wait: 900 });
  const { w } = b;
  const p = w.eval("products.find(p => p.code === 'STD1')");
  assert.equal(p.kra, undefined, 'a legacy product never had a kra block written to it, and none is invented just by loading');
  const defaults = w.eval('defaultKraClassification()');
  assert.equal(defaults.status, 'Not yet classified');
  assert.equal(defaults.kraClassCode, '');
  b.close();
});

test('water/index.html: saveProduct() gives every newly-created product a "Not yet classified" KRA block', async () => {
  const b = await boot('water/index.html', { storage: {}, wait: 900 });
  const { w } = b;
  w.document.getElementById('product-name-input').value = 'New Sealed Bottle 500ml';
  w.document.getElementById('product-price-input').value = '60';
  w.document.getElementById('product-cost-input').value = '30';
  w.document.getElementById('product-qty-input').value = '5';
  w.eval('saveProduct()');
  const p = w.eval("products.find(p => p.name === 'New Sealed Bottle 500ml')");
  assert.ok(p, 'the product should have been created');
  assert.equal(p.kra.status, 'Not yet classified');
  b.close();
});

test('water/index.html: the Edit Item modal only marks KRA status Confirmed once both a class code and an eTIMS code are entered, and logs the change', async () => {
  const b = await boot('water/index.html', { storage: { aqua_products: PRODUCTS }, wait: 900 });
  const { w } = b;
  w.eval("openEditProductModal('STD1')");
  assert.equal(w.document.getElementById('edit-product-kra-status-hint').textContent, 'Not yet classified');

  // Leaving the codes blank must never auto-confirm.
  w.eval('saveProductEditModal()');
  let p = w.eval("products.find(p => p.code === 'STD1')");
  assert.equal(p.kra.status, 'Not yet classified');

  w.eval("openEditProductModal('STD1')");
  w.document.getElementById('edit-product-kra-class-code').value = 'KRA-001';
  w.document.getElementById('edit-product-kra-etims-code').value = 'ET-001';
  w.document.getElementById('edit-product-kra-unit-code').value = 'U1';
  w.eval('saveProductEditModal()');
  p = w.eval("products.find(p => p.code === 'STD1')");
  assert.equal(p.kra.status, 'Confirmed');
  assert.equal(p.kra.kraClassCode, 'KRA-001');
  assert.equal(p.kra.etimsItemCode, 'ET-001');
  assert.ok(Array.isArray(p.kraClassificationHistory) && p.kraClassificationHistory.length >= 1, 'the change must be logged on the product');
  assert.equal(p.kraClassificationHistory.at(-1).source, 'manual');

  // Re-opening the modal must show what was just saved.
  w.eval("openEditProductModal('STD1')");
  assert.equal(w.document.getElementById('edit-product-kra-class-code').value, 'KRA-001');
  assert.equal(w.document.getElementById('edit-product-kra-status-hint').textContent, 'Confirmed');
  b.close();
});

test('water/index.html: KRA classification assistant suggests a category from its reference table and never invents a class/eTIMS code', async () => {
  const b = await boot('water/index.html', { storage: { aqua_products: PRODUCTS }, wait: 900 });
  const { w } = b;
  w.eval("openEditProductModal('STD1')");
  w.document.getElementById('edit-product-name-input').value = 'Bulk Maize Flour 2kg';
  w.eval('runKraClassificationAssistant()');
  const html = w.document.getElementById('edit-product-kra-assist-result').innerHTML;
  assert.match(html, /SUGGESTED MATCH|possible matches/);
  w.eval("acceptKraAssistantSuggestion('Z')");
  assert.equal(w.document.getElementById('edit-product-vat-select').value, 'Z', 'accepting a suggestion only ever sets the VAT category');
  assert.equal(w.document.getElementById('edit-product-kra-class-code').value, '', 'the assistant never invents a class/eTIMS code — those still need a person to enter them');
  b.close();
});

test('water/index.html: KRA classification assistant finds no match for an unrecognized item and lets an admin save a new reference rule', async () => {
  const b = await boot('water/index.html', { storage: { aqua_products: PRODUCTS }, wait: 900 });
  const { w } = b;
  w.eval("openEditProductModal('STD1')");
  w.document.getElementById('edit-product-name-input').value = 'Totally Unrecognizable Widget XYZ';
  w.eval('runKraClassificationAssistant()');
  assert.match(w.document.getElementById('edit-product-kra-assist-result').innerHTML, /NO MATCH FOUND/);
  w.document.getElementById('edit-product-kra-new-rule-keywords').value = 'widget xyz';
  w.document.getElementById('edit-product-kra-new-rule-category').value = 'B';
  w.eval('submitNewKraReferenceRule()');
  // The new rule should now match on a fresh run of the assistant.
  w.eval('runKraClassificationAssistant()');
  assert.match(w.document.getElementById('edit-product-kra-assist-result').innerHTML, /SUGGESTED MATCH/);
  b.close();
});

test('water/index.html: validateSaleForEtims blocks structurally-broken sale lines but never blocks merely for an unconfirmed KRA classification', async () => {
  const b = await boot('water/index.html', { storage: { aqua_products: PRODUCTS }, wait: 900 });
  const { w } = b;
  const badSale = { items: [{ code: 'STD1', name: '', qty: 0, price: -5, vatCategory: 'X' }] };
  const bad = w.eval(`validateSaleForEtims(${JSON.stringify(badSale)})`);
  assert.ok(bad.errors.length >= 3, 'missing name, bad qty, bad price and an unknown VAT category should all be flagged');

  const unclassifiedSale = { items: [{ code: 'STD1', name: 'Standard Bottle', qty: 1, price: 58, vatCategory: 'A' }] };
  const warned = w.eval(`validateSaleForEtims(${JSON.stringify(unclassifiedSale)})`);
  assert.equal(warned.errors.length, 0, 'a structurally valid line is never blocked just for lacking a confirmed KRA classification');
  assert.ok(warned.warnings.length >= 1, 'but it should be flagged as a warning so the classification gap is visible');
  b.close();
});

test('water/index.html: submitSaleToEtimsIfEnabled refuses to submit a structurally-broken sale to eTIMS and never calls the eTIMS API for it', async () => {
  let etimsCalled = false;
  const b = await boot('water/index.html', {
    storage: { aqua_products: PRODUCTS },
    fetch: async (url) => { if (String(url).includes('etims-submit')) etimsCalled = true; return { ok: true, json: async () => ({}) }; },
    wait: 900,
  });
  const { w } = b;
  etimsCalled = false; // boot itself makes unrelated fetch calls (license/pull) — only count what happens after
  const sale = { id: 'sTest1', paid: true, items: [{ code: 'STD1', name: '', qty: 0, price: 58, vatCategory: 'A' }] };
  w.eval(`salesLog.push(${JSON.stringify(sale)})`);
  await w.eval("submitSaleToEtimsIfEnabled(salesLog.find(s => s.id === 'sTest1'))");
  const saved = w.eval("salesLog.find(s => s.id === 'sTest1')");
  assert.equal(saved.etimsStatus, 'validation_failed');
  assert.ok(Array.isArray(saved.etimsValidationErrors) && saved.etimsValidationErrors.length >= 1);
  assert.equal(etimsCalled, false, 'a structurally-broken sale must never reach the eTIMS API');
  b.close();
});
