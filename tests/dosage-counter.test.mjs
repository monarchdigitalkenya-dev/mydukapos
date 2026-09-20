import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// The Sales Counter of BOTH the Hospital and the Pharmacy: a dosage note typed under a medicine in the cart ends up on the sale and on the receipt.
const INV = JSON.stringify([
  { code: 'PAR', type: 'item', name: 'Mara Moja', price: 20, wholesalePrice: 10, qty: 100, unit: 'pcs', vatCategory: 'A' },
  { code: 'AMX', type: 'item', name: 'Amoxicillin 500mg', price: 30, wholesalePrice: 15, qty: 100, unit: 'pcs', vatCategory: 'A' },
  { code: 'CONS', type: 'service', name: 'Consultation', price: 500, unit: 'use', vatCategory: 'A' },
]);
for (const app of ['hospital/index.html', 'pharmacy/index.html']) {
  test(`${app}: a dosage typed under a medicine at the Sales Counter is saved on the sale and printed on the receipt`, async () => {
    const b = await boot(app, { storage: { pos_inventory: INV }, wait: 2000 });
    const { w, d, errors } = b;
    w.eval("showToast = function () {}");
    w.eval("addToCart('PAR'); addToCart('AMX'); addToCart('CONS')");
    const inputs = [...d.querySelectorAll('#cart-table .cart-dosage-input')];
    assert.equal(inputs.length, 2, 'a dosage box under each medicine, none under the service');
    const keys = JSON.parse(w.eval('JSON.stringify(Object.keys(currentCart))'));
    const keyOf = (code) => keys.find((k) => k.includes(code));
    inputs[0].value = '1 x 3 for 5 days'; inputs[0].dispatchEvent(new w.Event('change'));
    d.querySelectorAll('#cart-table .dose-chip')[5].click();                                    // the 2nd medicine's "1 x 2" chip
    assert.equal(w.eval(`currentCart['${keyOf('PAR')}'].dosage`), '1 x 3 for 5 days');
    assert.equal(w.eval(`currentCart['${keyOf('AMX')}'].dosage`), '1 x 2');
    w.eval("currentPaymentMethod = 'cash'");
    d.getElementById('cash-tendered-input').value = '100000';
    await w.eval('checkoutCart()');
    const sale = JSON.parse(w.eval('JSON.stringify(salesLog[salesLog.length - 1])'));
    assert.equal(sale.items.find((i) => i.code === 'PAR').dosage, '1 x 3 for 5 days', 'saved on the sale line');
    assert.equal(sale.items.find((i) => i.code === 'AMX').dosage, '1 x 2');
    assert.equal(sale.items.find((i) => i.code === 'CONS').dosage, undefined);
    const text = w.eval('lastReceiptText');
    assert.match(text, /Mara Moja[\s\S]*--> Dose: 1 x 3 for 5 days[\s\S]*Amoxicillin/, 'on the printed receipt, right under its medicine');
    assert.match(text, /--> Dose: 1 x 2/);
    assert.match(d.getElementById('receipt-body').textContent, /Dose: 1 x 3 for 5 days/, 'and on the on-screen receipt');
    assert.deepEqual(errors, []);
    b.close();
  });
}
