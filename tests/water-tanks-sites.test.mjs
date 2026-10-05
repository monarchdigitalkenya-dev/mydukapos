import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';

// Aqua POS: Production and every Shop branch each have their OWN bulk tank(s).
const SHOP = 'site-shop-1', PROD = 'site-production';
// Live data as it was before per-site tanks: one tank list, no siteId anywhere.
const LEGACY = [{ id: 'tank-1', name: 'Tank 1', capacityLiters: 5000, currentVolumeLiters: 3000, lowStockThresholdLiters: 500, refillLog: [{ id: 'r1', timestamp: '2026-01-01T00:00:00Z', litersAdded: 3000, cost: 0, supplier: 'Borehole', servedBy: 'Admin' }] }];
const SIZES = [{ id: 'size-1', sizeML: 1000, label: '1L', price: 10, siteId: SHOP, vatCategory: 'A' }];
const store = (extra = {}) => ({ aqua_tanks: JSON.stringify(LEGACY), aqua_refill_sizes: JSON.stringify(SIZES), aqua_biz_name: 'Aqua Test', ...extra });
const tanksOf = (w, site) => JSON.parse(w.eval(`JSON.stringify(siteTanks('${site}'))`));

test('existing water stays with the Shop; Production gets its own EMPTY tank', async () => {
  const { w, errors, close } = await boot('water/index.html', { storage: store() });
  const shop = tanksOf(w, SHOP), prod = tanksOf(w, PROD);
  assert.equal(shop.length, 1);
  assert.equal(shop[0].id, 'tank-1', 'the original tank record is kept');
  assert.equal(shop[0].currentVolumeLiters, 3000, 'no litres lost in the migration');
  assert.equal(shop[0].refillLog.length, 1, 'refill history kept');
  assert.equal(prod.length, 1);
  assert.equal(prod[0].currentVolumeLiters, 0, 'Production starts empty');
  assert.notEqual(prod[0].id, shop[0].id);
  assert.equal(w.eval(`totalTankVolume('${SHOP}')`), 3000);
  assert.equal(w.eval(`totalTankVolume('${PROD}')`), 0);
  assert.equal(w.eval("totalTankVolume('both')"), 3000);
  assert.deepEqual(errors, []);
  close();
});

test('running the migration again (every load / every pull) never duplicates tanks', async () => {
  const { w, close } = await boot('water/index.html', { storage: store() });
  w.eval('ensureTanksForEverySite(); ensureTanksForEverySite();');
  assert.equal(w.eval('tanks.length'), 2);
  close();
});

test('a Shop sale only draws down the Shop tank', async () => {
  const { w, d, errors, close } = await boot('water/index.html', { storage: store({ aqua_active_site_id: SHOP }) });
  w.eval("addRefillToCart('size-1')");
  d.getElementById('cash-tendered-input').value = '100';
  w.eval('checkoutCart()');
  assert.equal(d.getElementById('checkout-error').textContent, '');
  assert.equal(w.eval('salesLog.length'), 1);
  assert.equal(w.eval(`totalTankVolume('${SHOP}')`), 2999);
  assert.equal(w.eval(`totalTankVolume('${PROD}')`), 0, 'Production untouched');
  assert.deepEqual(errors, []);
  await new Promise((r) => setTimeout(r, 300));
  close();
});

test('a Production sale only draws down the Production tank, and needs water in it', async () => {
  const { w, d, close } = await boot('water/index.html', { url: 'https://demo.mydukapos.store/#production', storage: store({ aqua_active_site_id: PROD }) });
  const sizeId = w.eval("refillSizes.find(s => s.siteId === 'site-production').id");
  w.eval(`addRefillToCart('${sizeId}')`);
  assert.equal(w.eval('Object.keys(currentCart).length'), 0, 'empty Production tank: cannot sell, even though the Shop has 3000L');
  // record a delivery at Production
  d.getElementById('tank-add-target-select').innerHTML = `<option value="${w.eval(`siteTanks('${PROD}')[0].id`)}"></option>`;
  d.getElementById('tank-add-liters-input').value = '500';
  w.eval('addToTank()');
  assert.equal(w.eval(`totalTankVolume('${PROD}')`), 500);
  assert.equal(w.eval(`totalTankVolume('${SHOP}')`), 3000, 'the delivery did not land in the Shop tank');
  w.eval(`addRefillToCart('${sizeId}')`);
  d.getElementById('cash-tendered-input').value = '100';
  w.eval('checkoutCart()');
  assert.equal(w.eval(`totalTankVolume('${PROD}')`), 499);
  assert.equal(w.eval(`totalTankVolume('${SHOP}')`), 3000, 'Shop tank untouched');
  await new Promise((r) => setTimeout(r, 300));
  close();
});

test('a new branch gets its own empty tank; adding tanks stays inside one site', async () => {
  const { w, d, close } = await boot('water/index.html', { storage: store({ aqua_active_site_id: SHOP }) });
  w.eval("window.prompt = () => 'Westlands'; addShopBranch();");
  const branch = JSON.parse(w.eval("JSON.stringify(sites.find(s => s.name === 'Westlands'))"));
  assert.ok(branch, 'branch created');
  assert.equal(tanksOf(w, branch.id).length, 1);
  assert.equal(tanksOf(w, branch.id)[0].currentVolumeLiters, 0);
  w.eval(`setActiveSite('${SHOP}')`);
  d.getElementById('new-tank-name-input').value = 'Tank 2';
  d.getElementById('new-tank-capacity-input').value = '2000';
  w.eval('addNewTank()');
  assert.equal(tanksOf(w, SHOP).length, 2);
  assert.equal(tanksOf(w, PROD).length, 1, 'Production not affected');
  assert.equal(tanksOf(w, branch.id).length, 1, 'other branch not affected');
  close();
});

test('removing a tank: needs to be empty, every site keeps one, and it stays removed', async () => {
  const { w, d, close } = await boot('water/index.html', { storage: store({ aqua_active_site_id: SHOP }) });
  w.eval("window.confirm = () => true");
  d.getElementById('new-tank-name-input').value = 'Tank 2';
  w.eval('addNewTank()');
  const t1 = 'tank-1', t2 = w.eval(`siteTanks('${SHOP}').find(t => t.name === 'Tank 2').id`);
  w.eval(`removeTank('${t1}')`);
  assert.equal(tanksOf(w, SHOP).length, 2, 'a tank with water in it cannot be removed');
  w.eval(`removeTank('${t2}')`);
  assert.equal(tanksOf(w, SHOP).length, 1, 'empty tank removed');
  assert.equal(w.eval(`tanks.find(t => t.id === '${t2}').removed`), true, 'kept as a tombstone so sync cannot resurrect it');
  w.eval("tanks.find(t => t.id === 'tank-1').currentVolumeLiters = 0;");
  w.eval("removeTank('tank-1')");
  assert.equal(tanksOf(w, SHOP).length, 1, 'the last tank of a site cannot be removed');
  w.eval('ensureTanksForEverySite()');
  assert.equal(tanksOf(w, SHOP).length, 1, 'no phantom tank re-created');
  close();
});

test('level correction is applied and recorded in the refill history', async () => {
  const { w, close } = await boot('water/index.html', { storage: store() });
  w.eval("setTankLevel('tank-1', '2500')");
  assert.equal(w.eval("tanks.find(t => t.id === 'tank-1').currentVolumeLiters"), 2500);
  const last = JSON.parse(w.eval("JSON.stringify(tanks.find(t => t.id === 'tank-1').refillLog.slice(-1)[0])"));
  assert.equal(last.litersAdded, -500);
  assert.equal(last.supplier, 'Level correction');
  close();
});

test('bulk orders draw from their own site', async () => {
  const { w, close } = await boot('water/index.html', { storage: store({ aqua_active_site_id: SHOP }) });
  w.eval("window.confirm = () => true; bulkOrders.push({ id:'b1', clientName:'Hotel', volumeLiters: 1000, pricePerLiter: 1, totalPrice: 1000, depositAmount: 0, status:'pending', siteId:'site-shop-1' });");
  w.eval("fulfillBulkOrder('b1')");
  assert.equal(w.eval(`totalTankVolume('${SHOP}')`), 2000);
  assert.equal(w.eval(`totalTankVolume('${PROD}')`), 0);
  close();
});

// --- server: two devices at two sites must not overwrite each other's tanks ---
test('pos-sync merges tanks per record — a stale Production device cannot wipe the Shop tank level', async () => {
  const { onRequestGet, onRequestPost } = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);
  const kvStore = new Map();
  const kv = { async get(k) { return kvStore.has(k) ? kvStore.get(k) : null; }, async put(k, v) { kvStore.set(k, v); }, async delete(k) { kvStore.delete(k); }, async list() { return { keys: [], list_complete: true }; } };
  kvStore.set('license:C1', JSON.stringify({ id: 'C1', type: 'permanent', slug: 'shop' }));
  kvStore.set('license-index:v1', JSON.stringify([{ id: 'C1', slug: 'shop', type: 'permanent', businessName: 'Aqua' }]));
  const env = { mydukapos_kv: kv };
  const post = (body) => onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} , context: { waitUntil() {} } });
  const t0 = Date.now();
  const shopTank = (vol, ts) => ({ id: 'tank-1', siteId: SHOP, name: 'Tank 1', currentVolumeLiters: vol, updatedAt: ts });
  const prodTank = (vol, ts) => ({ id: 'tank-site-production', siteId: PROD, name: 'Tank 1', currentVolumeLiters: vol, updatedAt: ts });
  await post({ updatedAt: t0, businessName: 'Aqua', tanks: [shopTank(3000, t0 - 5000), prodTank(0, t0 - 5000)] });
  // Shop till sells: Shop tank now 2990 (newer)
  await post({ updatedAt: t0, businessName: 'Aqua', tanks: [shopTank(2990, t0), prodTank(0, t0 - 5000)] });
  // Production device (never pulled) records a delivery, still carrying the OLD Shop tank
  await post({ updatedAt: t0, businessName: 'Aqua', tanks: [shopTank(3000, t0 - 5000), prodTank(800, t0 + 10)] });
  const saved = JSON.parse(kvStore.get('pos-data:state:C1'));
  assert.equal(saved.tanks.find((t) => t.id === 'tank-1').currentVolumeLiters, 2990, 'Shop level kept (newest wins per tank)');
  assert.equal(saved.tanks.find((t) => t.id === 'tank-site-production').currentVolumeLiters, 800, 'Production delivery kept');
});

test('the Bulk Tank tab renders per site and in the All Sites view without errors', async () => {
  const { w, d, errors, close } = await boot('water/index.html', { storage: store({ aqua_active_site_id: SHOP }) });
  w.eval('renderTankTab()');
  assert.match(d.getElementById('tank-gauge-label').textContent, /3,000 \/ 5,000 L/);
  assert.match(d.getElementById('tank-site-label').textContent, /Shop/);
  w.eval("activeSiteId = 'both'; renderTankTab()");
  assert.equal(d.querySelectorAll('#tank-cards-list > div').length, 2, 'both sites\' tanks are listed');
  assert.equal(d.getElementById('new-tank-site-select').style.display, '', 'site picker shown for "add tank" in the combined view');
  w.eval(`activeSiteId = '${PROD}'; renderTankTab()`);
  assert.match(d.getElementById('tank-gauge-label').textContent, /^0 \/ 5,000 L/);
  assert.equal(d.querySelectorAll('#tank-cards-list > div').length, 1);
  assert.deepEqual(errors, []);
  close();
});

test('an "infinite" tank never runs out: sales draw from it without depleting it, and it is never flagged low or insufficient', async () => {
  const { w, d, errors, close } = await boot('water/index.html', { storage: store({ aqua_active_site_id: SHOP }) });
  // Off: normal metered behaviour first.
  assert.equal(w.eval(`totalTankVolume('${SHOP}')`), 3000);
  w.eval(`toggleTankInfinite('tank-1', true)`);
  assert.equal(w.eval("tanks.find(t => t.id === 'tank-1').infinite"), true);
  assert.equal(w.eval(`totalTankVolume('${SHOP}')`), Infinity, 'the site now reports bottomless supply');
  // A sale that would exceed the real 3000L stored on the tank still succeeds and doesn't touch the stored level.
  assert.equal(w.eval(`deductFromTanks(50000, '${SHOP}')`), true);
  assert.equal(w.eval("tanks.find(t => t.id === 'tank-1').currentVolumeLiters"), 3000, 'the real litre count is untouched');
  // Dashboard/tab rendering doesn't choke on Infinity.
  w.eval('renderTankTab()');
  assert.match(d.getElementById('tank-gauge-label').textContent, /♾️/);
  assert.doesNotMatch(d.getElementById('tank-gauge-caption').textContent, /Running low/);
  assert.deepEqual(errors, []);
  // Toggling back off restores normal metered behaviour.
  w.eval(`toggleTankInfinite('tank-1', false)`);
  assert.equal(w.eval(`totalTankVolume('${SHOP}')`), 3000);
  close();
});
