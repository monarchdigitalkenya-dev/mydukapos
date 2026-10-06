import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';
// zip 224 — every ledger / list panel that had no Print button gets one; printing makes a titled, dated copy without buttons.
for (const app of APPS.filter((a) => a !== 'owner/index.html')) {
  test(`${app}: ledger panels get a Print button and print a clean copy`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: { pos_biz_name: 'Duka Test', aqua_biz_name: 'Duka Test' }, wait: 4500 });
    const panels = [...d.querySelectorAll('.pp-bar')].map((b) => b.parentNode.id);
    assert.ok(panels.length >= 1, 'some ledger panel got the button: ' + panels.join(','));
    assert.ok(panels.includes('audit-tab') || panels.length > 0);
    let written = '';
    const realCreate = d.createElement.bind(d);
    d.createElement = (t) => { const e = realCreate(t); if (t === 'iframe') { Object.defineProperty(e, 'contentWindow', { get() { return { document: { open() {}, write(h) { written += h; }, close() {} }, focus() {}, print() {} }; } }); } return e; };
    w.printPanel(panels[0]);
    await new Promise((r) => setTimeout(r, 600));
    assert.match(written, /Duka Test/); assert.match(written, /Printed/); assert.doesNotMatch(written, /<button/);
    assert.deepEqual(errors, []);
    close();
  });
}
