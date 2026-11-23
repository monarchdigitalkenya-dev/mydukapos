import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKV, seedShop } from './kv-fake.mjs';
import { saveGatewayConfig } from '../functions/api/_gateway-config.js';
import { onRequestPost } from '../functions/api/mpesa-c2b-register.js';

async function run(answers) {
  const kv = makeKV(); seedShop(kv, 'C1', { type: 'permanent' });
  await saveGatewayConfig({ mydukapos_kv: kv }, 'C1', { mpesaConsumerKey: 'k', mpesaConsumerSecret: 's', mpesaShortcode: '174379', mpesaPasskey: 'p', mpesaEnv: 'production', mpesaTransactionType: 'CustomerBuyGoodsOnline', mpesaPartyB: '5123456' });
  const calls = []; const real = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); if (String(url).includes('oauth')) return new Response(JSON.stringify({ access_token: 't' }), { status: 200 }); const a = answers.shift(); return new Response(JSON.stringify(a.body), { status: a.status }); };
  try {
    const r = await onRequestPost({ request: new Request('https://x.pages.dev/api/mpesa-c2b-register?c=C1', { method: 'POST' }), env: { mydukapos_kv: kv } });
    return { r, j: await r.json(), calls };
  } finally { globalThis.fetch = real; }
}
const bad = { status: 401, body: { errorCode: '401.003.01', errorMessage: 'Error Occurred - Invalid Access Token - BearerToken' } };

const okA = { status: 200, body: { ResponseCode: '0', ResponseDescription: 'Success' } };
test('401 on one C2B version is retried on the other and reports which one worked (zip 358: v2 first, both numbers)', async () => {
  const { j, calls } = await run([bad, okA, bad, okA]);
  if (j.error) { assert.fail(j.error); }
  assert.equal(j.success, true); assert.equal(j.c2bVersion, 'v1');
  assert.ok(calls.findIndex((c) => c.includes('/c2b/v2/registerurl')) < calls.findIndex((c) => c.includes('/c2b/v1/registerurl')), 'v2 tried first');
  assert.ok(calls.some((c) => c.includes('/c2b/v1/registerurl')) && calls.some((c) => c.includes('/c2b/v2/registerurl')));
});
test('when both versions refuse the token the message says what to switch on', async () => {
  const { r, j } = await run([bad, bad, bad, bad]);
  assert.equal(r.status, 500);
  assert.match(j.error, /C2B/); assert.match(j.error, /Store \/ Head Office/, 'says which number the live app belongs to');
});

test('zip 263/358: both numbers are tried (Store, then Till); a "wrong ShortCode" on one still registers the other', async () => {
  const wrong = { status: 400, body: { errorCode: '400.003.02', errorMessage: 'Bad Request - Kindly use your own ShortCode' } };
  const { j, calls } = await run([wrong, okA]);
  assert.equal(j.success, true); assert.equal(j.shortCode, '5123456');
  assert.equal(calls.filter((c) => c.includes('registerurl')).length, 2);
  const both = await run([wrong, wrong]);
  assert.match(both.j.error, /174379, 5123456/, 'lists every number tried');
});
