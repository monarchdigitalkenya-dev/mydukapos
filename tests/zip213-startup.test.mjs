import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';
const req = createRequire(import.meta.url);
const raw = req(path.join(ROOT, 'native/windows/printraw.js'));

test('print worker compiles its C# class once into a cached DLL, loads it afterwards, and still falls back to compiling', () => {
  const s = raw.workerScript();
  assert.match(s, /-OutputAssembly \$dll/);
  assert.match(s, /Add-Type -Path \$dll/);
  assert.match(s, /MD5/, 'dll named after the code, so an update recompiles');
  assert.match(s, /if \(-not \$loaded -or -not \("MyDukaRaw" -as \[type\]\)\) \{ Add-Type -TypeDefinition \$src/, 'fallback compile kept');
  assert.ok(s.indexOf('READY') > s.indexOf('Add-Type -Path'), 'READY only after the class is available');
});

test('Windows app: PowerShell warm-up waits for the page to finish loading + 12 s, runs below normal priority', () => {
  const m = fs.readFileSync(path.join(ROOT, 'native/windows/main.js'), 'utf8');
  assert.doesNotMatch(m, /warm\(\)\.catch\(\(\) => \{\}\); \} catch \(e\) \{[^}]*\} \}, 2500\)/);
  assert.match(m, /once\('did-finish-load', queueWarm\)/);
  assert.match(m, /12000/);
  const p = fs.readFileSync(path.join(ROOT, 'native/windows/printraw.js'), 'utf8');
  assert.match(p, /PRIORITY_BELOW_NORMAL/);
});
