import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const apps = ['src/shared/blocks/business-hq.html', 'index.html', 'pharmacy/index.html', 'hospital/index.html', 'hotel/index.html', 'production/index.html', 'services/index.html', 'water/index.html'];
for (const a of apps) {
  const t = fs.readFileSync(new URL('../' + a, import.meta.url), 'utf8');
  test(`${a}: Business HQ is Admin-only and asks for no password`, () => {
    assert.ok(t.includes('function isAdminNow()'));
    assert.ok(t.includes("api({ action: 'login', auto: true })"));
    assert.ok(!t.includes('id="bhq-pw"') && !t.includes('bhq-owner'), 'no password form');
    assert.ok(t.includes('if (!isAdminNow()) { var ob = document.getElementById(\'bhq-open\')'));
    assert.ok(t.includes('Business HQ is for the Admin only.'));
  });
}
const org = fs.readFileSync(new URL('../functions/api/org.js', import.meta.url), 'utf8');
test('org.js: passwordless login only for the main branch, and needs an Admin session when staff sessions are enforced', () => {
  assert.ok(org.includes("body.auto === true && !body.personId"));
  assert.ok(org.includes("here.id !== mainId"));
  assert.ok(org.includes("readMode(env, here.id)) === 'enforce'"));
});
