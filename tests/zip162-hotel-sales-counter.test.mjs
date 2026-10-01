import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, ROOT } from './helpers.mjs';

// zip 162 - Hotel Sales Counter: "Confirm" button, "Sale saved", blank-price import, payment-method choice, optional table/name,
// one-tap tab settling (no Split by person / Pay a share), sticky total + payment + Confirm bar.
const SRC = fs.readFileSync(path.join(ROOT, 'hotel/index.html'), 'utf8');
const app = () => boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify([{ code: 'D1', type: 'service', name: 'Burger', price: 500, unit: 'pcs' }]) }, wait: 1000 });

test('static: Confirm label, short toast, no split-by-person buttons in Settle Tab', () => {
  assert.ok(/id="main-checkout-btn"[^>]*>✅ Confirm</.test(SRC));
  assert.ok(!/View &amp; Print Receipt/.test(SRC));
  assert.ok(!/Closing this screen never cancels/.test(SRC));
  assert.ok(/el\.textContent = '✓ Sale saved';/.test(SRC));
  const modal = SRC.slice(SRC.indexOf('<div id="tab-settle-modal">'), SRC.indexOf('<div id="tab-settle-modal">') + 1500);
  assert.ok(!/Split by person|Pay a share/.test(modal));
  assert.ok(/id="cart-sticky-bar"[\s\S]{0,400}id="payment-toggle"[\s\S]{0,1200}id="main-checkout-btn"/.test(SRC), 'payment methods + Confirm live in the sticky bar');
});

test('import: a dash / blank / N/A price is importable (price 0), real garbage is still an error', async () => {
  const b = await app(); const { w } = b;
  for (const v of ['—', '-', '', 'N/A', ' – ']) assert.equal(JSON.parse(w.eval(`JSON.stringify(hospImpNum(${JSON.stringify(v)}))`)).bad, undefined, v);
  assert.equal(JSON.parse(w.eval('JSON.stringify(hospImpNum("abc"))')).bad, true);
  assert.equal(JSON.parse(w.eval('JSON.stringify(hospImpNum("KES 1,200"))')).n, 1200);
  b.close();
});

test('payment methods: all five by default; owner can hide some; the current method moves to a shown one', async () => {
  const b = await app(); const { w, d } = b;
  const shown = () => ['cash', 'mpesa', 'split', 'bill', 'tab'].filter((k) => d.getElementById('pay-' + k + '-btn').style.display !== 'none');
  w.eval('hospApplyPayMethods()');
  assert.deepEqual(shown(), ['cash', 'mpesa', 'split', 'bill', 'tab']);
  w.eval("renderServiceChargeSetting && (document.getElementById('svc-charge-settings') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'svc-charge-settings' }))); renderServiceChargeSetting()");
  d.querySelectorAll('.hosp-paym').forEach((c) => { c.checked = ['mpesa', 'bill'].includes(c.value); });
  w.eval('saveHospPayMethods()');
  assert.deepEqual(shown(), ['mpesa', 'bill']);
  assert.equal(w.eval('currentPaymentMethod'), 'mpesa', 'cash was hidden, so the counter moved to a shown method');
  const set = [...d.querySelectorAll('#tab-settle-pay-toggle button')].filter((x) => x.style.display !== 'none').length;
  assert.equal(set, 2, 'settle shows M-Pesa and Card only (Card is always offered when settling)');
  d.querySelectorAll('.hosp-paym').forEach((c) => { c.checked = false; });
  w.eval('saveHospPayMethods()');
  assert.deepEqual(shown(), ['mpesa', 'bill'], 'cannot hide every method');
  d.querySelectorAll('.hosp-paym').forEach((c) => { c.checked = true; });
  w.eval('saveHospPayMethods()');
  assert.equal(w.eval('hospConfig.payMethods'), null);
  assert.deepEqual(shown(), ['cash', 'mpesa', 'split', 'bill', 'tab']);
  b.close();
});

test('order with no table / room and no name starts as an auto-numbered guest', async () => {
  const b = await app(); const { w } = b;
  w.eval("showToast = function (m, e) { (window.__t = window.__t || []).push(m); }");
  const label = w.eval("(function () { document.getElementById('svc-new-location') && (document.getElementById('svc-new-location').value = ''); var t = hospStartOrder({ route: false }); return t && t.label; })()");
  assert.ok(/^Guest: Guest \d+$/.test(label), String(label));
  b.close();
});

test('settling a tab in cash with nothing typed = exact cash (no "Amount tendered is less" error)', () => {
  assert.ok(/if \(!\(amountTendered > 0\)\) amountTendered = total;/.test(SRC));
});
