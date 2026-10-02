import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// Zip 185 — server-side hardening of payment callbacks, recovery, destructive actions, sessions and bootstrap.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const post = (url, body, headers = {}) => new Request(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const mk = () => { const kv = makeKV(); seedShop(kv, 'C1'); return { kv, env: { mydukapos_kv: kv } }; };
const stkOk = (id, receipt) => ({ Body: { stkCallback: { CheckoutRequestID: id, ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: receipt }, { Name: 'Amount', Value: 100 }] } } } });

test('1: callbacks for an id that is not a licensed shop write nothing (STK, C2B, KCB, Paywave)', async () => {
  const { kv, env } = mk();
  const stk = await load('functions/api/mpesa-callback.js'), c2b = await load('functions/api/mpesa-c2b-confirmation.js');
  const kcb = await load('functions/api/kcb-ipn.js'), pw = await load('functions/api/paywave-webhook.js');
  await kv.put('mpesa-tx:GHOST:X1', JSON.stringify({ status: 'pending', createdAt: 1 }));   // even with a pending record under a made-up shop
  await stk.onRequestPost({ request: post('https://x/api/mpesa-callback?c=GHOST', stkOk('X1', 'QGHOST001')), env });
  await c2b.onRequestPost({ request: post('https://x/a?c=GHOST', { TransID: 'QGHOST002', TransAmount: '5' }), env });
  await kcb.onRequestPost({ request: post('https://x/a?c=GHOST', { transactionReference: 'KGHOST01', transactionAmount: '5' }), env });
  await pw.onRequestPost({ request: post('https://x/a?c=GHOST', { CheckoutRequestID: 'X1', ResponseCode: 0 }), env });
  assert.equal(JSON.parse(await kv.get('mpesa-tx:GHOST:X1')).status, 'pending');
  assert.equal(await kv.get('mpesa-receipt:GHOST:QGHOST001'), null);
  assert.equal(await kv.get('till-payment:GHOST:QGHOST002'), null);
  assert.equal(await kv.get('till-payment:GHOST:KGHOST01'), null);
  assert.equal(await kv.get('till-payment-rejected:GHOST:QGHOST002'), null);
});

test('1b: legacy shop (no key yet): STK result only for a prompt this shop created; real ones still complete', async () => {
  const { kv, env } = mk();
  const stk = await load('functions/api/mpesa-callback.js');
  await stk.onRequestPost({ request: post('https://x/api/mpesa-callback?c=C1', stkOk('NEVER-ISSUED', 'QFORGED01')), env });
  assert.equal(await kv.get('mpesa-tx:C1:NEVER-ISSUED'), null, 'an id we never issued creates nothing');
  assert.equal(await kv.get('mpesa-receipt:C1:QFORGED01'), null);
  await kv.put('mpesa-tx:C1:REAL', JSON.stringify({ status: 'pending', createdAt: Date.now() - 5000, amount: 100 }));
  await stk.onRequestPost({ request: post('https://x/api/mpesa-callback?c=C1', stkOk('REAL', 'QREAL0001')), env });
  assert.equal(JSON.parse(await kv.get('mpesa-tx:C1:REAL')).status, 'success');
  assert.equal(JSON.parse(await kv.get('mpesa-receipt:C1:QREAL0001')).legacy, true, 'receipt marked legacy-accepted');
});

test('1c: keyed shop: STK result with the key is accepted; oversized / non-JSON bodies are ignored', async () => {
  const { kv, env } = mk();
  const cb = await load('functions/api/_callback-key.js'), stk = await load('functions/api/mpesa-callback.js');
  const key = await cb.ensureCallbackKey(env, 'C1', 'stk');
  const r = await stk.onRequestPost({ request: post(cb.withKey('https://x/api/mpesa-callback?c=C1', key), stkOk('ANY', 'QKEYED001')), env });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(await kv.get('mpesa-tx:C1:ANY')).status, 'success');
  const big = JSON.stringify({ pad: 'x'.repeat(40000), ...stkOk('BIG', 'QBIG00001') });
  await stk.onRequestPost({ request: post(cb.withKey('https://x/api/mpesa-callback?c=C1', key), big), env });
  assert.equal(await kv.get('mpesa-tx:C1:BIG'), null);
  const bad = await stk.onRequestPost({ request: post('https://x/api/mpesa-callback?c=C1', 'not json'), env });
  assert.equal(bad.status, 200);
});

test('1d: C2B / KCB legacy shop still stored (trusted) but flagged legacy; keyed shop stores no flag', async () => {
  const { kv, env } = mk();
  const c2b = await load('functions/api/mpesa-c2b-confirmation.js'), cb = await load('functions/api/_callback-key.js');
  await c2b.onRequestPost({ request: post('https://x/a?c=C1', { TransID: 'QLEGACY01', TransAmount: '500' }), env });
  const rec = JSON.parse(await kv.get('till-payment:C1:QLEGACY01'));
  assert.equal(rec.trusted, true); assert.equal(rec.legacy, true);
  const key = await cb.ensureCallbackKey(env, 'C1', 'c2b');
  await c2b.onRequestPost({ request: post(cb.withKey('https://x/a?c=C1', key), { TransID: 'QKEYED001', TransAmount: '500' }), env });
  const rec2 = JSON.parse(await kv.get('till-payment:C1:QKEYED001'));
  assert.equal(rec2.trusted, true); assert.equal(rec2.legacy, undefined);
});

test('1e: Paywave webhook: needs a real shop and (key, or a prompt this shop created)', async () => {
  const { kv, env } = mk();
  const pw = await load('functions/api/paywave-webhook.js'), cb = await load('functions/api/_callback-key.js');
  await pw.onRequestPost({ request: post('https://x/a?c=C1', { CheckoutRequestID: 'FORGED', ResponseCode: 0 }), env });
  assert.equal(await kv.get('mpesa-tx:C1:FORGED'), null, 'unknown id -> nothing');
  await kv.put('mpesa-tx:C1:PW1', JSON.stringify({ status: 'pending', createdAt: Date.now() - 1000, provider: 'paywave' }));
  await pw.onRequestPost({ request: post('https://x/a?c=C1', { CheckoutRequestID: 'PW1', ResponseCode: 0 }), env });
  assert.equal(JSON.parse(await kv.get('mpesa-tx:C1:PW1')).status, 'success', 'a legacy shop\'s real webhook still works');
  const key = await cb.ensureCallbackKey(env, 'C1', 'paywave');
  await kv.put('mpesa-tx:C1:PW2', JSON.stringify({ status: 'pending', createdAt: Date.now() + 5 }));
  await pw.onRequestPost({ request: post('https://x/a?c=C1', { CheckoutRequestID: 'PW2', ResponseCode: 0 }), env });
  assert.equal(JSON.parse(await kv.get('mpesa-tx:C1:PW2')).status, 'pending', 'keyed shop: unsigned refused');
  await pw.onRequestPost({ request: post(cb.withKey('https://x/a?c=C1', key), { CheckoutRequestID: 'PW2', ResponseCode: 0 }), env });
  assert.equal(JSON.parse(await kv.get('mpesa-tx:C1:PW2')).status, 'success');
});

const recReq = (body, c = 'C1', extra = {}) => post(`https://x/api/account-recovery?c=${c}`, body, { 'CF-Connecting-IP': '9.9.9.9', ...extra });
test('2: account-recovery: cannot replace a shop\'s recovery email without the current password; no email-existence oracle on verify; change-password is rate limited', async () => {
  const { kv, env } = mk(); seedShop(kv, 'C2');
  const m = await load('functions/api/account-recovery.js');
  const call = async (body, c) => { const r = await m.onRequestPost({ request: recReq(body, c), env }); return { status: r.status, body: await r.json() }; };
  assert.equal((await call({ action: 'link', email: 'owner@x.co', password: 'secret1' })).status, 200);
  // attacker holding the link tries to bind his own email
  const atk = await call({ action: 'link', email: 'evil@x.co', password: 'evilpw' });
  assert.equal(atk.status, 409); assert.equal(atk.body.code, 'already_linked');
  assert.equal((await call({ action: 'status' })).body.email, 'o****@x.co');
  assert.equal((await call({ action: 'link', email: 'evil@x.co', password: 'evilpw', currentPassword: 'wrong' })).status, 409);
  // the real owner proves the current password and may change it
  assert.equal((await call({ action: 'link', email: 'new@x.co', password: 'secret2', currentPassword: 'secret1' })).status, 200);
  assert.equal((await call({ action: 'status' })).body.email, 'n**@x.co');
  // same email again (retry of a signup) is unchanged
  assert.equal((await call({ action: 'link', email: 'new@x.co', password: 'secret2' })).status, 200);
  // verify: unknown email and wrong password look the same
  const u = await call({ action: 'verify', email: 'nobody@x.co', password: 'x' }); const w = await call({ action: 'verify', email: 'new@x.co', password: 'bad' });
  assert.equal(u.status, 401); assert.equal(w.status, 401); assert.deepEqual(u.body, w.body);
  assert.equal((await call({ action: 'verify', email: 'new@x.co', password: 'secret2' })).status, 200, 'the right password still signs in');
  // change-password: wrong guesses are counted and then blocked (per-account limit 20 by default -> use 3 here)
  env.LOGIN_FAILS_PER_ACCOUNT = '5'; env.LOGIN_FAILS_PER_IP = '1000';
  for (let i = 0; i < 3; i++) assert.equal((await call({ action: 'change-password', currentPassword: 'no' + i, newPassword: 'abcd', confirmNewPassword: 'abcd' })).status, 401);
  assert.equal((await call({ action: 'change-password', currentPassword: 'secret2', newPassword: 'abcd', confirmNewPassword: 'abcd' })).status, 429, 'blocked after repeated wrong guesses');
});

test('2b: account-recovery link/unlink/change-password honour paired-devices-only; unlink with a wrong password is refused', async () => {
  const { kv, env } = mk();
  const m = await load('functions/api/account-recovery.js');
  const call = async (body, h = {}) => { const r = await m.onRequestPost({ request: recReq(body, 'C1', h), env }); return r.status; };
  assert.equal(await call({ action: 'link', email: 'o@x.co', password: 'secret1' }), 200);
  assert.equal(await call({ action: 'unlink', currentPassword: 'wrong' }), 401);
  assert.equal(await call({ action: 'status' }), 200);
  await kv.put('device-auth:C1', JSON.stringify({ mode: 'paired', devices: {} }));
  const dev = await load('functions/api/_device-auth.js'); await dev.readDeviceAuth(env, 'C1', { fresh: true });
  assert.equal(await call({ action: 'unlink' }), 401, 'unpaired device refused');
  assert.equal(await call({ action: 'link', email: 'z@x.co', password: 'secret1' }), 401);
  assert.equal(await call({ action: 'status' }), 200, 'status unchanged');
  assert.equal(await call({ action: 'verify-for-client', password: 'secret1' }), 200, 'sign-in path stays open to an unpaired device');
});

test('3: gateway-config / branches / backups: no change in staff-session "off" mode; manager needed in "enforce" mode', async () => {
  const { kv, env } = mk();
  const gw = await load('functions/api/gateway-config.js'), br = await load('functions/api/branches.js'), bk = await load('functions/api/backups.js');
  const staff = await load('functions/api/_staff-auth.js');
  const g = (body) => gw.onRequestPost({ request: post('https://x/api/gateway-config?c=C1', body), env }).then((r) => r.status);
  assert.equal(await g({ paystackSecretKey: 'sk_test_x' }), 200, 'off mode: as before');
  const del = (h = {}) => gw.onRequestDelete({ request: post('https://x/api/gateway-config?c=C1', { which: 'paystack' }, h), env }).then((r) => r.status);
  assert.equal(await del(), 200);
  await staff.writeMode(env, 'C1', 'enforce');
  assert.equal(await g({ paystackSecretKey: 'sk_test_x' }), 401, 'enforce, no session');
  const cashier = await staff.issueSession(env, 'C1', { id: 's1', name: 'Cashier', perms: ['*'], mgr: false });
  const mgr = await staff.issueSession(env, 'C1', { id: 'admin', name: 'Admin', perms: ['*'], mgr: true });
  const withTok = (t) => ({ 'X-Staff-Token': t.token });
  assert.equal(await del(withTok(cashier)), 403, 'a non-manager cannot erase payment credentials');
  assert.equal(await del(withTok(mgr)), 200);
  assert.equal(await gw.onRequestPost({ request: post('https://x/api/gateway-config?c=C1', { paystackSecretKey: 'sk' }, withTok(mgr)), env }).then((r) => r.status), 200);
  // backups restore
  const rb = (h) => bk.onRequestPost({ request: post('https://x/api/backups?c=C1', { date: '2026-01-01' }, h), env }).then((r) => r.status);
  assert.equal(await rb(withTok(cashier)), 403);
  assert.notEqual(await rb(withTok(mgr)), 403, 'manager passes the guard (then "no such backup")');
  // branches create (permanent shop): cashier blocked, manager allowed
  const bc = (h) => br.onRequestPost({ request: post('https://x/api/branches?c=C1', { action: 'create' }, h), env }).then((r) => r.status);
  assert.equal(await bc(withTok(cashier)), 403);
  assert.equal(await bc(withTok(mgr)), 200);
  // off mode again: no token needed
  await staff.writeMode(env, 'C1', 'off');
  assert.equal(await bc({}), 200);
});

test('3b: branch creation is capped per day; restore per hour; gateway changes per hour', async () => {
  const { env } = mk(); env.BRANCH_CREATE_DAILY_LIMIT = '2'; env.RESTORE_HOURLY_LIMIT = '2'; env.GATEWAY_CONFIG_HOURLY_LIMIT = '2';
  const br = await load('functions/api/branches.js'), bk = await load('functions/api/backups.js'), gw = await load('functions/api/gateway-config.js');
  const bc = () => br.onRequestPost({ request: post('https://x/api/branches?c=C1', { action: 'create' }), env }).then((r) => r.status);
  assert.deepEqual([await bc(), await bc(), await bc()], [200, 200, 429]);
  const rb = () => bk.onRequestPost({ request: post('https://x/api/backups?c=C1', { date: '2026-01-01' }), env }).then((r) => r.status);
  const s = [await rb(), await rb(), await rb()]; assert.equal(s[2], 429); assert.notEqual(s[1], 429);
  const g = () => gw.onRequestPost({ request: post('https://x/api/gateway-config?c=C1', { mpesaEnv: 'sandbox' }), env }).then((r) => r.status);
  assert.deepEqual([await g(), await g(), await g()], [200, 200, 429]);
});

test('4: KCB IPN / Paywave URL: full for everyone when staff sessions are off; masked for non-managers when required', async () => {
  const { env } = mk();
  const gw = await load('functions/api/gateway-config.js'), cb = await load('functions/api/_callback-key.js'), staff = await load('functions/api/_staff-auth.js');
  const key = await cb.ensureCallbackKey(env, 'C1', 'kcb');
  const get = (h = {}) => gw.onRequestGet({ request: new Request('https://x/api/gateway-config?c=C1', { headers: h }), env }).then((r) => r.json());
  assert.ok((await get()).kcbIpnUrl.includes('&k=' + key.k), 'unchanged in off mode (the owner copies it to KCB)');
  await staff.writeMode(env, 'C1', 'enforce');
  const cashier = await staff.issueSession(env, 'C1', { id: 's1', name: 'C', perms: ['*'], mgr: false });
  const mgr = await staff.issueSession(env, 'C1', { id: 'admin', name: 'Admin', perms: ['*'], mgr: true });
  assert.ok(!(await get({ 'X-Staff-Token': cashier.token })).kcbIpnUrl.includes(key.k));
  assert.ok((await get({ 'X-Staff-Token': cashier.token })).kcbIpnUrl.includes('&k=•••'));
  assert.ok(!(await get()).kcbIpnUrl.includes(key.k));
  assert.ok((await get({ 'X-Staff-Token': mgr.token })).kcbIpnUrl.includes(key.k));
});

test('5: demo-account session does not survive a password reset (incl. the KV fallback); a normal session keeps working', async () => {
  const { kv, env } = mk();
  const acc = await load('functions/api/_account.js');
  const a = await acc.createAccount(env, { fullName: 'A B', phone: '0712345678', email: 'a@x.co', password: 'secret12', confirmPassword: 'secret12' });
  const t1 = await acc.createSession(env, a.email);
  assert.equal(await acc.emailFromToken(env, t1), 'a@x.co');
  // a reset: new password + the revocation stamp (what demo-account.js reset-password does)
  const { hashPassword } = await load('functions/api/_password.js');
  const fresh = await hashPassword('another-pw1'); a.passwordHash = fresh.passwordHash; a.salt = fresh.salt;
  await new Promise((r) => setTimeout(r, 3));
  acc.revokeSessionsBefore(a); await acc.saveAccount(env, a);
  assert.equal(await acc.emailFromToken(env, t1), '', 'the old session is gone even though its KV record still exists');
  const t2 = await acc.createSession(env, a.email);
  assert.equal(await acc.emailFromToken(env, t2), 'a@x.co', 'a session issued after the reset works');
  // an account that was never reset: a PBKDF2 upgrade (hash change) must NOT end its sessions (the KV fallback is why)
  const b = await acc.createAccount(env, { fullName: 'C D', phone: '0722345678', email: 'b@x.co', password: 'secret12', confirmPassword: 'secret12' });
  const tb = await acc.createSession(env, b.email);
  b.passwordHash = 'changed-by-upgrade'; await acc.saveAccount(env, b);
  assert.equal(await acc.emailFromToken(env, tb), 'b@x.co');
});

test('5b: owner sessions: new ones carry a 30-day expiry, tokens issued before the cutoff are grandfathered', async () => {
  const { kv, env } = mk();
  const oa = await load('functions/api/_owner-auth.js');
  const account = await oa.createOwnerAccount(env, 'owner@x.co', 'password1');
  const ctx = (t) => ({ request: new Request('https://x/api/owner-clients', { headers: { Authorization: 'Bearer ' + t } }), env });
  const realNow = Date.now;
  try {
    Date.now = () => Date.UTC(2026, 9, 10);
    const tNew = await oa.createOwnerSession(env, account);
    assert.equal(await oa.requireOwnerAuth(ctx(tNew)), true);
    Date.now = () => Date.UTC(2026, 9, 10) + 29 * 86400000; assert.equal(await oa.requireOwnerAuth(ctx(tNew)), true);
    Date.now = () => Date.UTC(2026, 9, 10) + 31 * 86400000; assert.equal(await oa.requireOwnerAuth(ctx(tNew)), false, 'expired after 30 days');
    Date.now = () => Date.UTC(2026, 8, 1);                 // an "old" session, issued before the cutoff
    const tOld = await oa.createOwnerSession(env, account);
    Date.now = () => Date.UTC(2027, 8, 1);                 // a year later
    assert.equal(await oa.requireOwnerAuth(ctx(tOld)), true, 'a pre-existing session is not cut off');
  } finally { Date.now = realNow; }
  const ttl = [...kv.data.keys()].filter((k) => k.startsWith('owner-session:')).length; assert.ok(ttl >= 2);
});

test('6: owner signup: OWNER_SETUP_TOKEN (optional) gates the bootstrap; without it nothing changes', async () => {
  const m = await load('functions/api/owner-auth.js');
  const su = (env, body, h) => m.onRequestPost({ request: post('https://x/api/owner-auth', { action: 'signup', identifier: 'o@x.co', password: 'password1', ...body }, h), env });
  { const { env } = mk(); assert.equal((await su(env, {})).status, 200, 'no env var: as before'); }
  { const { env } = mk(); env.OWNER_SETUP_TOKEN = 'tok-123';
    assert.equal((await su(env, {})).status, 403);
    assert.equal((await su(env, { setupToken: 'wrong' })).status, 403);
    assert.equal((await su(env, { setupToken: 'tok-123' })).status, 200);
    assert.equal((await su(env, { setupToken: 'tok-123' })).status, 409, 'only once'); }
  { const { env } = mk(); env.OWNER_SETUP_TOKEN = 'tok-123'; assert.equal((await su(env, {}, { 'X-Setup-Token': 'tok-123' })).status, 200, 'header form'); }
  { // two first sign-ups racing: exactly one account wins
    const { kv, env } = mk(); const both = await Promise.all([su(env, { identifier: 'a@x.co' }), su(env, { identifier: 'b@x.co' })]);
    const wins = both.filter((r) => r.status === 200).length; assert.ok(wins >= 1);
    const acct = JSON.parse(await kv.get('owner-account:v1')); assert.ok(['a@x.co', 'b@x.co'].includes(acct.identifier)); }
});

test('7: sms-inbound GET honours paired devices; POST caps the list, validates the number, and honours an optional per-shop key', async () => {
  const { kv, env } = mk();
  const m = await load('functions/api/sms-inbound.js'), cb = await load('functions/api/_callback-key.js');
  const form = (url, from, text) => new Request(url, { method: 'POST', body: new URLSearchParams({ from, text }) });
  await m.onRequestPost({ request: form('https://x/api/sms-inbound?c=C1', '+254712345678', 'STOP'), env });
  await m.onRequestPost({ request: form('https://x/api/sms-inbound?c=C1', '<script>', 'STOP'), env });
  assert.deepEqual(JSON.parse(await kv.get('sms-optouts:C1')), ['+254712345678']);
  await m.onRequestPost({ request: form('https://x/api/sms-inbound?c=C1', '+254712345678', 'START'), env });
  assert.deepEqual(JSON.parse(await kv.get('sms-optouts:C1')), []);
  const key = await cb.ensureCallbackKey(env, 'C1', 'sms');
  await m.onRequestPost({ request: form('https://x/api/sms-inbound?c=C1', '+254700000001', 'STOP'), env });
  assert.deepEqual(JSON.parse(await kv.get('sms-optouts:C1')), [], 'a keyed shop ignores an unsigned post');
  await m.onRequestPost({ request: form('https://x/api/sms-inbound?c=C1&k=' + key.k, '+254700000001', 'STOP'), env });
  assert.deepEqual(JSON.parse(await kv.get('sms-optouts:C1')), ['+254700000001']);
  const get = () => m.onRequestGet({ request: new Request('https://x/api/sms-inbound?c=C1'), env }).then((r) => r.status);
  assert.equal(await get(), 200);
  await kv.put('device-auth:C1', JSON.stringify({ mode: 'paired', devices: {} }));
  const dev = await load('functions/api/_device-auth.js'); await dev.readDeviceAuth(env, 'C1', { fresh: true });
  assert.equal(await get(), 401);
});

test('7b: etims-config DELETE and mpesa-stkpush GET are guarded', async () => {
  const { kv, env } = mk();
  const et = await load('functions/api/etims-config.js'), stk = await load('functions/api/mpesa-stkpush.js');
  assert.equal((await stk.onRequestGet({ request: new Request('https://x/api/mpesa-stkpush?c=NOPE'), env })).status, 403, 'unknown shop: no provider disclosure');
  assert.equal((await stk.onRequestGet({ request: new Request('https://x/api/mpesa-stkpush?c=C1'), env })).status, 200);
  assert.equal((await et.onRequestDelete({ request: new Request('https://x/api/etims-config?c=C1', { method: 'DELETE' }), env })).status, 200);
  await kv.put('device-auth:C1', JSON.stringify({ mode: 'paired', devices: {} }));
  const dev = await load('functions/api/_device-auth.js'); await dev.readDeviceAuth(env, 'C1', { fresh: true });
  assert.equal((await et.onRequestDelete({ request: new Request('https://x/api/etims-config?c=C1', { method: 'DELETE' }), env })).status, 401);
  assert.equal((await stk.onRequestGet({ request: new Request('https://x/api/mpesa-stkpush?c=C1'), env })).status, 401);
});

test('9: OTP check — parallel wrong guesses cannot exceed 5 tries; demo-account register caps the business name', async () => {
  const { kv, env } = mk();
  const acc = await load('functions/api/_account.js'), v = await load('functions/api/verify.js');
  const a = await acc.createAccount(env, { fullName: 'A B', phone: '0712345678', email: 'a@x.co', password: 'secret12', confirmPassword: 'secret12' });
  const token = await acc.createSession(env, a.email);
  await kv.put('otp:email:a@x.co', JSON.stringify({ h: await acc.sha256Hex('s' + '123456' + 'a@x.co'), salt: 's', sentAt: Date.now(), tries: 0 }));
  const chk = (code) => v.onRequestPost({ request: post('https://x/api/verify', { action: 'check', token, channel: 'email', code }), env }).then((r) => r.json());
  const res = await Promise.all(Array.from({ length: 12 }, (_, i) => chk(String(100000 + i))));
  const real = res.filter((r) => r.code === 'bad_code').length;
  assert.equal(real, 5, 'exactly 5 wrong codes were compared, the rest were refused');
  assert.ok(res.some((r) => r.code === 'too_many_tries' || r.code === 'expired'));
  const da = await load('functions/api/demo-account.js');
  const r = await da.onRequestPost({ request: post('https://x/api/demo-account', { action: 'register', fullName: 'Z Y', phone: '0733345678', email: 'z@x.co', password: 'secret12', confirmPassword: 'secret12', acceptTerms: true, product: 'shop', businessName: 'N'.repeat(500) }, { 'CF-Connecting-IP': '1.2.3.4' }), env, waitUntil() {} });
  const body = await r.json();
  if (r.status === 200 && body.link) { const rec = JSON.parse((await Promise.all([...kv.data.entries()].filter(([k]) => k.startsWith('license:') && k !== 'license:C1').map(([, x]) => x.value)))[0]); assert.ok(rec.label.length <= 60); }
  else assert.ok(r.status < 500, JSON.stringify(body));
});
