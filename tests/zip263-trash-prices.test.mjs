import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKV } from './kv-fake.mjs';
import * as oa from '../functions/api/_owner-auth.js';
import { createClient, deleteClient, getLicense, listClientSummaries } from '../functions/api/_license.js';
import { createAccount, getAccount, resolveLoginId, saveAccount } from '../functions/api/_account.js';
import { saveGatewayConfig } from '../functions/api/_gateway-config.js';
import { SHARED_DEMOS, ensureSharedDemo } from '../functions/api/_shared-demos.js';
import { onRequestPost as lock } from '../functions/api/owner-lock.js';
import { onRequestPost as prices } from '../functions/api/product-prices.js';
import { onRequestPost as gml } from '../functions/api/get-my-link.js';

// zip 263 - Empty trash frees the person's phone and email; product prices are the owner's to edit (nothing fixed in code).
async function world() {
  const env = { mydukapos_kv: makeKV() };
  const acct = await oa.createOwnerAccount(env, 'o@example.com', 'Sup3r-secret-pw');
  const sess = await oa.createOwnerSession(env, acct);
  const post = (fn, body, url = 'https://x.pages.dev/api/x') => fn({ env, request: new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sess }, body: JSON.stringify(body) }) }).then(async (r) => ({ r, j: await r.json() }));
  return { env, acct, post };
}
const signup = (env, o = {}) => createAccount(env, { fullName: 'Mary', phone: '0712345678', email: 'mary@example.com', password: 'Tr1cky-pass', confirmPassword: 'Tr1cky-pass', ...o });

test('Empty trash removes the links for good and frees their phone and email, so a new sign-up is never told they exist', async () => {
  const w = await world();
  const c = await createClient(w.env, 'permanent', 'Marys Shop', 'shop', { clientName: 'Mary', phone: '0712345678', email: 'mary@example.com' });
  const a = await signup(w.env); a.demoClientId = c.id; await saveAccount(w.env, a);
  await assert.rejects(() => signup(w.env), /already exists/, 'while the link exists the contact is taken');
  await deleteClient(w.env, c.id);
  await assert.rejects(() => signup(w.env), /already exists/, 'in Trash it can still be restored, so it is still tied');
  assert.deepEqual((await w.post(lock, { action: 'purge', c: 'nope' })).r.status, 404, 'only something in Trash can be deleted forever');
  const e = await w.post(lock, { action: 'emptyTrash' }); assert.equal(e.j.purged, 1);
  assert.equal(await getLicense(w.env, c.id), null, 'the link is gone');
  assert.equal(await getAccount(w.env, 'mary@example.com'), null, 'the website account is gone');
  assert.equal(await resolveLoginId(w.env, '0712345678'), '254712345678@phone.mydukapos.invalid', 'the phone points at nothing');
  await signup(w.env);                                                     // no "already exists"
});

test('a person who still has another live link keeps their login; one link can be deleted forever on its own', async () => {
  const w = await world();
  const one = await createClient(w.env, 'permanent', 'Shop One', 'shop', { phone: '0712345678', email: 'mary@example.com' });
  await createClient(w.env, 'permanent', 'Shop Two', 'hotel', { phone: '0712345678' });
  const a = await signup(w.env); a.demoClientId = one.id; await saveAccount(w.env, a);
  await deleteClient(w.env, one.id);
  assert.equal((await w.post(lock, { action: 'purge', c: one.id })).j.purged, 1);
  assert.ok(await getAccount(w.env, 'mary@example.com'), 'the other live link still uses this phone, so the login stays');
  assert.equal((await listClientSummaries(w.env)).filter((x) => x.label === 'Shop Two').length, 1);
});

test('a "Get my own link" request disappears with the link it created', async () => {
  const w = await world();
  await ensureSharedDemo(w.env, SHARED_DEMOS.find((d) => d.key === 'retail'));
  const call = (body) => gml({ env: w.env, request: new Request('https://x.pages.dev/api/get-my-link?c=demo_retail', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'x' }, body: JSON.stringify(body) }) }).then((r) => r.json());
  const s = await call({ action: 'start', name: 'Mary Wanjiku', phone: '0712345678', email: '' });
  await call({ action: 'claim', id: s.id, token: s.token });
  const done = await w.post(gml, { action: 'confirm', id: s.id }); assert.ok(done.j.request.clientId);
  await deleteClient(w.env, done.j.request.clientId);
  await w.post(lock, { action: 'emptyTrash' });
  assert.equal(w.env.mydukapos_kv.data.get('buy:' + s.id), undefined);
  assert.deepEqual((await w.post(gml, { action: 'list' })).j.requests, []);
});

test('prices are the owner\'s: per product, a branch price that defaults to the same, nothing fixed in code', async () => {
  const w = await world();
  await ensureSharedDemo(w.env, SHARED_DEMOS.find((d) => d.key === 'retail'));
  const opts = () => gml({ env: w.env, request: new Request('https://x.pages.dev/api/get-my-link?c=demo_retail', { method: 'POST', body: JSON.stringify({ action: 'options' }) }) }).then((r) => r.json());
  assert.equal((await opts()).amount, 3000, 'no price saved: the website price (3,000 by default)');
  assert.equal((await w.post(prices, { action: 'get' })).j.websitePrice, 3000);
  let p = await w.post(prices, { action: 'set', prices: { shop: 3500, hotel: '5000', bogus: 9 }, branchPrices: { shop: 2000 } });
  assert.deepEqual(p.j.prices, { shop: 3500, hotel: 5000 }); assert.deepEqual(p.j.branchPrices, { shop: 2000 }); assert.equal(p.j.products.length >= 7, true);
  const o = await opts(); assert.equal(o.amount, 3500); assert.equal(o.branchAmount, 2000);
  p = await w.post(prices, { action: 'set', prices: { shop: 3500 }, branchPrices: {} });
  assert.equal((await opts()).branchAmount, 3500, 'no branch price: same as the product');
  assert.equal((await gml({ env: w.env, request: new Request('https://x.pages.dev/api/x', { method: 'POST', body: JSON.stringify({ action: 'get' }) }) }).then((r) => r.status)) >= 400, true);
  assert.equal((await prices({ env: w.env, request: new Request('https://x.pages.dev/api/x', { method: 'POST', body: JSON.stringify({ action: 'get' }) }) })).status, 401, 'owner only');
});
