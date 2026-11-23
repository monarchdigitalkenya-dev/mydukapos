import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 367: POS adjustment (in-patient). Patient file, Lab / Radiology / Clinical notes tabs, no payment in the ward (send to cashier),
// meals edit / remove, renameable wards, Disposition removed from the consultation.
const APP = 'hospital/index.html';
const NOW = Date.now();
const adm = { id: 'AD1', patientId: 'PT-1', bedLabel: 'Bed 01', wardType: 'General', diagnosis: 'Severe malaria', admittedAt: NOW - 2 * 864e5, dischargedAt: null, status: 'admitted', depositAmount: 1000, dailyBedRate: 1500, dailyNursingRate: 500 };
const visit = { id: 'V1', patientId: 'PT-1', timestamp: NOW - 2 * 864e5 - 3600e3, seenBy: 'Dr A', diagnosis: 'Malaria', diagnoses: [{ name: 'Malaria' }, { name: 'Typhoid' }], soap: { s: 'fever 3 days', o: 'T 39', a: 'malaria', p: 'admit' }, medications: [{ name: 'Artemether', qty: 6, dosage: '1x2' }], services: [{ name: 'Dressing', qty: 1, price: 200 }], vitals: { bp: '120/80', pulse: 98, temp: 39 }, ref: 'V-REF-1', status: 'final' };
async function app() {
  const b = await boot(APP, { storage: {
    pos_patients: JSON.stringify([{ id: 'PT-1', name: 'Jane Wanjiru', age: 34, sex: 'Female', phone: '0711000001', registeredAt: 1 }]),
    pos_admissions: JSON.stringify([adm]), pos_visits: JSON.stringify([visit]),
    pos_rooms: JSON.stringify(['Bed 01', 'Bed 02']), pos_tables: JSON.stringify(['Ward 01', 'Ward 02']),
    pos_room_states: JSON.stringify({ 'Bed 01': { status: 'occupied', patientId: 'PT-1', admissionId: 'AD1' } }),
    pos_table_states: JSON.stringify({ 'Ward 01': { status: 'reserved', reservation: null } }),
    pos_lab_results: JSON.stringify([{ id: 'L1', patientId: 'PT-1', testName: 'Malaria RDT', requestedAt: NOW - 2 * 864e5, status: 'completed', resultText: 'Positive' }]),
    pos_radiology_orders: JSON.stringify([{ id: 'R1', orderNo: 'RAD-1', patientId: 'PT-1', modality: 'X-ray', study: 'Chest PA', requestedAt: NOW - 864e5, status: 'verified', report: { findings: 'Clear lungs', impression: 'Normal' } }]),
  }, wait: 1500 });
  b.w.eval("window.__toasts = []; showToast = function (m) { window.__toasts.push(String(m)); }; window.confirm = () => true; window.print = () => {}");
  return b;
}
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const click = (w, sel) => w.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);

test('menu says INPATIENT (ADMISSION); the Disposition / Outcome / patient-type section is gone from the consultation; Chart is Patient file', async () => {
  const { w, close } = await app();
  assert.match(w.eval("document.getElementById('tables-rooms-tab-btn').textContent"), /INPATIENT \(ADMISSION\)/);
  assert.equal(w.eval("document.getElementById('cw-disposition-removed').hidden"), true);
  assert.equal(w.eval("getComputedStyle(document.getElementById('cw-disposition-removed')).display"), 'none');
  w.eval('renderAdmissionsTable()');
  const row = w.eval("document.querySelector('#admissions-table tbody').innerHTML");
  assert.match(row, /Patient file/); assert.doesNotMatch(row, />📝 Chart</);
  close();
});

test('wards can be renamed after generating; duplicates refused; the ward keeps its status; beds untouched', async () => {
  const { w, close } = await app();
  w.eval("window.prompt = () => 'Male ward'"); w.eval("hmisAdjRenameWard('Ward 01')");
  assert.deepEqual(J(w, 'tables'), ['Male ward', 'Ward 02']);
  assert.equal(J(w, "tableStates['Male ward'].status"), 'reserved'); assert.equal(w.eval("'Ward 01' in tableStates"), false);
  assert.deepEqual(J(w, 'rooms'), ['Bed 01', 'Bed 02']);
  w.eval("window.prompt = () => 'male WARD'"); w.eval("hmisAdjRenameWard('Ward 02')");
  assert.deepEqual(J(w, 'tables'), ['Male ward', 'Ward 02'], 'a second ward cannot take the same name');
  close();
});

test('the patient file collects the consultation (vitals, dx, SOAP, treatment, services), lab and radiology automatically', async () => {
  const { w, close } = await app();
  const html = w.eval("hmisPatientFile.html(admissions[0])");
  for (const t of ['120/80', 'Malaria', 'Typhoid', 'fever 3 days', 'Artemether', 'Dressing', 'Malaria RDT', 'Positive', 'Chest PA', 'Clear lungs', 'Severe malaria']) assert.ok(html.includes(t), t + ' is in the file');
  assert.ok(w.eval("hmisPatientFile.text(admissions[0])").includes('Positive'));
  close();
});

test('Send to cashier: no payment in the ward; bed & nursing so far goes to the cashier ONCE; the total never changes', async () => {
  const { w, close } = await app();
  w.eval("hmisOpenInpatient('AD1', 'account')");
  const before = J(w, "hmisAccount(admissions[0])");
  assert.equal(before.bed, 6000, '3 days x 2000'); assert.equal(before.bedDue, 5000, 'less the 1000 deposit');
  assert.equal(w.eval("document.querySelector('#hc-ip [data-ip-pay]')"), null, 'no take-payment button in the ward');
  click(w, '#hc-ip [data-ipx="send-cashier"]');
  const a1 = J(w, "hmisAccount(admissions[0])");
  assert.equal(a1.bedSent, 5000); assert.equal(a1.total, before.total, 'bed is not counted twice'); assert.equal(a1.balance, before.balance);
  assert.equal(a1.unpaid.length, 1);
  click(w, '#hc-ip [data-ipx="send-cashier"]');                       // a second tap
  assert.equal(J(w, "patientCharges.filter(c => c.kind === 'bed').length"), 1, 'never charged twice');
  assert.equal(J(w, "salesLog.length"), 0, 'no sale / cash was recorded in the ward');
  // the cashier collects it: balance goes to 0 and the total is still the same
  w.eval("patientCharges.filter(c => c.kind === 'bed').forEach(c => { c.status = 'paid'; })");
  const a2 = J(w, "hmisAccount(admissions[0])");
  assert.equal(a2.balance, 0); assert.equal(a2.total, before.total);
  close();
});

test('Lab, Radiology and Clinical notes tabs: requests join the admission bill; inpatient lab is not held up waiting for payment', async () => {
  const { w, close } = await app();
  w.eval("hmisOpenInpatient('AD1', 'lab')");
  w.eval("document.getElementById('ipx-lab').value = 'Full Blood Count'"); click(w, '#hc-ip [data-ipx="lab-request"]');
  const lab = J(w, "labResults.find(t => /Full Blood Count/.test(t.testName))");
  assert.equal(lab.admissionId, 'AD1'); assert.equal(w.eval(`hmisLabNeedsPayment('${lab.id}')`), false);
  assert.equal(J(w, "patientCharges.filter(c => c.admissionId === 'AD1' && c.kind === 'lab').length"), 1);
  w.eval("hmisOpenInpatient('AD1', 'rad')");
  w.eval("document.getElementById('ipx-rstudy').value = 'Abdomen'; document.getElementById('ipx-rwhy').value = 'pain'"); click(w, '#hc-ip [data-ipx="rad-request"]');
  const ord = J(w, "radiologyOrders.find(o => o.study === 'Abdomen')");
  assert.equal(ord.admissionId, 'AD1');
  assert.equal(J(w, `patientCharges.find(c => c.id === '${ord.chargeId}').admissionId`), 'AD1');
  w.eval("hmisOpenInpatient('AD1', 'notes')");
  w.eval("document.getElementById('ipx-ntext').value = 'BP 118/76 comfortable'"); click(w, '#hc-ip [data-ipx="note-save"]');
  assert.equal(J(w, "admissions[0].notes.length"), 1);
  assert.ok(w.eval("hmisPatientFile.html(admissions[0])").includes('BP 118/76 comfortable'));
  close();
});

test('meals: add, edit and remove (an unpaid or zero-price meal); a paid meal cannot be removed; Charges is Services', async () => {
  const { w, close } = await app();
  w.eval("hmisOpenInpatient('AD1', 'meals')");
  const tabs = w.eval("[...document.querySelectorAll('#hc-ip .hc-tab')].map(b => b.textContent).join('|')");
  assert.match(tabs, /Services/); assert.doesNotMatch(tabs, /Charges/);
  w.eval("document.querySelector('#hc-ip [data-ip-meal]').click()");
  const meal = J(w, "patientCharges.find(c => c.kind === 'meal')"); assert.ok(meal, 'a meal was added');
  const menu = J(w, "[...document.querySelectorAll('#ip-meal option')].map(o => o.value)");
  const other = menu.find(v => !meal.postKey.endsWith('|' + v)) || menu[0];
  click(w, `#hc-ip [data-ipx="meal-edit"][data-id="${meal.id}"]`);
  w.eval(`document.getElementById('ip-meal').value = ${JSON.stringify(other)}`); w.eval("document.querySelector('#hc-ip [data-ip-meal]').click()");
  assert.equal(J(w, `patientCharges.find(c => c.id === '${meal.id}').status`), 'void', 'the old line is cancelled');
  const live = J(w, "patientCharges.filter(c => c.kind === 'meal' && c.status !== 'void')"); assert.equal(live.length, 1);
  click(w, `#hc-ip [data-ipx="meal-rm"][data-id="${live[0].id}"]`);
  assert.equal(J(w, "patientCharges.filter(c => c.kind === 'meal' && c.status !== 'void').length"), 0);
  // a paid meal with a price cannot be removed
  w.eval("patientCharges.push({ id: 'PM', kind: 'meal', admissionId: 'AD1', patientId: 'PT-1', name: 'Meal: x', qty: 1, price: 250, status: 'paid', createdAt: Date.now() })");
  w.eval("hmisOpenInpatient('AD1', 'meals')");
  assert.equal(w.eval(`document.querySelector('#hc-ip [data-ipx="meal-rm"][data-id="PM"]')`), null, 'no Remove button on a paid meal');
  close();
});

test('discharge to the patient: nothing is paid in the ward - the bed & nursing balance waits at the cashier, and the account still adds up', async () => {
  const { w, close } = await app();
  w.eval("openDischargeModal('AD1')");
  assert.match(w.eval("document.getElementById('discharge-modal-charge').textContent"), /Balance due: KES 5000\.00/);
  w.eval("document.getElementById('discharge-summary-input').value = 'recovered'; confirmDischarge()");
  assert.equal(J(w, "admissions[0].status"), 'discharged');
  assert.equal(J(w, "salesLog.length"), 0, 'no cash sale was invented');
  const c = J(w, "patientCharges.filter(c => c.kind === 'bed')"); assert.equal(c.length, 1); assert.equal(c[0].price, 5000); assert.equal(c[0].status, 'unpaid');
  const a1 = J(w, "hmisAccount(admissions[0])"); assert.equal(a1.balance, 5000, 'still owed until the cashier collects');
  w.eval("patientCharges.forEach(c => { if (c.kind === 'bed') c.status = 'paid'; })");
  assert.equal(J(w, "hmisAccount(admissions[0])").balance, 0);
  close();
});
