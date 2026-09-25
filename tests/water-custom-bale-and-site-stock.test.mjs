import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
import { mergeProductRecords, mergeRecordsById } from '../functions/api/_merge.js';

const APP = 'water/index.html';
const bottle = { code: 'BTL500', category: 'bottled', name: '500ml Sealed Bottle', price: 50, wholesalePrice: 20, qty: 0, unit: 'pcs', vatCategory: 'A', sizeML: 500 };
const linkedBale = { code: 'BALE500', category: 'bale', baleKind: 'standard', name: '500ml Bale', price: 500, wholesalePrice: 400, qty: 0, linkedBottleCode: 'BTL500', bottlesPerBale: 24, trackBottles: false, unit: 'pcs', vatCategory: 'A', sizeML: 500 };
const exec = { code: '90005', category: 'bale', baleKind: 'custom', name: '500ml Executive Bale/Case', price: 550, wholesalePrice: 390, qty: 0, bottleStock: 0, trackBottles: true, linkedBottleCode: 'BTL500', bottlesPerBale: 24, unit: 'pcs', vatCategory: 'A', sizeML: 500,
  productionRecipe: [{ materialId: 'mat-1', qtyPerUnit: 24 }] };
const mat = { id: 'mat-1', siteId: 'site-production', name: 'Preform', unitCost: 1, stockQty: 1000 };

async function session(products, extra = {}) {
  const b = await boot(APP, { url: 'https://x.mydukapos.store/water/?c=x#production', storage: { aqua_products: JSON.stringify(products), aqua_raw_materials: JSON.stringify([mat]), ...extra }, wait: 1200 });
  b.w.eval("showToast = function () {}; window.confirm = () => true;");
  return b;
}

test('server merge: a stale Shop push cannot wipe Production stock (per-site timestamps)', () => {
  const stored = { code: 'B20', name: '20L', updatedAt: 1000, stock: { shop: 0, prod: 42 }, siteTimes: { prod: 1000 } };
  // Shop till sold one bottle later on (newer record) but never saw Production's 42
  const incoming = { code: 'B20', name: '20L', updatedAt: 2000, stock: { shop: 3, prod: 0 }, siteTimes: { shop: 2000 } };
  const m = mergeProductRecords(stored, incoming);
  assert.equal(m.stock.prod, 42, "Production's stock survives");
  assert.equal(m.stock.shop, 3, "Shop's own newer change is kept");
  const arr = mergeRecordsById([stored], [incoming], false, 'products');
  assert.equal(arr[0].stock.prod, 42);
  // Same site changed on both sides: newest stamp wins
  const later = mergeProductRecords({ code: 'X', updatedAt: 5, stock: { prod: 1 }, siteTimes: { prod: 5 } }, { code: 'X', updatedAt: 3, stock: { prod: 9 }, siteTimes: { prod: 9 } });
  assert.equal(later.stock.prod, 9);
  // Legacy data without stamps behaves exactly as before (record winner)
  const legacy = mergeProductRecords({ code: 'L', updatedAt: 1, stock: { prod: 5 } }, { code: 'L', updatedAt: 2, stock: { prod: 7 } });
  assert.equal(legacy.stock.prod, 7);
});

test('app stamps only the site whose stock actually changed', async () => {
  const b = await session([{ ...bottle }]);
  const { w } = b;
  w.eval("const p = products.find(x => x.code === 'BTL500'); setStockAt(p, 'site-production', 10);");
  const t = w.eval("JSON.stringify(products.find(x => x.code === 'BTL500').siteTimes)");
  assert.ok(JSON.parse(t)['site-production'] > 0);
  assert.equal(JSON.parse(t)['site-shop-1'], undefined, 'untouched site not stamped');
  b.close();
});

test('custom/executive bale is never stocked: hidden from Factory Stock, produce list, wizard and low-stock alerts', async () => {
  const b = await session([{ ...bottle }, { ...linkedBale }, { ...exec }]);
  const { w, d } = b;
  w.eval('renderProductionTab()');
  assert.ok(!d.getElementById('factory-stock-table-body').textContent.includes('Executive'), 'not in Factory Stock');
  assert.ok(!d.getElementById('production-target-select').innerHTML.includes('90005'), 'not in the Produce dropdown');
  assert.ok(!w.eval('factoryStockEligibleProducts()').some(p => p.code === '90005'), 'not a wizard target');
  assert.ok(!w.eval('lowStockDispatchItems()').some(x => x.product.code === '90005'), 'no low-stock alert');
  assert.ok(d.getElementById('custom-orders-list').textContent.includes('Executive'), 'has its own Custom Orders button');
  assert.equal(w.eval("products.find(p => p.code === '90005').trackBottles"), false);
  w.eval('renderProductsTable()');
  assert.ok(!d.querySelector('#products-table').innerHTML.includes('Bottle Stock (Shop)') || !/90005[\s\S]*Bottle Stock/.test(d.querySelector('#products-table').innerHTML.split('BALE500')[0]), 'no bottle-stock row');
  b.close();
});

test('custom order: uses only its recipe, never touches bottle stock, does not double-deduct at checkout', async () => {
  const b = await session([{ ...bottle, stock: { 'site-production': 500 } }, { ...linkedBale }, { ...exec }]);
  const { w, d } = b;
  w.eval("openBrandedBaleModal('90005', true)");
  d.getElementById('branded-bale-qty-input').value = '2';
  d.getElementById('branded-bale-client-input').value = 'Jane';
  d.getElementById('branded-bale-phone-input').value = '0700';
  d.getElementById('branded-bale-logo-input').value = 'Blue logo';
  w.eval('confirmBrandedBale()');
  assert.equal(d.getElementById('branded-bale-modal-error').textContent, '');
  assert.equal(w.eval("rawMaterials.find(m => m.id === 'mat-1').stockQty"), 1000 - 48, 'recipe materials used');
  assert.equal(w.eval("products.find(p => p.code === 'BTL500').qty"), 500, 'existing bottle stock untouched');
  const line = w.eval("JSON.stringify(Object.values(currentCart)[0])");
  assert.ok(JSON.parse(line).customBaleOrder, 'in cart as a custom order');
  w.eval("deductEntriesForBill(Object.values(currentCart), activeSiteId)");
  assert.equal(w.eval("products.find(p => p.code === 'BTL500').qty"), 500, 'checkout does not deduct again');
  // fixed quantity in the cart
  const key = w.eval("Object.keys(currentCart)[0]");
  w.eval(`changeCartQty('${key}', 1)`);
  assert.equal(w.eval(`currentCart['${key}'].qty`), 2, 'qty of a produced order is fixed');
  b.close();
});

test('custom bale without a recipe records the run and deducts nothing; searching it opens the order form, not "0 in stock"', async () => {
  const noRecipe = { ...exec, productionRecipe: [] };
  const b = await session([{ ...bottle, stock: { 'site-production': 100 } }, { ...noRecipe }]);
  const { w, d } = b;
  w.eval("addBottledToCart('90005')");
  assert.equal(d.getElementById('branded-bale-modal').style.display, 'flex', 'order form opened');
  d.getElementById('branded-bale-qty-input').value = '1';
  d.getElementById('branded-bale-client-input').value = 'A'; d.getElementById('branded-bale-phone-input').value = '1'; d.getElementById('branded-bale-logo-input').value = 'x';
  w.eval('confirmBrandedBale()');
  assert.equal(w.eval("products.find(p => p.code === 'BTL500').qty"), 100);
  assert.equal(w.eval("productionLog.length"), 1);
  b.close();
});

test('after a push, a device that missed another device\'s change pulls it instead of marking itself up to date', async () => {
  const calls = [];
  const serverProducts = [{ ...bottle, stock: { 'site-production': 42 }, siteTimes: { 'site-production': 300 }, updatedAt: 300 }];
  const fetch = (url, opts = {}) => {
    calls.push((opts.method || 'GET') + ' ' + String(url));
    if (String(url).includes('/api/pos-sync')) {
      if (opts.method === 'POST') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, updatedAt: 300, prev: 250 }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ updatedAt: 300, products: serverProducts, sites: [{ id: 'site-shop-1', name: 'Shop', type: 'shop' }, { id: 'site-production', name: 'Production', type: 'production' }] }) });
    }
    return Promise.reject(new Error('offline'));
  };
  const b = await boot(APP, { url: 'https://x.mydukapos.store/water/?c=x#production', fetch, storage: { aqua_products: JSON.stringify([{ ...bottle, stock: { 'site-production': 0 } }]), aqua_last_synced_at: '100' }, wait: 800 });
  const { w } = b;
  w.eval("showToast = function () {}");
  w.localStorage.setItem('aqua_last_synced_at', '100');
  await w.eval('doPush()');
  await new Promise(r => setTimeout(r, 900));
  assert.equal(w.eval("products.find(p => p.code === 'BTL500').stock['site-production']"), 42, "Faith's production reached this device");
  b.close();
});
