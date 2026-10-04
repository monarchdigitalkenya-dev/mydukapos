import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 205: a staff session on the console must never show the red "Could not load dashboard data: owner only" message.
test('staff session: the dashboard shows a friendly note and no red owner-only error', async () => {
  const fetch = async () => ({ ok: false, status: 401, headers: { get: () => 'application/json' }, json: async () => ({ error: 'Owner only' }), text: async () => '{}', clone() { return this; } });
  const { w, d, errors, close } = await boot('owner/index.html', { fetch, wait: 700 });
  await w.eval('consoleStaffMode = true');
  await w.eval('renderDashboard()');
  w.eval("showToast('Could not load dashboard data: owner only — this page is signed in as staff.', true)");
  assert.equal(d.getElementById('toast').classList.contains('show'), false, 'no red toast for staff');
  assert.ok(d.getElementById('dash-staff-note'), 'a friendly note instead');
  w.eval("consoleStaffMode = false; showToast('Real problem', true)");
  assert.equal(d.getElementById('toast').classList.contains('show'), true, 'other errors still show');
  assert.deepEqual(errors, []); close();
});
