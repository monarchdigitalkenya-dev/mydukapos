import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
import fs from 'node:fs';

// Zip 237 — Aqua: Dispatch tab under a Logistics group; the Dispatch panels moved out of Production.
const PROD = 'site-production', SHOP = 'site-shop-1';
const TANKS = [
  { id: 'tank-p', name: 'Prod Tank', siteId: PROD, capacityLiters: 5000, currentVolumeLiters: 1000, lowStockThresholdLiters: 100, refillLog: [] },
  { id: 'tank-s', name: 'Shop Tank', siteId: SHOP, capacityLiters: 500, currentVolumeLiters: 100, lowStockThresholdLiters: 50, refillLog: [] },
];
const SIZES = [{ id: 'sz-p20', siteId: PROD, sizeML: 20000, label: '20L', refillPrice: 100 }];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app() {
  const b = await boot('water/index.html', { url: 'https://demo.mydukapos.store/#production', storage: { aqua_tanks: JSON.stringify(TANKS), aqua_refill_sizes: JSON.stringify(SIZES) } });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; activeSiteId = 'site-production';");
  return b;
}

test('T1: the nav has a Dispatch tab and the movement tabs sit together after it, in the Logistics block', () => {
  const html = fs.readFileSync('water/index.html', 'utf8');
  const ids = [...html.matchAll(/<button id="([a-z-]+)-tab-btn" class="tab-link/g)].map(m => m[1]);
  const i = ids.indexOf('dispatch');
  assert.ok(i >= 0);
  assert.deepEqual(ids.slice(i, i + 5), ['dispatch', 'deliveries', 'returns', 'restocking', 'tank']);
  assert.match(html, /GROUPS\.splice\(2, 0, \{ id: 'logistics'/);
});

test('T2: Dispatch panels moved: Factory stock + Dispatch History are inside dispatch-tab, not production-tab', async () => {
  const b = await app(); const { d } = b;
  const dt = d.getElementById('dispatch-tab'), pt = d.getElementById('production-tab');
  assert.ok(dt.querySelector('#factory-stock-table-body') && dt.querySelector('#dispatch-history-table'));
  assert.ok(!pt.querySelector('#factory-stock-table-body') && !pt.querySelector('#dispatch-history-table'));
  b.close();
});

test('T3: refill dispatch started from the Dispatch tab works and shows in its history; route banner at Production', async () => {
  const b = await app(); const { w, d } = b;
  w.eval('renderDispatchTab()');
  assert.match(d.getElementById('dispatch-route-banner').textContent, /You are at Production/);
  w.eval('openRefillDispatchModal()');
  d.getElementById('refill-dispatch-mode').value = 'containers';
  d.getElementById('refill-dispatch-size').value = 'sz-p20';
  d.getElementById('refill-dispatch-qty').value = '5';
  w.eval('renderRefillDispatchPreview(); confirmRefillDispatch()');
  assert.equal(J(w, "tanks.find(t => t.id === 'tank-p').currentVolumeLiters"), 900);
  assert.equal(J(w, "tanks.find(t => t.id === 'tank-s').currentVolumeLiters"), 200);
  assert.match(d.getElementById('dispatch-history-table').textContent, /Refill water.*100 L/s);
  b.close();
});

test('T4: shop requests are listed on the tab; away from Production the banner warns and the switch button goes to Production', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("stockRequests.push({ id: 'rq1', timestamp: new Date().toISOString(), code: 'X1', name: 'Test Bottle', fromSiteId: 'site-shop-1', fromSiteName: 'Shop', requestedBy: 'Amy', status: 'pending' }); renderDispatchTab()");
  assert.equal(d.getElementById('dispatch-requests-panel').style.display, '');
  assert.match(d.getElementById('dispatch-requests-list').textContent, /Test Bottle/);
  w.eval("setActiveSite('site-shop-1'); renderDispatchTab()");
  assert.match(d.getElementById('dispatch-route-banner').textContent, /Switch to Production/);
  w.eval('openDispatchTabFromProduction(true)');
  assert.equal(J(w, 'currentSite().type'), 'production');
  b.close();
});

test('T5: Dispatch is a lockable / assignable staff tab', () => {
  const html = fs.readFileSync('water/index.html', 'utf8');
  assert.match(html, /\{ id: 'dispatch-tab', label: '🚚 Dispatch' \}/);
});

test('T6: stock report at Production — opened 9, produced 92, dispatched all 101: Added 92 / Removed 101 / Opening 9 (no more -92), and the shop sees Added 101', async () => {
  const b = await app(); const { w } = b;
  w.eval(`products.push({ code: 'BX1', name: 'Test Bottle', category: 'bottled', qty: 9, price: 10, wholesalePrice: 5, stock: { '${PROD}': 9, '${SHOP}': 0 } });
    const p = products.find(x => x.code === 'BX1'); p.qty += 92; logStockMovement('BX1', 'Test Bottle', 92, 'Production');`);
  w.eval("siteDispatchCode = 'BX1'; openDispatchModal('BX1'); document.getElementById('site-dispatch-qty-input').value = '101'; confirmSiteDispatch();");
  const row = (siteId) => J(w, `(function(){ activeSiteId = '${siteId}'; const r = buildStockReportRows({ from: dateKey(new Date()), to: dateKey(new Date()) }).find(x => x.code === 'BX1'); return r && { o: r.opening, a: r.added, r: r.removed, c: r.closing }; })()`);
  const prod = row(PROD);
  assert.deepEqual([prod.a, prod.r], [92, 101]);
  assert.equal(prod.o, 9);
  assert.equal(prod.c, 0);
  // legacy (unstamped) dispatch rows are told apart by their wording
  w.eval("stockMovementLog.forEach(m => { delete m.siteId; })");
  w.eval("window.__stockReportTotals = null");
  const prod2 = row(PROD);
  assert.deepEqual([prod2.a, prod2.r, prod2.o], [92, 101, 9]);
  b.close();
});
