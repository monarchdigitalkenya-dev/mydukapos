import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
async function setup(extra = {}) {
  const kv = makeKV(); seedShop(kv, 'C1', extra);
  kv.data.set('owner-session:tok', { value: '1' });
  const env = { mydukapos_kv: kv };
  const lock = async (body) => { const m = await load('owner-lock.js'); const r = await m.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-lock', { method: 'POST', body: JSON.stringify({ c: 'C1', ...body }), headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' } }), env }); return { status: r.status, body: await r.json() }; };
  return { kv, lock };
}

test('recordGroupIncome: validated, accumulates multiple entries per group, and never collides with recordRevenue\'s per-link fields', async () => {
  const s = await setup();
  assert.equal((await s.lock({ action: 'recordGroupIncome', groupKey: 'maurice malowa', groupLabel: 'Maurice Malowa', agreedAmount: 0, paidAmount: 0 })).status, 400, 'agreed must be > 0');
  assert.equal((await s.lock({ action: 'recordGroupIncome', groupKey: 'maurice malowa', groupLabel: 'Maurice Malowa', agreedAmount: 3000, paidAmount: 3500 })).status, 400, 'paid cannot exceed agreed');
  assert.equal((await s.lock({ action: 'recordGroupIncome', groupKey: '', groupLabel: '', agreedAmount: 100, paidAmount: 0 })).status, 400, 'groupKey required');

  const first = await s.lock({ action: 'recordGroupIncome', groupKey: 'maurice malowa', groupLabel: 'Maurice Malowa', agreedAmount: 5000, paidAmount: 3000, method: 'mpesa', note: 'Initial setup' });
  assert.equal(first.status, 200);
  assert.equal(first.body.entries.length, 1);
  assert.equal(first.body.entries[0].agreed, 5000);

  // A second entry for the same person, later — the old recordRevenue action
  // would 409 here (recorded once, disabled). This is the whole point of
  // the new ledger: it must accumulate, not block.
  const second = await s.lock({ action: 'recordGroupIncome', groupKey: 'maurice malowa', groupLabel: 'Maurice Malowa', agreedAmount: 1500, paidAmount: 1500, method: 'cash', note: 'Extra service' });
  assert.equal(second.status, 200);
  assert.equal(second.body.entries.length, 2, 'accumulates rather than replacing or refusing');
  assert.equal(second.body.entries[1].note, 'Extra service');

  // recordRevenue (the old per-link action) still works exactly as before, on the underlying license record.
  const rev = await s.lock({ action: 'recordRevenue', agreedAmount: 9000, paidAmount: 9000 });
  assert.equal(rev.status, 200);
  assert.equal(rev.body.client.revenue.agreed, 9000, 'untouched, independent data path from the group ledger');

  // The group ledger is keyed independently of any one client id.
  const raw = s.kv.data.get('owner-group-income:v1');
  const stored = JSON.parse(raw.value);
  assert.equal(stored['maurice malowa'].entries.length, 2);
  assert.equal(stored['maurice malowa'].label, 'Maurice Malowa');
});

test('recordGroupIncome: requires a real client id and owner auth', async () => {
  const s = await setup();
  const bad = await s.lock({ c: 'does-not-exist', action: 'recordGroupIncome', groupKey: 'x', groupLabel: 'X', agreedAmount: 100, paidAmount: 0 });
  assert.equal(bad.status, 404);
});

test('/api/owner-clients GET includes the group-income ledger alongside the client list', async () => {
  const s = await setup();
  await s.lock({ action: 'recordGroupIncome', groupKey: 'maurice malowa', groupLabel: 'Maurice Malowa', agreedAmount: 5000, paidAmount: 3000 });
  const clientsMod = await load('owner-clients.js');
  const res = await clientsMod.onRequestGet({ request: new Request('https://x.pages.dev/api/owner-clients', { headers: { Authorization: 'Bearer tok' } }), env: { mydukapos_kv: s.kv } });
  const data = await res.json();
  assert.ok(data.groupIncome, 'groupIncome is present in the response');
  assert.equal(data.groupIncome['maurice malowa'].entries.length, 1);
});
