import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Versioning reset: each app's build stamp now starts fresh at 1.0.0
// (was an incrementing legacy counter per module, e.g. "HRB-POS v58 —
// ..."), and a short, append-only Update Log (newest first) replaces the
// old single long descriptive string, shown in Settings ▸ Install App.
for (const app of ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html']) {
  test(`${app}: build stamp reads 1.0.0 and the update log renders at least one entry`, async () => {
    const b = await boot(app, { storage: {}, wait: 900 });
    const { w } = b;
    w.eval('updateInstallUI()');
    assert.equal(w.eval('APP_BUILD'), '1.0.0');
    assert.match(w.document.getElementById('app-build-stamp').textContent, /1\.0\.0/);
    const logHtml = w.document.getElementById('app-update-log').innerHTML;
    assert.match(logHtml, /What changed/);
    assert.match(logHtml, /1\.0\.0/);
    const log = w.eval('APP_UPDATE_LOG');
    assert.ok(Array.isArray(log) && log.length >= 1);
    assert.equal(log[0].version, '1.0.0');
    b.close();
  });
}
