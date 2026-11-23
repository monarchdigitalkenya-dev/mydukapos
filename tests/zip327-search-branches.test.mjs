// zip 327: other-branch search uses the same matching as the till, and a failed lookup is never shown as "no matches".
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, boot } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const sync = await load('functions/api/pos-sync.js');
const xb = await load('functions/api/cross-branch-sale.js');

function world() {
  const kv = makeKV();
  seedShop(kv, 'C1', { branchGroupId: 'G1', label: 'Branch One' });
  seedShop(kv, 'C2', { branchGroupId: 'G1', label: 'Branch Two' });
  kv.data.set('branch-group:G1', { value: JSON.stringify(['C1', 'C2']) });
  return { kv, env: { mydukapos_kv: kv, MIGRATE_SETTLE_MS: 10 } };
}
const req = (c, m, b) => new Request(`https://x.pages.dev/api/pos-sync?c=${c}`, { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
const search = async (env, query) => (await (await xb.onRequestPost({ request: new Request('https://x.pages.dev/api/cross-branch-sale?c=C1', { method: 'POST', body: JSON.stringify({ action: 'searchOtherBranches', query }), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} })).json());

test('server: other-branch search finds a product by part of the name, any word order, punctuation, a nameless record does not break it', async () => {
  const { env } = world();
  const inv = [
    { code: 'B3', name: 'Fresh Beef Mince', qty: 4, price: 500, updatedAt: 1 },
    { code: 'S9', name: 'Coca-Cola 500ml', qty: 9, price: 70, updatedAt: 1 },
    { code: 'ZZ', qty: 3, price: 1, updatedAt: 1 },                       // no name
    { code: 'AR', name: 'Archived Beef', qty: 3, price: 1, archived: true, updatedAt: 1 },
    { code: 'OUT', name: 'Beef Out', qty: 0, price: 1, updatedAt: 1 },
  ];
  await sync.onRequestPost({ request: req('C2', 'POST', { businessName: 'B2', inventory: inv }), env, waitUntil() {} });
  const codes = async (q) => (await search(env, q)).results.map((r) => r.code).sort();
  assert.deepEqual(await codes('mince'), ['B3']);
  assert.deepEqual(await codes('MINCE  fresh'), ['B3']);
  assert.deepEqual(await codes('coca cola'), ['S9']);
  assert.deepEqual(await codes('cocacola'), ['S9']);
  assert.deepEqual(await codes('beef'), ['B3'], 'archived and out-of-stock items of the other branch are not offered');
  assert.deepEqual(await codes('zz'), ['ZZ'], 'the nameless record is still found by its code, and did not throw');
});

for (const mode of ['server error', 'network down']) {
  test(`till: ${mode} on the other-branch lookup keeps the local results and says so (not "no matches")`, async () => {
    const { w, d } = await boot('index.html', { storage: { pos_inventory: JSON.stringify([{ code: 'B3', type: 'item', name: 'Fresh Beef Mince', qty: 4, price: 500, unit: 'pcs' }]) }, wait: 700 });
    w.eval("showToast = function () {}");
    w.eval(mode === 'server error'
      ? "window.fetch = () => Promise.resolve(new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }))"
      : "window.fetch = () => Promise.reject(new TypeError('Failed to fetch'))");
    d.getElementById('sales-search').value = 'mince';
    await w.eval("searchOtherBranchesForCart('mince')");
    const txt = d.getElementById('search-results').textContent;
    assert.ok(!txt.includes('No matches in other branches'), 'a failure is not a genuine empty result: ' + txt);
    assert.ok(d.querySelector('#search-results .cross-branch-search-failed'), 'the failure is shown');
    assert.ok(!d.getElementById('cross-branch-search-loading'), 'the spinner is gone');
  });
}
