import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeKV } from './kv-fake.mjs';

// Zip 249 — Daraja with production keys. Pasting the production keys must just work:
//   * keys saved under SANDBOX are replaced at once (no 60-minute hold, no sandbox keys left talking to the production address);
//     keys that were saved as PRODUCTION keys are still held when replaced (the zip 247 protection is unchanged);
//   * a Till (Buy Goods) shop has a Store / Head Office number (BusinessShortCode + password) AND a Till number (PartyB);
//   * the timestamp is Nairobi time, and Safaricom's own error text + code reaches the till.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hdr = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const adminProof = (pw) => hdr({ a: true, p: sha(pw) });
const gw = await imp('gateway-config.js');
const gwl = await imp('_gateway-config.js');
const stk = await imp('mpesa-stkpush.js');
const lic = await imp('_license.js');

async function shop(opts = {}) {
  const kv = makeKV();
  const env = { mydukapos_kv: kv, LICENSE_CACHE_MS: '0', ...(opts.env || {}) };
  const rec = await lic.createClient(env, 'permanent', 'Makesh Liquor', 'shop', { phone: '0712345678', email: '' });
  return { kv, env, id: rec.id };
}
const P = adminProof('shoppass');
const call = async (mod, method, ctx, { body, proof, query = '' } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (proof) headers['X-Pay-Proof'] = proof;
  const request = new Request(`https://x.pages.dev/api/x?c=${ctx.id}${query}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await mod[`onRequest${method[0]}${method.slice(1).toLowerCase()}`]({ request, env: ctx.env, waitUntil() {} });
  let d = {}; try { d = await res.clone().json(); } catch (e) { /* none */ }
  return { status: res.status, d };
};
// no sms/staff/password on these shops: a shop with NO password has nothing to prove with and passes (zip 247), so a proof header is simply not needed
const save = (s, body) => call(gw, 'POST', s, { body, proof: P });
const SANDBOX = (n) => ({ mpesaEnv: 'sandbox', mpesaConsumerKey: 'sbk' + n, mpesaConsumerSecret: 'sbs' + n, mpesaShortcode: '174379', mpesaPasskey: 'sbp' + n });
const PROD = (n) => ({ mpesaEnv: 'production', mpesaConsumerKey: 'prk' + n, mpesaConsumerSecret: 'prs' + n, mpesaShortcode: '600111', mpesaPasskey: 'prp' + n });

test('pasting the production keys over sandbox keys applies AT ONCE (not held), environment included', async () => {
  const s = await shop();
  assert.equal((await save(s, SANDBOX('1'))).status, 200);
  const r = await save(s, PROD('1'));
  assert.equal(r.status, 200, JSON.stringify(r.d)); assert.equal(r.d.held, null, 'nothing is waiting');
  const cfg = await gwl.loadGatewayConfig(s.env, s.id);
  assert.equal(cfg.mpesaEnv, 'production'); assert.equal(cfg.mpesaConsumerKey, 'prk1'); assert.equal(cfg.mpesaConsumerSecret, 'prs1');
  assert.equal(cfg.mpesaShortcode, '600111'); assert.equal(cfg.mpesaPasskey, 'prp1');
  assert.equal(await gwl.getPendingChange(s.env, s.id), null);
});

test('the environment was switched to production first, sandbox keys still saved: the production keys are STILL not held', async () => {
  const s = await shop();
  await save(s, SANDBOX('1'));
  assert.equal((await save(s, { mpesaEnv: 'production' })).d.held, null);
  const r = await save(s, { mpesaConsumerKey: 'prk2', mpesaConsumerSecret: 'prs2', mpesaShortcode: '600111', mpesaPasskey: 'prp2' });
  assert.equal(r.d.held, null, 'the saved keys were sandbox keys: nothing real to protect');
  assert.equal((await gwl.loadGatewayConfig(s.env, s.id)).mpesaConsumerKey, 'prk2');
});

test('a Till number saved on its own does not turn the saved sandbox keys into "live" keys', async () => {
  const s = await shop();
  await save(s, SANDBOX('1'));
  assert.equal((await save(s, { mpesaEnv: 'production', mpesaPartyB: '5551234' })).d.held, null);
  const r = await save(s, { mpesaConsumerKey: 'prk3', mpesaConsumerSecret: 'prs3', mpesaShortcode: '600111', mpesaPasskey: 'prp3' });
  assert.equal(r.d.held, null);
  assert.equal((await gwl.loadGatewayConfig(s.env, s.id)).mpesaConsumerKey, 'prk3');
});

test('once the PRODUCTION keys are saved, replacing them is HELD (the old ones keep working) — the zip 247 protection is unchanged', async () => {
  const s = await shop({ env: { PAYMENT_CHANGE_COOLDOWN_MIN: '60' } });
  await save(s, SANDBOX('1'));
  await save(s, PROD('1'));
  const r = await save(s, { mpesaConsumerKey: 'EVIL', mpesaShortcode: '999999' });
  assert.deepEqual(r.d.held.providers, ['daraja']);
  const cfg = await gwl.loadGatewayConfig(s.env, s.id);
  assert.equal(cfg.mpesaConsumerKey, 'prk1', 'the live key keeps working'); assert.equal(cfg.mpesaShortcode, '600111');
  // a shop whose first-ever save is production keys is live from the start
  const t = await shop({ env: { PAYMENT_CHANGE_COOLDOWN_MIN: '60' } });
  await save(t, PROD('1'));
  assert.deepEqual((await save(t, { mpesaPasskey: 'other' })).d.held.providers, ['daraja']);
});

test('Reset Daraja clears the keys, the Till number and the "saved as" marker: the next paste is a fresh first-time setup', async () => {
  const s = await shop({ env: { PAYMENT_CHANGE_COOLDOWN_MIN: '60' } });
  await save(s, { ...PROD('1'), mpesaTransactionType: 'CustomerBuyGoodsOnline', mpesaPartyB: '5551234' });
  assert.equal((await call(gw, 'DELETE', s, { body: { which: 'daraja' }, proof: P })).status, 200);
  const cfg = await gwl.loadGatewayConfig(s.env, s.id);
  assert.equal(cfg.mpesaConsumerKey, ''); assert.equal(cfg.mpesaPartyB, '');
  assert.equal((await save(s, PROD('2'))).d.held, null);
});

test('Till number: digits only; GET hands it (and the Paybill / Till choice) back so Settings can pre-fill; it never reaches another shop', async () => {
  const s = await shop();
  assert.equal((await save(s, { mpesaPartyB: 'abc' })).status, 400);
  assert.equal((await save(s, { mpesaPartyB: '12' })).status, 400, 'too short');
  const ok = await save(s, { ...PROD('1'), mpesaTransactionType: 'CustomerBuyGoodsOnline', mpesaPartyB: ' 5551234 ' });
  assert.equal(ok.status, 200, JSON.stringify(ok.d));
  const g = await call(gw, 'GET', s);
  assert.equal(g.d.mpesaPartyB, '5551234'); assert.equal(g.d.mpesaTransactionType, 'CustomerBuyGoodsOnline');
  assert.ok(!JSON.stringify(g.d).includes('prs1') && !JSON.stringify(g.d).includes('prp1'), 'secrets are still never returned');
  const other = await shop();
  assert.equal((await call(gw, 'GET', other)).d.mpesaPartyB, '');
});

// ---- what is actually sent to Safaricom
async function withSafaricom(fn, { stkReply } = {}) {
  const real = globalThis.fetch, seen = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    seen.push({ url: u, init });
    if (u.includes('/oauth/v1/generate')) return new Response(JSON.stringify({ access_token: 'TOKEN123', expires_in: '3599' }), { status: 200 });
    if (u.includes('/mpesa/stkpush/v1/processrequest')) {
      const r = stkReply || { status: 200, body: { MerchantRequestID: 'mr1', CheckoutRequestID: 'ws_CO_1', ResponseCode: '0', ResponseDescription: 'Success', CustomerMessage: 'Success. Request accepted for processing' } };
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    return new Response('{}', { status: 404 });
  };
  try { return { result: await fn(), seen }; } finally { globalThis.fetch = real; }
}
const stkBodyOf = (seen) => JSON.parse(seen.find((x) => x.url.includes('/processrequest')).init.body);
const send = (s) => call(stk, 'POST', s, { body: { phone: '0712345678', amount: 10, accountRef: 'INV1', description: 'Sale' } });

test('Paybill: BusinessShortCode and PartyB are the same number, production address, correct password, Nairobi-time timestamp', async () => {
  const s = await shop();
  await save(s, { ...PROD('1'), mpesaTransactionType: 'CustomerPayBillOnline', mpesaPartyB: '5551234', provider: 'daraja' });
  const before = Date.now();
  const { result, seen } = await withSafaricom(() => send(s));
  assert.equal(result.status, 200, JSON.stringify(result.d)); assert.equal(result.d.checkoutRequestId, 'ws_CO_1');
  assert.ok(seen[0].url.startsWith('https://api.safaricom.co.ke/oauth/v1/generate'), 'production address: ' + seen[0].url);
  assert.equal(seen[0].init.headers.Authorization, 'Basic ' + Buffer.from('prk1:prs1').toString('base64'));
  const b = stkBodyOf(seen);
  assert.ok(seen.find((x) => x.url.includes('/processrequest')).url.startsWith('https://api.safaricom.co.ke/'));
  assert.equal(b.BusinessShortCode, '600111'); assert.equal(b.PartyB, '600111', 'a Paybill ignores any saved Till number');
  assert.equal(b.TransactionType, 'CustomerPayBillOnline'); assert.equal(b.PartyA, '254712345678'); assert.equal(b.PhoneNumber, '254712345678'); assert.equal(b.Amount, 10);
  assert.match(b.Timestamp, /^\d{14}$/);
  assert.equal(Buffer.from(b.Password, 'base64').toString(), '600111prp1' + b.Timestamp, 'password = shortcode + passkey + the SAME timestamp');
  // Nairobi time = UTC + 3 hours
  const ts = b.Timestamp, asUtc = Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12), +ts.slice(12, 14));
  const nairobiNow = Date.now() + 3 * 3600e3;
  assert.ok(asUtc >= before + 3 * 3600e3 - 2000 && asUtc <= nairobiNow + 2000, 'timestamp is Nairobi time: ' + ts);
  assert.match(b.CallBackURL, /^https:\/\/x\.pages\.dev\/api\/pay-cb-stk\?c=.+&k=[0-9a-f]{32}$/, 'signed callback URL: ' + b.CallBackURL);
});

test('Till: BusinessShortCode = the Store / Head Office number (and the password), PartyB = the Till number', async () => {
  const s = await shop();
  await save(s, { ...PROD('1'), mpesaTransactionType: 'CustomerBuyGoodsOnline', mpesaPartyB: '5551234', provider: 'daraja' });
  const { result, seen } = await withSafaricom(() => send(s));
  assert.equal(result.status, 200, JSON.stringify(result.d));
  const b = stkBodyOf(seen);
  assert.equal(b.BusinessShortCode, '600111'); assert.equal(b.PartyB, '5551234'); assert.equal(b.TransactionType, 'CustomerBuyGoodsOnline');
  assert.equal(Buffer.from(b.Password, 'base64').toString(), '600111prp1' + b.Timestamp, 'the password still uses the Store number');
});

test('Till with no separate Till number saved (Store number = Till number): PartyB is the shortcode, exactly as before', async () => {
  const s = await shop();
  await save(s, { ...PROD('1'), mpesaTransactionType: 'CustomerBuyGoodsOnline', provider: 'daraja' });
  const { seen } = await withSafaricom(() => send(s));
  assert.equal(stkBodyOf(seen).PartyB, '600111');
});

test('Safaricom\'s own refusal reaches the till with its error code; a non-JSON answer does not crash the handler', async () => {
  const s = await shop();
  await save(s, { ...PROD('1'), provider: 'daraja' });
  let { result } = await withSafaricom(() => send(s), { stkReply: { status: 400, body: { requestId: 'r', errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid BusinessShortCode' } } });
  assert.equal(result.status, 500); assert.match(result.d.error, /Invalid BusinessShortCode/); assert.match(result.d.error, /400\.002\.02/);
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes('/oauth/') ? new Response(JSON.stringify({ access_token: 'T' }), { status: 200 }) : new Response('<html>Bad gateway</html>', { status: 502 });
  try {
    const r = await send(s);
    assert.equal(r.status, 500); assert.match(r.d.error, /HTTP 502/);
  } finally { globalThis.fetch = real; }
});
