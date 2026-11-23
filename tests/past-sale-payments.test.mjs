import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// "Record a Past Sale" takes every payment method the Sales Counter does: cash, M-Pesa, card, split and bill (Pay Later).
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];
const INV = JSON.stringify([{ code: 'A1', type: 'item', name: 'Widget', price: 50, wholesalePrice: 20, qty: 20, unit: 'pcs', vatCategory: 'A' }]);
const val = (d, id, v) => { d.getElementById(id).value = String(v); };
async function session(app) {
  const b = await boot(app, { storage: { pos_inventory: INV }, wait: 1500 });
  b.w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.confirm = () => true");
  return b;
}
function fill(b, method, extra = {}) {
  const { w, d } = b;
  w.eval('openRecordPastSaleModal()');
  w.eval("selectPastSaleItem('A1')");
  val(d, 'past-sale-date-input', '2026-09-10'); val(d, 'past-sale-time-input', '14:30');
  val(d, 'past-sale-qty-input', 2); val(d, 'past-sale-price-input', 50);
  val(d, 'past-sale-payment-select', method); w.eval('pastSalePaymentChanged()');
  for (const [id, v] of Object.entries(extra)) val(d, id, v);
  w.eval('saveRecordPastSale()');
  return d.getElementById('past-sale-error').textContent;
}
const last = (w, list = 'salesLog') => JSON.parse(w.eval(`JSON.stringify(${list}[${list}.length - 1] || null)`));

for (const app of APPS) {
  test(`${app}: a past sale can be recorded as cash, M-Pesa, card and split`, async () => {
    const b = await session(app);
    const { w, d, errors } = b;
    const noCard = false;   // every app, the hotel included (hidden in the hotel from zip 153 to 268), takes card
    assert.equal(d.getElementById('past-sale-payment-select').options.length, noCard ? 4 : 5, noCard ? 'cash, M-Pesa, split, bill (no card)' : 'cash, M-Pesa, card, split, bill');
    assert.equal(fill(b, 'cash'), '');
    let s = last(w);
    assert.deepEqual([s.paymentMethod, s.paid, s.cashAmount, s.mpesaAmount, s.cardAmount], ['cash', true, 100, 0, 0]);
    assert.match(s.timestamp, /^2026-09-10/, 'dated when it really happened');
    assert.equal(s.recordedLate, true);
    assert.equal(fill(b, 'mpesa', { 'past-sale-mpesa-code-input': 'qgh7abc123', 'past-sale-mpesa-name-input': 'Jane W' }), '');
    s = last(w);
    assert.deepEqual([s.paymentMethod, s.mpesaAmount, s.cashAmount, s.mpesaReceiptNumber, s.mpesaPayerName], ['mpesa', 100, 0, 'QGH7ABC123', 'Jane W']);
    if (!noCard) {
      assert.equal(fill(b, 'card', { 'past-sale-card-ref-input': '4421' }), '');
      s = last(w);
      assert.deepEqual([s.paymentMethod, s.cardAmount, s.cardReference, s.cashAmount], ['card', 100, '4421', 0]);
    }
    // split must add up
    const before = w.eval('salesLog.length');
    assert.match(fill(b, 'split', { 'past-sale-split-cash-input': 60, 'past-sale-split-mpesa-input': 30 }), /must add up to the sale total \(KES 100\.00\); you have KES 90\.00/);
    assert.equal(w.eval('salesLog.length'), before, 'nothing recorded for a split that does not add up');
    assert.equal(fill(b, 'split', { 'past-sale-split-cash-input': 60, 'past-sale-split-mpesa-input': 40 }), '');
    s = last(w);
    assert.deepEqual([s.paymentMethod, s.cashAmount, s.mpesaAmount, s.paid], ['split', 60, 40, true]);
    assert.equal(w.eval('inventory.find(p => p.code === "A1").qty'), noCard ? 14 : 12, 'stock came off for each recorded sale (2 each)');
    assert.deepEqual(errors, []);
    b.close();
  });

  test(`${app}: a past sale on BILL (Pay Later) goes to the Bills tab dated then, with what was already paid recorded as a partial payment`, async () => {
    const b = await session(app);
    const { w, d, errors } = b;
    assert.match(fill(b, 'bill'), /needs the customer.s name/);
    assert.equal(w.eval('bills.length'), 0);
    assert.equal(fill(b, 'bill', { 'past-sale-bill-name-input': 'Jane Wanjiru', 'past-sale-bill-phone-input': '0712345678', 'past-sale-bill-paid-input': 30, 'past-sale-bill-method-select': 'mpesa' }), '');
    const bill = last(w, 'bills');
    assert.equal(bill.paid, false); assert.equal(bill.customerName, 'Jane Wanjiru'); assert.equal(bill.customerPhone, '0712345678');
    assert.equal(bill.amountPaid, 30); assert.match(bill.timestamp, /^2026-09-10/);
    assert.equal(bill.items[0].qty * bill.items[0].price, 100);
    assert.equal(w.eval('salesLog.some(s => s.items.some(i => i.code === "A1"))'), false, 'the goods are NOT counted as a paid sale yet');
    const part = last(w);
    assert.equal(part.mpesaAmount, 30, 'the 30 paid is a partial payment (M-Pesa), dated then');
    assert.match(part.timestamp, /^2026-09-10/);
    assert.equal(w.eval('inventory.find(p => p.code === "A1").qty'), 18, 'stock came off');
    w.eval("document.getElementById('bills-tab-btn') && renderBillsTab()");
    assert.match(d.getElementById('bills-table').textContent, /Jane Wanjiru/);
    assert.match(d.getElementById('bills-table').textContent, /70\.00/, 'KES 70 still owed');
    // paid nothing up front
    assert.equal(fill(b, 'bill', { 'past-sale-bill-name-input': 'Bob' }), '');
    assert.equal(last(w, 'bills').amountPaid, 0);
    assert.equal(w.eval('salesLog.length'), 1, 'no partial-payment record when nothing was paid');
    assert.deepEqual(errors, []);
    b.close();
  });
}

test('reopening the form starts again at Cash with the extra fields hidden', async () => {
  const b = await session('index.html');
  fill(b, 'bill', { 'past-sale-bill-name-input': 'X' });
  b.w.eval('openRecordPastSaleModal()');
  assert.equal(b.d.getElementById('past-sale-payment-select').value, 'cash');
  for (const id of ['past-sale-mpesa-panel', 'past-sale-card-panel', 'past-sale-split-panel', 'past-sale-bill-panel']) assert.equal(b.d.getElementById(id).style.display, 'none');
  assert.equal(b.d.getElementById('past-sale-bill-name-input').value, '');
  b.close();
});
