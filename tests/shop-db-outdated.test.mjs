import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';

// Zip 125: a shop in its own database whose server (the router Worker) was not redeployed runs pre-zip-120 code: no device list, no
// till numbers, no stock ledger — the device list showed "—" everywhere. It is now said plainly, to the shop and in the Owner Console.
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
async function shop(outdated) {
  const kv = makeKV(); seedShop(kv, 'C1'); kv.data.set('pos-data:mode:C1', { value: 'do' });
  kv.data.set('owner-session:tok', { value: '1' });
  const binding = await makeBinding();
  if (outdated) {                                                            // the old ShopStore: no /registry
    const get = binding.get;
    binding.get = (id) => { const s = get(id); return { fetch: (url, o) => (String(url).endsWith('/registry') ? Promise.resolve(new Response('Not found', { status: 404 })) : s.fetch(url, o)) }; };
  }
  return { kv, env: { mydukapos_kv: kv, SHOP_STORE: binding } };
}

test('device list: an out-of-date shop database is flagged; an up-to-date one is not', { skip: !hasSqlite && 'node:sqlite missing' }, async () => {
  const dp = await load('device-pair.js');
  for (const outdated of [true, false]) {
    const { env } = await shop(outdated);
    const r = await dp.onRequestGet({ request: new Request('https://x.pages.dev/api/device-pair?c=C1'), env });
    const body = await r.json();
    assert.equal(body.serverWarning === 'db_outdated', outdated);
  }
});

test('Owner Console health names the fix (npm run deploy:router)', { skip: !hasSqlite && 'node:sqlite missing' }, async () => {
  const { shopHealth } = await load('owner-health.js');
  const bad = await shopHealth((await shop(true)).env, { id: 'C1' });
  assert.ok(bad.dbOutdated);
  assert.ok(bad.problems.some((p) => /deploy:router/.test(p)));
  const good = await shopHealth((await shop(false)).env, { id: 'C1' });
  assert.ok(!good.dbOutdated);
});
