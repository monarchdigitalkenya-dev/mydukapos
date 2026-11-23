import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 269 - the lab test field: the whole Kenyan test menu is preloaded; one box to type in or pick from.
const NOW = Date.now();
const PATIENTS = [{ id: 'PT-1', name: 'Test Patient One', age: 30, sex: 'female', phone: '0700000001', allergies: '', registeredAt: NOW - 86400000 }];
const opened = [];
after(() => { for (const b of opened) { try { b.close(); } catch (e) { /* already closed */ } } });
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app() {
  const b = await boot('hospital/index.html', { storage: { pos_patients: JSON.stringify(PATIENTS) }, wait: 700 }); opened.push(b);
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = () => 'x'");
  return b;
}

test('the catalogue holds the full test menu: every discipline, unique ids and names, a result field on each test', async () => {
  const { w } = await app();
  const tests = J(w, 'hmisLab.tests()');
  assert.ok(tests.length >= 250, 'at least 250 tests, got ' + tests.length);
  const ids = tests.map((t) => t.id), names = tests.map((t) => t.name.toLowerCase());
  assert.equal(new Set(ids).size, ids.length, 'ids are unique'); assert.equal(new Set(names).size, names.length, 'no test is listed twice');
  const cats = new Set(tests.map((t) => t.category));
  for (const c of ['Haematology', 'Chemistry', 'Urinalysis', 'Hormones', 'Tumour markers', 'Immunology', 'Serology', 'Malaria', 'Microbiology', 'Parasitology', 'Cytology & Histology', 'Molecular', 'Blood bank', 'Stool', 'Toxicology']) assert.ok(cats.has(c), 'category ' + c);
  assert.ok(tests.every((t) => Array.isArray(t.fields) && t.fields.length >= 1 && t.name && t.specimen), 'every test can take a result');
  // a few of the tests every Kenyan lab is asked for
  for (const n of ['Full Blood Count (FBC)', 'Malaria RDT', 'Thyroid Stimulating Hormone (TSH)', 'Glycated Haemoglobin (HbA1c)', 'PSA Total (Prostate Specific Antigen)', 'Pap Smear (cervical cytology)', 'Blood Culture & Sensitivity', 'CD4 Count', 'HIV Viral Load', 'GeneXpert MTB/RIF', 'Hepatitis C Antibody (HCV)', 'Prothrombin Time / INR (PT/INR)', 'Semen Analysis', 'Urine Protein / Creatinine Ratio', 'Kato-Katz (stool helminth eggs)']) assert.ok(names.includes(n.toLowerCase()), 'listed: ' + n);
  assert.equal(J(w, 'hmisConfig').length, 0, 'the list lives in the code: nothing is stored until someone changes a test');
});

test('both lab test boxes are one type-or-pick field: a drop-down list of every active test, kept current', async () => {
  const { w, d } = await app();
  w.eval('hmisInject()');
  for (const id of ['lab-test-name-input', 'lab-tab-test-name-input']) assert.equal(d.getElementById(id).getAttribute('list'), 'hc-lab-dl', id);
  const opts = [...d.querySelectorAll('#hc-lab-dl option')];
  assert.ok(opts.length >= 250);
  const tsh = opts.find((o) => /TSH/.test(o.value)); assert.ok(tsh); assert.match(tsh.getAttribute('label'), /^Hormones/, 'the category is beside the name');
  // typing a few letters narrows it (this is what the browser does with the list); every abbreviation is in the name
  const find = (q) => opts.filter((o) => o.value.toLowerCase().includes(q)).map((o) => o.value);
  assert.ok(find('tsh').length >= 1); assert.ok(find('hba1c').length >= 1); assert.ok(find('culture').length >= 10); assert.ok(find('hiv').length >= 5); assert.ok(find('lft').length >= 1);
  // a test switched off in the catalogue leaves the list at once, and comes back when switched on
  const before = opts.length;
  w.eval("hmisConfig.push({ id: 'lc_k_semen_analysis', type: 'labtest', active: false })");
  d.getElementById('lab-test-name-input').dispatchEvent(new w.Event('focusin', { bubbles: true }));
  assert.equal(d.querySelectorAll('#hc-lab-dl option').length, before - 1, 'a switched-off test is gone from the list');
});

test('requesting a test picked from the list creates the request with the right result form, and numbers are flagged against the range', async () => {
  const { w, d } = await app();
  w.eval("currentVisitPatientId = 'PT-1'");
  d.getElementById('lab-test-name-input').value = 'Thyroid Stimulating Hormone (TSH)';
  w.eval('requestLabTest()');
  const r = J(w, 'labResults.find(x => /TSH/.test(x.testName))');
  assert.ok(r, 'the request exists'); assert.equal(r.patientId, 'PT-1');
  const t = J(w, `hmisLab.testFor(labResults.find(x => /TSH/.test(x.testName)))`);
  assert.equal(t.fields[0].type, 'number'); assert.equal(t.fields[0].ref, '0.27-4.2');
  assert.equal(J(w, "hmisLab.flagField(hmisLab.testFor({ testName: 'Thyroid Stimulating Hormone (TSH)' }).fields[0], '9.5')"), 'H');
  assert.equal(J(w, "hmisLab.flagField(hmisLab.testFor({ testName: 'Thyroid Stimulating Hormone (TSH)' }).fields[0], '2')"), '');
  // reactive / positive tests flag the abnormal answer
  assert.equal(J(w, "hmisLab.flagField(hmisLab.testFor({ testName: 'Hepatitis C Antibody (HCV)' }).fields[0], 'Reactive')"), 'A');
  assert.equal(J(w, "hmisLab.flagField(hmisLab.testFor({ testName: 'Pap Smear (cervical cytology)' }).fields[0], 'Atypical cells seen')"), '');
});
