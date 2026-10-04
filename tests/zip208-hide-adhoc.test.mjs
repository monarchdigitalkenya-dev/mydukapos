import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html']) {
  test(`${app}: Settings has a switch that hides / shows the Sell Unlisted Item button, remembered on the device`, async () => {
    const b = await boot(app, { wait: 800 });
    const { w, d } = b;
    const t = d.getElementById('hide-adhoc-toggle');
    assert.ok(t, 'the switch exists in Settings > General');
    assert.equal(t.checked, false, 'off by default: nothing changes');
    assert.equal(d.documentElement.classList.contains('hide-adhoc'), false);
    assert.ok(d.querySelector('button[onclick="openAdhocSaleModal()"]'), 'the button exists');
    t.checked = true; t.dispatchEvent(new w.Event('change'));
    assert.equal(d.documentElement.classList.contains('hide-adhoc'), true);
    assert.equal(w.localStorage.getItem('pos_hide_adhoc'), '1');
    assert.match([...d.querySelectorAll('style')].map((s) => s.textContent).join(''), /html\.hide-adhoc button\[onclick="openAdhocSaleModal\(\)"\]\s*\{\s*display:\s*none\s*!important/);
    t.checked = false; t.dispatchEvent(new w.Event('change'));
    assert.equal(d.documentElement.classList.contains('hide-adhoc'), false);
    b.close();
    const b2 = await boot(app, { storage: { pos_hide_adhoc: '1' }, wait: 800 });
    assert.equal(b2.d.documentElement.classList.contains('hide-adhoc'), true, 'remembered after a restart');
    assert.equal(b2.d.getElementById('hide-adhoc-toggle').checked, true);
    b2.close();
  });
}
