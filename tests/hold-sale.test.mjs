import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Sales Counter: put ONE sale on hold while serving the next customer, then bring it back and complete it.
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];
const INV = JSON.stringify([
  { code: 'A1', type: 'item', name: 'Widget', price: 100, wholesalePrice: 50, qty: 20, unit: 'pcs', vatCategory: 'A' },
  { code: 'B2', type: 'item', name: 'Gadget', price: 30, wholesalePrice: 10, qty: 20, unit: 'pcs', vatCategory: 'A' },
]);
const toasts = (w) => (w.__toasts || []).join(' | ');
async function session(app) {
  const b = await boot(app, { storage: { pos_inventory: INV }, wait: 1500 });
  b.w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.confirm = () => true");
  return b;
}
const cartCodes = (w) => JSON.parse(w.eval('JSON.stringify(Object.values(currentCart).map(l => [l.code, l.qty]))'));
const pay = async (b, tendered = 100000) => { b.w.eval("currentPaymentMethod = 'cash'"); b.d.getElementById('cash-tendered-input').value = String(tendered); await b.w.eval('checkoutCart()'); return JSON.parse(b.w.eval('JSON.stringify(salesLog[salesLog.length - 1])')); };

for (const app of APPS) {
  test(`${app}: hold a sale, serve the next customer, bring the held one back and complete it; only one can be held`, async () => {
    const b = await session(app);
    const { w, d, errors } = b;
    assert.ok(d.getElementById('hold-sale-btn'), 'a Hold button is on the Sales Counter');
    assert.equal(d.getElementById('hold-sale-btn').disabled, true, 'nothing to hold yet');
    assert.equal(d.getElementById('resume-held-btn').style.display, 'none');
    // customer 1: 2 widgets + a gadget, a phone number typed, then not ready to pay
    w.eval("addToCart('A1'); addToCart('A1'); addToCart('B2')");
    const phone = d.getElementById('sms-checkout-phone-input');
    if (phone) phone.value = '0712345678';
    const before = cartCodes(w);
    assert.equal(d.getElementById('hold-sale-btn').disabled, false);
    w.eval('holdCurrentSale()');
    assert.equal(w.eval('Object.keys(currentCart).length'), 0, 'the cart is free for the next customer');
    assert.equal(d.getElementById('resume-held-btn').style.display, '', 'the Held chip appears');
    assert.match(d.getElementById('resume-held-btn').innerHTML, /<sup>1<\/sup>/, 'Held with the small 1');
    assert.match(d.getElementById('held-sale-info').textContent, /KES 230\.00/);
    assert.equal(d.getElementById('hold-sale-btn').disabled, true);
    if (phone) assert.equal(phone.value, '', 'the next customer starts with a clean form');
    assert.equal(w.eval('inventory.find(p => p.code === "A1").qty'), 20, 'nothing was deducted');
    // customer 2 is served while the first waits
    w.eval("addToCart('B2')");
    assert.equal(w.eval('holdCurrentSale()'), false, 'a second sale cannot be held');
    assert.match(toasts(w), /only one can be held/);
    assert.equal(w.eval('resumeHeldSale()'), false, 'and the held one cannot be brought back over a sale in progress');
    assert.match(toasts(w), /Finish \(or clear\) the sale you are on first/);
    const s2 = await pay(b, 100);
    assert.deepEqual(s2.items.map((i) => [i.code, i.qty]), [['B2', 1]]);
    // customer 1 is ready
    assert.equal(w.eval('resumeHeldSale()'), true);
    assert.deepEqual(cartCodes(w), before, 'the same lines are back');
    if (phone) assert.equal(phone.value, '0712345678', 'and what was typed with them');
    assert.equal(d.getElementById('resume-held-btn').style.display, 'none', 'the chip is gone');
    assert.equal(d.getElementById('hold-sale-btn').disabled, false);
    const s1 = await pay(b, 300);
    assert.deepEqual(s1.items.map((i) => [i.code, i.qty]), [['A1', 2], ['B2', 1]]);
    assert.equal(w.eval('inventory.find(p => p.code === "A1").qty'), 18);
    assert.equal(w.eval("localStorage.getItem(heldSaleKey())"), null, 'nothing is left on hold');
    assert.deepEqual(errors, []);
    b.close();
  });
}

test('a held sale survives a refresh of the page (it is kept on the device)', async () => {
  const b = await session('index.html');
  b.w.eval("addToCart('A1')");
  b.w.eval('holdCurrentSale()');
  const stored = b.w.localStorage.getItem(b.w.eval('heldSaleKey()'));
  assert.ok(stored);
  b.close();
  const key = 'held_sale_v1:/';
  const c = await boot('index.html', { storage: { pos_inventory: INV, [key]: stored }, wait: 1200 });
  assert.equal(c.d.getElementById('resume-held-btn').style.display, '', 'the Held chip is there after reopening');
  c.w.eval("showToast = function () {}");
  assert.equal(c.w.eval('resumeHeldSale()'), true);
  assert.deepEqual(cartCodes(c.w), [['A1', 1]]);
  c.close();
});

test('if stock changed while it was held the sale still comes back, with a warning', async () => {
  const b = await session('index.html');
  b.w.eval("addToCart('A1'); addToCart('A1'); addToCart('A1')");
  b.w.eval('holdCurrentSale()');
  b.w.eval("inventory.find(p => p.code === 'A1').qty = 1");
  assert.equal(b.w.eval('resumeHeldSale()'), true);
  assert.deepEqual(cartCodes(b.w), [['A1', 3]]);
  assert.match(toasts(b.w), /Stock has changed since it was held: Widget \(1 left\)/);
  b.close();
});

test('Aqua POS: hold and bring back work on its cart too; School (no cart) is left alone without errors', async () => {
  const b = await boot('water/index.html', { wait: 1500 });
  b.w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }");
  b.w.eval("currentCart = { 'X::1': { code: 'X', cartKey: 'X::1', name: 'Test refill', price: 100, qty: 2, unit: 'pcs', vatCategory: 'A' } }; renderCart()");
  assert.ok(b.d.getElementById('hold-sale-btn'));
  assert.equal(b.w.eval('holdCurrentSale()'), true);
  assert.equal(b.w.eval('Object.keys(currentCart).length'), 0);
  assert.equal(b.w.eval('resumeHeldSale()'), true);
  assert.equal(b.w.eval("currentCart['X::1'].qty"), 2);
  assert.deepEqual(b.errors, []);
  b.close();
  const s = await boot('school/index.html', { wait: 1200 });
  assert.equal(s.d.getElementById('hold-sale-btn'), null);
  assert.deepEqual(s.errors, []);
  s.close();
});
