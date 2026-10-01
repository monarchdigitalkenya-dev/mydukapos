import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, ROOT } from './helpers.mjs';

// zip 163 - shared sticky total/payment/Confirm bar + owner-chosen payment methods (all modules), hotel sub-categories.
const MODS = ['index.html', 'water/index.html', 'hospital/index.html', 'production/index.html', 'pharmacy/index.html', 'services/index.html', 'hotel/index.html'];

test('static: every module has the sticky bar with Confirm and a payment-methods setting', () => {
  for (const m of MODS) {
    const s = fs.readFileSync(path.join(ROOT, m), 'utf8');
    assert.ok(/id="cart-sticky-bar"/.test(s), m + ' sticky bar');
    assert.ok(/id="main-checkout-btn"[^>]*>✅ Confirm</.test(s), m + ' Confirm');
    assert.ok(/id="pos-paymethods-panel"/.test(s), m + ' pay-methods panel');
    assert.ok(/function posPayAccepted/.test(s), m + ' shared pay code');
  }
});

for (const m of MODS) {
  test('payment methods setting works in ' + m, async () => {
    const b = await boot(m, { wait: 800 }); const { w, d } = b;
    const present = JSON.parse(w.eval('JSON.stringify(posPayPresent())'));
    assert.ok(present.length >= 2, 'has buttons ' + present);
    const shown = () => present.filter((k) => d.getElementById('pay-' + k + '-btn').style.display !== 'none');
    assert.deepEqual(shown(), present);
    w.eval('posRenderPayMethodsPanel()');
    const boxes = [...d.querySelectorAll('.pos-paym')];
    assert.ok(boxes.length >= 2);
    boxes.forEach((c) => { c.checked = c.value === present[1]; });
    w.eval('posSavePayMethods()');
    assert.deepEqual(shown(), [present[1]]);
    assert.equal(w.eval('currentPaymentMethod'), present[1]);
    assert.deepEqual(JSON.parse(w.eval('JSON.stringify(extraSettingsCollect().payMethods)')), [present[1]]);
    // sync apply: restoring everything clears the restriction
    w.eval("extraSettingsApply({ payMethods: " + JSON.stringify(['cash', 'mpesa', 'card', 'split', 'bill', 'tab']) + " })");
    assert.deepEqual(shown(), present);
    b.close();
  });
}

test('hotel sub-categories: add, assign, filter, delete clears the item sub-category', async () => {
  const inv = [
    { code: 'M1', type: 'service', name: 'Choc shake', category: 'Milkshakes', price: 200, unit: 'pcs' },
    { code: 'M2', type: 'service', name: 'Vanilla shake', category: 'Milkshakes', price: 100, unit: 'pcs' },
    { code: 'M3', type: 'service', name: 'Mango shake', category: 'Milkshakes', price: 200, unit: 'pcs' },
    { code: 'P1', type: 'service', name: 'Pizza', category: 'Mains', price: 800, unit: 'pcs' },
  ];
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(inv) }, wait: 1200 }); const { w, d } = b;
  w.eval("showToast = function(){}; window.confirm = () => true");
  const J = (js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
  const catId = J("hospScreenChips('sales').find(c => /milkshakes/i.test(c.label || c.name || '')).id");
  w.eval(`hospSubOpen && 0`);
  w.eval(`document.body.insertAdjacentHTML('beforeend','<input id="hosp-sub-new"><div id="hosp-sub-box"></div>')`);
  for (const n of ['200', '100']) { d.getElementById('hosp-sub-new').value = n; w.eval(`hospSubAdd('${catId}')`); }
  const subs = J(`hospSubList('${catId}')`);
  assert.deepEqual(subs.map((x) => x.name), ['200', '100']);
  w.eval(`hospSubAssign('M1','${subs[0].id}'); hospSubAssign('M3','${subs[0].id}'); hospSubAssign('M2','${subs[1].id}')`);
  w.eval(`hospCatPick('sales','${catId}')`);
  const r = (sub) => { w.eval(`hospSubPick('sales','${catId}','${sub}')`); return J("hospScreenItems('sales','').list.map(e => e.rec.code).sort()"); };
  assert.deepEqual(r('all'), ['M1', 'M2', 'M3']);
  assert.deepEqual(r(subs[0].id), ['M1', 'M3']);
  assert.deepEqual(r(subs[1].id), ['M2']);
  assert.ok(d.querySelector('#sc-cat-bar-sub .hcat-chip'), 'sub-chip row painted');
  assert.deepEqual(J("hospScreenItems('sales','vanilla').list.map(e => e.rec.code)"), ['M2'], 'search ignores sub filter');
  w.eval(`hospSubDelete('${catId}','${subs[0].id}')`);
  assert.equal(J("inventory.find(p => p.code === 'M1').subCat"), '');
  assert.equal(J(`hospSubList('${catId}').length`), 1);
  b.close();
});
