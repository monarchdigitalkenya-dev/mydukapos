import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
// zip 228 — Shop and Production keep their own materials; a sale/run at one never touches the other's stock, and reports follow the site.
const SHOP = 'site-shop-1', PROD = 'site-production';
const MATS = JSON.stringify([
  { id: 'm-shop', siteId: SHOP, name: '1.5 BOTTLES', unitCost: 700, sellingPrice: 0, stockQty: 100 },
  { id: 'm-prod', siteId: PROD, name: '1.5ml bottles', unitCost: 8, sellingPrice: 0, stockQty: 100 },
]);
const PRODUCTS = JSON.stringify([
  { code: 'B15', category: 'bottled', name: '1.5L Sealed Bottle', sizeML: 1500, price: 50, wholesalePrice: 30, qty: 50, siteId: SHOP, stock: { [SHOP]: 50, [PROD]: 50 }, priceTiers: [], bom: [{ materialId: 'm-shop', qty: 1 }, { materialId: 'm-prod', qty: 1 }], productionRecipe: [{ materialId: 'm-shop', qtyPerUnit: 1 }, { materialId: 'm-prod', qtyPerUnit: 2 }], vatCategory: 'A' },
]);
const open = (hash) => boot('water/index.html', { storage: { aqua_raw_materials: MATS, aqua_products: PRODUCTS }, wait: 1200, url: hash });
const stock = (w, id) => w.eval(`rawMaterials.find(m => m.id === '${id}').stockQty`);

test('S1: helpers keep only the active site materials', async () => {
  const b = await open();
  const { w } = b;
  assert.equal(w.eval("rowsForSite(products[0].bom, 'site-shop-1').map(r => r.materialId).join()"), 'm-shop');
  assert.equal(w.eval("rowsForSite(products[0].bom, 'site-production').map(r => r.materialId).join()"), 'm-prod');
  b.close();
});

test('S2: a sale at Production uses Production materials only; the Shop materials stay untouched', async () => {
  const b = await open();
  const { w } = b;
  w.eval("activeSiteId = 'site-production'");
  const used = w.eval("deductBomForLine(products[0], 3, undefined, 'site-production')");
  assert.equal(used.length, 1);
  assert.equal(used[0].materialId, 'm-prod');
  assert.equal(stock(w, 'm-prod'), 97);
  assert.equal(stock(w, 'm-shop'), 100, 'the shop stock is not touched by a production sale');
  b.close();
});

test('S3: a sale at the Shop uses Shop materials only', async () => {
  const b = await open();
  const { w } = b;
  w.eval("activeSiteId = 'site-shop-1'");
  w.eval("deductBomForLine(products[0], 2, undefined, 'site-shop-1')");
  assert.equal(stock(w, 'm-shop'), 98);
  assert.equal(stock(w, 'm-prod'), 100);
  b.close();
});

test('S4: the materials window and cost follow the site; a recipe too', async () => {
  const b = await open();
  const { w } = b;
  w.eval("activeSiteId = 'site-production'; openBomModal('product', 'B15')");
  const opts = w.eval("document.getElementById('bom-add-material-select').innerHTML");
  assert.ok(opts.includes('1.5ml bottles') && !opts.includes('1.5 BOTTLES'));
  assert.ok(w.eval("document.getElementById('bom-rows-list').innerHTML").includes('1.5ml bottles'));
  assert.ok(!w.eval("document.getElementById('bom-rows-list').innerHTML").includes('1.5 BOTTLES'));
  assert.equal(w.eval("bomMaterialsCostPerUnit(rowsForSite(products[0].bom))"), 8);
  assert.equal(w.eval("rowsForSite(products[0].productionRecipe)[0].qtyPerUnit"), 2);
  b.close();
});

test('S5: reports follow the site (sales and expenses)', async () => {
  const b = await open();
  const { w } = b;
  const now = new Date().toISOString();
  w.eval(`salesLog = [{ id:'a', siteId:'${SHOP}', timestamp:'${now}', total:100, paid:true, items:[] }, { id:'b', siteId:'${PROD}', timestamp:'${now}', total:40, paid:true, items:[] }];
          expenses = [{ id:'e1', timestamp:'${now}', amount:5 }, { id:'e2', siteId:'${PROD}', timestamp:'${now}', amount:7 }];`);
  w.eval("activeSiteId = 'site-production'");
  assert.equal(w.eval('allTimeRevenue()'), 40);
  assert.equal(w.eval('siteExpenses().length'), 1);
  w.eval("activeSiteId = 'site-shop-1'");
  assert.equal(w.eval('allTimeRevenue()'), 100);
  assert.equal(w.eval('siteExpenses().length'), 1, 'old expenses with no site count as the Shop');
  w.eval("activeSiteId = 'both'");
  assert.equal(w.eval('allTimeRevenue()'), 140);
  b.close();
});
