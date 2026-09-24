import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);

// A new branch used to start with no clientName at all, so it stood alone
// in the owner's Permanent Clients list (grouped by clientName — see
// groupNameKey() in owner/index.html) until the owner noticed and manually
// renamed it to match. Creating a branch now inherits the calling shop's
// own clientName automatically, so the two group together from the start.
test('creating a branch inherits the calling shop\'s clientName, so it groups with its sibling automatically', async () => {
  const kv = makeKV();
  seedShop(kv, 'C1', { clientName: 'Maurice Malowa' });
  const env = { mydukapos_kv: kv };
  const branchesMod = await load('branches.js');

  const res = await branchesMod.onRequestPost({
    request: new Request('https://x.pages.dev/api/branches?c=C1', {
      method: 'POST',
      body: JSON.stringify({ action: 'create', branchName: 'Singapore' }),
      headers: { 'content-type': 'application/json' },
    }),
    env,
  });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.branch.clientName, 'Maurice Malowa', 'the new branch inherits the main shop\'s clientName');

  // Stored on the license record itself, not just in the response.
  const stored = JSON.parse(kv.data.get(`license:${data.branch.id}`).value);
  assert.equal(stored.clientName, 'Maurice Malowa');
});

test('creating a branch when the calling shop has no clientName set leaves the new branch exactly as before (nothing to inherit)', async () => {
  const kv = makeKV();
  seedShop(kv, 'C1'); // no clientName
  const env = { mydukapos_kv: kv };
  const branchesMod = await load('branches.js');

  const res = await branchesMod.onRequestPost({
    request: new Request('https://x.pages.dev/api/branches?c=C1', {
      method: 'POST',
      body: JSON.stringify({ action: 'create', branchName: 'Singapore' }),
      headers: { 'content-type': 'application/json' },
    }),
    env,
  });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.branch.clientName, '', 'no regression — still blank, same as before this fix');
});
