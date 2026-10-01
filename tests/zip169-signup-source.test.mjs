import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ROOT } from './helpers.mjs';
const rd = (p) => fs.readFileSync(ROOT + '/' + p, 'utf8');

test('app self-signups are tagged signup, only the public anonymous demo stays website', () => {
  assert.match(rd('functions/api/demo-account.js'), /source: 'signup'/);
  assert.doesNotMatch(rd('functions/api/demo-account.js'), /source: 'website'/);
  assert.match(rd('functions/api/public-demo.js'), /source: 'website'/);
  assert.match(rd('functions/api/_crm/demo-lead.js'), /sourceKey: 'signup'/);
  assert.match(rd('functions/api/crm-lead.js'), /sourceKey: 'website'/);
});
test('owner console shows an App sign-up badge', () => {
  const o = rd('owner/index.html');
  assert.match(o, /App sign-up<\/span>/);
  assert.match(o, /client\.source === 'signup'/);
});
