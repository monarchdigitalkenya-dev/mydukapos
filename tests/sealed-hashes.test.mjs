import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeServer, openDevice } from './e2e-harness.mjs';
import { until } from './helpers.mjs';
import { proofMatches } from '../functions/api/_device-auth.js';

// Zip 121: salted, slow password / PIN hashes ("p2$..."), upgraded in place with nobody locked out.
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const PW = 'shop-secret', PWH = sha(PW), PIN = '4321';
const STAFF = [{ id: 'st1', name: 'Jane', pinHash: sha(PIN), roles: [], updatedAt: 1 }];
const OLD = String(Date.now() - 5 * 86400000);                      // this device has run zip-121+ for 5 days
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true");
const seal = async (sealedHex, salt) => `p2$100000$${salt}$${sealedHex}`;
const pbkdf2 = (secret, salt) => crypto.pbkdf2Sync(secret, salt, 100000, 32, 'sha256').toString('hex');

test('server: a pairing proof matches a stored hash whichever of the two is sealed', async () => {
  const sealed = await seal(pbkdf2(PWH, 'abc'), 'abc');
  assert.equal(await proofMatches(PWH, PWH), true);
  assert.equal(await proofMatches(PWH, sealed), true, 'typed password vs sealed stored hash');
  assert.equal(await proofMatches(sealed, PWH), true, 'sealed device hash vs a stored hash not yet sealed');
  assert.equal(await proofMatches(sealed, sealed), true);
  assert.equal(await proofMatches(sha('wrong'), sealed), false);
  assert.equal(await proofMatches(await seal(pbkdf2(sha('wrong'), 'abc'), 'abc'), PWH), false);
});

for (const [app, pwKey, staffKey] of [['index.html', 'pos_pw_hash', 'pos_staff'], ['water/index.html', 'aqua_pw_hash', 'aqua_staff']]) {
  test(`${app}: nothing is sealed until every recent device runs zip-121+, then everything is — and sign-in still works`, async () => {
    const s = makeServer();
    const store = { [pwKey]: PWH, [pwKey.replace('_pw_', '_admin_pw_')]: PWH, [staffKey]: JSON.stringify(STAFF), pos_biz_name: 'Biz', aqua_biz_name: 'Biz', pos_release_since: OLD };
    const a = await openDevice(app, s, store, 900, { webcrypto: true }); quiet(a.w);
    // an older till (zip-120) synced recently: the gate stays shut
    await s.fetch('https://x/api/pos-sync', { method: 'POST', body: JSON.stringify({ _till: 'dev_old', _dev: { v: 'zip-120' } }) });
    await a.w.eval("typeof pushNow === 'function' ? pushNow() : doPush()");
    await a.w.eval('sealStoredHashes()');
    assert.equal(a.w.localStorage.getItem(pwKey), PWH, 'not sealed while a zip-120 till is active');
    assert.equal(await a.w.eval(`sealHash('${PWH}')`), PWH, 'new hashes stay in the old form too');

    // the gate opens (in the field: once the old till updates) -> everything on the device is sealed
    a.w.localStorage.setItem('pos_hash_seal_ok', '1');
    assert.equal(await a.w.eval('sealStoredHashes()'), true);
    // a pull already in flight may briefly bring back the server's old form; the stamped push makes the sealed one win
    await until(async () => { await a.w.eval('sealStoredHashes()'); return /^p2\$/.test(a.w.localStorage.getItem(pwKey) || '') && /^p2\$/.test(s.serverState().pwHash || ''); }, 8000);
    const stored = a.w.localStorage.getItem(pwKey);
    assert.match(stored, /^p2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    assert.equal(stored.split('$')[3], pbkdf2(PWH, stored.split('$')[2]), 'standard PBKDF2-SHA256 of the old hash');
    assert.equal(await a.w.eval(`sealHash('${PWH}')`), stored, 'the same password seals to the same value on every device of the shop');
    const pin = a.w.eval('staff[0].pinHash');
    assert.match(pin, /^p2\$/, 'staff PINs sealed');
    assert.equal(await a.w.eval(`hashMatches('${sha(PIN)}', staff[0].pinHash)`), true);
    assert.equal(await a.w.eval(`hashMatches('${sha('0000')}', staff[0].pinHash)`), false);

    // signing in with the password still works; a wrong one is refused
    const login = async (pw) => {
      a.w.document.getElementById('login-screen').style.display = 'flex';
      a.w.document.getElementById('login-password-input').value = pw;
      await a.w.eval('loginSubmit()');
      return a.w.document.getElementById('login-screen').style.display === 'none';
    };
    assert.equal(await login('nope'), false);
    assert.equal(await login(PW), true, 'the right password opens the till after sealing');
    await new Promise((r) => setTimeout(r, 800));                              // let the sign-in's own background work finish
    a.close();
  });
}

test('the gate opens by itself once the device list shows only zip-121+ devices', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_pw_hash: PWH, pos_admin_pw_hash: PWH, pos_biz_name: 'Biz', pos_release_since: OLD }, 900, { webcrypto: true }); quiet(a.w);
  await a.w.eval('pushNow()');                                                   // this device (zip-121) is now in the shop's device list
  await a.w.eval('window.__sealGateAt = 0; sealStoredHashes()');
  assert.equal(a.w.localStorage.getItem('pos_hash_seal_ok'), '1');
  assert.match(a.w.localStorage.getItem('pos_pw_hash'), /^p2\$/);
  // ...and the sealed hash reaches the server, where a new device pairs with the typed password
  await a.w.eval('pushNow()');
  const pair = async (proof) => (await s.fetch('https://x/api/device-pair', { method: 'POST', body: JSON.stringify({ action: 'pair', deviceId: 'dev_new', proof }) })).status;
  assert.match(s.serverState().pwHash, /^p2\$/);
  assert.equal(await pair(PWH), 200, 'typed password vs sealed stored hash');
  assert.equal(await pair(sha('guess')), 403);
  a.close();
});

test('a brand-new device (under 3 days on this release) does not seal', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_pw_hash: PWH, pos_biz_name: 'Biz' }, 900, { webcrypto: true }); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('sealStoredHashes()');
  assert.equal(a.w.localStorage.getItem('pos_pw_hash'), PWH);
  assert.ok(Number(a.w.localStorage.getItem('pos_release_since')) > Date.now() - 60000, 'the clock started when it first ran this release');
  a.close();
});

test('"paired only": a sealed hash (what a lost or revoked device holds) cannot pair — the password can', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_pw_hash: PWH, pos_admin_pw_hash: PWH, pos_biz_name: 'Biz', pos_hash_seal_ok: '1' }, 900, { webcrypto: true }); quiet(a.w);
  await a.w.eval('sealStoredHashes()'); await a.w.eval('pushNow()');
  const sealed = a.w.localStorage.getItem('pos_pw_hash');
  await a.w.eval('devicePairNow()');
  assert.ok(a.w.localStorage.getItem('pos_device_token'), 'open shop: pairs itself in the background with the sealed hash it holds');
  const h = { 'X-Device-Id': a.w.eval('getOrCreateDeviceId()'), 'X-Device-Token': a.w.localStorage.getItem('pos_device_token') };
  const post = (body, headers = {}) => s.fetch('https://x/api/device-pair', { method: 'POST', body: JSON.stringify(body), headers });
  assert.equal((await post({ action: 'mode', mode: 'paired', proof: sealed }, h)).status, 403, 'switching needs the password itself');
  assert.equal((await post({ action: 'mode', mode: 'paired', proof: PWH }, h)).status, 200);
  assert.equal((await post({ action: 'pair', deviceId: 'dev_thief', proof: sealed })).status, 403, 'a copied/revoked device cannot re-pair');
  assert.equal((await post({ action: 'pair', deviceId: 'dev_new', proof: PWH })).status, 200, 'the shop password still pairs');
  a.close();
});

test('"Stay signed in" survives the password hash being sealed', async () => {
  const s = makeServer();
  const keep = JSON.stringify({ at: Date.now(), fp: PWH, role: 'admin' });
  const a = await openDevice('index.html', s, { pos_pw_hash: PWH, pos_biz_name: 'Biz', pos_hash_seal_ok: '1', pos_stay_signed_in: '1', pos_session_keep: keep }, 900, { webcrypto: true }); quiet(a.w);
  await a.w.eval('sealStoredHashes()');
  const fp = JSON.parse(a.w.localStorage.getItem('pos_session_keep')).fp;
  assert.equal(fp, a.w.localStorage.getItem('pos_pw_hash'));
  assert.match(fp, /^p2\$/);
  a.close();
});
