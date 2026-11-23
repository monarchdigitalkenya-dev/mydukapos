// zip 273: the STK prompt lifecycle against the REAL till endpoint with a stand-in provider (Paywave Express).
//  - the attempt is written down BEFORE the provider is called
//  - a double tap / parallel duplicate sends ONE prompt and both get the same checkout id
//  - a provider that never answers is "unknown", never "failed": nothing is stored as a payment, a second prompt is held back for a while
//  - a plain decline is reported as before and may be retried at once
//  - a webhook whose amount does not match the prompt does not credit the payment; a success without a receipt is flagged for review
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const stk = await load('functions/api/mpesa-stkpush.js');
const gwl = await load('functions/api/_gateway-config.js');
const hook = await load('functions/api/paywave-webhook.js');
const status = await load('functions/api/mpesa-status.js');
const cbk = await load('functions/api/_callback-key.js');
const realFetch = globalThis.fetch;
const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json' } });

async function world(extraEnv = {}) {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), ROOT_DOMAIN: 'mydukapos.store', LICENSE_CACHE_MS: '0', PAYMENT_SECRETS_KEY: 'k'.repeat(32), ...extraEnv };
  await gwl.saveGatewayConfig(env, 'C1', { paywaveApiKey: 'KEY', paywaveEmail: 'a@b.co' }, { cooldownMs: 0 });
  return { kv, env };
}
const post = (env, body, headers = {}) => stk.onRequestPost({ request: new Request('https://shop-c1.mydukapos.store/api/mpesa-stkpush?c=C1', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), env, waitUntil() {} });
const keys = (kv, prefix) => [...kv.data.keys()].filter((k) => k.startsWith(prefix));
const PH = '0712345678';

test('the attempt is on record BEFORE the provider is called, then marked sent; the tx record carries attemptId and phase', async () => {
  const { kv, env } = await world();
  let seenAtCall = null;
  globalThis.fetch = async () => { seenAtCall = keys(kv, 'mpesa-att:C1:').map((k) => JSON.parse(kv.data.get(k).value)); return json({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_1', transaction_request_id: 'T1' }); };
  try {
    const r = await post(env, { phone: PH, amount: 100, accountRef: 'S-1' });
    const d = await r.json();
    assert.equal(r.status, 200); assert.equal(d.checkoutRequestId, 'ws_CO_1'); assert.ok(d.attemptId);
    assert.equal(seenAtCall.length, 1); assert.equal(seenAtCall[0].status, 'initiating', 'written before the provider call');
    const att = JSON.parse(kv.data.get('mpesa-att:C1:' + d.attemptId).value);
    assert.equal(att.status, 'sent'); assert.equal(att.providerId, 'ws_CO_1');
    const tx = JSON.parse(kv.data.get('mpesa-tx:C1:ws_CO_1').value);
    assert.equal(tx.status, 'pending'); assert.equal(tx.phase, 'awaiting_customer'); assert.equal(tx.attemptId, d.attemptId);
  } finally { globalThis.fetch = realFetch; }
});

test('a double tap: 5 identical requests at once send exactly one prompt and all get the same checkout id', async () => {
  const { kv, env } = await world();
  let calls = 0;
  globalThis.fetch = async () => { calls++; await new Promise((r) => setTimeout(r, 80)); return json({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_2' }); };
  try {
    const rs = await Promise.all(Array.from({ length: 5 }, () => post(env, { phone: PH, amount: 250, accountRef: 'S-2' })));
    const ds = await Promise.all(rs.map((r) => r.json()));
    assert.equal(calls, 1, 'one provider call');
    assert.ok(ds.every((d) => d.checkoutRequestId === 'ws_CO_2'), JSON.stringify(ds));
    assert.equal(ds.filter((d) => d.duplicate).length, 4);
    assert.equal(keys(kv, 'mpesa-tx:C1:').length, 1);
    // a different amount is a different prompt
    globalThis.fetch = async () => { calls++; return json({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_3' }); };
    assert.equal((await (await post(env, { phone: PH, amount: 251, accountRef: 'S-2' })).json()).checkoutRequestId, 'ws_CO_3');
  } finally { globalThis.fetch = realFetch; }
});

test('provider silent: "unknown", never failed; nothing is stored as a payment; the same prompt is held back, a different one is not', async () => {
  const { kv, env } = await world({ STK_PROVIDER_TIMEOUT_MS: '60' });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Promise(() => {}); };
  try {
    const r = await post(env, { phone: PH, amount: 300, accountRef: 'S-3' });
    const d = await r.json();
    assert.equal(r.status, 504); assert.equal(d.code, 'stk_unknown'); assert.ok(d.retryAfter > 0 && d.attemptId);
    assert.match(d.error, /not known whether the prompt reached/i);
    const att = JSON.parse(kv.data.get('mpesa-att:C1:' + d.attemptId).value);
    assert.equal(att.status, 'unknown');
    assert.equal(keys(kv, 'mpesa-tx:C1:').length, 0, 'no payment record is invented');
    const again = await post(env, { phone: PH, amount: 300, accountRef: 'S-3' });
    assert.equal(again.status, 409); assert.equal((await again.json()).code, 'stk_unknown'); assert.equal(calls, 1, 'no second prompt');
    globalThis.fetch = async () => { calls++; return json({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_4' }); };
    assert.equal((await post(env, { phone: PH, amount: 301, accountRef: 'S-3' })).status, 200, 'another amount is a different request');
  } finally { globalThis.fetch = realFetch; }
});

test('a plain decline is a failure as before (500, the provider\'s words) and may be retried at once', async () => {
  const { kv, env } = await world();
  let n = 0;
  globalThis.fetch = async () => { n++; return n === 1 ? json({ message: 'Insufficient float' }, 400) : json({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_5' }); };
  try {
    const r = await post(env, { phone: PH, amount: 400, accountRef: 'S-4' });
    assert.equal(r.status, 500); assert.match((await r.json()).error, /declined/i);
    const att = keys(kv, 'mpesa-att:C1:').map((k) => JSON.parse(kv.data.get(k).value))[0];
    assert.equal(att.status, 'declined');
    assert.equal((await post(env, { phone: PH, amount: 400, accountRef: 'S-4' })).status, 200);
  } finally { globalThis.fetch = realFetch; }
});

async function sendOne(env, kv, id, amount) {
  globalThis.fetch = async () => json({ ResponseCode: '0', CheckoutRequestID: id });
  try { await post(env, { phone: PH, amount, accountRef: 'S-' + id }); } finally { globalThis.fetch = realFetch; }
  return JSON.parse(kv.data.get('mpesa-tx:C1:' + id).value);
}
const hookCall = async (env, body) => { const rec = await cbk.ensureCallbackKey(env, 'C1', 'paywave'); return hook.onRequestPost({ request: new Request('https://shop-c1.mydukapos.store/api/paywave-webhook?c=C1&k=' + rec.k, { method: 'POST', body: JSON.stringify(body) }), env, waitUntil() {} }); };

test('webhook: a success for the right amount credits; the wrong amount does not; a duplicate changes nothing; a success without a receipt is flagged', async () => {
  const { kv, env } = await world();
  await sendOne(env, kv, 'ws_A', 500); await sendOne(env, kv, 'ws_B', 500); await sendOne(env, kv, 'ws_C', 500);
  await hookCall(env, { CheckoutRequestID: 'ws_A', ResponseCode: '0', status: 'success', TransactionReceipt: 'RCP111', TransactionAmount: 500 });
  const a = JSON.parse(kv.data.get('mpesa-tx:C1:ws_A').value);
  assert.equal(a.status, 'success'); assert.equal(a.receiptNumber, 'RCP111'); assert.ok(!a.needsReview);
  await hookCall(env, { CheckoutRequestID: 'ws_A', ResponseCode: '0', status: 'failed' });          // a late or repeated message
  assert.equal(JSON.parse(kv.data.get('mpesa-tx:C1:ws_A').value).status, 'success', 'a completed payment is final');
  await hookCall(env, { CheckoutRequestID: 'ws_B', ResponseCode: '0', status: 'success', TransactionReceipt: 'RCP222', TransactionAmount: 50 });
  const b = JSON.parse(kv.data.get('mpesa-tx:C1:ws_B').value);
  assert.equal(b.status, 'pending', 'the amount does not match the prompt: not credited'); assert.equal(b.needsReview, 'amount_mismatch');
  await hookCall(env, { CheckoutRequestID: 'ws_C', ResponseCode: '0', status: 'success', TransactionAmount: 500 });
  const c = JSON.parse(kv.data.get('mpesa-tx:C1:ws_C').value);
  assert.equal(c.status, 'success'); assert.equal(c.needsReview, 'no_receipt', 'accepted, but a person is asked to look at it');
});
