import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { boot, APPS, ROOT } from './helpers.mjs';

// Every module has the SAME sign-up as the shop (one password, plus the login/recovery flow) and the SAME Change Password (one password for everything).
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const SHOPS = APPS.filter((a) => a !== 'owner/index.html');

for (const app of SHOPS) {
  test(`${app}: sign-up form and Change Password are the unified ones (no separate "management password" at sign-up or in Settings)`, () => {
    const html = fs.readFileSync(path.join(ROOT, app), 'utf8');
    for (const id of ['signup-full-name', 'signup-phone', 'signup-biz-name', 'signup-email', 'signup-password', 'signup-password-confirm', 'signup-accept-terms', 'auth-signup-submit-btn', 'change-pw-current', 'change-pw-new', 'change-pw-new-confirm', 'change-pw-msg']) {
      assert.ok(html.includes(`id="${id}"`), `${app} has #${id}`);
    }
    for (const gone of ['biz-admin-password-input', 'biz-admin-password-confirm-input', 'change-admin-current-pw', 'change-login-current-pw', 'onclick="registerBusiness()"', 'onclick="changeAdminPassword()"', 'onclick="changeLoginPassword()"']) {
      assert.ok(!html.includes(gone), `${app} no longer has ${gone}`);
    }
    assert.match(html, /async function submitDirectSignup\(/);
    assert.match(html, /async function changePassword\(/);
    assert.doesNotMatch(html, /function registerBusiness\(/);
  });
}

test('pharmacy: a brand-new device is offered Log In / Sign Up, and signing up creates ONE password used for both the till and the management actions', async () => {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = String(url); calls.push(u.split('?')[0]);
    if (u.includes('/api/demo-account') || u.includes('/api/account-recovery')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (u.includes('/api/pos-sync') && (opts.method || 'GET') === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, updatedAt: Date.now() }) };
    return Promise.reject(new Error('offline'));
  };
  const { w, d, errors, close } = await boot('pharmacy/index.html', { fetch, wait: 1500 });
  assert.equal(d.getElementById('registration-screen').style.display, 'flex', 'first open shows the sign-up screen');
  assert.ok(d.getElementById('auth-choice-login-btn') && d.getElementById('auth-choice-signup-btn'), 'with the Log In / Sign Up choice');
  assert.notEqual(d.getElementById('auth-choice-box').style.display, 'none', 'shown on first open');
  w.eval("showToast = function () {}; showAuthStep('signup')");
  d.getElementById('signup-full-name').value = 'Jane Doe';
  d.getElementById('signup-biz-name').value = 'Jane Pharmacy';
  d.getElementById('signup-phone').value = '0712345678';
  d.getElementById('signup-email').value = 'jane@example.com';
  d.getElementById('signup-password').value = 'secret99';
  d.getElementById('signup-password-confirm').value = 'secret99';
  d.getElementById('signup-accept-terms').checked = true;
  await w.eval('submitDirectSignup()');
  assert.ok(calls.includes('/api/demo-account') && calls.includes('/api/account-recovery'), 'account created and linked on the server');
  assert.equal(w.localStorage.getItem('pos_pw_hash'), sha('secret99'));
  assert.equal(w.localStorage.getItem('pos_admin_pw_hash'), sha('secret99'), 'the same password for management actions');
  assert.equal(w.localStorage.getItem('pos_biz_name'), 'Jane Pharmacy');
  assert.equal(d.getElementById('registration-screen').style.display, 'none');
  assert.deepEqual(errors, []);
  close();
});

test('pharmacy: an EXISTING user with two different passwords keeps both untouched; Change Password (the new method) then sets one password for everything', async () => {
  const storage = { pos_biz_name: 'Old Pharmacy', pos_pw_hash: sha('login-old'), pos_admin_pw_hash: sha('manage-old'), pos_staff: '[]' };
  const fetch = async (url, opts = {}) => (String(url).includes('/api/pos-sync') && (opts.method || 'GET') === 'POST')
    ? { ok: true, status: 200, json: async () => ({ ok: true, updatedAt: Date.now() }) } : Promise.reject(new Error('offline'));
  const { w, d, errors, close } = await boot('pharmacy/index.html', { storage, fetch, wait: 1500 });
  assert.equal(d.getElementById('login-screen').style.display, 'flex', 'returning user goes straight to the login picker');
  assert.equal(w.localStorage.getItem('pos_pw_hash'), sha('login-old'), 'nothing was changed by the update');
  assert.equal(w.localStorage.getItem('pos_admin_pw_hash'), sha('manage-old'));
  w.eval("showToast = function () {}");
  d.getElementById('change-pw-current').value = 'wrong'; d.getElementById('change-pw-new').value = 'brand-new'; d.getElementById('change-pw-new-confirm').value = 'brand-new';
  await w.eval('changePassword()');
  assert.match(d.getElementById('change-pw-msg').textContent, /incorrect/i);
  assert.equal(w.localStorage.getItem('pos_admin_pw_hash'), sha('manage-old'), 'a wrong current password changes nothing');
  d.getElementById('change-pw-current').value = 'login-old';
  await w.eval('changePassword()');
  assert.equal(w.localStorage.getItem('pos_pw_hash'), sha('brand-new'));
  assert.equal(w.localStorage.getItem('pos_admin_pw_hash'), sha('brand-new'), 'now ONE password for everything');
  assert.deepEqual(errors, []);
  close();
});

for (const app of SHOPS) {
  test(`${app}: the "Who's logging in?" list is not torn down and rebuilt when nothing about the people changed`, async () => {
    const pfx = app.startsWith('water') ? 'aqua_' : 'pos_';
    const storage = { [pfx + 'biz_name']: 'Shop', [pfx + 'pw_hash']: sha('x'), [pfx + 'admin_pw_hash']: sha('x'), [pfx + 'staff']: JSON.stringify([{ id: 's1', name: 'Ann', roles: [], pinHash: 'p', updatedAt: 1 }]) };
    const { w, d, close } = await boot(app, { storage, wait: 1200 });
    const list = d.getElementById('login-picker-list');
    const first = list.firstElementChild;
    assert.ok(first, 'the list is drawn');
    w.eval('renderLoginPicker(); renderLoginPicker()');
    assert.equal(list.firstElementChild, first, 'the same buttons are still there (not replaced)');
    w.eval("staff.push({ id: 's2', name: 'Bob', roles: [], pinHash: 'p', updatedAt: 2 }); renderLoginPicker()");
    assert.ok(list.textContent.includes('Bob'), 'but a real change is drawn');
    close();
  });
}

for (const app of SHOPS) {
  test(`${app}: changing the password on the FIRST sync action of a fresh session still stamps _fieldTimes (so it can't be undone by another device's stale push)`, async () => {
    const pwKey = app.startsWith('water/') ? 'aqua_pw_hash' : 'pos_pw_hash';
    const adminKey = app.startsWith('water/') ? 'aqua_admin_pw_hash' : 'pos_admin_pw_hash';
    const storage = { pos_biz_name: 'Biz', [pwKey]: sha('old-pass'), [adminKey]: sha('old-pass'), pos_staff: '[]' };
    let capturedBody = null;
    const fetch = async (url, opts = {}) => {
      if (String(url).includes('/api/pos-sync') && (opts.method || 'GET') === 'POST') {
        // Only capture the push that actually carries the password change —
        // an app may fire an earlier housekeeping push during boot itself.
        const body = JSON.parse(opts.body);
        if (body[pwKey.startsWith('aqua') ? 'pwHash' : 'pwHash'] === sha('new-password')) capturedBody = body;
        return { ok: true, status: 200, json: async () => ({ ok: true, updatedAt: Date.now() }) };
      }
      return Promise.reject(new Error('offline'));
    };
    const { w, d, errors, close } = await boot(app, { storage, fetch, wait: 900 });
    w.eval("showToast = function () {}");
    // Deliberately the FIRST sync-affecting action of this session — no prior edit,
    // no prior push, exactly the scenario where the generic auto-diff stamping
    // mechanism has no baseline yet (see changePassword()'s own comment).
    d.getElementById('change-pw-current').value = 'old-pass';
    d.getElementById('change-pw-new').value = 'new-password';
    d.getElementById('change-pw-new-confirm').value = 'new-password';
    await w.eval('changePassword()');
    assert.ok(capturedBody, 'the password-change push was sent');
    assert.equal(capturedBody.pwHash, sha('new-password'));
    assert.ok(capturedBody._fieldTimes && typeof capturedBody._fieldTimes.pwHash === 'number', 'pwHash is stamped even as the very first push of the session');
    assert.ok(capturedBody._fieldTimes && typeof capturedBody._fieldTimes.adminPwHash === 'number', 'adminPwHash is stamped too');
    assert.deepEqual(errors, []);
    close();
  });
}
