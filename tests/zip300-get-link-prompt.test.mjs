import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeKV } from './kv-fake.mjs';
import * as oa from '../functions/api/_owner-auth.js';
import { saveGatewayConfig } from '../functions/api/_gateway-config.js';
import { SHARED_DEMOS, ensureSharedDemo } from '../functions/api/_shared-demos.js';
import { onRequestPost as gml } from '../functions/api/get-my-link.js';

// zip 300: when the payment gateway is connected but the first prompt fails, the buyer can ask for the prompt again instead of being stuck on "send 3000".
test('a failed first prompt falls back with the reason, and "retry" sends the prompt once the gateway answers', async () => {
  const kv = makeKV(); const env = { mydukapos_kv: kv };
  const acct = await oa.createOwnerAccount(env, 'o@example.com', 'Sup3r-secret-pw');
  await saveGatewayConfig(env, acct.ownerClientId, { mpesaConsumerKey: 'k', mpesaConsumerSecret: 's', mpesaShortcode: '174379', mpesaPasskey: 'p', mpesaEnv: 'production' });
  await ensureSharedDemo(env, SHARED_DEMOS.find((d) => d.key === 'retail'));
  const call = (body) => gml({ env, request: new Request('https://x.pages.dev/api/get-my-link?c=demo_retail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }).then(async (r) => ({ r, j: await r.json() }));
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => String(url).includes('oauth') ? new Response(JSON.stringify({ errorMessage: 'bad' }), { status: 400 }) : new Response('{}', { status: 500 });
    const opt = await call({ action: 'options' }); assert.equal(opt.j.stk, true, 'gateway reported as connected');
    const s = await call({ action: 'start', name: 'Mary Wanjiku', phone: '0712345678', email: '' });
    assert.equal(s.j.method, 'claim'); assert.ok(s.j.stkError, 'the reason is returned: ' + JSON.stringify(s.j));
    globalThis.fetch = async (url) => String(url).includes('oauth') ? new Response(JSON.stringify({ access_token: 't' })) : new Response(JSON.stringify({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_1', MerchantRequestID: 'm', CustomerMessage: 'ok' }));
    const r = await call({ action: 'retry', id: s.j.id, token: s.j.token });
    assert.equal(r.r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.method, 'stk');
    const again = await call({ action: 'retry', id: s.j.id, token: s.j.token }); assert.equal(again.r.status, 400, 'an STK request cannot be retried as a claim');
    assert.equal((await call({ action: 'retry', id: s.j.id, token: 'wrong' })).r.status, 404);
  } finally { globalThis.fetch = real; }
});
test('the buy panel re-checks a saved manual request and offers the prompt button', () => {
  const h = fs.readFileSync(new URL('../src/shared/blocks/shared-demo.html', import.meta.url), 'utf8');
  assert.match(h, /id="sd-retry"/); assert.match(h, /action: 'retry'/); assert.match(h, /t\.stk\) \{ refSet\(null\)/);
});
