import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, APPS } from './helpers.mjs';

// zip 177: signing in to a till must work with NO internet (it is checked on the device) and just the same with internet.
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const SHOPS = APPS.filter((a) => a !== 'owner/index.html');

for (const app of SHOPS) {
  for (const mode of ['offline', 'online']) {
    test(`${app}: the shop password signs in ${mode}, and a wrong one is refused`, async () => {
      const pfx = app.startsWith('water/') ? 'aqua_' : 'pos_';
      const storage = { [pfx + 'biz_name']: 'Shop', [pfx + 'pw_hash']: sha('good-pass'), [pfx + 'admin_pw_hash']: sha('good-pass'), [pfx + 'staff']: '[]' };
      const fetch = async (url, opts = {}) => {
        if (mode === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
        if (String(url).includes('/api/pos-sync') && (opts.method || 'GET') === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, updatedAt: Date.now() }) };
        return { ok: false, status: 404, json: async () => ({}) };
      };
      const { w, d, errors, close } = await boot(app, { storage, fetch, wait: 1200 });
      w.eval("showToast = function () {}");
      const pw = d.getElementById('login-password-input');
      pw.value = 'wrong'; await w.eval('loginSubmit()');
      assert.match(d.getElementById('login-error').textContent, /incorrect/i);
      pw.value = 'good-pass'; await w.eval('loginSubmit()');
      assert.equal(d.getElementById('login-error').textContent, '', 'no error');
      assert.equal(d.getElementById('login-screen').style.display, 'none', 'login screen closed');
      assert.deepEqual(errors, []);
      close();
    });
  }
}
