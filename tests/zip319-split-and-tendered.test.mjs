import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 319: (1) a split payment is Cash + M-Pesa only (no Card / Bank boxes in any split; Card stays a payment method of its own);
// (2) Cash Tendered is filled with the amount due by default, and Settings > "Prefill Cash Tendered" turns that off.
const ITEMS = JSON.stringify([{ code: 'A', type: 'item', name: 'Alpha', price: 250, wholesalePrice: 100, qty: 50, unit: 'pcs', vatCategory: 'A' }]);
const J = (w, e) => JSON.parse(w.eval(`JSON.stringify(${e})`));
const quiet = (w) => w.eval("window.__t = []; showToast = function (m) { window.__t.push(m); }; window.print = () => {}; window.confirm = () => true;");
const visible = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { if (e.hidden || e.style.display === 'none') return false; } return true; };
// water sells refills, not catalogue items: put a line in its cart directly
const add = (w, n = 1) => w.eval(`for (let i = 0; i < ${n}; i++) { if (typeof addToCart === 'function') addToCart('A'); else { const l = currentCart.A || (currentCart.A = { code: 'A', name: 'Alpha', price: 250, qty: 0, unit: 'pcs' }); l.qty++; } }`);
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'water/index.html'];

for (const app of APPS) {
  test(`${app}: no split offers Card or Bank - only Cash and M-Pesa`, async () => {
    const { d, close } = await boot(app, { storage: { pos_inventory: ITEMS }, wait: 900 });
    try {
      assert.equal(d.getElementById('split-card-input'), null, 'the Sales Counter split has no Card box');
      for (const id of ['bill-settle-split-card-input', 'bill-settle-split-bank-input', 'bill-upfront-split-card-input', 'bill-upfront-split-bank-input', 'tab-settle-split-card-input']) {
        const el = d.getElementById(id); if (el) assert.equal(visible(el), false, id + ' is not shown');
      }
      for (const id of ['bill-settle-split-cash-input', 'bill-settle-split-mpesa-input', 'bill-upfront-split-cash-input', 'bill-upfront-split-mpesa-input']) {
        const el = d.getElementById(id); if (el) assert.ok(!el.closest('[hidden]'), id + ' is there');
      }
    } finally { close(); }
  });
}

test('Shop: a split sale is Cash + M-Pesa = total; anything else is refused; Card is still its own payment method', async () => {
  const { w, d, close } = await boot('index.html', { storage: { pos_inventory: ITEMS }, wait: 900 });
  try {
    quiet(w);
    assert.ok(d.getElementById('pay-card-btn'), 'Card is still a payment method');
    const sell = async (cash, mpesa) => {
      w.eval("addToCart('A'); setPaymentMethod('split')");
      d.getElementById('split-cash-input').value = String(cash); d.getElementById('split-mpesa-input').value = String(mpesa);
      d.getElementById('split-cash-tendered-input').value = String(cash);
      w.eval("try { document.getElementById('mpesa-code-input').value = 'QWE123RTY9'; } catch (e) {}");
      const n = J(w, 'salesLog.length'); await w.eval('checkoutCart()'); return J(w, 'salesLog.length') > n;
    };
    assert.equal(await sell(100, 100), false, '200 for a 250 sale is refused');
    assert.match(J(w, 'window.__t').join(' '), /Cash \+ M-Pesa must add up to the total \(KES 250\.00\)/);
    w.eval('currentCart = {}; renderCart()');
    const ok = await sell(100, 150);
    if (ok) {
      const s = J(w, 'salesLog[salesLog.length - 1]');
      assert.equal(s.paymentMethod, 'split'); assert.equal(s.cashAmount, 100); assert.equal(s.mpesaAmount, 150); assert.ok(!s.cardAmount, 'no card leg');
    } else assert.doesNotMatch(J(w, 'window.__t').join(' '), /must add up/, 'a matching split is not refused for its amounts: ' + J(w, 'window.__t').join(' | '));
    // the split's balance line names only Cash + M-Pesa
    w.eval("currentCart = {}; addToCart('A'); setPaymentMethod('split'); document.getElementById('split-cash-input').value = '50'; handleSplitAmountChange('cash')");
    assert.equal(d.getElementById('split-mpesa-input').value, '200.00', 'M-Pesa takes the rest');
    assert.match(d.getElementById('split-balance-line').textContent, /Cash \+ M-Pesa = KES 250\.00/);
  } finally { close(); }
});

for (const app of ['index.html', 'water/index.html', 'hotel/index.html']) {
  test(`${app}: Cash Tendered is the amount due by default (editable, change worked out); Settings > Prefill Cash Tendered off leaves it empty`, async () => {
    const { w, d, close } = await boot(app, { storage: { pos_inventory: ITEMS }, wait: 900 });
    try {
      quiet(w);
      const box = d.getElementById('cash-prefill-toggle');
      assert.ok(box, 'the setting is in Settings'); assert.equal(box.checked, true, 'on by default');
      assert.match(box.closest('label').textContent, /Prefill Cash Tendered/);
      add(w, 2); w.eval("setPaymentMethod('cash'); updateChangeDue()");
      const t = d.getElementById('cash-tendered-input');
      assert.equal(t.value, '500.00', 'filled with the amount due');
      t.value = '1000'; w.eval('updateChangeDue()');
      assert.match(d.getElementById('change-due-line').textContent, /Change Due: KES 500\.00/);
      assert.equal(t.value, '1000', 'what the cashier typed is kept');
      // off: the amount we filled is taken out, and nothing is filled again
      t.value = '500.00'; w.eval('window.__cashTenderedAutoFillValue = 500; updateChangeDue()');
      box.checked = false; box.dispatchEvent(new w.Event('change'));
      assert.equal(J(w, "localStorage.getItem('pos_cash_prefill')"), '0');
      assert.equal(t.value, '', 'left empty for the cashier');
      add(w); w.eval('updateChangeDue()');
      assert.equal(t.value, '', 'still empty after the total changes');
      t.value = '800'; w.eval('updateChangeDue()');
      assert.match(d.getElementById('change-due-line').textContent, /Change Due: KES 50\.00/, 'change from what was typed');
      // the split's cash box follows the same setting
      d.getElementById('split-cash-tendered-input').value = '';
      w.eval("setPaymentMethod('split'); document.getElementById('split-cash-input').value = '300'; handleSplitAmountChange('cash'); updateChangeDue()");
      assert.equal(d.getElementById('split-cash-tendered-input').value, '', 'not filled while the setting is off');
      // on again
      box.checked = true; box.dispatchEvent(new w.Event('change'));
      w.eval("setPaymentMethod('cash'); document.getElementById('cash-tendered-input').value = ''; updateChangeDue()");
      assert.equal(t.value, '750.00');
    } finally { close(); }
  });
}
