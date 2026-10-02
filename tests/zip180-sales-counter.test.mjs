// zip 180: Sales Counter — cart price menu (Retail / Wholesale / Custom) on every module, Receiving Account hidden, Hold in the card header.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const APPS = ['index.html', 'water/index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];
const block = fs.readFileSync(new URL('../src/shared/blocks/receipt-extras.html', import.meta.url), 'utf8');

test('every app carries the shared price menu + layout block', () => {
  for (const a of APPS) {
    const h = fs.readFileSync(new URL('../' + a, import.meta.url), 'utf8');
    assert.ok(h.includes('window.__cartPriceInstall'), a + ' has the price menu');
    assert.ok(h.includes('#receiving-account-wrap'), a + ' hides Receiving Account');
    assert.ok(h.includes('posPlaceHold'), a + ' moves the Hold button');
  }
});
test('hotel and hospital price cells use the menu and can take a management password', () => {
  for (const a of ['hotel/index.html', 'hospital/index.html']) {
    const h = fs.readFileSync(new URL('../' + a, import.meta.url), 'utf8');
    assert.ok(h.includes('renderCartPriceCell(line, unit)'), a);
    assert.ok(h.includes("adminPwModalPurpose === 'change-cart-price' && pendingCartPriceKey"), a);
    assert.ok(h.includes('performCartPriceChange,'), a + ' includes the shared performCartPriceChange');
  }
});
test('menu always offers Retail, Wholesale and Custom', () => {
  assert.ok(/row\('Retail'/.test(block) && /row\('Wholesale'/.test(block) && /Custom amount/.test(block));
});
