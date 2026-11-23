// zip 285: on the shared demo's "Your link is ready" screen (link + Download your licence) a tap outside the popup or Escape used to close it,
// and the link could be lost. Now ONLY the X button closes that screen; every other screen still closes on an outside tap / Escape.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../src/shared/blocks/shared-demo.html', import.meta.url), 'utf8');
const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'water/index.html'];

test('the outside tap and Escape are ignored while the licence screen is showing; the X button always closes', () => {
  assert.match(SRC, /mousedown', function \(e\) \{ if \(e\.target === d && !B\.locked\) close\(\); \}/);
  assert.match(SRC, /e\.key === 'Escape' && !B\.locked\) close\(\)/);
  assert.match(SRC, /querySelector\('\.sd-close'\)\.onclick = close;/, 'the X button is not guarded');
});

test('only ready() locks the popup, and every other screen (body()) unlocks it', () => {
  assert.match(SRC, /function body\(html\) \{ B\.locked = false;/);
  const ready = SRC.slice(SRC.indexOf('function ready(ref)'), SRC.indexOf('function licence(ref)'));
  assert.match(ready, /B\.locked = true;/);
  assert.equal((SRC.match(/B\.locked = true/g) || []).length, 1, 'nothing else may lock it');
});

test('every app carries the same guarded popup', () => {
  for (const f of APPS) {
    const t = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.ok(t.includes('B.locked = true; // zip 285'), f);
    assert.ok(t.includes("e.key === 'Escape' && !B.locked"), f);
  }
});
