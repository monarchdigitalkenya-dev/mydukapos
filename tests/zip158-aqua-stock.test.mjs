import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 158 — Aqua audit: dispatch of a connected bale and of fractions, requests answered by the right branch, production with a
// material twice / a missing bottle / fractional bottles, tank fills, stock take precision, restock guards.
const PROD = 'site-production', SHOP = 'site-shop-1';
const BOTTLE = { code: 'BTL', category: 'bottled', name: '500ml Bottle', price: 50, wholesalePrice: 20, qty: 0, unit: 'pcs', vatCategory: 'A', stock: { [PROD]: 240, [SHOP]: 0 } };
const BALE = { code: 'BALE', category: 'bale', name: '500ml Bale', price: 500, wholesalePrice: 400, qty: 0, unit: 'pcs', vatCategory: 'A', trackBottles: false, linkedBottleCode: 'BTL', bottlesPerBale: 24, stock: {} };
const CAP = { code: 'CAP', category: 'accessory', name: 'Cap Box', price: 100, wholesalePrice: 60, qty: 0, unit: 'pcs', vatCategory: 'A', stock: { [PROD]: 10, [SHOP]: 0 } };
const TRK = { code: 'TRK', category: 'bale', name: 'Tracked Bale', price: 500, wholesalePrice: 400, qty: 0, bottleStock: 0, unit: 'pcs', vatCategory: 'A', trackBottles: true, bottlesPerBale: 24, bottleStockBySite: { [PROD]: 48, [SHOP]: 0 }, stock: {} };
const MAT = { id: 'mat-1', siteId: PROD, name: 'Caps', unitCost: 1, stockQty: 5 };
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app(extra = {}) {
  const b = await boot('water/index.html', { storage: { aqua_products: JSON.stringify([BOTTLE, BALE, CAP, TRK]), aqua_raw_materials: JSON.stringify([MAT]), aqua_active_site_id: PROD, ...extra }, wait: 1200 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; activeSiteId = 'site-production'; syncQtyView(activeSiteId)");
  return b;
}
const stock = (w, code, site) => J(w, `stockAt(products.find(p => p.code === '${code}'), '${site}')`);
const dispatch = (b, code, qty, branch) => {
  const { w, d } = b;
  w.eval(`openDispatchModal('${code}')`);
  d.getElementById('site-dispatch-qty-input').value = String(qty);
  if (branch) { d.getElementById('site-dispatch-branch-select').innerHTML = `<option value="${branch}">${branch}</option>`; d.getElementById('site-dispatch-branch-select').value = branch; }
  w.eval('confirmSiteDispatch()');
};

test('W1: dispatching a bale connected to a bottle moves the BOTTLES from Production to the branch', async () => {
  const b = await app(); const { w } = b;
  dispatch(b, 'BALE', 2);
  assert.equal(stock(w, 'BTL', PROD), 240 - 48, 'production lost 2 bales of bottles');
  assert.equal(stock(w, 'BTL', SHOP), 48, 'the branch received them');
  b.close();
});

test('W2: a dispatch only answers the requests of the branch it went to', async () => {
  const b = await app(); const { w } = b;
  w.eval("sites.push({ id: 'site-shop-2', name: 'Branch 2', type: 'shop' }); stockRequests.push({ id: 'q1', code: 'CAP', fromSiteId: 'site-shop-1', status: 'pending' }, { id: 'q2', code: 'CAP', fromSiteId: 'site-shop-2', status: 'pending' })");
  dispatch(b, 'CAP', 1, SHOP);
  assert.deepEqual(J(w, "stockRequests.map(r => [r.id, r.status])"), [['q1', 'fulfilled'], ['q2', 'pending']]);
  b.close();
});

test('W3: dispatching a fraction moves exactly the same amount out and in; a tracked bale never moves 0 bottles', async () => {
  const b = await app(); const { w } = b;
  dispatch(b, 'CAP', 0.3335);
  assert.equal(stock(w, 'CAP', PROD) + stock(w, 'CAP', SHOP), 10, 'nothing created or lost');
  dispatch(b, 'TRK', 0.01);
  assert.equal(J(w, "bottleStockAt(products.find(p => p.code === 'TRK'), 'site-shop-1')"), 0);
  assert.equal(J(w, 'dispatchLog.filter(l => l.sourceCode === "TRK").length'), 0, 'refused, not logged');
  b.close();
});

test('W4: production with one material listed twice is checked as one total; a missing linked bottle deducts nothing', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("products.find(p => p.code === 'CAP').productionRecipe = [{ materialId: 'mat-1', qtyPerUnit: 3 }, { materialId: 'mat-1', qtyPerUnit: 3 }]; renderProductionTargetSelect()");
  d.getElementById('production-target-select').innerHTML = '<option value="product:CAP">x</option>'; d.getElementById('production-target-select').value = 'product:CAP';
  d.getElementById('production-qty-input').value = '1';
  w.eval('submitProduction()');
  assert.equal(J(w, "rawMaterials[0].stockQty"), 5, '6 needed, 5 there: refused');
  assert.equal(stock(w, 'CAP', PROD), 10);
  // the bale's bottle was deleted: nothing may be consumed for a run that cannot credit anything
  w.eval("products.find(p => p.code === 'BALE').productionRecipe = [{ materialId: 'mat-1', qtyPerUnit: 1 }]; products.splice(products.findIndex(p => p.code === 'BTL'), 1)");
  d.getElementById('production-target-select').innerHTML = '<option value="product:BALE">x</option>'; d.getElementById('production-target-select').value = 'product:BALE';
  d.getElementById('production-qty-input').value = '2';
  w.eval('submitProduction()');
  assert.equal(J(w, "rawMaterials[0].stockQty"), 5, 'materials untouched');
  assert.equal(J(w, 'productionLog.length'), 0);
  b.close();
});

test('W5: production of a tracked bale credits whole bottles', async () => {
  const b = await app(); const { w, d } = b;
  d.getElementById('production-target-select').innerHTML = '<option value="product:TRK">x</option>'; d.getElementById('production-target-select').value = 'product:TRK';
  d.getElementById('production-qty-input').value = '1.3';
  w.eval('submitProduction()');
  const bs = J(w, "products.find(p => p.code === 'TRK').bottleStock");
  assert.equal(bs, Math.round(bs), 'no 31.2 bottles');
  b.close();
});

test('W6: a tank fill adds exact litres, cannot pass the tank capacity, and is refused on an infinite tank', async () => {
  const b = await app(); const { w, d } = b;
  const id = w.eval("tanks.find(t => t.siteId === 'site-production').id");
  w.eval(`(function () { const t = tanks.find(x => x.id === '${id}'); t.capacityLiters = 1000; t.currentVolumeLiters = 0.1; })()`);
  const add = (l) => { d.getElementById('tank-add-target-select').innerHTML = `<option value="${id}">t</option>`; d.getElementById('tank-add-target-select').value = id; d.getElementById('tank-add-liters-input').value = String(l); w.eval('addToTank()'); };
  add(0.2);
  assert.equal(J(w, `tanks.find(t => t.id === '${id}').currentVolumeLiters`), 0.3, 'not 0.30000000000000004');
  add(2000);
  assert.equal(J(w, `tanks.find(t => t.id === '${id}').currentVolumeLiters`), 0.3, 'over capacity refused');
  assert.match(d.getElementById('tank-add-error').textContent, /capacity|room/i);
  b.close();
});

test('W7: a stock take of 12.345 leaves the device and the counted movement on the same figure', async () => {
  const b = await app(); const { w } = b;
  w.eval("(function () { const st = aquaStockTakeState(); const row = aquaStockTakeRows().find(x => x.cell.c === 'products' && x.rec.code === 'CAP'); st.counts[aquaCellKey(row.cell)] = '12.345'; })(); aquaStockTakeApply()");
  const m = J(w, "stockMovementLog.filter(x => x.kind === 'count' && x.cell.k.indexOf('CAP') >= 0 || (x.kind === 'count' && x.name && /Cap Box/.test(x.name)))");
  assert.equal(m.length, 1);
  assert.equal(stock(w, 'CAP', PROD), m[0].counted, 'the shelf shows what the movement will set on the server');
  b.close();
});

test('W8: restock refuses an impossible quantity, and a restock of a connected bale adds its bottles', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("restockClassification = 'item'; restockIsNewEntry = false; renderRestockExistingPicker()");
  const go = (code, q) => { const sel = d.getElementById('restock-existing-select'); sel.innerHTML = `<option value="${code}">x</option>`; sel.value = code; { const qi = d.getElementById('restock-qty-input'); qi.type = 'text'; qi.value = q; } w.eval('submitRestock()'); };
  go('CAP', '1e999');
  assert.equal(stock(w, 'CAP', PROD), 10, 'Infinity is not a quantity');
  go('BALE', '2');
  assert.equal(J(w, "products.find(p => p.code === 'BTL').qty"), 240 + 48);
  b.close();
});
