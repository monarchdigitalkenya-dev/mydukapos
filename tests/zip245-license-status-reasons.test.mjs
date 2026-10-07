import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';

// Zip 245. license-status says 'deleted' only with proof (Trash record or a tombstone left by the permanent purge);
// an unknown code is 'not_found'; a request naming no shop is 'no_link'. Clients were told "This link no longer exists" for live links.
const imp = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const ask = async (ls, env, url) => (await ls.onRequestGet({ request: new Request(url), env })).json();

test('license-status reasons: live, in Trash, purged (tombstone), unknown code, no link at all', async () => {
  const env = { mydukapos_kv: makeKV(), LICENSE_CACHE_MS: '0' };
  const lic = await imp('functions/api/_license.js'); const ls = await imp('functions/api/license-status.js');
  const rec = await lic.createClient(env, 'permanent', 'Live Shop', 'shop');
  const base = 'https://mydukapos.store/api/license-status';
  assert.equal((await ask(ls, env, base + '?c=' + rec.id)).valid, true);
  assert.equal((await ask(ls, env, base + '?c=NOPE-NEVER-EXISTED')).reason, 'not_found', 'unknown is NOT deleted');
  assert.equal((await ask(ls, env, base)).reason, 'no_link', 'no shop named at all is NOT deleted');
  assert.equal((await ask(ls, env, base + '?c=' + rec.id)).valid, true);
  await lic.deleteClient(env, rec.id);
  assert.equal((await ask(ls, env, base + '?c=' + rec.id)).reason, 'deleted', 'in Trash');
  // sit in Trash for 31 days, then the purge removes it for good and leaves a tombstone
  const r2 = await lic.getLicense(env, rec.id); r2.deletedAt = Date.now() - 31 * 24 * 3600 * 1000; await lic.saveLicense(env, r2);
  await lic.purgeExpiredTrash(env);
  assert.equal(await lic.getLicense(env, rec.id), null, 'really gone');
  assert.equal((await ask(ls, env, base + '?c=' + rec.id)).reason, 'deleted', 'purged: the tombstone proves it');
  assert.equal((await ask(ls, env, base + '?c=SOMEONE-ELSE')).reason, 'not_found');
});

test('a live shop on its own subdomain is found even when the slug entry is missing or differs (the ?c= it carries is honoured), but never on another shop\'s subdomain', async () => {
  const env = { mydukapos_kv: makeKV(), LICENSE_CACHE_MS: '0' };
  const lic = await imp('functions/api/_license.js'); const ls = await imp('functions/api/license-status.js');
  const a = await lic.createClient(env, 'permanent', 'Makesh Liquor Joint', 'hotel');
  const b = await lic.createClient(env, 'permanent', 'Other Shop', 'hotel');
  const host = (label) => `https://${label}.mydukapos.store/api/license-status`;
  assert.equal((await ask(ls, env, host(a.slug))).valid, true, 'normal: slug entry present');
  await env.mydukapos_kv.delete('slug:' + a.slug);                                  // the slug entry is lost
  assert.equal((await ask(ls, env, host(a.slug) + '?c=' + a.id)).valid, true, 'slug entry missing: found through its own c');
  assert.equal((await ask(ls, env, host('some-renamed-label') + '?c=' + a.id)).valid, true, 'an unclaimed subdomain + the real c is trusted like the apex ?c=');
  const r3 = await ask(ls, env, host(b.slug) + '?c=' + a.id);
  assert.notEqual(r3.clientId, a.id, "another shop's subdomain never accepts someone else's c");
  const r4 = await ask(ls, env, host('typo-label'));
  assert.equal(r4.reason, 'not_found'); assert.ok(r4.diag, 'support diagnostics included');
});

test('a shop whose slug entry is lost is found again from the Licenses index with NO c at all (an installed app), and the entry is written back', async () => {
  const env = { mydukapos_kv: makeKV(), LICENSE_CACHE_MS: '0' };
  const lic = await imp('functions/api/_license.js'); const ls = await imp('functions/api/license-status.js');
  const a = await lic.createClient(env, 'permanent', 'Makesh Liquor Joint', 'hotel');
  await env.mydukapos_kv.delete('slug:' + a.slug);
  const r = await ask(ls, env, `https://${a.slug}.mydukapos.store/api/license-status`);
  assert.equal(r.valid, true); assert.equal(r.clientId, a.id);
  assert.equal(await env.mydukapos_kv.get('slug:' + a.slug), a.id, 'the slug entry is healed');
});
