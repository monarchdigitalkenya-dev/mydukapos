import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const MSG = "This shop's data is too large to sync (26.0 MB, limit 24 MB). Your till still works and nothing is lost — please contact support.";
const tooLarge = () => Promise.resolve({ ok: false, status: 413, json: async () => ({ error: MSG, code: 'shop_too_large' }) });

for (const [app, fn] of [['index.html', 'pushNow'], ['hotel/index.html', 'pushNow'], ['water/index.html', 'pushNowOrWarn']]) {
  test(`${app}: a 413 shows the cashier NOTHING (the server archives itself long before this; the till just stays offline-safe)`, async () => {
    const { w, d, errors, close } = await boot(app, { fetch: tooLarge, wait: 300 });
    w.eval('window.__toasts = []; showToast = function (m) { window.__toasts.push(m); }');
    const ok = await w.eval(`${fn}('test')`);
    assert.equal(ok, false);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.eval('window.__toasts.length'), 0, 'no toast');
    assert.ok(![...d.querySelectorAll('body *')].find((e) => e.textContent === MSG), 'no message on screen');
    assert.doesNotMatch(d.getElementById('sync-status').className, /sync-error/, 'not shown as an error either');
    assert.deepEqual(errors, []);
    close();
  });
}
