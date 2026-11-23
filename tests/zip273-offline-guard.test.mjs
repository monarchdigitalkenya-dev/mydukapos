// zip 273: with no internet the M-Pesa prompt button says so plainly, sends nothing, and the sale stays a normal (unpaid-by-M-Pesa) one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

for (const app of ['index.html', 'hotel/index.html', 'water/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html']) {
  test(app + ': offline -> "No internet" message, no payment request leaves the device', async () => {
    const seen = [];
    const fetch = async (url) => { seen.push(String(url)); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }); };
    const b = await boot(app, { fetch, wait: 300 });
    try {
      const { w, d } = b;
      w.eval("window.posNetOffline = function () { return true; }");
      const before = seen.filter((u) => /mpesa-stkpush/.test(u)).length;
      await w.sendMpesaPrompt();
      const status = d.getElementById('mpesa-status-line');
      const text = status ? status.textContent : '';
      assert.match(text, /No internet right now/, app + ': ' + text);
      assert.equal(seen.filter((u) => /mpesa-stkpush/.test(u)).length, before, 'nothing was sent');
    } finally { b.close(); }
  });
}
