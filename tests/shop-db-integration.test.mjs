import baseTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';
const test = hasSqlite ? baseTest : baseTest.skip;

// The whole path a shop takes: blob -> database -> back, through the real Pages Functions and the real ShopStore.
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const DAY = 86400000;

async function setup(opts = {}) {
  // zip 156: a PERMANENT shop moves into the database at its first push (see zip156-server-write-race). These tests are about the manual move of a
  // single-record shop, so the shop here is a demo link (which keeps the single-record start).
  const kv = makeKV(); seedShop(kv, 'C1', { type: 'demo', expiresAt: Date.now() + 30 * 86400000, createdAt: Date.now() });
  kv.data.set('owner-session:tok', { value: '1' });
  const env = { mydukapos_kv: kv, SHOP_STORE: await makeBinding(opts), MIGRATE_SETTLE_MS: 10 };
  const call = async (mod, fn, url, method = 'GET', body, headers = {}) => {
    const m = await load(mod);
    return m[fn]({ request: new Request('https://x.pages.dev' + url, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', ...headers } }), env, waitUntil() {} });
  };
  const auth = { Authorization: 'Bearer tok' };
  return {
    kv, env, call,
    push: (b) => call('pos-sync.js', 'onRequestPost', '/api/pos-sync?c=C1', 'POST', { businessName: 'Biz', ...b }),
    pull: async (q = '') => (await call('pos-sync.js', 'onRequestGet', '/api/pos-sync?c=C1' + q)).json(),
    owner: async (b) => { const r = await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', b, auth); return { status: r.status, ...(await r.json()) }; },
  };
}
const sale = (id, ageDays) => ({ id, timestamp: new Date(Date.now() - ageDays * DAY).toISOString(), paymentMethod: 'cash', cashAmount: 10, items: [{ code: '1', qty: 1, price: 10 }] });

test('migrate: the shop moves into its database with everything in it, devices keep working, and the old record is kept as a rollback', async () => {
  const s = await setup();
  const now = Date.now();
  await s.push({ updatedAt: now, inventory: [{ code: 'A', name: 'Bolt', qty: 5, price: 10, updatedAt: 1 }], salesLog: [sale('old', 400), sale('new', 1)], staff: [{ id: 'u1', name: 'Ann', updatedAt: 1 }], receiptFooter: 'Thanks' });
  const blobBefore = s.kv.data.get('pos-data:state:C1').value;
  const m = await s.owner({ action: 'migrate', clientId: 'C1' });
  assert.equal(m.changed, true);
  assert.equal(s.kv.data.get('pos-data:mode:C1').value, 'do');
  assert.equal(s.kv.data.get('pos-data:state:C1').value, blobBefore, 'the old record is untouched (rollback copy)');
  const got = await s.pull('&hot=all');
  assert.deepEqual(got.salesLog.map((x) => x.id).sort(), ['new', 'old']);
  assert.equal(got.inventory[0].qty, 5);
  assert.equal(got.receiptFooter, 'Thanks');
  const recent = await s.pull();
  assert.deepEqual(recent.salesLog.map((x) => x.id), ['new'], 'devices get the recent window by default; the 400-day-old sale is in the database, not lost');

  // a device pushes after the move: it lands in the database, not the old record
  const r = await s.push({ updatedAt: Date.now(), salesLog: [sale('after', 0)] });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.equal(s.kv.data.get('pos-data:state:C1').value, blobBefore);
  assert.ok((await s.pull()).salesLog.some((x) => x.id === 'after'));
  // conditional GET
  const ua = (await s.pull()).updatedAt;
  assert.deepEqual(await s.pull('&since=' + ua), { unchanged: true, updatedAt: ua });
});

test('migrate is verified and reversible: unmigrate brings back everything, including what was pushed while in the database', async () => {
  const s = await setup();
  await s.push({ updatedAt: Date.now(), salesLog: [sale('a', 500), sale('b', 1)], inventory: [{ code: 'A', qty: 3, updatedAt: 1 }] });
  await s.owner({ action: 'migrate', clientId: 'C1' });
  await s.push({ updatedAt: Date.now(), salesLog: [sale('c', 0)] });
  const back = await s.owner({ action: 'unmigrate', clientId: 'C1' });
  assert.equal(back.changed, true);
  assert.equal(s.kv.data.has('pos-data:mode:C1'), false);
  const got = await s.pull();
  assert.deepEqual(got.salesLog.map((x) => x.id).sort(), ['a', 'b', 'c']);
  assert.equal(got.inventory[0].qty, 3);
});

test('migrate that fails leaves the shop exactly as it was, and pushes are told to retry only while it is moving', async () => {
  const s = await setup({ failOn: '/import' });
  await s.push({ updatedAt: Date.now(), salesLog: [sale('a', 1)] });
  const before = s.kv.data.get('pos-data:state:C1').value;
  const m = await s.owner({ action: 'migrate', clientId: 'C1' });
  assert.equal(m.status, 500);
  assert.match(m.error, /nothing was changed/);
  assert.equal(s.kv.data.has('pos-data:mode:C1'), false, 'still a normal shop');
  assert.equal(s.kv.data.get('pos-data:state:C1').value, before);
  assert.equal((await s.push({ updatedAt: Date.now(), salesLog: [sale('b', 1)] })).status, 200);
  // while "migrating", devices get a polite 503 (they retry), never a lost push
  s.kv.data.set('pos-data:mode:C1', { value: 'migrating' });
  const busy = await s.push({ updatedAt: Date.now(), salesLog: [sale('c', 1)] });
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('Retry-After'), '5');
});

test('without the SHOP_STORE binding nothing changes: shops stay on the single record and migrate says why not', async () => {
  const s = await setup();
  delete s.env.SHOP_STORE;
  assert.equal((await s.push({ updatedAt: Date.now(), salesLog: [sale('a', 1)] })).status, 200);
  assert.equal((await s.pull()).salesLog.length, 1);
  const m = await s.owner({ action: 'migrate', clientId: 'C1' });
  assert.equal(m.status, 409);
  assert.match(m.error, /SHOP_STORE/);
});

test('a database shop has no size ceiling: 30,000 sales, small pushes stay fast, devices still get a bounded window', async () => {
  const s = await setup();
  await s.owner({ action: 'migrate', clientId: 'C1' });
  const big = Array.from({ length: 30000 }, (_, i) => ({ ...sale('s' + i, i % 500), note: 'x'.repeat(200) }));
  assert.equal((await s.push({ updatedAt: Date.now(), salesLog: big })).status, 200);
  let t = Date.now();
  assert.equal((await s.push({ updatedAt: Date.now(), salesLog: [sale('one-more', 0)] })).status, 200);
  const one = Date.now() - t;
  // A generous ceiling, not a tight one: this is here to catch a real
  // regression (e.g. an accidental full scan over all 30,000 sales on
  // every push) rather than to hold the CI machine to a specific
  // millisecond figure — that kind of tight wall-clock budget is flaky
  // under normal load (e.g. running the whole suite back to back), and a
  // flaky test that fails on a healthy build is worse than a looser one
  // that still catches a genuine slowdown.
  assert.ok(one < 500, `one more sale on a 30,000-sale shop took ${one} ms`);
  const window = await s.pull();
  const all = await s.pull('&hot=all');
  assert.ok(window.salesLog.length < 30000 * 0.4, `default window is bounded (${window.salesLog.length})`);
  assert.equal(all.salesLog.length, 30001, 'nothing archived away');
  const list = await s.owner({ action: 'archives', clientId: 'C1' });
  assert.equal(list.archives.length, 0, 'no archive was needed');
});

test('history: any date range, paged, for a database shop AND a single-record shop', async () => {
  const s = await setup();
  const logs = [sale('a', 400), sale('b', 300), sale('c', 200), sale('d', 1)];
  await s.push({ updatedAt: Date.now(), salesLog: logs });
  const q = (extra = '') => s.call('history.js', 'onRequestGet', `/api/history?c=C1&col=salesLog&from=${Date.now() - 450 * DAY}&to=${Date.now() - 150 * DAY}${extra}`).then((r) => r.json());
  const blob = await q('&limit=2');
  assert.deepEqual(blob.records.map((r) => r.id), ['a', 'b']);
  assert.ok(blob.next);
  assert.deepEqual((await q(`&limit=2&after=${blob.next}`)).records.map((r) => r.id), ['c']);
  await s.owner({ action: 'migrate', clientId: 'C1' });
  const db = await q('&limit=2');
  assert.deepEqual(db.records.map((r) => r.id), ['a', 'b'], 'same answer from the database');
  assert.deepEqual((await q(`&limit=2&after=${db.next}`)).records.map((r) => r.id), ['c']);
  assert.equal((await s.call('history.js', 'onRequestGet', '/api/history?c=C1&col=inventory')).status, 400);
});

test('owner reset-password and cross-shop writes reach a database shop (they go through the same merge as a device push)', async () => {
  const s = await setup();
  await s.push({ updatedAt: Date.now(), pwHash: 'old-hash', adminPwHash: 'old-admin' });
  await s.owner({ action: 'migrate', clientId: 'C1' });
  const lock = await load('owner-lock.js');
  const r = await lock.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-lock', { method: 'POST', body: JSON.stringify({ c: 'C1', action: 'resetPassword', target: 'login' }), headers: { Authorization: 'Bearer tok', 'content-type': 'application/json' } }), env: s.env });
  assert.equal(r.status, 200);
  const got = await s.pull();
  assert.notEqual(got.pwHash, 'old-hash', 'the reset password hash is what devices now see');
  assert.equal(got.adminPwHash, 'old-admin', 'the other password is untouched');
  // A till that's still active (mid-sale, editing stock — anything that
  // triggers its own routine sync) doesn't know the password just changed,
  // so it keeps pushing its own stale copy of the OLD hash. Without the
  // reset stamping _fieldTimes, that stale push would silently win and
  // undo the reset within moments — which is exactly what was reported as
  // "resetting via the owner console isn't working."
  await s.push({ updatedAt: Date.now(), pwHash: 'old-hash', salesLog: [{ id: 's1', total: 500 }] });
  const afterStalePush = await s.pull();
  assert.notEqual(afterStalePush.pwHash, 'old-hash', 'an unaware device\'s routine push cannot undo the reset');
});

test('owner reset-password on a plain (non-database) shop also survives an unaware device\'s stale push', async () => {
  const s = await setup();
  await s.push({ updatedAt: Date.now(), pwHash: 'old-hash', adminPwHash: 'old-admin' });
  const lock = await load('owner-lock.js');
  const r = await lock.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-lock', { method: 'POST', body: JSON.stringify({ c: 'C1', action: 'resetPassword', target: 'login' }), headers: { Authorization: 'Bearer tok', 'content-type': 'application/json' } }), env: s.env });
  assert.equal(r.status, 200);
  const got = await s.pull();
  assert.notEqual(got.pwHash, 'old-hash', 'the reset password hash is what devices now see');
  await s.push({ updatedAt: Date.now(), pwHash: 'old-hash', salesLog: [{ id: 's1', total: 500 }] });
  const afterStalePush = await s.pull();
  assert.notEqual(afterStalePush.pwHash, 'old-hash', 'an unaware device\'s routine push cannot undo the reset');
});

test('backups: a database shop is protected by point-in-time history instead, and says so instead of restoring a stale copy', async () => {
  const s = await setup();
  await s.owner({ action: 'migrate', clientId: 'C1' });
  const { restoreBackup } = await load('_backups.js');
  const r = await restoreBackup(s.env, 'C1', '2026-01-01');
  assert.equal(r.status, 409);
  assert.match(r.error, /point-in-time/);
});

test('owner list shows database shops with their real record counts and never flags them "large"', async () => {
  const s = await setup();
  await s.push({ updatedAt: Date.now(), salesLog: Array.from({ length: 50 }, (_, i) => sale('s' + i, i)) });
  await s.owner({ action: 'migrate', clientId: 'C1' });
  const list = await (await s.call('owner-storage.js', 'onRequestGet', '/api/owner-storage', 'GET', undefined, { Authorization: 'Bearer tok' })).json();
  const shop = list.shops.find((x) => x.id === 'C1');
  assert.equal(shop.mode, 'db');
  assert.equal(shop.db.records >= 50, true);
  assert.equal(shop.level, 'ok');
});

test('database shops tell devices the window (_hotFrom) and poke the other tills instead of broadcasting the shop', async () => {
  const s = await setup();
  const sent = [];
  s.env.SYNC_ROOM = { idFromName: (n) => n, get: () => ({ fetch: async (url, opts) => { sent.push(opts.body); return new Response('ok'); } }) };
  await s.push({ updatedAt: Date.now(), salesLog: [sale('a', 1)] });
  assert.equal(sent.length, 1, 'a normal shop broadcasts its data as before');
  assert.ok(JSON.parse(sent[0]).salesLog, 'the whole record, not a poke');
  await s.owner({ action: 'migrate', clientId: 'C1' });
  sent.length = 0;
  await s.push({ updatedAt: Date.now(), salesLog: [sale('b', 1)] });
  assert.deepEqual(sent, ['{"poke":true}'], 'just a poke: no shop data, no updatedAt');
  assert.ok((await s.pull())._hotFrom > 0, 'windowed pull says where the window starts');
  assert.equal((await s.pull('&hot=all'))._hotFrom, undefined, 'a full pull has no window');
});

test('database self-test: runs the whole life of a shop on a throw-away database, reports each step, and refuses to touch a shop that has data', async () => {
  const s = await setup();
  const r = await s.owner({ action: 'dbSelfTest' });
  assert.equal(r.status, 200);
  assert.ok(r.steps.length >= 8);
  const failed = r.steps.filter((x) => !x.ok && !x.soft);
  assert.deepEqual(failed, [], 'every hard step passes: ' + JSON.stringify(failed));
  assert.ok(r.steps.find((x) => /bulk load/.test(x.name)).detail.includes('ms'));
  const pit = r.steps.find((x) => /point-in-time/.test(x.name));
  assert.equal(pit.soft || pit.ok, true, 'a runtime without point-in-time recovery is a warning, not a failure');
  // it never touches a real shop: run it directly on a database that holds data
  await s.push({ updatedAt: Date.now(), salesLog: [sale('keep-me', 1)] });
  await s.owner({ action: 'migrate', clientId: 'C1' });
  const store = s.env.SHOP_STORE.stores.get('C1');
  const refused = await store.selfTest();
  assert.equal(refused.ok, false);
  assert.match(refused.steps[0].detail, /already holds data/);
  assert.equal((await s.pull()).salesLog.some((x) => x.id === 'keep-me'), true, 'the real shop is untouched');
  // and without the binding it says why
  delete s.env.SHOP_STORE;
  assert.equal((await s.owner({ action: 'dbSelfTest' })).status, 409);
});

test('photos can be shrunk for a shop that lives in its database too', async () => {
  const s = await setup();
  const IMGD = (n) => 'data:image/jpeg;base64,' + 'A'.repeat(n);
  await s.push({ updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Big', image: IMGD(400000), qty: 1, updatedAt: 1 }] });
  await s.owner({ action: 'migrate', clientId: 'C1' });
  const list = await s.owner({ action: 'photosList', clientId: 'C1' });
  assert.equal(list.items.length, 1);
  const set = await s.owner({ action: 'photosSet', clientId: 'C1', images: [{ col: 'inventory', code: 'A', image: IMGD(15000) }] });
  assert.equal(set.updated, 1);
  const got = await s.pull();
  assert.equal(got.inventory[0].image.length, IMGD(15000).length);
  assert.equal(got.inventory[0].qty, 1);
  await s.push({ updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Big', image: IMGD(400000), qty: 1, updatedAt: 1 }] });      // stale big copy
  assert.equal((await s.pull()).inventory[0].image.length, IMGD(15000).length);
});
