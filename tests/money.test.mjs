import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';

// MONEY INVARIANTS, run through the REAL checkout of every app that has the shared Sales Counter.
// checkoutCart() exists in 8 diverged copies (see DRIFT_REPORT.md), so a fix in one can silently break another.
// These tests pin down what must be true of a sale no matter which copy runs it:
//   * the sale total is the sum of its lines; the lines are what was in the cart
//   * cash + M-Pesa + card paid == total (nothing gained or lost), change is exactly tendered - total
//   * stock falls by exactly the quantity sold; a sale is recorded exactly once
//   * an invalid payment (short cash, split that doesn't add up) creates NO sale and moves NO stock
const SHOP_APPS = APPS.filter((a) => a !== 'water/index.html');
const ITEMS = [
  { code: '00001', type: 'item', name: 'Widget', price: 100, wholesaleSellingPrice: 80, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' },
  { code: '00002', type: 'item', name: 'Gadget', price: 33.33, wholesaleSellingPrice: 30, wholesalePrice: 20, qty: 10, unit: 'pcs', vatCategory: 'B' },
];
const LINES = [['00001', 3], ['00002', 2]];
const EXPECT_TOTAL = 3 * 100 + 2 * 33.33;                      // 366.66
const cents = (n) => Math.round(n * 100);

async function session(app, extraStorage = {}) {
  const b = await boot(app, { storage: { pos_inventory: JSON.stringify(ITEMS), ...extraStorage }, wait: 900 });
  const { w } = b;
  w.eval('showToast = function (m) { window.__lastToast = m; }');
  for (const [code, qty] of LINES) for (let i = 0; i < qty; i++) w.eval(`addToCart('${code}')`);
  return b;
}
const setInput = (d, id, v) => { const el = d.getElementById(id); assert.ok(el, `#${id} exists`); el.value = String(v); };
const stock = (w, code) => w.eval(`inventory.find(p => p.code === '${code}').qty`);
const sales = (w) => JSON.parse(w.eval('JSON.stringify(salesLog)'));
// A sale record doesn't carry a `total` field in every app; it IS its lines minus any discount.
const saleTotal = (s) => s.items.reduce((n, it) => n + it.price * it.qty, 0) - (s.totalDiscount || 0);
const paid = (s) => (s.cashAmount || 0) + (s.mpesaAmount || 0) + (s.cardAmount || 0);

for (const app of SHOP_APPS) {
  test(`${app}: cash sale — total is the sum of the lines, change is exact, stock falls by what was sold`, async () => {
    const { w, d, errors, close } = await session(app);
    assert.equal(cents(w.eval('cartTotal()')), cents(EXPECT_TOTAL), 'cart total');
    w.eval("currentPaymentMethod = 'cash'");
    setInput(d, 'cash-tendered-input', 400);
    await w.eval('checkoutCart()');
    const s = sales(w);
    assert.equal(s.length, 1, 'exactly one sale recorded');
    assert.equal(cents(saleTotal(s[0])), cents(EXPECT_TOTAL), 'the recorded lines add up to what the cart showed');
    assert.deepEqual(s[0].items.map((it) => [it.code, it.qty]), LINES, 'the lines are what was in the cart');
    assert.equal(cents(paid(s[0])), cents(EXPECT_TOTAL), 'money taken == total');
    assert.equal(cents(s[0].change), cents(400 - EXPECT_TOTAL), 'change = tendered - total');
    assert.equal(stock(w, '00001'), 47);
    assert.equal(stock(w, '00002'), 8);
    assert.deepEqual(errors, []);
    await new Promise((r) => setTimeout(r, 200));
    close();
  });

  test(`${app}: short cash creates no sale and moves no stock`, async () => {
    const { w, d, close } = await session(app);
    w.eval("currentPaymentMethod = 'cash'");
    setInput(d, 'cash-tendered-input', 100);
    await w.eval('checkoutCart()');
    assert.equal(sales(w).length, 0);
    assert.equal(stock(w, '00001'), 50);
    assert.equal(stock(w, '00002'), 10);
    close();
  });

  test(`${app}: split sale — cash + M-Pesa add up to the total exactly, and a split that doesn't add up is refused`, async () => {
    const { w, d, close } = await session(app);
    w.eval("currentPaymentMethod = 'split'");
    setInput(d, 'split-cash-input', 200);
    setInput(d, 'split-mpesa-input', 100);            // 300 != 366.66
    setInput(d, 'split-cash-tendered-input', 200);
    await w.eval('checkoutCart()');
    assert.equal(sales(w).length, 0, 'mismatched split refused');
    assert.equal(stock(w, '00001'), 50);
    setInput(d, 'split-mpesa-input', 166.66);
    await w.eval('checkoutCart()');
    const s = sales(w);
    assert.equal(s.length, 1);
    assert.equal(cents(s[0].cashAmount) + cents(s[0].mpesaAmount), cents(saleTotal(s[0])), 'nothing gained or lost across the split');
    assert.equal(cents(paid(s[0])), cents(EXPECT_TOTAL));
    assert.equal(stock(w, '00001'), 47);
    await new Promise((r) => setTimeout(r, 200));
    close();
  });
}
