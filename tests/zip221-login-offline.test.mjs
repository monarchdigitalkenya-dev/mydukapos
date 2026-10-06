import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, APPS } from './helpers.mjs';
// zip 221 — login must work ONLINE and OFFLINE in every app: shop password, staff PIN (picker) and personal staff link. All are checked on the device.
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const SHOPS = APPS.filter((a) => a !== 'owner/index.html');
const mkFetch = (mode) => async (url, opts = {}) => {
  if (mode === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
  if (String(url).includes('/api/pos-sync') && (opts.method || 'GET') === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, updatedAt: Date.now() }) };
  return { ok: false, status: 404, json: async () => ({}) };
};
for (const app of SHOPS) for (const mode of ['offline', 'online']) {
  test(`${app}: staff PIN signs in ${mode} (picker and personal link); wrong PIN refused`, async () => {
    const pfx = app.startsWith('water/') ? 'aqua_' : 'pos_';
    const staff = [{ id: 's1', name: 'Mary', pinHash: sha('4321'), role: 'cashier' }];
    const storage = { [pfx + 'biz_name']: 'Shop', [pfx + 'pw_hash']: sha('good-pass'), [pfx + 'admin_pw_hash']: sha('good-pass'), [pfx + 'staff']: JSON.stringify(staff) };
    const { w, d, errors, close } = await boot(app, { storage, fetch: mkFetch(mode), wait: 1500 });
    w.eval('showToast = function () {}');
    // personal link screen
    w.eval("document.getElementById('staff-login-screen').dataset.staffId = 's1'");
    const pin = d.getElementById('staff-login-pin-input');
    if (pin) {
      pin.value = '0000'; await w.eval('submitStaffLogin()');
      assert.match(d.getElementById('staff-login-error').textContent, /incorrect/i);
      pin.value = '4321'; await w.eval('submitStaffLogin()');
      assert.equal(d.getElementById('staff-login-error').textContent, '');
      assert.equal(w.eval('currentServer && currentServer.name'), 'Mary');
      w.eval('currentServer = null');
    }
    // picker
    w.eval("pendingServerLoginId = 's1'");
    const sp = d.getElementById('server-pin-input');
    if (sp) {
      sp.value = '0000'; await w.eval('submitServerPin()');
      assert.match(d.getElementById('server-pin-error').textContent, /incorrect/i);
      sp.value = '4321'; await w.eval('submitServerPin()');
      assert.equal(w.eval('currentServer && currentServer.name'), 'Mary');
    }
    assert.ok(pin || sp, 'app has a PIN entry');
    assert.deepEqual(errors, []);
    close();
  });
}
test('owner console: the password signs in offline and online', async () => {
  for (const mode of ['offline', 'online']) {
    const storage = { pos_pw_hash: sha('good-pass'), pos_admin_pw_hash: sha('good-pass') };
    const { w, d, errors, close } = await boot('owner/index.html', { storage, fetch: mkFetch(mode), wait: 1200 });
    w.eval('showToast = function () {}');
    const pw = d.getElementById('login-password-input');
    if (!pw) { close(); continue; }
    pw.value = 'wrong'; await w.eval('loginSubmit()');
    assert.match(d.getElementById('login-error').textContent, /incorrect/i);
    pw.value = 'good-pass'; await w.eval('loginSubmit()');
    assert.equal(d.getElementById('login-screen').style.display, 'none', mode);
    assert.deepEqual(errors, []);
    close();
  }
});
