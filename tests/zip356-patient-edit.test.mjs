import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';

// zip 356: "I edit a patient's details but nothing happens." A REAL Hospital app talking to the REAL server code: the edit is on screen, on
// the server, survives a second till that has not refreshed (and pushes its old copy), reaches that till, and survives a pull.
// Slow (the Hospital app is large): a few minutes.
const PT = [{ id: 'PT-AAA111', name: 'Jane Wanjiru', phone: '0712345678', sex: 'F', bloodType: 'o+', registeredAt: 1, updatedAt: 1 }];
const quiet = (w) => w.eval('Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || function () {}; showToast = function () {}; window.confirm = function () { return true; }; window.alert = function () {};');
const nameOf = (w) => w.eval("(patients.find(p => p.id === 'PT-AAA111') || {}).name");
const serverP = (s) => (s.serverState().patients || []).find((p) => p.id === 'PT-AAA111') || {};

test('hospital: an edited patient stays edited - on the server, on another till, after a pull; Sex / Blood type are not blanked', { timeout: 900000 }, async () => {
  const s = makeServer();
  const a = await openDevice('hospital/index.html', s, { pos_patients: JSON.stringify(PT) });
  quiet(a.w);
  await a.w.eval('pushNow()');
  await sleep(50);
  const b = await openDevice('hospital/index.html', s, deviceStorage(a.w), 1200);    // till B starts from the same (old) copy
  quiet(b.w);
  a.w.eval("editPatient('PT-AAA111')");
  assert.equal(a.w.eval("document.getElementById('patient-sex-input').value"), 'Female', '"F" is shown as Female, not blank');
  assert.equal(a.w.eval("document.getElementById('patient-blood-type-input').value"), 'O+', '"o+" is shown as O+, not blank');
  a.w.eval("document.getElementById('patient-name-input').value = 'Jane W. Kamau'; document.getElementById('patient-county-input').value = 'Nairobi'; savePatient()");
  assert.equal(nameOf(a.w), 'Jane W. Kamau', 'on screen at once');
  assert.equal(a.w.eval("(patients.find(p => p.id === 'PT-AAA111') || {}).sex"), 'Female', 'sex kept');
  assert.equal(a.w.eval("(patients.find(p => p.id === 'PT-AAA111') || {}).bloodType"), 'O+', 'blood type kept');
  await a.w.eval('pushNow()');                                                       // (the app's own debounced push does the same a moment later)
  assert.ok(await until(() => serverP(s).name === 'Jane W. Kamau', 60000), 'the server has the edit');
  assert.equal(serverP(s).county, 'Nairobi');
  // till B has not refreshed and saves something else: its old copy of the patient must not put the old name back
  b.w.eval("patients.push({ id: 'PT-BBB222', name: 'New Person', registeredAt: Date.now(), updatedAt: Date.now() }); safeSetItem('pos_patients', JSON.stringify(patients))");
  await b.w.eval('pushNow()');
  assert.ok(await until(() => (s.serverState().patients || []).some((p) => p.id === 'PT-BBB222'), 60000), 'B pushed');
  assert.equal(serverP(s).name, 'Jane W. Kamau', 'a stale till did not undo the edit');
  await b.w.eval('pullState()');
  assert.equal(nameOf(b.w), 'Jane W. Kamau', 'the other till shows it');
  await a.w.eval('pullState()');
  assert.equal(nameOf(a.w), 'Jane W. Kamau', 'still there after a pull');
  a.close(); b.close();
});
