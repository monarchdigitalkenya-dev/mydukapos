import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'water/index.html'];

test('every till gets the checkout-workspace structure', async () => {
  for (const a of APPS) {
    const { d, close } = await boot(a, { wait: 900 });
    const panel = d.getElementById('active-checkout-cart-panel') || d.getElementById('cart-and-payment-panel');
    assert.ok(panel, a + ': panel');
    assert.ok(panel.classList.contains('pos-checkout'), a + ': pos-checkout class');
    assert.ok(panel.querySelector('.pos-cart-scroll'), a + ': internal cart scroller');
    const bar = d.getElementById('cart-sticky-bar');
    assert.ok(bar, a + ': sticky bar');
    assert.ok(bar.querySelector('.pos-pay-details'), a + ': pay details inside bar');
    for (const id of ['cart-grand-total', 'payment-toggle', 'main-checkout-btn']) assert.ok(bar.contains(d.getElementById(id)), a + ' ' + id);
    assert.ok(d.getElementById('pos-ck-count'), a + ': item count pill');
    close();
  }
});

test('all payment methods and fields still exist', async () => {
  for (const a of APPS) {
    const { d, close } = await boot(a, { wait: 900 });
    for (const id of ['cash-payment-panel', 'split-payment-panel', 'mpesa-prompt-panel', 'mpesa-code-input']) {
      if (!d.getElementById(id)) { close(); assert.fail(a + ' missing ' + id); }
    }
    assert.equal(d.getElementById('mpesa-code-input').required, false, a + ': code optional');
    close();
  }
});
