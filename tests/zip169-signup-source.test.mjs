import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ROOT } from './helpers.mjs';
const rd = (p) => fs.readFileSync(ROOT + '/' + p, 'utf8');

test('app self-signups are tagged signup; the anonymous website generator is retired (zip 262)', () => {
  assert.match(rd('functions/api/demo-account.js'), /source: 'signup'/);
  assert.doesNotMatch(rd('functions/api/demo-account.js'), /source: 'website'/);
  assert.doesNotMatch(rd('functions/api/public-demo.js'), /createClient/, 'the retired route creates nothing');
  assert.match(rd('functions/api/public-demo.js'), /410/);
});
test('owner console shows an App sign-up badge', () => {
  const o = rd('owner/index.html');
  assert.match(o, /App sign-up<\/span>/);
  assert.match(o, /client\.source === 'signup'/);
});
