import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// zip 356: why KCB Buni still failed after zip 350 - login body, live address, 32-character messageId, shared short code.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const OK = () => json({ header: { statusCode: '0', statusDescription: 'Success' }, response: { ResponseCode: '0', MerchantRequestID: 'M1', CheckoutRequestID: 'ws_CO_1', CustomerMessage: 'ok' } });
async function run(cfg, handler, phone = '254712345678') {
  const m = await load('functions/api/mpesa-stkpush.js');
  const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv };
  const calls = []; const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init || {} }); return handler(String(url), init || {}); };
  try {
    const out = await m.sendStk(env, new Request('https://shop.example.com/api/mpesa-stkpush'), 'C1', cfg, 'kcb', { phone, amount: 100, accountRef: 'POS Sale', description: 'POS Sale' }).then((r) => ({ ok: r }), (e) => ({ err: e }));
    return { ...out, calls };
  } finally { globalThis.fetch = real; }
}
const BASE = { kcbConsumerKey: ' K \n', kcbConsumerSecret: 'S ', kcbOrgShortCode: '7654321', kcbOrgPassKey: 'PK', kcbSharedShortCode: true };
const isToken = (u) => /\/token/.test(u);

test('login: grant_type is in the form body, the key / secret are trimmed', async () => {
  const r = await run({ ...BASE, kcbEnv: 'sandbox' }, (u) => isToken(u) ? json({ access_token: 'T' }) : OK());
  assert.ok(r.ok, r.err && r.err.message);
  const t = r.calls.find((c) => isToken(c.url));
  assert.equal(t.init.body, 'grant_type=client_credentials');
  assert.equal(t.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(t.init.headers.Authorization, 'Basic ' + btoa('K:S'));
});

test('push: messageId is at most 32 characters; own Till + Pass Key is never sent as shared (the old ticked box); amount whole shillings; no spaces in invoiceNumber', async () => {
  const r = await run({ ...BASE, kcbEnv: 'sandbox' }, (u) => isToken(u) ? json({ access_token: 'T' }) : OK());
  const p = r.calls.find((c) => c.url.endsWith('/stkpush'));
  assert.ok(p.init.headers.messageId.length <= 32 && p.init.headers.messageId.length >= 16);
  const body = JSON.parse(p.init.body);
  assert.equal(body.sharedShortCode, false); assert.equal(body.orgShortCode, '7654321'); assert.equal(body.orgPassKey, 'PK');
  assert.equal(body.amount, '100'); assert.equal(body.invoiceNumber, 'POS-Sale', 'own short code: plain reference'); assert.ok(body.transactionDescription.length <= 13);
});

test('no Pass Key = KCB shared short code, in KCB\'s documented shape', async () => {
  const r = await run({ ...BASE, kcbOrgPassKey: '', kcbSharedShortCode: false, kcbEnv: 'sandbox' }, (u) => isToken(u) ? json({ access_token: 'T' }) : OK());
  const body = JSON.parse(r.calls.find((c) => c.url.endsWith('/stkpush')).init.body);
  assert.equal(body.sharedShortCode, true);
  assert.equal(body.orgShortCode, ''); assert.equal(body.orgPassKey, '');
  assert.equal(body.invoiceNumber, '7654321-POS-Sale', 'KCB routes the money by "<account / Till>-<reference>"');
});

test('production: the push goes to the API gateway (api.buni.kcbgroup.com); a web-page answer falls back to buni.kcbgroup.com', async () => {
  let r = await run({ ...BASE, kcbEnv: 'production' }, (u) => isToken(u) ? json({ access_token: 'T' }) : OK());
  assert.ok(r.ok, r.err && r.err.message);
  assert.equal(r.calls.find((c) => isToken(c.url)).url, 'https://accounts.buni.kcbgroup.com/oauth2/token');
  assert.equal(r.calls.find((c) => c.url.endsWith('/stkpush')).url, 'https://api.buni.kcbgroup.com/mm/api/request/1.0.0/stkpush');
  r = await run({ ...BASE, kcbEnv: 'production' }, (u) => isToken(u) ? json({ access_token: 'T' }) : u.startsWith('https://api.') ? new Response('<html>Not Found</html>', { status: 404 }) : OK());
  assert.ok(r.ok, r.err && r.err.message);
  assert.deepEqual(r.calls.filter((c) => c.url.endsWith('/stkpush')).map((c) => new URL(c.url).host), ['api.buni.kcbgroup.com', 'buni.kcbgroup.com']);
});

test('production login: a non-API answer from the accounts server tries the gateway token; a real refusal (401) stops with KCB\'s words', async () => {
  let r = await run({ ...BASE, kcbEnv: 'production' }, (u) => u.includes('accounts.') ? new Response('<html>oops</html>', { status: 404 }) : isToken(u) ? json({ access_token: 'T' }) : OK());
  assert.ok(r.ok, r.err && r.err.message);
  r = await run({ ...BASE, kcbEnv: 'production' }, () => json({ error: 'invalid_client', error_description: 'Client Authentication failed.' }, 401));
  assert.match(r.err.message, /login failed.*401.*Client Authentication failed/);
  assert.equal(r.calls.length, 1, 'a wrong key is not retried elsewhere');
});

test('a wrong phone number is refused before anything is sent', async () => {
  const r = await run({ ...BASE, kcbEnv: 'sandbox' }, () => OK(), '25412');
  assert.match(r.err.message, /Kenyan mobile number/); assert.equal(r.calls.length, 0);
});
