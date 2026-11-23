// zip 347: a password reset from the Owner Console must let the user in even when the device has not synced yet,
// and a password pasted with a space / line break at the end must still work.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function sealed(h, salt = 'abcd') { return `p2$100000$${salt}$` + crypto.pbkdf2Sync(h, salt, 100000, 32, 'sha256').toString('hex'); }

async function staleDevice() {
  const s = makeServer({ d1: true });
  const oldH = sealed(sha('oldpass'));
  const st = { pwHash: oldH, adminPwHash: oldH, updatedAt: Date.now() - 5000, businessName: 'Biz' };
  s.kv.data.set('pos-data:state:C1', { value: JSON.stringify(st) });
  const a = await openDevice('index.html', s, { pos_biz_name: 'Biz', pos_pw_hash: oldH, pos_admin_pw_hash: oldH, pos_last_synced_at: String(st.updatedAt) }, 1200);
  // the Owner Console resets while this device is not looking
  const now = Date.now(); const st2 = JSON.parse(s.kv.data.get('pos-data:state:C1').value);
  st2.pwHash = sha('Temp1234'); st2.adminPwHash = sha('Temp1234'); st2._fieldTimes = { pwHash: now, adminPwHash: now }; st2.updatedAt = now;
  s.kv.data.set('pos-data:state:C1', { value: JSON.stringify(st2) });
  return a;
}
async function tryLogin(a, pw) {
  a.w.eval("document.getElementById('login-screen').style.display='block'");
  a.w.document.getElementById('login-password-input').value = pw;
  await a.w.eval('loginSubmit()'); await sleep(300);
  return a.w.document.getElementById('login-error').textContent;
}

test('new temporary password works on a device that has not synced the reset yet', async () => {
  const a = await staleDevice();
  assert.equal(await tryLogin(a, 'Temp1234'), '');
  a.close();
});
test('temporary password pasted with a trailing space / line break works', async () => {
  const a = await staleDevice();
  assert.equal(await tryLogin(a, 'Temp1234 \n'), '');
  a.close();
});
test('a wrong password is still refused', async () => {
  const a = await staleDevice();
  assert.match(await tryLogin(a, 'WrongPass9'), /Incorrect password/);
  a.close();
});
test('the old password no longer works after the reset reached the device', async () => {
  const a = await staleDevice();
  await tryLogin(a, 'Temp1234');
  assert.match(await tryLogin(a, 'oldpass'), /Incorrect password/);
  a.close();
});
test('password boxes turn off capitals / auto-correct', async () => {
  const a = await staleDevice();
  const el = a.w.document.getElementById('login-password-input');
  for (let i = 0; i < 40 && el.getAttribute('autocapitalize') !== 'off'; i++) await sleep(250);
  assert.equal(el.getAttribute('autocapitalize'), 'off');
  assert.equal(el.getAttribute('spellcheck'), 'false');
  a.close();
});

test('a device that seals its OLD password after a reset cannot put the old password back on the server', async () => {
  const s = makeServer({ d1: true });
  const oldH = sha('oldpass');
  const t0 = Date.now() - 9000;
  s.kv.data.set('pos-data:state:C1', { value: JSON.stringify({ pwHash: oldH, adminPwHash: oldH, updatedAt: t0, businessName: 'Biz' }) });
  const a = await openDevice('index.html', s, { pos_biz_name: 'Biz', pos_pw_hash: oldH, pos_admin_pw_hash: oldH, pos_last_synced_at: String(t0), pos_hash_seal_ok: '1' }, 1500);
  const now = Date.now(); const st2 = JSON.parse(s.kv.data.get('pos-data:state:C1').value);
  st2.pwHash = sha('Temp1234'); st2.adminPwHash = sha('Temp1234'); st2._fieldTimes = { pwHash: now, adminPwHash: now }; st2.updatedAt = now;
  s.kv.data.set('pos-data:state:C1', { value: JSON.stringify(st2) });
  await a.w.eval('sealStoredHashes()'); await sleep(2500);
  const server = JSON.parse(s.kv.data.get('pos-data:state:C1').value);
  assert.ok(!String(server.pwHash).includes(sha('oldpass').slice(0, 10)) && server.pwHash !== oldH, 'server still has the reset password');
  assert.equal(await tryLogin(a, 'Temp1234'), '');
  a.close();
});

test('a refused password says why (server reached: different password)', async () => {
  const a = await staleDevice();
  const msg = await tryLogin(a, 'WrongPass9');
  assert.match(msg, /Incorrect password/);
  assert.match(msg, /server has a different password|No internet/);
  a.close();
});
