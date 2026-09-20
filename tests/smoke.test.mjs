import test from 'node:test';
import assert from 'node:assert/strict';
import { APPS, boot } from './helpers.mjs';

for (const app of APPS) {
  test(`${app}: boots with no script errors and the shared UI is present`, async () => {
    const { w, d, errors, close } = await boot(app);
    assert.deepEqual(errors, [], 'uncaught script errors on boot');
    assert.ok(d.getElementById('hardware-header-btn'), 'hardware icon');
    assert.ok(d.getElementById('storage-health-card'), 'storage card');
    // Hardware popup: opens, real section is moved in, and put back on close
    const sec = d.getElementById('settings-section-hardware');
    const home = sec.parentNode;
    d.getElementById('hardware-header-btn').click();
    assert.equal(d.getElementById('hardware-modal').style.display, 'flex');
    assert.ok(d.getElementById('hardware-modal-body').contains(sec));
    d.querySelector('.hw-modal-done').click();
    assert.ok(home.contains(sec), 'hardware section returned to Settings');
    close();
  });
}
