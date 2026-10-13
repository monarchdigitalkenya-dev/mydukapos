import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { boot, ROOT, APPS } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// Zip 247 — payment safety: a typed Admin password / manager PIN before payment or SMS keys change (server-checked, every time), a changed key is HELD
// while the old one keeps working, the owner is alerted, the keys are encrypted in KV, unsigned payment callbacks end at a cutoff, the CORS / manager
// checks on sms-config, payment-accounts, mpesa-stkpush and mpesa-status are tight, and the service worker no longer announces an update that is not one.
const imp = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sealed = (pin, salt = 'saltsalt', iter = 1000) => `p2$${iter}$${salt}$${crypto.pbkdf2Sync(sha(pin), salt, iter, 32, 'sha256').toString('hex')}`;
const hdr = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const adminProof = (pw) => hdr({ a: true, p: sha(pw) });
const mgrProof = (id, pin) => hdr({ s: id, p: sha(pin) });
const STAFF = [
  { id: 'm1', name: 'Manager Mary', pinHash: sealed('7777'), isManager: true, roles: [], updatedAt: 1 },
  { id: 'c1', name: 'Cashier Cate', pinHash: sealed('2222'), roles: ['service-tab', 'hosp-role:cashier', 'perm:payments'], updatedAt: 1 },
  { id: 'w1', name: 'Waiter Wanjiru', pinHash: sealed('1111'), roles: ['service-tab', 'hosp-role:waiter'], updatedAt: 1 },
  { id: 'g1', name: 'Gone Manager', pinHash: sealed('9999'), isManager: true, removed: true, roles: [], updatedAt: 1 },
];
const sync = await imp('pos-sync.js');
const gw = await imp('gateway-config.js');
const gwl = await imp('_gateway-config.js');
const smsc = await imp('sms-config.js');
const box = await imp('_secret-box.js');
const cbk = await imp('_callback-key.js');
const alertMod = await imp('_pay-alert.js');
const lic = await imp('_license.js');

async function shop(opts = {}) {
  const kv = makeKV();
  const env = { mydukapos_kv: kv, LICENSE_CACHE_MS: '0', ...(opts.env || {}) };
  const rec = await lic.createClient(env, 'permanent', 'Makesh Liquor', 'shop', { phone: opts.phone === undefined ? '0712345678' : opts.phone, email: opts.email || '' });
  const id = rec.id;
  const state = { businessName: 'Biz', updatedAt: Date.now(), staff: STAFF };
  if (opts.password !== false) state.pwHash = sealed(opts.password || 'shoppass');
  await sync.onRequestPost({ request: new Request(`https://x.pages.dev/api/pos-sync?c=${id}`, { method: 'POST', body: JSON.stringify(state) }), env, waitUntil() {} });
  return { kv, env, id };
}
const call = async (mod, method, ctx, { body, proof, extra = {}, query = '' } = {}) => {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (proof) headers['X-Pay-Proof'] = proof;
  const request = new Request(`https://x.pages.dev/api/x?c=${ctx.id}${query}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await mod[`onRequest${method[0]}${method.slice(1).toLowerCase()}`]({ request, env: ctx.env, waitUntil() {} });
  let d = {}; try { d = await res.clone().json(); } catch (e) { /* none */ }
  return { status: res.status, d, res };
};
const DARAJA = (n = '1') => ({ mpesaConsumerKey: 'ck' + n, mpesaConsumerSecret: 'SECRETVALUE' + n, mpesaShortcode: '174379', mpesaPasskey: 'pk' + n });
// zip 249: keys saved while the environment is PRODUCTION (real money) — replacing THESE is what the hold guards; sandbox keys are replaced at once (see zip249 test)
const LIVE = (n = '1') => ({ ...DARAJA(n), mpesaEnv: 'production' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 1. the encryption box
test('secret box: round trip; bound to its shop; wrong / missing key is "unreadable"; old key still opens (and asks for a re-seal)', async () => {
  const env = { PAYMENT_SECRETS_KEY: 'k'.repeat(32) };
  const raw = await box.sealRecord(env, 'gateway|A', { paywaveApiKey: 'sk_live_TOPSECRET' });
  assert.ok(!raw.includes('TOPSECRET') && raw.includes('_enc'), 'sealed in KV');
  const ok = await box.openRecord(env, 'gateway|A', raw);
  assert.equal(ok.ok, true); assert.equal(ok.value.paywaveApiKey, 'sk_live_TOPSECRET'); assert.equal(ok.encrypted, true);
  assert.equal((await box.openRecord(env, 'gateway|B', raw)).ok, false, 'another shop\'s record cannot be pasted over this one');
  assert.equal((await box.openRecord({}, 'gateway|A', raw)).ok, false, 'no key set: unreadable (never silently empty)');
  assert.equal((await box.openRecord({ PAYMENT_SECRETS_KEY: 'z'.repeat(32) }, 'gateway|A', raw)).ok, false, 'wrong key');
  const rotated = { PAYMENT_SECRETS_KEY: 'n'.repeat(32), PAYMENT_SECRETS_KEY_OLD: 'k'.repeat(32) };
  const viaOld = await box.openRecord(rotated, 'gateway|A', raw);
  assert.equal(viaOld.ok, true); assert.equal(viaOld.needsSeal, true, 'sealed with the old key: re-seal with the new one');
  // no key configured: plain JSON exactly as before, and a plain record is read
  assert.equal(await box.sealRecord({}, 'x', { a: 1 }), '{"a":1}');
  const plain = await box.openRecord({ PAYMENT_SECRETS_KEY: 'k'.repeat(32) }, 'x', '{"a":1}');
  assert.equal(plain.ok, true); assert.equal(plain.needsSeal, true);
  assert.equal((await box.openRecord(env, 'x', null)).empty, true);
});

// ---------------------------------------------------------------- 2. proof required to change payment settings
test('gateway-config: no proof / wrong password / a cashier\'s PIN / a removed manager are refused; the Admin password and a manager PIN work', async () => {
  const s = await shop();
  const body = DARAJA('1');
  let r = await call(gw, 'POST', s, { body });
  assert.equal(r.status, 401); assert.equal(r.d.code, 'pay_confirm_required');
  r = await call(gw, 'POST', s, { body, proof: adminProof('wrong') });
  assert.equal(r.status, 403); assert.equal(r.d.code, 'pay_confirm_failed');
  r = await call(gw, 'POST', s, { body, proof: mgrProof('c1', '2222') });
  assert.equal(r.status, 403, 'a cashier is not a manager');
  r = await call(gw, 'POST', s, { body, proof: mgrProof('g1', '9999') });
  assert.equal(r.status, 403, 'a removed manager');
  r = await call(gw, 'POST', s, { body, proof: mgrProof('m1', '0000') });
  assert.equal(r.status, 403, 'wrong manager PIN');
  assert.equal((await gwl.loadGatewayConfig(s.env, s.id)).mpesaConsumerKey, '', 'nothing was saved by any refused attempt');
  r = await call(gw, 'POST', s, { body, proof: adminProof('shoppass') });
  assert.equal(r.status, 200, JSON.stringify(r.d)); assert.equal(r.d.confirmedBy, 'Admin');
  assert.equal((await gwl.loadGatewayConfig(s.env, s.id)).mpesaConsumerKey, 'ck1', 'first-time setup applies at once');
  r = await call(gw, 'POST', s, { body: { paywaveApiKey: 'sk_test_x' }, proof: mgrProof('m1', '7777') });
  assert.equal(r.status, 200); assert.equal(r.d.confirmedBy, 'Manager Mary');
  // a proof that is a sealed hash (what a device keeps) is not accepted as the password
  r = await call(gw, 'POST', s, { body: { paywaveApiKey: 'sk_test_y' }, proof: hdr({ a: true, p: sealed('shoppass') }) });
  assert.equal(r.status, 401, 'the sealed hash is not the password');
  // DELETE (reset) needs it too
  r = await call(gw, 'DELETE', s, { body: { which: 'paywave' } });
  assert.equal(r.status, 401);
  r = await call(gw, 'DELETE', s, { body: { which: 'paywave' }, proof: adminProof('shoppass') });
  assert.equal(r.status, 200);
  assert.equal((await gwl.loadGatewayConfig(s.env, s.id)).paywaveApiKey, '');
});

test('a shop with NO password has nothing to prove with: it passes (and is still alerted); a guessing brake stops password guessing', async () => {
  const s = await shop({ password: false });
  const r = await call(gw, 'POST', s, { body: DARAJA('1') });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const t = await shop({ env: { PAY_PROOF_HOURLY_LIMIT: '3' } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await call(gw, 'POST', t, { body: DARAJA('1'), proof: adminProof('guess' + i) })).status);
  assert.deepEqual(codes, [403, 403, 403, 429, 429], 'after 3 wrong tries the shop is slowed down');
});

// ---------------------------------------------------------------- 3. the hold
test('replacing a key the shop already has is HELD: the old key keeps working, GET shows the waiting change, it takes effect after the hold; first-time setup, env mode and the provider choice are immediate; a hold can be cancelled', async () => {
  const s = await shop({ env: { PAYMENT_CHANGE_COOLDOWN_MIN: '0.002' } });      // 0.002 min = 120 ms
  const P = adminProof('shoppass');
  assert.equal((await call(gw, 'POST', s, { body: LIVE('1'), proof: P })).d.held, null, 'first-time setup: immediate');
  const r = await call(gw, 'POST', s, { body: { mpesaConsumerKey: 'NEWKEY', mpesaShortcode: '999999' }, proof: P });
  assert.equal(r.status, 200); assert.deepEqual(r.d.held.providers, ['daraja']); assert.ok(r.d.held.effectiveAt > Date.now() - 50);
  let cfg = await gwl.loadGatewayConfig(s.env, s.id);
  assert.equal(cfg.mpesaConsumerKey, 'ck1', 'the OLD key still works during the hold'); assert.equal(cfg.mpesaShortcode, '174379');
  const g = await call(gw, 'GET', s);
  assert.deepEqual(g.d.pendingChange.providers, ['daraja']); assert.ok(!JSON.stringify(g.d).includes('NEWKEY') && !JSON.stringify(g.d).includes('SECRETVALUE1'), 'GET never returns a key, old or new');
  // non-destination settings and the provider choice are not held
  const imm = await call(gw, 'POST', s, { body: { mpesaEnv: 'production', provider: 'daraja' }, proof: P });
  assert.equal(imm.d.held && imm.d.held.providers.length, 1, 'the earlier hold is still the only one');
  assert.equal((await gwl.loadGatewayConfig(s.env, s.id)).mpesaEnv, 'production');
  await sleep(200);
  cfg = await gwl.loadGatewayConfig(s.env, s.id);
  assert.equal(cfg.mpesaConsumerKey, 'NEWKEY', 'after the hold the new key is the saved one'); assert.equal(cfg.mpesaShortcode, '999999');
  assert.equal(cfg.mpesaConsumerSecret, 'SECRETVALUE1', 'fields not sent are untouched');
  assert.equal((await gwl.getPendingChange(s.env, s.id)), null);

  // cancel
  const s2 = await shop({ env: { PAYMENT_CHANGE_COOLDOWN_MIN: '60' } });
  await call(gw, 'POST', s2, { body: LIVE('1'), proof: P });
  await call(gw, 'POST', s2, { body: { mpesaShortcode: '555555' }, proof: P });
  assert.equal((await call(gw, 'DELETE', s2, { body: { cancelPending: true } })).status, 401, 'cancelling needs the proof too');
  const c = await call(gw, 'DELETE', s2, { body: { cancelPending: true }, proof: P });
  assert.equal(c.d.cancelled, true);
  assert.equal((await gwl.loadGatewayConfig(s2.env, s2.id)).mpesaShortcode, '174379');
  assert.equal(await gwl.getPendingChange(s2.env, s2.id), null);
  // the same value saved again is no change at all; hold 0 disables the hold
  assert.equal((await call(gw, 'POST', s2, { body: { mpesaShortcode: '174379' }, proof: P })).d.held, null);
  const s3 = await shop({ env: { PAYMENT_CHANGE_COOLDOWN_MIN: '0' } });
  await call(gw, 'POST', s3, { body: LIVE('1'), proof: P });
  assert.equal((await call(gw, 'POST', s3, { body: { mpesaShortcode: '1' }, proof: P })).d.held, null);
  assert.equal((await gwl.loadGatewayConfig(s3.env, s3.id)).mpesaShortcode, '1');
  // resetting a provider drops its held change with it
  await call(gw, 'POST', s2, { body: { mpesaShortcode: '888' }, proof: P });
  await call(gw, 'DELETE', s2, { body: { which: 'daraja' }, proof: P });
  assert.equal(await gwl.getPendingChange(s2.env, s2.id), null);
  assert.equal((await gwl.loadGatewayConfig(s2.env, s2.id)).mpesaConsumerKey, '');
});

// ---------------------------------------------------------------- 4. encrypted at rest
test('with PAYMENT_SECRETS_KEY set, payment keys are never plain in KV; a plain record is sealed when touched; an unopenable record is never written over', async () => {
  const KEY = 'q'.repeat(40);
  const s = await shop({ env: { PAYMENT_SECRETS_KEY: KEY } });
  const P = adminProof('shoppass');
  await call(gw, 'POST', s, { body: DARAJA('1'), proof: P });
  const raw = await s.kv.get('gateway-config:v1:' + s.id);
  assert.ok(raw.includes('_enc') && !raw.includes('SECRETVALUE1') && !raw.includes('174379'), 'sealed: ' + raw.slice(0, 80));
  assert.equal((await gwl.loadGatewayConfig(s.env, s.id)).mpesaConsumerSecret, 'SECRETVALUE1', 'and still works');

  // an old plain record (written before this release) is sealed the first time it is read
  const old = await shop({ env: { PAYMENT_SECRETS_KEY: KEY } });
  await old.kv.put('gateway-config:v1:' + old.id, JSON.stringify({ paywaveApiKey: 'sk_live_PLAINONE' }));
  await old.kv.put('sms-config:' + old.id, JSON.stringify({ provider: 'africastalking', atUsername: 'u', atApiKey: 'AT_PLAIN_KEY' }));
  assert.equal((await gwl.loadGatewayConfig(old.env, old.id)).paywaveApiKey, 'sk_live_PLAINONE');
  assert.ok(!(await old.kv.get('gateway-config:v1:' + old.id)).includes('PLAINONE'), 'sealed after the first read');
  const smsStore = await imp('_sms-store.js');
  assert.equal((await smsStore.readSmsConfig(old.env, old.id)).atApiKey, 'AT_PLAIN_KEY');
  assert.ok(!(await old.kv.get('sms-config:' + old.id)).includes('AT_PLAIN_KEY'), 'the SMS account too');

  // the secret is lost / removed: the record is "unreadable" - reads say so, writes refuse, and the record is untouched
  const lost = { ...s, env: { ...s.env, PAYMENT_SECRETS_KEY: undefined } };
  const before = await s.kv.get('gateway-config:v1:' + s.id);
  assert.equal((await gwl.loadGatewayConfig(lost.env, s.id)).secretsUnreadable, true);
  assert.equal((await call(gw, 'GET', lost)).status, 503);
  const w = await call(gw, 'POST', lost, { body: { paywaveApiKey: 'sk_x' }, proof: P });
  assert.equal(w.status, 503); assert.equal(w.d.code, 'secrets_unreadable');
  assert.equal(await s.kv.get('gateway-config:v1:' + s.id), before, 'never overwritten');
  // key rotation: the new key + the old one still opens, and the record is re-sealed with the new one on the next read
  const rot = { ...s.env, PAYMENT_SECRETS_KEY: 'r'.repeat(40), PAYMENT_SECRETS_KEY_OLD: KEY };
  assert.equal((await gwl.loadGatewayConfig(rot, s.id)).mpesaConsumerSecret, 'SECRETVALUE1');
  assert.equal((await gwl.loadGatewayConfig({ ...rot, PAYMENT_SECRETS_KEY_OLD: undefined }, s.id)).mpesaConsumerSecret, 'SECRETVALUE1', 'now sealed with the new key alone');
});

// ---------------------------------------------------------------- 5. the owner is told
test('every change alerts the owner by SMS (the shop\'s own account) - what changed and when, never a key - and is logged; an unanswered channel is reported, never faked', async () => {
  const s = await shop({ env: { PAYMENT_CHANGE_COOLDOWN_MIN: '60' } });
  await s.kv.put('sms-config:' + s.id, JSON.stringify({ provider: 'africastalking', atUsername: 'myuser', atApiKey: 'AT_KEY_1' }));
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: String(init && init.body) }); return new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ status: 'Success', number: '+254712345678' }] } }), { status: 201, headers: { 'Content-Type': 'application/json' } }); };
  try {
    const P = adminProof('shoppass');
    const first = await call(gw, 'POST', s, { body: LIVE('1'), proof: P });
    assert.equal(first.d.alerted, true, 'first-time setup is alerted too: ' + JSON.stringify(first.d));
    const held = await call(gw, 'POST', s, { body: { mpesaShortcode: '424242' }, proof: P });
    assert.equal(held.d.alerted, true);
    const texts = sent.filter((x) => /africastalking/.test(x.url)).map((x) => decodeURIComponent(x.body.replace(/\+/g, ' ')));
    assert.equal(texts.length, 2, 'two alerts: ' + texts.length);
    assert.match(texts[0], /Makesh Liquor/); assert.match(texts[0], /M-Pesa Daraja/); assert.match(texts[0], /Admin/);
    assert.match(texts[1], /start at/); assert.match(texts[1], /OLD keys keep working/); assert.match(texts[1], /Cancel the pending change/);
    for (const t of texts) assert.ok(!/SECRETVALUE|424242|ck1|pk1/.test(t), 'no key or value in an alert: ' + t);
    const log = await alertMod.recentPayChanges(s.env, s.id);
    assert.equal(log.length, 2); assert.equal(log[0].kind, 'held'); assert.equal(log[0].alerted, true); assert.ok(!JSON.stringify(log).includes('424242'));
    assert.equal((await call(gw, 'GET', s)).d.recentChanges.length, 2, 'Settings can show what happened');
  } finally { globalThis.fetch = realFetch; }
  // no SMS account and no phone: nothing is sent and the answer says so (alerted:false), the save still happens
  const bare = await shop({ phone: '' });
  const r = await call(gw, 'POST', bare, { body: DARAJA('1'), proof: adminProof('shoppass') });
  assert.equal(r.status, 200); assert.equal(r.d.alerted, false);
  // the text itself
  const t = alertMod.alertText('Shop', { kind: 'reset', providers: ['kcb'], who: { name: 'Mary' } });
  assert.match(t, /REMOVED/); assert.match(t, /KCB Buni/);
  assert.match(alertMod.eatStamp(Date.UTC(2026, 9, 7, 19, 4)), /^07 Oct 22:04$/, 'Kenya time');
});

// ---------------------------------------------------------------- 6. sms-config
test('sms-config: changing the account needs the proof and alerts; templates and the thank-you switch stay free; the same values saved again are not a change', async () => {
  const s = await shop();
  const P = adminProof('shoppass');
  assert.equal((await call(smsc, 'POST', s, { body: { thankYouTemplate: 'Thanks!' } })).status, 200, 'a template needs no proof');
  assert.equal((await call(smsc, 'POST', s, { body: { autoThankYouEnabled: true } })).status, 200);
  const r = await call(smsc, 'POST', s, { body: { atUsername: 'u', atApiKey: 'AK_SECRET' } });
  assert.equal(r.status, 401); assert.equal(r.d.code, 'pay_confirm_required');
  assert.equal((await call(smsc, 'POST', s, { body: { atUsername: 'u', atApiKey: 'AK_SECRET' }, proof: adminProof('nope') })).status, 403);
  const ok = await call(smsc, 'POST', s, { body: { atUsername: 'u', atApiKey: 'AK_SECRET' }, proof: P });
  assert.equal(ok.status, 200);
  const g = await call(smsc, 'GET', s, { query: '&status=1' });
  assert.equal(g.d.configured, true); assert.ok(!JSON.stringify(g.d).includes('AK_SECRET'));
  assert.equal((await call(smsc, 'POST', s, { body: { atUsername: 'u', atApiKey: 'AK_SECRET', thankYouTemplate: 'Hi' } })).status, 200, 'unchanged keys: no proof needed');
  assert.equal((await call(smsc, 'POST', s, { body: { atApiKey: '' } })).status, 401, 'blanking the key (a reset) is a change');
  // sealed in KV when a secret is set
  const e = await shop({ env: { PAYMENT_SECRETS_KEY: 's'.repeat(40) } });
  await call(smsc, 'POST', e, { body: { atUsername: 'u', atApiKey: 'AK_SEALED' }, proof: P });
  assert.ok(!(await e.kv.get('sms-config:' + e.id)).includes('AK_SEALED'));
});

// ---------------------------------------------------------------- 7. callback keys + cutoff
test('callback keys: keyless shops are given grace keys; unsigned callbacks work until the cutoff, then not; the first signed callback ends the grace; the SMS rail is exempt', async () => {
  const kv = makeKV();
  const before = { mydukapos_kv: kv, CALLBACK_LEGACY_CUTOFF: new Date(Date.now() + 3600e3).toISOString() };
  const after = { mydukapos_kv: kv, CALLBACK_LEGACY_CUTOFF: new Date(Date.now() - 3600e3).toISOString() };
  const URL0 = 'https://x.test/api/mpesa-callback?c=S1';
  // 1. a shop with no key at all
  assert.deepEqual(await cbk.checkCallback(before, 'S1', 'c2b', URL0), { ok: true, legacy: true }, 'before the cutoff: as before');
  assert.equal((await cbk.checkCallback(after, 'S1', 'c2b', URL0)).ok, false, 'after the cutoff: refused');
  assert.equal((await cbk.checkCallback(after, 'S1', 'sms', URL0)).ok, true, 'STOP replies are exempt');
  // 2. grace keys
  const made = await cbk.ensureShopCallbackKeysGrace(before, 'S1');
  assert.deepEqual(made.sort(), ['c2b', 'kcb', 'paywave', 'pesapal', 'stk']);
  assert.deepEqual(await cbk.ensureShopCallbackKeysGrace(before, 'S1'), [], 'nothing more to create');
  assert.deepEqual(await cbk.checkCallback(before, 'S1', 'kcb', URL0), { ok: true, legacy: true }, 'the URL registered earlier keeps working until the cutoff');
  assert.equal((await cbk.checkCallback(after, 'S1', 'kcb', URL0)).ok, false, 'and stops at the cutoff');
  // 3. a callback WITH the key proves the provider moved: the grace ends at once
  const rec = await cbk.getCallbackKey(before, 'S1', 'kcb');
  assert.equal(rec.grace, true);
  assert.deepEqual(await cbk.checkCallback(before, 'S1', 'kcb', URL0 + '&k=' + rec.k), { ok: true, legacy: false });
  assert.equal((await cbk.getCallbackKey(before, 'S1', 'kcb')).grace, undefined, 'grace over');
  assert.equal((await cbk.checkCallback(before, 'S1', 'kcb', URL0)).ok, false, 'unsigned is refused from then on, even before the cutoff');
  assert.equal((await cbk.checkCallback(before, 'S1', 'kcb', URL0 + '&k=wrong')).ok, false);
  // 4. an ordinary key (created by a prompt / registration) never had grace
  const k2 = await cbk.ensureCallbackKey(before, 'S2', 'stk');
  assert.equal(k2.grace, undefined);
  assert.equal((await cbk.checkCallback(before, 'S2', 'stk', URL0)).ok, false);
  // 5. end to end: a Till confirmation without the key, after the cutoff, is quarantined and never becomes a payment the till can see
  const conf = await imp('mpesa-c2b-confirmation.js');
  const kv2 = makeKV(); seedShop(kv2, 'S3');
  const env2 = { mydukapos_kv: kv2, LICENSE_CACHE_MS: '0', CALLBACK_LEGACY_CUTOFF: after.CALLBACK_LEGACY_CUTOFF };
  const post = (e) => conf.onRequestPost({ request: new Request('https://x.pages.dev/api/mpesa-c2b-confirmation?c=S3', { method: 'POST', body: JSON.stringify({ TransID: 'QWE123', TransAmount: '100', MSISDN: '254712345678', BusinessShortCode: '123' }) }), env: e, waitUntil() {} });
  await post(env2);
  assert.ok(await kv2.get('till-payment-rejected:S3:QWE123'), 'quarantined');
  assert.equal(await kv2.get('till-payment:S3:QWE123'), null, 'not a payment');
  const kv3 = makeKV(); seedShop(kv3, 'S4');
  await conf.onRequestPost({ request: new Request('https://x.pages.dev/api/mpesa-c2b-confirmation?c=S4', { method: 'POST', body: JSON.stringify({ TransID: 'QWE124', TransAmount: '100', MSISDN: '254712345678', BusinessShortCode: '123' }) }), env: { mydukapos_kv: kv3, LICENSE_CACHE_MS: '0', CALLBACK_LEGACY_CUTOFF: before.CALLBACK_LEGACY_CUTOFF }, waitUntil() {} });
  assert.ok([...kv3.data.keys()].some((k) => k.startsWith('till-payment') && !k.startsWith('till-payment-rejected')), 'before the cutoff a legacy shop is still paid as before');
  assert.equal(cbk.legacyCutoffMs({}), Date.parse('2026-12-01T00:00:00Z'), 'default cutoff');
  assert.equal(cbk.legacyCutoffMs({ CALLBACK_LEGACY_CUTOFF: 'garbage' }), Date.parse('2026-12-01T00:00:00Z'), 'a bad value falls back to the default');
});

test('opening Settings > Payment Gateway gives a keyless shop its callback keys; the URLs shown then carry them', async () => {
  const s = await shop();
  assert.equal(await cbk.getCallbackKey(s.env, s.id, 'kcb'), null);
  const g = await call(gw, 'GET', s);
  assert.match(g.d.kcbIpnUrl, /&k=[0-9a-f]{32}/);
  assert.equal((await cbk.getCallbackKey(s.env, s.id, 'kcb')).grace, true);
});

// ---------------------------------------------------------------- 8. CORS and staff checks
test('CORS: sms-config, payment-accounts, mpesa-stkpush and mpesa-status never answer with "*"; another website is not handed the answer, the shop\'s own origin is', async () => {
  const s = await shop();
  const mods = { 'sms-config': await imp('sms-config.js'), 'payment-accounts': await imp('payment-accounts.js'), 'mpesa-stkpush': await imp('mpesa-stkpush.js'), 'mpesa-status': await imp('mpesa-status.js') };
  for (const [name, m] of Object.entries(mods)) {
    for (const [origin, allowed] of [['https://evil.example', false], ['https://makesh.mydukapos.store', true], ['http://localhost:8788', true]]) {
      const res = await m.onRequestOptions({ request: new Request(`https://mydukapos.store/api/${name}`, { method: 'OPTIONS', headers: { Origin: origin } }), env: s.env });
      const aco = res.headers.get('Access-Control-Allow-Origin');
      assert.notEqual(aco, '*', name);
      assert.equal(aco === origin, allowed, `${name} ${origin} -> ${aco}`);
      assert.match(res.headers.get('Access-Control-Allow-Headers') || '', /X-Staff-Token/, name);
    }
  }
  // a real answer (not just the preflight) also carries no wildcard
  const r = await mods['mpesa-stkpush'].onRequestGet({ request: new Request(`https://mydukapos.store/api/mpesa-stkpush?c=${s.id}`, { headers: { Origin: 'https://evil.example' } }), env: s.env });
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  const pa = await mods['payment-accounts'].onRequestPost({ request: new Request(`https://mydukapos.store/api/payment-accounts?c=${s.id}`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: JSON.stringify({ action: 'get' }) }), env: s.env });
  assert.equal(pa.headers.get('Access-Control-Allow-Origin'), null);
  for (const f of ['sms-config.js', 'payment-accounts.js', 'mpesa-stkpush.js', 'mpesa-status.js']) assert.ok(!/Access-Control-Allow-Origin['"]?\s*:\s*['"]\*/.test(fs.readFileSync(path.join(ROOT, 'functions/api', f), 'utf8')), f + ' has no wildcard');
});

test('staff sessions required: payment-accounts changes need a manager; payment prompts need the payments permission; payment status needs a session - and nothing changes while the switch is off', async () => {
  const s = await shop();
  const ss = await imp('staff-session.js');
  const login = async (body) => (await (await ss.onRequestPost({ request: new Request(`https://x.pages.dev/api/staff-session?c=${s.id}`, { method: 'POST', body: JSON.stringify(body) }), env: s.env })).json());
  const admin = await login({ admin: true, proof: sha('shoppass') });
  const waiter = await login({ staffId: 'w1', proof: sha('1111') });
  const cashier = await login({ staffId: 'c1', proof: sha('2222') });
  const pa = await imp('payment-accounts.js'), stk = await imp('mpesa-stkpush.js'), st = await imp('mpesa-status.js');
  const accounts = (tok, action = 'add') => call(pa, 'POST', s, { body: { action, name: 'Till 1' }, extra: tok ? { 'X-Staff-Token': tok } : {} });
  // switch OFF: exactly as before
  assert.equal((await accounts(null)).status, 200);
  assert.equal((await call(st, 'GET', s, { query: '&checkoutRequestId=zz' })).d.status, 'unknown');
  // switch ON
  const sm = await imp('_staff-auth.js'); await sm.writeMode(s.env, s.id, 'enforce');
  assert.equal((await accounts(null)).status, 401, 'no session');
  assert.equal((await accounts(cashier.token)).status, 403, 'a cashier is not a manager');
  assert.equal((await accounts(admin.token)).status, 200, 'the Admin may');
  assert.equal((await accounts(null, 'get')).status, 200, 'reading the list stays open');
  const prompt = (tok) => call(stk, 'POST', s, { body: { phone: '0712345678', amount: 10 }, extra: tok ? { 'X-Staff-Token': tok } : {} });
  assert.equal((await prompt(null)).status, 401);
  assert.equal((await prompt(waiter.token)).status, 403, 'a waiter has no payments permission');
  assert.notEqual((await prompt(cashier.token)).status, 403, 'a cashier with payments passes the guard (then "no gateway configured")');
  assert.equal((await prompt(cashier.token)).status, 500);
  assert.equal((await call(st, 'GET', s, { query: '&checkoutRequestId=zz' })).status, 401, 'status needs a session');
  assert.equal((await call(st, 'GET', s, { query: '&checkoutRequestId=zz', extra: { 'X-Staff-Token': cashier.token } })).d.status, 'unknown');
});

test('a payment prompt to one phone number is capped per hour (a leaked link cannot pester a customer); other numbers are unaffected', async () => {
  const rl = await imp('_ratelimit.js');
  const env = { mydukapos_kv: makeKV(), STK_PHONE_HOURLY_LIMIT: '3' };
  const res = [];
  for (let i = 0; i < 5; i++) res.push((await rl.checkRateLimit(env, 'stkPhone', 'S1:254712345678', 1)).ok);
  assert.deepEqual(res, [true, true, true, false, false]);
  assert.equal((await rl.checkRateLimit(env, 'stkPhone', 'S1:254799999999', 1)).ok, true);
  assert.equal(rl.LIMITS.stkPhone({}), 6);
});

// ---------------------------------------------------------------- 9. owner sweep
test('owner-secrets: status reports sealed / plain / grace without ever returning a key; migrate seals everything and issues the callback keys; unauthenticated is refused', async () => {
  const KEY = 'o'.repeat(40);
  const kv = makeKV();
  const env = { mydukapos_kv: kv, LICENSE_CACHE_MS: '0' };
  const a = await lic.createClient(env, 'permanent', 'Alpha', 'shop'), b = await lic.createClient(env, 'permanent', 'Beta', 'shop');
  await kv.put('gateway-config:v1:' + a.id, JSON.stringify({ paywaveApiKey: 'sk_live_ALPHA' }));
  await kv.put('sms-config:' + b.id, JSON.stringify({ atUsername: 'u', atApiKey: 'BETA_KEY' }));
  const os = await imp('owner-secrets.js');
  const oa = await imp('_owner-auth.js');
  const noAuth = await os.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-secrets', { method: 'POST', body: '{}' }), env });
  assert.equal(noAuth.status, 401);
  // sign in as the owner
  await oa.createOwnerAccount(env, 'owner@x.test', 'ownerpass1');
  const acct = await oa.getOwnerAccount(env);
  const token = await oa.createOwnerSession(env, acct);
  const run = async (e, action, offset = 0) => (await (await os.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-secrets', { method: 'POST', headers: { Authorization: 'Bearer ' + (token.token || token) }, body: JSON.stringify({ action, offset, limit: 10 }) }), env: e })).json());
  const st = await run({ ...env, PAYMENT_SECRETS_KEY: KEY }, 'status');
  assert.equal(st.done, true); assert.equal(st.totals.gatewayPlain, 1); assert.equal(st.totals.smsPlain, 1);
  assert.ok(!JSON.stringify(st).includes('sk_live_ALPHA') && !JSON.stringify(st).includes('BETA_KEY'), 'no key in the answer');
  assert.ok(!(await kv.get('gateway-config:v1:' + a.id)).includes('_enc'), 'status changes nothing');
  const mig = await run({ ...env, PAYMENT_SECRETS_KEY: KEY }, 'migrate');
  assert.equal(mig.totals.sealedNow, 2); assert.ok(mig.totals.keysIssued >= 10, 'five rails for each of the two shops');
  assert.ok(!(await kv.get('gateway-config:v1:' + a.id)).includes('sk_live_ALPHA')); assert.ok(!(await kv.get('sms-config:' + b.id)).includes('BETA_KEY'));
  const again = await run({ ...env, PAYMENT_SECRETS_KEY: KEY }, 'status');
  assert.equal(again.totals.gatewayPlain, 0); assert.equal(again.totals.smsPlain, 0); assert.equal(again.totals.railsGrace, 5 * again.total, 'five rails for every shop');
  // no secret set: says so, seals nothing
  const nokey = await run(env, 'migrate');
  assert.equal(nokey.sealing, false); assert.match(nokey.note, /PAYMENT_SECRETS_KEY/);
});

// ---------------------------------------------------------------- 10. the app: pop-up + header
for (const app of APPS) {
  test(`${app}: the pay-confirm block is in place (and is the shared copy)`, () => {
    const html = fs.readFileSync(path.join(ROOT, app), 'utf8');
    assert.match(html, /<!-- @shared-block:pay-confirm:begin -->[\s\S]*PAY CONFIRM \(zip 247\)[\s\S]*<!-- @shared-block:pay-confirm:end -->/);
  });
}

test('the app asks for the Admin password before a payment-gateway save, sends only its SHA-256 as X-Pay-Proof, remembers it for 90 seconds, tells the person about a held change, and a cancelled pop-up sends nothing', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), method: (init && init.method) || 'GET', proof: init && init.headers && (init.headers.get ? init.headers.get('X-Pay-Proof') : init.headers['X-Pay-Proof']) });
    if (/gateway-config/.test(String(url)) && init && init.method === 'POST') return new Response(JSON.stringify({ ok: true, held: { providers: ['daraja'], effectiveAt: Date.now() + 3600e3 }, alerted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const { w, d, close } = await boot('index.html', { fetch, wait: 900, webcrypto: true });
  try {
    const toasts = []; w.eval("showToast = function (t) { window.__toasts = (window.__toasts || []).concat([String(t)]); }");
    // a call that is not a payment change goes straight through
    await w.fetch('/api/gateway-config');
    assert.equal(d.getElementById('pay-confirm-ov'), null, 'reading the settings never asks');
    const sms = w.fetch('/api/sms-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thankYouTemplate: 'x' }) });
    await sms; assert.equal(d.getElementById('pay-confirm-ov'), null, 'a template save never asks');
    // a payment save asks
    const p1 = w.fetch('/api/gateway-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mpesaShortcode: '1' }) });
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(d.getElementById('pay-confirm-ov'), 'the pop-up is shown');
    assert.ok(!seen.some((x) => x.method === 'POST' && /gateway-config/.test(x.url)), 'nothing sent before the password');
    d.getElementById('pay-confirm-pw').value = 'shoppass';
    d.getElementById('pay-confirm-ok').click();
    const res = await p1;
    assert.equal(res.status, 200);
    const sent = seen.find((x) => x.method === 'POST' && /gateway-config/.test(x.url));
    assert.ok(sent && sent.proof, 'the proof header was sent');
    assert.deepEqual(JSON.parse(Buffer.from(sent.proof, 'base64').toString()), { a: true, p: sha('shoppass') }, 'only the SHA-256 - never the password itself');
    assert.ok(!sent.proof.includes('shoppass'));
    await new Promise((r) => setTimeout(r, 80));
    assert.match((w.__toasts || []).join(' | '), /start at/, 'the held change is explained: ' + JSON.stringify(w.__toasts));
    // within 90 seconds the same sitting does not ask again
    await w.fetch('/api/gateway-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mpesaPasskey: 'p' }) });
    assert.equal(d.getElementById('pay-confirm-ov'), null, 'no second prompt');
    // a manager can be chosen and the cancel path sends nothing
    w.eval("window.staff = [{ id: 'm1', name: 'Mary', isManager: true }, { id: 'c1', name: 'Cate' }]");
  } finally { close(); }
  const b2 = await boot('index.html', { fetch, wait: 900, webcrypto: true });
  try {
    const before = seen.length;
    const p = b2.w.fetch('/api/gateway-config', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ which: 'daraja' }) });
    await new Promise((r) => setTimeout(r, 60));
    b2.d.getElementById('pay-confirm-no').click();
    const res = await p;
    assert.equal(res.status, 403); assert.equal((await res.json()).code, 'pay_confirm_cancelled');
    assert.equal(seen.length, before, 'cancelled: no request left the device');
  } finally { b2.close(); }
});

// ---------------------------------------------------------------- 11. the service worker no longer cries "update"
const SW_FILES = ['sw.js', ...['water', 'hotel', 'hospital', 'production', 'services', 'pharmacy', 'owner', 'chama'].map((a) => `${a}/sw.js`)];
function loadSw(file, { fetchImpl, cachesImpl, clients = [], href }) {
  const handlers = {};
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8').replace('NAVIGATION_NETWORK_TIMEOUT_MS = 3500', 'NAVIGATION_NETWORK_TIMEOUT_MS = 40');
  const self = { addEventListener: (t, fn) => { handlers[t] = fn; }, location: { origin: 'https://x.test', href }, skipWaiting() {}, clients: { claim() {}, matchAll: async () => clients } };
  vm.runInNewContext(code, { self, caches: cachesImpl, fetch: fetchImpl, Request, Response, URL, AbortController, setTimeout, clearTimeout, crypto: globalThis.crypto, TextDecoder, TextEncoder, console: { warn() {}, log() {} } });
  return handlers;
}
const memCaches = (initial = {}) => {
  const stores = new Map(Object.entries(initial).map(([n, o]) => [n, new Map(Object.entries(o))]));
  const mk = (name) => { if (!stores.has(name)) stores.set(name, new Map()); const m = stores.get(name); return { match: async (k) => { const key = typeof k === 'string' ? k : k.url || String(k); const hit = m.get(key) || [...m.entries()].find(([kk]) => key.endsWith(kk.replace(/^\./, '')) || kk.endsWith(key)); const v = hit && (Array.isArray(hit) ? hit[1] : hit); return v ? v.clone() : undefined; }, put: async (k, v) => { m.set(typeof k === 'string' ? k : k.url, v); }, delete: async (k) => m.delete(k), keys: async () => [...m.keys()] }; };
  return { open: async (n) => mk(n), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n), stores };
};
const nav = async (handlers, url, kept) => { let p; handlers.fetch({ request: { method: 'GET', url, mode: 'navigate' }, respondWith: (x) => { p = x; }, waitUntil: (x) => kept.push(x) }); return p; };

for (const file of SW_FILES) {
  test(`${file}: the same page with a different ETag is NOT an update; a changed page is announced once; another page opened under this worker is not stored as the app; other apps' windows are not told`, async () => {
    const root = file === 'sw.js' ? '/' : `/${file.split('/')[0]}/`;
    const href = `https://x.test${root}sw.js`;
    const id = /const APP_ID = '([^']*)'/.exec(fs.readFileSync(path.join(ROOT, file), 'utf8'))[1];
    const stores = { [`${id}-shell-pointer`]: { 'https://sw-internal/current-cache-name': new Response(`${id}-shell-abc`) }, [`${id}-shell-abc`]: { './index.html': new Response('THE APP v1') } };
    const caches = memCaches(stores);
    let page = 'THE APP v1', etag = '"a"';
    const told = [];
    const clients = [{ url: `https://x.test${root}?c=1`, postMessage: (m) => told.push(['app', m.type]) }, { url: 'https://x.test/some-other-app/', postMessage: (m) => told.push(['other', m.type]) }];
    const h = loadSw(file, { cachesImpl: caches, clients, href, fetchImpl: async () => new Response(page, { status: 200, headers: { etag } }) });
    const kept = [];
    // 1. first open of this release: same bytes as the stored copy -> silent
    await (await nav(h, `https://x.test${root}?c=1`, kept)).text(); await Promise.all(kept.splice(0));
    assert.deepEqual(told, [], 'identical page: nothing announced');
    // 2. the ETag changes but the bytes do not (a CDN re-labelling the copy): still nothing
    etag = '"b-weak"';
    await (await nav(h, `https://x.test${root}?c=1`, kept)).text(); await Promise.all(kept.splice(0));
    etag = 'W/"c"';
    await (await nav(h, `https://x.test${root}`, kept)).text(); await Promise.all(kept.splice(0));
    assert.deepEqual(told, [], 'a new ETag with identical bytes is not an update');
    // 3. a different page (a receipt / QR-order page opened under this worker) is not stored as the app and does not make the app "differ"
    if (file === 'sw.js') {
      const original = page; page = 'RECEIPT PAGE';
      await (await nav(h, 'https://x.test/order/abc', kept)).text(); await Promise.all(kept.splice(0));
      page = original;
      await (await nav(h, 'https://x.test/?c=1', kept)).text(); await Promise.all(kept.splice(0));
      assert.deepEqual(told, [], 'another page does not trigger an update notice');
      assert.equal(await (await (await caches.open(`${id}-shell-abc`)).match('./index.html')).text(), 'THE APP v1', 'and is not kept as the app\'s page');
    }
    // 4. a REAL new release: announced, once, to this app's window only
    page = 'THE APP v2'; etag = '"d"';
    await (await nav(h, `https://x.test${root}?c=1`, kept)).text(); await Promise.all(kept.splice(0));
    assert.deepEqual(told, [['app', 'app-update-ready']], 'announced to this app\'s window only, once');
    assert.equal(await (await (await caches.open(`${id}-shell-abc`)).match('./index.html')).text(), 'THE APP v2');
    await (await nav(h, `https://x.test${root}?c=1`, kept)).text(); await Promise.all(kept.splice(0));
    assert.equal(told.length, 1, 'the same release again: silent');
    assert.match(fs.readFileSync(path.join(ROOT, file), 'utf8'), /SW_VERSION = 'zip-268'/);
  });
}

// ---------------------------------------------------------------- 12. silent renewal: no password again when the internet returns
test('a session is renewed from the token the device holds - no password: also after being offline for a day or two; refused after 3 days, a changed password / PIN, a removed person, or 14 days since the last typed sign-in', async () => {
  const s = await shop();
  const ss = await imp('staff-session.js'), sa = await imp('_staff-auth.js');
  const login = async (body) => (await (await ss.onRequestPost({ request: new Request(`https://x.pages.dev/api/staff-session?c=${s.id}`, { method: 'POST', body: JSON.stringify(body) }), env: s.env })).json());
  const renew = async (token) => { const r = await ss.onRequestPost({ request: new Request(`https://x.pages.dev/api/staff-session?c=${s.id}`, { method: 'POST', headers: token ? { 'X-Staff-Token': token } : {}, body: JSON.stringify({ action: 'renew' }) }), env: s.env }); return { status: r.status, d: await r.json() }; };
  const admin = await login({ admin: true, proof: sha('shoppass') });
  const a2 = await renew(admin.token);
  assert.equal(a2.status, 200); assert.equal(a2.d.renewed, true); assert.ok(a2.d.exp > admin.exp - 1000);
  assert.equal((await renew(a2.d.token)).status, 200, 'renewal can follow renewal');
  assert.equal((await renew('')).status, 401); assert.equal((await renew('s1.x.y')).status, 401);
  const cashier = await login({ staffId: 'c1', proof: sha('2222') });
  const c2 = await renew(cashier.token); assert.equal(c2.status, 200); assert.deepEqual(c2.d.perms, ['payments']);
  // the phone was off for a day and a half: the token ran out, it still renews
  const key = await sa.shopKey(s.env, s.id);
  const old = await sa.issueSession(s.env, s.id, { id: 'admin', name: 'Admin', perms: ['*'], mgr: true, pfSrc: sa.pfSourceOf(...await (async () => { const st = JSON.parse(await s.kv.get('pos-data:state:' + s.id)); return [st.pwHash, st.adminPwHash]; })()) }, Date.now() - 2 * 86400000);
  assert.equal((await renew(old.token)).status, 200, 'expired 1.3 days ago: renewed');
  const tooOld = await sa.issueSession(s.env, s.id, { id: 'admin', name: 'Admin', perms: ['*'], mgr: true, pfSrc: 'x' }, Date.now() - 4 * 86400000);
  assert.equal((await renew(tooOld.token)).status, 401, 'expired over 3 days ago: sign in once');
  const ancient = await sa.issueSession(s.env, s.id, { id: 'admin', name: 'Admin', perms: ['*'], mgr: true, orig: Date.now() - 15 * 86400000, pfSrc: 'x' });
  assert.equal((await renew(ancient.token)).status, 401, 'last typed sign-in over 14 days ago');
  // a changed PIN ends the cashier's renewal; a removed person too; a changed Admin password ends the Admin's
  const st = JSON.parse(await s.kv.get('pos-data:state:' + s.id));
  st.staff = st.staff.map((m) => (m.id === 'c1' ? { ...m, pinHash: sealed('3333'), updatedAt: 9 } : m));
  st.pwHash = sealed('newpass'); st.updatedAt = Date.now() + 5;
  await sync.onRequestPost({ request: new Request(`https://x.pages.dev/api/pos-sync?c=${s.id}`, { method: 'POST', body: JSON.stringify(st) }), env: s.env, waitUntil() {} });
  assert.equal((await renew(c2.d.token)).status, 401, 'PIN changed');
  assert.equal((await renew(a2.d.token)).status, 401, 'password changed');
});

test('the app renews its own session quietly: a held token close to its end (or ended while offline) is swapped for a fresh one with no prompt; a refusal is not retried every minute', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init && init.method, token: init && init.headers && (init.headers.get ? init.headers.get('X-Staff-Token') : init.headers['X-Staff-Token']), body: init && init.body });
    if (/staff-session/.test(String(url)) && init && init.method === 'POST') return new Response(JSON.stringify({ ok: true, renewed: true, sessionId: 'a'.repeat(20), token: 'NEWTOKEN', secret: 'sec', exp: Date.now() + 16 * 3600e3, name: 'Admin', perms: ['*'] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const { w, close } = await boot('index.html', { fetch, wait: 800 });
  try {
    // an Admin session that ended 6 hours ago (offline overnight)
    w.localStorage.setItem('pos_staff_sessions_v1', JSON.stringify({ admin: { sessionId: 'o'.repeat(20), token: 'OLDTOKEN', secret: 's', exp: Date.now() - 6 * 3600e3, name: 'Admin', perms: ['*'], since: 1, at: 1 } }));
    const ok = await w.staffSessionRenew('admin');
    assert.equal(ok, true);
    const c = calls.find((x) => /staff-session/.test(x.url) && x.method === 'POST');
    assert.equal(c.token, 'OLDTOKEN', 'the held token is the credential'); assert.deepEqual(JSON.parse(c.body), { action: 'renew' }, 'nothing typed, nothing stored');
    assert.equal(JSON.parse(w.localStorage.getItem('pos_staff_sessions_v1')).admin.token, 'NEWTOKEN');
    // plenty of time left: no request at all
    const n = calls.length; assert.equal(await w.staffSessionRenew('admin'), false); assert.equal(calls.length, n);
  } finally { close(); }
});

// ---------------------------------------------------------------- 13. Hotel sub-categories: roomy boxes, add an item directly, update-or-new, dark mode
test('Sub-categories: an item is added straight into a sub-category; an existing name asks UPDATE or ADD AS NEW; both work; the boxes are roomy; dark mode rules are present in every app', async () => {
  const inv = [
    { code: 'M1', type: 'service', name: 'Choc shake', category: 'Milkshakes', price: 200, unit: 'pcs' },
    { code: 'M2', type: 'service', name: 'Vanilla shake', category: 'Milkshakes', price: 100, unit: 'pcs' },
    { code: 'P1', type: 'service', name: 'Pizza', category: 'Mains', price: 800, unit: 'pcs' },
  ];
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(inv) }, wait: 1200 }); const { w, d } = b;
  w.eval('showToast = function (t) { window.__t = (window.__t || []).concat([String(t)]); }; window.confirm = () => true');
  const J = (js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
  const catId = J("hospScreenChips('sales').find(c => /milkshakes/i.test(c.label || c.name || '')).id");
  w.eval(`hospSubOpen('${catId}')`);
  d.getElementById('hosp-sub-new').value = '300ml'; w.eval(`hospSubAdd('${catId}')`);
  const sub = J(`hospSubList('${catId}')`)[0];
  const modal = d.getElementById('hosp-simple-modal');
  assert.match(modal.innerHTML, /hsub-in/); assert.match(modal.innerHTML, /min-height:52px/, 'big boxes');
  assert.ok(d.getElementById('hsub-n-0') && d.getElementById('hsub-p-0'), 'add-item form under the sub-category');
  assert.equal(d.getElementById('hsub-q-0'), null, 'a dish has no stock box');
  // add a brand-new dish
  d.getElementById('hsub-n-0').value = 'Strawberry shake'; d.getElementById('hsub-p-0').value = '250';
  w.eval(`hospSubItemAdd('${catId}','${sub.id}',0)`);
  const made = J("inventory.find(p => p.name === 'Strawberry shake')");
  assert.equal(made.subCat, sub.id); assert.equal(made.type, 'service'); assert.equal(made.price, 250); assert.ok(made.categoryId && made.category === 'Milkshakes');
  // an existing name (different capitals / spaces) asks first and changes nothing yet
  d.getElementById('hsub-n-0').value = 'choc  SHAKE'; d.getElementById('hsub-p-0').value = '220';
  w.eval(`hospSubItemAdd('${catId}','${sub.id}',0)`);
  assert.match(d.getElementById('hosp-simple-modal').innerHTML, /already exists/); assert.match(d.getElementById('hosp-simple-modal').innerHTML, /Update the existing item/); assert.match(d.getElementById('hosp-simple-modal').innerHTML, /Add as a new item/);
  assert.equal(J("inventory.filter(p => /choc/i.test(p.name)).length"), 1); assert.equal(J("inventory.find(p => p.code === 'M1').price"), 200);
  // UPDATE: new price and it goes into the sub-category
  w.eval('hospSubAskUpdate()');
  assert.equal(J("inventory.find(p => p.code === 'M1').price"), 220); assert.equal(J("inventory.find(p => p.code === 'M1').subCat"), sub.id);
  assert.equal(J("inventory.filter(p => /choc/i.test(p.name)).length"), 1, 'no second item');
  // ADD AS NEW: asks for a different name
  d.getElementById('hsub-n-0').value = 'Vanilla shake'; d.getElementById('hsub-p-0').value = '120';
  w.eval(`hospSubItemAdd('${catId}','${sub.id}',0)`);
  const sug = d.getElementById('hsub-ask-name').value; assert.match(sug, /Vanilla shake \(2\)/);
  d.getElementById('hsub-ask-name').value = 'Vanilla shake'; w.eval('hospSubAskNew()');
  assert.equal(J("inventory.filter(p => /vanilla/i.test(p.name)).length"), 1, 'the same name is refused again');
  d.getElementById('hsub-ask-name').value = 'Vanilla shake large'; w.eval('hospSubAskNew()');
  const nv = J("inventory.find(p => p.name === 'Vanilla shake large')");
  assert.equal(nv.subCat, sub.id); assert.equal(nv.price, 120); assert.notEqual(nv.code, 'M2');
  assert.equal(J("inventory.find(p => p.code === 'M2').price"), 100, 'the original is untouched');
  b.close();
});

for (const app of APPS) {
  test(`${app}: dark-mode fix block present; a dish that already exists asks update / add as new`, () => {
    const s = fs.readFileSync(path.join(ROOT, app), 'utf8');
    assert.match(s, /<style id="dark-fix-css">/); assert.match(s, /html\[data-theme="dark"\] \[style\*="background:#f8f9fa"\]/);
    if (app !== 'water/index.html') assert.match(s, /zip 247: a dish \/ service that already exists is not an error either/);
  });
}

// zip 263: per-request rewriting by Cloudflare (random e-mail obfuscation key) is not an update, and the window that was just shown the NEW network copy is not told "newer version"
test('sw.js zip 263: a random e-mail-obfuscation key is not an update; a freshly shown window is not told, another open window is', async () => {
  const mail = (key) => `<p><a href="/cdn-cgi/l/email-protection#${key}" class="__cf_email__" data-cfemail="${key}">[email protected]</a></p>`;
  const stores = { 'minimartpos-shell-pointer': { 'https://sw-internal/current-cache-name': new Response('minimartpos-shell-abc') }, 'minimartpos-shell-abc': { './index.html': new Response('APP v1' + mail('aa11')) } };
  const caches = memCaches(stores);
  let page = 'APP v1' + mail('bb22');
  const told = [];
  const clients = [{ id: 'new', url: 'https://x.test/', postMessage: (m) => told.push(['new', m.type]) }, { id: 'old', url: 'https://x.test/', postMessage: (m) => told.push(['old', m.type]) }];
  const h = loadSw('sw.js', { cachesImpl: caches, clients, href: 'https://x.test/sw.js', fetchImpl: async () => new Response(page, { status: 200 }) });
  const kept = [];
  const open = async () => { let p; h.fetch({ request: { method: 'GET', url: 'https://x.test/', mode: 'navigate' }, resultingClientId: 'new', respondWith: (x) => { p = x; }, waitUntil: (x) => kept.push(x) }); await (await p).text(); await Promise.all(kept.splice(0)); };
  await open(); page = 'APP v1' + mail('cc33'); await open();
  assert.deepEqual(told, [], 'same app, different obfuscation key: silent');
  page = 'APP v2' + mail('dd44'); await open();
  assert.deepEqual(told, [['old', 'app-update-ready']], 'a real release: only the window that was not just shown the new copy is told');
});
