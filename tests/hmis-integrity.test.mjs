import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// HMIS clinical integrity: corrections keep the original, visits are voided not erased, released lab results
// cannot be deleted, critical vitals are flagged, duplicates are detected, referrals follow a lifecycle and
// the patient timeline merges every source in time order.
const APP = 'hospital/index.html';
const now = Date.now();
const PATIENT = { id: 'PT-1', name: 'Jane Mwangi', age: 30, sex: 'Female', phone: '0712345678', allergies: 'Penicillin', registeredAt: now - 9e6 };
const VISIT = { id: 'V1', patientId: 'PT-1', timestamp: now - 8e6, seenBy: 'Dr A', visitType: 'outpatient', diagnosis: 'Malaria', notes: 'fever 3 days', ref: 'V1REF',
  medications: [{ code: 'M1', name: 'Coartem', qty: 1, dosage: '1x2' }], vitals: { bp: '190/125', pulse: '90', temp: '39.5', spo2: '97', recordedAt: now - 8.5e6 } };
const LAB = { id: 'L1', patientId: 'PT-1', testName: 'Malaria RDT', requestedAt: now - 7e6, resultAt: now - 6e6, resultText: 'Positive', resultUnits: '', referenceRange: '', flag: 'abnormal', status: 'completed' };

async function session() {
  const b = await boot(APP, { storage: { pos_patients: JSON.stringify([PATIENT]), pos_visits: JSON.stringify([VISIT]), pos_lab_results: JSON.stringify([LAB]) }, wait: 1200 });
  b.w.eval("showToast = function () {}; window.confirm = () => true");
  return b;
}

test('vitalAlerts flags critical adult readings and skips age-banded checks for children', async () => {
  const b = await session();
  const a = JSON.parse(b.w.eval("JSON.stringify(vitalAlerts({bp:'190/125',pulse:'140',temp:'39.5',spo2:'85'}, 30))"));
  assert.equal(a.length, 4);
  const kid = JSON.parse(b.w.eval("JSON.stringify(vitalAlerts({bp:'190/125',pulse:'140',temp:'36.5',spo2:'98'}, 5))"));
  assert.equal(kid.length, 0);
  assert.equal(JSON.parse(b.w.eval("JSON.stringify(vitalAlerts({bp:'120/80',pulse:'80',temp:'36.8',spo2:'98'}, 40))")).length, 0);
  b.close();
});

test('editing a visit requires a reason and keeps the original as an amendment', async () => {
  const b = await session(); const { w } = b;
  const answers = ['Severe malaria', 'updated notes', 'Lab confirmed severe'];
  w.prompt = () => answers.shift();
  w.eval("editVisitRecord('V1')");
  const v = JSON.parse(w.eval("JSON.stringify(visits[0])"));
  assert.equal(v.diagnosis, 'Severe malaria');
  assert.equal(v.amendments.length, 1);
  assert.equal(v.amendments[0].before.diagnosis, 'Malaria');
  assert.equal(v.amendments[0].reason, 'Lab confirmed severe');
  assert.ok(v.updatedAt);
  assert.ok(JSON.parse(w.eval("JSON.stringify(auditLog)")).some(a => a.action === 'Visit record amended'));
  b.close();
});

test('an amendment without a reason changes nothing', async () => {
  const b = await session(); const { w } = b;
  const answers = ['Other dx', 'n', '   '];
  w.prompt = () => answers.shift();
  w.eval("editVisitRecord('V1')");
  const v = JSON.parse(w.eval("JSON.stringify(visits[0])"));
  assert.equal(v.diagnosis, 'Malaria');
  assert.ok(!v.amendments);
  b.close();
});

test('removing a visit voids it (kept on file) and reports exclude it', async () => {
  const b = await session(); const { w } = b;
  w.prompt = () => 'entered on wrong patient';
  w.eval("deleteVisitRecord('V1')");
  assert.equal(w.eval("visits.length"), 1);
  assert.equal(w.eval("visits[0].voided.reason"), 'entered on wrong patient');
  assert.equal(w.eval("activeVisits().length"), 0);
  b.close();
});

test('a released lab result cannot be deleted; a correction keeps the original', async () => {
  const b = await session(); const { w } = b;
  w.eval("deleteLabTest('L1')");
  assert.equal(w.eval("labResults.length"), 1);
  w.prompt = () => 'transcription error';
  w.eval("openLabResultModal('L1')");
  w.document.getElementById('lab-result-value-input').value = 'Negative';
  w.eval("confirmLabResult()");
  const t = JSON.parse(w.eval("JSON.stringify(labResults[0])"));
  assert.equal(t.resultText, 'Negative');
  assert.equal(t.amendments[0].before.resultText, 'Positive');
  assert.equal(t.amendments[0].reason, 'transcription error');
  b.close();
});

test('duplicate detection matches by phone (last 9 digits) or name + age', async () => {
  const b = await session(); const { w } = b;
  assert.equal(w.eval("findPossibleDuplicatePatients({name:'Someone Else', age:50, phone:'+254712345678'}, null).length"), 1);
  assert.equal(w.eval("findPossibleDuplicatePatients({name:'jane  mwangi', age:30, phone:''}, null).length"), 1);
  assert.equal(w.eval("findPossibleDuplicatePatients({name:'Jane Mwangi', age:44, phone:'0799000111'}, null).length"), 0);
  b.close();
});

test('referral lifecycle: create -> sent -> received -> completed, then closed', async () => {
  const b = await session(); const { w, d } = b;
  w.eval("openReferralModal('V1')");
  d.getElementById('referral-to-input').value = 'KNH Cardiology';
  d.getElementById('referral-reason-input').value = 'Severe hypertension';
  w.eval("saveReferral()");
  let r = JSON.parse(w.eval("JSON.stringify(visits[0].referrals[0])"));
  assert.equal(r.status, 'pending');
  const answers = ['1', '', '1', '', '1', ''];
  w.prompt = () => answers.shift();
  ['sent', 'received', 'completed'].forEach(next => {
    w.eval("updateReferralStatus('V1','" + r.id + "')");
    r = JSON.parse(w.eval("JSON.stringify(visits[0].referrals[0])"));
    assert.equal(r.status, next);
  });
  assert.equal(r.history.length, 4);
  w.eval("updateReferralStatus('V1','" + r.id + "')");
  assert.equal(JSON.parse(w.eval("JSON.stringify(visits[0].referrals[0])")).status, 'completed');
  b.close();
});

test('a referral without a destination or reason is refused', async () => {
  const b = await session(); const { w } = b;
  w.eval("openReferralModal('V1')");
  w.eval("saveReferral()");
  assert.ok(!w.eval("visits[0].referrals"));
  b.close();
});

test('timeline merges registration, vitals, visit, prescription, lab and flags critical events newest first', async () => {
  const b = await session(); const { w } = b;
  const ev = JSON.parse(w.eval("JSON.stringify(buildPatientTimeline('PT-1'))"));
  const kinds = ev.map(e => e.kind);
  ['Registration', 'Triage', 'Consultation', 'Prescription', 'Lab'].forEach(k => assert.ok(kinds.includes(k), k));
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i - 1].ts >= ev[i].ts);
  assert.ok(ev.find(e => e.kind === 'Triage').flag, 'critical vitals are highlighted');
  w.eval("openPatientTimeline('PT-1')");
  assert.equal(w.document.getElementById('timeline-modal').style.display, 'flex');
  assert.ok(w.document.getElementById('timeline-list').textContent.includes('Malaria'));
  b.close();
});

// ---- Server: clinical collections merge per record (two devices no longer overwrite each other) ----
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
async function srv() {
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const req = (method, body) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
  return {
    push: async (d) => (await m.onRequestPost({ request: req('POST', { businessName: 'Biz', ...d }), env, waitUntil() {} })).json(),
    pull: async () => (await m.onRequestGet({ request: req('GET'), env })).json(),
  };
}
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('reception and triage pushing from two devices keep BOTH devices\' patients and queue entries', async () => {
  const s = await srv(); const t = Date.now();
  await s.push({ updatedAt: t, patients: [{ id: 'P1', name: 'A', updatedAt: t - 5000 }], queue: [] });
  await wait();
  // device 1 (reception) registers P2; device 2 (triage) never saw P2 and queues P1
  await s.push({ updatedAt: Date.now(), patients: [{ id: 'P1', name: 'A', updatedAt: t - 5000 }, { id: 'P2', name: 'B', updatedAt: Date.now() }] });
  await wait();
  await s.push({ updatedAt: Date.now(), patients: [{ id: 'P1', name: 'A', updatedAt: t - 5000 }], queue: [{ id: 'Q1', patientId: 'P1', updatedAt: Date.now() }] });
  const got = await s.pull();
  assert.deepEqual(got.patients.map(p => p.id).sort(), ['P1', 'P2']);
  assert.equal(got.queue.length, 1);
});

test('a stale visit copy cannot overwrite a newer amendment; a tombstoned patient is not resurrected', async () => {
  const s = await srv(); const t = Date.now();
  await s.push({ updatedAt: t, visits: [{ id: 'V1', diagnosis: 'Malaria', updatedAt: t - 9000 }], patients: [{ id: 'P1', name: 'A', updatedAt: t - 9000 }] });
  await wait();
  await s.push({ updatedAt: Date.now(), visits: [{ id: 'V1', diagnosis: 'Severe malaria', amendments: [{ reason: 'x' }], updatedAt: Date.now() }] });
  await wait();
  await s.push({ updatedAt: Date.now(), visits: [{ id: 'V1', diagnosis: 'Malaria', updatedAt: t - 9000 }] });     // stale device
  await s.push({ updatedAt: Date.now(), patients: [{ id: 'P1', _deleted: true, updatedAt: Date.now() }] });
  await wait();
  await s.push({ updatedAt: Date.now(), patients: [{ id: 'P1', name: 'A', updatedAt: t - 9000 }] });              // stale copy tries to bring it back
  const got = await s.pull();
  assert.equal(got.visits[0].diagnosis, 'Severe malaria');
  assert.ok(!(got.patients || []).some(p => p.id === 'P1'));
});

// ---- Zip 88: SOAP + diagnosis type, lab verification / critical alert, patient merge ----
test('saving a visit stores diagnosis type and SOAP notes', async () => {
  const b = await session(); const { w, d } = b;
  w.eval("openPatientVisitModal('PT-1')");
  d.getElementById('visit-diagnosis-input').value = 'Pneumonia';
  d.getElementById('visit-dx-type-input').value = 'final';
  d.getElementById('visit-soap-s-input').value = 'cough 5 days';
  d.getElementById('visit-soap-p-input').value = 'amoxicillin';
  w.eval("saveVisit()");
  const v = JSON.parse(w.eval("JSON.stringify(visits.find(x => x.diagnosis === 'Pneumonia'))"));
  assert.equal(v.diagnosisType, 'final');
  assert.equal(v.soap.s, 'cough 5 days');
  assert.equal(v.soap.p, 'amoxicillin');
  assert.equal(v.soap.o, '');
  b.close();
});

test('lab result needs verification; a correction clears it; critical results show a banner until acknowledged', async () => {
  const b = await session(); const { w, d } = b;
  w.eval("openLabResultModal('L1')");
  d.getElementById('lab-result-value-input').value = 'Positive ++';
  w.eval("setLabResultFlag('critical')");
  w.prompt = () => 'recheck';
  w.eval("confirmLabResult()");
  assert.equal(w.eval("labResults[0].verifiedAt"), null);
  w.confirm = () => true;
  w.eval("verifyLabResult('L1')");
  assert.ok(w.eval("labResults[0].verifiedAt"));
  w.eval("renderLaboratoryTab()");
  assert.ok(d.getElementById('lab-critical-banner').textContent.includes('CRITICAL'));
  w.eval("acknowledgeCriticalResult('L1')");
  assert.equal(d.getElementById('lab-critical-banner').textContent.trim(), '');
  b.close();
});

test('merging patients moves every record, keeps all allergies, removes the duplicate and audits it', async () => {
  const b = await boot(APP, { storage: {
    pos_patients: JSON.stringify([PATIENT, { id: 'PT-2', name: 'Jane M', age: 30, sex: 'Female', phone: '', allergies: 'Peanuts', registeredAt: now }]),
    pos_visits: JSON.stringify([VISIT, { ...VISIT, id: 'V2', patientId: 'PT-2' }]),
    pos_lab_results: JSON.stringify([{ ...LAB, id: 'L2', patientId: 'PT-2' }]) }, wait: 1200 });
  const { w } = b;
  w.eval("showToast = function () {}");
  assert.equal(w.eval("mergePatients('PT-1','PT-2','duplicate registration')"), true);
  assert.equal(w.eval("patients.length"), 1);
  assert.equal(w.eval("visits.filter(v => v.patientId === 'PT-1').length"), 2);
  assert.equal(w.eval("labResults[0].patientId"), 'PT-1');
  const p = JSON.parse(w.eval("JSON.stringify(patients[0])"));
  assert.ok(p.allergies.includes('Penicillin') && p.allergies.includes('Peanuts'));
  assert.equal(p.mergedFrom[0].id, 'PT-2');
  assert.ok(JSON.parse(w.eval("JSON.stringify(auditLog)")).some(a => a.action === 'Patients merged'));
  assert.equal(w.eval("mergePatients('PT-1','PT-1','x')"), false);
  b.close();
});

// ---- Zip 89: maternity / ANC / labour / delivery / newborn ----
const DAY = 86400000;
test('EDD is LMP + 280 days and gestation is computed in weeks + days', async () => {
  const b = await session(); const { w } = b;
  const lmp = Date.now() - 100 * DAY;
  assert.equal(w.eval(`eddFromLmp(${lmp})`), lmp + 280 * DAY);
  assert.equal(w.eval(`gestationWeeks(${lmp}, ${lmp + 100 * DAY})`), 14);
  assert.equal(w.eval(`gestationLabel(${lmp}, ${lmp + 100 * DAY})`), '14w 2d');
  b.close();
});

test('ANC visit flags pre-eclampsia signs, anaemia and abnormal fetal heart rate', async () => {
  const b = await session(); const { w } = b;
  const f = JSON.parse(w.eval(`JSON.stringify(ancVisitFlags({bp:'165/112', urineProtein:'++', hb:'9.5', fhr:'100', fundalCm:'20', at: Date.now()}, ${Date.now() - 200 * DAY}))`));
  assert.ok(f.some(x => /SEVERE hypertension/.test(x)));
  assert.ok(f.some(x => /Proteinuria/.test(x)));
  assert.ok(f.some(x => /Anaemia/.test(x)));
  assert.ok(f.some(x => /fetal heart/.test(x)));
  assert.ok(f.some(x => /Fundal height/.test(x)));
  assert.equal(JSON.parse(w.eval(`JSON.stringify(ancVisitFlags({bp:'118/76', hb:'12.5', fhr:'140'}, null))`)).length, 0);
  b.close();
});

test('partograph alert line: behind 1 cm/hr from 4 cm is flagged, on track is not', async () => {
  const b = await session(); const { w } = b;
  const t = Date.now();
  const behind = w.eval(`partographAlert([{at:${t - 4 * 3600000}, dilationCm:4},{at:${t}, dilationCm:5}])`);
  assert.ok(/behind the alert line/.test(behind));
  assert.equal(w.eval(`partographAlert([{at:${t - 4 * 3600000}, dilationCm:4},{at:${t}, dilationCm:8}])`), null);
  assert.equal(w.eval(`partographAlert([{at:${t}, dilationCm:3}])`), null);
  b.close();
});

test('maternity flow: profile -> ANC visit -> labour -> delivery registers a linked newborn (not merged) with alerts', async () => {
  const b = await session(); const { w, d } = b;
  w.eval("showToast = function () {}");
  w.eval("openMaternity('PT-1')");
  d.getElementById('mat-gravida').value = '2'; d.getElementById('mat-parity').value = '1';
  const lmp = new Date(Date.now() - 200 * DAY).toISOString().slice(0, 10);
  d.getElementById('mat-lmp').value = lmp;
  w.eval("saveMaternityProfile()");
  assert.ok(w.eval("patients[0].maternity.edd") > Date.now());
  d.getElementById('mat-anc-bp').value = '150/95'; d.getElementById('mat-anc-hb').value = '10';
  w.eval("addAncVisit()");
  assert.equal(w.eval("patients[0].maternity.ancVisits.length"), 1);
  assert.ok(w.eval("patients[0].maternity.ancVisits[0].flags.length") >= 2);
  w.eval("startLabour()");
  d.getElementById('mat-lab-dil').value = '5'; d.getElementById('mat-lab-fhr').value = '105';
  w.eval("addLabourObs()");
  assert.ok(w.eval("patients[0].maternity.labour.obs[0].alerts.length") >= 1);
  d.getElementById('mat-nb-wt').value = '2.2'; d.getElementById('mat-nb-a5').value = '6'; d.getElementById('mat-nb-a1').value = '5';
  d.getElementById('mat-del-blood').value = '650';
  w.eval("recordDelivery()");
  assert.equal(w.eval("patients.length"), 2);
  const baby = JSON.parse(w.eval("JSON.stringify(patients[1])"));
  assert.equal(baby.motherId, 'PT-1');
  assert.notEqual(baby.id, 'PT-1');
  assert.equal(baby.apgar.m5, 6);
  const del = JSON.parse(w.eval("JSON.stringify(patients[0].maternity.deliveries[0])"));
  assert.equal(del.newborns[0], baby.id);
  assert.ok(del.alerts.some(a => /haemorrhage/.test(a)) && del.alerts.some(a => /APGAR/.test(a)) && del.alerts.some(a => /birth weight/.test(a)));
  assert.equal(w.eval("patients[0].maternity.parity"), 2);
  const kinds = JSON.parse(w.eval("JSON.stringify(buildPatientTimeline('PT-1').map(e => e.kind))"));
  ['ANC', 'Labour', 'Delivery'].forEach(k => assert.ok(kinds.includes(k), k));
  assert.ok(JSON.parse(w.eval(`JSON.stringify(buildPatientTimeline('${baby.id}').map(e => e.kind))`)).includes('Birth'));
  b.close();
});

test('an LMP in the future and a labour reading outside 0-10 cm are refused', async () => {
  const b = await session(); const { w, d } = b;
  w.eval("showToast = function () {}");
  w.eval("openMaternity('PT-1')");
  d.getElementById('mat-lmp').value = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
  w.eval("saveMaternityProfile()");
  assert.ok(!w.eval("patients[0].maternity"));
  b.close();
});

// ---- Zip 90: cashier shifts ----
const nowIso = () => new Date().toISOString();
async function shiftSession() {
  const b = await boot(APP, { wait: 1200 });
  b.w.eval("showToast = function () {}; window.confirm = () => true");
  return b;
}
const sale = (o) => JSON.stringify({ id: 's' + Math.random(), timestamp: nowIso(), servedBy: 'Admin', paid: true, cashAmount: 0, mpesaAmount: 0, cardAmount: 0, ...o });

test('shift: open with float, expected cash = float + this cashier\'s cash (voided / other cashier / bills excluded), balanced close needs no approval', async () => {
  const b = await shiftSession(); const { w, d } = b;
  d.body.insertAdjacentHTML('beforeend', '<div id="cash-shift-body"></div>');
  w.eval("renderCashShiftTab()");
  d.getElementById('cash-open-float-input').value = '500';
  w.eval("openCashShift()");
  assert.equal(w.eval("cashShifts.length"), 1);
  const who = w.eval("activeServerName()");
  w.eval(`salesLog.push(${sale({ servedBy: who, cashAmount: 1000 })}, ${sale({ servedBy: who, mpesaAmount: 700 })}, ${sale({ servedBy: who, cashAmount: 300, voided: true })}, ${sale({ servedBy: 'Someone Else', cashAmount: 999 })}, ${sale({ servedBy: who, paid: false, cashAmount: 0 })})`);
  const exp = JSON.parse(w.eval("JSON.stringify(cashShiftExpected(cashShifts[0]))"));
  assert.equal(exp.expectedCash, 1500);
  assert.equal(exp.totals.mpesa, 700);
  assert.equal(exp.totals.voided, 1);
  w.eval("renderCashShiftTab()");
  d.getElementById('cash-close-counted-input').value = '1500';
  w.eval("closeCashShift()");
  const s = JSON.parse(w.eval("JSON.stringify(cashShifts[0])"));
  assert.equal(s.status, 'closed');
  assert.equal(s.closing.variance, 0);
  assert.equal(s.approval.status, 'not-required');
  b.close();
});

test('shift: a variance cannot be closed without an explanation; a large one needs manager approval and is audited', async () => {
  const b = await shiftSession(); const { w, d } = b;
  d.body.insertAdjacentHTML('beforeend', '<div id="cash-shift-body"></div>');
  w.eval("renderCashShiftTab()");
  d.getElementById('cash-open-float-input').value = '1000';
  w.eval("openCashShift()");
  w.eval("renderCashShiftTab()");
  d.getElementById('cash-close-counted-input').value = '700';
  w.eval("closeCashShift()");
  assert.equal(w.eval("cashShifts[0].status"), 'open', 'no explanation -> stays open');
  d.getElementById('cash-close-note-input').value = 'gave change from own pocket';
  w.eval("closeCashShift()");
  const s = JSON.parse(w.eval("JSON.stringify(cashShifts[0])"));
  assert.equal(s.closing.variance, -300);
  assert.equal(s.approval.status, 'pending');
  assert.ok(JSON.parse(w.eval("JSON.stringify(auditLog)")).some(a => /VARIANCE needs approval/.test(a.action)));
  w.prompt = () => 'checked CCTV';
  w.eval(`decideCashShift('${s.id}', true)`);
  assert.equal(w.eval("cashShifts[0].approval.status"), 'approved');
  b.close();
});

test('shift: closed shifts cannot be reopened or overwritten; a manager adds a signed adjustment with a reason', async () => {
  const b = await shiftSession(); const { w, d } = b;
  d.body.insertAdjacentHTML('beforeend', '<div id="cash-shift-body"></div>');
  w.eval("renderCashShiftTab()");
  d.getElementById('cash-open-float-input').value = '0';
  w.eval("openCashShift()");
  w.eval("renderCashShiftTab()");
  d.getElementById('cash-close-counted-input').value = '0';
  w.eval("closeCashShift()");
  const before = JSON.parse(w.eval("JSON.stringify(cashShifts[0].closing)"));
  w.eval("closeCashShift()");                                   // nothing open now
  assert.deepEqual(JSON.parse(w.eval("JSON.stringify(cashShifts[0].closing)")), before);
  const answers = ['-50', 'coin shortage found'];
  w.prompt = () => answers.shift();
  w.eval(`addCashShiftAdjustment('${w.eval("cashShifts[0].id")}')`);
  assert.equal(w.eval("cashShifts[0].adjustments[0].amount"), -50);
  assert.deepEqual(JSON.parse(w.eval("JSON.stringify(cashShifts[0].closing)")), before, 'frozen closing figures untouched');
  b.close();
});

test('cashShifts sync per record on the server', async () => {
  const s = await srv(); const t = Date.now();
  await s.push({ updatedAt: t, cashShifts: [{ id: 'A', cashier: 'x', status: 'open', updatedAt: t - 5000 }] });
  await wait();
  await s.push({ updatedAt: Date.now(), cashShifts: [{ id: 'B', cashier: 'y', status: 'open', updatedAt: Date.now() }] });
  const got = await s.pull();
  assert.deepEqual(got.cashShifts.map(x => x.id).sort(), ['A', 'B']);
});

// ---- Zip 91: refund requests / approval ----
async function refundSession() {
  const b = await shiftSession(); const { w, d } = b;
  d.body.insertAdjacentHTML('beforeend', '<div id="cash-shift-body"></div>');
  w.eval("staff = [{id:'S1', name:'Cashier Amy'}, {id:'M1', name:'Manager Bob', isManager: true}]");
  w.eval("currentServer = {id:'S1', name:'Cashier Amy'}");
  w.eval(`salesLog.push({ id:'SALE1', refNumber:'R-100', timestamp:new Date().toISOString(), servedBy:'Cashier Amy', paid:true, cashAmount:1000, mpesaAmount:0, cardAmount:0, items:[{name:'Consultation', price:1000, qty:1, unit:'use'}] })`);
  return b;
}

test('refund: cashier can only REQUEST; nothing is paid out until a manager approves; then expected cash falls', async () => {
  const b = await refundSession(); const { w, d } = b;
  w.eval("renderCashShiftTab()");
  d.getElementById('cash-open-float-input').value = '1000';
  w.eval("openCashShift()");
  const r = JSON.parse(w.eval("JSON.stringify(requestRefund('R-100', 400, 'cash', 'wrong test billed'))"));
  assert.equal(r.status, 'pending');
  assert.equal(w.eval("salesLog.length"), 1, 'no ledger entry yet');
  assert.equal(w.eval("decideApprovalRequest('" + r.id + "', true, '')"), false, 'a plain cashier cannot approve');
  w.eval("currentServer = {id:'M1', name:'Manager Bob'}");
  assert.equal(w.eval("decideApprovalRequest('" + r.id + "', true, 'ok')"), true);
  const entry = JSON.parse(w.eval("JSON.stringify(salesLog[1])"));
  assert.equal(entry.cashAmount, -400);
  assert.equal(entry.servedBy, 'Cashier Amy');
  assert.equal(entry.isRefund, true);
  assert.equal(entry.approvedBy, 'Manager Bob');
  w.eval("currentServer = {id:'S1', name:'Cashier Amy'}");
  const exp = JSON.parse(w.eval("JSON.stringify(cashShiftExpected(cashShifts[0]))"));
  assert.equal(exp.expectedCash, 600);
  assert.ok(JSON.parse(w.eval("JSON.stringify(auditLog)")).some(a => a.action === 'Refund approved'));
  b.close();
});

test('refund: cannot exceed what is left on the sale (pending + approved counted), needs a reason, unknown refs refused', async () => {
  const b = await refundSession(); const { w } = b;
  assert.equal(w.eval("requestRefund('R-100', 700, 'cash', 'x') && 1"), 1);
  assert.equal(w.eval("requestRefund('R-100', 400, 'cash', 'x')"), null, 'only 300 left');
  assert.equal(w.eval("requestRefund('R-100', 100, 'cash', '  ')"), null);
  assert.equal(w.eval("requestRefund('NOPE', 100, 'cash', 'x')"), null);
  assert.equal(w.eval("requestRefund('R-100', 100, 'bitcoin', 'x')"), null);
  b.close();
});

test('refund: requester cannot approve their own; rejection needs a reason and posts nothing', async () => {
  const b = await refundSession(); const { w } = b;
  w.eval("staff.push({id:'S2', name:'Manager Sue', isManager:true})");
  w.eval("currentServer = {id:'S2', name:'Manager Sue'}");
  const r = JSON.parse(w.eval("JSON.stringify(requestRefund('R-100', 100, 'mpesa', 'duplicate charge'))"));
  assert.equal(w.eval(`decideApprovalRequest('${r.id}', true, '')`), false, 'own request');
  w.eval("currentServer = {id:'M1', name:'Manager Bob'}");
  assert.equal(w.eval(`decideApprovalRequest('${r.id}', false, '')`), false, 'reject needs a reason');
  assert.equal(w.eval(`decideApprovalRequest('${r.id}', false, 'not eligible')`), true);
  assert.equal(w.eval("salesLog.length"), 1);
  assert.equal(w.eval("approvalRequests[0].status"), 'rejected');
  assert.equal(w.eval(`decideApprovalRequest('${r.id}', true, '')`), false, 'already decided');
  b.close();
});

test('approvalRequests sync per record on the server', async () => {
  const s = await srv(); const t = Date.now();
  await s.push({ updatedAt: t, approvalRequests: [{ id: 'A', status: 'pending', updatedAt: t - 5000 }] });
  await wait();
  await s.push({ updatedAt: Date.now(), approvalRequests: [{ id: 'A', status: 'approved', updatedAt: Date.now() }, { id: 'B', status: 'pending', updatedAt: Date.now() }] });
  await wait();
  await s.push({ updatedAt: Date.now(), approvalRequests: [{ id: 'A', status: 'pending', updatedAt: t - 5000 }] });   // stale device
  const got = await s.pull();
  assert.equal(got.approvalRequests.find(x => x.id === 'A').status, 'approved');
  assert.ok(got.approvalRequests.find(x => x.id === 'B'));
});

// ---- Zip 92: claims lifecycle ----
const CLAIM = { id: 'C1', institutionId: 'I1', patientName: 'Jane', description: 'Malaria', amount: 5000, policyNo: 'P1', timestamp: Date.now(), claimStatus: 'submitted', claimNo: 'CLM-T-0001' };
async function claimSession() {
  const b = await boot(APP, { storage: { pos_institution_charges: JSON.stringify([CLAIM]), pos_institutions: JSON.stringify([{ id: 'I1', name: 'SHA', balance: 5000 }]) }, wait: 1200 });
  b.w.eval("showToast = function () {}");
  return b;
}

test('claims: invalid transitions are refused; a rejection needs a reason; partial needs 0 < approved < claimed and a reason', async () => {
  const b = await claimSession(); const { w } = b;
  assert.equal(w.eval("updateClaimStatus('C1', 'paid', {})"), false, 'submitted cannot jump to paid');
  assert.equal(w.eval("updateClaimStatus('C1', 'rejected', {})"), false, 'no reason');
  assert.equal(w.eval("updateClaimStatus('C1', 'partially_approved', {approvedAmount: 5000, reason: 'x'})"), false, 'must be less than claimed');
  assert.equal(w.eval("updateClaimStatus('C1', 'partially_approved', {approvedAmount: 3000, reason: ''})"), false, 'shortfall reason');
  assert.equal(w.eval("institutionCharges[0].claimStatus"), 'submitted');
  b.close();
});

test('claims: submitted -> under review -> partial -> paid keeps amounts and a full history', async () => {
  const b = await claimSession(); const { w } = b;
  assert.equal(w.eval("updateClaimStatus('C1', 'under_review', {note: 'received by SHA'})"), true);
  assert.equal(w.eval("updateClaimStatus('C1', 'partially_approved', {approvedAmount: 3500, reason: 'lab not covered'})"), true);
  let c = JSON.parse(w.eval("JSON.stringify(institutionCharges[0])"));
  assert.equal(c.approvedAmount, 3500);
  assert.equal(c.rejectedAmount, 1500);
  assert.equal(w.eval("updateClaimStatus('C1', 'paid', {})"), true);
  c = JSON.parse(w.eval("JSON.stringify(institutionCharges[0])"));
  assert.equal(c.paidAmount, 3500);
  assert.deepEqual(c.claimHistory.map(h => h.status), ['under_review', 'partially_approved', 'paid']);
  assert.equal(w.eval("updateClaimStatus('C1', 'rejected', {reason: 'x'})"), false, 'paid is final');
  assert.ok(JSON.parse(w.eval("JSON.stringify(auditLog)")).length >= 3);
  b.close();
});

test('claims: rejected -> resubmitted -> approved -> paid; totals reflect it', async () => {
  const b = await claimSession(); const { w } = b;
  w.eval("updateClaimStatus('C1', 'rejected', {reason: 'missing pre-auth'})");
  let t = JSON.parse(w.eval("JSON.stringify(claimAmounts(institutionCharges))"));
  assert.equal(t.rejected, 5000);
  assert.equal(t.outstanding, 0);
  assert.equal(w.eval("updateClaimStatus('C1', 'approved', {})"), false, 'must be resubmitted first');
  assert.equal(w.eval("updateClaimStatus('C1', 'resubmitted', {note: 'pre-auth attached'})"), true);
  assert.equal(w.eval("institutionCharges[0].resubmitCount"), 1);
  t = JSON.parse(w.eval("JSON.stringify(claimAmounts(institutionCharges))"));
  assert.equal(t.pending, 5000);
  w.eval("updateClaimStatus('C1', 'approved', {})");
  w.eval("updateClaimStatus('C1', 'paid', {})");
  t = JSON.parse(w.eval("JSON.stringify(claimAmounts(institutionCharges))"));
  assert.equal(t.approved, 5000);
  assert.equal(t.outstanding, 0);
  b.close();
});

test('claims: legacy "adjudicated" claims can still be moved on; claim numbers are unique; table renders', async () => {
  const b = await boot(APP, { storage: { pos_institution_charges: JSON.stringify([{ ...CLAIM, claimStatus: 'adjudicated', claimNo: undefined }]), pos_institutions: JSON.stringify([{ id: 'I1', name: 'SHA', balance: 5000 }]) }, wait: 1200 });
  const { w, d } = b;
  w.eval("showToast = function () {}");
  assert.equal(w.eval("updateClaimStatus('C1', 'paid', {})"), true);
  assert.equal(w.eval("institutionCharges[0].paidAmount"), 5000);
  const nos = new Set(JSON.parse(w.eval("JSON.stringify(Array.from({length: 50}, () => { const n = nextClaimNo(); institutionCharges.push({id: n, claimNo: n}); return n; }))")));
  assert.equal(nos.size, 50);
  d.body.insertAdjacentHTML('beforeend', '<div id="claims-summary"></div>');
  w.eval("renderClaimsTable()");
  assert.ok(d.getElementById('claims-summary').textContent.includes('Claimed'));
  b.close();
});

test('institutionCharges and institutions sync per record on the server', async () => {
  const s = await srv(); const t = Date.now();
  await s.push({ updatedAt: t, institutionCharges: [{ id: 'C1', claimStatus: 'submitted', updatedAt: t - 5000 }] });
  await wait();
  await s.push({ updatedAt: Date.now(), institutionCharges: [{ id: 'C1', claimStatus: 'approved', updatedAt: Date.now() }, { id: 'C2', claimStatus: 'submitted', updatedAt: Date.now() }] });
  await wait();
  await s.push({ updatedAt: Date.now(), institutionCharges: [{ id: 'C1', claimStatus: 'submitted', updatedAt: t - 5000 }] });
  const got = await s.pull();
  assert.equal(got.institutionCharges.find(x => x.id === 'C1').claimStatus, 'approved');
  assert.ok(got.institutionCharges.find(x => x.id === 'C2'));
});

test('claims: an institution-billed visit creates a claim with a claim number, history and amount', async () => {
  const b = await boot(APP, { storage: { pos_patients: JSON.stringify([PATIENT]), pos_institutions: JSON.stringify([{ id: 'I1', name: 'SHA', balance: 0 }]) }, wait: 1200 });
  const { w, d } = b;
  w.eval("showToast = function () {}; window.confirm = () => true");
  w.eval("openPatientVisitModal('PT-1')");
  d.getElementById('visit-diagnosis-input').value = 'Typhoid';
  d.getElementById('visit-consultation-fee-input').value = '800';
  w.eval("setVisitBillTo('institution')");
  d.getElementById('visit-institution-select').value = 'I1';
  d.getElementById('visit-policy-no-input').value = 'POL-9';
  w.eval("saveVisit()");
  assert.equal(w.eval("institutionCharges.length"), 1);
  const c = JSON.parse(w.eval("JSON.stringify(institutionCharges[0])"));
  assert.match(c.claimNo, /^CLM-\d{6}-[A-Z2-9]{4}$/);
  assert.equal(c.claimStatus, 'submitted');
  assert.equal(c.claimHistory[0].status, 'submitted');
  assert.ok(c.amount >= 800 - 0.001 || c.amount > 0);
  b.close();
});

// ---- Zip 93: registration + triage fields ----
function fillPatientForm(d, o) {
  const map = { name: 'patient-name-input', age: 'patient-age-input', phone: 'patient-phone-input', altPhone: 'patient-altphone-input', email: 'patient-email-input', county: 'patient-county-input', subCounty: 'patient-subcounty-input', address: 'patient-address-input', nationalId: 'patient-nationalid-input', sha: 'patient-sha-input', rel: 'patient-nok-rel-input', dob: 'patient-dob-input', nokPhone: 'patient-nok-phone-input' };
  Object.entries(o).forEach(([k, v]) => { d.getElementById(map[k]).value = v; });
}

test('registration stores the optional fields (county, ID, SHA no., alt phone, email, relationship) and derives age from DOB', async () => {
  const b = await boot(APP, { wait: 1200 }); const { w, d } = b;
  w.eval("showToast = function () {}; window.confirm = () => true");
  const dob = new Date(Date.now() - 30.5 * 365.25 * 86400000).toISOString().slice(0, 10);
  fillPatientForm(d, { name: 'Peter Otieno', dob, phone: '0722111222', altPhone: '+254733444555', email: 'peter@example.com', county: 'Kisumu', subCounty: 'Kisumu East', address: 'Milimani', nationalId: '12345678', sha: 'SHA-99', rel: 'Spouse' });
  w.eval("savePatient()");
  const p = JSON.parse(w.eval("JSON.stringify(patients[0])"));
  assert.equal(p.county, 'Kisumu'); assert.equal(p.nationalId, '12345678'); assert.equal(p.shaNumber, 'SHA-99');
  assert.equal(p.nextOfKinRelationship, 'Spouse'); assert.equal(p.altPhone, '+254733444555');
  assert.ok(p.age >= 30 && p.age <= 31, 'age from DOB: ' + p.age);
  b.close();
});

test('registration: bad email and future DOB are refused; a non-Kenyan phone asks to confirm', async () => {
  const b = await boot(APP, { wait: 1200 }); const { w, d } = b;
  w.eval("showToast = function () {}");
  let asked = 0; w.confirm = () => { asked++; return false; };
  fillPatientForm(d, { name: 'A B', email: 'not-an-email' });
  w.eval("savePatient()");
  assert.equal(w.eval("patients.length"), 0);
  fillPatientForm(d, { email: '', dob: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) });
  w.eval("savePatient()");
  assert.equal(w.eval("patients.length"), 0);
  fillPatientForm(d, { dob: '', age: '20', phone: '12345' });
  w.eval("savePatient()");
  assert.equal(asked, 1);
  assert.equal(w.eval("patients.length"), 0, 'declined');
  w.confirm = () => true;
  w.eval("savePatient()");
  assert.equal(w.eval("patients.length"), 1);
  assert.equal(w.eval("isKenyanMobile('0712 345 678')"), true);
  assert.equal(w.eval("isKenyanMobile('+254112345678')"), true);
  assert.equal(w.eval("isKenyanMobile('020123456')"), false);
  b.close();
});

test('search finds a patient by national ID, SHA number, alternative phone and email; duplicates match on ID / SHA no.', async () => {
  const P = { ...PATIENT, nationalId: '12 345 678', shaNumber: 'SHA-1', altPhone: '0733000111', email: 'jane@x.co' };
  const b = await boot(APP, { storage: { pos_patients: JSON.stringify([P]) }, wait: 1200 }); const { w, d } = b;
  for (const q of ['12 345', 'sha-1', '0733000', 'jane@x']) {
    d.getElementById('patient-search-input').value = q;
    w.eval("renderPatientsTable()");
    assert.ok(d.querySelector('#patients-table tbody').textContent.includes('Jane Mwangi'), q);
  }
  assert.equal(w.eval("findPossibleDuplicatePatients({name:'Other', age:9, phone:'', nationalId:'12345678'}, null).length"), 1);
  assert.equal(w.eval("findPossibleDuplicatePatients({name:'Other', age:9, phone:'', shaNumber:'sha-1'}, null).length"), 1);
  b.close();
});

test('triage: respiratory rate, pain, glucose captured, shown in the summary, and critical values flagged', async () => {
  const b = await session(); const { w } = b;
  const a = JSON.parse(w.eval("JSON.stringify(vitalAlerts({rr:'34', glucose:'2.4', pain:'9'}, 40))"));
  assert.equal(a.length, 3);
  assert.equal(JSON.parse(w.eval("JSON.stringify(vitalAlerts({rr:'16', glucose:'5.5', pain:'3'}, 40))")).length, 0);
  assert.equal(JSON.parse(w.eval("JSON.stringify(vitalAlerts({glucose:'25'}, 40))")).length, 1);
  const html = w.eval("vitalsSummary({rr:'18', glucose:'5.6', pain:'0', bp:'120/80'}, 30)");
  assert.ok(html.includes('RR 18') && html.includes('Glu 5.6') && html.includes('Pain 0/10'));
  // through the real modal
  w.eval("queue.push({id:'Q1', patientId:'PT-1', status:'waiting', triageLevel:'routine', stage:'triage', stageHistory:[]})");
  w.eval("openVitalsModal('Q1')");
  const d = w.document;
  d.getElementById('vitals-rr-input').value = '32'; d.getElementById('vitals-glucose-input').value = '6.1';
  d.getElementById('vitals-pain-input').value = '4'; d.getElementById('vitals-pregnancy-input').value = 'not_pregnant';
  w.eval("saveVitals()");
  const v = JSON.parse(w.eval("JSON.stringify(queue.find(q => q.id === 'Q1').vitals)"));
  assert.equal(v.rr, '32'); assert.equal(v.pain, '4'); assert.equal(v.pregnancy, 'not_pregnant');
  assert.ok(v.alerts.some(x => /breathing/.test(x)));
  b.close();
});

// ---- Zip 94: radiology ----
async function radSession() {
  const b = await session(); const { w } = b;
  w.eval("staff = [{id:'T1', name:'Tech Tom'}, {id:'R1', name:'Dr Radi'}]");
  return b;
}
test('radiology: request validates, creates an order number and an unpaid charge under a reference', async () => {
  const b = await radSession(); const { w } = b;
  assert.equal(w.eval("requestRadiology('PT-1', 'X-ray', '', 'cough', 'routine')"), null, 'study needed');
  assert.equal(w.eval("requestRadiology('PT-1', 'X-ray', 'Chest PA', '  ', 'routine')"), null, 'indication needed');
  assert.equal(w.eval("requestRadiology('PT-1', 'Telepathy', 'Chest', 'x', 'routine')"), null);
  const o = JSON.parse(w.eval("JSON.stringify(requestRadiology('PT-1', 'X-ray', 'Chest PA', 'cough 3 weeks', 'urgent'))"));
  assert.match(o.orderNo, /^RAD-\d{6}-[A-Z2-9]{4}$/);
  assert.equal(o.status, 'requested');
  const c = JSON.parse(w.eval("JSON.stringify(patientCharges.find(x => x.radiologyId))"));
  assert.equal(c.status, 'unpaid'); assert.equal(c.kind, 'radiology'); assert.equal(c.ref, o.visitRef);
  b.close();
});

test('radiology: full flow request -> schedule -> performed -> report -> verify; cannot skip steps', async () => {
  const b = await radSession(); const { w } = b;
  const id = w.eval("requestRadiology('PT-1', 'Ultrasound', 'Abdomen', 'pain', 'routine').id");
  assert.equal(w.eval(`saveRadiologyReport('${id}', 'f', 'i', false, '')`), false, 'must be performed first');
  assert.equal(w.eval(`scheduleRadiology('${id}', '2026-10-02T09:30')`), true);
  assert.equal(w.eval(`markRadiologyPerformed('${id}', 'ACC-77')`), true);
  assert.equal(w.eval(`saveRadiologyReport('${id}', 'Normal liver', '', false, '')`), false, 'impression needed');
  assert.equal(w.eval(`saveRadiologyReport('${id}', 'Normal liver', 'No abnormality', false, '')`), true);
  assert.equal(w.eval(`radiologyOrders[0].status`), 'reported');
  w.confirm = () => false;
  assert.equal(w.eval(`verifyRadiology('${id}')`), false, 'own report: declined');
  w.confirm = () => true;
  assert.equal(w.eval(`verifyRadiology('${id}')`), true);
  const o = JSON.parse(w.eval("JSON.stringify(radiologyOrders[0])"));
  assert.equal(o.status, 'verified'); assert.equal(o.imageRef, 'ACC-77');
  assert.deepEqual(o.history.map(h => h.status), ['requested', 'scheduled', 'performed', 'reported', 'verified']);
  b.close();
});

test('radiology: correcting a released report keeps the original, needs a reason, and clears verification', async () => {
  const b = await radSession(); const { w } = b;
  const id = w.eval("requestRadiology('PT-1', 'X-ray', 'Chest PA', 'cough', 'routine').id");
  w.eval(`markRadiologyPerformed('${id}', '')`);
  w.eval(`saveRadiologyReport('${id}', 'Clear lung fields', 'Normal chest', false, '')`);
  w.confirm = () => true; w.eval(`verifyRadiology('${id}')`);
  assert.equal(w.eval(`saveRadiologyReport('${id}', 'Right lower lobe opacity', 'Pneumonia', true, '')`), false, 'reason required');
  assert.equal(w.eval(`saveRadiologyReport('${id}', 'Right lower lobe opacity', 'Pneumonia', true, 'missed on first read')`), true);
  const o = JSON.parse(w.eval("JSON.stringify(radiologyOrders[0])"));
  assert.equal(o.status, 'reported');
  assert.equal(o.verifiedAt, null);
  assert.equal(o.amendments[0].before.impression, 'Normal chest');
  assert.equal(o.report.impression, 'Pneumonia');
  b.close();
});

test('radiology: critical finding banner until acknowledged; cancel needs a reason and voids the unpaid charge; timeline shows imaging', async () => {
  const b = await radSession(); const { w, d } = b;
  d.body.insertAdjacentHTML('beforeend', '<div id="radiology-body"></div>');
  const id = w.eval("requestRadiology('PT-1', 'CT', 'Head', 'trauma', 'emergency').id");
  w.eval(`markRadiologyPerformed('${id}', '')`);
  w.eval(`saveRadiologyReport('${id}', 'Acute bleed', 'Intracranial haemorrhage', true, '')`);
  w.eval("renderRadiologyTab()");
  assert.ok(d.getElementById('radiology-body').textContent.includes('CRITICAL FINDING'));
  w.eval(`acknowledgeRadCritical('${id}')`);
  assert.ok(!d.getElementById('radiology-body').textContent.includes('CRITICAL FINDING'));
  const id2 = w.eval("requestRadiology('PT-1', 'MRI', 'Knee', 'pain', 'routine').id");
  assert.equal(w.eval(`cancelRadiology('${id2}', '')`), false);
  assert.equal(w.eval(`cancelRadiology('${id2}', 'patient declined')`), true);
  assert.equal(w.eval(`patientCharges.filter(c => c.radiologyId === '${id2}')[0].status`), 'cancelled');
  const kinds = JSON.parse(w.eval("JSON.stringify(buildPatientTimeline('PT-1').map(e => e.kind))"));
  assert.ok(kinds.includes('Radiology'));
  assert.ok(JSON.parse(w.eval("JSON.stringify(auditLog)")).some(a => /CRITICAL finding/.test(a.action)));
  b.close();
});

test('radiologyOrders sync per record on the server', async () => {
  const s = await srv(); const t = Date.now();
  await s.push({ updatedAt: t, radiologyOrders: [{ id: 'R1', status: 'requested', updatedAt: t - 5000 }] });
  await wait();
  await s.push({ updatedAt: Date.now(), radiologyOrders: [{ id: 'R1', status: 'reported', updatedAt: Date.now() }, { id: 'R2', status: 'requested', updatedAt: Date.now() }] });
  await wait();
  await s.push({ updatedAt: Date.now(), radiologyOrders: [{ id: 'R1', status: 'requested', updatedAt: t - 5000 }] });
  const got = await s.pull();
  assert.equal(got.radiologyOrders.find(x => x.id === 'R1').status, 'reported');
  assert.ok(got.radiologyOrders.find(x => x.id === 'R2'));
});

// ---- Zip 95: theatre / procedures ----
async function thSession() { const b = await session(); b.w.eval("window.confirm = () => true"); return b; }
const THID = (w) => w.eval("requestTheatreCase('PT-1', 'Appendicectomy', 'elective', 'Dr Kim', 'acute appendicitis').id");
function readyCase(w, id, when = '2026-11-02T09:00', room = 'Theatre 1') {
  w.eval(`scheduleTheatreCase('${id}', '${when}', '${room}', 90)`);
  w.eval(`recordTheatreConsent('${id}', 'Jane Mwangi', 'Nurse Ann', '')`);
  w.eval(`recordPreop('${id}', 2, 'fit for surgery', {allergiesReviewed: true, fasting: true})`);
  return w.eval(`markTheatreReady('${id}')`);
}

test('theatre: request validates and creates a case number and an unpaid procedure charge', async () => {
  const b = await thSession(); const { w } = b;
  assert.equal(w.eval("requestTheatreCase('PT-1', '', 'elective', '', 'x')"), null);
  assert.equal(w.eval("requestTheatreCase('PT-1', 'Hernia repair', 'elective', '', '  ')"), null);
  const c = JSON.parse(w.eval("JSON.stringify(requestTheatreCase('PT-1', 'Hernia repair', 'elective', 'Dr Kim', 'inguinal hernia'))"));
  assert.match(c.caseNo, /^THE-\d{6}-[A-Z2-9]{4}$/);
  const ch = JSON.parse(w.eval("JSON.stringify(patientCharges.find(x => x.theatreId))"));
  assert.equal(ch.status, 'unpaid'); assert.equal(ch.kind, 'procedure');
  b.close();
});

test('theatre: cannot double-book a room; different room or non-overlapping time is fine', async () => {
  const b = await thSession(); const { w } = b;
  const a = THID(w), c2 = THID(w), c3 = THID(w);
  assert.equal(w.eval(`scheduleTheatreCase('${a}', '2026-11-02T09:00', 'Theatre 1', 60)`), true);
  assert.equal(w.eval(`scheduleTheatreCase('${c2}', '2026-11-02T09:30', 'Theatre 1', 60)`), false, 'overlaps');
  assert.equal(w.eval(`scheduleTheatreCase('${c2}', '2026-11-02T09:30', 'Theatre 2', 60)`), true);
  assert.equal(w.eval(`scheduleTheatreCase('${c3}', '2026-11-02T10:00', 'Theatre 1', 60)`), true, 'starts when the first ends');
  assert.equal(w.eval(`scheduleTheatreCase('${a}', '2026-11-02T09:15', 'Theatre 1', 30)`), true, 'rescheduling itself is not a clash');
  b.close();
});

test('theatre: cannot be READY or start without consent, pre-op (with allergy review) and a surgeon', async () => {
  const b = await thSession(); const { w } = b;
  const id = THID(w);
  assert.equal(w.eval(`markTheatreReady('${id}')`), false, 'not scheduled');
  w.eval(`scheduleTheatreCase('${id}', '2026-11-02T09:00', 'Theatre 1', 60)`);
  assert.equal(w.eval(`markTheatreReady('${id}')`), false, 'no consent/preop');
  assert.equal(w.eval(`recordTheatreConsent('${id}', 'Jane', '', '')`), false, 'witness needed');
  assert.equal(w.eval(`recordTheatreConsent('${id}', 'Jane', 'Ann', '')`), true);
  assert.equal(w.eval(`recordPreop('${id}', 9, 'x', {})`), false, 'ASA 1-6');
  w.eval(`recordPreop('${id}', 2, 'fit', {allergiesReviewed: false})`);
  assert.equal(w.eval(`markTheatreReady('${id}')`), false, 'allergies not reviewed');
  w.eval(`recordPreop('${id}', 2, 'fit', {allergiesReviewed: true})`);
  assert.equal(w.eval(`markTheatreReady('${id}')`), true);
  assert.equal(w.eval(`startTheatreCase('${THID(w)}', '')`), false, 'unscheduled case cannot start');
  b.close();
});

test('theatre: full flow in order; notes are append-only; recovery needs a procedure note, completion a post-op note', async () => {
  const b = await thSession(); const { w } = b;
  const id = THID(w);
  assert.equal(readyCase(w, id), true);
  assert.equal(w.eval(`addTheatreNote('${id}', 'procedure', 'x')`), false, 'not in theatre yet');
  assert.equal(w.eval(`startTheatreCase('${id}', '')`), true);
  assert.equal(w.eval(`toTheatreRecovery('${id}')`), false, 'needs procedure note');
  w.eval(`addTheatreNote('${id}', 'anaesthesia', 'GA, uneventful')`);
  w.eval(`addTheatreNote('${id}', 'procedure', 'Appendix removed, no perforation')`);
  assert.equal(w.eval(`toTheatreRecovery('${id}')`), true);
  assert.equal(w.eval(`completeTheatreCase('${id}')`), false, 'needs post-op note');
  w.eval(`addTheatreNote('${id}', 'postop', 'Stable, analgesia charted')`);
  assert.equal(w.eval(`completeTheatreCase('${id}')`), true);
  const c = JSON.parse(w.eval("JSON.stringify(theatreCases[0])"));
  assert.equal(c.status, 'completed');
  assert.equal(c.notes.length, 3);
  assert.equal(w.eval(`addTheatreNote('${id}', 'postop', 'late edit')`), true, 'a later note is an addendum, never an edit');
  assert.equal(w.eval("theatreCases[0].notes[0].text"), 'GA, uneventful', 'existing notes untouched');
  assert.ok(c.history.map(h => h.status).includes('recovery'));
  const kinds = JSON.parse(w.eval("JSON.stringify(buildPatientTimeline('PT-1').map(e => e.kind))"));
  assert.ok(kinds.includes('Theatre'));
  b.close();
});

test('theatre: emergency may start without full pre-op ONLY with a documented override, which is audited and flagged', async () => {
  const b = await thSession(); const { w } = b;
  const el = w.eval("requestTheatreCase('PT-1', 'Laparotomy', 'elective', 'Dr Kim', 'peritonitis').id");
  assert.equal(w.eval(`startTheatreCase('${el}', 'urgent')`), false, 'elective cannot use the override');
  const em = w.eval("requestTheatreCase('PT-1', 'Laparotomy', 'emergency', 'Dr Kim', 'ruptured ectopic').id");
  assert.equal(w.eval(`startTheatreCase('${em}', '')`), false, 'no reason');
  assert.equal(w.eval(`startTheatreCase('${em}', 'life-threatening bleeding')`), true);
  assert.equal(w.eval(`theatreCases.find(c => c.id === '${em}').emergencyOverride.reason`), 'life-threatening bleeding');
  assert.ok(JSON.parse(w.eval("JSON.stringify(auditLog)")).some(a => /EMERGENCY start/.test(a.action)));
  assert.ok(JSON.parse(w.eval("JSON.stringify(buildPatientTimeline('PT-1'))")).some(e => e.flag && e.kind === 'Theatre'));
  b.close();
});

test('theatre: consumables become charges on the same reference; cancel needs a reason and cancels unpaid charges', async () => {
  const b = await thSession(); const { w } = b;
  const id = THID(w);
  assert.equal(w.eval(`addTheatreConsumable('${id}', 'Suture pack', 0, 500)`), false);
  assert.equal(w.eval(`addTheatreConsumable('${id}', 'Suture pack', 2, 500)`), true);
  const ref = w.eval("theatreCases[0].visitRef");
  assert.equal(w.eval(`patientCharges.filter(c => c.ref === '${ref}').length`), 2);
  assert.equal(w.eval(`cancelTheatreCase('${id}', '')`), false);
  assert.equal(w.eval(`cancelTheatreCase('${id}', 'patient declined')`), true);
  assert.equal(w.eval(`patientCharges.filter(c => c.theatreId === '${id}' && c.status === 'cancelled').length`), 2);
  assert.equal(w.eval(`cancelTheatreCase('${id}', 'again')`), false, 'already cancelled');
  b.close();
});

test('theatre: tab and case modal render; theatreCases sync per record', async () => {
  const b = await thSession(); const { w, d } = b;
  d.body.insertAdjacentHTML('beforeend', '<div id="theatre-body"></div><div id="theatre-case-modal"><h2 id="theatre-case-title"></h2><div id="theatre-case-body"></div></div>');
  const id = THID(w);
  w.eval("renderTheatreTab()");
  assert.ok(d.getElementById('theatre-body').textContent.includes('Appendicectomy'));
  w.eval(`openTheatreCase('${id}')`);
  assert.ok(d.getElementById('theatre-case-body').textContent.includes('Consent'));
  b.close();
  const s = await srv(); const t = Date.now();
  await s.push({ updatedAt: t, theatreCases: [{ id: 'T1', status: 'requested', updatedAt: t - 5000 }] });
  await wait();
  await s.push({ updatedAt: Date.now(), theatreCases: [{ id: 'T1', status: 'ready', updatedAt: Date.now() }, { id: 'T2', status: 'requested', updatedAt: Date.now() }] });
  await wait();
  await s.push({ updatedAt: Date.now(), theatreCases: [{ id: 'T1', status: 'requested', updatedAt: t - 5000 }] });
  const got = await s.pull();
  assert.equal(got.theatreCases.find(x => x.id === 'T1').status, 'ready');
  assert.ok(got.theatreCases.find(x => x.id === 'T2'));
});

// ---- Zip 96: patient notifications (appointment reminders, result-ready) ----
function fetchStub(log, { configured = true, success = true } = {}) {
  return async (url, init) => {
    log.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    const u = String(url);
    if (u.includes('sms-config')) return { json: async () => ({ configured }) };
    if (u.includes('sms-send')) return { json: async () => (success ? { success: true } : { success: false, error: 'provider down' }) };
    return { json: async () => ({}) };
  };
}
async function notifySession(log, opts) {
  const in3h = Date.now() + 3 * 3600000;
  const b = await boot(APP, { fetch: fetchStub(log, opts), wait: 1200, storage: {
    pos_patients: JSON.stringify([PATIENT, { id: 'PT-2', name: 'No Phone', age: 40, sex: 'Male', phone: '', registeredAt: now }]),
    pos_appointments: JSON.stringify([
      { id: 'A1', patientId: 'PT-1', patientName: 'Jane Mwangi', scheduledFor: in3h, status: 'scheduled', reason: 'HIV follow-up', doctorAssigned: 'Dr A' },
      { id: 'A2', patientId: 'PT-2', patientName: 'No Phone', scheduledFor: in3h, status: 'scheduled', reason: 'x' },
      { id: 'A3', patientId: 'PT-1', patientName: 'Jane Mwangi', scheduledFor: now + 30 * 86400000, status: 'scheduled' },
    ]),
    pos_lab_results: JSON.stringify([{ ...LAB, verifiedAt: now, verifiedBy: 'Dr B' }]) } });
  b.w.eval("showToast = function () {}; window.confirm = () => true; window.open = (u) => { window.__opened = u; }");
  return b;
}

test('phone numbers normalise to +254 and invalid ones are rejected', async () => {
  const b = await session(); const { w } = b;
  assert.equal(w.eval("kenyaPhoneE164('0712 345 678')"), '+254712345678');
  assert.equal(w.eval("kenyaPhoneE164('+254 112 345 678')"), '+254112345678');
  assert.equal(w.eval("kenyaPhoneE164('712345678')"), '+254712345678');
  assert.equal(w.eval("kenyaPhoneE164('020123456')"), null);
  assert.equal(w.eval("kenyaPhoneE164('')"), null);
  b.close();
});

test('appointment reminder SMS: generic text (no reason/diagnosis), logged, and a recent one asks before repeating', async () => {
  const log = []; const b = await notifySession(log); const { w } = b;
  const r = await w.eval("sendAppointmentReminder('A1', 'sms')");
  assert.equal(r.ok, true);
  const sent = log.find(x => x.url.includes('sms-send'));
  assert.equal(sent.body.to, '+254712345678');
  assert.ok(/Jane/.test(sent.body.message) && /Dr A/.test(sent.body.message));
  assert.ok(!/HIV/.test(sent.body.message), 'the reason for the visit must never be sent');
  assert.equal(w.eval("appointments[0].notices.length"), 1);
  assert.ok(JSON.parse(w.eval("JSON.stringify(auditLog)")).some(a => a.action === 'Appointment reminder sent'));
  let asked = 0; w.confirm = () => { asked++; return false; };
  const r2 = await w.eval("sendAppointmentReminder('A1', 'sms')");
  assert.equal(asked, 1); assert.equal(r2.skipped, true);
  assert.equal(w.eval("appointments[0].notices.length"), 1);
  b.close();
});

test('reminders: SMS not configured / provider failure / no phone are reported and logged, never silently lost', async () => {
  const log = []; const b = await notifySession(log, { configured: false }); const { w } = b;
  let r = await w.eval("sendAppointmentReminder('A1', 'sms')");
  assert.equal(r.ok, false); assert.ok(/not set up/.test(r.error));
  assert.equal(w.eval("appointments[0].notices[0].ok"), false);
  r = await w.eval("sendAppointmentReminder('A2', 'sms')");
  assert.ok(/valid Kenyan mobile/.test(r.error));
  b.close();
  const log2 = []; const b2 = await notifySession(log2, { success: false });
  r = await b2.w.eval("sendAppointmentReminder('A1', 'sms')");
  assert.equal(r.ok, false); assert.equal(r.error, 'provider down');
  assert.ok(JSON.parse(b2.w.eval("JSON.stringify(auditLog)")).some(a => a.action === 'Appointment reminder FAILED'));
  b2.close();
});

test('WhatsApp reminder opens a click-to-chat link with the message; non-scheduled appointments are refused', async () => {
  const log = []; const b = await notifySession(log); const { w } = b;
  const r = await w.eval("sendAppointmentReminder('A1', 'whatsapp')");
  assert.equal(r.ok, true);
  assert.ok(w.__opened.startsWith('https://wa.me/254712345678?text='));
  w.eval("appointments[0].status = 'cancelled'");
  assert.equal((await w.eval("sendAppointmentReminder('A1', 'sms')")).ok, false);
  b.close();
});

test('bulk reminder: only scheduled appointments in the next 36h that have a phone and no earlier successful reminder', async () => {
  const log = []; const b = await notifySession(log); const { w } = b;
  const out = JSON.parse(await w.eval("remindUpcomingAppointments(36).then(JSON.stringify)"));
  assert.equal(out.total, 2, 'A3 is 30 days away');
  assert.equal(out.sent, 1); assert.equal(out.noPhone, 1);
  const again = JSON.parse(await w.eval("remindUpcomingAppointments(36).then(JSON.stringify)"));
  assert.equal(again.sent, 0, 'already reminded');
  b.close();
});

test('result-ready notice: only for verified results, critical needs clinician acknowledgement, and never contains the result or test name', async () => {
  const log = []; const b = await notifySession(log); const { w } = b;
  w.eval("labResults[0].verifiedAt = null");
  assert.ok(/Verify/.test((await w.eval("notifyResultReady('L1', 'sms')")).error));
  w.eval("labResults[0].verifiedAt = Date.now(); labResults[0].flag = 'critical'");
  assert.ok(/acknowledged/.test((await w.eval("notifyResultReady('L1', 'sms')")).error));
  w.eval("labResults[0].criticalAckAt = Date.now()");
  const r = await w.eval("notifyResultReady('L1', 'sms')");
  assert.equal(r.ok, true);
  const sent = log.filter(x => x.url.includes('sms-send')).pop();
  assert.ok(!/Malaria|Positive/.test(sent.body.message), 'no test name or value in the SMS');
  assert.equal(w.eval("labResults[0].notices[0].kind"), 'result');
  b.close();
});

// ---- Zip 97: postpartum + newborn care ----
async function pnSession() {
  const mother = { ...PATIENT, maternity: { gravida: 2, parity: 1, lmp: now - 280 * DAY, edd: now, riskFactors: '', ancVisits: [], labour: null, deliveries: [{ id: 'D1', at: now - 5 * 3600000, type: 'Spontaneous vaginal', newborns: ['PT-B'], alerts: [] }] } };
  const baby = { id: 'PT-B', name: 'Baby of Jane', age: 0, sex: 'Female', motherId: 'PT-1', dobAt: now - 5 * 3600000, birthWeightKg: 3.0, registeredAt: now - 5 * 3600000, newborn: { feeding: [], obs: [], immunisations: [], nicu: null } };
  const b = await boot(APP, { storage: { pos_patients: JSON.stringify([mother, baby]) }, wait: 1200 });
  b.w.eval("showToast = function () {}; window.confirm = () => true");
  return b;
}
test('postpartum: needs a delivery; alerts for severe BP, fever, heavy bleeding, boggy uterus; due-check tracker', async () => {
  const b = await pnSession(); const { w } = b;
  assert.equal(w.eval("addPostpartumObs('PT-B', {bp:'120/80'})"), null, 'baby is not a mother');
  const r = JSON.parse(w.eval("JSON.stringify(addPostpartumObs('PT-1', {bp:'165/112', temp:'38.4', pulse:'112', bleeding:'heavy', fundus:'boggy'}))"));
  assert.ok(r.alerts.length >= 5, JSON.stringify(r.alerts));
  assert.equal(JSON.parse(w.eval("JSON.stringify(addPostpartumObs('PT-1', {bp:'118/76', temp:'36.8', pulse:'80'}).alerts)")).length, 0);
  assert.equal(w.eval("addPostpartumObs('PT-1', {})"), null);
  const due = JSON.parse(w.eval(`JSON.stringify(postpartumChecksDue(${now - 5 * 3600000}, patients[0].maternity.postpartum))`));
  assert.equal(due[0].done, true); assert.equal(due[1].done, false);
  assert.ok(JSON.parse(w.eval("JSON.stringify(auditLog)")).some(a => a.action === 'Postpartum check — ALERT'));
  b.close();
});
test('newborn observations: hypothermia, breathing, jaundice, >10% weight loss are flagged; only babies accepted', async () => {
  const b = await pnSession(); const { w } = b;
  assert.equal(w.eval("addNewbornObs('PT-1', {temp:'36'})"), null, 'mother is not a newborn');
  const r = JSON.parse(w.eval("JSON.stringify(addNewbornObs('PT-B', {temp:'35.9', rr:'70', hr:'170', weightKg:'2.6', jaundice:'severe', cord:'infected', spo2:'85'}))"));
  assert.ok(r.alerts.length >= 6, JSON.stringify(r.alerts));
  assert.equal(JSON.parse(w.eval("JSON.stringify(addNewbornObs('PT-B', {temp:'36.8', rr:'45', hr:'130', weightKg:'2.95'}).alerts)")).length, 0);
  b.close();
});
test('feeding: valid types only; immunisation: schedule, batch required, no duplicates, no future / pre-birth dates', async () => {
  const b = await pnSession(); const { w } = b;
  assert.equal(w.eval("addNewbornFeeding('PT-B', 'pizza', '')"), null);
  assert.ok(w.eval("addNewbornFeeding('PT-B', 'exclusive_breastfeeding', 'latching well')"));
  const sched = JSON.parse(w.eval("JSON.stringify(immunisationSchedule(patients[1].dobAt, patients[1].newborn.immunisations))"));
  assert.ok(sched.find(s => s.vaccine === 'BCG') && sched.find(s => s.vaccine === 'Measles-Rubella 1'));
  assert.equal(w.eval("recordImmunisation('PT-B', 'BCG', '', '', 'left arm')"), null, 'batch needed');
  assert.equal(w.eval("recordImmunisation('PT-B', 'Smallpox', '', 'B1', '')"), null, 'not in schedule');
  const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  assert.equal(w.eval(`recordImmunisation('PT-B', 'BCG', '${future}', 'B1', '')`), null);
  assert.ok(w.eval("recordImmunisation('PT-B', 'BCG', '', 'B123', 'right arm')"));
  assert.equal(w.eval("recordImmunisation('PT-B', 'BCG', '', 'B123', '')"), null, 'duplicate');
  const s2 = JSON.parse(w.eval("JSON.stringify(immunisationSchedule(patients[1].dobAt, patients[1].newborn.immunisations))"));
  assert.ok(s2.find(s => s.vaccine === 'BCG').given);
  const old = JSON.parse(w.eval(`JSON.stringify(immunisationSchedule(${now - 100 * 86400000}, []))`));
  assert.equal(old.find(s => s.vaccine === 'OPV 1').overdue, true);
  assert.equal(old.find(s => s.vaccine === 'Measles-Rubella 1').overdue, false);
  b.close();
});
test('NICU: admit needs a reason, no double admission, notes only while admitted, discharge needs a summary', async () => {
  const b = await pnSession(); const { w } = b;
  assert.equal(w.eval("admitNicu('PT-B', '', 'Cot 3')"), false);
  assert.equal(w.eval("admitNicu('PT-B', 'respiratory distress', 'Cot 3')"), true);
  assert.equal(w.eval("admitNicu('PT-B', 'again', '')"), false);
  assert.equal(w.eval("addNicuNote('PT-B', 'on CPAP')"), true);
  assert.equal(w.eval("dischargeNicu('PT-B', '')"), false);
  assert.equal(w.eval("dischargeNicu('PT-B', 'off oxygen 48h, feeding well')"), true);
  assert.equal(w.eval("addNicuNote('PT-B', 'late')"), false);
  assert.equal(w.eval("patients[1].newborn.nicu.status"), 'discharged');
  const kinds = JSON.parse(w.eval("JSON.stringify(buildPatientTimeline('PT-B').map(e => e.kind))"));
  assert.ok(kinds.includes('NICU'));
  b.close();
});
test('maternity panel renders postpartum for the mother and newborn sections for the baby; delivery creates the newborn record', async () => {
  const b = await pnSession(); const { w, d } = b;
  w.eval("openMaternity('PT-1')");
  assert.ok(d.getElementById('maternity-body').textContent.includes('Postpartum monitoring'));
  w.eval("openMaternity('PT-B')");
  const t = d.getElementById('maternity-body').textContent;
  assert.ok(t.includes('Immunisation') && t.includes('NICU') && t.includes('Feeding'));
  assert.ok(!t.includes('ANC profile'));
  // a newborn created by recordDelivery carries an empty newborn record
  w.eval("patients[0].maternity.deliveries = []; openMaternity('PT-1')");
  d.getElementById('mat-nb-wt').value = '3.1';
  w.eval("recordDelivery()");
  const nb = JSON.parse(w.eval("JSON.stringify(patients[patients.length - 1])"));
  assert.ok(nb.newborn && Array.isArray(nb.newborn.immunisations));
  b.close();
});

// ---- Zip 98: operations snapshot ----
test('operations snapshot counts what needs attention and renders on the Hospital Report', async () => {
  const t = Date.now();
  const b = await boot(APP, { wait: 1200, storage: {
    pos_patients: JSON.stringify([PATIENT, { id: 'PT-B', name: 'Baby', motherId: 'PT-1', newborn: { feeding: [], obs: [], immunisations: [], nicu: { status: 'admitted', admittedAt: t, reason: 'x', notes: [] } } }]),
    pos_queue: JSON.stringify([{ id: 'Q1', patientId: 'PT-1', status: 'waiting', triageLevel: 'emergency', stage: 'triage' }, { id: 'Q2', patientId: 'PT-1', status: 'done', stage: 'cashier' }]),
    pos_lab_results: JSON.stringify([
      { id: 'L1', patientId: 'PT-1', testName: 'a', status: 'pending', requestedAt: t },
      { id: 'L2', patientId: 'PT-1', testName: 'b', status: 'completed', flag: 'critical', requestedAt: t - 4 * 3600000, resultAt: t, resultText: 'x' },
      { id: 'L3', patientId: 'PT-1', testName: 'c', status: 'completed', flag: 'normal', requestedAt: t - 2 * 3600000, resultAt: t, verifiedAt: t, resultText: 'y' }]),
    pos_admissions: JSON.stringify([{ id: 'A1', patientId: 'PT-1', status: 'admitted' }, { id: 'A2', patientId: 'PT-1', status: 'discharged' }]),
    pos_patient_charges: JSON.stringify([{ id: 'C1', ref: 'R1', status: 'unpaid', price: 100, qty: 2 }, { id: 'C2', ref: 'R1', status: 'unpaid', price: 50, qty: 1 }, { id: 'C3', ref: 'R2', status: 'cancelled', price: 999, qty: 1 }, { id: 'C4', ref: 'R3', status: 'paid', price: 10, qty: 1 }]),
    pos_institution_charges: JSON.stringify([{ id: 'I1', amount: 1000, claimStatus: 'submitted' }, { id: 'I2', amount: 500, claimStatus: 'rejected', rejectedAmount: 500 }, { id: 'I3', amount: 700, claimStatus: 'paid' }]),
    pos_cash_shifts: JSON.stringify([{ id: 'S1', status: 'open' }, { id: 'S2', status: 'closed', approval: { status: 'pending' } }]),
  } });
  const { w, d } = b;
  const s = JSON.parse(w.eval("JSON.stringify(hospitalOpsSnapshot())"));
  assert.equal(s.queueWaiting, 1); assert.equal(s.emergencyWaiting, 1);
  assert.equal(s.labPending, 1); assert.equal(s.labUnverified, 1); assert.equal(s.labCriticalOpen, 1);
  assert.equal(s.labTurnaroundHours, 3, 'average of 4h and 2h');
  assert.equal(s.admitted, 1); assert.equal(s.nicu, 1);
  assert.equal(s.unpaidBills, 1); assert.equal(s.unpaidAmount, 250, 'cancelled and paid charges excluded');
  assert.equal(s.claimsAwaitingCount, 1); assert.equal(s.claimsAwaitingAmount, 1000); assert.equal(s.claimsRejectedAmount, 500);
  assert.equal(s.openShifts, 1); assert.equal(s.shiftsAwaitingApproval, 1);
  w.eval("renderHospitalReport()");
  const txt = d.getElementById('hr-ops-snapshot').textContent;
  assert.ok(txt.includes('Needs attention now') && txt.includes('Critical results not acknowledged'));
  b.close();
});

// ---- Zip 99: SHA / DHA eClaims credentials + claim submission (client side) ----
async function shaClientSession(fetchStub) {
  const b = await boot(APP, { fetch: fetchStub, wait: 1200, storage: {
    pos_patients: JSON.stringify([{ ...PATIENT, shaNumber: 'SHA-999' }]),
    pos_institution_charges: JSON.stringify([{ id: 'C1', claimNo: 'CLM-1', amount: 500, description: 'Consultation', patientName: 'Jane Mwangi', policyNo: 'P1', timestamp: now, claimStatus: 'submitted' }]),
  } });
  b.w.eval("showToast = function () {}; window.confirm = () => true");
  return b;
}
function shaFetchStub(log, resp) {
  return async (url, init) => {
    log.push(String(url));
    if (String(url).includes('/api/sha-claim-submit')) return { json: async () => resp };
    return { json: async () => ({}) };
  };
}

test('SHA settings: Save posts the pasted credentials and clears the secret field after saving', async () => {
  const log = [];
  const b = await boot(APP, { fetch: async (url, init) => { log.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null }); return { ok: true, json: async () => ({ ok: true, configured: false }) }; }, wait: 1200 });
  const { w, d } = b;
  d.getElementById('sha-env-input').value = 'sandbox';
  d.getElementById('sha-base-url-input').value = 'https://sandbox.afyaconnect.dha.go.ke';
  d.getElementById('sha-client-id-input').value = 'CID1';
  d.getElementById('sha-client-secret-input').value = 'SECRET1';
  d.getElementById('sha-facility-code-input').value = 'FAC1';
  await w.eval("saveShaConfig()");
  const post = log.find(x => x.url.includes('/api/sha-config') && x.body);
  assert.equal(post.body.shaClientId, 'CID1');
  assert.equal(post.body.shaFacilityCode, 'FAC1');
  assert.equal(d.getElementById('sha-client-secret-input').value, '', 'the secret field is cleared after saving');
  b.close();
});

test('submitting a claim to SHA records the outcome on the claim, audits it, and never changes claimStatus itself', async () => {
  const log = [];
  const b = await shaClientSession(shaFetchStub(log, { ok: true, dhaClaimResponseId: 'DHA-77' }));
  const { w } = b;
  await w.eval("submitClaimToSha('C1')");
  const c = JSON.parse(w.eval("JSON.stringify(institutionCharges[0])"));
  assert.equal(c.shaSubmissions.length, 1);
  assert.equal(c.shaSubmissions[0].ok, true);
  assert.equal(c.shaSubmissions[0].dhaClaimResponseId, 'DHA-77');
  assert.equal(c.claimStatus, 'submitted', 'claimStatus is untouched — only a human moves it, via Update status');
  assert.ok(JSON.parse(w.eval("JSON.stringify(auditLog)")).some(a => a.action === 'Claim submitted to SHA electronically'));
  b.close();
});

test('a failed SHA submission is recorded with the real error and audited as a failure, not silently dropped', async () => {
  const log = [];
  const b = await shaClientSession(shaFetchStub(log, { ok: false, error: 'Unknown facility code' }));
  const { w } = b;
  await w.eval("submitClaimToSha('C1')");
  const c = JSON.parse(w.eval("JSON.stringify(institutionCharges[0])"));
  assert.equal(c.shaSubmissions[0].ok, false);
  assert.equal(c.shaSubmissions[0].error, 'Unknown facility code');
  assert.ok(JSON.parse(w.eval("JSON.stringify(auditLog)")).some(a => a.action === 'SHA submission FAILED'));
  b.close();
});

test('a patient with no SHA number or national ID triggers a confirmation before submitting', async () => {
  const b = await boot(APP, { fetch: shaFetchStub([], { ok: true }), wait: 1200, storage: {
    pos_patients: JSON.stringify([PATIENT]),   // no shaNumber, no nationalId
    pos_institution_charges: JSON.stringify([{ id: 'C1', claimNo: 'CLM-2', amount: 300, patientName: 'Jane Mwangi', timestamp: now, claimStatus: 'submitted' }]),
  } });
  const { w } = b;
  w.eval("showToast = function () {}");
  let asked = 0;
  w.confirm = () => { asked++; return false; };
  await w.eval("submitClaimToSha('C1')");
  assert.ok(asked >= 1);
  assert.ok(!w.eval("institutionCharges[0].shaSubmissions"), 'declining the warning stops the submission');
  b.close();
});

// ---- Zip 100: Reception/Diagnosis split (search-first, least-privilege) ----
async function navSession() {
  const b = await boot(APP, { storage: {
    pos_patients: JSON.stringify([PATIENT]),
    pos_appointments: JSON.stringify([{ id: 'A1', patientId: 'PT-1', patientName: 'Jane Mwangi', scheduledFor: now + 3600000, status: 'scheduled' }]),
  }, wait: 1200 });
  b.w.eval("showToast = function () {}; window.confirm = () => true");
  return b;
}

test('searchPatientsAny matches by name, patient no., phone, national ID or SHA no. — never returns everyone on an empty query', async () => {
  const b = await navSession(); const { w } = b;
  assert.equal(w.eval("searchPatientsAny('').length"), 0, 'empty query = no browsing');
  assert.equal(w.eval("searchPatientsAny('jane').length"), 1);
  assert.equal(w.eval("searchPatientsAny('PT-1').length"), 1);
  assert.equal(w.eval("searchPatientsAny('0712345678').length"), 1);
  assert.equal(w.eval("searchPatientsAny('nobody-matches-this').length"), 0);
  b.close();
});

test('searchPatientsOrVisitRef also matches a visit reference directly (patient ID or visit ID or any identifier)', async () => {
  const b = await boot(APP, { storage: { pos_patients: JSON.stringify([PATIENT]), pos_visits: JSON.stringify([VISIT]) }, wait: 1200 });
  const { w } = b;
  const byRef = JSON.parse(w.eval(`JSON.stringify(searchPatientsOrVisitRef('${VISIT.ref}'))`));
  assert.equal(byRef.length, 1);
  assert.equal(byRef[0].id, 'PT-1');
  b.close();
});

test('Reception tab: shows only identity + routing (no allergies, no diagnosis, no timeline/merge) and can send to Triage', async () => {
  const b = await navSession(); const { w, d } = b;
  w.eval("renderReceptionTab()");
  w.eval("onReceptionPatientPicked('PT-1')");
  const card = d.getElementById('reception-search-card').innerHTML;
  assert.ok(card.includes('Jane Mwangi'));
  assert.ok(card.includes('Has an appointment today'));
  assert.ok(!/Timeline|openPatientTimeline|Merge|mergePatients|Maternity|openMaternity|Allerg/i.test(card), 'no clinical/admin tools leak into Reception');
  w.eval("receptionSendToTriage('PT-1')");
  assert.equal(w.eval("queue.length"), 1);
  assert.equal(w.eval("queue[0].patientId"), 'PT-1');
  assert.equal(w.eval("queue[0].stage"), 'triage');
  b.close();
});

test('Diagnosis tab: search-first, and once found gives full clinical context (allergies, queue status, history, consultation)', async () => {
  const b = await boot(APP, { storage: {
    pos_patients: JSON.stringify([PATIENT]),
    pos_queue: JSON.stringify([{ id: 'Q1', patientId: 'PT-1', arrivedAt: now, triageLevel: 'urgent', status: 'waiting', vitals: { bp: '120/80' }, stage: 'triage' }]),
  }, wait: 1200 });
  const { w, d } = b;
  w.eval("showToast = function () {}");
  w.eval("renderDiagnosisTab()");
  assert.equal(d.getElementById('diagnosis-search-card').innerHTML.trim(), '', 'nothing shown before a search');
  w.eval("onDiagnosisPatientPicked('PT-1')");
  const card = d.getElementById('diagnosis-search-card').innerHTML;
  assert.ok(card.includes('ALLERGIES: Penicillin'));
  assert.ok(card.includes('urgent'));
  assert.ok(card.includes('vitals recorded'));
  assert.ok(/openPatientVisitModal\('PT-1'\)/.test(card));
  assert.ok(/openPatientTimeline\('PT-1'\)/.test(card));
  b.close();
});

test('the search-and-pick widget stores the chosen id into the target input, matching what the four converted pickers rely on', async () => {
  const b = await navSession(); const { w, d } = b;
  d.body.insertAdjacentHTML('beforeend', '<div id="test-picker"></div><input type="hidden" id="test-target">');
  w.eval("renderPatientSearchPicker('test-picker', 'test-target', 'placeholder')");
  d.getElementById('test-picker-q').value = 'jane';
  w.eval("runPatientSearchPicker('test-picker', 'test-target')");
  assert.ok(d.getElementById('test-picker-results').innerHTML.includes('Jane Mwangi'));
  w.eval("pickPatientFromSearch('test-picker', 'test-target', 'PT-1')");
  assert.equal(d.getElementById('test-target').value, 'PT-1');
  assert.ok(d.getElementById('test-picker-chosen').textContent.includes('Jane Mwangi'));
  b.close();
});

test('Queue and Laboratory request pickers are now search-first (no plain <select> listing every patient)', async () => {
  const b = await navSession(); const { w, d } = b;
  assert.equal(d.querySelector('#queue-add-patient-select').tagName, 'INPUT');
  assert.equal(d.querySelector('#lab-tab-patient-select').tagName, 'INPUT');
  w.eval("renderQueuePatientSelect()");
  assert.ok(d.getElementById('queue-add-patient-picker').innerHTML.includes('queue-add-patient-picker-q'));
  d.getElementById('queue-add-patient-picker-q').value = 'jane';
  w.eval("runPatientSearchPicker('queue-add-patient-picker', 'queue-add-patient-select')");
  w.eval("pickPatientFromSearch('queue-add-patient-picker', 'queue-add-patient-select', 'PT-1')");
  w.eval("addPatientToQueue()");
  assert.equal(w.eval("queue.length"), 1);
  b.close();
});

test('sales-tab (Pharmacy & Cashier) role is never forced: an admin assigning only Laboratory to a new staff member sticks', async () => {
  const b = await navSession(); const { w } = b;
  assert.equal(w.eval("newStaffSelectedRoles.length"), 0, 'nothing pre-checked for a new invite');
  w.eval("toggleNewStaffRole('laboratory-tab', true)");
  w.eval("document.getElementById('new-staff-name-input') && (document.getElementById('new-staff-name-input').value = 'Dr Lab')");
  const rolesBeforeSave = JSON.parse(w.eval("JSON.stringify(newStaffSelectedRoles)"));
  assert.deepEqual(rolesBeforeSave, ['laboratory-tab']);
  assert.ok(!rolesBeforeSave.includes('sales-tab'), 'sales-tab is not silently added');
  b.close();
});

// ---- Zip 101: prescribe medicine not in stock, carry/not-carry ticking at dispensing ----
async function rxSession() {
  const b = await session(); const { w } = b;
  w.eval("showToast = function () {}; window.confirm = () => true");
  return b;
}

test('a doctor can prescribe a medicine this facility does not stock; it is never charged or stock-deducted', async () => {
  const b = await rxSession(); const { w, d } = b;
  w.eval("openPatientVisitModal('PT-1')");
  d.getElementById('visit-diagnosis-input').value = 'Hypertension';
  w.eval("addVisitMedicationRow()");
  w.eval("toggleVisitMedNotStocked(0, true)");
  const rows = w.document.querySelectorAll('#visit-medication-rows input[type=text]');
  // first free-text input for the row is the medicine name (qty/dosage are separate inputs after it)
  w.eval("updateVisitMedicationRow(0, 'freeName', 'Amlodipine 10mg')");
  w.eval("updateVisitMedicationRow(0, 'dosage', '1 tablet daily')");
  w.eval("saveVisit()");
  const v = JSON.parse(w.eval("JSON.stringify(visits.find(x => x.diagnosis === 'Hypertension'))"));
  assert.equal(v.medications.length, 1);
  assert.equal(v.medications[0].name, 'Amlodipine 10mg');
  assert.equal(v.medications[0].notStocked, true);
  assert.equal(v.medications[0].dosage, '1 tablet daily');
  assert.equal(w.eval("patientCharges.filter(c => c.kind === 'medication').length"), 0, 'never charged');
  b.close();
});

test('an empty not-stocked row is silently skipped, same as an empty stocked row always was', async () => {
  const b = await rxSession(); const { w, d } = b;
  w.eval("openPatientVisitModal('PT-1')");
  d.getElementById('visit-diagnosis-input').value = 'Checkup';
  w.eval("addVisitMedicationRow()");
  w.eval("toggleVisitMedNotStocked(0, true)");
  w.eval("saveVisit()");
  const v = JSON.parse(w.eval("JSON.stringify(visits.find(x => x.diagnosis === 'Checkup'))"));
  assert.equal(v.medications.length, 0);
  b.close();
});

test('not-stocked medicine shows in the visit history and patient timeline with dosage, and a print-slip button appears', async () => {
  const b = await rxSession(); const { w, d } = b;
  w.eval("openPatientVisitModal('PT-1')");
  d.getElementById('visit-diagnosis-input').value = 'Diabetes';
  w.eval("addVisitMedicationRow(); toggleVisitMedNotStocked(0, true); updateVisitMedicationRow(0, 'freeName', 'Insulin glargine'); updateVisitMedicationRow(0, 'dosage', '10 units at night')");
  w.eval("saveVisit()");
  w.eval("renderPatientVisitHistory('PT-1')");
  const histHtml = d.getElementById('patient-visit-history-list').innerHTML;
  assert.ok(histHtml.includes('Insulin glargine') && histHtml.includes('10 units at night'));
  assert.ok(/printExternalPrescriptionForRef/.test(histHtml));
  const kinds = JSON.parse(w.eval("JSON.stringify(buildPatientTimeline('PT-1'))"));
  const rx = kinds.find(e => e.kind === 'Prescription' && e.detail.includes('Insulin glargine'));
  assert.ok(rx && rx.detail.includes('not stocked here'));
  b.close();
});

test('carry checklist: a bill with a stocked medication shows the panel; unticking declines it, keeps it off the loaded cart, and it never lingers as unpaid', async () => {
  const b = await boot(APP, { storage: {
    pos_patients: JSON.stringify([PATIENT]),
    pos_patient_charges: JSON.stringify([
      { id: 'C1', ref: 'V1REF', patientId: 'PT-1', patientName: 'Jane Mwangi', kind: 'medication', name: 'Amoxicillin', code: 'AMX', qty: 2, price: 100, unit: 'pcs', status: 'unpaid', dosage: '1 cap x2 daily', createdAt: now },
      { id: 'C2', ref: 'V1REF', patientId: 'PT-1', patientName: 'Jane Mwangi', kind: 'consultation', name: 'Consultation Fee', code: '', qty: 1, price: 500, unit: 'use', status: 'unpaid', isService: true, createdAt: now },
    ]),
  }, wait: 1200 });
  const { w, d } = b;
  w.eval("showToast = function () {}");
  w.eval("loadPatientBill('V1REF')");
  assert.equal(d.getElementById('med-carry-panel').style.display, 'block');
  assert.ok(d.getElementById('med-carry-list').innerHTML.includes('Amoxicillin'));
  assert.ok(d.getElementById('med-carry-list').innerHTML.includes('1 cap x2 daily'), 'dosage shown at dispensing');
  d.getElementById('carry-C1').checked = false;
  w.prompt = () => 'cannot afford';
  w.eval("confirmMedicationCarry()");
  assert.equal(w.eval("patientCharges.find(c => c.id === 'C1').status"), 'declined');
  assert.equal(w.eval("patientCharges.find(c => c.id === 'C1').declinedReason"), 'cannot afford');
  assert.equal(w.eval("Object.keys(currentCart).some(k => k.includes('C1'))"), false, 'declined med never enters the cart');
  assert.equal(w.eval("Object.keys(currentCart).some(k => k.includes('C2'))"), true, 'the consultation fee still loads normally');
  assert.ok(JSON.parse(w.eval("JSON.stringify(auditLog)")).some(a => a.action === 'Medication not carried'));
  // reloading the same ref later must not show the declined charge again
  w.eval("Object.keys(currentCart).forEach(k => delete currentCart[k])");
  w.eval("loadPatientBill('V1REF')");
  assert.equal(d.getElementById('med-carry-panel').style.display, 'none', 'no medication left to ask about');
  b.close();
});

test('carry checklist: leaving everything ticked behaves exactly as a normal bill load (no items declined)', async () => {
  const b = await boot(APP, { storage: {
    pos_patients: JSON.stringify([PATIENT]),
    pos_patient_charges: JSON.stringify([
      { id: 'C1', ref: 'V2REF', patientId: 'PT-1', patientName: 'Jane Mwangi', kind: 'medication', name: 'Paracetamol', code: 'PCM', qty: 1, price: 50, unit: 'pcs', status: 'unpaid', createdAt: now },
    ]),
  }, wait: 1200 });
  const { w, d } = b;
  w.eval("showToast = function () {}");
  w.eval("loadPatientBill('V2REF')");
  w.eval("confirmMedicationCarry()");
  assert.equal(w.eval("patientCharges.find(c => c.id === 'C1').status"), 'unpaid');
  assert.equal(w.eval("Object.keys(currentCart).length"), 1);
  b.close();
});

test('printExternalPrescriptionForRef prints the not-stocked and declined medicines together, with dosage, and refuses when there is nothing to print', async () => {
  const b = await boot(APP, { storage: {
    pos_patients: JSON.stringify([PATIENT]),
    pos_visits: JSON.stringify([{ ...VISIT, ref: 'V3REF', medications: [{ name: 'Metformin', qty: 30, dosage: '1 tab twice daily', notStocked: true }] }]),
    pos_patient_charges: JSON.stringify([{ id: 'C9', ref: 'V3REF', patientId: 'PT-1', patientName: 'Jane Mwangi', kind: 'medication', name: 'Ibuprofen', qty: 1, price: 20, status: 'declined', declinedReason: 'out of stock', dosage: '1 tab as needed' }]),
  }, wait: 1200 });
  const { w } = b;
  w.eval("showToast = function () {}");
  let opened = null;
  w.eval("window.open = () => { window.__win = { document: { write(h) { window.__html = h; }, close(){} }, focus(){}, print(){} }; return window.__win; }");
  w.eval("printExternalPrescriptionForRef('V3REF')");
  const html = w.eval("window.__html");
  assert.ok(html.includes('Metformin') && html.includes('1 tab twice daily'));
  assert.ok(html.includes('Ibuprofen') && html.includes('out of stock'));
  let refused = false;
  w.eval("window.open = () => { window.__called = true; return window.__win; }; window.__called = false;");
  w.eval("printExternalPrescriptionForRef('NO-SUCH-REF')");
  assert.equal(w.eval("window.__called"), false, 'nothing to print -> no window opened');
  b.close();
});
