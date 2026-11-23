import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 215: Aqua POS - visible material cost, staff list per link, removed staff, paid/unpaid stamp mark, hidden tabs, capture sales from a book.
const SHOP = 'site-shop-1', PROD = 'site-production';
const PRODUCTS = JSON.stringify([
  { code: 'B500', category: 'bottled', name: 'Sealed Bottle 500ml', sizeML: 500, price: 50, wholesalePrice: 30, qty: 40, unit: 'pcs', vatCategory: 'A', bom: [{ materialId: 'mat-cap', qty: 1 }], stock: { [SHOP]: 40 } },
  { code: 'B15', category: 'bottled', name: '1.5L Sealed Bottle', sizeML: 1500, price: 120, wholesalePrice: 0, qty: 10, unit: 'pcs', vatCategory: 'A', bom: [], stock: { [SHOP]: 10 } },
  { code: 'DSP', category: 'accessory', name: 'Manual Dispenser', price: 550, wholesalePrice: 0, qty: 3, unit: 'pcs', vatCategory: 'A', bom: [], stock: { [SHOP]: 3 } },
]);
const MATS = JSON.stringify([{ id: 'mat-cap', siteId: SHOP, name: 'Caps', unitCost: 2, stockQty: 100 }, { id: 'mat-old', siteId: SHOP, name: '1.5 BOTTLES', unitCost: 708.5, stockQty: 5 }]);
const STAFF = JSON.stringify([
  { id: 's1', name: 'Nelly', pinHash: 'x1', siteId: SHOP, roles: ['sales-tab'] },
  { id: 's2', name: 'Gone', pinHash: 'x2', siteId: SHOP, roles: ['sales-tab'], removed: true, updatedAt: 5 },
  { id: 's3', name: 'Plant', pinHash: 'x3', siteId: PROD, roles: ['sales-tab'] },
]);
const open = (hash, extra = {}) => boot('water/index.html', { url: `https://x.mydukapos.store/water/?c=x${hash}`, storage: { aqua_products: PRODUCTS, aqua_raw_materials: MATS, aqua_staff: STAFF, aqua_refill_sizes: JSON.stringify([{ id: 'rs20', siteId: SHOP, label: '20L', sizeML: 20000, price: 40, autoPrice: false, vatCategory: 'A', bom: [] }]), ...extra }, wait: 900 });
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true");

test('1. the recipe window shows every material cost, lets it be edited, and a fresh install has no water cost', async () => {
  const b = await open('#shop'); const { w } = b; quiet(w);
  w.eval("bomModalTarget = { type: 'product', code: 'B15' }; products.find(p => p.code === 'B15').bom = [{ materialId: 'mat-old', qty: 1 }];");
  const html = w.eval("(function(){ try { openBomModal('product', 'B15'); } catch (e) {} return document.getElementById('bom-rows-list').innerHTML + '|' + document.getElementById('bom-cost-summary').textContent; })()");
  assert.match(html, /708\.50/, 'the 708.50 is on screen, per row');
  assert.match(html, /Cost each/);
  w.eval("updateBomMaterialCost('mat-old', '0')");
  assert.equal(w.eval("rawMaterials.find(m => m.id === 'mat-old').unitCost"), 0);
  assert.match(w.eval("document.getElementById('bom-cost-summary').textContent"), /KES 0\.00/);
  assert.equal(w.eval('waterCostPerLiter'), 0, 'no water cost is applied until the owner types one');
  b.close();
});

test('2. the plain link lists everyone (zip 248); #production is Production; removed staff are never listed or let in', async () => {
  let b = await open(''); let w = b.w; quiet(w);
  assert.equal(w.eval('activeSiteId'), SHOP, 'no hash = shop even if the device last used production');
  w.eval('renderLoginPicker()');
  let list = w.eval("document.getElementById('login-picker-list').textContent");
  assert.match(list, /Nelly/); assert.match(list, /Plant/); assert.doesNotMatch(list, /Gone/);   // zip 248: the plain link shows all staff
  b.close();
  b = await open('', { aqua_active_site_id: PROD }); w = b.w; quiet(w);
  assert.equal(w.eval('activeSiteId'), PROD, 'zip 356: a device last used in Production opens in Production again (the picker still lists everyone)');
  w.eval('renderLoginPicker()');
  assert.match(w.eval("document.getElementById('login-picker-list').textContent"), /Nelly/, 'shop staff still listed on the plain link');
  b.close();
  b = await open('#production'); w = b.w; quiet(w);
  assert.equal(w.eval('activeSiteId'), PROD);
  w.eval('renderLoginPicker()');
  list = w.eval("document.getElementById('login-picker-list').textContent");
  assert.match(list, /Plant/); assert.doesNotMatch(list, /Nelly/);
  // a removed person can not be picked, and their personal link finds nobody
  w.eval("selectLoginStaff('s2')");
  assert.notEqual(w.eval("document.getElementById('login-staffpin-step').style.display"), 'block');
  assert.equal(w.eval("(function(){ history.replaceState(null, '', '/water/?c=x&staff=s2'); return checkForStaffLoginToken(); })()"), false);
  b.close();
});

test('3. PAID / UNPAID stamp mark: setting syncs, credit sales are UNPAID, everything else PAID', async () => {
  const b = await open('#shop'); const { w } = b; quiet(w);
  assert.equal(w.eval("rxPaidStateOf({ paymentMethod: 'cash' })"), null, 'off by default');
  w.eval("extraSettingsApply({ receiptStampPaid: true })");
  assert.equal(w.eval("extraSettingsCollect().receiptStampPaid"), true);
  assert.equal(w.eval("rxPaidStateOf({ paymentMethod: 'cash', paid: true })"), 'paid');
  assert.equal(w.eval("rxPaidStateOf({ paymentMethod: 'mpesa' })"), 'paid');
  assert.equal(w.eval("rxPaidStateOf({ paymentMethod: 'bill', paid: false })"), 'unpaid');
  assert.equal(w.eval("rxPaidStateOf({ paymentMethod: 'pod', paid: false })"), 'unpaid');
  assert.equal(w.eval("rxPaidStateOf({ paymentMethod: 'bill', paid: true })"), 'paid', 'a bill that has been settled');
  // zip 253: the state is printed as wording on the TOTAL line (no separate picture), so the wording is what must change with it
  assert.equal(w.eval("receiptPaidWording({ paymentMethod: 'cash' })"), 'PAID');
  assert.equal(w.eval("receiptPaidWording({ paymentMethod: 'bill', paid: false })"), 'UNPAID');
  b.close();
});

test('4. Capture Sales: lines are matched to items and refill sizes, and ONE confirm records the sale and takes stock off', async () => {
  const b = await open('#shop', { aqua_tanks: JSON.stringify([{ id: 'tank-1', siteId: SHOP, name: 'Tank', capacityLiters: 5000, currentVolumeLiters: 500 }]) }); const { w } = b; quiet(w);
  assert.equal(typeof w.eval('window.__captureSales'), 'object');
  const res = JSON.parse(w.eval(`JSON.stringify((function(){
    var cs = window.__captureSales; cs.open(); var opts = cs._optionList();
    var ai = [{ detected_name: '500ml bottle', quantity: 5, retail_price: 50 }, { detected_name: 'Dispenser manual', quantity: 1, retail_price: 550 }, { detected_name: '20L refill', quantity: 2, retail_price: 40 }, { detected_name: 'zzzz mystery', quantity: 1, retail_price: 10 }];
    cs._state.lines = ai.map(function (it) { return cs._lineFromAi(it, opts); });
    return cs._state.lines.map(function (l) { return { w: l.written, v: l.v }; });
  })())`));
  assert.equal(res[0].v, 'p:B500'); assert.equal(res[1].v, 'p:DSP'); assert.match(res[2].v, /^r:/); assert.equal(res[3].v, '', 'an unknown line is left for the person to match');
  w.eval("window.__captureSales._showReview()");
  assert.equal(w.eval("document.getElementById('cs-go').disabled"), true, 'cannot confirm while a line is unmatched');
  w.eval("window.__captureSales._state.lines = window.__captureSales._state.lines.slice(0, 3); window.__captureSales._render()");
  assert.equal(w.eval("document.getElementById('cs-go').disabled"), false, w.eval("JSON.stringify(window.__captureSales._state.lines) + document.getElementById('cs-rows').innerHTML.slice(0, 1500)"));
  const before = JSON.parse(w.eval("JSON.stringify({ b: products.find(p=>p.code==='B500').qty, d: products.find(p=>p.code==='DSP').qty, cap: rawMaterials.find(m=>m.id==='mat-cap').stockQty, tank: totalTankVolume(), sales: salesLog.length })"));
  w.eval("window.__captureSales._commit()");
  const after = JSON.parse(w.eval("JSON.stringify({ b: products.find(p=>p.code==='B500').qty, d: products.find(p=>p.code==='DSP').qty, cap: rawMaterials.find(m=>m.id==='mat-cap').stockQty, tank: totalTankVolume(), sales: salesLog.length, last: salesLog[salesLog.length-1] })"));
  assert.equal(after.sales, before.sales + 1, 'one sale recorded');
  assert.equal(after.b, before.b - 5); assert.equal(after.d, before.d - 1);
  assert.equal(after.cap, before.cap - 5, 'the recipe materials come off too');
  assert.equal(before.tank - after.tank, 40, '2 x 20 L off the tank');
  assert.equal(after.last.capturedFromBook, true); assert.equal(after.last.total, 5 * 50 + 550 + 2 * 40);
  assert.equal(after.last.items.length, 3);
  b.close();
});

test('5. restocking from a captured list in the "All Sites" view is kept (it used to show, then vanish on the next sync)', async () => {
  const b = await open('#shop'); const { w } = b; quiet(w);
  w.eval("activeSiteId = 'both'; syncQtyView('both'); captureReviewState = { items: [{ id: 'a', name: 'Manual Dispenser', classification: 'item', qty: '4', unitCost: '', matchedId: 'DSP', confidence: 1 }], sourceType: 'photo', sourceImage: '' }; try { commitCaptureReview(); } catch (e) {}");
  w.eval("activeSiteId = '" + SHOP + "'; syncQtyView(activeSiteId)");
  assert.equal(w.eval("products.find(p => p.code === 'DSP').stock['" + SHOP + "']"), 7, '3 + 4 reached the shop figure');
  b.close();
});
