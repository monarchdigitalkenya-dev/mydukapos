import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';
import { saveGatewayConfig } from '../functions/api/_gateway-config.js';

// zip 358 — direct Till payments that never showed up: path-based callback address, held payments the owner can accept, a callback that names no
// shop matched by its number, both numbers registered (C2B v2 first), Till health, and recovery of missed payments through Safaricom's Pull API.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const ORIGIN = 'https://shop-c1.mydukapos.store';
const BAD = /mpesa|m-pesa|safaricom|exe|exec|cmd|sql|query/i;
const pay = (id, amt, extra = {}) => ({ TransactionType: 'Buy Goods', TransID: id, TransTime: '20261107101500', TransAmount: String(amt), BusinessShortCode: '600100', BillRefNumber: '', MSISDN: '2547 ***** 126', FirstName: 'Jane', ...extra });

async function world() {
  const kv = makeKV(); seedShop(kv, 'C1', { type: 'permanent' });
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), ROOT_DOMAIN: 'mydukapos.store' };
  await saveGatewayConfig(env, 'C1', { mpesaConsumerKey: 'k', mpesaConsumerSecret: 's', mpesaShortcode: '600100', mpesaPasskey: 'p', mpesaEnv: 'production', mpesaTransactionType: 'CustomerBuyGoodsOnline', mpesaPartyB: '5123456' });
  const pcb = await load('functions/api/pcb/[[path]].js');
  const cb = await load('functions/api/mpesa-c2b-confirmation.js');
  const health = await load('functions/api/till-health.js');
  const key = (await (await load('functions/api/_callback-key.js')).ensureCallbackKey(env, 'C1', 'c2b')).k;
  const viaPath = (body, k = key, shop = 'C1', kind = 'c') => pcb.onRequestPost({ request: new Request(`${ORIGIN}/api/pcb/${shop}/${k}/${kind}`, { method: 'POST', body: JSON.stringify(body) }), params: { path: [shop, k, kind] }, env });
  const viaQuery = (body, qs) => cb.onRequestPost({ request: new Request(`${ORIGIN}/api/pay-cb-till-confirm${qs}`, { method: 'POST', body: JSON.stringify(body) }), env });
  const getHealth = () => health.onRequestGet({ request: new Request(`${ORIGIN}/api/till-health?c=C1`), env }).then((r) => r.json());
  const act = (body) => health.onRequestPost({ request: new Request(`${ORIGIN}/api/till-health?c=C1`, { method: 'POST', body: JSON.stringify(body) }), env }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const rows = () => { try { return env.LEDGER_DB.query('select * from till_payments'); } catch (e) { return []; } };   // no table yet = nothing listed
  return { kv, env, key, viaPath, viaQuery, getHealth, act, rows };
}

test('the path address /api/pcb/<shop>/<key>/c stores the payment exactly like the old one, and Safaricom always gets ResultCode 0', async () => {
  const w = await world();
  const r = await w.viaPath(pay('TKA1000001', 750));
  assert.equal(r.status, 200); assert.equal((await r.json()).ResultCode, 0);
  await w.viaPath(pay('TKA1000001', 750));                                    // a repeat
  assert.equal(w.rows().length, 1); assert.equal(w.rows()[0].amount, 750); assert.equal(w.rows()[0].status, 'UNLINKED');
  assert.equal(JSON.parse(w.kv.data.get('till-payment:C1:TKA1000001').value).trusted, true, 'a typed code verifies');
  const h = await w.getHealth();
  assert.equal(h.events[0].outcome, 'repeat'); assert.equal(h.events[1].outcome, 'accepted'); assert.ok(h.lastReceivedAt > 0);
  const v = await w.viaPath({}, w.key, 'C1', 'v'); assert.equal((await v.json()).ResultCode, 0, 'validation accepted');
  const p = await w.viaPath({}, w.key, 'C1', 'p'); assert.equal(p.status, 200, 'pull callback acknowledged');
  const junk = await w.viaPath(pay('TKA1000002', 5), 'x', 'C1', 'zz'); assert.equal(junk.status, 200);
});

test('a wrong key is HELD (not listed, not verifiable), shown in Till health, and the owner can accept or dismiss it', async () => {
  const w = await world();
  await w.viaPath(pay('TKB2000001', 1200, { FirstName: 'Otieno' }), 'deadbeef');
  await w.viaPath(pay('TKB2000002', 300), 'deadbeef');
  assert.equal(w.rows().length, 0, 'nothing listed');
  const h = await w.getHealth();
  assert.equal(h.held.length, 2); assert.equal(h.held[1].code, 'TKB2000001'); assert.equal(h.held[1].amount, 1200); assert.equal(h.held[1].name, 'Otieno'); assert.equal(h.held[1].why, 'held_key');
  assert.ok(h.checks.some((c) => /HELD/.test(c.text)));
  const a = await w.act({ action: 'accept', code: 'TKB2000001' });
  assert.equal(a.status, 200); assert.equal(a.listed, true);
  assert.equal(w.rows().length, 1); assert.equal(w.rows()[0].code, 'TKB2000001'); assert.equal(w.rows()[0].amount, 1200);
  assert.equal(JSON.parse(w.kv.data.get('till-payment:C1:TKB2000001').value).trusted, true, 'an accepted payment verifies when typed');
  assert.equal((await w.act({ action: 'accept', code: 'TKB2000001' })).status, 404, 'accepted once only');
  assert.equal((await w.act({ action: 'dismiss', code: 'TKB2000002' })).status, 200);
  assert.equal((await w.getHealth()).held.length, 0);
  assert.equal(w.rows().length, 1, 'the dismissed one is not listed');
});

test('a callback with NO shop in its address is matched by its Till / Store number and held for that shop; an unknown number is kept aside', async () => {
  const w = await world();
  const { mapShortcodes } = await load('functions/api/_till-diag.js');
  await mapShortcodes(w.env, 'C1', ['600100', '5123456']);
  await w.viaQuery(pay('TKC3000001', 450), '');
  const h = await w.getHealth();
  assert.equal(h.held.length, 1); assert.equal(h.held[0].why, 'held_nokey'); assert.equal(w.rows().length, 0);
  await w.viaQuery(pay('TKC3000002', 99, { BusinessShortCode: '777777' }), '');
  assert.ok(w.kv.data.get('c2b-orphan:777777'), 'unknown number recorded for the platform owner');
  assert.equal((await w.getHealth()).held.length, 1);
});

async function withFetch(handler, fn) {
  const real = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init = {}) => { const body = init.body ? JSON.parse(init.body) : null; calls.push({ url: String(url), body }); return handler(String(url), body); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const ok = (b) => new Response(JSON.stringify(b), { status: 200 });

test('Register Till URLs: BOTH numbers, C2B v2 first, a path address with no query string and no banned word; numbers mapped; Till health shows it', async () => {
  const w = await world();
  const reg = await load('functions/api/mpesa-c2b-register.js');
  await withFetch((url) => url.includes('oauth') ? ok({ access_token: 't' }) : ok({ ResponseCode: '0', ResponseDescription: 'Success' }), async (calls) => {
    const r = await reg.onRequestPost({ request: new Request(`${ORIGIN}/api/mpesa-c2b-register?c=C1`, { method: 'POST' }), env: w.env });
    const d = await r.json();
    assert.equal(r.status, 200, JSON.stringify(d)); assert.equal(d.success, true);
    const regs = calls.filter((c) => /registerurl/.test(c.url));
    assert.equal(regs.length, 2); assert.deepEqual(regs.map((c) => c.body.ShortCode), ['600100', '5123456'], 'Store number first, then the Till');
    assert.ok(regs.every((c) => /\/c2b\/v2\/registerurl/.test(c.url)), 'v2 first');
    for (const c of regs) {
      assert.equal(c.body.ResponseType, 'Completed');
      for (const u of [c.body.ConfirmationURL, c.body.ValidationURL]) { assert.ok(!u.includes('?'), u); assert.ok(!BAD.test(u.replace(ORIGIN, '')), u); }
      assert.equal(c.body.ConfirmationURL, `${ORIGIN}/api/pcb/C1/${w.key}/c`);
    }
    assert.ok(!JSON.stringify(d).includes(w.key), 'the key is never shown to the page');
  });
  assert.equal(w.kv.data.get('c2b-sc:600100').value, 'C1'); assert.equal(w.kv.data.get('c2b-sc:5123456').value, 'C1');
  const h = await w.getHealth();
  assert.equal(h.registration.form, 'path'); assert.equal(h.registration.results.length, 2);
  assert.ok(h.checks.some((c) => /no payment notice has arrived yet/i.test(c.text)), 'tells the owner to test with KES 10 and what to check in Cloudflare');
});

test('Register: "already registered" on one number is reported and the other number still counts; both already -> explains URL Management', async () => {
  const w = await world();
  const reg = await load('functions/api/mpesa-c2b-register.js');
  const dup = new Response(JSON.stringify({ errorCode: '500.003.1001', errorMessage: 'Urls are already registered' }), { status: 500 });
  let n = 0;
  await withFetch((url) => url.includes('oauth') ? ok({ access_token: 't' }) : (n++ === 0 ? dup.clone() : ok({ ResponseCode: '0', ResponseDescription: 'Success' })), async () => {
    const d = await (await reg.onRequestPost({ request: new Request(`${ORIGIN}/api/mpesa-c2b-register?c=C1`, { method: 'POST' }), env: w.env })).json();
    assert.equal(d.success, true); assert.match(d.message, /5123456/); assert.match(d.message, /already registered/);
  });
  await withFetch((url) => url.includes('oauth') ? ok({ access_token: 't' }) : dup.clone(), async () => {
    const r = await reg.onRequestPost({ request: new Request(`${ORIGIN}/api/mpesa-c2b-register?c=C1`, { method: 'POST' }), env: w.env });
    const d = await r.json();
    assert.equal(r.status, 500); assert.match(d.error, /URL Management/); assert.match(d.error, /ONCE/);
  });
});

test('Recover missed payments (Pull Transactions): registers once with the business phone, lists only what is missing, never twice', async () => {
  const w = await world();
  await w.viaPath(pay('TKD4000001', 100));                                   // already captured by the callback
  const answer = { ResponseRefID: 'x', ResponseCode: '1000', ResponseMessage: 'Success', Response: [[
    { transactionId: 'TKD4000001', trxDate: '2026-11-07 10:15:00', msisdn: '2547****126', transactiontype: 'c2b-buy-goods-debit', billreference: '', amount: '100.00' },
    { transactionId: 'TKD4000002', trxDate: '2026-11-07 10:20:00', msisdn: '2547****555', transactiontype: 'c2b-buy-goods-debit', billreference: '', amount: '2500.00' },
    { transactionId: 'TKD4000003', trxDate: '2026-11-07 10:25:00', msisdn: '2547****777', transactiontype: 'reversal', billreference: '', amount: '50.00' },
  ]] };
  // no phone yet -> asks for it, nothing registered
  await withFetch((url) => url.includes('oauth') ? ok({ access_token: 't' }) : ok({}), async () => {
    const r = await w.act({ action: 'pull', hours: 24 });
    assert.equal(r.status, 502); assert.match(r.message, /phone number/);
  });
  w.kv.data.delete('till-pull-lock:C1');
  await withFetch((url) => url.includes('oauth') ? ok({ access_token: 't' }) : url.includes('/register') ? ok({ ResponseRefID: 'r', ResponseCode: '1000', ResponseMessage: 'Success' }) : url.includes('/query') ? (globalThis.__q = (globalThis.__q || 0) + 1, ok(globalThis.__q % 2 ? answer : { ResponseCode: '1000', Response: [[]] })) : ok({}), async (calls) => {
    const r = await w.act({ action: 'pull', hours: 24, phone: '0712345678' });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.added, 1, 'only the missing payment is added (the reversal is skipped)');
    const reg = calls.find((c) => /pulltransactions\/v1\/register/.test(c.url));
    assert.equal(reg.body.NominatedNumber, '254712345678'); assert.equal(reg.body.RequestType, 'Pull');
    assert.ok(!reg.body.CallBackURL.includes('?') && !BAD.test(reg.body.CallBackURL.replace(ORIGIN, '')), reg.body.CallBackURL);
    const q = calls.find((c) => /pulltransactions\/v1\/query/.test(c.url));
    assert.match(q.body.StartDate, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/); assert.equal(q.body.OffSetValue, '0');
  });
  const codes = w.rows().map((r) => r.code).sort();
  assert.deepEqual(codes, ['TKD4000001', 'TKD4000002']);
  const added = w.rows().find((r) => r.code === 'TKD4000002');
  assert.equal(added.amount, 2500); assert.equal(added.paid_at, Date.UTC(2026, 10, 7, 7, 20, 0), 'Safaricom time is East Africa Time');
  assert.equal(JSON.parse(w.kv.data.get('till-payment:C1:TKD4000002').value).trusted, true);
  const again = await w.act({ action: 'pull' });
  assert.equal(again.status, 429, 'one recovery every 2 minutes');
  w.kv.data.delete('till-pull-lock:C1');
  await withFetch((url) => url.includes('oauth') ? ok({ access_token: 't' }) : url.includes('/query') ? (globalThis.__q2 = (globalThis.__q2 || 0) + 1, ok(globalThis.__q2 === 1 ? answer : { Response: [[]] })) : ok({}), async (calls) => {
    const r = await w.act({ action: 'pull', hours: 48 });
    assert.equal(r.added, 0, 'nothing twice'); assert.ok(!calls.some((c) => /\/register/.test(c.url)), 'registered once only');
  });
  assert.equal(w.rows().length, 2);
  assert.equal((await w.getHealth()).pullReady, true);
});

test('helpers: Pull date format and parsing', async () => {
  const h = await load('functions/api/till-health.js');
  assert.equal(h.eatStamp(Date.UTC(2026, 10, 7, 7, 5, 9)), '2026-11-07 10:05:09');
  assert.equal(h.pullTime('20261107100509', 0), Date.UTC(2026, 10, 7, 7, 5, 9));
  assert.equal(h.pullTime('2026-11-07T10:05:09+03:00', 0), Date.UTC(2026, 10, 7, 7, 5, 9));
  assert.equal(h.pullRows({ Response: [[{ transactionId: 'A', amount: '1' }], [{ transactionId: 'B', amount: '2' }]] }).length, 2);
});

test('POS screen: compact snackbar (queued, with Match), plain "Till" button, "= CART TOTAL" tag, and the 🩺 Health view with held payments', { timeout: 240000 }, async () => {
  const { boot } = await import('./helpers.mjs');
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify([{ code: 'A', type: 'item', name: 'Alpha', category: 'General', price: 480, wholesalePrice: 300, qty: 10, unit: 'pcs' }]) }, wait: 900 });
  const { w } = b; const d = w.document;
  const now = Date.now();
  const pays = [{ code: 'TKA1', amount: 1250, paidAt: now, name: 'PETER KAMAU', status: 'UNLINKED', source: 'direct' }, { code: 'TKA2', amount: 480, paidAt: now - 1000, name: 'JANE', status: 'UNLINKED', source: 'direct' }];
  const health = { registration: { at: now, form: 'path', results: [{ shortCode: '600100', ok: true, version: 'v2' }] }, events: [{ at: now, outcome: 'accepted', code: 'TKA1', amount: 1250 }], held: [{ code: 'TKH9', amount: 700, paidAt: now, name: 'ALI' }], lastReceivedAt: now, checks: [], pullReady: true };
  w.__posted = [];
  w.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = u.includes('till-health') ? (init.method === 'POST' ? (w.__posted.push(JSON.parse(init.body)), { ok: true, message: 'Accepted' }) : health) : u.includes('till-payments') ? { payments: pays, unlinked: 2 } : u.includes('gateway-config') ? { hasDarajaConfig: true } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });   // node Response (jsdom has none)
  };
  w.eval("window.requireManagementApproval = function (m, fn) { fn(); }; window.confirm = () => true;");
  const TP = () => w.__tillPay;
  TP()._announce(pays[0]); TP()._announce(pays[1]);
  const t = d.getElementById('tp-toast');
  assert.ok(t.classList.contains('on')); assert.match(t.textContent, /DIRECT TILL PAYMENT/); assert.match(t.textContent, /JANE/); assert.match(t.textContent, /\+1 more/);
  assert.ok(t.querySelector('.tp-tact'), 'one action: Match');
  t.querySelector('.tp-tx2').click(); assert.ok(!t.classList.contains('on'), 'dismissable');
  TP()._paintBtn(); const lab = d.getElementById('tp-lab'); if (lab) assert.equal(lab.textContent, 'Till', 'no name squeezed into the checkout header');
  w.eval("currentCart = {}; addToCart('A')");
  assert.equal(TP()._cartMatches(480), true); assert.equal(TP()._cartMatches(1250), false);
  TP().open(); await new Promise((r) => setTimeout(r, 300));
  for (let i = 0; i < 30 && !d.querySelector('#tp-body .tp-card'); i++) await new Promise((r) => setTimeout(r, 100));
  const cards = [...d.querySelectorAll('#tp-body .tp-card')];
  assert.ok(cards.length, d.getElementById('tp-body').textContent.slice(0, 300));
  assert.match(cards[0].textContent, /= CART TOTAL/); assert.match(cards[0].textContent, /JANE/, 'the payment equal to the cart is listed first');
  d.getElementById('tp-health').click(); await new Promise((r) => setTimeout(r, 300));
  const hb = d.getElementById('tp-health-in');
  assert.match(hb.textContent, /Working/); assert.match(hb.textContent, /600100/); assert.match(hb.textContent, /TKH9/); assert.match(hb.textContent, /Recover/);
  hb.querySelector('[data-th-accept="TKH9"]').click(); await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(w.__posted[0], { action: 'accept', code: 'TKH9', by: w.eval("typeof activeServerName === 'function' ? activeServerName() : ''") });
  b.close();
});
