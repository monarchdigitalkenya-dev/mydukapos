import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 219 — every "hide this" switch lives in ONE Settings tab, "View".
for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html']) {
  test(`${app}: Settings > View holds the hide switches (and not General)`, async () => {
    const { w, d } = await boot(app, { wait: 10000 });
    const view = d.getElementById('settings-section-view');
    assert.ok(view, 'View section exists');
    assert.ok(d.querySelector('.settings-subtab-btn[data-section="settings-section-view"]'), 'View tab button exists');
    for (const id of ['hide-adhoc-toggle', 'hide-ctr-sales-toggle', 'hide-ctr-bills-toggle', 'pos-phonetill-panel']) assert.ok(view.querySelector('#' + id), id + ' is inside View');
    assert.ok(!d.getElementById('settings-section-general').querySelector('#hide-adhoc-toggle, #hide-ctr-sales-toggle, #pos-phonetill-panel'), 'nothing left in General');
    const t = view.querySelector('#hide-ctr-sales-toggle'); t.checked = true; t.dispatchEvent(new w.Event('change'));
    assert.ok(d.documentElement.classList.contains('hide-ctr-sales'));
  });
}
for (const app of ['hospital/index.html', 'water/index.html']) {
  test(`${app}: View tab exists and holds the phone & till layout`, async () => {
    const { d } = await boot(app, { wait: 10000 });
    const view = d.getElementById('settings-section-view'); assert.ok(view);
    assert.ok(view.querySelector('#pos-phonetill-panel'));
  });
}

test('owner console: the grouped sidebar is built from its tabs', async () => {
  const { d } = await boot('owner/index.html', { wait: 10000 });
  assert.ok(d.getElementById('snav'), 'sidebar exists');
  const txt = d.getElementById('snav').textContent;
  for (const g of ['Clients & Access', 'Money & Billing', 'Website', 'Platform', 'Administration']) assert.ok(txt.includes(g), g);   // zip 304 folders
  assert.ok(!/Clock Out/.test(txt), 'no staff clock-out on the owner console');
});

test('every service worker tells an open page when a newer copy differs (zip 219, content-based since zip 247)', async () => {
  const fs = await import('node:fs');
  for (const f of ['sw.js', 'hotel/sw.js', 'owner/sw.js', 'water/sw.js']) {
    const s = fs.readFileSync(f, 'utf8');
    assert.match(s, /SW_VERSION = 'zip-\d+'/, f); assert.match(s, /let differs = !!prevHash/, f);   // zip 247: decided by the page's own bytes, not its ETag
  }
});
