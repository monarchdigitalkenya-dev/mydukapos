import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';

// Zip 185 — owner console API: every destructive action needs the owner session; extend validates its hours; new links never take a reserved subdomain.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const post = (body, headers = {}) => new Request('https://x/api/owner-lock', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

async function setup() {
  const kv = makeKV(); const env = { mydukapos_kv: kv, OWNER_LEGACY_INCOME_FORMS: '1' };
  const oa = await load('functions/api/_owner-auth.js'), lic = await load('functions/api/_license.js');
  const acct = await oa.createOwnerAccount(env, 'owner@example.com', 'Sup3r-secret-pw');
  const sess = await oa.createOwnerSession(env, acct);
  const token = typeof sess === 'string' ? sess : sess.token;
  const demo = await lic.createClient(env, 'demo', 'Victim Shop', 'shop');
  return { env, token, demo, lic };
}

test('owner-lock: delete / resetPassword / extend / unlock / resetAllIncome all refuse a call with no (or a wrong) owner session', async () => {
  const { env, demo } = await setup();
  const lock = await load('functions/api/owner-lock.js');
  for (const action of ['delete', 'restore', 'resetPassword', 'extend', 'lock', 'unlock', 'edit', 'convertToDemo', 'resetAllIncome', 'recordGroupIncome', 'billing', 'remind']) {
    for (const headers of [{}, { Authorization: 'Bearer nope' }, { Authorization: 'Bearer ' + 'a'.repeat(64) }]) {
      const r = await lock.onRequestPost({ request: post({ c: demo.id, action, hours: 1 }, headers), env });
      assert.equal(r.status, 401, action + ' without the owner session must be 401');
    }
  }
  const lic = await load('functions/api/_license.js');
  const rec = await lic.getLicense(env, demo.id);
  assert.ok(!rec.deleted && !rec.locked, 'nothing changed');
});

test('owner-confirm / owner-clients / owner-storage / owner-messages / owner-releases: no session, no action', async () => {
  const { env, demo } = await setup();
  const confirm = await load('functions/api/owner-confirm.js');
  const r1 = await confirm.onRequestPost({ request: post({ c: demo.id }), env });
  assert.equal(r1.status, 401);
  const clients = await load('functions/api/owner-clients.js');
  assert.equal((await clients.onRequestGet({ request: new Request('https://x/api/owner-clients'), env })).status, 401);
  assert.equal((await clients.onRequestPost({ request: post({ type: 'permanent', label: 'x' }), env })).status, 401);
  const storage = await load('functions/api/owner-storage.js');
  assert.equal((await storage.onRequestPost({ request: post({ action: 'compress' }), env })).status, 401);
  const msgs = await load('functions/api/owner-messages.js');
  assert.equal((await msgs.onRequestPost({ request: post({ action: 'delete', id: 'x' }), env })).status, 401);
  const rel = await load('functions/api/owner-releases.js');
  assert.equal((await rel.onRequestPost({ request: post({ action: 'delete', id: 'x' }), env })).status, 401);
});

test('owner-lock extend: a valid owner session extends; a huge / non-numeric number of hours is refused and writes nothing', async () => {
  const { env, token, demo, lic } = await setup();
  const lock = await load('functions/api/owner-lock.js');
  const H = { Authorization: 'Bearer ' + token };
  const before = (await lic.getLicense(env, demo.id)).expiresAt;
  const ok = await lock.onRequestPost({ request: post({ c: demo.id, action: 'extend', hours: 24 }, H), env });
  assert.equal(ok.status, 200);
  const after = (await lic.getLicense(env, demo.id)).expiresAt;
  assert.ok(after >= before + 23 * 3600e3, 'extended by about a day');
  for (const hours of [1e300, 99999999, -5, 'abc', 0]) {
    const r = await lock.onRequestPost({ request: post({ c: demo.id, action: 'extend', hours }, H), env });
    assert.equal(r.status, 400, 'hours=' + hours);
  }
  assert.equal((await lic.getLicense(env, demo.id)).expiresAt, after, 'expiry unchanged by refused calls');
});

test('new links never take a reserved subdomain (www, owner, login ...) - they get the usual -2 suffix; ordinary names are unchanged', async () => {
  const { env, lic } = await setup();
  const www = await lic.createClient(env, 'demo', 'WWW', 'shop');
  const owner = await lic.createClient(env, 'demo', 'Owner', 'shop');
  const login = await lic.createClient(env, 'demo', 'login', 'shop');
  assert.equal(www.slug, 'www-2'); assert.equal(owner.slug, 'owner-2'); assert.equal(login.slug, 'login-2');
  const ok = await lic.createClient(env, 'demo', 'Mama Njeri Duka', 'shop');
  assert.equal(ok.slug, 'mama-njeri-duka');
});
