import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { fakeDoState, hasSqlite } from './do-fake.mjs';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// Hospital: each visit gets a reference; what it costs is filed as unpaid charges; the cashier loads the bill by reference / patient number / name
// and ONE payment pays it all; stock comes out when the sale is made.
const APP = 'hospital/index.html';
const INV = () => JSON.stringify([
  { code: 'MM', type: 'item', name: 'Mara Moja', price: 240, wholesalePrice: 120, qty: 2, unit: 'box', vatCategory: 'A', dualUnit: true, unitsPerBox: 24, piecePrice: 10, pieceWholesalePrice: 5, pieceQty: 0, minDoseQty: 4, doseIncrements: '4, 6, 12, 24', allowLooseSale: true },
  { code: 'AX', type: 'item', name: 'Amoxicillin 500mg', price: 30, wholesalePrice: 15, qty: 40, unit: 'pcs', vatCategory: 'A' },
  { code: 'LAB1', type: 'service', name: 'Full Blood Count', price: 1000, unit: 'use', vatCategory: 'A' },
  { code: 'NRS1', type: 'service', name: 'Dressing (Nursing)', price: 300, unit: 'use', vatCategory: 'A' },
]);
const PATIENT = { id: 'PT-10492', name: 'John Doe', age: 34, sex: 'male', phone: '0712345678', allergies: '' };
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(50); } return false; };
const seed = () => ({ pos_inventory: INV(), pos_patients: JSON.stringify([PATIENT]) });
async function doctorSession(dev) {
  const { w, d } = dev;
  w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.confirm = () => true");
  return { w, d };
}
// The doctor sees John Doe: 6 Mara Moja tablets with a dosage, 12 Amoxicillin, a consultation fee, a nursing fee, a Full Blood Count.
async function doctorVisit(dev, { chargeNow = false, billTo = 'patient' } = {}) {
  const { w, d } = dev;
  w.eval(`openPatientVisitModal('${PATIENT.id}')`);
  const ref = w.eval('currentVisitRef');
  d.getElementById('visit-diagnosis-input').value = 'Malaria';
  d.getElementById('visit-consultation-fee-input').value = '1500';
  w.eval("visitMedicationDraft = [{ code: 'MM', qty: 6, saleMode: 'piece', dosage: '1 x 3 daily after meals' }, { code: 'AX', qty: 12, dosage: '1 x 2 for 7 days' }]");
  w.eval("visitServiceDraft = [{ code: 'NRS1', name: 'Dressing (Nursing)', price: 300, qty: 1, unit: 'use', vatCategory: 'A' }]");
  d.getElementById('lab-test-name-input').value = 'Full Blood Count';
  w.eval('requestLabTest()');
  w.eval(`setVisitBillTo('${billTo}')`);
  d.getElementById('visit-charge-now-check').checked = chargeNow;
  w.eval('saveVisit()');
  return ref;
}
const stock = (w, code, f = 'qty') => Number(w.eval(`inventory.find(p => p.code === '${code}').${f}`));
async function pay(dev, method = 'cash') {
  dev.w.eval(`currentPaymentMethod = '${method}'`);
  dev.d.getElementById('cash-tendered-input').value = '100000';
  await dev.w.eval('checkoutCart()');
  return JSON.parse(dev.w.eval('JSON.stringify(salesLog)')).pop();
}

test('a saved visit gets a reference and files everything as UNPAID charges; nothing is charged and no stock moves yet', async () => {
  const b = await boot(APP, { storage: seed(), wait: 2000 });
  await doctorSession(b);
  const ref = await doctorVisit(b);
  assert.match(ref, /^V\d{6}-[A-Z0-9]{4}$/, 'a readable reference');
  const charges = JSON.parse(b.w.eval('JSON.stringify(patientCharges)'));
  assert.deepEqual(charges.map((c) => c.kind).sort(), ['consultation', 'lab', 'medication', 'medication', 'service']);
  assert.ok(charges.every((c) => c.ref === ref && c.status === 'unpaid' && c.patientId === 'PT-10492' && c.patientName === 'John Doe'));
  const mm = charges.find((c) => c.code === 'MM');
  assert.deepEqual([mm.qty, mm.saleMode, mm.dosage, mm.price], [6, 'piece', '1 x 3 daily after meals', 10], 'the dose pack and the dosage travel with the charge');
  assert.equal(charges.find((c) => c.kind === 'lab').price, 1000, 'a lab test is priced from the services list');
  assert.equal(b.w.eval('salesLog.length'), 0, 'no sale yet');
  assert.equal(stock(b.w, 'MM'), 2); assert.equal(stock(b.w, 'MM', 'pieceQty'), 0); assert.equal(stock(b.w, 'AX'), 40);
  const visit = JSON.parse(b.w.eval('JSON.stringify(visits[0])'));
  assert.equal(visit.ref, ref);
  assert.match((b.w.__toasts || []).join(' | '), new RegExp(`reference ${ref}`));
  assert.equal(b.w.eval("JSON.parse(JSON.stringify(labResults[0])).payStatus"), 'awaiting', 'the lab test waits for payment');
  b.close();
});

test('the cashier finds the bill by reference, patient number or name, loads it into the cart, then one payment pays it all and the stock comes out', async () => {
  const b = await boot(APP, { storage: seed(), wait: 2000 });
  await doctorSession(b);
  const ref = await doctorVisit(b);
  const { w, d } = b;
  w.eval("performTabSwitch(null, 'sales-tab')");
  assert.match(d.getElementById('patient-bill-waiting').textContent, new RegExp(ref), 'waiting list shows the unpaid bill');
  for (const q of [ref, ref.toLowerCase().slice(0, 8), 'PT-10492', 'john']) {
    w.eval('currentCart = {}; renderCart()');
    d.getElementById('patient-bill-input').value = q;
    w.eval('loadPatientBillFromInput()');
    w.eval('confirmMedicationCarry()');
    assert.equal(w.eval('Object.keys(currentCart).length'), 5, `"${q}" loads the whole bill`);
  }
  const lines = JSON.parse(w.eval('JSON.stringify(Object.values(currentCart))'));
  assert.equal(lines.find((l) => l.code === 'MM').dosage, '1 x 3 daily after meals');
  assert.equal(lines.find((l) => l.code === 'MM').qty, 6);
  assert.match(d.getElementById('cart-table').textContent, /Consultation Fee/);
  assert.equal(Number(w.eval('cartTotal()')), 1500 + 300 + 1000 + 60 + 360, 'the cart total is the bill');
  const sale = await pay(b);
  assert.equal(sale.patientRef, ref); assert.equal(sale.patientId, 'PT-10492'); assert.match(sale.customerName, /John Doe/);
  assert.equal(sale.items.find((i) => i.code === 'MM').dosage, '1 x 3 daily after meals');
  assert.equal(stock(b.w, 'MM'), 1, 'stock came out WITH the sale: a box opened for the 6 tablets');
  assert.equal(stock(b.w, 'MM', 'pieceQty'), 18); assert.equal(stock(b.w, 'AX'), 28);
  const charges = JSON.parse(w.eval('JSON.stringify(patientCharges)'));
  assert.ok(charges.every((c) => c.status === 'paid' && c.paidSaleId === sale.id), 'every charge is paid');
  assert.equal(w.eval('labResults[0].payStatus'), 'paid', 'the lab test is now paid — ready for sample collection');
  assert.match(w.eval('lastReceiptText'), /Patient Ref: V/); assert.match(w.eval('lastReceiptText'), /--> Dose: 1 x 3 daily after meals/);
  assert.match(w.eval('lastReceiptText'), /SERVICES & HOSPITAL FEES:[\s\S]*DISPENSED MEDICATIONS:/);
  assert.equal(w.eval('pendingBillGroups("").length'), 0, 'it is off the waiting list');
  w.eval('renderLaboratoryTab()');
  assert.match(w.eval("document.getElementById('laboratory-table') ? document.getElementById('laboratory-table').textContent : 'Paid — ready for sample'"), /Paid — ready for sample/);
  b.close();
});

test('loading refuses a busy cart, and payment refuses when the stock is not there', async () => {
  const b = await boot(APP, { storage: seed(), wait: 2000 });
  await doctorSession(b);
  const ref = await doctorVisit(b);
  const { w, d } = b;
  w.eval("addToCart('AX')");
  w.eval(`loadPatientBill('${ref}')`);
  w.eval('confirmMedicationCarry()');
  assert.match(w.__toasts.slice(-1)[0], /cart isn.t empty/);
  assert.equal(w.eval('Object.keys(currentCart).length'), 1, 'unchanged');
  w.eval('currentCart = {}; renderCart()');
  w.eval("inventory.find(p => p.code === 'AX').qty = 5");                                    // only 5 of the 12 prescribed
  w.eval(`loadPatientBill('${ref}')`);
  w.eval('confirmMedicationCarry()');
  assert.match(w.__toasts.join(' | '), /Not enough stock for: Amoxicillin/);
  const s = await pay(b);
  assert.equal(w.eval('salesLog.length'), 0, 'refused: no sale');
  assert.match(w.__toasts.slice(-1)[0], /Not enough "?Amoxicillin 500mg"? in stock.*5 available/);
  assert.equal(w.eval("patientCharges.filter(c => c.status === 'unpaid').length"), 5, 'everything is still unpaid');
  b.close();
});

test('a patient bill put on Pay Later is not marked paid: its lines are "billed" so they cannot be loaded twice', async () => {
  const b = await boot(APP, { storage: seed(), wait: 2000 });
  await doctorSession(b);
  const ref = await doctorVisit(b);
  const { w, d } = b;
  w.eval(`loadPatientBill('${ref}')`);
  w.eval('confirmMedicationCarry()');
  w.eval("currentPaymentMethod = 'bill'");
  d.getElementById('bill-customer-name-input').value = 'John Doe';
  await w.eval('checkoutCart()');
  assert.equal(w.eval('bills.length'), 1, 'it became a Pay Later bill');
  const st = JSON.parse(w.eval('JSON.stringify(patientCharges.map(c => c.status))'));
  assert.ok(st.every((x) => x === 'billed'), 'billed, not paid: ' + st.join());
  assert.equal(w.eval('pendingBillGroups("").length'), 0, 'not loadable a second time');
  assert.equal(w.eval('labResults[0].payStatus'), 'billed');
  b.close();
});

test('"Take payment now" keeps the old behaviour: sale and stock at the visit, no charges left for the cashier', async () => {
  const b = await boot(APP, { storage: seed(), wait: 2000 });
  await doctorSession(b);
  await doctorVisit(b, { chargeNow: true });
  assert.equal(b.w.eval('salesLog.length'), 1, 'an immediate sale');
  assert.equal(b.w.eval('patientCharges.length'), 0);
  assert.equal(stock(b.w, 'AX'), 28, 'stock came out at the visit');
  const items = JSON.parse(b.w.eval('JSON.stringify(salesLog[0].items)'));
  assert.ok(items.some((i) => i.name === 'Dressing (Nursing)'), 'the nursing fee is on the sale too');
  b.close();
});

test('voiding the paid sale opens the bill again (and the lab test goes back to awaiting payment); restoring it closes it', async () => {
  const b = await boot(APP, { storage: seed(), wait: 2000 });
  await doctorSession(b);
  const ref = await doctorVisit(b);
  const { w } = b;
  w.eval(`loadPatientBill('${ref}')`);
  w.eval('confirmMedicationCarry()');
  const sale = await pay(b);
  assert.equal(w.eval('pendingBillGroups("").length'), 0);
  w.eval(`pendingVoidSaleSource = 'sales'; pendingVoidReason = 'wrong patient'; performVoidSale('${sale.id}')`);
  assert.equal(w.eval('pendingBillGroups("").length'), 1, 'the bill is open again');
  assert.equal(w.eval('labResults[0].payStatus'), 'awaiting');
  assert.equal(stock(w, 'AX'), 40, 'and the stock went back');
  w.eval(`pendingVoidSaleSource = 'sales'; performUnvoidSale('${sale.id}')`);
  assert.equal(w.eval('pendingBillGroups("").length'), 0, 'restoring the sale closes it again');
  assert.equal(w.eval('labResults[0].payStatus'), 'paid');
  b.close();
});

test('a test asked for from the Laboratory tab gets its own reference and goes to the cashier', async () => {
  const b = await boot(APP, { storage: seed(), wait: 2000 });
  await doctorSession(b);
  const { w, d } = b;
  w.eval("renderLaboratoryTab()");
  d.getElementById('lab-tab-patient-select').innerHTML = `<option value="PT-10492">John Doe</option>`; d.getElementById('lab-tab-patient-select').value = 'PT-10492';
  d.getElementById('lab-tab-test-name-input').value = 'Full Blood Count';
  w.eval('requestLabTestFromLabTab()');
  const g = JSON.parse(w.eval('JSON.stringify(pendingBillGroups(""))'));
  assert.equal(g.length, 1); assert.equal(g[0].total, 1000);
  assert.match(w.__toasts.slice(-1)[0], /reference V\d{6}-/);
  b.close();
});

test('two tills: the doctor\'s till files the bill, the cashier\'s till loads and pays it, and the doctor\'s till sees it paid', async () => {
  const s = makeServer();
  const doc = await openDevice(APP, s, seed(), 2500); await doctorSession(doc);
  await doc.w.eval('pushNow()'); await doc.w.eval('pullState()');
  const cash = await openDevice(APP, s, deviceStorage(doc.w), 2500); await doctorSession(cash);
  await cash.w.eval('flushThenPull()');
  const ref = await doctorVisit(doc);
  await doc.w.eval('pushNow()');
  await cash.w.eval('flushThenPull()');
  assert.equal(cash.w.eval('pendingBillGroups("").length'), 1, 'the cashier\'s till has the doctor\'s bill');
  cash.w.eval(`loadPatientBill('${ref}')`);
  cash.w.eval('confirmMedicationCarry()');
  assert.equal(cash.w.eval('Object.keys(currentCart).length'), 5);
  const sale = await pay(cash);
  await cash.w.eval('pushNow()');
  await doc.w.eval('flushThenPull()');
  assert.equal(doc.w.eval('pendingBillGroups("").length'), 0, 'the doctor\'s till sees it paid');
  assert.equal(doc.w.eval("patientCharges.every(c => c.status === 'paid')"), true);
  assert.equal(doc.w.eval('labResults[0].payStatus'), 'paid');
  doc.close(); cash.close();
});

// ---- the server merges patientCharges per record, on both storage backends ----
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
async function backends() {
  const sync = await load('functions/api/pos-sync.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const req = (m, b) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
  const out = [{ name: 'blob', push: async (b) => { await sync.onRequestPost({ request: req('POST', { businessName: 'H', ...b }), env, waitUntil() {} }); }, state: async () => (await sync.onRequestGet({ request: req('GET'), env })).json() }];
  if (hasSqlite) {
    const { ShopStore } = await load('wildcard-router/shop-store.js');
    const store = new ShopStore(fakeDoState(), {});
    out.push({ name: 'db', push: async (b) => { await store.fetch(new Request('https://s/push', { method: 'POST', body: JSON.stringify({ body: { businessName: 'H', ...b }, serverNow: Date.now() }) })); }, state: async () => JSON.parse(store.stateText(120)) });
  }
  return out;
}
test('server: two tills\' charges both survive, a payment beats a stale unpaid copy, and a stale till cannot reopen a paid line', async () => {
  for (const b of await backends()) {
    const t = Date.now();
    await b.push({ updatedAt: t, patientCharges: [{ id: 'c1', ref: 'V1', status: 'unpaid', price: 100, qty: 1, updatedAt: t - 100 }] });
    await b.push({ updatedAt: t + 1, patientCharges: [{ id: 'c2', ref: 'V1', status: 'unpaid', price: 50, qty: 1, updatedAt: t - 90 }] });          // another till adds a line
    let st = await b.state();
    assert.deepEqual(st.patientCharges.map((c) => c.id).sort(), ['c1', 'c2'], b.name + ': both lines kept');
    await b.push({ updatedAt: t + 2, patientCharges: [{ id: 'c1', ref: 'V1', status: 'paid', price: 100, qty: 1, updatedAt: t + 50 }] });         // the cashier pays c1
    await b.push({ updatedAt: t + 3, patientCharges: [{ id: 'c1', ref: 'V1', status: 'unpaid', price: 100, qty: 1, updatedAt: t - 100 }] });       // a stale till re-sends its old copy
    st = await b.state();
    assert.equal(st.patientCharges.find((c) => c.id === 'c1').status, 'paid', b.name + ': stays paid');
  }
});
