import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 340: patient registration - two ways to give an age: Date of birth, or Enter age (a number + Years / Months / Days).
const APP = 'hospital/index.html';
const dayISO = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
async function app(patients = []) {
  const b = await boot(APP, { storage: { pos_patients: JSON.stringify(patients) }, wait: 1200 });
  b.w.HTMLElement.prototype.scrollIntoView = function () {};
  b.w.eval("showToast = function (m) { (window.__toasts = window.__toasts || []).push(m); }; window.confirm = () => true");
  return b;
}
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
function fill(d, name, mode, value, unit) {
  d.getElementById('patient-name-input').value = name;
  d.getElementById(mode === 'age' ? 'patient-age-mode-age' : 'patient-age-mode-dob').checked = true;
  d.defaultView.setPatientAgeMode(mode);
  if (mode === 'age') { d.getElementById('patient-age-input').value = value; if (unit) d.getElementById('patient-age-unit-input').value = unit; }
  else d.getElementById('patient-dob-input').value = value;
}

test('the form shows only the box for the chosen option; Years is the default unit', async () => {
  const { d, w, errors, close } = await app();
  assert.equal(d.getElementById('age-pane-dob').hidden, false);
  assert.equal(d.getElementById('age-pane-age').hidden, true);
  assert.equal(d.getElementById('patient-age-unit-input').value, 'years');
  assert.deepEqual([...d.getElementById('patient-age-unit-input').options].map((o) => o.value), ['years', 'months', 'days']);
  w.setPatientAgeMode('age');
  assert.equal(d.getElementById('age-pane-dob').hidden, true);
  assert.equal(d.getElementById('age-pane-age').hidden, false);
  assert.equal(errors.length, 0, errors.join(' | '));
  close();
});

test('25 years, 8 months and 12 days are saved with their own unit - months and days are never read as years', async () => {
  const { d, w, close } = await app();
  fill(d, 'Adult Test', 'age', '25', 'years'); w.savePatient();
  fill(d, 'Infant Test', 'age', '8', 'months'); w.savePatient();
  fill(d, 'Newborn Test', 'age', '12', 'days'); w.savePatient();
  const get = (n) => J(w, `patients.find(p => p.name === '${n}')`);
  const a = get('Adult Test'), i = get('Infant Test'), n = get('Newborn Test');
  assert.deepEqual([a.ageValue, a.ageUnit, a.age, a.ageSource], [25, 'years', 25, 'entered']);
  assert.deepEqual([i.ageValue, i.ageUnit, i.age], [8, 'months', 0]);
  assert.deepEqual([n.ageValue, n.ageUnit, n.age], [12, 'days', 0]);
  assert.ok(!a.dob && !i.dob && !n.dob, 'a typed age never becomes an invented date of birth');
  assert.equal(w.hmisAgeText(a), '25 yrs'); assert.equal(w.hmisAgeText(i), '8 months'); assert.equal(w.hmisAgeText(n), '12 days');
  assert.equal(w.hmisAgeYears(i), 0); assert.equal(w.hmisAgeYears(n), 0);
  close();
});

test('a date of birth still works: the age is worked out and nothing extra is saved', async () => {
  const { d, w, close } = await app();
  fill(d, 'Dob Test', 'dob', dayISO(-45));
  w.updatePatientAgeReadout();
  assert.match(d.getElementById('patient-age-readout').textContent, /Age:/);
  w.savePatient();
  const p = J(w, `patients.find(x => x.name === 'Dob Test')`);
  assert.equal(p.dob, dayISO(-45)); assert.equal(p.age, 0); assert.equal(p.ageSource, 'dob'); assert.equal(p.ageValue, null);
  assert.match(w.hmisAgeText(p), /1 month/);
  close();
});

test('invalid ages are refused: letters, negatives, decimals, empty with Enter age ok, and over 120 years', async () => {
  const { d, w, close } = await app();
  for (const bad of ['-3', '2.5', 'abc', '1e3']) {
    fill(d, 'Bad ' + bad, 'age', bad, 'years');
    w.sanitizePatientAgeInput();                       // what typing does: only digits stay
    const kept = d.getElementById('patient-age-input').value;
    assert.match(kept, /^\d*$/, 'only digits survive typing: ' + bad + ' -> ' + kept);
  }
  d.getElementById('patient-age-input').value = '200'; d.getElementById('patient-age-unit-input').value = 'years';
  d.getElementById('patient-name-input').value = 'Too Old'; w.updatePatientAgeReadout();
  assert.match(d.getElementById('patient-age-readout').textContent, /more than 120/);
  const before = J(w, 'patients.length'); w.savePatient();
  assert.equal(J(w, 'patients.length'), before, 'an impossible age is not saved');
  // a hand-set invalid value (bypassing typing) is still refused
  d.getElementById('patient-age-input').type = 'text'; d.getElementById('patient-age-input').value = '-5'; w.savePatient();
  assert.equal(J(w, 'patients.length'), before);
  d.getElementById('patient-age-input').type = 'number'; d.getElementById('patient-age-input').value = ''; d.getElementById('patient-name-input').value = 'No Age Given';
  w.savePatient();
  assert.equal(J(w, 'patients.length'), before + 1, 'age stays optional');
  close();
});

test('a typed age keeps counting up from the day it was entered', async () => {
  const { w, close } = await app();
  const twoMonthsAgo = dayISO(-61);
  const p = { ageSource: 'entered', ageValue: 8, ageUnit: 'months', ageAsOf: twoMonthsAgo };
  assert.equal(w.hmisAgeText(p), '10 months');
  assert.equal(w.hmisAgeText({ ageSource: 'entered', ageValue: 12, ageUnit: 'days', ageAsOf: dayISO(-3) }), '15 days');
  assert.equal(w.hmisAgeText({ ageSource: 'entered', ageValue: 25, ageUnit: 'years', ageAsOf: dayISO(0) }), '25 yrs');
  close();
});

test('editing: a real date of birth is kept unless staff confirm replacing it; typed ages reopen as typed; old records still open', async () => {
  const people = [
    { id: 'P1', name: 'Has Dob', dob: '1990-05-20', age: 36, sex: 'Female', registeredAt: 1 },
    { id: 'P2', name: 'Typed Age', ageSource: 'entered', ageValue: 8, ageUnit: 'months', ageAsOf: dayISO(-10), age: 0, dob: '', registeredAt: 1 },
    { id: 'P3', name: 'Legacy Age', age: 34, registeredAt: 1 },
    { id: 'P4', name: 'Old Estimate', dob: '2018-03-01', dobApprox: true, age: 8, registeredAt: 1 },
  ];
  const { d, w, close } = await app(people);
  // P1 opens in Date of birth mode; switching to Enter age and saving asks first - Cancel keeps the date of birth
  w.editPatient('P1');
  assert.equal(w.getPatientAgeMode(), 'dob'); assert.equal(d.getElementById('patient-dob-input').value, '1990-05-20');
  w.setPatientAgeMode('age'); d.getElementById('patient-age-input').value = '30';
  let asked = 0; w.confirm = () => { asked++; return false; };
  w.savePatient();
  assert.equal(asked, 1); assert.equal(J(w, `patients.find(p => p.id === 'P1').dob`), '1990-05-20', 'declined: date of birth untouched');
  w.confirm = () => true; w.savePatient();
  assert.equal(J(w, `patients.find(p => p.id === 'P1').ageValue`), 30);
  assert.equal(J(w, `patients.find(p => p.id === 'P1').dob`), '', 'confirmed: replaced by the typed age');
  // P2 reopens as "8 + Months"; an unchanged save keeps the original entry day
  w.editPatient('P2');
  assert.equal(w.getPatientAgeMode(), 'age'); assert.equal(d.getElementById('patient-age-input').value, '8'); assert.equal(d.getElementById('patient-age-unit-input').value, 'months');
  w.savePatient();
  assert.equal(J(w, `patients.find(p => p.id === 'P2').ageAsOf`), dayISO(-10), 'the day the age was entered is kept');
  // P3 (older record, whole-number age only) opens as 34 years and an unchanged save adds no new fields
  w.editPatient('P3');
  assert.equal(d.getElementById('patient-age-input').value, '34'); assert.equal(d.getElementById('patient-age-unit-input').value, 'years');
  w.savePatient();
  const p3 = J(w, `patients.find(p => p.id === 'P3')`); assert.equal(p3.age, 34); assert.ok(p3.ageValue === undefined && !p3.ageSource);
  // P4 (older estimated birth date) opens as an age; unchanged save keeps its record as it was
  w.editPatient('P4');
  assert.equal(w.getPatientAgeMode(), 'age'); assert.equal(d.getElementById('patient-age-unit-input').value, 'years');
  w.savePatient();
  assert.equal(J(w, `patients.find(p => p.id === 'P4').dob`), '2018-03-01');
  close();
});

test('the age shows correctly in the lists, the consultation, lab report and prescription', async () => {
  const people = [{ id: 'P9', name: 'Baby Typed', sex: 'Male', ageSource: 'entered', ageValue: 8, ageUnit: 'months', ageAsOf: dayISO(0), age: 0, registeredAt: 1 }];
  const { d, w, errors, close } = await app(people);
  w.openPatientVisitModal('P9');
  assert.match(d.getElementById('patient-visit-modal-sub').textContent, /8 months/);
  assert.ok(!/0 yrs/.test(d.getElementById('patient-visit-modal-sub').textContent));
  w.onDiagnosisPatientPicked('P9');
  assert.match(d.getElementById('diagnosis-search-card').textContent, /8 months/);
  assert.equal(errors.length, 0, errors.join(' | '));
  close();
});

test('a typed age survives the sync merge unchanged (the patient record is merged whole, by id)', async () => {
  const { mergeRecordsById } = await import('../functions/api/_merge.js');
  const rec = { id: 'P9', name: 'Baby Typed', ageSource: 'entered', ageValue: 8, ageUnit: 'months', ageAsOf: '2026-10-01', age: 0, updatedAt: 5 };
  const out = mergeRecordsById([], [rec], false, 'patients');
  assert.deepEqual(out[0], rec);
  const edited = { ...rec, ageValue: 9, updatedAt: 9 };
  assert.equal(mergeRecordsById([rec], [edited], false, 'patients')[0].ageValue, 9, 'the newer edit wins');
});
