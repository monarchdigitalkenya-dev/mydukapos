import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// "Entered price is below the minimum allowed threshold" — a custom/quoted
// price at the Sales Counter must never go below an item's minimumPrice.
// Covers both code shapes in the app suite: root's confirmPriceSelectCustom
// does its own addToCart+performCartPriceChange inline; hospital/hotel's
// version delegates to the shared applyPriceSelectTier() instead — the
// guardrail was added to each call site separately, not to the shared
// function itself (so it never affects a straight Retail/Wholesale pick).
const INV = JSON.stringify([
  { code: 'A1', type: 'item', name: 'Item With A Floor', price: 500, wholesalePrice: 200, wholesaleSellingPrice: 400, minimumPrice: 300, qty: 10, unit: 'pcs', vatCategory: 'A' },
  { code: 'A2', type: 'item', name: 'Item With No Floor', price: 500, wholesalePrice: 200, qty: 10, unit: 'pcs', vatCategory: 'A' },
]);

async function session(app) {
  const b = await boot(app, { storage: { pos_inventory: INV }, wait: 900 });
  b.w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }");
  return b;
}
const last = (w) => (w.__toasts || []).slice(-1)[0] || '';
const tryCustomPrice = async (w, code, price) => {
  w.eval(`openPriceSelectModal('${code}')`);
  const input = w.document.getElementById('price-select-custom-input');
  input.value = String(price);
  await w.eval('confirmPriceSelectCustom()');
};

for (const app of ['index.html', 'hospital/index.html']) {
  test(`${app}: a custom price below the item's minimumPrice is blocked, with the item's own threshold in the message`, async () => {
    const b = await session(app);
    const { w } = b;
    await tryCustomPrice(w, 'A1', 250); // below the 300 floor
    assert.match(last(w), /below the minimum allowed threshold of.*300/, 'names the actual floor, not a generic refusal');
    assert.equal(Object.keys(w.eval('currentCart')).length, 0, 'nothing was added to the cart — the sale is genuinely blocked, not just warned about');
    b.close();
  });

  test(`${app}: a custom price at or above minimumPrice succeeds normally`, async () => {
    const b = await session(app);
    const { w } = b;
    await tryCustomPrice(w, 'A1', 300); // exactly the floor — must be ALLOWED, not treated as "below"
    const key = w.eval('Object.keys(currentCart)[0]');
    assert.equal(Number(w.eval(`currentCart['${key}'].price`)), 300, 'the floor price itself goes through');
    b.close();
  });

  test(`${app}: an item with no minimumPrice set is unaffected — any non-negative custom price works as before`, async () => {
    const b = await session(app);
    const { w } = b;
    await tryCustomPrice(w, 'A2', 1); // absurdly low, but this item has no floor at all
    const key = w.eval('Object.keys(currentCart)[0]');
    assert.equal(Number(w.eval(`currentCart['${key}'].price`)), 1, 'no minimumPrice on the item means no guardrail — matches every item that existed before this feature');
    b.close();
  });

  test(`${app}: picking the preset Retail or Wholesale tier is never blocked by minimumPrice, even if it's below the floor`, async () => {
    const b = await session(app);
    const { w } = b;
    // A1's Wholesale (400) sits ABOVE its floor (300) in the fixture, so
    // exercise the real edge case: an admin-set tier price that happens to
    // sit below minimumPrice must still go through untouched — the
    // guardrail is only ever about a manually TYPED price, never a preset.
    w.eval("inventory.find(p => p.code === 'A1').wholesaleSellingPrice = 100");
    w.eval("openPriceSelectModal('A1')");
    await w.eval("choosePriceSelectOption('wholesale')");
    const key = w.eval('Object.keys(currentCart)[0]');
    assert.equal(Number(w.eval(`currentCart['${key}'].price`)), 100, 'preset tiers bypass the custom-price guardrail entirely, by design');
    b.close();
  });
}
