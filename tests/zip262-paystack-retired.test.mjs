import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider } from '../functions/api/_gateway-config.js';

// Zip 262: Paystack is retired. No new prompt is ever routed to it, even when an old key is still stored; the other providers keep working.
test('resolveProvider never returns paystack, whatever is stored or forced', () => {
  assert.equal(resolveProvider({ paystackSecretKey: 'sk_live_x' }), null, 'a lone old Paystack key = not configured');
  assert.equal(resolveProvider({ paystackSecretKey: 'sk_live_x', forcedProvider: 'paystack' }), null);
  const daraja = { mpesaConsumerKey: 'k', mpesaConsumerSecret: 's', mpesaShortcode: '174379', mpesaPasskey: 'p' };
  assert.equal(resolveProvider({ ...daraja, paystackSecretKey: 'sk_live_x' }), 'daraja', 'Daraja wins over an old Paystack key');
  assert.equal(resolveProvider({ paywaveApiKey: 'k', paywaveEmail: 'a@b.co', paystackSecretKey: 'sk_live_x' }), 'paywave');
  assert.equal(resolveProvider({ paywaveApiKey: 'k', paywaveEmail: 'a@b.co', ...daraja, forcedProvider: 'paywave' }), 'paywave', 'forcing another provider still works');
});

test('the apps and the owner console no longer offer Paystack, and the owner console offers Paywave Express', async () => {
  const fs = await import('node:fs');
  for (const f of ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hospital/index.html', 'water/index.html', 'owner/index.html']) {
    const h = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.ok(!/gateway-paystack-key-input|Always use Paystack|saveGatewayPaystackKey|Option A — Paystack/.test(h), f + ': no Paystack entry points');
    assert.ok(/gateway-paywave-api-key-input/.test(h) && /saveGatewayPaywaveConfig/.test(h), f + ': Paywave Express settings present');
  }
});
