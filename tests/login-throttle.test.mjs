import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';

// Zip 143: the owner sign-in (one account controls every shop) had no limit on wrong passwords.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const req = (body, ip = '1.2.3.4') => new Request('https://x.pages.dev/api/owner-auth', { method: 'POST', headers: { 'CF-Connecting-IP': ip, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('owner sign-in: wrong passwords are limited per hour; the right password is never slowed down before that', async () => {
  const auth = await load('functions/api/owner-auth.js');
  const env = { mydukapos_kv: makeKV(), LOGIN_FAILS_PER_IP: '5', LOGIN_FAILS_PER_ACCOUNT: '8' };
  await auth.onRequestPost({ request: req({ action: 'signup', identifier: 'me@shop.ke', password: 'secret123' }), env });
  assert.equal((await auth.onRequestPost({ request: req({ action: 'login', identifier: 'me@shop.ke', password: 'secret123' }), env })).status, 200, 'right password works');
  for (let i = 0; i < 5; i++) assert.equal((await auth.onRequestPost({ request: req({ action: 'login', identifier: 'me@shop.ke', password: 'guess' + i }), env })).status, 401);
  assert.equal((await auth.onRequestPost({ request: req({ action: 'login', identifier: 'me@shop.ke', password: 'guess-x' }), env })).status, 429, 'this IP is now blocked');
  assert.equal((await auth.onRequestPost({ request: req({ action: 'login', identifier: 'me@shop.ke', password: 'secret123' }), env })).status, 429, 'even with the right password, until the hour passes');
  // another IP: allowed until the per-ACCOUNT limit (8 failures in all) is reached
  for (let i = 0; i < 3; i++) assert.equal((await auth.onRequestPost({ request: req({ action: 'login', identifier: 'me@shop.ke', password: 'g' + i }, '9.9.9.9'), env })).status, 401);
  assert.equal((await auth.onRequestPost({ request: req({ action: 'login', identifier: 'me@shop.ke', password: 'secret123' }, '9.9.9.9'), env })).status, 429, 'account-wide limit reached');
});
