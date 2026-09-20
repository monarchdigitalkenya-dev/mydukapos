import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const KEY = (id) => `pos-data:state:${id}`;
const big = (n, tag = 'x') => Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, name: `Item number ${i} with a reasonably long descriptive name`, price: i, updatedAt: 1 }));

function setup(envExtra = {}) {
  const kv = makeKV();
  seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, ...envExtra };
  const call = async (mod, fn, url, method = 'GET', body, headers = {}) => {
    const m = await load(mod);
    const request = new Request('https://x.pages.dev' + url, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', ...headers } });
    return m[fn]({ request, env, waitUntil() {} });
  };
  const push = (body, headers) => call('pos-sync.js', 'onRequestPost', '/api/pos-sync?c=C1', 'POST', { businessName: 'Biz', ...body }, headers);
  const pull = (q = '') => call('pos-sync.js', 'onRequestGet', '/api/pos-sync?c=C1' + q);
  return { kv, env, call, push, pull };
}

test('push reply is slim: only what the apps read, not the whole shop', async () => {
  const { push } = setup();
  const r = await push({ updatedAt: Date.now(), products: big(50) });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.ok(j.updatedAt > 0);
  assert.equal(j.products, undefined);
  assert.ok(JSON.stringify(j).length < 200);
});

test('size guard: an oversized shop is refused with 413 + a clear message, and the last good copy is untouched', async () => {
  const { kv, push, pull } = setup({ SYNC_MAX_BYTES: '30000' });
  assert.equal((await push({ updatedAt: Date.now(), products: big(20) })).status, 200);
  const good = kv.data.get(KEY('C1')).value;
  const r = await push({ updatedAt: Date.now(), products: big(2000) });
  const j = await r.json();
  assert.equal(r.status, 413);
  assert.equal(j.code, 'shop_too_large');
  assert.match(j.error, /too large to sync/);
  assert.ok(j.bytes > j.limit);
  assert.equal(kv.data.get(KEY('C1')).value, good, 'refused push wrote nothing');
  assert.ok(kv.data.has('pos-data:sizealert:C1'), 'refusal recorded for the Owner Console');
  const back = await (await pull()).json();
  assert.equal(back.products.length, 20);
});

test('auto-compress: a big shop is stored gzipped, reads back identical, and stays compressed on later pushes', async () => {
  const { kv, push, pull } = setup({ SYNC_AUTO_COMPRESS_BYTES: '5000' });
  const products = big(300);
  const r = await push({ updatedAt: Date.now(), products });
  assert.equal(r.status, 200);
  const stored = kv.data.get(KEY('C1'));
  assert.ok(stored.value.startsWith('gz1:'), 'stored gzipped');
  assert.ok(stored.value.length < JSON.stringify(products).length / 3, 'much smaller than the raw JSON');
  assert.equal(stored.metadata.gz, true);
  assert.ok(stored.metadata.bytes > 5000 && stored.metadata.stored < stored.metadata.bytes);
  const got = await (await pull()).json();
  assert.deepEqual(got.products, products, 'lossless round trip');
  // a later, small push keeps it compressed (sticky)
  await push({ updatedAt: Date.now() + 5, products: products.slice(0, 5) });
  assert.ok(kv.data.get(KEY('C1')).value.startsWith('gz1:'));
});

test('small shops are untouched: plain JSON, size metadata attached, writer IP recorded', async () => {
  const { kv, push } = setup();
  await push({ updatedAt: Date.now(), products: big(3) }, { 'CF-Connecting-IP': '41.90.1.2', 'CF-IPCountry': 'KE' });
  const s = kv.data.get(KEY('C1'));
  assert.ok(s.value.startsWith('{'), 'plain JSON');
  assert.equal(s.metadata.gz, false);
  assert.equal(s.metadata.bytes, new TextEncoder().encode(s.value).length);
  assert.equal(s.metadata.writers[0].ip, '41.90.1.2');
  assert.equal(s.metadata.writers[0].cc, 'KE');
  assert.ok(s.metadata.ua > 0);
});

test('legacy data (plain JSON, no metadata) still reads and merges', async () => {
  const { kv, push, pull } = setup();
  kv.data.set(KEY('C1'), { value: JSON.stringify({ updatedAt: 10, businessName: 'Biz', products: [{ id: 'a', name: 'old', updatedAt: 5 }] }) });
  const got = await (await pull()).json();
  assert.equal(got.products[0].name, 'old');
  await push({ updatedAt: Date.now(), products: [{ id: 'b', name: 'new', updatedAt: 6 }] });
  const after = await (await pull()).json();
  assert.deepEqual(after.products.map((p) => p.id).sort(), ['a', 'b']);
});

test('conditional GET answers "unchanged" from metadata, without decoding a compressed shop', async () => {
  const { push, pull, kv } = setup({ SYNC_AUTO_COMPRESS_BYTES: '5000' });
  const r = await (await push({ updatedAt: Date.now(), products: big(300) })).json();
  // corrupt the payload: if the fast path decoded it, this would throw
  const cur = kv.data.get(KEY('C1'));
  kv.data.set(KEY('C1'), { value: 'gz1:AAAA', metadata: cur.metadata });
  const u = await (await pull('&since=' + r.updatedAt)).json();
  assert.equal(u.unchanged, true);
});

test('CORS: only the shop\'s own domain family is answered — no wildcard', async () => {
  const { call } = setup({ ROOT_DOMAIN: 'mydukapos.store' });
  const opt = (origin) => call('pos-sync.js', 'onRequestOptions', '/api/pos-sync', 'OPTIONS', undefined, origin ? { Origin: origin } : {});
  assert.equal((await opt('https://evil.example.com')).headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await opt('https://georgehardware.mydukapos.store')).headers.get('Access-Control-Allow-Origin'), 'https://georgehardware.mydukapos.store');
  assert.equal((await opt('https://mydukapos.store')).headers.get('Access-Control-Allow-Origin'), 'https://mydukapos.store');
  assert.equal((await opt('https://notmydukapos.store')).headers.get('Access-Control-Allow-Origin'), null, 'suffix trick rejected');
  assert.equal((await opt(null)).headers.get('Access-Control-Allow-Origin'), null);
  const get = await call('pos-sync.js', 'onRequestGet', '/api/pos-sync?c=C1', 'GET', undefined, { Origin: 'https://evil.example.com' });
  assert.equal(get.headers.get('Access-Control-Allow-Origin'), null);
});

test('backups of a big shop are stored gzipped and restore losslessly', async () => {
  const { kv, push, pull, env } = setup();
  const products = big(9000);                                    // ~0.9 MB: above the backup-compression threshold
  await push({ updatedAt: Date.now(), products });
  kv.data.delete('pos-data:backup:C1:last-date');                // the first push already claimed today's slot; reopen it
  await push({ updatedAt: Date.now() + 10, products });         // now the state written above is snapshotted
  const backupKeys = [...kv.data.keys()].filter((k) => /pos-data:backup:C1:\d{4}-/.test(k));
  assert.equal(backupKeys.length, 1);
  assert.ok(kv.data.get(backupKeys[0]).value.startsWith('gz1:'), 'big backup compressed');
  const { restoreBackup } = await load('_backups.js');
  const date = backupKeys[0].split(':').pop();
  await push({ updatedAt: Date.now() + 20, products: [] });
  const res = await restoreBackup(env, 'C1', date);
  assert.equal(res.restored, true);
  const got = await (await pull()).json();
  assert.equal(got.products.length, 9000);
});

// ---- Owner Console Storage endpoint ----
test('owner-storage: needs the owner session; lists shops largest-first with levels; measure/compress/uncompress are lossless', async () => {
  const { kv, env, call, push } = setup({ SYNC_WARN_BYTES: '20000', SYNC_MAX_BYTES: '400000' });
  seedShop(kv, 'C2');
  kv.data.set('owner-session:tok', { value: '1' });
  const auth = { Authorization: 'Bearer tok' };
  await push({ updatedAt: Date.now(), products: big(400) });                                   // ~ big, C1
  await (await load('pos-sync.js')).onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C2', { method: 'POST', body: JSON.stringify({ businessName: 'Biz2', updatedAt: Date.now(), products: big(3) }) }), env, waitUntil() {} });

  assert.equal((await call('owner-storage.js', 'onRequestGet', '/api/owner-storage')).status, 401);
  const list = await (await call('owner-storage.js', 'onRequestGet', '/api/owner-storage', 'GET', undefined, auth)).json();
  assert.equal(list.shops.length, 2);
  assert.equal(list.shops[0].id, 'C1', 'largest / most urgent first');
  assert.equal(list.shops[0].level, 'warn');
  assert.equal(list.shops[1].level, 'ok');
  assert.equal(list.shops[0].label, 'Biz', 'shows the business name the shop pushed');

  const m = await (await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'measure', clientId: 'C1' }, auth)).json();
  assert.equal(m.fields[0].name, 'products');
  assert.equal(m.fields[0].items, 400);

  const before = JSON.parse(kv.data.get(KEY('C1')).value);
  const c = await (await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'compress', clientId: 'C1' }, auth)).json();
  assert.equal(c.changed, true);
  assert.ok(c.ratio > 3, `expected >3x, got ${c.ratio}`);
  assert.ok(kv.data.get(KEY('C1')).value.startsWith('gz1:'));
  assert.equal(kv.data.get(KEY('C1')).metadata.gz, true);
  assert.deepEqual(JSON.parse(await (await (await load('_state-store.js')).decodeStateText(kv.data.get(KEY('C1')).value))), before, 'identical after compression');
  const again = await (await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'compress', clientId: 'C1' }, auth)).json();
  assert.equal(again.changed, false);

  const u = await (await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'uncompress', clientId: 'C1' }, auth)).json();
  assert.equal(u.changed, true);
  assert.deepEqual(JSON.parse(kv.data.get(KEY('C1')).value), before, 'identical after uncompressing');
  assert.equal((await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'compress', clientId: '../x' }, auth)).status, 400);
});

test('owner-storage: a shop refused for size shows as "refused" until a newer write succeeds', async () => {
  const { kv, env, call, push } = setup({ SYNC_MAX_BYTES: '30000' });
  kv.data.set('owner-session:tok', { value: '1' });
  const auth = { Authorization: 'Bearer tok' };
  await push({ updatedAt: Date.now(), products: big(10) });
  await push({ updatedAt: Date.now(), products: big(3000) });
  let list = await (await call('owner-storage.js', 'onRequestGet', '/api/owner-storage', 'GET', undefined, auth)).json();
  assert.equal(list.shops[0].level, 'refused');
  await new Promise((r) => setTimeout(r, 5));
  await push({ updatedAt: Date.now(), products: big(10) });
  list = await (await call('owner-storage.js', 'onRequestGet', '/api/owner-storage', 'GET', undefined, auth)).json();
  assert.notEqual(list.shops[0].level, 'refused');
});

// ---- rate limits ----
test('SMS: per-shop hourly cap counts recipients, blocks with 429 + Retry-After, and is reported to the owner', async () => {
  const { kv, call } = setup({ SMS_HOURLY_LIMIT: '5' });
  kv.data.set('owner-session:tok', { value: '1' });
  const send = (n) => call('sms-send.js', 'onRequestPost', '/api/sms-send?c=C1', 'POST', { message: 'hi', to: Array.from({ length: n }, (_, i) => `07001000${String(i).padStart(2, '0')}`) });
  const first = await send(3);
  assert.notEqual(first.status, 429, 'within the cap');
  const second = await send(3);              // 3 + 3 > 5
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get('Retry-After')) > 0);
  assert.equal((await second.json()).code, 'rate_limited');
  const list = await (await call('owner-storage.js', 'onRequestGet', '/api/owner-storage', 'GET', undefined, { Authorization: 'Bearer tok' })).json();
  assert.equal(list.rateLimited.length, 1);
  assert.equal(list.rateLimited[0].name, 'sms');
});

test('M-Pesa STK: per-shop hourly cap', async () => {
  const { env } = setup({ STK_HOURLY_LIMIT: '2' });
  const { checkRateLimit } = await load('_ratelimit.js');
  assert.equal((await checkRateLimit(env, 'stk', 'C1', 1)).ok, true);
  assert.equal((await checkRateLimit(env, 'stk', 'C1', 1)).ok, true);
  assert.equal((await checkRateLimit(env, 'stk', 'C1', 1)).ok, false);
  assert.equal((await checkRateLimit(env, 'stk', 'C2', 1)).ok, true, 'other shops are independent');
});

// ---- archiving old history (the lever that actually shrinks a shop) ----
test('archive: old history moves to a verified gzipped archive, devices get a smaller shop, and it can be restored without duplicates', async () => {
  const { kv, call, push, pull } = setup();
  kv.data.set('owner-session:tok', { value: '1' });
  const auth = { Authorization: 'Bearer tok' };
  const day = 86400000, now = Date.now();
  const sale = (id, ageDays) => ({ id, timestamp: new Date(now - ageDays * day).toISOString(), paymentMethod: 'cash', cashAmount: 10, items: [{ code: '1', qty: 1, price: 10 }] });
  const mv = (id, ageDays) => ({ id, timestamp: new Date(now - ageDays * day).toISOString(), code: '1', delta: -1 });
  const oldSales = Array.from({ length: 100 }, (_, i) => sale('old' + i, 200 + i % 50));
  const newSales = Array.from({ length: 20 }, (_, i) => sale('new' + i, i));
  await push({ updatedAt: now, salesLog: [...oldSales, ...newSales], stockMovementLog: [mv('m-old', 300), mv('m-new', 1)], inventory: [{ code: '1', name: 'Bolt', qty: 5, updatedAt: 1 }], returns: [{ id: 'r-nodate' }] });
  const beforeUpdatedAt = (await (await pull()).json()).updatedAt;

  const a = await (await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'archive', clientId: 'C1', keepDays: 90 }, auth)).json();
  assert.equal(a.changed, true);
  assert.deepEqual(a.counts, { salesLog: 100, stockMovementLog: 1 });
  assert.ok(a.bytesAfter < a.bytesBefore);

  const live = await (await pull()).json();
  assert.equal(live.salesLog.length, 20, 'only the hot window is left');
  assert.deepEqual(live.stockMovementLog.map((m) => m.id), ['m-new']);
  assert.equal(live.returns.length, 1, 'a record with no date is never archived');
  assert.equal(live.inventory[0].qty, 5, 'everything else is untouched');
  assert.ok(live.updatedAt > beforeUpdatedAt, 'updatedAt moved so devices pull the smaller shop');

  const list = await (await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'archives', clientId: 'C1' }, auth)).json();
  assert.equal(list.archives.length, 1);
  assert.deepEqual(list.archives[0].counts, { salesLog: 100, stockMovementLog: 1 });
  const stored = kv.data.get(`pos-data:archive:C1:${a.archiveId}`).value;
  assert.ok(stored.startsWith('gz1:'), 'the archive itself is gzipped');

  const dl = await (await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'downloadArchive', clientId: 'C1', archiveId: a.archiveId }, auth)).json();
  assert.equal(dl.fields.salesLog.length, 100);

  const r1 = await (await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'restoreArchive', clientId: 'C1', archiveId: a.archiveId }, auth)).json();
  assert.equal(r1.restored, 101);
  const r2 = await (await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'restoreArchive', clientId: 'C1', archiveId: a.archiveId }, auth)).json();
  assert.equal(r2.restored, 0, 'restoring twice adds nothing');
  const back = await (await pull()).json();
  assert.equal(back.salesLog.length, 120);
  assert.equal(new Set(back.salesLog.map((s) => s.id)).size, 120, 'no duplicates');

  const again = await (await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'archive', clientId: 'C1', keepDays: 1000 }, auth)).json();
  assert.equal(again.changed, false, 'nothing older than the cutoff -> no-op');
});

test('archive needs the owner session and a sane keepDays', async () => {
  const { kv, call, push } = setup();
  await push({ updatedAt: Date.now(), salesLog: [{ id: 'a', timestamp: new Date(Date.now() - 400 * 86400000).toISOString() }] });
  assert.equal((await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'archive', clientId: 'C1' })).status, 401);
  kv.data.set('owner-session:tok', { value: '1' });
  const r = await (await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'archive', clientId: 'C1', keepDays: 0 }, { Authorization: 'Bearer tok' })).json();
  assert.equal(r.keepDays, 90, 'a missing / zero keepDays falls back to 90 days, never "archive everything"');
});

// ---- AUTOMATIC archive at 80% of the size limit ----
const DAY = 86400000;
const mkSale = (id, ageDays, now = Date.now()) => ({ id, timestamp: new Date(now - ageDays * DAY).toISOString(), paymentMethod: 'cash', cashAmount: 10, note: 'x'.repeat(150), items: [{ code: '1', qty: 1, price: 10 }] });

test('auto-archive: at 80% of the limit the shop trims itself, no error, nothing lost, and re-sent old records are not brought back', async () => {
  const { kv, push, pull, env } = setup({ SYNC_MAX_BYTES: '200000', SYNC_AUTO_COMPRESS_BYTES: 'off' });
  const now = Date.now();
  const oldSales = Array.from({ length: 400 }, (_, i) => mkSale('old' + i, 100 + (i % 200), now));      // > 90 days old
  const newSales = Array.from({ length: 150 }, (_, i) => mkSale('new' + i, i % 60, now));
  // one push that would be OVER the limit (~ 550 x 300 B): it must be archived, not refused
  const r = await push({ updatedAt: now, salesLog: [...oldSales, ...newSales], inventory: [{ code: '1', name: 'Bolt', qty: 5, updatedAt: 1 }] });
  assert.equal(r.status, 200, 'not a 413');
  let live = await (await pull()).json();
  const liveBytes = new TextEncoder().encode(JSON.stringify(live)).length;
  assert.ok(liveBytes <= 200000 * 0.6, `back under 60% of the limit (${liveBytes})`);
  assert.ok(live._archiveCutoff > 0);
  assert.equal(live._lastAutoArchive.keepDays <= 90, true);
  assert.equal(live.inventory[0].qty, 5, 'the rest of the shop is untouched');
  const archiveKeys = [...kv.data.keys()].filter((k) => k.startsWith('pos-data:archive:C1:'));
  assert.equal(archiveKeys.length, 1);
  const { decodeStateText } = await load('_state-store.js');
  const arch = JSON.parse(await decodeStateText(kv.data.get(archiveKeys[0]).value));
  assert.equal(arch.auto, true);
  assert.equal(arch.fields.salesLog.length + live.salesLog.length, 550, 'every sale is either live or archived');
  assert.ok(new Set([...arch.fields.salesLog, ...live.salesLog].map((s) => s.id)).size === 550, 'no duplicates, none lost');

  // a device reloads and re-sends its whole history: the archived records must not come back, and no second archive is made
  await push({ updatedAt: Date.now() + 5, salesLog: [...oldSales, ...newSales] });
  live = await (await pull()).json();
  assert.equal(live.salesLog.length, 550 - arch.fields.salesLog.length, 'archived records stayed archived');
  assert.equal([...kv.data.keys()].filter((k) => k.startsWith('pos-data:archive:C1:')).length, 1, 'no second archive');

  // a NEW record that just has an old date (back-dated import) is kept, not mistaken for archived history
  await push({ updatedAt: Date.now() + 10, salesLog: [mkSale('imported-backdated', 300, now)] });
  live = await (await pull()).json();
  assert.ok(live.salesLog.some((s) => s.id === 'imported-backdated'));
});

test('auto-archive: a shop below 80% is never touched', async () => {
  const { kv, push, pull } = setup({ SYNC_MAX_BYTES: '200000' });
  const now = Date.now();
  await push({ updatedAt: now, salesLog: Array.from({ length: 100 }, (_, i) => mkSale('s' + i, 200, now)) });     // old but small
  const live = await (await pull()).json();
  assert.equal(live.salesLog.length, 100);
  assert.equal(live._archiveCutoff, undefined);
  assert.equal([...kv.data.keys()].filter((k) => k.startsWith('pos-data:archive')).length, 0);
});

test('auto-archive: restoring an archive re-opens those ids (the index is updated)', async () => {
  const { kv, call, push, pull } = setup({ SYNC_MAX_BYTES: '200000', SYNC_AUTO_COMPRESS_BYTES: 'off' });
  kv.data.set('owner-session:tok', { value: '1' });
  const now = Date.now();
  const all = [...Array.from({ length: 400 }, (_, i) => mkSale('old' + i, 100 + (i % 200), now)), ...Array.from({ length: 150 }, (_, i) => mkSale('new' + i, i % 60, now))];
  await push({ updatedAt: now, salesLog: all });
  const list = await (await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'archives', clientId: 'C1' }, { Authorization: 'Bearer tok' })).json();
  assert.equal(list.archives.length, 1);
  assert.equal(list.archives[0].auto, true, 'flagged as automatic');
  const idxKey = 'pos-data:archive-ids:C1';
  const { decodeStateText } = await load('_state-store.js');
  const before = JSON.parse(await decodeStateText(kv.data.get(idxKey).value)).salesLog.length;
  assert.ok(before > 0);
  await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { action: 'restoreArchive', clientId: 'C1', archiveId: list.archives[0].id }, { Authorization: 'Bearer tok' });
  const after = JSON.parse(await decodeStateText(kv.data.get(idxKey).value)).salesLog.length;
  assert.equal(after, 0, 'restored ids are no longer treated as archived');
});
