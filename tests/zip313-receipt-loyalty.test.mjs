import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 313: with loyalty tokens on, the receipt shows the tokens this sale earned and the customer's balance after it (Settings > Loyalty >
// "Show tokens earned and the token balance on the receipt", on by default). A real checkout in the Shop app, then the same receipt lines in the
// other apps' receipt builder.
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; window.alert = () => {}");

test('Shop: a cash sale to a known customer prints "Earned this sale" and "Token balance"; the switch turns them off; a reprint keeps the figures', async () => {
  const { w, d, close } = await boot('index.html', { wait: 900 });
  try {
    quiet(w);
    w.eval(`loyaltyEnabled = true; tokenValueKES = 2; loyaltyTiers = [{ id: 't1', minSpend: 100, maxSpend: null, tokens: 5 }];
      customers.push({ id: 'c1', name: 'Amina', phone: '0712345678', tokens: 10, createdAt: 1, updatedAt: 1 });
      inventory.push({ code: 'SUG', name: 'Sugar 1kg', qty: 20, price: 200, unit: 'pcs', type: 'item' });
      addToCart('SUG'); currentPaymentMethod = 'cash';`);
    d.getElementById('cash-tendered-input').value = '500';
    d.getElementById('sms-checkout-phone-input').value = '0712345678';
    await w.eval('checkoutCart()');
    await new Promise((r) => setTimeout(r, 400));
    const sale = JSON.parse(w.eval('JSON.stringify(salesLog[salesLog.length - 1])'));
    assert.deepEqual(sale.loyalty, { earned: 5, balance: 15, value: 2 }, 'stored on the sale');
    const text = w.eval('lastReceiptText') || d.getElementById('receipt-modal').textContent;
    assert.match(text, /LOYALTY TOKENS/); assert.match(text, /Earned this sale\s+\+5/); assert.match(text, /Token balance\s+15/); assert.match(text, /Balance worth\s+KES 30\.00/);
    // a reprint of that sale shows the same figures even after the balance moved on
    w.eval("customers[0].tokens = 99");
    const again = w.eval(`buildReceiptDoc(salesLog[salesLog.length - 1], {}).text`);
    assert.match(again, /Token balance\s+15/);
    // switched off in Settings > Loyalty: no loyalty lines
    w.eval('setReceiptShowLoyalty(false)');
    assert.equal(w.localStorage.getItem('pos_receipt_show_loyalty'), 'false');
    assert.doesNotMatch(w.eval(`buildReceiptDoc(salesLog[salesLog.length - 1], {}).text`), /LOYALTY TOKENS/);
    // loyalty off: nothing either
    w.eval('setReceiptShowLoyalty(true); loyaltyEnabled = false');
    assert.doesNotMatch(w.eval(`buildReceiptDoc(salesLog[salesLog.length - 1], {}).text`), /LOYALTY TOKENS/);
    // the switch is in Settings and reflects the setting
    w.eval('loyaltyEnabled = true; initLoyaltySettingsUI()');
    assert.equal(d.getElementById('loyalty-receipt-toggle').checked, true);
    // a sale without a customer has no loyalty lines
    w.eval("salesLog[salesLog.length - 1].loyalty = undefined");
    assert.doesNotMatch(w.eval(`buildReceiptDoc(salesLog[salesLog.length - 1], {}).text`), /LOYALTY/);
  } finally { close(); }
});

for (const app of ['hotel/index.html', 'pharmacy/index.html', 'hospital/index.html', 'water/index.html', 'services/index.html']) {
  test(`${app}: stamping a sale and the receipt lines work the same`, async () => {
    const { w, d, close } = await boot(app, { wait: 700 });
    try {
      quiet(w);
      w.eval(`loyaltyEnabled = true; tokenValueKES = 1; customers.push({ id: 'c1', name: 'A', phone: '0700000001', tokens: 4 });
        window.__s = { id: 's1', refNumber: 'R1', timestamp: new Date().toISOString(), items: [], total: 100, paymentMethod: 'cash', paid: true, amountTendered: 100, change: 0 };
        var __b = loyaltyBalanceOf('0700000001'); awardTokensToCustomer(customers[0], 3); loyaltyStampSale(window.__s, '0700000001', __b);`);
      assert.equal(w.eval('JSON.stringify(window.__s.loyalty)'), JSON.stringify({ earned: 3, balance: 7, value: 1 }));
      const lines = w.eval('receiptLoyaltyLines(window.__s, 32).join("\\n")');
      assert.match(lines, /Earned this sale\s+\+3/); assert.match(lines, /Token balance\s+7/);
      assert.ok(d.getElementById('loyalty-receipt-toggle'), 'the switch is in Settings > Loyalty');
      w.eval('setReceiptShowLoyalty(false)');
      assert.equal(w.eval('receiptLoyaltyLines(window.__s, 32).length'), 0);
    } finally { close(); }
  });
}
