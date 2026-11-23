import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeKV } from './kv-fake.mjs';

// Zip 250 — Safaricom's PRODUCTION system filters out any callback / validation / confirmation URL containing "mpesa", "m-pesa" or "safaricom"
// (sandbox does not), so a prompt could be sent while its result never arrived. Every address handed to Safaricom must be free of those words,
// and the old routes must stay alive for prompts / registrations made before.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const lic = await imp('_license.js');
const reg = await imp('mpesa-c2b-register.js');
const stk = await imp('mpesa-stkpush.js');
const gw = await imp('gateway-config.js');
const gwl = await imp('_gateway-config.js');
const BAD = /m-?pesa|safaricom/i;

async function shop(cfg) {
  const kv = makeKV();
  const env = { mydukapos_kv: kv, LICENSE_CACHE_MS: '0' };
  const rec = await lic.createClient(env, 'permanent', 'Makesh Liquor', 'shop', { phone: '0712345678', email: '' });
  await gwl.saveGatewayConfig(env, rec.id, cfg, { cooldownMs: 0 });
  return { env, id: rec.id };
}
const DARAJA = { mpesaEnv: 'production', mpesaConsumerKey: 'k', mpesaConsumerSecret: 's', mpesaShortcode: '4000001', mpesaPasskey: 'pp', provider: 'daraja' };

function fakeSafaricom(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (/oauth\/v1\/generate/.test(url)) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    return handler(url, body);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('the STK prompt gives Safaricom a callback address with no "mpesa" / "safaricom" in it', async () => {
  const s = await shop(DARAJA);
  const f = fakeSafaricom(() => new Response(JSON.stringify({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_1', MerchantRequestID: 'm1' }), { status: 200 }));
  try {
    const request = new Request(`https://shop.mydukapos.store/api/mpesa-stkpush?c=${s.id}`, { method: 'POST', body: JSON.stringify({ phone: '0712345678', amount: 50 }) });
    const res = await stk.onRequestPost({ request, env: s.env, waitUntil() {} });
    assert.equal(res.status, 200, await res.clone().text());
    const sent = f.calls.find((c) => /stkpush/.test(c.url));
    assert.ok(sent, 'the prompt was sent');
    assert.ok(/\/api\/pay-cb-stk\?c=/.test(sent.body.CallBackURL), sent.body.CallBackURL);
    assert.ok(!BAD.test(new URL(sent.body.CallBackURL).pathname), 'path is clean');
  } finally { f.restore(); }
});

test('Register Till URLs: neutral addresses (zip 358: path form, no query string), and a Till shop registers BOTH its Store number and its Till number', async () => {
  const s = await shop({ ...DARAJA, mpesaTransactionType: 'CustomerBuyGoodsOnline', mpesaPartyB: '5551234' });
  const f = fakeSafaricom(() => new Response(JSON.stringify({ ResponseCode: '0', ResponseDescription: 'Success' }), { status: 200 }));
  try {
    const request = new Request(`https://shop.mydukapos.store/api/mpesa-c2b-register?c=${s.id}`, { method: 'POST' });
    const res = await reg.onRequestPost({ request, env: s.env });
    const d = await res.json();
    assert.equal(res.status, 200, JSON.stringify(d));
    const sent = f.calls.filter((c) => /registerurl/.test(c.url));
    assert.deepEqual(sent.map((c) => c.body.ShortCode), ['4000001', '5551234']);
    assert.equal(d.shortCode, '4000001 + 5551234');
    for (const c of sent) for (const u of [c.body.ConfirmationURL, c.body.ValidationURL]) { assert.ok(!BAD.test(new URL(u).pathname), u); assert.equal(new URL(u).search, '', u); }
    assert.match(sent[0].body.ConfirmationURL, /\/api\/pcb\/[^/]+\/[a-f0-9]+\/c$/);
    assert.match(sent[0].body.ValidationURL, /\/api\/pcb\/[^/]+\/[a-f0-9]+\/v$/);
    assert.ok(/•••/.test(JSON.stringify(d)), 'key not shown to the page');
  } finally { f.restore(); }
});

test('Register Till URLs: a Paybill shop registers its Paybill; "Duplicate notification info" comes back with what to do', async () => {
  const s = await shop(DARAJA);
  const f = fakeSafaricom(() => new Response(JSON.stringify({ errorCode: '500.003.1001', errorMessage: 'Duplicate notification info' }), { status: 500 }));
  try {
    const request = new Request(`https://shop.mydukapos.store/api/mpesa-c2b-register?c=${s.id}`, { method: 'POST' });
    const res = await reg.onRequestPost({ request, env: s.env });
    const d = await res.json();
    assert.equal(res.status, 500);
    assert.equal(f.calls.find((c) => /registerurl/.test(c.url)).body.ShortCode, '4000001');
    assert.match(d.error, /Duplicate notification info/); assert.match(d.error, /500\.003\.1001/); assert.match(d.error, /URL Management/);
  } finally { f.restore(); }
});

test('Safaricom answering a non-JSON page does not crash the registration', async () => {
  const s = await shop(DARAJA);
  const f = fakeSafaricom(() => new Response('<html>Bad gateway</html>', { status: 502 }));
  try {
    const res = await reg.onRequestPost({ request: new Request(`https://x.pages.dev/api/x?c=${s.id}`, { method: 'POST' }), env: s.env });
    assert.equal(res.status, 500); assert.match((await res.json()).error, /HTTP 502/);
  } finally { f.restore(); }
});

test('a rejected login to Daraja says which environment the keys were tried against', async () => {
  const s = await shop(DARAJA);
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ errorMessage: 'Bad Request: Invalid Authentication passed' }), { status: 400 });
  try {
    const request = new Request(`https://x.pages.dev/api/mpesa-stkpush?c=${s.id}`, { method: 'POST', body: JSON.stringify({ phone: '0712345678', amount: 10 }) });
    const res = await stk.onRequestPost({ request, env: s.env, waitUntil() {} });
    const d = await res.json();
    assert.equal(res.status, 500); assert.match(d.error, /PRODUCTION/); assert.match(d.error, /HTTP 400/);
  } finally { globalThis.fetch = real; }
});

test('Settings shows the new callback address; the old routes still answer (prompts / registrations made before keep working)', async () => {
  const s = await shop(DARAJA);
  const res = await gw.onRequestGet({ request: new Request(`https://x.pages.dev/api/gateway-config?c=${s.id}`), env: s.env });
  const d = await res.json();
  assert.match(d.mpesaCallbackUrl, /\/api\/pay-cb-stk\?c=/);
  for (const [oldF, newF] of [['mpesa-callback.js', 'pay-cb-stk.js'], ['mpesa-c2b-confirmation.js', 'pay-cb-till-confirm.js'], ['mpesa-c2b-validation.js', 'pay-cb-till-validate.js']]) {
    const a = await imp(oldF), b = await imp(newF);
    assert.equal(b.onRequestPost, a.onRequestPost, newF + ' is the same handler as ' + oldF);
  }
});

test('no address the server hands to Safaricom contains the filtered words (source guard)', () => {
  for (const f of ['mpesa-stkpush.js', 'mpesa-c2b-register.js', 'gateway-config.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'functions/api', f), 'utf8');
    const urls = src.match(/\$\{origin\}\/api\/[a-z0-9-]+\?c=/g) || [];
    for (const u of urls) {
      if (/paystack|paywave|kcb|pesapal/.test(u)) continue;      // other providers' own webhooks, not Safaricom's
      assert.ok(!BAD.test(u), `${f}: ${u}`);
    }
  }
});

test('STK status check: an error object (no ResultCode) never marks a waiting prompt as failed', async () => {
  const st = await imp('mpesa-status.js');
  const s = await shop(DARAJA);
  const kvKey = `mpesa-tx:${s.id}:ws_CO_9`;
  await s.env.mydukapos_kv.put(kvKey, JSON.stringify({ provider: 'daraja', status: 'pending', phone: '254712345678', amount: 10, createdAt: Date.now() - 60000 }));
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => /oauth/.test(String(url))
    ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
    : new Response(JSON.stringify({ requestId: 'r', errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' }), { status: 200 });
  try {
    const res = await st.onRequestGet({ request: new Request(`https://x.pages.dev/api/mpesa-status?c=${s.id}&checkoutRequestId=ws_CO_9`), env: s.env });
    assert.equal((await res.json()).status, 'pending');
  } finally { globalThis.fetch = real; }
});
