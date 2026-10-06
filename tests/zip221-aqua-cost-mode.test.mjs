import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 221 - Aqua: an item's cost is EITHER calculated from its materials OR typed in by the owner.
const SHOP = 'site-shop-1';
const PRODUCTS = JSON.stringify([
  { code: 'B15', category: 'bottled', name: '1.5L Sealed Bottle', sizeML: 1500, price: 120, wholesalePrice: 0, qty: 10, unit: 'pcs', vatCategory: 'A', bom: [{ materialId: 'mat-old', qty: 1 }, { materialId: 'mat-cap', qty: 1 }], stock: { [SHOP]: 10 } },
]);
const MATS = JSON.stringify([{ id: 'mat-cap', siteId: SHOP, name: 'Caps', unitCost: 2, stockQty: 100 }, { id: 'mat-old', siteId: SHOP, name: '1.5 BOTTLES', unitCost: 708.5, stockQty: 50 }]);
const open = () => boot('water/index.html', { url: 'https://x.mydukapos.store/water/?c=x#shop', storage: { aqua_products: PRODUCTS, aqua_raw_materials: MATS } });
const sell = (w, qty) => JSON.parse(w.eval(`(function(){ var l = { type: 'bottled', code: 'B15', qty: ${qty}, sizeML: 1500 }; deductEntriesForBill([l], '${SHOP}'); var it = { type: 'bottled', code: 'B15', qty: ${qty}, materialsUsed: l.materialsUsed, fixedCostAtSale: l.fixedCostAtSale }; return JSON.stringify({ cogs: itemCogs(it, {}), line: lineMaterialsCost({ type: 'bottled', code: 'B15', qty: ${qty} }) }); })()`));

test('Z1. default: cost is calculated from the materials, and the screen says so', async () => {
  const b = await open(); const { w } = b; w.eval("showToast = function () {}");
  w.eval("openBomModal('product', 'B15')");
  const mode = w.eval("document.getElementById('bom-cost-mode').textContent");
  assert.match(mode, /Calculate it from the materials above \(KES 710\.50 per unit\)/); assert.match(mode, /type the cost myself/);
  const r = sell(w, 2);
  assert.equal(r.cogs, 1421); assert.equal(r.line, 1421);
  b.close();
});

test('Z2. typed cost: the cost is exactly what was typed, the materials still come off stock, and the typed cost is kept on the sale', async () => {
  const b = await open(); const { w } = b; w.eval("showToast = function () {}");
  w.eval("openBomModal('product', 'B15')");
  w.eval("setBomCostMode('fixed')");
  assert.equal(w.eval("products.find(p => p.code === 'B15').fixedCost"), 710.5, 'starts from what the materials worked out to');
  w.eval("setBomFixedCost('35')");
  assert.match(w.eval("document.getElementById('bom-cost-summary').textContent"), /Cost per unit: KES 35\.00/);
  const r = sell(w, 3);
  assert.equal(r.cogs, 105); assert.equal(r.line, 105);
  assert.equal(w.eval("rawMaterials.find(m => m.id === 'mat-cap').stockQty"), 97, 'materials still deducted');
  assert.equal(w.eval("rawMaterials.find(m => m.id === 'mat-old').stockQty"), 47);
  // an old sale keeps the cost it was sold at, even after the typed cost changes
  const old = JSON.parse(w.eval("JSON.stringify({ type: 'bottled', code: 'B15', qty: 3, fixedCostAtSale: 35, materialsUsed: [{ materialId: 'mat-old', name: 'x', qty: 3, unitCost: 0 }] })"));
  w.eval("setBomFixedCost('50')");
  assert.equal(w.eval(`itemCogs(${JSON.stringify(old)}, {})`), 105);
  // a typed cost of 0 really is 0 (the 708 can never sneak back in)
  w.eval("setBomFixedCost('0')");
  assert.equal(sell(w, 1).cogs, 0);
  // and switching back goes back to the materials
  w.eval("setBomCostMode('materials')");
  assert.equal(sell(w, 1).cogs, 710.5);
  b.close();
});
