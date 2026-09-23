import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// HMIS outpatient pipeline: every station/tab shows a queue, and a patient
// can be explicitly pushed from one stage to the next (Reception, Triage,
// Consultation, Laboratory, Pharmacy, Cashier, etc.) — see PIPELINE_STAGES
// and pushQueueStage() in hospital/index.html. The stage history then has
// to survive onto the patient's permanent visit record, not just live on
// the (transient) queue entry, so the Registry's history view shows it.
const APP = 'hospital/index.html';
const PATIENT = { id: 'PT-1', name: 'Jane Mwangi', age: 30, sex: 'female', phone: '0700000000', allergies: '' };

async function session() {
  const b = await boot(APP, { storage: { pos_patients: JSON.stringify([PATIENT]) }, wait: 1200 });
  b.w.eval("showToast = function () {}; window.confirm = () => true");
  return b;
}

test('joining the queue starts at the Triage stage, with a stage-history entry', async () => {
  const b = await session();
  const { w, d } = b;
  d.getElementById('queue-add-patient-select').innerHTML = '<option value="PT-1">x</option>';
  d.getElementById('queue-add-patient-select').value = 'PT-1';
  w.eval('addPatientToQueue()');
  const entry = JSON.parse(w.eval("JSON.stringify(queue[0])"));
  assert.equal(entry.stage, 'triage');
  assert.equal(entry.stageHistory.length, 1);
  assert.equal(entry.stageHistory[0].stage, 'triage');
  b.close();
});

test('pushQueueStage moves a patient to any named station and appends to their stage history', async () => {
  const b = await session();
  const { w, d } = b;
  d.getElementById('queue-add-patient-select').innerHTML = '<option value="PT-1">x</option>';
  d.getElementById('queue-add-patient-select').value = 'PT-1';
  w.eval('addPatientToQueue()');
  const id = w.eval('queue[0].id');
  w.eval(`pushQueueStage('${id}', 'laboratory')`);
  assert.equal(w.eval('queue[0].stage'), 'laboratory');
  assert.deepEqual(JSON.parse(w.eval("JSON.stringify(queue[0].stageHistory.map(h => h.stage))")), ['triage', 'laboratory']);
  // pushing to a stage that isn't one of the real pipeline stages is a no-op, not silent corruption
  w.eval(`pushQueueStage('${id}', 'not-a-real-stage')`);
  assert.equal(w.eval('queue[0].stage'), 'laboratory', 'an invalid stage id is rejected, not applied');
  b.close();
});

test('starting a consultation advances the stage to Consultation, and finishing the visit copies the whole stage history onto the permanent record', async () => {
  const b = await session();
  const { w, d } = b;
  d.getElementById('queue-add-patient-select').innerHTML = '<option value="PT-1">x</option>';
  d.getElementById('queue-add-patient-select').value = 'PT-1';
  w.eval('addPatientToQueue()');
  const id = w.eval('queue[0].id');
  w.eval(`pushQueueStage('${id}', 'reception')`); // simulate an earlier hop before consultation
  w.eval(`startConsultFromQueue('${id}')`);
  assert.equal(w.eval('queue[0].stage'), 'consultation');
  d.getElementById('visit-diagnosis-input').value = 'Malaria';
  w.eval('saveVisit()');
  const visit = JSON.parse(w.eval('JSON.stringify(visits[0])'));
  assert.deepEqual(visit.stageHistory.map((h) => h.stage), ['triage', 'reception', 'consultation'], 'the FULL hop-by-hop history survived onto the visit, not just the final stage');
  // and it's actually rendered, not just stored
  w.eval(`openPatientVisitModal('PT-1')`);
  const historyHtml = d.getElementById('patient-visit-history-list').innerHTML;
  assert.match(historyHtml, /Triage/);
  assert.match(historyHtml, /Reception/);
  assert.match(historyHtml, /Consultation/);
  b.close();
});

test("opening a patient's record shows their full history: appointments and billing, not just visits and vitals", async () => {
  const b = await session();
  const { w, d } = b;
  w.eval("appointments = [{ id: 'a1', patientId: 'PT-1', patientName: 'Jane Mwangi', scheduledFor: Date.now() - 86400000, reason: 'Follow-up', doctorAssigned: 'Dr. Otieno', type: 'consultation', status: 'completed' }]");
  w.eval("patientCharges = [{ id: 'c1', patientId: 'PT-1', ref: 'REF-1', name: 'Consultation Fee', code: '', qty: 1, price: 500, status: 'paid', createdAt: Date.now() }]");
  w.eval("openPatientVisitModal('PT-1')");
  assert.match(d.getElementById('patient-appointment-history-list').innerHTML, /Follow-up/);
  assert.match(d.getElementById('patient-appointment-history-list').innerHTML, /Dr\. Otieno/);
  assert.match(d.getElementById('patient-billing-history-list').innerHTML, /REF-1/);
  assert.match(d.getElementById('patient-billing-history-list').innerHTML, /Paid/);
  b.close();
});

