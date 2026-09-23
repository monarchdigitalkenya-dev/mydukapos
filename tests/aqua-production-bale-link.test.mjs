import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// "I produced 24 500ml bale and the linked Sealed Bottle stayed at 0" — a
// bale connected to a Sealed Bottle product (trackBottles off, linkedBottleCode
// set) has no stock of its own: its qty is always a live derivation of the
// linked bottle's actual stock. Production has to credit the BOTTLE, never
// write the bale's own qty directly (that value is silently overwritten by
// the next sync anyway, which is exactly how the bug looked invisible).
const APP = 'water/index.html';
const bottle = { code: 'BTL500', type: 'item', category: 'bottled', name: '500ml Sealed Bottle', price: 50, wholesalePrice: 20, qty: 0, unit: 'pcs', vatCategory: 'A' };
const connectedBale = { code: 'BALE500', type: 'item', category: 'bale', name: '500ml Bale', price: 500, wholesalePrice: 400, qty: 0, unit: 'pcs', vatCategory: 'A', trackBottles: false, linkedBottleCode: 'BTL500', bottlesPerBale: 24 };
const trackedBale = { code: 'BALETRK', type: 'item', category: 'bale', name: 'Tracked Bale', price: 500, wholesalePrice: 400, qty: 0, bottleStock: 0, unit: 'pcs', vatCategory: 'A', trackBottles: true, bottlesPerBale: 24 };

async function session(products) {
  const b = await boot(APP, { storage: { aqua_products: JSON.stringify(products) }, wait: 1200 });
  b.w.eval("showToast = function () {}; window.confirm = () => true; activeSiteId = 'site-production';");
  return b;
}

test('quick-produce (submitProduction): a connected bale credits the linked bottle, not its own qty', async () => {
  const b = await session([{ ...bottle }, { ...connectedBale }]);
  const { w, d } = b;
  d.getElementById('production-target-select').innerHTML = '<option value="product:BALE500">x</option>';
  d.getElementById('production-target-select').value = 'product:BALE500';
  d.getElementById('production-qty-input').value = '24';
  w.eval('submitProduction()');
  assert.equal(w.eval("products.find(p => p.code === 'BTL500').qty"), 24 * 24, 'the bottle received the produced stock (24 bales x 24/bale)');
  assert.equal(w.eval("effectiveBaleQty(products.find(p => p.code === 'BALE500'))"), 24, "the bale's derived qty now correctly shows 24, not 0");
  b.close();
});

test('quick-produce (submitProduction): a trackBottles bale updates its own bottleStock, not a plain qty write that the UI never reads', async () => {
  const b = await session([{ ...trackedBale }]);
  const { w, d } = b;
  d.getElementById('production-target-select').innerHTML = '<option value="product:BALETRK">x</option>';
  d.getElementById('production-target-select').value = 'product:BALETRK';
  d.getElementById('production-qty-input').value = '3'; // 3 bales
  w.eval('submitProduction()');
  assert.equal(w.eval("products.find(p => p.code === 'BALETRK').bottleStock"), 3 * 24, 'bottleStock (the field the UI actually displays for a tracked bale) received the produced bottles');
  b.close();
});

test('Production Wizard: a connected bale target credits the linked bottle too', async () => {
  const b = await session([{ ...bottle }, { ...connectedBale }]);
  const { w } = b;
  w.eval("wizardStepsDraft = [{ name: 'Fill', materials: [] }]"); // no materials needed — just exercise the stock-crediting branch
  w.eval("document.getElementById('wizard-target-select').innerHTML = '<option value=\"BALE500\">x</option>'; document.getElementById('wizard-target-select').value = 'BALE500';");
  w.eval("document.getElementById('wizard-batch-bottles-input').value = '48'"); // 48 bottles = 2 bales worth
  w.eval('submitProductionWizard()');
  assert.equal(w.eval("products.find(p => p.code === 'BTL500').qty"), 48, 'the bottle received the produced bottles directly');
  assert.equal(w.eval("effectiveBaleQty(products.find(p => p.code === 'BALE500'))"), 2, 'the bale correctly derives to 2 (48 / 24 per bale)');
  b.close();
});

test('unticking "track by bottle" alone (no re-ticking needed) immediately re-syncs a connected bale\'s qty from its linked bottle', async () => {
  const b = await session([{ ...bottle, qty: 300 }, { ...connectedBale, trackBottles: true, bottleStock: 999, qty: 999 }]);
  const { w } = b;
  // The bale starts in independent trackBottles mode with a stale qty —
  // unticking it (turning the connection back on) must show the real
  // linked-bottle-derived figure right away, not the stale 999.
  w.eval("updateBaleTrackingField('BALE500', 'trackBottles', false)");
  assert.equal(w.eval("products.find(p => p.code === 'BALE500').qty"), Math.floor(300 / 24), 'a single untick is enough — no need to re-tick to force a sync');
  b.close();
});
