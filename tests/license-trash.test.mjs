import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';

async function harness() {
  const kv = makeKV();
  const env = { mydukapos_kv: kv };
  const lic = await import(pathToFileURL(path.join(ROOT, 'functions/api/_license.js')).href);
  return { env, lic };
}

test('deleteClient soft-deletes: the record, slug and index entry all survive, but the license is invalid', async () => {
  const { env, lic } = await harness();
  const record = await lic.createClient(env, 'permanent', "Jane's Chemist", 'pharmacy');
  assert.equal(lic.evaluateLicense(record).valid, true, 'valid before deletion');

  const removed = await lic.deleteClient(env, record.id);
  assert.equal(removed, true);

  const after = await lic.getLicense(env, record.id);
  assert.equal(after.deleted, true);
  assert.ok(after.deletedAt);
  assert.equal(after.slug, record.slug, 'the slug is untouched — restoring needs no re-creation');
  assert.equal(lic.evaluateLicense(after).valid, false);
  assert.equal(lic.evaluateLicense(after).reason, 'deleted');

  // the slug mapping itself must still resolve to this client (not freed) while it's only in Trash
  const bySlug = await lic.getLicenseBySlug(env, record.slug);
  assert.equal(bySlug.id, record.id);

  // deleting an already-deleted client is a no-op, not a double-delete
  assert.equal(await lic.deleteClient(env, record.id), false);
});

test('restoreClient undoes a soft delete exactly, and only works on something actually in Trash', async () => {
  const { env, lic } = await harness();
  const record = await lic.createClient(env, 'demo', 'Northside Hotel', 'hotel');
  await lic.deleteClient(env, record.id);

  assert.equal(await lic.restoreClient(env, 'no-such-id'), false);

  const restored = await lic.restoreClient(env, record.id);
  assert.equal(restored, true);
  const after = await lic.getLicense(env, record.id);
  assert.equal(after.deleted, undefined);
  assert.equal(after.deletedAt, undefined);
  assert.equal(lic.evaluateLicense(after).valid, true, 'live again after restore');

  // restoring something not in Trash is a no-op
  assert.equal(await lic.restoreClient(env, record.id), false);
});

test('listClientSummaries separates Trash from the live list, and both stay searchable', async () => {
  const { env, lic } = await harness();
  const alive = await lic.createClient(env, 'permanent', 'Alive Shop', 'shop');
  const trashed = await lic.createClient(env, 'permanent', 'Trashed Shop', 'shop');
  await lic.deleteClient(env, trashed.id);

  const live = await lic.listClientSummaries(env, {});
  assert.ok(live.some((c) => c.id === alive.id));
  assert.ok(!live.some((c) => c.id === trashed.id), 'a trashed client is excluded from the normal list');

  const trash = await lic.listClientSummaries(env, { trashOnly: true });
  assert.ok(trash.some((c) => c.id === trashed.id));
  assert.ok(!trash.some((c) => c.id === alive.id), 'a live client is excluded from the trash list');

  const found = await lic.listClientSummaries(env, { q: 'trashed', trashOnly: true });
  assert.equal(found.length, 1);
});

test('purgeExpiredTrash leaves anything under 30 days alone, and permanently removes anything older', async () => {
  const { env, lic } = await harness();
  const recent = await lic.createClient(env, 'permanent', 'Recent Delete', 'shop');
  const old = await lic.createClient(env, 'permanent', 'Old Delete', 'shop');
  await lic.deleteClient(env, recent.id);
  await lic.deleteClient(env, old.id);

  // backdate the old one past the 30-day window
  const oldRecord = await lic.getLicense(env, old.id);
  oldRecord.deletedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
  await lic.saveLicense(env, oldRecord);

  const purgedCount = await lic.purgeExpiredTrash(env);
  assert.equal(purgedCount, 1);

  assert.equal(await lic.getLicense(env, old.id), null, 'the old one is really gone');
  const stillThere = await lic.getLicense(env, recent.id);
  assert.equal(stillThere.deleted, true, 'the recent one is still safely in Trash');

  const bySlug = await lic.getLicenseBySlug(env, old.slug);
  assert.equal(bySlug, null, 'its slug is freed for reuse only after the real purge');

  const trash = await lic.listClientSummaries(env, { trashOnly: true });
  assert.ok(!trash.some((c) => c.id === old.id), 'gone from the index too');
});
