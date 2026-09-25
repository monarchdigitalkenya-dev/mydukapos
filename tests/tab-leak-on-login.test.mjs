import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot } from './helpers.mjs';

// applyServerVisibility() only hides/shows the tab BUTTONS by role — it
// never moved away from whatever tab-content panel was already active
// underneath the login screen. So clocking out while on Settings, then a
// different staff member (or the same device's staff PIN picker) signing
// in, would show that staff member Settings' content for a moment before
// they clicked anywhere themselves — a real leak between accounts sharing
// one device.
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const APPS = ['index.html', 'water/index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];

for (const app of APPS) {
  test(`${app}: clocking out on Settings, then a staff PIN login, does not leave Settings' content showing`, async () => {
    const { w, d, errors, close } = await boot(app, { wait: 1200 });
    w.eval("showToast = function () {};");
    w.eval(`staff.length = 0; staff.push({ id: 's1', name: 'Jane', pinHash: '${sha('1234')}', roles: ['sales-tab'] });`);
    // Simulate: admin was on Settings, then clocked out (login screen shown
    // over whatever was already active — clocking out itself doesn't touch
    // the tab content, exactly like in production).
    w.eval("performTabSwitch(document.getElementById('settings-tab-btn'), 'settings-tab')");
    assert.equal(d.getElementById('settings-tab').classList.contains('active'), true, 'settings really was the active panel before login');
    d.getElementById('login-screen').style.display = 'flex';
    w.eval("currentServer = null; applyServerVisibility();"); // "not serving" state, as at the login picker
    // Now Jane logs in via the staff PIN picker.
    w.eval("pendingLoginStaffId = 's1';");
    d.getElementById('login-staffpin-input').value = '1234';
    await w.eval('submitLoginStaffPin()');
    assert.equal(d.getElementById('settings-tab').classList.contains('active'), false, "Settings' panel is no longer the active one");
    assert.equal(d.getElementById('sales-tab').classList.contains('active'), true, 'landed on Sales Counter instead');
    assert.deepEqual(errors, []);
    // water/index.html's login kicks off a real flushThenPull() chain that
    // keeps rendering afterward (pre-existing, unrelated to this fix); give
    // it a moment to settle before closing so that async work doesn't
    // outlive the test window — a harness-timing artifact, not a bug.
    if (app.startsWith('water/')) await new Promise((r) => setTimeout(r, 1500));
    close();
  });
}

test('index.html: an admin login (who can see every tab) is left exactly where they were — only a role-restricted login forces a switch', async () => {
  const storage = { pos_pw_hash: sha('admin-pass'), pos_admin_pw_hash: sha('admin-pass') };
  const { w, d, errors, close } = await boot('index.html', { storage, wait: 900 });
  w.eval("showToast = function () {};");
  w.eval("performTabSwitch(document.getElementById('settings-tab-btn'), 'settings-tab')");
  d.getElementById('login-screen').style.display = 'flex';
  w.eval("currentServer = null; applyServerVisibility();");
  d.getElementById('login-password-input').value = 'admin-pass';
  await w.eval('loginSubmit()');
  // Not a bug: an admin can see every tab, so there is nothing to leak —
  // ensureActiveTabAllowed() is a safe no-op here, not a forced reset.
  assert.equal(d.getElementById('settings-tab').classList.contains('active'), true);
  assert.deepEqual(errors, []);
  close();
});
