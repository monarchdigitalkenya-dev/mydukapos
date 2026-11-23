import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 298: date-of-birth picker (age in years AND months), lab-history-only view for the lab technician, the stand-alone "Patient Notes" box is gone.
const APP = 'hospital/index.html';
async function app() {
  const b = await boot(APP, { storage: { pos_patients: JSON.stringify([{ id: 'PT-1', name: 'Jane Wanjiru', age: 34, sex: 'Female', phone: '0711000001', registeredAt: 1 }]),
    pos_lab_results: JSON.stringify([{ id: 'L1', patientId: 'PT-1', testName: 'Malaria RDT', requestedAt: Date.now() - 864e5, requestedBy: 'Dr A', status: 'completed', resultText: 'Positive', flag: 'abnormal', resultAt: Date.now(), resultBy: 'Ann' },
      { id: 'L2', patientId: 'PT-1', testName: 'Urinalysis', requestedAt: Date.now(), requestedBy: 'Dr A', status: 'pending' }]) }, wait: 1200 });
  b.w.eval("showToast = function (m) { (window.__toasts = window.__toasts || []).push(m); }; window.confirm = () => true; window.print = () => {}");
  return b;
}
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));

test('age is worked out from the birth date, with months and days for babies', async () => {
  const { w, close } = await app();
  const ref = (y, m, d) => `new Date(${y}, ${m - 1}, ${d})`;
  assert.deepEqual(J(w, `(() => { const a = hmisAgeParts('2026-06-02', ${ref(2026, 10, 18)}); return [a.y, a.m, a.d]; })()`), [0, 4, 16]);
  assert.equal(w.eval(`hmisAgeLabel(hmisAgeParts('2026-06-02', ${ref(2026, 10, 18)}))`), '4 months');
  assert.equal(w.eval(`hmisAgeLabel(hmisAgeParts('2024-04-10', ${ref(2026, 10, 18)}))`), '2 yrs 6 mths');
  assert.equal(w.eval(`hmisAgeLabel(hmisAgeParts('1990-10-19', ${ref(2026, 10, 18)}))`), '35 yrs', 'birthday tomorrow: still 35');
  assert.equal(w.eval(`hmisAgeLabel(hmisAgeParts('2026-10-16', ${ref(2026, 10, 18)}))`), '2 days');
  assert.equal(w.eval(`hmisAgeText({ age: 34 })`), '34 yrs', 'old records with only a number still show');
  assert.equal(w.eval(`hmisAgeText({ age: 0 })`), '0 yrs');
  assert.equal(w.eval(`hmisAgeYears({ dob: '2000-01-01' }) >= 26`), true);
  close();
});

test('the registration form takes a birth date, saves dob + age, and keeps a typed age as typed (no made-up birth date)', async () => {
  const { w, d, close } = await app();
  d.getElementById('patient-name-input').value = 'Baby Test';
  d.getElementById('patient-dob-input').value = '2026-06-02';
  d.getElementById('patient-sex-input').value = 'Male';
  w.eval('updatePatientAgeReadout()');
  assert.match(d.getElementById('patient-age-readout').textContent, /months/);
  w.eval('savePatient()');
  const baby = J(w, `patients.find(p => p.name === 'Baby Test')`);
  assert.equal(baby.dob, '2026-06-02'); assert.equal(baby.age, 0); assert.ok(!baby.dobApprox);
  d.getElementById('patient-name-input').value = 'Old Man';
  d.getElementById('patient-age-input').value = '61'; d.getElementById('patient-age-unit-input').value = 'years';
  d.getElementById('patient-sex-input').value = 'Male';
  w.eval('savePatient()');
  const old = J(w, `patients.find(p => p.name === 'Old Man')`);
  // zip 340: a typed age is saved AS TYPED (value + unit) and is never turned into an invented date of birth
  assert.equal(old.ageSource, 'entered'); assert.equal(old.ageValue, 61); assert.equal(old.ageUnit, 'years'); assert.equal(old.age, 61); assert.ok(!old.dob);
  d.getElementById('patient-name-input').value = 'Future'; d.getElementById('patient-dob-input').value = '2999-01-01';
  const before = J(w, 'patients.length'); w.eval('savePatient()');
  assert.equal(J(w, 'patients.length'), before, 'a birth date in the future is refused');
  close();
});

test('the visit form has no stand-alone Patient Notes box (the SOAP notes stay) and opens without errors', async () => {
  const { w, d, errors, close } = await app();
  w.eval("openPatientVisitModal('PT-1')");
  assert.ok(!d.getElementById('patient-notes-list') && !d.getElementById('patient-note-input'));
  assert.ok(!/Patient Notes/.test(d.getElementById('patient-visit-modal').textContent));
  assert.ok(d.getElementById('visit-soap-s-input'), 'SOAP consultation notes remain');
  assert.equal(errors.length, 0, errors.join(' | '));
  close();
});

test('Laboratory tab: one patient pick shows that patient\'s lab history only; lab technician cannot open Patient Records', async () => {
  const { w, d, close } = await app();
  w.eval("renderLaboratoryTab(); document.getElementById('lab-tab-patient-select').value = 'PT-1'; onLabTabPatientPicked('PT-1')");
  const box = d.getElementById('lab-tab-history');
  assert.equal(box.querySelectorAll('.lab-hist-row').length, 2);
  assert.match(box.textContent, /Malaria RDT/); assert.match(box.textContent, /Urinalysis/);
  assert.ok(!/diagnos|visit|bill|medicat/i.test(box.textContent), 'lab history shows lab data only');
  assert.equal(d.querySelectorAll('#lab-tab-actions .btn-main').length, 1, 'one Request button (the duplicate is gone)');
  w.eval("clearLabTabHistory()"); assert.equal(box.innerHTML, '');
  assert.ok(!w.eval("CLINICAL_ROLE_PRESETS.lab_tech.tabs.includes('patients-tab')"));
  w.eval("staff.push({ id: 'S1', name: 'Ann', roles: ['laboratory-tab', 'patients-tab'], clinicalRole: 'lab_tech' }); currentServer = { id: 'S1', name: 'Ann' };");
  assert.equal(w.eval("isTabLocked('patients-tab')"), true, 'even if it was ticked before');
  assert.equal(w.eval("isTabLocked('laboratory-tab')"), false);
  close();
});
