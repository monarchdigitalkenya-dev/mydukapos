import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const APPS = ['index.html', 'water/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hotel/index.html'];

test('every module has the ▲ Hide / ▼ Show top bar and the 💰 Sales quick view, once', async () => {
  for (const a of APPS) {
    const { w, d, close } = await boot(a, { wait: 1200 });
    try {
      assert.equal(d.querySelectorAll('#hdr-hide-btn').length, 1, a + ': one hide button');
      assert.equal(d.querySelectorAll('#hdr-show-bar').length, 1, a + ': one show bar');
      assert.equal(d.querySelectorAll('#my-sales-toggle-btn').length, 1, a + ': one Sales button');
    } finally { close(); }
  }
});

test('Hide folds the header, Show brings it back and the choice is remembered (non-hotel modules)', async () => {
  for (const a of APPS.filter((x) => x !== 'hotel/index.html')) {
    const { w, d, close } = await boot(a, { wait: 1200 });
    try {
      d.getElementById('hdr-hide-btn').click();
      assert.ok(d.body.classList.contains('hdr-hidden'), a);
      assert.equal(w.localStorage.getItem('pos_hdr_hidden'), '1', a);
      d.getElementById('hdr-show-btn').click();
      assert.ok(!d.body.classList.contains('hdr-hidden'), a);
      assert.equal(w.localStorage.getItem('pos_hdr_hidden'), null, a);
    } finally { close(); }
  }
});

test('💰 Sales shows the day total / cash / M-Pesa, leaves voided sales out, and staff see only their own', async () => {
  for (const a of APPS.filter((x) => x !== 'hotel/index.html')) {
    const { w, d, close } = await boot(a, { wait: 1200 });
    try {
      const out = JSON.parse(w.eval(`(() => {
        const now = new Date().toISOString();
        salesLog.push({ id: 't1', timestamp: now, cashAmount: 300, mpesaAmount: 200, servedBy: 'Ann', items: [{ price: 500, qty: 1 }] },
                      { id: 't2', timestamp: now, cashAmount: 100, mpesaAmount: 0, servedBy: 'Bob', items: [{ price: 100, qty: 1 }] },
                      { id: 't3', timestamp: now, cashAmount: 999, mpesaAmount: 0, servedBy: 'Ann', voided: true, items: [{ price: 999, qty: 1 }] });
        document.getElementById('my-sales-toggle-btn').click();
        const all = document.getElementById('pos-sq-list').textContent.replace(/\\s+/g, ' ');
        currentServer = { name: 'Ann' };
        posSqDay(posSqDay && document.getElementById('pos-sq-day').value);
        const mine = document.getElementById('pos-sq-list').textContent.replace(/\\s+/g, ' ');
        return JSON.stringify({ all, mine });
      })()`));
      assert.match(out.all, /Everyone/, a); assert.match(out.all, /600\.00/, a + ' admin total 500+100');
      assert.doesNotMatch(out.all, /999/, a + ': voided left out');
      assert.doesNotMatch(out.mine, /Bob|Everyone/, a + ': staff see only their own');
      assert.match(out.mine, /500\.00/, a);
    } finally { close(); }
  }
});
