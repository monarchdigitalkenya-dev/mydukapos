import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'water/index.html'];

test('payment methods and receipt shortcuts are Settings tabs, not loose cards above them', async () => {
  for (const a of APPS) {
    const { d, close } = await boot(a, { wait: 3000 });
    try {
      const pay = d.getElementById('settings-section-paymethods'), keys = d.getElementById('settings-section-shortcuts');
      assert.ok(pay && keys, a + ': both sections exist ' + !!pay + !!keys);
      assert.ok(pay.contains(d.getElementById('pos-paymethods-panel')), a);
      assert.ok(keys.contains(d.getElementById('pos-receiptkeys-panel')), a);
      assert.ok(d.querySelector('.settings-subtab-btn[data-section="settings-section-paymethods"]'), a + ': tab button');
      assert.ok(d.querySelector('.settings-subtab-btn[data-section="settings-section-shortcuts"]'), a + ': tab button');
      const loose = [...d.getElementById('settings-tab').children].filter((c) => c.id === 'pos-paymethods-panel' || c.id === 'pos-receiptkeys-panel');
      assert.equal(loose.length, 0, a + ': nothing left above the tabs');
    } finally { close(); }
  }
});

test('hotel: sub-categories moved from Settings to the Inventory category toolbar', async () => {
  const { d, close } = await boot('hotel/index.html', { wait: 3000 });
  try {
    const btn = d.getElementById('inv-subcat-open');
    assert.ok(btn && d.getElementById('inv-catmgr-bar').contains(btn));
    assert.match(btn.getAttribute('onclick'), /hospSubOpen\(\)/);
    assert.ok(![...d.querySelectorAll('#settings-tab h3')].some((h) => /Sub-categories/.test(h.textContent)), 'no Sub-categories card left in Settings');
  } finally { close(); }
});
