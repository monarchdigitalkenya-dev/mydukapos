import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';

// Zip 126: Kenyan patient flow on the EXISTING queue — Reception asks where the patient is going, every station has its own queue with
// NOW SERVING + NEXT 5 + CALL NEXT, patients are routed only where they need to go, and the journey is recorded end to end.
const APP = 'hospital/index.html';
const P = (id, name, age, sex) => ({ id, name, age, sex, phone: '0711' + id.replace(/\D/g, '').padStart(6, '0'), allergies: '', registeredAt: Date.now() - 86400000 });
const PATIENTS = [P('PT-1', 'Jane Mwangi', 30, 'female'), P('PT-2', 'John Otieno', 40, 'male'), P('PT-3', 'Baby Amani', 2, 'male'), P('PT-4', 'Mary Wanjiru', 26, 'female'), P('PT-5', 'Peter Kamau', 55, 'male')];
const INV = [{ code: 'AX', type: 'item', name: 'Amoxicillin 500mg', price: 30, wholesalePrice: 15, qty: 40, unit: 'pcs', vatCategory: 'A' }];
async function app(extra = {}) {
  const b = await boot(APP, { storage: { pos_patients: JSON.stringify(PATIENTS.concat(extra.patients || [])), pos_inventory: JSON.stringify(INV), ...(extra.storage || {}) }, wait: 1500 });
  b.w.eval("showToast = function (m) { (window.__toasts = window.__toasts || []).push(m); }; window.confirm = () => true; window.prompt = (m, d) => (window.__promptAnswers && window.__promptAnswers.length ? window.__promptAnswers.shift() : 'test reason'); window.print = () => {}");
  return b;
}
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const entryOf = (w, pid) => J(w, `queue.find(q => q.patientId === '${pid}' && q.status !== 'done') || queue.filter(q => q.patientId === '${pid}').pop()`);
const stagesOf = (w, pid) => entryOf(w, pid).stageHistory.map((h) => h.stage);
const tab = (w, id) => w.eval(`document.querySelector('.tab-link[data-tab="${id}"]').click()`);
const fromReception = (w, pid, station, priority, reason) => {
  w.eval(`renderReceptionTab(); onReceptionPatientPicked('${pid}')`);
  const d = w.document;
  if (priority) d.getElementById('reception-priority').value = priority;
  if (reason) d.getElementById('reception-reason').value = reason;
  w.eval(`receptionSendTo('${pid}', '${station}')`);
};
// "Send to…" through the real dialog
const sendTo = async (w, entryId, dest, { back = null, referral = false, reason = '' } = {}) => {
  w.eval(`hmisOpenRoute('${entryId}')`);
  const d = w.document;
  if (dest) w.eval(`hmisPickDest(document.querySelector('[data-hmis-dest="${dest}"]'))`);
  const r = d.getElementById('hmis-route-return'); if (r && back !== null) r.checked = back;
  d.getElementById('hmis-route-referral').checked = referral;
  d.getElementById('hmis-route-reason').value = reason;
  w.eval('hmisConfirmRoute()');
};
const finish = (w, entryId, type = 'Discharged home', followUp = '', note = '') => {
  w.eval(`hmisOpenFinish('${entryId}')`);
  const d = w.document;
  d.getElementById('hmis-finish-type').value = type; d.getElementById('hmis-finish-followup').value = followUp; d.getElementById('hmis-finish-note').value = note;
  w.eval('hmisConfirmFinish()');
};
const call = (w, station) => J(w, `(hmisCallNext('${station}') || {}).patientId || null`);
const labResult = (w, testId, value) => {
  w.eval(`openLabResultModal('${testId}')`);
  w.document.getElementById('lab-result-value-input').value = value;
  w.eval('confirmLabResult()');
};

test('Reception asks "Where are you going today?", offers the configured services, and sends the patient to THAT queue with a ticket', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("renderReceptionTab(); onReceptionPatientPicked('PT-1')");
  const card = d.getElementById('reception-search-card').innerHTML;
  assert.match(card, /Where are you going today\?/);
  for (const s of ['General Clinic', 'ANC', 'Maternity', 'Child Health', 'Immunization', 'Family Planning', 'TB Clinic', 'HIV / CCC', 'Chronic Disease', 'Dental', 'Eye Clinic', 'Laboratory', 'Pharmacy', 'Emergency']) assert.ok(card.includes(s), 'offers ' + s);
  assert.ok(!/openMaternity|openPatientTimeline|\bMerge\b|mergePatients|Allerg/i.test(card), 'still no clinical tools at Reception');
  fromReception(w, 'PT-1', 'consultation');
  fromReception(w, 'PT-4', 'anc');
  fromReception(w, 'PT-3', 'child');
  assert.deepEqual([entryOf(w, 'PT-1').stage, entryOf(w, 'PT-4').stage, entryOf(w, 'PT-3').stage], ['consultation', 'anc', 'child'], 'each to its own queue — not everyone through Triage');
  assert.deepEqual([w.eval("hmisTicket(queue[0])"), w.eval("hmisTicket(queue[1])"), w.eval("hmisTicket(queue[2])")], ['G-001', 'A-001', 'CH-001']);
  // the same patient again: MOVED, not a second visit
  fromReception(w, 'PT-1', 'dental');
  assert.equal(J(w, "queue.filter(q => q.patientId === 'PT-1').length"), 1, 'no duplicate visit');
  assert.equal(entryOf(w, 'PT-1').stage, 'dental');
  assert.ok(J(w, 'auditLog').some((a) => a.action === 'Patient sent to station' && /ANC/.test(a.details)), 'audited');
  b.close();
});

test('TEST 1 — general outpatient: Reception → Triage → General Clinic → Lab → Clinic review → Pharmacy → Discharge; every queue updates', async () => {
  const b = await app(); const { w, d } = b;
  fromReception(w, 'PT-2', 'triage');
  tab(w, 'queue-tab');
  assert.match(d.getElementById('queue-station-board').innerHTML, /T-001/);
  assert.equal(call(w, 'triage'), 'PT-2');
  const id = entryOf(w, 'PT-2').id;
  w.eval(`openVitalsModal('${id}')`); d.getElementById('vitals-bp-input').value = '130/85'; d.getElementById('vitals-temp-input').value = '38.4'; w.eval('saveVitals()');
  await sleep(20);
  assert.equal(d.getElementById('hmis-route-dest').value, 'consultation', 'triage ends with choosing where next; General Clinic suggested');
  w.eval('hmisConfirmRoute()');
  assert.equal(entryOf(w, 'PT-2').stage, 'consultation');
  assert.equal(J(w, "hmisWaiting('triage').length"), 0, 'left the triage queue');
  // clinic: call, consult, request a test → Lab (and come back)
  assert.equal(call(w, 'consultation'), 'PT-2');
  w.eval(`hmisOpenConsult('${id}')`);
  assert.equal(entryOf(w, 'PT-2').vitals.bp, '130/85', 'the vitals from triage travel with the patient');
  d.getElementById('visit-diagnosis-input').value = 'Fever — ?malaria';
  d.getElementById('lab-test-name-input').value = 'Malaria RDT'; w.eval('requestLabTest()');
  w.eval('saveVisit()');
  await sleep(20);
  assert.equal(entryOf(w, 'PT-2').status, 'in-consult', 'saving the consultation does not end the visit');
  assert.equal(d.getElementById('hmis-route-dest').value, 'laboratory', 'a pending test → Laboratory suggested');
  d.getElementById('hmis-route-return').checked = true;
  w.eval('hmisConfirmRoute()');
  let e = entryOf(w, 'PT-2');
  assert.deepEqual([e.stage, e.returnTo], ['laboratory', 'consultation']);
  // lab: call, result, back to the clinician
  tab(w, 'laboratory-tab');
  assert.match(d.getElementById('laboratory-station-board').innerHTML, /LB-001/);
  assert.equal(call(w, 'laboratory'), 'PT-2');
  const testId = w.eval("labResults.find(t => t.patientId === 'PT-2').id");
  labResult(w, testId, 'Positive (P. falciparum)');
  tab(w, 'laboratory-tab');
  assert.match(d.getElementById('laboratory-station-board').innerHTML, /Back to .*General Clinic.* for review/);
  w.eval(`hmisUiRoute('${id}', 'consultation', 'Results ready — clinician review')`);
  // clinician review: sees the result, prescribes → Pharmacy
  assert.equal(call(w, 'consultation'), 'PT-2');
  w.eval(`hmisOpenConsult('${id}')`);
  assert.match(d.getElementById('patient-visit-modal').innerHTML + J(w, "labResults.find(t => t.patientId === 'PT-2').resultText"), /Positive/);
  d.getElementById('visit-diagnosis-input').value = 'Malaria';
  w.eval("visitMedicationDraft = [{ code: 'AX', qty: 6, dosage: '1 x 3' }]");
  w.eval('saveVisit()');
  await sleep(20);
  assert.equal(d.getElementById('hmis-route-dest').value, 'pharmacy', 'medicine prescribed → Pharmacy suggested');
  w.eval('hmisConfirmRoute()');
  // pharmacy: dispense + pay at the existing counter (stock comes out of the ONE inventory)
  assert.equal(call(w, 'pharmacy'), 'PT-2');
  w.eval(`hmisUiCounter('${id}')`);
  await sleep(120);
  w.eval('confirmMedicationCarry()');
  w.eval("currentPaymentMethod = 'cash'"); d.getElementById('cash-tendered-input').value = '100000';
  await w.eval('checkoutCart()');
  assert.equal(Number(w.eval("inventory.find(p => p.code === 'AX').qty")), 34, 'dispensed from the existing stock');
  assert.ok(entryOf(w, 'PT-2').events.some((x) => x.action === 'paid'), 'the journey records payment/dispensing');
  finish(w, id, 'Discharged home');
  e = entryOf(w, 'PT-2');
  assert.deepEqual([e.status, e.outcome], ['done', 'completed']);
  assert.deepEqual(stagesOf(w, 'PT-2'), ['triage', 'consultation', 'laboratory', 'consultation', 'pharmacy', 'discharge']);
  assert.equal(J(w, 'visits').filter((v) => v.patientId === 'PT-2').length, 2, 'the two consultations are on ONE patient');
  assert.equal(J(w, 'patients').length, PATIENTS.length, 'no patient duplicated');
  const journey = w.eval(`hmisJourneyHtml(queue.find(q => q.patientId === 'PT-2'))`);
  for (const s of ['Triage', 'General Clinic', 'Laboratory', 'Pharmacy', 'Discharge', 'Visit completed']) assert.ok(journey.includes(s), 'journey shows ' + s);
  b.close();
});

test('TEST 2 — ANC: Reception → ANC → investigations → ANC review → Pharmacy → follow-up (appointment booked)', async () => {
  const b = await app(); const { w, d } = b;
  fromReception(w, 'PT-4', 'anc');
  tab(w, 'maternity-tab');
  assert.match(d.getElementById('maternity-station-board').innerHTML, /A-001/);
  assert.equal(call(w, 'anc'), 'PT-4');
  const id = entryOf(w, 'PT-4').id;
  w.eval("hmisUiStart(queue[0].id, true); openMaternity('PT-4')");
  const lmp = new Date(Date.now() - 20 * 7 * 86400000).toISOString().slice(0, 10);
  d.getElementById('mat-gravida').value = '2'; d.getElementById('mat-parity').value = '1'; d.getElementById('mat-lmp').value = lmp; w.eval('saveMaternityProfile()');
  d.getElementById('mat-anc-bp').value = '118/76'; d.getElementById('mat-anc-hb').value = '10.2'; w.eval('addAncVisit()');
  const m = J(w, "patients.find(p => p.id === 'PT-4').maternity");
  assert.equal(m.ancVisits.length, 1); assert.ok(m.edd > Date.now(), 'EDD computed');
  assert.ok(m.ancVisits[0].flags.some((f) => /Anaemia/.test(f)), 'risk flagged (Hb 10.2)');
  w.eval("addLabTestRequest('PT-4', 'Haemoglobin (repeat)')");
  await sendTo(w, id, 'laboratory', { back: true, reason: 'ANC profile bloods' });
  assert.equal(entryOf(w, 'PT-4').returnTo, 'anc');
  call(w, 'laboratory');
  labResult(w, w.eval("labResults.find(t => t.patientId === 'PT-4').id"), '10.9 g/dL');
  w.eval(`hmisUiRoute('${id}', 'anc', 'Results ready — ANC review')`);
  assert.equal(call(w, 'anc'), 'PT-4', 'back in the ANC queue for review');
  await sendTo(w, id, 'pharmacy', { reason: 'Iron & folate' });
  call(w, 'pharmacy');
  const fu = new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
  finish(w, id, 'Follow-up appointment', fu, 'Next ANC visit');
  assert.deepEqual(stagesOf(w, 'PT-4'), ['anc', 'laboratory', 'anc', 'pharmacy', 'discharge']);
  assert.ok(J(w, 'appointments').some((a) => a.patientId === 'PT-4' && a.type === 'follow-up' && a.status === 'scheduled'), 'follow-up booked');
  b.close();
});

test('TEST 3 — maternity: Reception → Maternity → Labour → Delivery → Postnatal → Newborn → Discharge; one mother record, baby linked', async () => {
  const b = await app(); const { w, d } = b;
  const before = J(w, 'patients').length;
  fromReception(w, 'PT-1', 'maternity', 'urgent', 'In labour');
  call(w, 'maternity');
  const id = entryOf(w, 'PT-1').id;
  await sendTo(w, id, 'labour', { reason: 'Active labour, 5 cm' });
  tab(w, 'labour-tab');
  assert.match(d.getElementById('labour-station-board').innerHTML, /L-001/);
  call(w, 'labour');
  w.eval(`hmisUiStartLabour('${id}')`);
  d.getElementById('mat-lab-dil').value = '6'; d.getElementById('mat-lab-fhr').value = '140'; w.eval('addLabourObs()');
  tab(w, 'labour-tab');
  assert.match(d.getElementById('labour-list').innerHTML, /Jane Mwangi/, 'listed as in labour');
  w.eval("openMaternity('PT-1')");
  d.getElementById('mat-nb-name').value = 'Baby of Jane'; d.getElementById('mat-nb-wt').value = '3.2'; d.getElementById('mat-nb-a1').value = '8'; d.getElementById('mat-nb-a5').value = '9';
  w.eval('recordDelivery()');
  const babyId = J(w, "patients.find(p => p.motherId === 'PT-1').id");
  assert.equal(J(w, 'patients').length, before + 1, 'only the baby is a new record — the mother keeps hers');
  const baby = entryOf(w, babyId);
  assert.deepEqual([baby.stage, baby.motherId], ['newborn', 'PT-1'], 'the newborn is in the Newborn care queue, linked to the mother');
  assert.ok(entryOf(w, 'PT-1').events.some((x) => x.action === 'delivered'));
  await sendTo(w, id, 'postnatal', { reason: 'Delivered SVD' });
  tab(w, 'postnatal-tab');
  assert.match(d.getElementById('postnatal-list').innerHTML, /Jane Mwangi/);
  tab(w, 'child-tab');
  assert.match(d.getElementById('child-station-board').innerHTML, /NB-001/);
  assert.equal(call(w, 'newborn'), babyId);
  finish(w, baby.id, 'Discharged home', '', 'With mother');
  call(w, 'postnatal');
  finish(w, id, 'Discharged home');
  assert.deepEqual(stagesOf(w, 'PT-1'), ['maternity', 'labour', 'postnatal', 'discharge']);
  assert.equal(J(w, "patients.find(p => p.id === 'PT-1').maternity.deliveries.length"), 1, 'delivery on the mother\'s own record');
  b.close();
});

test('TEST 4 — child health: Reception → Child Health → Immunization → Pharmacy → Discharge', async () => {
  const b = await app(); const { w } = b;
  fromReception(w, 'PT-3', 'child');
  call(w, 'child');
  const id = entryOf(w, 'PT-3').id;
  await sendTo(w, id, 'immunization', { reason: 'Measles due' });
  call(w, 'immunization');
  await sendTo(w, id, 'pharmacy');
  call(w, 'pharmacy');
  finish(w, id);
  assert.deepEqual(stagesOf(w, 'PT-3'), ['child', 'immunization', 'pharmacy', 'discharge']);
  b.close();
});

test('TEST 5 — emergency: Reception → Emergency (called first everywhere) → Treatment → disposition (admitted)', async () => {
  const b = await app(); const { w, d } = b;
  fromReception(w, 'PT-2', 'emergency');
  fromReception(w, 'PT-5', 'emergency', 'emergency', 'Road traffic accident — bleeding');
  tab(w, 'emergency-tab');
  const html = d.getElementById('emergency-station-board').innerHTML;
  assert.ok(html.indexOf('Peter Kamau') < html.indexOf('John Otieno'), 'the emergency patient is first even though he came second');
  assert.equal(call(w, 'emergency'), 'PT-5');
  const id = entryOf(w, 'PT-5').id;
  await sendTo(w, id, 'procedures', { reason: 'Wound suturing' });
  call(w, 'procedures');
  finish(w, id, 'Admitted (in-patient)', '', 'Ward 3');
  const e = entryOf(w, 'PT-5');
  assert.deepEqual(stagesOf(w, 'PT-5'), ['emergency', 'procedures', 'discharge']);
  assert.equal(e.disposition.type, 'Admitted (in-patient)');
  b.close();
});

test('TEST 6 — referral: Clinic → internal referral → destination queue (and on the visit); external referral closes the visit as referred out', async () => {
  const b = await app(); const { w, d } = b;
  fromReception(w, 'PT-2', 'consultation');
  call(w, 'consultation');
  const id = entryOf(w, 'PT-2').id;
  w.eval(`hmisOpenConsult('${id}')`);
  d.getElementById('visit-diagnosis-input').value = 'Dental caries'; w.eval('saveVisit()');
  await sleep(20);
  await sendTo(w, id, 'dental', { referral: true, reason: 'Extraction' });
  const e = entryOf(w, 'PT-2');
  assert.equal(e.stage, 'dental');
  assert.equal(J(w, "hmisWaiting('dental').map(q => q.patientId)")[0], 'PT-2', 'in the Dental queue');
  const ref = J(w, "visits.find(v => v.patientId === 'PT-2').referrals[0]");
  assert.deepEqual([ref.type, ref.status], ['internal', 'sent']);
  assert.match(ref.to, /Dental/);
  tab(w, 'referrals-tab');
  assert.match(d.getElementById('referrals-list').innerHTML, /Internal.*Dental/s);
  call(w, 'dental');
  finish(w, id, 'Referred to another facility', '', 'KNH maxillofacial');
  assert.equal(entryOf(w, 'PT-2').outcome, 'referred-out');
  b.close();
});

test('TEST 7 — queue: 7 patients; NOW SERVING + NEXT 5; CALL NEXT shifts it; priority; out-of-turn needs a reason; history kept; no duplicates', async () => {
  const extra = Array.from({ length: 7 }, (_, i) => P('QX-' + (i + 1), 'Queue Patient ' + (i + 1), 30 + i, 'female'));
  const b = await app({ patients: extra }); const { w, d } = b;
  extra.forEach((p, i) => { w.eval(`hmisPlace('${p.id}', 'consultation', { from: 'reception' })`); w.eval(`queue[queue.length - 1].stationAt = Date.now() - ${(10 - i) * 60000}`); });
  tab(w, 'diagnosis-tab');
  const board = () => d.getElementById('diagnosis-station-board');
  const nextTickets = () => [...board().querySelectorAll('ol li')].map((li) => li.textContent.match(/G-\d{3}/)[0]);
  const serving = () => (board().querySelector('div[style*="eafaf1"]').textContent.match(/G-\d{3}/) || [null])[0];
  assert.deepEqual(nextTickets(), ['G-001', 'G-002', 'G-003', 'G-004', 'G-005'], 'the next five, in order');
  assert.equal(serving(), null);
  const btn = () => [...board().querySelectorAll('button')].find((x) => /CALL NEXT PATIENT/.test(x.textContent));
  btn().click();
  assert.equal(serving(), 'G-001');
  assert.deepEqual(nextTickets(), ['G-002', 'G-003', 'G-004', 'G-005', 'G-006']);
  btn().click();
  assert.equal(serving(), 'G-002', 'now serving moves on');
  assert.deepEqual(nextTickets(), ['G-003', 'G-004', 'G-005', 'G-006', 'G-007'], 'everyone promoted by one');
  // priority: the last patient becomes an emergency (reason required, audited) → first in line
  const last = J(w, "queue.find(q => q.patientId === 'QX-7').id");
  assert.equal(J(w, `hmisSetPriority('${last}', 'emergency', '') ? 1 : 0`), 0, 'no reason, no change');
  w.eval(`hmisSetPriority('${last}', 'emergency', 'Collapsed in the waiting area'); hmisRefreshBoards()`);
  assert.deepEqual(nextTickets(), ['G-007', 'G-003', 'G-004', 'G-005', 'G-006']);
  // serving someone out of turn needs a reason
  const g5 = J(w, "queue.find(q => q.patientId === 'QX-5').id");
  assert.equal(J(w, `(hmisCallNext('consultation', '${g5}') || {}).id || null`), null);
  assert.ok(J(w, `hmisCallNext('consultation', '${g5}', 'Specialist only here now')`));
  assert.ok(J(w, 'auditLog').some((a) => a.action === 'Served out of turn') && J(w, 'auditLog').some((a) => a.action === 'Queue priority changed'));
  // not here → back in the line; no-show / finish keep the record
  const g1 = J(w, "queue.find(q => q.patientId === 'QX-1').id");
  finish(w, g1, 'Discharged home');
  const g2 = J(w, "queue.find(q => q.patientId === 'QX-2').id");
  w.eval(`hmisNotHere('${g2}')`);
  assert.equal(J(w, `hmisWaiting('consultation').pop().id`), g2, 'not here → back of the line');
  assert.equal(J(w, 'queue').length, 7, 'every entry kept (history preserved)');
  assert.equal(J(w, "queue.find(q => q.patientId === 'QX-1').status"), 'done');
  const ev = J(w, "queue.find(q => q.patientId === 'QX-1').events").map((x) => x.action);
  assert.deepEqual(ev, ['sent', 'called', 'completed']);
  // no duplicates
  w.eval("hmisPlace('QX-3', 'consultation', {})");
  assert.equal(J(w, "queue.filter(q => q.patientId === 'QX-3').length"), 1);
  // numbers-only public display
  w.eval("hmisOpenDisplay('consultation')");
  const disp = d.getElementById('hmis-display').textContent;
  assert.match(disp, /NOW SERVING/); assert.match(disp, /G-00\d/); assert.ok(!/Queue Patient/.test(disp), 'no names on the public display');
  w.eval('hmisCloseDisplay()');
  b.close();
});

test('two devices: Reception on one, the clinic on another — the patient arrives in the clinic queue; offline duplicates settle to one', async () => {
  const s = makeServer();
  const st = { pos_patients: JSON.stringify(PATIENTS), pos_biz_name: 'Clinic' };
  const reception = await openDevice(APP, s, st, 1500);
  const clinic = await openDevice(APP, s, st, 1500);
  for (const dev of [reception, clinic]) dev.w.eval("showToast = function () {}; window.confirm = () => true");
  await reception.w.eval('pushNow()'); await clinic.w.eval('pullState()');
  fromReception(reception.w, 'PT-2', 'consultation');
  await reception.w.eval('pushNow()');
  await clinic.w.eval('pullState()');
  assert.equal(clinic.w.eval("hmisWaiting('consultation').length"), 1, 'the clinic device sees the patient in its queue');
  assert.equal(clinic.w.eval("hmisCallNext('consultation').patientId"), 'PT-2');
  await clinic.w.eval('pushNow()'); await reception.w.eval('pullState()');
  assert.equal(reception.w.eval("hmisServing('consultation').length"), 1, 'Reception sees them being served');
  // both devices offline put the same NEW patient on the list → after syncing, one active entry on both
  s.state.down = true;
  fromReception(reception.w, 'PT-5', 'triage');
  fromReception(clinic.w, 'PT-5', 'consultation');
  s.state.down = false;
  await reception.w.eval('pushNow()'); await clinic.w.eval('pushNow()');
  await reception.w.eval('pullState()'); await clinic.w.eval('pullState()');
  for (const dev of [reception, clinic]) { dev.w.eval('hmisDedupeQueue()'); assert.equal(dev.w.eval("queue.filter(q => q.patientId === 'PT-5' && q.status !== 'done').length"), 1); }
  assert.equal(reception.w.eval("queue.find(q => q.patientId === 'PT-5' && q.status !== 'done').id"), clinic.w.eval("queue.find(q => q.patientId === 'PT-5' && q.status !== 'done').id"), 'both keep the same one');
  reception.close(); clinic.close();
});

test('stations are configurable: rename, switch off, add a clinic — Reception and the boards follow; config syncs', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("hmisSetStationOverride('eye', 'enabled', false)");
  w.eval("hmisSetStationOverride('consultation', 'label', '🩺 OPD')");
  d.getElementById('hmis-new-station-label').value = '🦻 ENT Clinic'; d.getElementById('hmis-new-station-kind').value = 'clinic'; d.getElementById('hmis-new-station-prefix').value = 'en';
  w.eval('hmisAddCustomStation()');
  w.eval("renderReceptionTab(); onReceptionPatientPicked('PT-1')");
  const card = d.getElementById('reception-search-card').innerHTML;
  assert.ok(!card.includes('Eye Clinic'), 'switched-off station hidden');
  assert.ok(card.includes('🩺 OPD') && card.includes('ENT Clinic'));
  const ent = J(w, "hmisStations().find(s => /ENT/.test(s.label)).id");
  fromReception(w, 'PT-1', ent);
  assert.equal(w.eval('hmisTicket(queue[0])'), 'EN-001');
  tab(w, 'diagnosis-tab');
  assert.match(d.getElementById('diagnosis-station-board').innerHTML, /ENT Clinic/, 'the new clinic has a board on the Clinic tab');
  const payload = J(w, 'collectSyncPayload().hmisStationConfig');
  assert.equal(payload.custom.length, 1, 'the configuration goes to the other devices');
  b.close();
});

test('every station tab is visible in the navigation, and roles still decide who sees what', async () => {
  const b = await app(); const { w, d } = b;
  for (const id of ['reception-tab', 'queue-tab', 'diagnosis-tab', 'emergency-tab', 'maternity-tab', 'labour-tab', 'postnatal-tab', 'child-tab', 'laboratory-tab', 'radiology-tab', 'theatre-tab', 'sales-tab', 'bills-tab', 'referrals-tab', 'discharge-tab', 'patients-tab', 'hospital-report-tab', 'settings-tab']) {
    assert.ok(d.querySelector(`.tab-link[data-tab="${id}"]`), id + ' has a tab button');
    assert.ok(d.getElementById(id), id + ' exists');
  }
  w.eval("staff = [{ id: 'S1', name: 'Nurse Achieng', roles: CLINICAL_ROLE_PRESETS.midwife.tabs.slice() }]; currentServer = { id: 'S1', name: 'Nurse Achieng' }");
  assert.equal(w.eval("isTabLocked('labour-tab')"), false, 'a midwife reaches Labour & Delivery');
  assert.equal(w.eval("isTabLocked('contracts-tab')"), true, 'but not insurance');
  assert.equal(w.eval("isTabLocked('diagnosis-tab')"), true, 'nor the general clinic');
  b.close();
});
