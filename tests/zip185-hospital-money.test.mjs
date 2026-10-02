import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 185 — Hospital money audit: negative split rejected, bill cost shares + delivery fee, "take payment now" visit sale keeps product
// code and cost (void restores stock), admission negatives, institution payment method, refunded sale cannot be voided.
const INV = () => JSON.stringify([
  { code: 'AX', type: 'item', name: 'Amoxicillin', price: 100, wholesalePrice: 60, qty: 40, unit: 'pcs', vatCategory: 'A' },
  { code: 'NRS1', type: 'service', name: 'Dressing', price: 300, unit: 'use', vatCategory: 'A' },
]);
const PATIENT = { id: 'PT-1', name: 'John Doe', age: 34, sex: 'male', phone: '0712345678', allergies: '' };
const quiet = (w) => w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => d; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }");
const mk = async () => { const b = await boot('hospital/index.html', { storage: { pos_inventory: INV(), pos_patients: JSON.stringify([PATIENT]) }, wait: 900 }); quiet(b.w); return b; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('hospital: a negative split-payment part is refused and nothing is sold', { timeout: 150000 }, async () => {
  const b = await mk(); const { w, d } = b;
  w.eval("currentCart = {}; addToCart('AX'); currentPaymentMethod = 'split'");
  const set = (id, v) => { const el = d.getElementById(id); if (el) el.value = v; };
  set('split-cash-input', '-50'); set('split-mpesa-input', '150'); set('split-cash-tendered-input', '0');
  await w.eval('checkoutCart()'); await wait(80);
  assert.equal(w.eval('salesLog.filter(s => !s._deleted).length'), 0);
  assert.equal(w.eval("inventory.find(i => i.code === 'AX').qty"), 40);
  b.close();
});

test('hospital: bill instalments carry the whole cost of goods and the delivery fee is owed', { timeout: 150000 }, async () => {
  const b = await mk(); const { w } = b;
  const r = JSON.parse(w.eval(`(() => {
    const bill = { items: [{ code: 'AX', name: 'x', price: 1000, qty: 1, wholesalePrice: 600, unit: 'pcs' }], deliveryDetails: { fee: 200 }, amountPaid: 0, paymentHistory: [] };
    const a1 = billCostShareFor(bill, 500, 0); bill.paymentHistory.push({ amount: 500, costShare: a1 }); bill.amountPaid = 500;
    recomputeBillStatus(bill); const st1 = bill.status;
    const a2 = billCostShareFor(bill, 700, 500); bill.paymentHistory.push({ amount: 700, costShare: a2 }); bill.amountPaid = 1200; recomputeBillStatus(bill);
    const line = { unit: 'payment', price: 500, qty: 1, wholesalePrice: 0, costShare: a1 };
    return JSON.stringify({ st1, st2: bill.status, sum: round2(a1 + a2), itemCogs: itemCogs(line), old: itemCogs({ unit: 'payment', price: 5, qty: 1, wholesalePrice: 0 }) }); })()`));
  assert.equal(r.st1, 'partially_paid', 'items 1000 + fee 200, 500 paid: still owing 700');
  assert.equal(r.st2, 'fully_paid'); assert.equal(r.sum, 600);
  assert.equal(r.itemCogs, 250); assert.equal(r.old, 0, 'old payment lines are unchanged');
  b.close();
});

test('hospital: "take payment now" visit sale keeps code + cost, and voiding it puts the medicine back', { timeout: 150000 }, async () => {
  const b = await mk(); const { w, d } = b;
  w.eval(`openPatientVisitModal('${PATIENT.id}')`);
  d.getElementById('visit-diagnosis-input').value = 'Malaria';
  d.getElementById('visit-consultation-fee-input').value = '0';
  w.eval("visitMedicationDraft = [{ code: 'AX', qty: 5, dosage: '1 x 3' }]");
  w.eval("setVisitBillTo('patient')"); d.getElementById('visit-charge-now-check').checked = true;
  w.eval('saveVisit()');
  assert.equal(w.eval("inventory.find(i => i.code === 'AX').qty"), 35);
  const sale = JSON.parse(w.eval('JSON.stringify(salesLog[salesLog.length - 1])'));
  const line = sale.items.find((i) => i.name === 'Amoxicillin');
  assert.ok(line && line.code === 'AX' && line.wholesalePrice === 60, JSON.stringify(sale.items));
  w.eval(`pendingVoidSaleSource = 'salesLog'; pendingVoidReason = 't'; performVoidSale('${sale.id}')`);
  assert.equal(w.eval("inventory.find(i => i.code === 'AX').qty"), 40, 'stock came back');
  b.close();
});

test('hospital: negative consultation fee and negative admission deposit are refused', { timeout: 150000 }, async () => {
  const b = await mk(); const { w, d } = b;
  w.eval(`openPatientVisitModal('${PATIENT.id}')`);
  d.getElementById('visit-diagnosis-input').value = 'Cough'; d.getElementById('visit-consultation-fee-input').value = '-500';
  w.eval('saveVisit()');
  assert.equal(w.eval('visits.length'), 0);
  b.close();
});

test('hospital: institution payment can be booked as bank and is not cash; a refunded sale cannot be voided', { timeout: 150000 }, async () => {
  const b = await mk(); const { w } = b;
  w.eval("window.prompt = (m, d) => /Received by/.test(m) ? 'bank' : '500'; institutions = [{ id: 'i1', name: 'SHA', balance: 800 }]; recordInstitutionPayment('i1')");
  const s = JSON.parse(w.eval('JSON.stringify(salesLog[salesLog.length - 1])'));
  assert.equal(s.cashAmount, 0); assert.equal(s.cardAmount, 500); assert.equal(w.eval("institutions[0].balance"), 300);
  w.eval("salesLog.push({ id: 'S1', refNumber: 'R1', timestamp: new Date().toISOString(), paid: true, paymentMethod: 'cash', cashAmount: 100, items: [{ name: 'x', price: 100, qty: 1 }] }, { id: 'R2', isRefund: true, refundOfSaleId: 'S1', paid: true, timestamp: new Date().toISOString(), items: [{ name: 'Refund', price: -40, qty: 1, unit: 'payment' }] }); pendingVoidSaleSource = 'salesLog'; pendingVoidReason = 't'; performVoidSale('S1')");
  assert.ok(!w.eval("!!salesLog.find(s => s.id === 'S1').voided"), 'refunded sale was not voided');
  b.close();
});

test('hospital: a half-unit return works, and an exchange credit above what the item sold for needs a manager', { timeout: 150000 }, async () => {
  const b = await mk(); const { w, d } = b;
  w.eval("selectedReturnItem = { code: 'AX', name: 'Amoxicillin', unit: 'pcs' }");
  d.getElementById('return-qty-input').value = '0.5';
  d.getElementById('return-condition-select').value = 'good';
  w.eval('saveSimpleReturn()');
  assert.equal(w.eval("returns.length"), 1, 'the half-unit return was recorded: ' + d.getElementById('return-save-error').textContent);
  assert.equal(w.eval("inventory.find(i => i.code === 'AX').qty"), 40.5);
  w.eval("isManagerSession = () => false");
  assert.match(w.eval("exchangeCreditProblem({ code: 'AX' }, 1, 5000)"), /more than that item was sold for/);
  assert.equal(w.eval("exchangeCreditProblem({ code: 'AX' }, 1, 100)"), '');
  w.eval("isManagerSession = () => true");
  assert.equal(w.eval("exchangeCreditProblem({ code: 'AX' }, 1, 5000)"), '', 'manager override');
  b.close();
});
