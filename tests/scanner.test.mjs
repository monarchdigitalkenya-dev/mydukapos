import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 143 — hardware barcode scanners (keyboard wedge: very fast keys, then Enter).
const SHOP_APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];
const ITEM = { code: '5901234123457', type: 'item', name: 'Scanned Soap', price: 120, qty: 10, unit: 'pcs', vatCategory: 'A' };

// A scanner: every character arrives at once (well inside 60 ms), then Enter — typed into whatever has the focus, like a real one.
function scan(w, d, code, { slow = false } = {}) {
  const now = Date.now;
  let t = now();
  const step = slow ? 150 : 5;
  w.Date.now = () => t;
  const el = d.activeElement;
  for (const ch of code) {
    t += step;
    const ev = new w.KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    if (!ev.defaultPrevented && el && 'value' in el) el.value += ch;
  }
  t += step;
  el.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  w.Date.now = now;
}
const cartQty = (w) => w.eval("Object.values(currentCart).reduce((s, l) => s + (Number(l.qty) || 0), 0)");

for (const app of SHOP_APPS) {
  test(`${app}: a scan adds the item; a scan with the cursor in "cash tendered" does not leave the barcode in the cash box`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: { pos_inventory: JSON.stringify([ITEM]) }, wait: 1200 });
    w.eval('showToast = function () {};');
    w.eval("performTabSwitch(document.getElementById('sales-tab-btn'), 'sales-tab')");
    const search = d.getElementById('sales-search');
    search.focus();
    scan(w, d, ITEM.code);
    assert.equal(cartQty(w), 1, 'scanned into the cart');
    assert.equal(search.value, '', 'the search box is cleared');
    const cash = d.getElementById('cash-tendered-input');
    if (cash) {
      cash.value = '500';
      cash.focus();
      scan(w, d, ITEM.code);
      assert.equal(cartQty(w), 2, 'the second scan added one more');
      assert.equal(cash.value, '500', 'the cash box still says 500, not 5005901234123457');
    }
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: a slower scanner (or a code typed by hand) + Enter in the search box adds the exact item; a name + Enter does not`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: { pos_inventory: JSON.stringify([ITEM]) }, wait: 1200 });
    w.eval('showToast = function () {};');
    w.eval("performTabSwitch(document.getElementById('sales-tab-btn'), 'sales-tab')");
    const search = d.getElementById('sales-search');
    search.focus();
    scan(w, d, ITEM.code, { slow: true });
    assert.equal(cartQty(w), 1, 'slow scan still added');
    search.value = 'Scanned';
    search.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(cartQty(w), 1, 'a partial name + Enter adds nothing');
    assert.deepEqual(errors, []);
    close();
  });
}

test('index.html: Add New Items — a slow lookup for an EARLIER scan never fills the item scanned since', async () => {
  const pending = [];
  const fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/barcode-lookup')) {
      const code = new URL(u, 'https://x').searchParams.get('code');
      return new Promise((resolve) => pending.push({ code, resolve: () => resolve(new Response(JSON.stringify({ found: true, name: 'Name for ' + code }), { status: 200 })) }));
    }
    return Promise.reject(new Error('offline'));
  };
  const { w, d, close } = await boot('index.html', { fetch, wait: 1200 });
  w.eval('showToast = function () {};');
  w.eval('window.posNetOffline = () => false;');
  const first = w.eval("applyScannedCodeToAddItemForm('1111111111116')");
  const second = w.eval("applyScannedCodeToAddItemForm('2222222222222')");
  await new Promise((r) => setTimeout(r, 50));
  pending.find((p) => p.code === '2222222222222').resolve();
  await second;
  pending.find((p) => p.code === '1111111111116').resolve();   // the first answer arrives LAST
  await first;
  assert.equal(d.getElementById('inv-code').value, '2222222222222');
  assert.equal(d.getElementById('inv-name').value, 'Name for 2222222222222', 'not overwritten by the earlier scan\'s answer');
  close();
});

test('water/index.html: Aqua POS now reads a hardware scanner (it had no handler at all)', async () => {
  const product = { code: 'AQ500', name: 'Bottle 500ml', price: 30, qty: 20, category: 'bottle' };
  const { w, d, errors, close } = await boot('water/index.html', { storage: { pos_products: JSON.stringify([product]) }, wait: 1500 });
  w.eval('showToast = function () {};');
  w.eval("if (typeof activeSiteId !== 'undefined' && activeSiteId === 'both') activeSiteId = 'shop';");
  const hasProduct = w.eval("products.some(p => p.code === 'AQ500')");
  if (!hasProduct) w.eval(`products.push(${JSON.stringify(product)})`);
  w.eval("performTabSwitch(document.getElementById('sales-tab-btn'), 'sales-tab')");
  d.getElementById('universal-search').focus();
  scan(w, d, 'AQ500');
  assert.equal(cartQty(w), 1, 'scanned into the cart');
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(errors, []);
  close();
});
