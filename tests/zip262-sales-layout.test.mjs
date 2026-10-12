import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 262: sales-screen layout. No Till banner; split "Cash tendered" follows the cash portion until the cashier types their own amount.
const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hospital/index.html'];
const opened = [];
after(() => { for (const b of opened) { try { b.close(); } catch (e) { /* closed */ } } });

for (const app of APPS) {
  test(`${app}: split cash-tendered prefill follows the cash portion until edited by hand`, async () => {
    const b = await boot(app, { wait: 300 }); opened.push(b); const { w } = b; const d = w.document;
    const el = (id) => d.getElementById(id);
    if (!el('split-cash-tendered-input')) return;
    w.eval("currentPaymentMethod = 'split'; cartTotal = function () { return 1000; }");
    el('split-cash-input').value = '400'; w.eval("handleSplitAmountChange('cash')");
    assert.equal(el('split-cash-tendered-input').value, '400.00', 'prefilled with the cash portion');
    assert.equal(el('split-mpesa-input').value, '600.00');
    el('split-cash-input').value = '300'; w.eval("handleSplitAmountChange('cash')");
    assert.equal(el('split-cash-tendered-input').value, '300.00', 'follows while untouched');
    // the cashier types an amount handed over: no more overwriting
    el('split-cash-tendered-input').value = '500'; w.eval('updateChangeDue()');
    el('split-cash-input').value = '350'; w.eval("handleSplitAmountChange('cash')");
    assert.equal(el('split-cash-tendered-input').value, '500', 'manual edit is kept');
    assert.match(el('split-change-due-line').textContent, /150\.00/, 'change = tendered - cash portion');
  });

  test(`${app}: no Till banner; Till button hidden until Daraja is configured`, async () => {
    const b = await boot(app, { wait: 300 }); opened.push(b); const { w } = b; const d = w.document;
    assert.equal(d.getElementById('till-pay-bar'), null);
    const btn = d.getElementById('tp-open-btn');
    if (!btn) return;
    assert.equal(btn.hidden, true);
  });
}
