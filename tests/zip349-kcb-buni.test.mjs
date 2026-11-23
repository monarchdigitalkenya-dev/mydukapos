import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// zip 349: KCB Buni STK push. The push now carries the gateway headers KCB's integrations use (routeCode / operation / messageId), and every failure says WHAT
// failed (token or push, the HTTP status and KCB's own words) instead of a generic "declined" - a non-JSON answer used to surface as a raw SyntaxError.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const CFG = { kcbEnv: 'sandbox', kcbConsumerKey: 'K', kcbConsumerSecret: 'S', kcbOrgShortCode: '174379', kcbOrgPassKey: 'PK', kcbSharedShortCode: false };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
async function run(handler) {
  const m = await load('functions/api/mpesa-stkpush.js');
  const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv };
  const calls = []; const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init || {} }); return handler(String(url), init || {}); };
  try {
    const out = await m.sendStk(env, new Request('https://shop.example.com/api/mpesa-stkpush'), 'C1', CFG, 'kcb', { phone: '254712345678', amount: 100, accountRef: 'INV-1', description: 'Sale' }).then((r) => ({ ok: r }), (e) => ({ err: e }));
    return { ...out, calls };
  } finally { globalThis.fetch = real; }
}
const tokenOk = () => json({ access_token: 'TKN', expires_in: 3599 });

test('the push carries routeCode, operation and a unique messageId, and a good answer is accepted', async () => {
  const r = await run((u) => u.includes('/token') ? tokenOk() : json({ header: { statusCode: '0', statusDescription: 'Success' }, response: { ResponseCode: '0', MerchantRequestID: 'M1', CheckoutRequestID: 'ws_CO_1', CustomerMessage: 'ok' } }));
  assert.ok(r.ok, r.err && r.err.message);
  assert.equal(r.ok.id, 'ws_CO_1');
  const push = r.calls.find((c) => c.url.endsWith('/mm/api/request/1.0.0/stkpush'));
  assert.equal(push.init.headers.Authorization, 'Bearer TKN');
  assert.equal(push.init.headers.routeCode, '207');
  assert.equal(push.init.headers.operation, 'STKPush');
  assert.match(push.init.headers.messageId, /^[A-Za-z0-9-]{8,}$/);
});

test('a rejected login says the token step failed, with the HTTP status and KCB\'s own words (no secret in the message)', async () => {
  const r = await run(() => json({ fault: { code: 900901, message: 'Invalid Credentials', description: 'Invalid Credentials. Make sure you have provided the correct security credentials' } }, 401));
  assert.match(r.err.message, /KCB Buni/); assert.match(r.err.message, /401/); assert.match(r.err.message, /Invalid Credentials/);
  assert.doesNotMatch(r.err.message, /\bS\b.*\bK\b|Basic /);
});

test('an HTTP 200 whose header.statusCode is not 0 is a decline, and its description is shown', async () => {
  const r = await run((u) => u.includes('/token') ? tokenOk() : json({ header: { statusCode: '1', statusDescription: 'Bad Request - Invalid Remarks' }, response: {} }));
  assert.match(r.err.message, /Invalid Remarks/);
});

test('an answer that is not JSON is explained, not a raw SyntaxError', async () => {
  const r = await run((u) => u.includes('/token') ? tokenOk() : new Response('<html>Bad gateway</html>', { status: 502 }));
  assert.match(r.err.message, /KCB Buni/); assert.match(r.err.message, /502/); assert.doesNotMatch(r.err.message, /JSON|Unexpected token/);
});

test('a token answer without access_token is caught', async () => {
  const r = await run(() => json({ hello: 'world' }));
  assert.match(r.err.message, /KCB Buni/); assert.match(r.err.message, /access token|authenticate/i);
});
