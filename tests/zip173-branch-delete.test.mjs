import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ROOT } from './helpers.mjs';

const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'water/index.html'];

test('every app shows a Delete branch button for branches that are neither this shop nor Main, and asks for the name', () => {
  for (const a of APPS) {
    const s = fs.readFileSync(ROOT + '/' + a, 'utf8');
    assert.match(s, /\(!b\.isSelf && !b\.isMainBranch\)[\s\S]{0,400}deleteBranch\(/, a + ': button rule');
    assert.match(s, /type the branch name exactly/, a + ': typed confirmation');
  }
});

test('Windows workflow: .msi smoke test waits for a clean machine, prints the real reason and keeps its log', () => {
  const y = fs.readFileSync(ROOT + '/.github/workflows/windows.yml', 'utf8');
  assert.match(y, /Return value 3/);
  assert.match(y, /msi-install-log/);
  assert.match(y, /continue-on-error: true/);
  const c = fs.readFileSync(ROOT + '/native/windows/check-installed.ps1', 'utf8');
  assert.match(c, /Test-Path \$dir/);
});
