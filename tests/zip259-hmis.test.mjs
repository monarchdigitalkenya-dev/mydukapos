import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 259 HMIS: consolidated prescription (NA), lab catalogue + structured results, inpatient account / meals / MAR / transfer. Synthetic data only.
const APP = 'hospital/index.html';
const NOW = Date.now();
const PATIENTS = [
  { id: 'PT-1', name: 'Test Patient One', age: 30, sex: 'female', phone: '0700000001', allergies: 'Penicillin', registeredAt: NOW - 86400000 },
  { id: 'PT-2', name: 'Test Patient Two', age: 40, sex: 'male', phone: '0700000002', allergies: '', registeredAt: NOW - 86400000 },
];
const INV = [
  { code: 'AX', type: 'item', name: 'Amoxicillin 500mg', price: 30, wholesalePrice: 15, qty: 40, unit: 'pcs', vatCategory: 'A' },
  { code: 'PC', type: 'item', name: 'Paracetamol 500mg', price: 5, wholesalePrice: 2, qty: 0, unit: 'pcs', vatCategory: 'A' },
];
const opened = [];
after(() => { for (const b of opened) { try { b.close(); } catch (e) { /* already closed */ } } });
async function app(extra = {}) {
  const b = await boot(APP, { storage: { pos_hrx_hm: '1', pos_patients: JSON.stringify(PATIENTS), pos_inventory: JSON.stringify(INV), ...(extra.storage || {}) }, wait: 400 });
  opened.push(b);
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push(m); }; window.confirm = () => true; window.prompt = () => 'test reason';");
  return b;
}
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const report = (w) => w.document.getElementById('sales-report-body').textContent.replace(/\s+/g, ' ');

test('nothing patient-specific is preloaded; starter catalogue covers every category', async () => {
  const { w } = await app();
  assert.equal(J(w, 'labResults').length, 0);
  const cats = new Set(J(w, 'hmisLab.tests().map(t => t.category)'));
  for (const c of ['Urinalysis', 'Haematology', 'Malaria', 'Chemistry', 'Stool', 'Microbiology', 'Serology', 'Other']) assert.ok(cats.has(c), c);
  assert.equal(J(w, 'hmisConfig').length, 0, 'seed lives in code: nothing stored until someone customises');
});

test('one consolidated prescription: stocked, out-of-stock and not-stocked drugs in ONE document with NA', async () => {
  const { w } = await app();
  w.eval(`currentVisitPatientId = 'PT-1'; visitMedicationDraft = [
    { code: 'AX', qty: '10', dosage: '1 tds', saleMode: 'box', notStocked: false, freeName: '' },
    { code: 'PC', qty: '20', dosage: '2 qid', saleMode: 'box', notStocked: false, freeName: '' },
    { code: '', qty: '5', dosage: 'od', saleMode: 'piece', notStocked: true, freeName: 'Zinc dispersible' }]`);
  w.eval('printPrescription()');
  const t = report(w);
  assert.match(t, /Amoxicillin 500mg/); assert.match(t, /Paracetamol 500mg/); assert.match(t, /Zinc dispersible/);
  assert.equal((w.document.getElementById('sales-report-body').querySelectorAll('table').length), 1, 'one table, not a second slip');
  const rows = [...w.document.querySelectorAll('#sales-report-body tbody tr')].map((r) => r.textContent.replace(/\s+/g, ' '));
  assert.match(rows.find((r) => r.includes('Amoxicillin')), /Available/);
  assert.match(rows.find((r) => r.includes('Paracetamol')), /NA/);
  assert.match(rows.find((r) => r.includes('Zinc')), /NA/);
  assert.match(w.eval('lastReportText'), /Zinc dispersible .*NA/);
  assert.match(t, /Penicillin/);
});

test('saved prescription shows prescribed / dispensed / outstanding from the charges', async () => {
  const { w } = await app();
  w.eval(`visits.push({ id: 'v1', ref: 'R1', patientId: 'PT-1', timestamp: ${NOW}, seenBy: 'Dr Test', diagnosis: 'Test dx', medications: [
     { code: 'AX', name: 'Amoxicillin 500mg', qty: 10, unit: 'pcs', dosage: '1 tds' }, { name: 'Zinc dispersible', qty: 5, notStocked: true, dosage: 'od' }] });
   patientCharges.push({ id: 'c1', ref: 'R1', patientId: 'PT-1', kind: 'medication', name: 'Amoxicillin 500mg', code: 'AX', qty: 10, price: 30, status: 'paid', dispenseState: 'awaiting', createdAt: ${NOW} });`);
  w.eval("printExternalPrescriptionForRef('R1')");
  let rows = [...w.document.querySelectorAll('#sales-report-body tbody tr')].map((r) => r.textContent.replace(/\s+/g, ' '));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /Available.*0.*10/);          // not dispensed yet: dispensed 0, outstanding 10
  assert.match(rows[1], /NA/);
  w.eval(`patientCharges[0].dispensedAt = ${NOW}; patientCharges[0].dispenseState = 'dispensed'`);
  w.eval("printExternalPrescriptionForRef('R1')");
  rows = [...w.document.querySelectorAll('#sales-report-body tbody tr')].map((r) => r.textContent.replace(/\s+/g, ' '));
  assert.match(rows[0], /Available.*10.*0/);
});

test('Request Lab: multi-select, indication, duplicate guard, price, disable hides a test', async () => {
  const { w } = await app();
  w.eval(`document.getElementById('lab-tab-patient-select').value = 'PT-1'; hmisOpenRequestLab('tab')`);
  const d = w.document;
  assert.ok(d.getElementById('hc-rl').classList.contains('open'));
  assert.ok(d.querySelectorAll('[data-rl-t]').length >= 20);
  w.eval("putOverride = null");   // (closure-private; just proving it is not leaked)
  w.eval("hmisConfig.push({ id: 'lc_urinalysis', type: 'labtest', price: 250, updatedAt: 1 }); hmisConfig.push({ id: 'lc_fbc', type: 'labtest', active: false, updatedAt: 1 })");
  w.eval(`hmisOpenRequestLab('tab')`);
  assert.equal(d.querySelector('[data-rl-t="lc_fbc"]'), null, 'disabled test is not offered');
  for (const id of ['lc_urinalysis', 'lc_mrdt']) d.querySelector(`[data-rl-t="${id}"]`).click();
  d.getElementById('hc-rl-ind').value = 'fever 3 days'; d.getElementById('hc-rl-pri').value = 'Urgent';
  d.querySelector('[data-rl-go]').click();
  const labs = J(w, 'labResults');
  assert.equal(labs.length, 2);
  assert.equal(labs.find((l) => l.testId === 'lc_urinalysis').price, 250);
  assert.equal(labs[0].indication, 'fever 3 days'); assert.equal(labs[0].priority, 'Urgent'); assert.equal(labs[0].status, 'pending');
  const ch = J(w, "patientCharges.filter(c => c.kind === 'lab')");
  assert.equal(ch.length, 2); assert.equal(ch.find((c) => c.name.includes('Urinalysis')).price, 250); assert.ok(ch.every((c) => c.status === 'unpaid'));
  // asking again within the hour is refused
  w.eval(`document.getElementById('lab-tab-patient-select').value = 'PT-1'; hmisOpenRequestLab('tab')`);
  d.querySelector('[data-rl-t="lc_urinalysis"]').click(); d.querySelector('[data-rl-go]').click();
  assert.equal(J(w, 'labResults').length, 2);
});

test('structured urinalysis: draft -> final (auto-flags) -> verify -> printable; amend keeps the original', async () => {
  const { w } = await app();
  const d = w.document;
  w.eval(`labResults.push({ id: 'L1', patientId: 'PT-2', testName: 'Urinalysis (Urine R/E)', testId: 'lc_urinalysis', requestedAt: ${NOW}, status: 'pending', resultText: '' })`);
  w.eval("openLabResultModal('L1')");
  assert.ok(d.getElementById('hc-sr').classList.contains('open'));
  const set = (k, v) => { const e = d.querySelector(`#hc-sr [data-sr="${k}"]`); e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); };
  assert.ok(d.querySelectorAll('#hc-sr [data-sr]').length >= 18);
  assert.ok(![...d.querySelectorAll('#hc-sr [data-sr]')].some((e) => e.value), 'blank form: no preloaded findings');
  set('ph', '9.2'); set('protein', '++'); set('leucocytes', 'Negative'); set('pus', '10-15');
  d.querySelector('[data-sr-act="draft"]').click();
  assert.equal(J(w, 'labResults[0].stage'), 'draft'); assert.equal(J(w, 'labResults[0].status'), 'pending', 'a draft is not a released result');
  d.querySelector('[data-sr-act="final"]').click();
  const r = J(w, 'labResults[0]');
  assert.equal(r.status, 'completed'); assert.equal(r.stage, 'final'); assert.equal(r.flag, 'abnormal');
  assert.match(r.resultText, /pH 9\.2 \(H\)/); assert.match(r.resultText, /Protein \+\+/); assert.doesNotMatch(r.resultText, /Leucocytes/);
  d.querySelector('[data-sr-act="verify"]').click();
  assert.equal(J(w, 'labResults[0].stage'), 'verified');
  w.eval("hmisLabPrint('L1')");
  const t = report(w); assert.match(t, /VERIFIED/); assert.match(t, /Protein/); assert.match(t, /Test Patient Two/); assert.match(t, /Pus cells/);
  w.eval("openLabResultModal('L1')"); d.querySelector('[data-sr-act="reopen"]').click();
  const a = J(w, 'labResults[0]'); assert.equal(a.stage, 'draft'); assert.equal(a.amendments.length, 1); assert.match(a.amendments[0].before.resultText, /pH 9\.2/);
});

function admit(w, id = 'AD1', bed = 'Bed 1', days = 1, extra = '') {
  w.eval(`rooms = ['Bed 1','Bed 2','Bed 3']; bedTypes = { 'Bed 1': 'General', 'Bed 2': 'Private', 'Bed 3': 'General' }; roomStates = {};
    roomStates['${bed}'] = { status: 'occupied', patientId: 'PT-1', admissionId: '${id}' };
    admissions.push({ id: '${id}', patientId: 'PT-1', bedLabel: '${bed}', wardType: bedTypes['${bed}'], diagnosis: 'Test', admittedAt: ${Date.now()} - ${days} * 86400000 + 3600000, status: 'admitted', depositAmount: 1000, dailyBedRate: 1000, dailyNursingRate: 500, notes: [] ${extra} })`);
}

test('inpatient: transfer — no double occupancy, days billed once across beds, history kept', async () => {
  const { w } = await app();
  admit(w, 'AD1', 'Bed 1', 3);          // 3 days
  w.eval("roomStates['Bed 3'] = { status: 'occupied', patientId: 'PT-2' }");
  w.eval("hmisOpenInpatient('AD1', 'transfer')");
  const d = w.document;
  assert.ok(!d.querySelector('#ip-bed option[value="Bed 3"]'), 'occupied bed not offered');
  d.getElementById('ip-bed').value = 'Bed 3'; d.querySelector('[data-ip-move]').click();
  assert.equal(J(w, 'admissions[0].bedLabel'), 'Bed 1', 'refused: Bed 3 is occupied');
  d.getElementById('ip-bed').value = 'Bed 2'; d.getElementById('ip-bwhy').value = 'needs isolation'; d.querySelector('[data-ip-move]').click();
  const a = J(w, 'admissions[0]'); assert.equal(a.bedLabel, 'Bed 2'); assert.equal(a.bedHistory.length, 2);
  assert.equal(J(w, "roomStates['Bed 1'].status"), 'cleaning'); assert.equal(J(w, "roomStates['Bed 2'].status"), 'occupied');
  // total days stays 3 whatever the split; just transferred => all 3 days at the first bed's rate (day charged at the bed occupied when it started)
  assert.equal(w.eval('admissionDaysSoFar(admissions[0])'), 3);
  assert.equal(w.eval('admBedTotal(admissions[0])'), 3 * 1500);
  // a transfer a day and a half later bills the later day(s) at the new bed's rate, never more than 3 days in total
  w.eval(`admissions[0].bedHistory[0].to = admissions[0].admittedAt + 86400000 + 1000; admissions[0].bedHistory[1].from = admissions[0].bedHistory[0].to; admissions[0].bedHistory[1].bedRate = 2000; admissions[0].bedHistory[1].nursingRate = 500`);
  assert.equal(w.eval('admBedTotal(admissions[0])'), 2 * 1500 + 1 * 2500);
});

test('inpatient: one account — lab + medicines + meals + services + deposit, nothing double counted, cashier-paid stays distinct', async () => {
  const { w } = await app();
  admit(w, 'AD1', 'Bed 1', 2);
  w.eval(`patientCharges.push(
    { id: 'p1', ref: 'R9', patientId: 'PT-1', kind: 'lab', name: 'Lab Test: Malaria RDT', qty: 1, price: 300, status: 'paid', createdAt: ${NOW} - 3600000 },
    { id: 'p2', ref: 'R9', patientId: 'PT-1', kind: 'medication', name: 'Amoxicillin', qty: 2, price: 100, status: 'unpaid', createdAt: ${NOW} - 3600000 },
    { id: 'p3', ref: 'R0', patientId: 'PT-1', kind: 'lab', name: 'Old lab before admission', qty: 1, price: 999, status: 'unpaid', createdAt: ${NOW} - 10 * 86400000 })`);
  const A = J(w, 'hmisAccount(admissions[0])');
  assert.equal(A.bed, 2 * 1500); assert.equal(A.chargeTotal, 500, 'pre-admission charge excluded');
  assert.equal(A.total, 3500); assert.equal(A.chargePaid, 300); assert.equal(A.balance, 3500 - 1000 - 300);
  const d = w.document;
  w.eval("hmisOpenInpatient('AD1', 'meals')");
  w.eval("hmisConfig.push({ id: 'mn_lunch', type: 'menu', price: 150, updatedAt: 1 })");
  w.eval("hmisOpenInpatient('AD1', 'meals')");
  d.getElementById('ip-meal').value = 'mn_lunch'; d.getElementById('ip-mdate').value = '2026-01-05';
  d.querySelector('[data-ip-meal]').click();
  d.getElementById('ip-meal').value = 'mn_lunch'; d.getElementById('ip-mdate').value = '2026-01-05'; d.querySelector('[data-ip-meal]').click();      // again: same meal, same day
  assert.equal(J(w, "patientCharges.filter(c => c.kind === 'meal')").length, 1, 'same meal, same day: once');
  assert.equal(J(w, 'hmisAccount(admissions[0]).chargeTotal'), 650);
  // included policy => recorded at no charge
  w.eval("hmisConfig.push({ id: 'policy', type: 'policy', mealsBilling: 'included', updatedAt: 2 })");
  w.eval("hmisOpenInpatient('AD1', 'meals')"); d.getElementById('ip-mdate').value = '2026-01-06'; d.querySelector('[data-ip-meal]').click();
  assert.equal(J(w, "patientCharges.filter(c => c.kind === 'meal' && c.mealDate === '2026-01-06')[0].price"), 0);
  // per-day service charge once per date; priced from Setup
  w.eval("hmisConfig.push({ id: 'ct_nursing', type: 'chargetype', price: 400, updatedAt: 3 })");
  w.eval("hmisOpenInpatient('AD1', 'charges')"); d.getElementById('ip-ct').value = 'ct_nursing'; d.getElementById('ip-cd').value = '2026-01-05';
  d.querySelector('[data-ip-charge]').click();
  d.getElementById('ip-ct').value = 'ct_nursing'; d.getElementById('ip-cd').value = '2026-01-05'; d.querySelector('[data-ip-charge]').click();
  assert.equal(J(w, "patientCharges.filter(c => c.name === 'Nursing care')").length, 1);
  // zip 367: no payment is taken in the ward any more (send to cashier). A payment already on file can still be reversed.
  w.eval("hmisOpenInpatient('AD1', 'account')");
  assert.equal(d.querySelector('[data-ip-pay]'), null, 'no take-payment button in the ward');
  assert.ok(d.querySelector('[data-ipx="send-cashier"]'), 'Send to cashier is there');
  w.eval("admissions[0].depositAmount += 500; admissions[0].ledger = [{ id: 'LG1', type: 'payment', amount: 500, at: Date.now(), by: 'x' }]; hmisOpenInpatient('AD1', 'account')");
  d.querySelector('[data-ip-rev]').click();
  assert.equal(J(w, 'admissions[0].depositAmount'), 1000); assert.equal(J(w, 'admissions[0].ledger').length, 2);
  assert.ok(J(w, 'admissions[0].ledger[0].reversedBy'));
  assert.equal(J(w, "expenses.filter(e => e.category === 'Admission refund').length"), 1);
});

test('inpatient: MAR needs a reason unless given; discharge warns on unpaid, prints account, releases bed; readmission is linked', async () => {
  const { w } = await app();
  admit(w, 'AD1', 'Bed 1', 1);
  const d = w.document;
  w.eval("hmisOpenInpatient('AD1', 'mar')");
  d.getElementById('mr-drug').value = 'Ceftriaxone'; d.getElementById('mr-st').value = 'refused'; d.querySelector('[data-ip-mar]').click();
  assert.equal(J(w, 'admissions[0].mar || []').length, 0, 'refused needs a reason');
  d.getElementById('mr-why').value = 'patient declined'; d.querySelector('[data-ip-mar]').click();
  d.getElementById('mr-drug').value = 'Ceftriaxone'; d.getElementById('mr-st').value = 'given'; d.querySelector('[data-ip-mar]').click();
  assert.deepEqual(J(w, 'admissions[0].mar.map(m => m.status)'), ['refused', 'given']);
  w.eval(`patientCharges.push({ id: 'p2', ref: 'R9', patientId: 'PT-1', kind: 'medication', name: 'Amoxicillin', qty: 2, price: 100, status: 'unpaid', createdAt: ${NOW} })`);
  let asked = 0; w.eval('window.confirm = (m) => { window.__asked = (window.__asked || 0) + 1; window.__askMsg = m; return true; }');
  w.eval("openDischargeModal('AD1'); document.getElementById('discharge-summary-input').value = 'Recovered'; confirmDischarge()");
  assert.equal(w.eval('window.__asked'), 1); assert.match(w.eval('window.__askMsg'), /still unpaid/);
  assert.equal(J(w, 'admissions[0].status'), 'discharged'); assert.equal(J(w, "roomStates['Bed 1'].status"), 'cleaning');
  // Zip 367: discharge sends the bed bill still owed (1 day 1,500 - 1,000 deposit) to the cashier as an unpaid charge, so 2 items are unpaid: the medicine + the bed balance
  assert.equal(J(w, 'admissions[0].finalAccount.unpaidItems'), 2);
  assert.deepEqual(J(w, "patientCharges.filter(c => c.status === 'unpaid' && c.kind !== 'medication').map(c => c.price * c.qty)"), [500], 'bed balance sent to the cashier, once');
  const t = report(w); assert.match(t, /Discharge Summary/); assert.match(t, /Admission account/); assert.match(t, /Pharmacy/);
  // the unpaid medicine is still unpaid for the cashier — discharge never marked it paid
  assert.equal(J(w, "patientCharges.find(c => c.id === 'p2').status"), 'unpaid');
  // readmission
  w.eval("document.getElementById('admit-patient-select').innerHTML = '<option value=\"PT-1\">x</option>'; document.getElementById('admit-patient-select').value = 'PT-1'; roomStates['Bed 2'] = { status: 'available' }; renderAdmitBedSelect(); document.getElementById('admit-bed-select').value = 'Bed 2'; admitPatient()");
  assert.equal(J(w, 'admissions.length'), 2); assert.equal(J(w, 'admissions[1].readmitOf'), 'AD1');
});

test('new-visit summary shows history; hmisConfig travels in the sync state', async () => {
  const { w } = await app();
  w.eval(`visits.push({ id: 'v1', ref: 'R1', patientId: 'PT-1', timestamp: ${NOW} - 86400000, diagnosis: 'Malaria', medications: [{ name: 'Artemether', qty: 6 }] })`);
  assert.match(w.eval("hmisVisitSummary('PT-1')"), /Malaria/);
  assert.match(w.eval("hmisVisitSummary('PT-2')"), /First visit/);
  w.eval("hmisConfig.push({ id: 'lc_x', type: 'labtest', name: 'x' })");
  assert.ok(w.eval("typeof getSyncState === 'function' ? JSON.stringify(getSyncState()).includes('hmisConfig') : true"));
});
