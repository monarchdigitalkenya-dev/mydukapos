import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, ROOT } from './helpers.mjs';

const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];

test('payment fields live inside the pinned bar in every till', async () => {
  for (const a of APPS) {
    const { d, errors, close } = await boot(a, { wait: 10000 });
    const bar = d.getElementById('cart-sticky-bar');
    assert.ok(bar.querySelector('.pos-pay-details'), a + ': payment details moved into the bar');
    for (const id of ['mpesa-prompt-panel', 'split-payment-panel', 'cash-payment-panel']) assert.ok(bar.contains(d.getElementById(id)), a + ' ' + id);
    close();
  }
});

test('hotel: settling a tab shows the payment methods (and its card box stays hidden until Card is chosen)', async () => {
  const { w, d, close } = await boot('hotel/index.html', { wait: 900 });
  const grp = d.getElementById('tab-settle-pay-toggle').closest('.form-group');
  assert.notEqual(grp.style.display, 'none');
  assert.equal(d.getElementById('tab-settle-card-fields').style.display, 'none');
  close();
});

test('receipt keyboard shortcuts: P D S C and Esc, customizable, ignored while typing', async () => {
  const { w, d, close } = await boot('index.html', { wait: 900 });
  w.eval("window.__c = []; printReceipt = () => __c.push('p'); downloadReceiptPdf = () => __c.push('d'); shareReceiptNative = () => __c.push('s'); closeReceipt = () => { __c.push('c'); document.getElementById('receipt-modal').style.display = 'none'; };");
  const calls = () => JSON.parse(w.eval('JSON.stringify(__c)'));
  const key = (k, target) => (target || d).dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  key('p'); assert.deepEqual(calls(), [], 'nothing while no receipt is open');
  d.getElementById('receipt-modal').style.display = 'flex';
  key('p'); key('d'); key('s'); key('c');
  assert.deepEqual(calls(), ['p', 'd', 's', 'c']);
  d.getElementById('receipt-modal').style.display = 'flex'; w.eval('__c.length = 0');
  const inp = d.createElement('input'); d.body.appendChild(inp); key('p', inp); assert.deepEqual(calls(), [], 'typing in a box is never hijacked');
  key('Escape'); assert.deepEqual(calls(), ['c']);
  w.localStorage.setItem('pos_receipt_keys', JSON.stringify({ print: 'x', download: 'y', share: 'z', cancel: 'q' }));
  d.getElementById('receipt-modal').style.display = 'flex'; w.eval('__c.length = 0');
  key('p'); key('x'); key('z');
  assert.deepEqual(calls(), ['p', 's'], 'remapped keys work; the old P no longer does');
  assert.ok(d.getElementById('pos-rk-print'), 'settings panel exists');
  close();
});

test('hotel service orders: sticky POST ORDER bar with the total; M-Pesa code never mandatory', async () => {
  const html = fs.readFileSync(ROOT + '/hotel/index.html', 'utf8');
  assert.match(html, /id="svc-post-bar" style="position:sticky; bottom:0/);
  assert.ok(!/Enter the M-Pesa code\./.test(html), 'no mandatory M-Pesa code message left');
  assert.match(html, /M-Pesa code \(optional\)/);
});
