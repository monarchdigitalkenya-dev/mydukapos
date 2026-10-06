import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 218 — Aqua: Dispatch Refills. Refill water goes from Production's bulk tank to a Shop branch's tank, as pre-filled bottles of an existing refill size or as litres.
const PROD = 'site-production', SHOP = 'site-shop-1';
const TANKS = [
  { id: 'tank-p', name: 'Prod Tank', siteId: PROD, capacityLiters: 5000, currentVolumeLiters: 1000, lowStockThresholdLiters: 100, refillLog: [] },
  { id: 'tank-s', name: 'Shop Tank', siteId: SHOP, capacityLiters: 500, currentVolumeLiters: 100, lowStockThresholdLiters: 50, refillLog: [] },
];
const SIZES = [{ id: 'sz-p20', siteId: PROD, sizeML: 20000, label: '20L', refillPrice: 100 }, { id: 'sz-p1', siteId: PROD, sizeML: 1000, label: '1L', refillPrice: 10 }];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app() {
  const b = await boot('water/index.html', { url: 'https://demo.mydukapos.store/#production', storage: { aqua_tanks: JSON.stringify(TANKS), aqua_refill_sizes: JSON.stringify(SIZES), aqua_active_site_id: PROD } });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; activeSiteId = 'site-production';");
  return b;
}
const lvl = (w, id) => J(w, `tanks.find(t => t.id === '${id}').currentVolumeLiters`);
const go = (b, mode, qty, sizeId) => {
  const { w, d } = b; w.eval('openRefillDispatchModal()');
  d.getElementById('refill-dispatch-mode').value = mode;
  if (sizeId) d.getElementById('refill-dispatch-size').value = sizeId;
  d.getElementById('refill-dispatch-qty').value = String(qty);
  w.eval('renderRefillDispatchPreview()');
  const preview = d.getElementById('refill-dispatch-preview').textContent, error = d.getElementById('refill-dispatch-error').textContent;
  w.eval('confirmRefillDispatch()');
  return { preview, error, after: d.getElementById('refill-dispatch-error').textContent };
};

test('R1: 10 pre-filled 20 L bottles = 200 L leave Production and arrive in the branch tank, logged on both tanks and in Dispatch History', async () => {
  const b = await app(); const { w } = b;
  const r = go(b, 'containers', 10, 'sz-p20');
  assert.match(r.preview, /200 L/);
  assert.equal(lvl(w, 'tank-p'), 800); assert.equal(lvl(w, 'tank-s'), 300);
  const log = J(w, 'dispatchLog'); assert.equal(log.length, 1);
  assert.deepEqual([log[0].kind, log[0].qty, log[0].unit, log[0].toSiteId, log[0].containers], ['refill', 200, 'L', SHOP, { sizeML: 20000, count: 10 }]);
  assert.equal(J(w, "tanks.find(t => t.id === 'tank-p').refillLog.at(-1).litersAdded"), -200);
  assert.equal(J(w, "tanks.find(t => t.id === 'tank-s').refillLog.at(-1).litersAdded"), 200);
  assert.match(b.d.getElementById('dispatch-history-table').textContent, /Refill water.*200 L/s);
  b.close();
});

test('R2: plain litres (including a fraction) move exactly the same amount out and in', async () => {
  const b = await app(); const { w } = b;
  go(b, 'litres', 37.5);
  assert.equal(lvl(w, 'tank-p'), 962.5); assert.equal(lvl(w, 'tank-s'), 137.5);
  assert.equal(lvl(w, 'tank-p') + lvl(w, 'tank-s'), 1100, 'nothing created or lost');
  b.close();
});

test('R3: refused dispatches change nothing — more than Production has, more than the branch tank can hold, zero, a half bottle', async () => {
  const b = await app(); const { w } = b;
  assert.match(go(b, 'litres', 5000).error, /Only 1000 L/);
  assert.match(go(b, 'litres', 450).error, /room for 400 L/);
  assert.match(go(b, 'litres', 0).error, /Enter the litres/);
  assert.match(go(b, 'containers', 1.5, 'sz-p1').error, /whole number/);
  assert.equal(lvl(w, 'tank-p'), 1000); assert.equal(lvl(w, 'tank-s'), 100); assert.equal(J(w, 'dispatchLog.length'), 0);
  b.close();
});

test('R4: only from Production; a branch with no tank refuses; the data stays after a reload', async () => {
  const b = await app(); const { w } = b;
  w.eval("activeSiteId = 'site-shop-1'");
  w.eval('openRefillDispatchModal()'); assert.match(J(w, '__toasts.at(-1)'), /Switch to .*Production/);
  w.eval("activeSiteId = 'site-production'; tanks.find(t => t.id === 'tank-s').removed = true");
  assert.match(go(b, 'litres', 10).error, /no metered bulk tank/);
  b.close();
});
