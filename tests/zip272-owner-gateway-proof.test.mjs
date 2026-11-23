// zip 272: the Owner Console's payment-settings save (Paywave Express, Daraja, KCB ...) against the REAL gateway-config server code.
// A shop that has an Admin password answers 401 pay_confirm_required; the console used to hide that behind "Could not save". It now asks for the
// password (masked), sends the SHA-256 as X-Pay-Proof like the shop apps, and says WHY when it still cannot save.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';

const imp = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sealed = (pin, salt = 'saltsalt', iter = 1000) => `p2$${iter}$${salt}$${crypto.pbkdf2Sync(sha(pin), salt, iter, 32, 'sha256').toString('hex')}`;
const sync = await imp('pos-sync.js'), gw = await imp('gateway-config.js'), lic = await imp('_license.js'), gwl = await imp('_gateway-config.js');

const page = fs.readFileSync(path.join(ROOT, 'owner/index.html'), 'utf8');
const SRC = page.slice(page.indexOf('let gatewayProof = null;'), page.indexOf('async function saveGatewayPaywaveConfig'));

async function shopWith(password) {
  const env = { mydukapos_kv: makeKV(), LICENSE_CACHE_MS: '0', PAYMENT_SECRETS_KEY: 'k'.repeat(32) };
  const rec = await lic.createClient(env, 'permanent', 'Owner', 'shop', { phone: '0712345678' });
  const state = { businessName: 'Biz', updatedAt: Date.now() }; if (password) state.pwHash = sealed(password);
  await sync.onRequestPost({ request: new Request(`https://x.pages.dev/api/pos-sync?c=${rec.id}`, { method: 'POST', body: JSON.stringify(state) }), env, waitUntil() {} });
  return { env, id: rec.id };
}
function consoleWindow(shop) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://mydukapos.store/owner/' });
  const w = dom.window;
  Object.defineProperty(w, 'crypto', { value: globalThis.crypto, configurable: true }); w.TextEncoder = globalThis.TextEncoder;
  w.apiUrl = (p) => `https://x.pages.dev${p}?c=${shop.id}`;
  w.fetch = async (url, init) => gw[`onRequest${init.method[0]}${init.method.slice(1).toLowerCase()}`]({ request: new Request(url, init), env: shop.env, waitUntil() {} });
  w.eval(SRC);
  return w;
}
const until = async (fn) => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); } throw new Error('timed out'); };
const BODY = { paywaveApiKey: 'KEY123', paywaveEmail: 'a@b.co' };
const post = (w, body) => w.gatewayFetch({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('a shop with NO password saves at once; the password pop-up never appears', async () => {
  const shop = await shopWith(null), w = consoleWindow(shop);
  const res = await post(w, BODY);
  assert.equal(res.status, 200); assert.equal(w.document.getElementById('gw-pw'), null);
  assert.equal(gwl.hasPaywaveConfig(await gwl.loadGatewayConfig(shop.env, shop.id)), true);
});

test('a shop WITH an Admin password: the console asks (masked), sends the proof, and the keys are saved', async () => {
  const shop = await shopWith('shoppass'), w = consoleWindow(shop);
  const p = post(w, BODY);
  const inp = await until(() => w.document.getElementById('gw-pw'));
  assert.equal(inp.type, 'password', 'what is typed is hidden');
  inp.value = 'shoppass'; w.document.getElementById('gw-pw-ok').click();
  const res = await p;
  assert.equal(res.status, 200);
  assert.equal(gwl.hasPaywaveConfig(await gwl.loadGatewayConfig(shop.env, shop.id)), true);
  // the next save inside 90 s does not ask again
  const again = await post(w, { paywaveApiKey: 'KEY456', paywaveEmail: 'a@b.co' });
  assert.equal(again.status, 200); assert.equal(w.document.getElementById('gw-pw'), null);
});

test('a wrong password says so and asks again; Cancel stops with the server\'s own reason; nothing is saved', async () => {
  const shop = await shopWith('shoppass'), w = consoleWindow(shop);
  const p = post(w, BODY);
  let inp = await until(() => w.document.getElementById('gw-pw'));
  inp.value = 'nope'; w.document.getElementById('gw-pw-ok').click();
  await until(() => { const n = w.document.getElementById('gw-pw-note'); return n && /not right/.test(n.textContent); });
  w.document.getElementById('gw-pw-no').click();
  const res = await p;
  assert.equal(res.ok, false);
  assert.match(await w.gatewaySaveFailText(res), /Incorrect password.*pay_confirm_failed/);
  assert.equal(gwl.hasPaywaveConfig(await gwl.loadGatewayConfig(shop.env, shop.id)), false);
});

test('the three save buttons and Reset go through the same helper, and the error text is shown', () => {
  assert.equal((page.match(/gatewayFetch\(\{/g) || []).length, 5, 'every payment-settings write asks for the proof');
  assert.ok(!/fetch\(apiUrl\('\/api\/gateway-config'\), \{/.test(page.replace(/fetch\(apiUrl\('\/api\/gateway-config'\), \{ \.\.\./, '')));
  assert.equal((page.match(/e && e\.shown \? 'Not saved: ' \+ e\.message/g) || []).length, 3);
});
