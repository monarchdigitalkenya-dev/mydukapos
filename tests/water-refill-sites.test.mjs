import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Live data as it is today: refill sizes exist for the Shop only (stamped with its site id).
const SHOP_ONLY = [
  { id: 'size-1', sizeML: 1000, label: '1L', price: 10, siteId: 'site-shop-1', vatCategory: 'A' },
  { id: 'size-2', sizeML: 20000, label: '20L', price: 180, customPrice: true, siteId: 'site-shop-1', vatCategory: 'A', bom: [{ materialId: 'm1', qty: 1 }] },
];
// Each site has its own bulk tank now — Production needs water of its own to sell a refill.
const TANKS = [
  { id: 'tank-1', siteId: 'site-shop-1', name: 'Tank 1', capacityLiters: 5000, currentVolumeLiters: 5000, lowStockThresholdLiters: 500, refillLog: [] },
  { id: 'tank-site-production', siteId: 'site-production', name: 'Tank 1', capacityLiters: 5000, currentVolumeLiters: 2000, lowStockThresholdLiters: 500, refillLog: [] },
];
const STORE = { aqua_refill_sizes: JSON.stringify(SHOP_ONLY), aqua_tanks: JSON.stringify(TANKS), aqua_active_site_id: 'site-production', aqua_biz_name: 'Aqua Test' };
const cards = (d) => [...d.querySelectorAll('#all-items-grid .size-card .size-label')].map((e) => e.textContent.trim());

test('production: refill cards are there and a refill can be sold', async () => {
  const { w, d, errors, close } = await boot('water/index.html', { url: 'https://demo.mydukapos.store/#production', storage: STORE });
  assert.equal(w.eval('activeSiteId'), 'site-production');
  w.eval('renderAllItemsGrid()');
  assert.deepEqual(cards(d).sort(), ['1L', '20L'], 'Production shows refill sizes');
  d.querySelector('#all-items-grid .size-card').click();
  assert.equal(w.eval('Object.keys(currentCart).length'), 1, 'tapping a size adds it to the cart');
  d.getElementById('cash-tendered-input').value = '1000';
  w.eval('checkoutCart()');
  assert.equal(d.getElementById('checkout-error').textContent, '');
  assert.equal(w.eval('salesLog.length'), 1, 'the refill was sold');
  assert.equal(w.eval('salesLog[0].siteId'), 'site-production');
  assert.match(w.eval('lastReceiptText'), /Refill/);
  assert.deepEqual(errors, []);
  await new Promise((r) => setTimeout(r, 400));   // let the sale's follow-up (eTIMS/sync) callbacks finish before closing
  close();
});

test('production copies the Shop sizes and prices; the Shop is untouched; the Shop materials are not carried over', async () => {
  const { w, close } = await boot('water/index.html', { url: 'https://demo.mydukapos.store/#production', storage: STORE });
  const sizes = JSON.parse(w.eval('JSON.stringify(refillSizes)'));
  const shop = sizes.filter((s) => s.siteId === 'site-shop-1'), prod = sizes.filter((s) => s.siteId === 'site-production');
  assert.equal(shop.length, 2); assert.equal(prod.length, 2);
  assert.deepEqual(prod.map((s) => [s.sizeML, s.price]).sort(), shop.map((s) => [s.sizeML, s.price]).sort());
  assert.deepEqual(prod.find((s) => s.sizeML === 20000).bom, [], 'Shop materials are not deducted at Production');
  assert.deepEqual(shop.find((s) => s.sizeML === 20000).bom, [{ materialId: 'm1', qty: 1 }]);
  assert.equal(new Set(sizes.map((s) => s.id)).size, sizes.length, 'ids are unique');
  close();
});

test('each site prices from its own 1L rate', async () => {
  const { w, close } = await boot('water/index.html', { url: 'https://demo.mydukapos.store/#production', storage: STORE });
  w.eval("refillSizes.push({ id:'p5', sizeML:5000, label:'5L', price:0, siteId:'site-production' }); refillSizes.push({ id:'s5', sizeML:5000, label:'5L', price:0, siteId:'site-shop-1' });");
  w.eval("refillSizes.find(s => s.sizeML===1000 && s.siteId==='site-production').price = 20; recomputeAutoRefillPrices();");
  assert.equal(w.eval("refillSizes.find(s => s.id==='p5').price"), 100, 'Production 5L = 5 x its own 1L');
  assert.equal(w.eval("refillSizes.find(s => s.id==='s5').price"), 50, 'Shop 5L = 5 x the Shop 1L');
  close();
});

test('a size added at Production shows at Production straight away and not at the Shop', async () => {
  const { w, d, errors, close } = await boot('water/index.html', { url: 'https://demo.mydukapos.store/#production', storage: STORE });
  d.getElementById('custom-size-label-input').value = '3L';
  d.getElementById('custom-size-ml-input').value = '3000';
  d.getElementById('custom-size-price-input').value = '40';
  w.eval('saveCustomRefillSize()');
  assert.ok(cards(d).includes('3L'), 'visible immediately at Production');
  w.eval("setActiveSite('site-shop-1'); renderAllItemsGrid();");
  assert.ok(!cards(d).includes('3L'), 'not on the Shop counter');
  assert.deepEqual(errors, []);
  close();
});

test('a fresh install can sell refills at Production too, and a new branch gets sizes', async () => {
  const { w, d, close } = await boot('water/index.html', { url: 'https://demo.mydukapos.store/#production', storage: { aqua_active_site_id: 'site-production' } });
  w.eval('seedDefaultSizesIfEmpty(); renderAllItemsGrid()');   // what first-time setup runs
  assert.ok(cards(d).length >= 3, 'default sizes on Production');
  w.eval("window.prompt = () => 'Westlands'; addShopBranch();");
  w.eval('renderAllItemsGrid()');
  assert.ok(cards(d).length >= 3, 'new branch has refill sizes');
  close();
});

test('the bottle-size picker lists each size once', async () => {
  const { w, d, close } = await boot('water/index.html', { url: 'https://demo.mydukapos.store/#production', storage: STORE });
  w.eval('renderProductSizeSelect()');
  const opts = [...d.querySelectorAll('#product-size-select option')].map((o) => o.value);
  assert.equal(new Set(opts).size, opts.length);
  close();
});

test('a refill size can carry its own cost, editable in Settings, and it is used for COGS instead of the litre-rate fallback', async () => {
  const { w, d, errors, close } = await boot('water/index.html', { url: 'https://demo.mydukapos.store/#production', storage: STORE });
  w.eval("showToast = function () {};");
  // Editable in the settings list.
  w.eval('renderRefillPriceRows()');
  const costInputs = [...d.querySelectorAll('#refill-price-rows input[title*="what one refill"], #refill-price-rows input[placeholder="Cost"]')];
  assert.ok(costInputs.length >= 1, 'a cost input exists per refill size');
  w.eval("updateRefillCost('size-2', '90')");
  assert.equal(w.eval("refillSizes.find(s => s.id === 'size-2').cost"), 90);
  // Adding a size via the modal accepts an optional cost too.
  d.getElementById('custom-size-label-input').value = '5L';
  d.getElementById('custom-size-ml-input').value = '5000';
  d.getElementById('custom-size-price-input').value = '50';
  d.getElementById('custom-size-cost-input').value = '22.5';
  w.eval('saveCustomRefillSize()');
  const created = w.eval("JSON.stringify(refillSizes.find(s => s.label === '5L'))");
  assert.equal(JSON.parse(created).cost, 22.5);
  // A sold refill snapshots that size's cost onto the line, and itemCogs() uses it directly.
  const sale = { waterCostPerLiterAtSale: 999 }; // deliberately wrong, to prove it's ignored when refillCostAtSale is set
  const line = { type: 'refill', refillSizeId: 'size-2', sizeML: 20000, qty: 3, refillCostAtSale: 90, materialsUsed: [] };
  assert.equal(w.eval(`itemCogs(${JSON.stringify(line)}, ${JSON.stringify(sale)})`), 270, '3 × the size\'s own 90 cost, not the litre rate');
  // A size with no cost set still falls back to the litre-rate calculation exactly as before.
  const lineNoCost = { type: 'refill', refillSizeId: 'size-1', sizeML: 1000, qty: 2, refillCostAtSale: null, materialsUsed: [] };
  const saleWithRate = { waterCostPerLiterAtSale: 1.5 };
  assert.equal(w.eval(`itemCogs(${JSON.stringify(lineNoCost)}, ${JSON.stringify(saleWithRate)})`), 3, 'falls back to litres × waterCostPerLiterAtSale');
  assert.deepEqual(errors, []);
  close();
});
