import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Closes the checkout gap: a typed cart-line price and a custom total quote
// used to ignore minimum prices entirely (for every item, variants included).
// The preset Retail/Wholesale buttons stay exempt — those are the owner's own
// prices, not a staff-negotiated one.
const JERSEY = {
  code: 'JER', type: 'item', name: 'Jersey', price: 3000, wholesaleSellingPrice: 2000, wholesalePrice: 1500, minimumPrice: 2500, qty: 13, unit: 'pcs', vatCategory: 'A', hasVariants: true,
  variants: [
    { id: 'vxl', name: 'XL', code: 'JER-XL', price: 3200, wholesalePrice: 1500, minimumPrice: 2800, qty: 5 },
    { id: 'vl', name: 'L', code: 'JER-L', price: 3000, wholesalePrice: 1500, qty: 8 }, // saved before per-variant minimums: no own value
  ],
};
const CAP = { code: 'CAP', type: 'item', name: 'Cap', price: 1000, wholesaleSellingPrice: 600, wholesalePrice: 400, minimumPrice: 800, qty: 20, unit: 'pcs', vatCategory: 'A' };
const RICE = { code: 'RICE', type: 'item', name: 'Rice', price: 5000, wholesalePrice: 3000, minimumPrice: 4500, qty: 10, unit: 'bag', dualUnit: true, unitsPerBox: 50, looseUnit: 'kg', piecePrice: 110, pieceWholesalePrice: 60, pieceQty: 20, vatCategory: 'A' };
const STORE = { pos_inventory: JSON.stringify([JERSEY, CAP, RICE]) };

const VARIANT_APPS = ['index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];
const priceOf = (w, key) => w.eval(`currentCart[${JSON.stringify(key)}] && currentCart[${JSON.stringify(key)}].price`);

for (const app of VARIANT_APPS) {
  test(`${app}: a typed cart-line price below a variant's (or item's) minimum is refused; at or above it is accepted`, async () => {
    const { w, errors, close } = await boot(app, { storage: STORE, wait: 900 });
    w.eval("window.__t = []; showToast = function (m) { window.__t.push(m); }; REQUIRE_CART_PRICE_PW = false;");
    w.eval("addToCart('JER', undefined, undefined, 'vxl'); addToCart('JER', undefined, undefined, 'vl'); addToCart('CAP');");
    const xl = 'JER::variant::vxl', l = 'JER::variant::vl';

    w.eval(`confirmCartCustomPrice('${xl}', '2500')`);
    assert.equal(priceOf(w, xl), 3200, "below the variant's own 2800 minimum: price unchanged");
    assert.match(w.eval('window.__t.join("|")'), /minimum/);
    w.eval(`confirmCartCustomPrice('${xl}', '2800')`);
    assert.equal(priceOf(w, xl), 2800, 'exactly the minimum is allowed');

    w.eval(`confirmCartCustomPrice('${l}', '2400')`);
    assert.equal(priceOf(w, l), 3000, "a variant with no minimum of its own falls back to the parent's 2500");
    w.eval(`confirmCartCustomPrice('${l}', '2600')`);
    assert.equal(priceOf(w, l), 2600);

    w.eval("confirmCartCustomPrice('CAP', '700')");
    assert.equal(priceOf(w, 'CAP'), 1000, 'a plain item below its minimum is refused too');
    w.eval("selectCartPriceOption('CAP', 'wholesale')");
    assert.equal(priceOf(w, 'CAP'), 600, 'the preset Wholesale button stays exempt, as before');
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: a loose-piece line has no minimum (the minimum is set against the whole bag)`, async () => {
    const { w, errors, close } = await boot(app, { storage: STORE, wait: 900 });
    w.eval("showToast = function () {}; REQUIRE_CART_PRICE_PW = false;");
    w.eval("addToCart('RICE', 'piece')");
    const key = w.eval("Object.keys(currentCart).find(k => currentCart[k].saleMode === 'piece')");
    w.eval(`confirmCartCustomPrice('${key}', '100')`);
    assert.equal(priceOf(w, key), 100, 'a piece price is never compared with the bag minimum of 4500');
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: with the manager password turned on, a refused price never asks for the password`, async () => {
    const { w, errors, close } = await boot(app, { storage: STORE, wait: 900 });
    w.eval("showToast = function () {}; REQUIRE_CART_PRICE_PW = true; adminPwModalPurpose = 'tab-switch';");
    w.eval("addToCart('JER', undefined, undefined, 'vxl');");
    w.eval("confirmCartCustomPrice('JER::variant::vxl', '1000')");
    assert.equal(w.eval('adminPwModalPurpose'), 'tab-switch', 'no password prompt for a price that would be refused');
    w.eval("confirmCartCustomPrice('JER::variant::vxl', '3000')");
    assert.equal(w.eval('adminPwModalPurpose'), 'change-cart-price', 'an allowed price still goes through the password as before');
    assert.deepEqual(errors, []);
    close();
  });
}

const QUOTE_APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];
for (const app of QUOTE_APPS) {
  test(`${app}: a custom total quote that would push any line below its minimum is refused and says the lowest total allowed`, async () => {
    const { w, errors, close } = await boot(app, { storage: STORE, wait: 900 });
    w.eval("window.__t = []; showToast = function (m) { window.__t.push(m); }; REQUIRE_CART_PRICE_PW = false;");
    // Cap 1000 (min 800) + a no-minimum line; set directly so this does not depend on each module's add-to-cart variant path.
    w.eval(`currentCart = {
      CAP: { code: 'CAP', cartKey: 'CAP', name: 'Cap', price: 1000, qty: 2, unit: 'pcs', vatCategory: 'A' },
      FREE: { code: 'NOPE', cartKey: 'FREE', name: 'Misc', price: 1000, qty: 1, unit: 'pcs', vatCategory: 'A' },
    };`);
    // Lowest allowed: 3000 * (800/1000) = 2400.
    w.eval("performCartTotalQuote(2000)");
    assert.equal(priceOf(w, 'CAP'), 1000, 'refused: nothing rescaled');
    assert.match(w.eval('window.__t.join("|")'), /lowest total you can quote for this sale is KES 2,?400/);
    w.eval("performCartTotalQuote(2400)");
    assert.equal(priceOf(w, 'CAP'), 800, 'exactly the lowest allowed total is accepted');
    const total = w.eval("Object.values(currentCart).reduce((s, l) => s + l.price * l.qty, 0)");
    assert.equal(Math.round(total * 100) / 100, 2400);
    assert.deepEqual(errors, []);
    close();
  });
}

test('water/index.html: the custom total quote still works (Water has no minimum prices, and the check must not crash it)', async () => {
  const { w, errors, close } = await boot('water/index.html', { wait: 1500 });
  w.eval("showToast = function () {}; REQUIRE_CART_PRICE_PW = false;");
  w.eval("currentCart = { A: { code: 'X', cartKey: 'A', name: 'Refill', price: 100, qty: 2, unit: 'pcs', vatCategory: 'A' } };");
  w.eval("performCartTotalQuote(150)");
  assert.equal(priceOf(w, 'A'), 75);
  assert.deepEqual(errors, []);
  await new Promise((r) => setTimeout(r, 1500));
  close();
});
