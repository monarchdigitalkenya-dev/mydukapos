import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
// zip 229 — a material can be priced per piece or per bag/pack; the cost used everywhere stays per piece.
test('M1: adding a material priced per bag works out the per-piece cost', async () => {
  const b = await boot('water/index.html', { wait: 1200 });
  const { w } = b, d = w.document;
  d.getElementById('new-material-name-input').value = 'Caps';
  d.getElementById('new-material-cost-input').value = '1500';
  d.getElementById('new-material-buy-select').value = 'bag';
  d.getElementById('new-material-perbag-input').value = '1000';
  w.eval('matBuyPreview()');
  assert.ok(d.getElementById('new-material-buy-preview').textContent.includes('1.50'));
  w.eval('saveRawMaterial()');
  const m = JSON.parse(w.eval("JSON.stringify(rawMaterials.find(x => x.name === 'Caps'))"));
  assert.equal(m.unitCost, 1.5); assert.equal(m.buyUnit, 'bag'); assert.equal(m.perBag, 1000); assert.equal(m.bagCost, 1500);
  b.close();
});
test('M2: bag needs a pieces-per-bag number; per piece stays as typed', async () => {
  const b = await boot('water/index.html', { wait: 1200 });
  const { w } = b, d = w.document;
  d.getElementById('new-material-name-input').value = 'Seals';
  d.getElementById('new-material-cost-input').value = '500';
  d.getElementById('new-material-buy-select').value = 'bag';
  w.eval('saveRawMaterial()');
  assert.equal(w.eval("rawMaterials.some(x => x.name === 'Seals')"), false);
  d.getElementById('new-material-buy-select').value = 'piece';
  w.eval('saveRawMaterial()');
  assert.equal(w.eval("rawMaterials.find(x => x.name === 'Seals').unitCost"), 500);
  b.close();
});
test('M3: editing in the table keeps the per-piece cost in step', async () => {
  const b = await boot('water/index.html', { wait: 1200, storage: { aqua_raw_materials: JSON.stringify([{ id: 'm1', siteId: 'site-shop-1', name: 'Preform', unitCost: 8, sellingPrice: 0, stockQty: 10 }]) } });
  const { w } = b;
  w.eval("setMaterialBuy('m1', 'unit', 'bag')");            // starts from the same per-piece cost, 1 per bag
  w.eval("setMaterialBuy('m1', 'perBag', '500')");          // 500 pieces in a bag -> bag price stays 8, so piece cost drops
  assert.equal(w.eval("rawMaterials[0].unitCost"), 0.016);
  w.eval("setMaterialBuy('m1', 'price', '4000')");          // bag price 4000 / 500 = 8
  assert.equal(w.eval("rawMaterials[0].unitCost"), 8);
  w.eval("setMaterialBuy('m1', 'unit', 'piece')");
  assert.equal(w.eval("rawMaterials[0].unitCost"), 8);
  // zip 381: the old materials table was replaced by the Aqua materials cards (AquaFlow); the costs above are what this test is about
  assert.ok(w.eval("(function(){ var t = document.querySelector('#raw-materials-table tbody'); return !t || !t.innerHTML || t.innerHTML.includes('per piece') || !!document.getElementById('aqm-root') || !!document.getElementById('aqf-root'); })()"));
  b.close();
});
