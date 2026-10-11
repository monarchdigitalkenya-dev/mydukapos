import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeKV } from './kv-fake.mjs';

// Zip 255 — "Test Daraja connection": walks the steps and reports Safaricom's own words; PAY_CALLBACK_ORIGIN override.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const chk = await imp('daraja-check.js');
const gwl = await imp('_gateway-config.js');
const lic = await imp('_license.js');
const ck = await imp('_callback-key.js');

async function shop(cfg) {
  const kv = makeKV();
  const env = { mydukapos_kv: kv, LICENSE_CACHE_MS: '0' };
  const rec = await lic.createClient(env, 'permanent', 'Makesh Liquor', 'shop', { phone: '0712345678', email: '' });
  if (cfg) await gwl.saveGatewayConfig(env, rec.id, cfg);
  return { env, id: rec.id };
}
const run = async (s, fake) => {
  const real = globalThis.fetch; globalThis.fetch = fake;
  try {
    const res = await chk.onRequestPost({ request: new Request(`https://x.pages.dev/api/daraja-check?c=${s.id}`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }), env: s.env, waitUntil() {} });
    return { status: res.status, d: await res.json() };
  } finally { globalThis.fetch = real; }
};
const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st });
const byId = (d, id) => d.steps.find((x) => x.id === id);
const PROD = { mpesaEnv: 'production', mpesaConsumerKey: 'k', mpesaConsumerSecret: 's', mpesaShortcode: '600111', mpesaPasskey: 'p' };

test('nothing saved: says what is missing and skips the Safaricom steps', async () => {
  const s = await shop();
  const r = await run(s, async () => J({}));
  assert.equal(r.status, 200);
  assert.equal(byId(r.d, 'saved').status, 'fail'); assert.equal(byId(r.d, 'login').status, 'skip');
  assert.match(r.d.summary, /Saved details/);
});

test('production keys refused by Safaricom login: reported with its words and the production advice', async () => {
  const s = await shop(PROD);
  const r = await run(s, async (u) => String(u).includes('/oauth/') ? J({ errorCode: '400.008.01', errorMessage: 'Invalid Authentication passed' }, 400) : J({}));
  const l = byId(r.d, 'login');
  assert.equal(l.status, 'fail'); assert.match(l.detail, /Invalid Authentication passed/); assert.match(l.fix, /go-live/i);
  assert.equal(byId(r.d, 'shortcode').status, 'skip');
  assert.ok(!JSON.stringify(r.d).includes('"p"'), 'no secrets');
});

test('login ok, shortcode ok (Safaricom only complains about the invented prompt), callback ok', async () => {
  const s = await shop(PROD);
  const urls = [];
  const r = await run(s, async (u) => {
    urls.push(String(u));
    if (String(u).includes('/oauth/')) return J({ access_token: 'tok', expires_in: '3599' });
    if (String(u).includes('stkpushquery')) return J({ requestId: 'x', errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' }, 500);
    return new Response('ok', { status: 200 });
  });
  assert.equal(byId(r.d, 'login').status, 'ok'); assert.equal(byId(r.d, 'shortcode').status, 'ok', JSON.stringify(byId(r.d, 'shortcode')));
  assert.equal(byId(r.d, 'callback').status, 'ok');
  assert.ok(urls.some((u) => u.startsWith('https://api.safaricom.co.ke/')), 'production host');
});

test('explainShortcode: wrong passkey, wrong shortcode, app not allowed', () => {
  const cfg = { mpesaShortcode: '600111' };
  const mk = (st, d) => ({ ok: true, status: st, data: d, text: JSON.stringify(d) });
  assert.equal(chk.explainShortcode(mk(400, { errorCode: '400.002.02', errorMessage: 'Bad Request - Wrong credentials' }), cfg).status, 'fail');
  assert.equal(chk.explainShortcode(mk(400, { errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid BusinessShortCode' }), cfg).status, 'fail');
  const na = chk.explainShortcode(mk(404, { errorCode: '404.001.03', errorMessage: 'Invalid Access Token' }), cfg);
  assert.equal(na.status, 'fail'); assert.match(na.fix, /M-Pesa Express/);
});

test('sandbox shortcode with production environment is flagged', async () => {
  const s = await shop({ ...PROD, mpesaShortcode: '174379' });
  const r = await run(s, async (u) => String(u).includes('/oauth/') ? J({ error: 'x' }, 400) : J({}));
  assert.equal(byId(r.d, 'sanity').status, 'warn'); assert.match(byId(r.d, 'sanity').detail, /174379/);
});

test('PAY_CALLBACK_ORIGIN overrides the callback host; junk is ignored', () => {
  const req = new Request('https://mydukapos.pages.dev/api/x');
  assert.equal(ck.callbackOrigin(req, {}), 'https://mydukapos.pages.dev');
  assert.equal(ck.callbackOrigin(req, { PAY_CALLBACK_ORIGIN: 'https://shop.co.ke/' }), 'https://shop.co.ke');
  assert.equal(ck.callbackOrigin(req, { PAY_CALLBACK_ORIGIN: 'http://insecure' }), 'https://mydukapos.pages.dev');
});

test('the Settings page has the button wired to the endpoint', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /daraja-check-btn/); assert.match(html, /\/api\/daraja-check/);
});

test('zip 256: failure reasons are explained, and what is sent is shown', async () => {
  assert.match(chk.explainFailure('Failed. The Agent number and Store number entered do not match.'), /Store/);
  assert.match(chk.explainFailure('Merchant does not exist'), /Paybill/);
  assert.match(chk.explainFailure('Failed due to an unresolved reason type.'), /generic/i);
  const s = await shop({ ...PROD, mpesaTransactionType: 'CustomerBuyGoodsOnline', mpesaPartyB: '5551234' });
  const r = await run(s, async (u) => String(u).includes('/oauth/') ? J({ error: 'x' }, 400) : J({}));
  const sent = byId(r.d, 'sent');
  assert.match(sent.detail, /BusinessShortCode: 600111/); assert.match(sent.detail, /PartyB\): 5551234/);
});

test('zip 256: a held Till/shortcode change is named in the test', async () => {
  const s = await shop(PROD);
  await gwl.saveGatewayConfig(s.env, s.id, { mpesaShortcode: '6075378' }, { cooldownMs: 3600000 });
  const r = await run(s, async (u) => String(u).includes('/oauth/') ? J({ error: 'x' }, 400) : J({}));
  assert.equal(byId(r.d, 'held').status, 'warn'); assert.match(byId(r.d, 'held').detail, /Shortcode/);
});
