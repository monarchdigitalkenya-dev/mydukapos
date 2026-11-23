import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 269 - clearing a bill by Card: the split-bill screen offers Card and must record it as card (not cash), with the slip reference.
const INV = [{ code: 'CHP', type: 'service', name: 'Chips', category: 'Sides', price: 200, unit: 'pcs', vatCategory: 'A' }];
const J = (w, e) => JSON.parse(w.eval(`JSON.stringify(${e})`));

test('split-bill part paid by card is recorded as card with its reference; tab settle by card keeps the reference', async () => {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 05']) }, wait: 1200 });
  const { w, d } = b;
  w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; queuePrintJob = function () { return Promise.resolve(); }");
  d.getElementById('svc-new-location').value = 'Table 05'; w.eval("svcAdd('CHP'); svcAdd('CHP')"); w.eval('svcPostOrder()');
  const id = J(w, "tabs.find(t => t.status === 'OPEN').id");
  w.eval(`hospPayPart('${id}', { amount: 150, method: 'card', cardRef: 'SLIP-77' })`);
  const part = J(w, "salesLog[salesLog.length - 1]");
  assert.equal(part.paymentMethod, 'card'); assert.equal(part.cardAmount, 150); assert.equal(part.cashAmount, 0); assert.equal(part.cardReference, 'SLIP-77');
  // the rest by card from the Settle Tab screen
  w.eval(`activeTabDetailId = '${id}'; openTabSettleModal(); setTabSettlePayMethod('card')`);
  assert.equal(d.getElementById('tab-settle-card-fields').style.display, 'block');
  d.getElementById('tab-settle-card-ref-input').value = 'SLIP-78'; w.eval('confirmTabSettle()');
  const last = J(w, "salesLog[salesLog.length - 1]");
  assert.equal(last.paymentMethod, 'card'); assert.equal(last.cardAmount, 250); assert.equal(last.cardReference, 'SLIP-78');
  assert.equal(J(w, `tabs.find(t => t.id === '${id}').status`), 'CLOSED');
  // Settle Bill modal shows a card reference box for Card
  w.eval("setBillSettlePayMethod('card')");
  assert.equal(d.getElementById('bill-settle-card-fields').style.display, 'block');
  w.eval("setBillSettlePayMethod('cash')"); assert.equal(d.getElementById('bill-settle-card-fields').style.display, 'none');
  b.close();
});

// Card is on every module's Settle Bill screen, and the card reference is never required.
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'water/index.html'];
for (const app of APPS) {
  test(`${app}: Settle Bill has a visible Card button, and a card payment with no reference is accepted`, async () => {
    const b = await boot(app, { wait: 2000 }); const { w, d } = b;
    const water = app === 'water/index.html';
    const toggle = d.getElementById(water ? 'bill-settle-method-toggle' : 'bill-settle-pay-toggle');
    const card = [...toggle.querySelectorAll('button')].find((x) => /Card/.test(x.textContent));
    assert.ok(card, 'a Card button'); assert.notEqual(card.style.display, 'none', 'and nothing hides it');
    assert.equal(!!d.querySelector('#bill-settle-modal [id*="card-ref-input"][required]'), false, 'the reference is not required');
    // choosing Card shows an optional reference box, and only then
    const box = d.getElementById(water ? 'bill-settle-card-ref-group' : 'bill-settle-card-fields');
    w.eval(water ? "setBillSettleMethod('card')" : "setBillSettlePayMethod('card')"); assert.equal(box.style.display, 'block');
    w.eval(water ? "setBillSettleMethod('cash')" : "setBillSettlePayMethod('cash')"); assert.equal(box.style.display, 'none');
    b.close();
  });
}

const INV2 = JSON.stringify([{ code: 'A1', type: 'item', name: 'Tea', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }]);
for (const app of APPS.filter((a) => a !== 'water/index.html')) {
  test(`${app}: a bill is cleared by Card with the reference left blank, then another with a reference`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: { pos_inventory: INV2 }, wait: 1500 });
    w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");
    for (const [name, ref] of [['Jane', ''], ['Omar', 'SLIP-9']]) {
      w.eval("addToCart('A1'); addToCart('A1'); currentPaymentMethod = 'bill'");
      const n = d.getElementById('bill-customer-name-input'); if (n) n.value = name; { const p = d.getElementById('sms-checkout-phone-input'); if (p) p.value = '07' + String(10000000 + [...String(name)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 89999999, 7)).slice(0, 8); }   // a different person needs a different phone (a shared phone asks the cashier, by design)
      await w.eval('checkoutCart()');
      const id = w.eval(`bills.find(b => b.customerName === '${name}').id`);
      w.eval(`openBillSettleModal('sale', '${id}')`); w.eval("setBillSettlePayMethod('card')");
      d.getElementById('bill-settle-card-ref-input').value = ref;
      await w.eval('confirmBillSettle(true)');
      assert.equal(w.eval(`bills.find(b => b.id === '${id}').closed`), true, 'cleared with no card code required');
      const h = JSON.parse(w.eval(`JSON.stringify(bills.find(b => b.id === '${id}').paymentHistory.slice(-1)[0])`));
      assert.equal(h.method, 'card'); assert.equal(h.reference, ref);
      const sale = JSON.parse(w.eval('JSON.stringify(salesLog[salesLog.length - 1])'));
      assert.equal(sale.cardAmount, 200); assert.equal(sale.cashAmount, 0);
    }
    assert.deepEqual(errors, []); close();
  });
}

// The hotel Sales Counter takes Card, and the owner chooses which methods the till accepts (Card included).
test('hotel Sales Counter: Card button, optional reference, sale recorded as card; Settings can switch Card off', async () => {
  const { w, d, errors, close } = await boot('hotel/index.html', { storage: { pos_inventory: INV2 }, wait: 1500 });
  w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");
  assert.ok(d.getElementById('pay-card-btn'), 'a Card button on the counter');
  for (const ref of ['', '4421']) {
    w.eval("addToCart('A1'); addToCart('A1'); setPaymentMethod('card')");
    assert.equal(d.getElementById('card-payment-panel').classList.contains('show'), true);
    assert.equal(d.getElementById('pay-card-btn').classList.contains('active'), true);
    d.getElementById('card-reference-input').value = ref;
    await w.eval('checkoutCart()');
    const sale = JSON.parse(w.eval('JSON.stringify(salesLog[salesLog.length - 1])'));
    assert.equal(sale.paymentMethod, 'card'); assert.equal(sale.cardAmount, 200); assert.equal(sale.cashAmount, 0); assert.equal(sale.mpesaAmount, 0);
    assert.equal(sale.cardReference, ref || null);
  }
  assert.equal(w.eval('salesLog.length'), 2);
  assert.equal(w.eval('inventory.find(p => p.code === "A1").qty'), 46, 'stock came off');
  // Settings lists Card; unticking it hides the button on the counter and in Settle Tab
  w.eval('posRenderPayMethodsPanel()');
  assert.ok(d.querySelector('.pos-paym[value="card"]'), 'Card is a choice in Payment methods I accept');
  w.eval("posPaySetAccepted(['cash', 'mpesa', 'split', 'bill', 'tab'], true)");
  assert.equal(d.getElementById('pay-card-btn').style.display, 'none');
  assert.equal([...d.querySelectorAll('#tab-settle-pay-toggle button')].find((x) => /Card/.test(x.textContent)).style.display, 'none');
  w.eval("posPaySetAccepted(['cash', 'mpesa', 'card', 'split', 'bill', 'tab'], true)");
  assert.equal(d.getElementById('pay-card-btn').style.display, '');
  assert.deepEqual(errors, []); close();
});
