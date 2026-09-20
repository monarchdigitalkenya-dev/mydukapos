import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';

for (const app of APPS.filter((a) => a !== 'owner/index.html')) {
  test(`${app}: staff login links can be opened as well as copied`, async () => {
    const { w, d, errors, close } = await boot(app, { wait: 300 });
    const opened = [];
    w.open = (u, t, f) => { opened.push([u, t, f]); };
    w.eval("openStaffLoginLink('abc123')");
    assert.equal(opened.length, 1);
    assert.match(opened[0][0], /\?staff=abc123$/, 'the same link Copy Link copies');
    assert.equal(opened[0][2], 'noopener');
    const html = require_html(app);
    assert.ok((html.match(/openStaffLoginLink\(/g) || []).length >= 3, 'an Open button sits next to each Copy/Link button (2 places) + the function');
    assert.deepEqual(errors, []);
    close();
  });
}
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
function require_html(app) { return fs.readFileSync(path.join(ROOT, app), 'utf8'); }
