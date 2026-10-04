import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, boot } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const mk = () => { const kv = makeKV(); seedShop(kv, 'C1'); return { kv, env: { mydukapos_kv: kv } }; };
const req = (url, method, body) => new Request(url, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

function pesapalFake({ statusCode = 0, amount = 150 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.endsWith('/api/Auth/RequestToken')) return json({ token: 'TOK', status: '200' });
    if (u.endsWith('/api/URLSetup/RegisterIPN')) return json({ ipn_id: 'IPN-1', status: '200' });
    if (u.endsWith('/api/Transactions/SubmitOrderRequest')) return json({ order_tracking_id: 'TRK-1', merchant_reference: JSON.parse(init.body).id, redirect_url: 'https://cybqa.pesapal.com/pesapaliframe/PesapalIframe3/Index?OrderTrackingId=TRK-1', status: '200' });
    if (u.includes('/api/Transactions/GetTransactionStatus')) return json({ status_code: statusCode, amount, confirmation_code: 'TJ12CONF34', payment_method: 'Mpesa', payment_status_description: statusCode === 1 ? 'Completed' : 'Invalid' });
    return json({ error: 'unexpected ' + u }, 500);
  };
  return calls;
}

test('config: Pesapal and Co-op are real providers, only when complete; forced choice respected', async () => {
  const { env } = mk();
  const g = await load('functions/api/_gateway-config.js');
  await g.saveGatewayConfig(env, 'C1', { pesapalConsumerKey: 'k' });
  assert.equal(g.resolveProvider(await g.loadGatewayConfig(env, 'C1')), null, 'half a set is not a gateway');
  await g.saveGatewayConfig(env, 'C1', { pesapalConsumerSecret: 's' });
  assert.equal(g.resolveProvider(await g.loadGatewayConfig(env, 'C1')), 'pesapal');
  await g.saveGatewayConfig(env, 'C1', { coopConsumerKey: 'k', coopConsumerSecret: 's', coopTokenUrl: 'https://bank.example/token', coopStkUrl: 'https://bank.example/stk' });
  assert.equal(g.hasCoopConfig(await g.loadGatewayConfig(env, 'C1')), false, 'needs the shortcode too');
  await g.saveGatewayConfig(env, 'C1', { coopShortcode: '400200' });
  const cfg = await g.loadGatewayConfig(env, 'C1');
  assert.equal(g.resolveProvider(cfg), 'coop', 'auto prefers co-op over pesapal');
  await g.saveGatewayConfig(env, 'C1', { provider: 'pesapal' });
  assert.equal(g.resolveProvider(await g.loadGatewayConfig(env, 'C1')), 'pesapal');
  await g.clearGatewayProvider(env, 'C1', 'pesapal');
  assert.equal(g.hasPesapalConfig(await g.loadGatewayConfig(env, 'C1')), false);
});

test('gateway-config POST refuses a non-https / IP / local Co-op address', async () => {
  const { env } = mk();
  const gc = await load('functions/api/gateway-config.js');
  for (const bad of ['http://bank.example/t', 'https://127.0.0.1/t', 'https://localhost/t', 'https://10.0.0.5/x', 'nonsense']) {
    const r = await gc.onRequestPost({ request: req('https://x/api/gateway-config?c=C1', 'POST', { coopTokenUrl: bad }), env });
    assert.equal(r.status, 400, bad);
  }
  assert.equal((await gc.onRequestPost({ request: req('https://x/api/gateway-config?c=C1', 'POST', { coopTokenUrl: 'https://openapi.bank.co.ke/token' }), env })).status, 200);
});

test('Pesapal end to end: prompt -> link, pending, IPN verified with Pesapal, success once, wrong amount refused', async () => {
  const realFetch = globalThis.fetch;
  try {
    const { kv, env } = mk();
    const g = await load('functions/api/_gateway-config.js'), stk = await load('functions/api/mpesa-stkpush.js'), st = await load('functions/api/mpesa-status.js'), ipn = await load('functions/api/pesapal-ipn.js');
    await g.saveGatewayConfig(env, 'C1', { pesapalConsumerKey: 'k', pesapalConsumerSecret: 's' });
    const calls = pesapalFake({ statusCode: 0 });
    const r = await stk.onRequestPost({ request: req('https://x/api/mpesa-stkpush?c=C1', 'POST', { phone: '0712345678', amount: 150, accountRef: 'Shop' }), env });
    const d = await r.json();
    assert.equal(r.status, 200, JSON.stringify(d));
    assert.equal(d.checkoutRequestId, 'TRK-1');
    assert.match(d.paymentUrl, /^https:\/\/cybqa\.pesapal\.com\//);
    const submit = JSON.parse(calls.find((c) => c.url.endsWith('SubmitOrderRequest')).init.body);
    assert.equal(submit.amount, 150); assert.equal(submit.currency, 'KES'); assert.equal(submit.notification_id, 'IPN-1');
    assert.match(submit.id, /^[A-Za-z0-9]{1,50}$/); assert.equal(submit.billing_address.phone_number, '254712345678');
    const regBody = JSON.parse(calls.find((c) => c.url.endsWith('RegisterIPN')).init.body);
    assert.match(regBody.url, /\/api\/pesapal-ipn\?c=C1&k=/); assert.equal(regBody.ipn_notification_type, 'GET');
    assert.equal(JSON.parse(await kv.get('mpesa-tx:C1:TRK-1')).status, 'pending');
    // a second order reuses the registered IPN
    await stk.onRequestPost({ request: req('https://x/api/mpesa-stkpush?c=C1', 'POST', { phone: '0712345678', amount: 150 }), env });
    assert.equal(calls.filter((c) => c.url.endsWith('RegisterIPN')).length, 1);
    // forged IPN for an order we never made does nothing; for ours, with Pesapal saying "not paid", still pending
    await ipn.onRequestGet({ request: new Request('https://x/api/pesapal-ipn?c=C1&OrderTrackingId=FORGED&OrderMerchantReference=x'), env });
    assert.equal(await kv.get('mpesa-tx:C1:FORGED'), null);
    await ipn.onRequestGet({ request: new Request('https://x/api/pesapal-ipn?c=C1&OrderTrackingId=TRK-1&OrderMerchantReference=x'), env });
    assert.equal(JSON.parse(await kv.get('mpesa-tx:C1:TRK-1')).status, 'pending', 'the IPN alone never marks paid');
    // Pesapal says underpaid -> refused
    pesapalFake({ statusCode: 1, amount: 20 });
    await ipn.onRequestGet({ request: new Request('https://x/api/pesapal-ipn?c=C1&OrderTrackingId=TRK-1'), env });
    const bad = JSON.parse(await kv.get('mpesa-tx:C1:TRK-1'));
    assert.equal(bad.status, 'failed'); assert.match(bad.resultDesc, /was due/);
    // fresh order, paid in full: IPN confirms, repeat is harmless
    await kv.put('mpesa-tx:C1:TRK-2', JSON.stringify({ provider: 'pesapal', status: 'pending', amount: 150, createdAt: Date.now() }));
    pesapalFake({ statusCode: 1, amount: 150 });
    const ack = await (await ipn.onRequestGet({ request: new Request('https://x/api/pesapal-ipn?c=C1&OrderTrackingId=TRK-2&OrderMerchantReference=m'), env })).json();
    assert.equal(ack.status, 200); assert.equal(ack.orderTrackingId, 'TRK-2');
    const ok = JSON.parse(await kv.get('mpesa-tx:C1:TRK-2'));
    assert.equal(ok.status, 'success'); assert.equal(ok.receiptNumber, 'TJ12CONF34'); assert.equal(ok.amount, 150);
    assert.equal(JSON.parse(await kv.get('mpesa-receipt:C1:TJ12CONF34')).amount, 150, 'indexed for the till receipt check');
    await ipn.onRequestGet({ request: new Request('https://x/api/pesapal-ipn?c=C1&OrderTrackingId=TRK-2'), env });
    assert.equal(JSON.parse(await kv.get('mpesa-tx:C1:TRK-2')).status, 'success');
    // the till's own poll also asks Pesapal when the IPN has not arrived
    await kv.put('mpesa-tx:C1:TRK-3', JSON.stringify({ provider: 'pesapal', status: 'pending', amount: 150, createdAt: Date.now() - 5000 }));
    const s = await (await st.onRequestGet({ request: new Request('https://x/api/mpesa-status?c=C1&checkoutRequestId=TRK-3'), env })).json();
    assert.equal(s.status, 'success'); assert.equal(s.receiptNumber, 'TJ12CONF34');
  } finally { globalThis.fetch = realFetch; }
});

test('Co-op Bank: token + Daraja-shaped STK to the owner-supplied addresses; result via mpesa-callback', async () => {
  const realFetch = globalThis.fetch;
  try {
    const { kv, env } = mk();
    const g = await load('functions/api/_gateway-config.js'), stk = await load('functions/api/mpesa-stkpush.js'), cb = await load('functions/api/mpesa-callback.js');
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith('https://bank.example/token')) return json({ access_token: 'CT', expires_in: 3599 });
      if (String(url) === 'https://bank.example/stk') return json({ MerchantRequestID: 'M1', CheckoutRequestID: 'ws_CO_1', ResponseCode: '0', ResponseDescription: 'ok', CustomerMessage: 'Sent' });
      return json({}, 500);
    };
    await g.saveGatewayConfig(env, 'C1', { coopConsumerKey: 'k', coopConsumerSecret: 's', coopTokenUrl: 'https://bank.example/token', coopStkUrl: 'https://bank.example/stk', coopShortcode: '400200', coopPasskey: 'pk' });
    const r = await stk.onRequestPost({ request: req('https://x/api/mpesa-stkpush?c=C1', 'POST', { phone: '0712345678', amount: 75, accountRef: 'Shop' }), env });
    const d = await r.json();
    assert.equal(r.status, 200, JSON.stringify(d)); assert.equal(d.checkoutRequestId, 'ws_CO_1'); assert.equal(d.paymentUrl, undefined);
    const tok = calls[0]; assert.match(tok.init.headers.Authorization, /^Basic /);
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.BusinessShortCode, '400200'); assert.equal(body.Amount, 75); assert.equal(body.PhoneNumber, '254712345678'); assert.match(body.CallBackURL, /\/api\/mpesa-callback\?c=C1&k=/);
    assert.equal(calls[1].init.headers.Authorization, 'Bearer CT');
    const key = new URL(body.CallBackURL).searchParams.get('k');
    await cb.onRequestPost({ request: req(`https://x/api/mpesa-callback?c=C1&k=${key}`, 'POST', { Body: { stkCallback: { CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'QCOOP00001' }, { Name: 'Amount', Value: 75 }] } } } }), env });
    assert.equal(JSON.parse(await kv.get('mpesa-tx:C1:ws_CO_1')).status, 'success');
    // declined by the bank surfaces its message
    globalThis.fetch = async (url) => String(url).startsWith('https://bank.example/token') ? json({ access_token: 'CT' }) : json({ ResponseCode: '1', ResponseDescription: 'Bad shortcode' }, 400);
    const bad = await stk.onRequestPost({ request: req('https://x/api/mpesa-stkpush?c=C1', 'POST', { phone: '0712345678', amount: 5 }), env });
    assert.equal(bad.status, 500); assert.match((await bad.json()).error, /Bad shortcode/);
  } finally { globalThis.fetch = realFetch; }
});

for (const app of ['index.html', 'hotel/index.html', 'water/index.html']) {
  test(`${app}: Settings shows Pesapal + Co-op options and the till shows the Pesapal link`, async () => {
    const b = await boot(app, { wait: 800 });
    const { w, d } = b;
    assert.ok(w.__gwMore, 'block loaded');
    const forced = d.getElementById('gateway-forced-provider-input');
    if (forced) {
      assert.ok(d.getElementById('gw-more'), 'panels mounted');
      assert.ok(d.getElementById('pesapal-save') && d.getElementById('coop-save'));
      assert.ok([...forced.options].some((o) => o.value === 'pesapal') && [...forced.options].some((o) => o.value === 'coop'));
    }
    b.close();
  });
}

test('till: a paymentUrl answer shows the link card (open / copy / WhatsApp) and it clears when the payment is confirmed', async () => {
  const b = await boot('index.html', { wait: 800, fetch: async (url) => {
    if (/mpesa-stkpush/.test(url)) return new Response(JSON.stringify({ checkoutRequestId: 'T1', paymentUrl: 'https://pay.pesapal.com/x?id=1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (/mpesa-status/.test(url)) return new Response(JSON.stringify({ status: 'success', receiptNumber: 'R1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const { w, d } = b;
  assert.ok(d.getElementById('mpesa-status-line'));
  await w.fetch('/api/mpesa-stkpush', { method: 'POST', body: JSON.stringify({ phone: '0712345678', amount: 5 }) });
  await new Promise((r) => setTimeout(r, 100));
  const c = d.getElementById('pesapal-link-card');
  assert.ok(c, 'card shown');
  assert.match(c.innerHTML, /pay\.pesapal\.com\/x\?id=1/); assert.match(c.innerHTML, /wa\.me\/254712345678/);
  await w.fetch('/api/mpesa-status?checkoutRequestId=T1');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(d.getElementById('pesapal-link-card'), null, 'cleared once confirmed');
  b.close();
});
