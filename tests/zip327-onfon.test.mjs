import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { boot, ROOT, APPS } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
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
const smsc = await imp('sms-config.js');
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

const onf = await imp('_onfon.js');
const smsSend = await imp('sms-send.js');
const smsTest = await imp('sms-test.js');
const CFG = { onfonAccessKey: 'ACCESS_SECRET_111', onfonApiKey: 'APIKEY_SECRET_222', onfonClientId: 'CLIENT_333', onfonSenderId: 'MYDUKA' };
const OK = (rows) => ({ ErrorCode: 0, ErrorDescription: 'Success', Data: rows || [{ MessageErrorCode: 0, MessageErrorDescription: 'Success', MobileNumber: '254712345678', MessageId: 'MSG-1' }] });
// a fetch that records every request and answers from a script
function net(answer) { const calls = []; const f = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? (() => { try { return JSON.parse(init.body); } catch (e) { return String(init.body); } })() : null }); const a = typeof answer === 'function' ? await answer(calls.length, String(url)) : answer; if (a instanceof Error) throw a; return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status || 200 }); }; f.calls = calls; return f; }
const saveOnfon = async (s, extra = {}) => { const r = await call(smsc, 'POST', s, { body: { provider: 'onfon', ...CFG, ...extra }, proof: adminProof('shoppass') }); assert.equal(r.status, 200, JSON.stringify(r.d)); };
const ctxWith = (s, f) => ({ request: null, env: s.env, waitUntil() {}, fetchImpl: f });
const callTest = async (s, f, method, { body, query = '' } = {}) => { const request = new Request(`https://x.pages.dev/api/sms-test?c=${s.id}${query}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const res = await smsTest[`onRequest${method[0]}${method.slice(1).toLowerCase()}`]({ request, env: s.env, waitUntil() {}, fetchImpl: f }); let d = {}; try { d = await res.clone().json(); } catch (e) { /* none */ } return { status: res.status, d, text: await res.clone().text() }; };

test('Kenyan phone normalisation for Onfon: local, +254, 254, 9-digit, international; junk is refused (never guessed)', () => {
  for (const [i, o] of [['0712345678', '254712345678'], ['0112 345 678', '254112345678'], ['+254712345678', '254712345678'], ['254712345678', '254712345678'], ['712345678', '254712345678'], ['+44 7911 123456', '447911123456'], ['0044 7911 123456', '447911123456'], ['12345', ''], ['', ''], ['abc', ''], ['0912345678', '']]) assert.equal(onf.onfonNumber(i), o, i);
});

test('request: the documented URL, AccessKey header, SenderId + MessageParameters[{Number,Text}] + ApiKey + ClientId; HTTPS', async () => {
  const f = net({ body: OK() });
  const r = await onf.sendViaOnfon(CFG, ['+254712345678'], 'Hello', { fetch: f });
  assert.equal(r.success, true); assert.equal(r.sentCount, 1); assert.equal(r.recipients[0].messageId, 'MSG-1');
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.onfonmedia.co.ke/v1/sms/SendBulkSMS'); assert.equal(c.method, 'POST');
  assert.equal(c.headers.AccessKey, 'ACCESS_SECRET_111'); assert.equal(c.headers['Content-Type'], 'application/json');
  assert.deepEqual(c.body, { SenderId: 'MYDUKA', MessageParameters: [{ Number: '254712345678', Text: 'Hello' }], ApiKey: 'APIKEY_SECRET_222', ClientId: 'CLIENT_333' });
  assert.ok(!c.url.includes('SECRET'), 'no credential in the URL of a send');
});

test('HTTP 200 is not success: the application ErrorCode decides - credentials, sender, credits, recipient, account, IP, rate, service, unknown', async () => {
  const cases = [['credentials', 'Invalid API key'], ['sender', 'Sender ID not approved'], ['credits', 'Insufficient credits'], ['recipient', 'Invalid mobile number'], ['account', 'Account is locked'], ['ip', 'IP address is not whitelisted'], ['rate', 'Too many requests'], ['service', 'Internal server error'], ['unknown', 'Something odd']];
  for (const [kind, desc] of cases) {
    const r = await onf.sendViaOnfon(CFG, ['0712345678'], 'x', { fetch: net({ body: { ErrorCode: 9, ErrorDescription: desc, Data: [] } }) });
    assert.ok(r.error, kind); assert.equal(r.kind, kind, desc); assert.ok(!r.success);
    assert.ok(!JSON.stringify(r).includes('SECRET'));
  }
  // one recipient accepted, one refused: counted separately
  const mixed = await onf.sendViaOnfon(CFG, ['0712345678', '0722333444'], 'x', { fetch: net({ body: OK([{ MessageErrorCode: 0, MessageErrorDescription: 'Success', MobileNumber: '254712345678', MessageId: 'A' }, { MessageErrorCode: 5, MessageErrorDescription: 'Invalid number', MobileNumber: '254722333444' }]) }) });
  assert.equal(mixed.sentCount, 1); assert.equal(mixed.failedCount, 1);
  // not JSON / 401 / no ErrorCode
  assert.equal((await onf.sendViaOnfon(CFG, ['0712345678'], 'x', { fetch: net({ status: 401, body: 'Unauthorized' }) })).kind, 'credentials');
  assert.ok((await onf.sendViaOnfon(CFG, ['0712345678'], 'x', { fetch: net({ body: { hello: 1 } }) })).error);
  // an invalid number is refused BEFORE any request
  const f = net({ body: OK() }); const bad = await onf.sendViaOnfon(CFG, ['12'], 'x', { fetch: f }); assert.ok(bad.error); assert.equal(f.calls.length, 0);
});

test('timeout / dropped connection: reported as uncertain and NEVER retried', async () => {
  const f = net(() => new Promise(() => {}));                 // never answers
  const r = await onf.sendViaOnfon(CFG, ['0712345678'], 'x', { fetch: f, timeoutMs: 30 });
  assert.equal(r.uncertain, true); assert.match(r.error, /NOT sent again|not sent again/i); assert.equal(f.calls.length, 1, 'one attempt only');
  const g = net(new Error('socket hang up')); const r2 = await onf.sendViaOnfon(CFG, ['0712345678'], 'x', { fetch: g });
  assert.equal(r2.uncertain, true); assert.equal(g.calls.length, 1);
});

test('balance: parsed from the response, never invented; auth + insufficient + malformed handled', async () => {
  const f = net({ body: { ErrorCode: 0, ErrorDescription: 'Success', Data: [{ PluginType: 'SMS', Credits: '1,234.50' }] } });
  const b = await onf.onfonBalance(CFG, { fetch: f });
  assert.equal(b.ok, true); assert.equal(b.balance, 1234.5);
  assert.ok(f.calls[0].url.startsWith('https://api.onfonmedia.co.ke/v1/sms/Balance')); assert.equal(f.calls[0].method, 'GET'); assert.equal(f.calls[0].headers.AccessKey, 'ACCESS_SECRET_111');
  assert.equal((await onf.onfonBalance(CFG, { fetch: net({ body: { ErrorCode: 9, ErrorDescription: 'Invalid access key' } }) })).kind, 'credentials');
  const none = await onf.onfonBalance(CFG, { fetch: net({ body: { ErrorCode: 0, ErrorDescription: 'Success', Data: [] } }) });
  assert.ok(none.error && none.balance === undefined, 'no figure -> no invented number');
  assert.ok((await onf.onfonBalance(CFG, { fetch: net({ status: 500, body: 'oops' }) })).error);
});

test('routing: Onfon sends only when it is the selected, enabled provider; no silent fallback; other providers never touch Onfon', async () => {
  const real = globalThis.fetch;
  try {
    for (const [cfg, expectUrl] of [[{ provider: 'onfon', ...CFG }, 'onfonmedia'], [{ provider: 'africastalking', atUsername: 'u', atApiKey: 'k', ...CFG }, 'africastalking'], [{ provider: 'talksasa', talksasaApiKey: 'k', talksasaSenderId: 's', ...CFG }, 'talksasa']]) {
      const f = net({ body: expectUrl === 'onfonmedia' ? OK() : { SMSMessageData: { Message: 'ok', Recipients: [{ number: '+254712345678', status: 'Success', statusCode: 101 }] }, status: 'success' } });
      globalThis.fetch = f;
      await smsSend.dispatchSms(cfg, ['+254712345678'], 'hi');
      assert.equal(f.calls.length, 1); assert.ok(f.calls[0].url.includes(expectUrl), f.calls[0].url);
    }
    // disabled: nothing leaves the building, an error says so, and no other provider is tried
    const f2 = net({ body: OK() }); globalThis.fetch = f2;
    const off = await smsSend.dispatchSms({ provider: 'onfon', onfonEnabled: false, ...CFG, atUsername: 'u', atApiKey: 'k' }, ['+254712345678'], 'hi');
    assert.equal(off.status, 400); assert.match(off.error, /turned off/i); assert.equal(f2.calls.length, 0);
    // incomplete: same, never a fallback
    const inc = await smsSend.dispatchSms({ provider: 'onfon', onfonApiKey: 'x', atUsername: 'u', atApiKey: 'k' }, ['+254712345678'], 'hi');
    assert.equal(inc.status, 400); assert.equal(f2.calls.length, 0);
  } finally { globalThis.fetch = real; }
});

test('settings: saved sealed, secrets never come back, changing credentials needs the proof, tenants are separate, other providers keep their keys', async () => {
  const a = await shop({ env: { PAYMENT_SECRETS_KEY: 'k'.repeat(32) } }), b = await shop({ env: { PAYMENT_SECRETS_KEY: 'k'.repeat(32) } });
  await call(smsc, 'POST', a, { body: { atUsername: 'u', atApiKey: 'AT_KEEP_ME' }, proof: adminProof('shoppass') });
  assert.equal((await call(smsc, 'POST', a, { body: { provider: 'onfon', ...CFG } })).status, 401, 'no proof: refused');
  await saveOnfon(a);
  const raw = await a.kv.get('sms-config:' + a.id);
  for (const k of ['ACCESS_SECRET_111', 'APIKEY_SECRET_222', 'AT_KEEP_ME']) assert.ok(!raw.includes(k), k + ' is sealed in storage');
  const g = await call(smsc, 'GET', a, {});
  assert.equal(g.d.provider, 'onfon'); assert.equal(g.d.configured, true); assert.deepEqual(g.d.onfon, { hasAccessKey: true, hasApiKey: true, clientId: 'CLIENT_333', senderId: 'MYDUKA', enabled: true });
  assert.ok(!JSON.stringify(g.d).includes('SECRET') && !JSON.stringify(g.d).includes('AT_KEEP_ME'), 'no secret in the answer');
  const stored = await (await imp('_sms-store.js')).readSmsConfig(a.env, a.id);
  assert.equal(stored.atApiKey, 'AT_KEEP_ME', 'the other provider\'s keys were not overwritten');
  const gb = await call(smsc, 'GET', b, {});
  assert.notEqual(gb.d.provider, 'onfon'); assert.equal(gb.d.onfon.hasAccessKey, false, 'another shop has none of it');
  // disable without touching the keys
  assert.equal((await call(smsc, 'POST', a, { body: { onfonEnabled: false } })).status, 200);
  const g2 = await call(smsc, 'GET', a, {}); assert.equal(g2.d.onfon.enabled, false); assert.equal(g2.d.onfon.hasApiKey, true);
});

test('test SMS and balance: use only the saved credentials, answer from Onfon\'s real result, redact secrets, log without secrets, rate-limit, one send per double tap', async () => {
  const s = await shop(); await saveOnfon(s);
  const f = net({ body: OK() });
  const r = await callTest(s, f, 'POST', { body: { to: '0712 345 678' } });
  assert.equal(r.status, 200); assert.equal(r.d.ok, true); assert.equal(r.d.messageId, 'MSG-1'); assert.match(r.d.note, /not proof/i);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.MessageParameters[0].Number, '254712345678');
  assert.ok(!r.text.includes('SECRET'), 'no secret in the answer');
  // a double tap does not send twice
  const again = await callTest(s, f, 'POST', { body: { to: '0712345678' } });
  assert.equal(again.status, 429); assert.equal(f.calls.length, 1);
  // a failure is shown as a failure (HTTP 200 + ErrorCode)
  const bad = await callTest(s, net({ body: { ErrorCode: 7, ErrorDescription: 'Insufficient credits' } }), 'POST', { body: { to: '0722000111' } });
  assert.equal(bad.status, 502); assert.equal(bad.d.ok, false); assert.match(bad.d.error, /credits/i);
  assert.equal((await callTest(s, f, 'POST', { body: { to: 'nonsense' } })).status, 400);
  const bal = await callTest(s, net({ body: { ErrorCode: 0, ErrorDescription: 'Success', Data: [{ PluginType: 'SMS', Credits: '88' }] } }), 'GET', { query: '&action=balance' });
  assert.equal(bal.d.ok, true); assert.equal(bal.d.balance, 88);
  const log = JSON.parse(await s.kv.get('sms-log:' + s.id));
  assert.ok(log.length >= 3 && log.every((e) => !JSON.stringify(e).includes('SECRET') && !JSON.stringify(e).includes('Hello')));
  assert.ok(log.some((e) => e.kind === 'test' && e.ok === true && /\*\*\*\*/.test(e.to)), 'the number is masked');
});

test('test SMS refuses when Onfon is not the provider, not saved, or turned off; another shop cannot use this shop\'s credentials', async () => {
  const s = await shop(); const f = net({ body: OK() });
  assert.equal((await callTest(s, f, 'POST', { body: { to: '0712345678' } })).status, 400, 'not selected');
  await saveOnfon(s, { onfonApiKey: '' });
  assert.equal((await callTest(s, f, 'POST', { body: { to: '0712345678' } })).status, 400, 'incomplete');
  await saveOnfon(s); await call(smsc, 'POST', s, { body: { onfonEnabled: false } });
  assert.equal((await callTest(s, f, 'POST', { body: { to: '0712345678' } })).status, 400, 'turned off');
  assert.equal(f.calls.length, 0);
  const other = await shop(); await call(smsc, 'POST', other, { body: { provider: 'onfon' }, proof: adminProof('shoppass') });
  assert.equal((await callTest(other, f, 'POST', { body: { to: '0712345678' } })).status, 400, 'the other shop has no credentials of its own to use');
  assert.equal(f.calls.length, 0);
});

test('sms-send: Onfon duplicate protection (same message twice within a minute is sent once; a refused send frees the key)', async () => {
  const s = await shop(); await saveOnfon(s);
  const real = globalThis.fetch; const f = net({ body: OK() }); globalThis.fetch = f;
  try {
    const post = (b) => call(smsSend, 'POST', s, { body: b });
    const one = await post({ to: ['0712345678'], message: 'Your OTP is 123456' });
    assert.equal(one.status, 200); assert.equal(one.d.success, true); assert.equal(one.d.provider, 'onfon');
    const two = await post({ to: ['0712345678'], message: 'Your OTP is 123456' });
    assert.equal(two.d.duplicate, true); assert.equal(f.calls.length, 1, 'sent once');
    const diff = await post({ to: ['0712345678'], message: 'A different message' });
    assert.equal(diff.d.success, true); assert.equal(f.calls.length, 2);
    // refused for sure (bad credentials): the key is freed so the person can fix and resend at once
    globalThis.fetch = net({ body: { ErrorCode: 4, ErrorDescription: 'Invalid api key' } });
    const bad = await post({ to: ['0733111222'], message: 'x1' }); assert.equal(bad.status, 502);
    globalThis.fetch = net({ body: OK() });
    const retry = await post({ to: ['0733111222'], message: 'x1' }); assert.equal(retry.d.success, true);
  } finally { globalThis.fetch = real; }
});

test('regression: the existing providers still list, save and read as before', async () => {
  const s = await shop(); const P = adminProof('shoppass');
  for (const [p, body, label] of [['africastalking', { atUsername: 'u', atApiKey: 'k' }], ['mobitech', { mobitechApiKey: 'k', mobitechSenderName: 'S' }], ['celcom', { celcomApiKey: 'k', celcomPartnerId: 'p', celcomShortcode: 's' }], ['advanta', { advantaApiKey: 'k', advantaPartnerId: 'p', advantaShortcode: 's' }], ['talksasa', { talksasaApiKey: 'k', talksasaSenderId: 's' }]]) {
    assert.equal((await call(smsc, 'POST', s, { body: { provider: p, ...body }, proof: P })).status, 200, p);
    const g = await call(smsc, 'GET', s, {}); assert.equal(g.d.provider, p); assert.equal(g.d.configured, true, p);
  }
  assert.equal(smsSend.smsProviderOf({}), 'africastalking', 'legacy shops with no provider');
});
