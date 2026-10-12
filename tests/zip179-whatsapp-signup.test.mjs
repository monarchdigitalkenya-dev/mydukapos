import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, boot } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const post = (body, ip = '2.2.2.2') => new Request('https://mydukapos.store/api/demo-account', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body) });
const base = { action: 'register', channel: 'website', acceptTerms: true, fullName: 'Wanjiru K', phone: '0712 345 678', password: 'Tr1cky-pass', confirmPassword: 'Tr1cky-pass' };

test('sign-up: WhatsApp number required, email optional; phone-only accounts sign in by number (and email accounts by either)', async () => {
  const da = await load('functions/api/demo-account.js');
  const env = { mydukapos_kv: makeKV() };
  const call = (b, ip) => da.onRequestPost({ request: post(b, ip), env });
  let r = await call({ ...base, phone: '' }); assert.equal(r.status, 400); assert.match((await r.json()).error, /WhatsApp/);
  r = await call({ ...base, phone: '12' }); assert.equal(r.status, 400, 'junk number refused');
  r = await call({ ...base, email: 'not-an-email' }); assert.equal(r.status, 400, 'a bad email is refused, not ignored');
  r = await call({ ...base }); assert.equal(r.status, 200, await r.clone().text());           // no email at all
  const tok = (await r.json()).token; assert.ok(tok);
  r = await call({ ...base, phone: '+254712345678' }); assert.equal(r.status, 409, 'same number twice');
  for (const who of ['0712345678', '+254 712 345 678', '712345678']) {
    r = await call({ action: 'login', email: who, password: 'Tr1cky-pass' }); assert.equal(r.status, 200, who);
  }
  r = await call({ action: 'login', email: '0712345678', password: 'wrong-pass-1' }); assert.equal(r.status, 401);
  r = await call({ action: 'dashboard', token: tok }); const d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.email, '', 'no fake email shown'); assert.equal(d.phone, '0712 345 678');
  // second person, with an email: can sign in with the email or the number
  r = await call({ ...base, phone: '0722000111', email: 'Jo@Example.com' }, '3.3.3.3'); assert.equal(r.status, 200);
  for (const who of ['jo@example.com', '0722000111']) { r = await call({ action: 'login', email: who, password: 'Tr1cky-pass' }); assert.equal(r.status, 200, who); }
  // forgot-password for a phone-only account is the generic reply and never tries to mail the placeholder
  r = await call({ action: 'forgot-password', email: '0712345678' }); assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
});

test('POS sign-up form: only the WhatsApp number is required', async () => {
  for (const app of ['index.html', 'water/index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html']) {
    const fs = await import('node:fs');
    const html = fs.readFileSync(path.join(ROOT, app), 'utf8');
    assert.match(html, /id="signup-phone"[^>]*required/, app);
    assert.match(html, /id="signup-email" placeholder="Email Address \(optional\)"/, app);
    assert.ok(!/Enter your email address\.'; return; \}/.test(html), app + ' still demands an email');
  }
});

test('STK push: a payment the status poll confirmed is verified at once, others still wait for the lookup', async () => {
  const { w, close } = await boot('index.html', { wait: 800 });
  try {
    w.localStorage.removeItem('pos_stk_confirmed');
    w.eval(`salesLog.length = 0;
      salesLog.push({ id: 's1', timestamp: new Date().toISOString(), mpesaAmount: 500, mpesaReceiptNumber: 'ABC123XYZ9' });
      salesLog.push({ id: 's2', timestamp: new Date().toISOString(), mpesaAmount: 500, mpesaReceiptNumber: 'TYPEDCODE1' });`);
    w.posNetOffline = () => false;
    w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'not_found' }) });
    w.mpesaNoteConfirmed('abc123xyz9', 500);
    await w.mpesaVerifyNow();
    const sales = JSON.parse(w.eval('JSON.stringify(salesLog)'));
    const a = sales.find((x) => x.id === 's1'), b = sales.find((x) => x.id === 's2');
    assert.equal(a.mpesaCheck.status, 'verified'); assert.equal(a.mpesaCheck.source, 'stk-confirmed');
    assert.equal(b.mpesaCheck.status, 'not_found', 'a typed code is not trusted');
  } finally { close && close(); }
});

test('verification is never forced and its box is hidden by default', async () => {
  const da = await load('functions/api/demo-account.js');
  const env = { mydukapos_kv: makeKV(), WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_OTP_TEMPLATE: 'x' };   // WhatsApp fully configured, still nothing forced
  const call = (b) => da.onRequestPost({ request: post(b, '4.4.4.4'), env });
  let r = await call({ ...base, product: 'shop', businessName: 'Duka' }); assert.equal(r.status, 200, await r.clone().text());
  const tok = (await r.json()).token;
  r = await call({ action: 'dashboard', token: tok }); assert.equal((await r.json()).verifyUi, false);
  r = await call({ action: 'generate-demo', token: tok, product: 'shop', businessName: 'Duka 2' });
  assert.equal(r.status, 410); assert.equal((await r.json()).code, 'demo_generation_retired', 'zip 262: no per-visitor demo is generated any more');
  env.SHOW_VERIFY_UI = '1'; r = await call({ action: 'dashboard', token: tok }); assert.equal((await r.json()).verifyUi, true);
});
