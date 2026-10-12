// zip 259: Sales Counter -> Till Payments, in the REAL apps, talking to the REAL server code (till-payments.js over fake KV + D1).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, boot } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';

const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hospital/index.html'];
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const quiet = (w) => w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => d; window.print = () => {};");
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await tick(50); } return false; };
const BILL = (id, name, price) => ({ id, timestamp: new Date().toISOString(), customerName: name, customerPhone: '0712345678', servedBy: 'Admin', items: [{ code: 'A', name: 'Alpha', qty: 1, price, unit: 'pcs', vatCategory: 'A' }], amountPaid: 0, status: 'unpaid', closed: false, fulfillmentType: 'carried_immediately', fulfillmentStatus: 'fulfilled', inventoryDeducted: true, paymentHistory: [] });

async function server() {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), ROOT_DOMAIN: 'mydukapos.store' };
  const cb = await load('functions/api/mpesa-c2b-confirmation.js'), tp = await load('functions/api/till-payments.js');
  const key = (await (await load('functions/api/_callback-key.js')).ensureCallbackKey(env, 'C1', 'c2b')).k;
  const receive = (id, amt, time, first = 'Jane', last = 'Wanjiru') => cb.onRequestPost({ request: new Request(`https://shop-c1.mydukapos.store/api/pay-cb-till-confirm?c=C1&k=${key}`, { method: 'POST', body: JSON.stringify({ TransID: id, TransAmount: String(amt), TransTime: time, MSISDN: '254712345678', FirstName: first, LastName: last }) }), env });
  const fetchStub = async (u, init = {}) => {
    const s = String(u); if (!/\/api\/till-payments/.test(s)) return new Response('{}', { status: 404 });
    const req = new Request('https://shop-c1.mydukapos.store/api/till-payments' + (s.includes('?') ? s.slice(s.indexOf('?')) : '?c=C1'), { method: init.method || 'GET', body: init.body });
    return (init.method === 'POST' ? tp.onRequestPost : tp.onRequestGet)({ request: req, env });
  };
  return { env, receive, fetchStub };
}

for (const app of APPS) {
  test(`${app}: Till Payments lists newest first, links to a bill (balance and status right), to a sale, and never applies twice`, { timeout: 120000 }, async () => {
    const sv = await server();
    await sv.receive('QAB9000001', 300, '20261011080000', 'Peter', 'Kamau');
    await sv.receive('QAB9000003', 1000, '20261011120000');                     // Jane Wanjiru, exactly the bill
    await sv.receive('QAB9000002', 400, '20261011100000');
    const sale = { id: 'S1', refNumber: 'R-1', timestamp: new Date().toISOString(), paid: true, servedBy: 'Admin', customerName: '', items: [{ code: 'A', name: 'Alpha', qty: 1, price: 300 }], paymentMethod: 'mpesa', cashAmount: 0, mpesaAmount: 300, mpesaReceiptNumber: 'TYPED1' };
    const b = await boot(app, { storage: { pos_bills: JSON.stringify([BILL('B1', 'Jane Wanjiru', 1000), BILL('B2', 'Other Person', 250)]), pos_sales_log: JSON.stringify([sale]) }, wait: 900 });
    const { w } = b; quiet(w); const d = w.document;
    w.fetch = sv.fetchStub;
    const problems = []; w.addEventListener('error', (e) => problems.push(String(e.message)));
    assert.equal(d.getElementById('till-pay-bar'), null, 'the tall banner is gone');
    assert.ok(d.querySelector('.panel > h3 #tp-open-btn'), 'the compact button sits in the checkout header');
    assert.equal(d.getElementById('tp-open-btn').hidden, true, 'hidden until Daraja is known to be configured');
    const cfg = (on) => { w.fetch = async (u) => ({ ok: true, json: async () => ({ hasDarajaConfig: on }) }); return w.__tillPay.refreshDaraja(true); };
    await cfg(false); await new Promise((r) => setTimeout(r, 50)); assert.equal(d.getElementById('tp-open-btn').hidden, true, 'no Daraja -> hidden');
    await cfg(true); await new Promise((r) => setTimeout(r, 50)); assert.equal(d.getElementById('tp-open-btn').hidden, false, 'Daraja configured -> visible');
    w.fetch = sv.fetchStub;
    d.getElementById('tp-open-btn').click(); await until(() => d.querySelector('#tp-body .tp-card'));
    const names = () => [...d.querySelectorAll('#tp-body .tp-card .tp-code')].map((e) => e.textContent);
    assert.deepEqual(names(), ['QAB9000003', 'QAB9000002', 'QAB9000001'], 'newest first');
    const first = d.querySelector('#tp-body .tp-card').textContent;
    assert.match(first, /Jane Wanjiru/); assert.match(first, /1,000\.00/); assert.match(first, /UNLINKED/); assert.match(first, /QAB9000003/);

    // partial payment to a bill: 400 of 1000
    d.querySelector('[data-match="QAB9000002"]').click(); await tick();
    const cands = [...d.querySelectorAll('#tp-body [data-pick]')];
    assert.ok(cands.length >= 2, 'open bills are offered');
    const cardOf = (label) => [...d.querySelectorAll('#tp-body .tp-card')].find((c) => c.querySelector('[data-pick]') && c.textContent.includes(label));
    const pickBill = (label) => cardOf(label).querySelector('[data-pick]').click();
    pickBill('Jane Wanjiru'); await tick();
    const sum = d.querySelector('.tp-sum').textContent;
    assert.match(sum, /Balance now/); assert.match(sum, /1,000\.00/); assert.match(sum, /600\.00/); assert.match(sum, /Partly paid/);
    d.getElementById('tp-apply').click(); await tick(600);
    assert.equal(w.eval("bills.find(b => b.id === 'B1').amountPaid"), 400, 'bill paid amount');
    assert.equal(w.eval("bills.find(b => b.id === 'B1').paymentHistory[0].tillCode"), 'QAB9000002', 'the bill payment traces to the code');
    assert.equal(w.eval("bills.find(b => b.id === 'B1').paymentHistory[0].balanceAfter"), 600);
    assert.match(String(w.eval("bills.find(b => b.id === 'B1').status")), /partial/i);
    assert.equal(w.eval("salesLog.filter(s => s.tillCode === 'QAB9000002').length"), 1, 'an installment record carries the code');
    assert.equal(w.eval("salesLog.find(s => s.tillCode === 'QAB9000002').mpesaReceiptNumber"), 'QAB9000002');
    assert.deepEqual(names(), ['QAB9000003', 'QAB9000001'], 'it leaves the Unlinked list');

    // the same payment cannot be applied again (another till): the server refuses and nothing local changes
    const again = await sv.fetchStub('/api/till-payments', { method: 'POST', body: JSON.stringify({ action: 'apply', code: 'QAB9000002', targetType: 'bill', targetId: 'B2' }) });
    assert.equal(again.status, 409);

    // over-paying is blocked: 1000 against the 250 bill
    d.querySelector('[data-match="QAB9000003"]').click(); await tick();
    const over = cardOf('Other Person').querySelector('[data-pick]');
    assert.ok(over.disabled, 'a payment bigger than the balance cannot be applied to it');
    // the rest of Jane's bill: 600 is owed, a 1000 payment is also too much -> disabled; use QAB9000001 (300) for the sale instead
    d.getElementById('tp-back').click(); await tick();
    d.querySelector('[data-match="QAB9000001"]').click(); await tick();
    d.querySelector('[data-kind="sale"]').click(); await tick();
    assert.match(d.getElementById('tp-body').textContent, /R-1/);
    d.querySelector('#tp-body [data-pick="0"]').click(); await tick();
    d.getElementById('tp-apply').click(); await tick(600);
    assert.equal(w.eval("salesLog.find(s => s.id === 'S1').mpesaReceiptNumber"), 'QAB9000001');
    assert.equal(w.eval("salesLog.find(s => s.id === 'S1').mpesaCheck.status"), 'verified');
    assert.equal(w.eval("salesLog.find(s => s.id === 'S1').tillCode"), 'QAB9000001');

    // applied payments show where they went
    d.querySelector('[data-st="APPLIED"]').click(); await until(() => /Applied to Bill/.test(d.getElementById('tp-body').textContent));
    const t = d.getElementById('tp-body').textContent;
    assert.match(t, /Applied to Bill/); assert.match(t, /Applied to Sale/); assert.match(t, /APPLIED/);
    assert.deepEqual(problems, [], 'no script errors');
    b.close();
  });
}

test('a server failure leaves the bill untouched, and a refused (already-applied) payment changes nothing locally', async () => {
  const sv = await server(); await sv.receive('QAB9100001', 500, '20261011080000');
  const b = await boot('index.html', { storage: { pos_bills: JSON.stringify([BILL('B1', 'Jane Wanjiru', 500)]) }, wait: 900 });
  const { w } = b; quiet(w); const d = w.document; w.fetch = sv.fetchStub;
  d.getElementById('tp-open-btn').click(); await until(() => d.querySelector('#tp-body .tp-card'));
  d.querySelector('[data-match="QAB9100001"]').click(); await tick();
  d.querySelector('#tp-body [data-pick="0"]').click(); await tick();
  // another till applies it first
  await sv.fetchStub('/api/till-payments', { method: 'POST', body: JSON.stringify({ action: 'apply', code: 'QAB9100001', targetType: 'bill', targetId: 'ELSEWHERE' }) });
  d.getElementById('tp-apply').click(); await until(() => /already applied/i.test(d.getElementById('tp-body').textContent));
  assert.equal(w.eval("bills[0].amountPaid || 0"), 0, 'nothing was recorded on this till');
  assert.match(d.getElementById('tp-body').textContent, /already applied.*Nothing was changed/i);
  assert.equal(w.eval("bills[0].paymentHistory.length"), 0);
  // offline: nothing changes
  w.fetch = async () => { throw new TypeError('Failed to fetch'); };
  b.close();
});
