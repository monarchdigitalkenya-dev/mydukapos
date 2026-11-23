import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';
import { needsManager, guardPush } from '../functions/api/_perm-guard.js';
import { mergeChargeRecords } from '../functions/api/_merge.js';

// Zip 328 (prompt 7 part 2) — the doctor's "Send to Cashier / Add Charge", the cashier's queue, payment, receipt and the status back to the doctor,
// across TWO real devices (jsdom) talking to the real sync function. Prices come from the Services list; a charge becomes PAID only when the sale completes.
const APP = 'hospital/index.html';
const PT = [{ id: 'PT-1', name: 'Jane Mwangi', age: 30, sex: 'female', phone: '0711000001', allergies: '', registeredAt: Date.now() - 86400000 }, { id: 'PT-2', name: 'John Otieno', age: 40, sex: 'male', phone: '0711000002', allergies: '', registeredAt: Date.now() - 86400000 }];
const INV = [
  { code: 'SV-CONS', type: 'service', name: 'Consultation', price: 500, wholesalePrice: 0, qty: 0, unit: 'use', vatCategory: 'A' },
  { code: 'SV-REV', type: 'service', name: 'Review visit', price: 300, wholesalePrice: 0, qty: 0, unit: 'use', vatCategory: 'A' },
  { code: 'SV-DRESS', type: 'service', name: 'Wound dressing', price: 800, wholesalePrice: 0, qty: 0, unit: 'use', vatCategory: 'A' },
  { code: 'SV-ZERO', type: 'service', name: 'Unpriced service', price: 0, wholesalePrice: 0, qty: 0, unit: 'use', vatCategory: 'A' },
];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const quiet = (w) => w.eval("showToast = function (m) { (window.__toasts = window.__toasts || []).push(m); }; window.confirm = () => true");
const toasts = (w) => J(w, 'window.__toasts || []');
async function pair() {
  const s = makeServer({ d1: true });
  const doc = await openDevice(APP, s, { pos_patients: JSON.stringify(PT), pos_inventory: JSON.stringify(INV) }, 1500);
  quiet(doc.w);
  await doc.w.eval('pushNow()'); await sleep(300);
  const cash = await openDevice(APP, s, deviceStorage(doc.w), 1800);
  quiet(cash.w);
  return { s, doc, cash };
}
const sync = async (from, to) => { await from.w.eval('pushNow()'); await sleep(250); await to.w.eval('pullState()'); await sleep(250); };
const addLine = (w, code, qty = 1, kind = 'consultation') => { const d = w.document; d.getElementById('rq-svc').value = code; d.getElementById('rq-qty').value = String(qty); d.getElementById('rq-kind').value = kind; w.eval('rqAddLine()'); };
const sold = async (w, method = 'cash', amount = 100000) => {
  w.eval(`currentPaymentMethod = '${method}'`);
  const t = w.document.getElementById('cash-tendered-input'); if (t) t.value = String(amount);
  await w.eval('checkoutCart()'); await sleep(300);
};

test('W1–W10: the whole lifecycle across two devices — send, duplicate-safe, cashier sees it, pays, receipt, doctor sees PAID, history and reports agree', async () => {
  const { s, doc, cash } = await pair();
  try {
    // 1-2. open the patient and the consultation
    doc.w.eval("openPatientVisitModal('PT-1')");
    assert.ok(doc.w.document.getElementById('rq-consult-btn'), 'the Send to Cashier / Add Charge button is in the consultation');
    // 3. add the configured consultation fee (price comes from the Services list)
    doc.w.eval('rqOpen()');
    addLine(doc.w, 'SV-CONS');
    assert.match(doc.w.document.getElementById('rq-in').textContent, /KES 500/);
    // 4. send - twice (a double tap), then again with the same request replayed
    const ref = doc.w.eval('currentVisitRef');
    doc.w.eval('rqSend()'); doc.w.eval('rqSend()');
    const op = doc.w.eval('RQ_OP = (typeof RQ !== "undefined" ? 1 : 0)');
    void op;
    let charges = J(doc.w, 'patientCharges.filter(c => c.ref === currentVisitRef)');
    assert.equal(charges.length, 1, 'a double tap makes ONE charge'); assert.equal(charges[0].price, 500); assert.equal(charges[0].status, 'unpaid');
    assert.equal(charges[0].requestedBy.length > 0, true); assert.equal(charges[0].encounterId, ref); assert.equal(charges[0].serviceId, 'SV-CONS'); assert.ok(charges[0].requestedAt);
    const replay = J(doc.w, `rqCreate({ opId: '${charges[0].requestId.slice(3)}', patientId: 'PT-1', ref: currentVisitRef, lines: [{ code: 'SV-CONS', qty: 1, kind: 'consultation' }] })`);
    assert.deepEqual([replay.created, replay.existing], [0, 1], 'replaying the same request adds nothing');
    assert.equal(J(doc.w, 'patientCharges.length'), 1);
    // doctor's own view: awaiting
    assert.match(doc.w.document.getElementById('rq-consult').textContent, /Awaiting payment/);
    // 5. another device sees it after sync (no manual refresh of the app)
    await sync(doc, cash);
    const q = J(cash.w, 'rqGroups()');
    assert.equal(q.length, 1); assert.equal(q[0].status, 'awaiting'); assert.equal(q[0].total, 500); assert.equal(q[0].patientName, 'Jane Mwangi'); assert.equal(q[0].ref, ref);
    cash.w.eval('rqRenderQueue()');
    const qt = cash.w.document.getElementById('rq-queue-body').textContent;
    assert.match(qt, /Jane Mwangi/); assert.match(qt, new RegExp(ref)); assert.match(qt, /Consultation/); assert.match(qt, /KES 500/); assert.match(qt, /Awaiting payment/);
    // 6. the cashier opens it (loads the bill into the counter) and 7. takes payment
    cash.w.eval(`loadPatientBill('${ref}')`);
    assert.equal(J(cash.w, 'Object.keys(currentCart).length'), 1, 'the request is in the cart at the counter');
    await sold(cash.w, 'cash', 500);
    const sale = J(cash.w, 'salesLog[salesLog.length - 1]');
    assert.equal(sale.chargeIds.length, 1);
    // 8. payment record + receipt
    assert.equal(J(cash.w, 'patientCharges[0].status'), 'paid'); assert.equal(J(cash.w, 'patientCharges[0].paidSaleId'), sale.id);
    assert.ok(sale.servedBy !== undefined && sale.timestamp);
    cash.w.eval(`rqDetail('${ref}')`);
    const det = cash.w.document.getElementById('rq-in').textContent;
    assert.match(det, /Amount charged/); assert.match(det, /Amount paid/); assert.match(det, /Outstanding balance\s*KES 0/); assert.match(det, /Receipt/);
    cash.w.eval('rqClose()');
    // 9. the doctor sees PAID
    await sync(cash, doc);
    doc.w.eval('rqRenderConsult()');
    assert.match(doc.w.document.getElementById('rq-consult').textContent, /Paid/); assert.doesNotMatch(doc.w.document.getElementById('rq-consult').textContent, /Awaiting/);
    assert.equal(J(doc.w, 'patientCharges[0].status'), 'paid');
    // 10. patient history and the financial figures agree
    const tl = J(doc.w, "buildPatientTimeline('PT-1').map(e => e.title)");
    assert.ok(tl.some((t) => /Billed KES|Billed 500|Billed/.test(t)) && tl.some((t) => /Paid in full/.test(t)), 'the patient history shows billed and paid');
    const paidTotal = J(doc.w, "patientCharges.filter(c => c.status === 'paid').reduce((s, c) => s + c.price * c.qty, 0)");
    const salesTotal = J(doc.w, "salesLog.filter(x => x.chargeIds).reduce((s, x) => s + x.items.reduce((a, i) => a + i.price * i.qty, 0), 0)");
    assert.equal(paidTotal, salesTotal, 'what the charges say was paid equals the sales recorded');
    // the saved visit does not charge the consultation fee a second time
    doc.w.document.getElementById('visit-consultation-fee-input').value = '500';
    doc.w.document.getElementById('visit-diagnosis-input').value = 'Malaria';
    doc.w.eval('saveVisit()');
    assert.equal(J(doc.w, "patientCharges.filter(c => c.kind === 'consultation' && c.status !== 'cancelled').length"), 1, 'saving the visit does not bill the fee again');
    // the server's ledger holds the charge too
    assert.ok(s.serverState().patientCharges.some((c) => c.status === 'paid' && c.paidSaleId));
  } finally { doc.close(); cash.close(); }
});

test('W11: M-PESA — a prompt that is sent, pending or failed never marks the charge paid', async () => {
  const { doc, cash } = await pair();
  try {
    doc.w.eval("openPatientVisitModal('PT-2'); rqOpen()"); addLine(doc.w, 'SV-DRESS', 1, 'procedure'); doc.w.eval('rqSend()');
    const ref = doc.w.eval('currentVisitRef');
    await sync(doc, cash);
    cash.w.eval(`loadPatientBill('${ref}')`);
    // pending: the STK prompt is out, nothing confirmed
    cash.w.eval("mpesaCheckoutRequestId = 'ws_CO_123'");
    cash.w.eval('rqRenderQueue()');
    assert.match(cash.w.document.getElementById('rq-queue-body').textContent, /M-PESA prompt sent — not paid until confirmed/);
    assert.equal(J(cash.w, 'patientCharges[0].status'), 'unpaid');
    // a cashier pressing checkout with M-PESA but no confirmed code: refused, nothing paid
    cash.w.eval("currentPaymentMethod = 'mpesa'");
    const before = J(cash.w, 'salesLog.length');
    await cash.w.eval('checkoutCart()'); await sleep(300);
    assert.equal(J(cash.w, 'salesLog.length'), before, 'no sale without a confirmed M-PESA payment');
    assert.equal(J(cash.w, 'patientCharges[0].status'), 'unpaid');
    assert.ok(toasts(cash.w).some((m) => /M-PESA is not confirmed yet/.test(m)));
    // the confirmed code (from the confirmation message) lets it through, and the sale carries the code
    cash.w.eval("mpesaCheckoutRequestId = null; document.getElementById('mpesa-code-input').value = 'QGH7TEST01'");
    await cash.w.eval('checkoutCart()'); await sleep(300);
    assert.equal(J(cash.w, 'salesLog.length'), before + 1); assert.equal(J(cash.w, 'patientCharges[0].status'), 'paid');
    assert.equal(J(cash.w, 'salesLog[salesLog.length - 1].mpesaReceiptNumber'), 'QGH7TEST01');
    cash.w.eval(`rqDetail('${ref}')`); assert.match(cash.w.document.getElementById('rq-in').textContent, /QGH7TEST01/); cash.w.eval('rqClose()');
    // failed: the prompt was cancelled by the customer
    cash.w.eval("mpesaCheckoutRequestId = null");
    cash.w.eval('rqRenderQueue()');
    assert.doesNotMatch(cash.w.document.getElementById('rq-queue-body').textContent, /M-PESA prompt sent/);
  } finally { doc.close(); cash.close(); }
});

test('W12: cancel / reject needs a reason, reaches the doctor, never touches a paid item or the payment history; partial payment shows as partly paid', async () => {
  const { doc, cash } = await pair();
  try {
    doc.w.eval("openPatientVisitModal('PT-1'); rqOpen()"); addLine(doc.w, 'SV-REV', 1, 'review'); doc.w.eval('rqSend()');
    const ref = doc.w.eval('currentVisitRef');
    await sync(doc, cash);
    assert.equal(J(cash.w, `rqCancel('${ref}', '')`).ok, false, 'a reason is required');
    assert.equal(J(cash.w, `rqCancel('${ref}', 'ab')`).ok, false);
    assert.equal(J(cash.w, `rqCancel('${ref}', 'Patient left before paying')`).ok, true);
    assert.equal(J(cash.w, `rqCancel('${ref}', 'again please')`).ok, false, 'a second cancel finds nothing unpaid');
    await sync(cash, doc);
    doc.w.eval('rqRenderConsult()');
    const t = doc.w.document.getElementById('rq-consult').textContent;
    assert.match(t, /Cancelled/); assert.match(t, /Patient left before paying/);
    assert.ok(J(doc.w, "buildPatientTimeline('PT-1').map(e => e.title)").some((x) => /Charge cancelled: Review visit/.test(x)));
    assert.equal(J(doc.w, 'patientCharges.length'), 1, 'the record is kept, not deleted');
    // a request with two lines, only one paid -> PARTLY paid, never shown as fully paid
    doc.w.eval('currentVisitRef = null; openPatientVisitModal("PT-1"); rqOpen()'); addLine(doc.w, 'SV-CONS'); addLine(doc.w, 'SV-DRESS', 1, 'procedure'); doc.w.eval('rqSend()');
    const ref2 = doc.w.eval('currentVisitRef');
    await sync(doc, cash);
    cash.w.eval(`loadPatientBill('${ref2}')`);
    const keys = J(cash.w, 'Object.keys(currentCart)');
    cash.w.eval(`delete currentCart[${JSON.stringify(keys[1])}]; renderCart()`);          // the cashier takes only the first line now
    await sold(cash.w, 'cash', 100000);
    assert.equal(J(cash.w, `rqGroups().find(g => g.ref === '${ref2}').status`), 'partial');
    // a paid item cannot be cancelled
    assert.equal(J(cash.w, `rqCancel('${ref2}', 'try to cancel everything')`).cancelled, 1, 'only the unpaid line is cancelled');
    assert.equal(J(cash.w, `patientCharges.filter(c => c.ref === '${ref2}' && c.status === 'paid').length`), 1, 'the paid line stays paid');
    await sync(cash, doc);
    assert.equal(J(doc.w, `patientCharges.filter(c => c.ref === '${ref2}' && c.status === 'paid').length`), 1);
  } finally { doc.close(); cash.close(); }
});

test('W13: unauthorized users cannot create or cancel; unpriced / unknown services are refused; no clinical block is introduced', async () => {
  const { doc } = await pair();
  try {
    doc.w.eval("openPatientVisitModal('PT-1')");
    // a staff member with no clinical / reception tab and not a manager
    doc.w.eval("isManagerSession = () => false; document.querySelectorAll('.tab-link').forEach(b => { b.style.display = 'none'; })");
    const r = J(doc.w, "rqCreate({ opId: 'x1', patientId: 'PT-1', ref: 'V-X', lines: [{ code: 'SV-CONS', qty: 1, kind: 'consultation' }] })");
    assert.equal(r.ok, false); assert.match(r.error, /do not have access/);
    assert.equal(J(doc.w, 'patientCharges.length'), 0);
    // back to a clinician
    doc.w.eval("document.querySelector('.tab-link[data-tab=\"diagnosis-tab\"]').style.display = ''");
    assert.equal(J(doc.w, "rqCreate({ opId: 'x2', patientId: 'PT-1', ref: 'V-Y', lines: [{ code: 'SV-ZERO', qty: 1, kind: 'service' }] })").ok, false, 'a service with no price is refused');
    assert.equal(J(doc.w, "rqCreate({ opId: 'x3', patientId: 'PT-1', ref: 'V-Y', lines: [{ code: 'NOPE', qty: 1, kind: 'service' }] })").ok, false);
    assert.equal(J(doc.w, "rqCreate({ opId: 'x4', patientId: 'PT-1', ref: 'V-Y', lines: [{ code: 'SV-CONS', qty: 0, kind: 'service' }] })").ok, false);
    assert.equal(J(doc.w, "rqCreate({ opId: 'x5', patientId: 'PT-1', ref: 'V-Y', lines: [{ code: 'SV-CONS', qty: 1, kind: 'consultation' }] })").ok, true);
    // the clinician is not the cashier and not the requester's colleague: a doctor who did NOT send it, without the counter tab, cannot cancel it
    doc.w.eval("patientCharges[0].requestedBy = 'Someone else'");
    assert.equal(J(doc.w, "rqCancel('V-Y', 'not mine to cancel')").ok, false);
    // sending a request never blocks saving the consultation
    doc.w.document.getElementById('visit-diagnosis-input').value = 'Flu'; doc.w.eval('saveVisit()');
    assert.equal(J(doc.w, 'visits.length'), 1, 'the consultation saves with the charge still unpaid');
  } finally { doc.close(); }
});

test('W14: sync conflicts — a cancel can never overwrite a payment (merge) and the server holds a modified client to the paid rules', () => {
  const paid = { id: 'c1', status: 'paid', paidSaleId: 's1', price: 500, qty: 1, name: 'Consultation', updatedAt: 100 };
  const cancelledNewer = { id: 'c1', status: 'cancelled', cancelReason: 'left', cancelledBy: 'Pat', price: 500, qty: 1, name: 'Consultation', updatedAt: 200 };
  const m = mergeChargeRecords(paid, cancelledNewer);
  assert.equal(m.status, 'paid'); assert.equal(m.cancelConflict.reason, 'left'); assert.equal(m.paidSaleId, 's1');
  assert.equal(mergeChargeRecords(cancelledNewer, paid).status, 'paid', 'either order');
  // a sale void reopens the charge: the newer 'unpaid' wins as before
  assert.equal(mergeChargeRecords(paid, { id: 'c1', status: 'unpaid', price: 500, qty: 1, name: 'Consultation', updatedAt: 300 }).status, 'unpaid');
  // guard: flipping to paid without a sale, with a sale that does not exist, or editing a paid amount
  const stored = { id: 'c1', status: 'unpaid', price: 500, qty: 1, name: 'Consultation' };
  const ctxNo = { hasSale: () => false }, ctxYes = { hasSale: () => true };
  assert.match(needsManager('patientCharges', { ...stored, status: 'paid' }, stored, ctxYes), /completed sale/);
  assert.match(needsManager('patientCharges', { ...stored, status: 'paid', paidSaleId: 'nope' }, stored, ctxNo), /completed sale/);
  assert.equal(needsManager('patientCharges', { ...stored, status: 'paid', paidSaleId: 's1' }, stored, ctxYes), '');
  assert.match(needsManager('patientCharges', { ...paid, price: 1 }, paid, ctxYes), /cannot be changed/);
  assert.equal(needsManager('patientCharges', { ...stored, status: 'cancelled', cancelReason: 'x' }, stored, ctxNo), '', 'cancelling is not guarded here');
  // through guardPush: a staff (non-manager) push in enforce mode
  const body = { patientCharges: [{ ...stored, status: 'paid', paidSaleId: 'fake' }], salesLog: [] };
  const get = () => stored;
  const g = guardPush(body, (col, rec) => (col === 'patientCharges' ? stored : null), { enforce: true, claims: { mgr: false, perms: [] } });
  void get;
  assert.equal(g.held.length, 1); assert.equal(g.body.patientCharges[0].status, 'unpaid', 'the stored (unpaid) copy stands');
  const ok = guardPush({ patientCharges: [{ ...stored, status: 'paid', paidSaleId: 's9' }], salesLog: [{ id: 's9', paid: true }] }, (col) => (col === 'patientCharges' ? stored : null), { enforce: true, claims: { mgr: false, perms: [] } });
  assert.equal(ok.held.length, 0, 'a real sale in the same push lets the payment through');
  const mgr = guardPush(body, () => stored, { enforce: true, claims: { mgr: true, perms: ['*'] } });
  assert.equal(mgr.held.length, 0);
  const off = guardPush(body, () => stored, { enforce: false, claims: { mgr: false } });
  assert.equal(off.held.length, 0, 'with staff sessions not enforced nothing changes');
});
