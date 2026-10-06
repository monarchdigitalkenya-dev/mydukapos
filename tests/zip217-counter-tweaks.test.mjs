import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const INV = JSON.stringify([{ code: 'S1', type: 'item', name: 'Sugar Kg', price: 320, wholesalePrice: 200, qty: 50, unit: 'kg', vatCategory: 'A' }]);

test('Choose a Price: typing 0.5 adds 0.5 to the cart (not 1); 2.25 and plain 3 work too', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: INV }, wait: 900 });
  const { w } = b;
  const qtyOf = () => w.eval("Object.values(currentCart).map(l => l.qty)[0]");
  for (const [typed, want] of [['0.5', 0.5], ['2.25', 2.25], ['3', 3]]) {
    w.eval('currentCart = {}; renderCart()');
    w.eval("openPriceSelectModal('S1')");
    w.document.getElementById('price-select-qty-input').value = typed;
    w.eval("choosePriceSelectOption('retail')");
    assert.equal(qtyOf(), want, `typed ${typed}`);
  }
  // the box allows decimals, and + / - keep them
  const inp = w.document.getElementById('price-select-qty-input');
  assert.equal(inp.getAttribute('step'), 'any');
  inp.value = '0.5'; w.eval('stepPriceSelectQty(1)'); assert.equal(inp.value, '1.5');
  inp.value = '0.5'; w.eval('stepPriceSelectQty(-1)'); assert.equal(inp.value, '0.5', 'never goes to zero');
  // custom amount path honours the decimal too
  w.eval('currentCart = {}; renderCart()');
  w.eval("openPriceSelectModal('S1')");
  inp.value = '0.5'; w.document.getElementById('price-select-custom-input').value = '150';
  w.eval('confirmPriceSelectCustom()');
  assert.equal(qtyOf(), 0.5);
});

for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html']) {
  test(`${app}: Settings can hide the Sales button (and the Bills button where there is one), remembered`, async () => {
    const b = await boot(app, { wait: 1300 });
    const { w, d } = b;
    const s = d.getElementById('hide-ctr-sales-toggle');
    assert.ok(s, 'switch exists');
    assert.equal(s.checked, false);
    assert.equal(d.documentElement.classList.contains('hide-ctr-sales'), false);
    s.checked = true; s.dispatchEvent(new w.Event('change'));
    assert.equal(d.documentElement.classList.contains('hide-ctr-sales'), true);
    assert.match([...d.querySelectorAll('style')].map((x) => x.textContent).join(''), /hide-ctr-sales #my-sales-toggle-btn[^}]*display:\s*none\s*!important/);
    if (d.getElementById('my-bills-toggle-btn')) {
      const bl = d.getElementById('hide-ctr-bills-toggle');
      bl.checked = true; bl.dispatchEvent(new w.Event('change'));
      assert.equal(d.documentElement.classList.contains('hide-ctr-bills'), true);
      assert.notEqual(d.getElementById('hide-ctr-bills-row').style.display, 'none');
    } else {
      assert.equal(d.getElementById('hide-ctr-bills-row').style.display, 'none', 'no Bills button here, so no Bills switch');
    }
    s.checked = false; s.dispatchEvent(new w.Event('change'));
    assert.equal(d.documentElement.classList.contains('hide-ctr-sales'), false);
  });
}

test('the Sales panel heading says Today\'s Sales (hotel and the shared block)', async () => {
  const h = await boot('hotel/index.html', { wait: 900 });
  h.w.eval('toggleMySalesPanel()');
  assert.match(h.d.getElementById('my-sales-list').textContent, /Daily Sales/);
  const p = await boot('pharmacy/index.html', { wait: 1300 });
  p.w.eval('posSqToggle()');
  assert.match(p.d.getElementById('pos-sq-list').textContent, /Daily Sales/);
  assert.doesNotMatch(p.d.getElementById('pos-sq-list').textContent, /Everyone/);
});

test('hide switches and hidden tabs are shop-wide: they travel with the shop settings to every device', async () => {
  const a = await boot('hotel/index.html', { wait: 1300 });
  assert.equal(a.w.eval('extraSettingsCollect().switches'), undefined, 'a fresh device sends nothing, so it never overwrites the shop');
  a.w.eval("setHideAdhoc(true); setHideCounterBtn('sales', true); setHideCounterBtn('bills', true)");
  const sent = JSON.parse(a.w.eval('JSON.stringify(extraSettingsCollect().switches)'));
  assert.deepEqual(sent, { hideAdhoc: true, hideCtrBills: true, hideCtrSales: true });
  a.w.eval("localStorage.setItem('pos_ptl_tabs_off', JSON.stringify(['contracts-tab'])); localStorage.setItem('pos_ptl_search', 'icon')");
  const pt = JSON.parse(a.w.eval('JSON.stringify(extraSettingsCollect().phoneTill)'));
  assert.deepEqual(pt.tabsOff, ['contracts-tab']); assert.equal(pt.search, 'icon');
  // another device receives them
  const b = await boot('hotel/index.html', { wait: 1300 });
  b.w.eval(`extraSettingsApply({ switches: ${JSON.stringify(sent)}, phoneTill: ${JSON.stringify(pt)} })`);
  const c = b.d.documentElement.classList;
  assert.ok(c.contains('hide-adhoc') && c.contains('hide-ctr-sales') && c.contains('hide-ctr-bills'));
  assert.equal(b.d.getElementById('hide-ctr-sales-toggle').checked, true);
  assert.deepEqual(JSON.parse(b.w.localStorage.getItem('pos_ptl_tabs_off')), ['contracts-tab']);
  // and un-hiding reaches it too
  b.w.eval("extraSettingsApply({ switches: { hideAdhoc: false, hideCtrSales: false, hideCtrBills: false }, phoneTill: { tabsOff: [] } })");
  assert.ok(!c.contains('hide-adhoc') && !c.contains('hide-ctr-sales'));
  assert.deepEqual(JSON.parse(b.w.localStorage.getItem('pos_ptl_tabs_off')), []);
  a.close(); b.close();
});
