// zip 183: editing a bale's stock (inventory cell or Edit pop-up) and removing an item survive the sync round trip
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';
import { makeServer, deviceStorage } from './e2e-harness.mjs';

const APP = 'water/index.html';
const BOTTLE = { code: 'B500', category: 'bottled', name: '500ml', price: 20, wholesalePrice: 10, qty: 0, unit: 'pcs', vatCategory: 'A', sizeML: 500, stock: { 'site-shop-1': 48 } };
const PLAIN = { code: 'BAL1', category: 'bale', name: 'Plain bale', price: 400, wholesalePrice: 300, qty: 0, unit: 'pcs', vatCategory: 'A', sizeML: 500, stock: { 'site-shop-1': 0 } };
const LINK = { code: 'BAL2', category: 'bale', name: 'Linked bale', price: 400, wholesalePrice: 300, qty: 0, unit: 'pcs', vatCategory: 'A', sizeML: 500, linkedBottleCode: 'B500', bottlesPerBale: 24, stock: { 'site-shop-1': 0 } };
const TRK = { code: 'BAL3', category: 'bale', name: 'Tracked bale', price: 400, wholesalePrice: 300, qty: 0, unit: 'pcs', vatCategory: 'A', sizeML: 500, trackBottles: true, bottlesPerBale: 24, bottleStock: 0, bottleStockBySite: { 'site-shop-1': 0 }, stock: { 'site-shop-1': 0 } };
const GONE = { code: 'GONE1', category: 'accessory', name: 'To remove', price: 5, wholesalePrice: 2, qty: 0, unit: 'pcs', vatCategory: 'A', stock: { 'site-shop-1': 3 } };
const open = async (s, hash, storage) => {
  const b = await boot(APP, { url: `https://x.mydukapos.store/water/?c=x#${hash}`, fetch: s.fetch, storage, wait: 1200 });
  b.w.eval("showToast = function () {}; window.confirm = () => true; window.alert = () => {}");
  return b;
};
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0), 8000);

test('Aqua: bale stock edits and removals stick after the server round trip', async () => {
  const s = makeServer();
  const d = await open(s, 'shop', { aqua_products: JSON.stringify([BOTTLE, PLAIN, LINK, TRK, GONE]) });
  await d.w.eval('doPush()'); await d.w.eval('pullFromServer()'); await settled(d);
  d.w.eval(`(function(){ updateProductField('BAL1','qty','5'); updateProductField('BAL2','qty','5'); updateProductField('BAL3','qty','5'); removeProduct('GONE1'); setTimeout(ackLocalFields, 0); })()`);   // a pull finishing right after the removal used to erase the pending deletion
  await settled(d);
  await d.w.eval('pullFromServer()'); await settled(d); await d.w.eval('pullFromServer()');
  const r = JSON.parse(d.w.eval(`JSON.stringify({ plain: availableStockForLine(products.find(p=>p.code==='BAL1')), linked: availableStockForLine(products.find(p=>p.code==='BAL2')), tracked: availableStockForLine(products.find(p=>p.code==='BAL3')), gone: products.some(p=>p.code==='GONE1' && !p._deleted) })`));
  const srv = s.serverState().products;
  assert.equal(r.plain, 5, 'plain bale shows 5 on the counter');
  assert.equal(r.linked, 5, 'linked bale shows 5 on the counter');
  assert.equal(r.tracked, 5, 'tracked bale shows 5 on the counter');
  assert.equal(r.gone, false, 'removed item stays removed locally');
  assert.ok(!srv.some((p) => p.code === 'GONE1' && !p._deleted), 'and on the server');
  d.close();
});

test('Aqua: a bale stock edit made in the "All Sites" view is kept (applied to the Shop) and reaches the Sales Counter', async () => {
  const s = makeServer();
  const d = await open(s, 'shop', { aqua_products: JSON.stringify([BOTTLE, PLAIN, LINK, TRK]) });
  await d.w.eval('doPush()'); await d.w.eval('pullFromServer()'); await settled(d);
  d.w.eval("setActiveSite('both')");
  d.w.eval(`(function(){ updateProductField('BAL1','qty','5'); updateProductField('BAL2','qty','5'); updateProductField('BAL3','qty','5'); })()`);
  await settled(d);
  await d.w.eval('pullFromServer()'); await settled(d);
  d.w.eval("syncQtyView('both')");
  const both = JSON.parse(d.w.eval(`JSON.stringify(['BAL1','BAL2','BAL3'].map(c => availableStockForLine(products.find(p => p.code === c))))`));
  assert.deepEqual(both, [5, 5, 5], 'All Sites view shows 5 each');
  d.w.eval("setActiveSite('site-shop-1')");
  const shopV = JSON.parse(d.w.eval(`JSON.stringify(['BAL1','BAL2','BAL3'].map(c => availableStockForLine(products.find(p => p.code === c))))`));
  assert.deepEqual(shopV, [5, 5, 5], 'and so does the Shop Sales Counter');
  // the Edit pop-up now takes a quantity for a linked bale as well
  d.w.eval(`(function(){ openEditProductModal('BAL2'); const i = document.getElementById('edit-product-qty-input'); i.value = '7'; saveProductEditModal(); })()`);
  assert.equal(d.w.eval("availableStockForLine(products.find(p => p.code === 'BAL2'))"), 7);
  d.close();
});
