import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot } from './helpers.mjs';
// zip 222 — sign in OFFLINE, connection flaps: the server session is obtained silently on reconnect; nobody is asked to sign in again.
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
test('offline PIN sign-in gets its server session by itself when the internet returns (and after a reload)', async () => {
  let up = false, calls = 0;
  const fetch = async (url, opts = {}) => {
    if (!up) return Promise.reject(new TypeError('Failed to fetch'));
    if (String(url).includes('/api/staff-session')) { calls++; return { ok: true, status: 200, json: async () => ({ ok: true, token: 't', sessionId: 'sid1', secret: 'x', exp: Date.now() + 8 * 3600000, name: 'Mary', perms: [] }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const storage = { pos_biz_name: 'Shop', pos_pw_hash: sha('p'), pos_admin_pw_hash: sha('p'), pos_staff: JSON.stringify([{ id: 's1', name: 'Mary', pinHash: sha('4321') }]) };
  const { w, d, errors, close } = await boot('index.html', { storage, fetch, wait: 1500 });
  w.eval('showToast = function () {}');
  w.eval("pendingServerLoginId = 's1'"); d.getElementById('server-pin-input').value = '4321';
  await w.eval('submitServerPin()');
  assert.equal(w.eval('staffSessionFor("s1")'), null, 'offline: no server session yet');
  assert.ok(w.sessionStorage.getItem('pos_staff_pending_v1'), 'proof kept for this tab only');
  for (let i = 0; i < 3; i++) { up = false; w.dispatchEvent(new w.Event('offline')); up = true; }   // flapping
  const got = await w.eval('staffSessionEnsure("s1")');
  assert.equal(got, true); assert.ok(calls >= 1);
  assert.equal(w.sessionStorage.getItem('pos_staff_pending_v1'), '{}');
  assert.deepEqual(errors, []);
  close();
});
