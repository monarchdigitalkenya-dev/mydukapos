import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as acorn from 'acorn';
import { APPS, ROOT } from './helpers.mjs';

for (const app of [...APPS, 'owner/index.html']) {
  test(`${app}: every inline script parses`, () => {
    const html = fs.readFileSync(path.join(ROOT, app), 'utf8');
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m, n = 0;
    while ((m = re.exec(html))) { if (m[1].length < 2000) continue; acorn.parse(m[1], { ecmaVersion: 'latest' }); n++; }
    assert.ok(n >= 1);
  });
}

test('shared source is in sync with every app', () => {
  execFileSync('node', ['tools/sync-shared.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
});
