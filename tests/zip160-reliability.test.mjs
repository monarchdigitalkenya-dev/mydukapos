import test from 'node:test';
import assert from 'node:assert/strict';
import { until } from './helpers.mjs';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// Zip 160 - reliability leftovers of zip 159: (A) a stale device must not stamp old records as fresh, (B) every server writer respects the
// write fence, (C) returns of set items / produced items, (E) refill log truncation is reported.
const J = (w, js) => { const r = w.eval(`JSON.stringify(${js})`); return r === undefined ? undefined : JSON.parse(r); };
const idle = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0));

// ---------------------------------------------------------------------------------------------------------- A: stale device stamping
for (const app of ['index.html', 'production/index.html']) {
  test(`A [${app}]: a device booted from OLD storage (empty change snapshot) does not stamp old records as fresh, so a delete tombstone survives, its offline sales arrive, and a real offline edit still wins`, async () => {
    const s = makeServer();
    const T0 = Date.now() - 3 * 86400000;
    const seed = () => [{ id: 'c1', name: 'Ann', phone: '0700000001', updatedAt: T0 }, { id: 'c2', name: 'Bob', phone: '0700000002', updatedAt: T0 }, { id: 'c3', name: 'Cy', phone: '0700000003', updatedAt: T0 }];
    const a = await openDevice(app, s, { pos_customers: JSON.stringify(seed()) }, 1500); a.w.eval("showToast = function () {}");
    await a.w.eval('pushNow()'); await a.w.eval('pullState()'); await idle(a);
    const oldStorage = deviceStorage(a.w);                                 // what a till in a drawer still has
    // A deletes Ann (a tombstone) and syncs
    a.w.eval("customers = customers.filter(c => c.id !== 'c1'); safeSetItem('pos_customers', JSON.stringify(customers)); queuePush()");
    await idle(a); await a.w.eval('pushNow()');
    const onServer = () => (s.serverState().customers || []);
    assert.equal(onServer().find((c) => c.id === 'c1')._deleted, true, 'precondition: tombstone on the server');
    // B: old storage, offline while booting (nothing pulled), then it sells offline and edits Cy offline, then the network comes back
    s.state.down = true;
    const b = await openDevice(app, s, oldStorage, 1500); b.w.eval("showToast = function () {}");
    assert.ok(J(b.w, "customers.some(c => c.id === 'c1')"), 'B still holds Ann');
    b.w.eval(`salesLog.push({ id: 'offline-sale-1', timestamp: new Date().toISOString(), items: [{ code: 'X', name: 'X', qty: 1, price: 50 }], total: 50, paymentMethod: 'cash' }); safeSetItem('pos_sales_log', JSON.stringify(salesLog)); queuePush()`);
    await sleep(50);
    b.w.eval("customers.find(c => c.id === 'c3').name = 'Cy edited offline'; safeSetItem('pos_customers', JSON.stringify(customers)); queuePush()");
    await sleep(600);
    s.state.down = false;
    await b.w.eval('pushNow()');                                            // the first thing a returning till does: push (the old code pushed before pulling)
    await idle(b);
    await b.w.eval('pullState()'); await idle(b);
    const c1 = onServer().find((c) => c.id === 'c1');
    assert.equal(c1 && c1._deleted, true, 'the tombstone survived the stale device');
    assert.ok((s.serverState().salesLog || []).some((x) => x.id === 'offline-sale-1'), 'the offline sale arrived');
    assert.equal(onServer().find((c) => c.id === 'c3').name, 'Cy edited offline', 'a record really edited offline still wins');
    assert.equal(onServer().find((c) => c.id === 'c2').updatedAt, T0, 'an untouched record kept its ORIGINAL updatedAt (not stamped fresh)');
    assert.equal(J(b.w, "customers.some(c => c.id === 'c1' && !c._deleted)"), false, 'B dropped Ann after it synced');
    a.close(); b.close();
  });
}

// ---------------------------------------------------------------------------------------------------------- B: every server writer uses the write fence
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const KEY = 'pos-data:state:C1';
const DAY = 86400000;
async function shop(extraEnv = {}, { d1 = true } = {}) {
  const kv = makeKV(); seedShop(kv, 'C1', { type: 'demo', expiresAt: Date.now() + 30 * DAY, createdAt: Date.now() });      // a demo link stays a single record
  kv.data.set('owner-session:tok', { value: '1' });
  const env = { mydukapos_kv: kv, FENCE_WAIT_MS: '60', RETRY_BASE_MS: '0', MIGRATE_SETTLE_MS: 10, ...(d1 ? { LEDGER_DB: makeD1() } : {}), ...extraEnv };
  const call = async (mod, fn, url, method = 'GET', body, headers = {}) => {
    const m = await load(mod);
    return m[fn]({ request: new Request('https://x.pages.dev' + url, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', ...headers } }), env, waitUntil() {} });
  };
  const sale = (id) => ({ id, refNumber: 'R-' + id, timestamp: new Date().toISOString(), paymentMethod: 'cash', cashAmount: 100, servedBy: 'J', items: [{ code: 'A', name: 'A', qty: 1, price: 100 }] });
  const s = {
    kv, env, call, sale,
    push: (b) => call('pos-sync.js', 'onRequestPost', '/api/pos-sync?c=C1', 'POST', { businessName: 'Biz', ...b }),
    pull: async () => (await call('pos-sync.js', 'onRequestGet', '/api/pos-sync?c=C1')).json(),
    owner: async (b) => { const r = await call('owner-storage.js', 'onRequestPost', '/api/owner-storage', 'POST', { clientId: 'C1', ...b }, { Authorization: 'Bearer tok' }); return { status: r.status, ...(await r.json()) }; },
    lock: async (b) => { const r = await call('owner-lock.js', 'onRequestPost', '/api/owner-lock', 'POST', { c: 'C1', ...b }, { Authorization: 'Bearer tok' }); return { status: r.status, ...(await r.json()) }; },
    meta: () => kv.data.get(KEY).metadata,
    state: () => JSON.parse(kv.data.get(KEY).value),
    row: () => (env.LEDGER_DB ? env.LEDGER_DB.query(`SELECT * FROM shop_write_fence WHERE client_id = 'C1'`)[0] : null),
  };
  return s;
}
// after an unfenced-looking writer: the stored version IS the fence's version (never lower), and the very next fenced push is accepted at once
async function assertFenceConsistent(s, label) {
  const row = s.row();
  assert.ok(row, label + ': the fence row exists');
  assert.equal(s.meta().ver, row.kv_ver, label + ': the version it stamped is the version the fence expects');
  const before = row.seq;
  const r = await s.push({ salesLog: [s.sale('after-' + label.replace(/\W/g, ''))] });
  assert.equal(r.status, 200, label + ': the next device push is accepted (no 503 busy)');
  assert.equal(s.row().seq, before + 1);
  assert.ok(s.meta().ver > row.kv_ver);
}

test('B: writeStateFenced - claims the next slot, stamps the fence version, and refuses a write built from a stale read', async () => {
  const { writeStateFenced, readStateRaw } = await load('_state-store.js');
  const s = await shop();
  await s.push({ salesLog: [s.sale('p1')] });
  const cur1 = await readStateRaw(s.env, KEY);
  const m = await writeStateFenced(s.env, KEY, JSON.stringify({ ...JSON.parse(cur1.text), owner: 'edited', updatedAt: Date.now() }), { prevMeta: cur1.meta });
  assert.ok(m && m.ver === cur1.meta.ver + 1);
  assert.equal(s.row().kv_ver, m.ver);
  // a device push lands; a writer that read BEFORE it (cur1) must not overwrite it or stamp a lower version
  await s.push({ salesLog: [s.sale('p2')] });
  const kvBefore = s.kv.data.get(KEY).value;
  const stale = await writeStateFenced(s.env, KEY, JSON.stringify({ wiped: true, updatedAt: Date.now() }), { prevMeta: m });
  assert.equal(stale, null, 'refused: the copy it read is not the copy that is there');
  assert.equal(s.kv.data.get(KEY).value, kvBefore, 'nothing was written');
  // ...and one that read a copy which is OLDER than the fence knows (a stale KV read) is refused too, without touching anything
  s.env.LEDGER_DB._db.exec(`UPDATE shop_write_fence SET kv_ver = 999, at = ${Date.now()} WHERE client_id = 'C1'`);
  const cur2 = await readStateRaw(s.env, KEY);
  assert.equal(await writeStateFenced(s.env, KEY, cur2.text, { prevMeta: cur2.meta }), null, 'the fence says the stored copy is behind: busy, not a lower version');
  assert.equal(s.kv.data.get(KEY).value, kvBefore);
});

test('B: writeStateFenced - no D1, WRITE_FENCE=0, or a fence that fails to answer: exactly the old behaviour (version = previous + 1)', async () => {
  const { writeStateFenced, readStateRaw } = await load('_state-store.js');
  for (const [label, envx, opts] of [['no D1', {}, { d1: false }], ['WRITE_FENCE=0', { WRITE_FENCE: '0' }, {}], ['fence query fails', {}, {}]]) {
    const s = await shop(envx, opts);
    await s.push({ salesLog: [s.sale('p1')] });
    if (label === 'fence query fails') s.env.LEDGER_DB._state.failOnSql = /shop_write_fence/;
    const cur = await readStateRaw(s.env, KEY);
    const m = await writeStateFenced(s.env, KEY, JSON.stringify({ ...JSON.parse(cur.text), owner: 'edited', updatedAt: Date.now() }), { prevMeta: cur.meta });
    assert.ok(m, label);
    assert.equal(m.ver, cur.meta.ver + 1, label + ': legacy version');
    assert.equal(s.state().owner, 'edited', label);
  }
});

test('B: owner resetPassword goes through the fence (version = fence version, next push accepted); a save landing between its read and write is kept', async () => {
  const s = await shop();
  await s.push({ pwHash: 'old-hash', adminPwHash: 'old-admin', salesLog: [s.sale('p1')] });
  const r = await s.lock({ action: 'resetPassword', target: 'login' });
  assert.equal(r.status, 200);
  assert.notEqual(s.state().pwHash, 'old-hash');
  await assertFenceConsistent(s, 'resetPassword');
  // race: a device push lands right after the reset READ the shop
  const getWM = s.kv.getWithMetadata.bind(s.kv); let armed = true;
  s.kv.getWithMetadata = async (k) => { const out = await getWM(k); if (armed && k === KEY) { armed = false; await s.push({ salesLog: [s.sale('raced')] }); } return out; };
  const r2 = await s.lock({ action: 'resetPassword', target: 'admin' });
  assert.equal(r2.status, 200);
  s.kv.getWithMetadata = getWM;
  assert.ok(s.state().salesLog.some((x) => x.id === 'raced'), 'the sale that landed meanwhile is still there');
  assert.notEqual(s.state().adminPwHash, 'old-admin', 'and the reset was applied on top of it');
  assert.equal(s.meta().ver, s.row().kv_ver);
});
test('B: owner resetPassword without D1 / with WRITE_FENCE=0 works as before', async () => {
  for (const [envx, opts] of [[{}, { d1: false }], [{ WRITE_FENCE: '0' }, {}]]) {
    const s = await shop(envx, opts);
    await s.push({ pwHash: 'old-hash', salesLog: [s.sale('p1')] });
    const v = s.meta().ver;
    assert.equal((await s.lock({ action: 'resetPassword', target: 'login' })).status, 200);
    assert.notEqual(s.state().pwHash, 'old-hash'); assert.equal(s.meta().ver, v + 1);
  }
});

test('B: owner compress / uncompress, photosSet, archive and restoreArchive all go through the fence', async () => {
  const s = await shop({ SYNC_AUTO_COMPRESS_BYTES: 'off' });
  const img = (n) => 'data:image/png;base64,' + 'A'.repeat(n);
  const old = (i) => ({ id: 'old' + i, timestamp: new Date(Date.now() - 200 * DAY).toISOString(), paymentMethod: 'cash', cashAmount: 5, items: [{ code: 'A', qty: 1, price: 5 }], paid: true });
  await s.push({ inventory: [{ code: 'P1', name: 'Photo', qty: 1, price: 1, image: img(5000), updatedAt: 1 }], salesLog: [old(1), old(2), s.sale('new1')] });
  const c = await s.owner({ action: 'compress' });
  assert.equal(c.status, 200); assert.equal(c.changed, true);
  await assertFenceConsistent(s, 'compress');
  const u = await s.owner({ action: 'uncompress' });
  assert.equal(u.changed, true);
  await assertFenceConsistent(s, 'uncompress');
  const p = await s.owner({ action: 'photosSet', images: [{ col: 'inventory', code: 'P1', image: img(300) }] });
  assert.equal(p.updated, 1);
  assert.equal(s.state().inventory[0].image.length < 1000, true);
  await assertFenceConsistent(s, 'photosSet');
  const a = await s.owner({ action: 'archive', keepDays: 30 });
  assert.equal(a.changed, true, JSON.stringify(a));
  assert.equal(s.state().salesLog.some((x) => x.id === 'old1'), false);
  await assertFenceConsistent(s, 'archive');
  const list = await s.owner({ action: 'archives' });
  const back = await s.owner({ action: 'restoreArchive', archiveId: list.archives[0].id });
  assert.ok(back.restored >= 2, JSON.stringify(back));
  assert.equal(s.state().salesLog.some((x) => x.id === 'old1'), true);
  await assertFenceConsistent(s, 'restoreArchive');
});
test('B: owner archive redoes itself from the newer copy when a save lands between its read and its write (the fence notices even a stale read)', async () => {
  const s = await shop({ SYNC_AUTO_COMPRESS_BYTES: 'off' });
  const old = (i) => ({ id: 'old' + i, timestamp: new Date(Date.now() - 200 * DAY).toISOString(), paymentMethod: 'cash', cashAmount: 5, items: [{ code: 'A', qty: 1, price: 5 }], paid: true });
  await s.push({ salesLog: [old(1), old(2), s.sale('new1')] });
  // a push lands right after the archive read the shop, and the "did it change?" raw comparison is fooled (a stale read that still matches)
  const getWM = s.kv.getWithMetadata.bind(s.kv); let armed = true, reads = 0;
  s.kv.getWithMetadata = async (k) => { const out = await getWM(k); if (k === KEY && ++reads === 1 && armed) { armed = false; setTimeout(() => {}, 0); } return out; };
  const plainGet = s.kv.get.bind(s.kv);
  s.kv.get = async (k) => { const v = await plainGet(k); if (k === KEY && !armed) { armed = 'done'; const cur = v; await s.push({ salesLog: [s.sale('raced')] }); return cur; } return v; };     // returns the OLD raw: the compare passes
  const a = await s.owner({ action: 'archive', keepDays: 30 });
  s.kv.get = plainGet; s.kv.getWithMetadata = getWM;
  assert.equal(a.status, 200, JSON.stringify(a));
  const ids = s.state().salesLog.map((x) => x.id);
  assert.ok(ids.includes('raced') && ids.includes('new1'), 'the sale that landed meanwhile survived the archive: ' + ids);
  assert.equal(ids.includes('old1'), false);
  assert.equal(s.meta().ver, s.row().kv_ver);
});

test('B: restoreBackup and seedInitialState go through the fence', async () => {
  const s = await shop();
  await s.push({ salesLog: [s.sale('p1')] });
  const { restoreBackup } = await load('_backups.js');
  s.kv.data.set('pos-data:backup:C1:2026-01-01', { value: JSON.stringify({ businessName: 'Old biz', salesLog: [], updatedAt: 5 }) });
  const r = await restoreBackup(s.env, 'C1', '2026-01-01');
  assert.equal(r.restored, true, JSON.stringify(r));
  assert.equal(s.state().businessName, 'Old biz');
  await assertFenceConsistent(s, 'restoreBackup');
  const { seedInitialState } = await load('pos-sync.js');
  await seedInitialState(s.env, 'C1', { pwHash: 'seeded' });
  assert.equal(s.state().pwHash, 'seeded'); assert.equal(s.state().businessName, 'Biz', 'merged, not replaced');
  await assertFenceConsistent(s, 'seedInitialState');
  // a brand-new shop (no record yet) can be seeded too, and then accepts a push
  const n = await shop();
  await seedInitialState(n.env, 'C1', { pwHash: 'first' });
  assert.equal(n.state().pwHash, 'first');
  await assertFenceConsistent(n, 'seed on empty');
});
test('B: restoreBackup / seedInitialState without D1 and with WRITE_FENCE=0 behave as before', async () => {
  const { restoreBackup } = await load('_backups.js'); const { seedInitialState } = await load('pos-sync.js');
  for (const [envx, opts] of [[{}, { d1: false }], [{ WRITE_FENCE: '0' }, {}]]) {
    const s = await shop(envx, opts);
    await s.push({ salesLog: [s.sale('p1')] });
    s.kv.data.set('pos-data:backup:C1:2026-01-01', { value: JSON.stringify({ businessName: 'Old biz', updatedAt: 5 }) });
    assert.equal((await restoreBackup(s.env, 'C1', '2026-01-01')).restored, true);
    await seedInitialState(s.env, 'C1', { pwHash: 'seeded' });
    assert.equal(s.state().businessName, 'Old biz'); assert.equal(s.state().pwHash, 'seeded');
    assert.equal((await s.push({ salesLog: [s.sale('p2')] })).status, 200);
  }
});

test('B: owner move back to a single record (unmigrate) goes through the fence', { skip: !hasSqlite }, async () => {
  const s = await shop({ SHOP_STORE: await makeBinding() });
  await s.push({ salesLog: [s.sale('p1')] });
  assert.equal((await s.owner({ action: 'migrate' })).changed, true);
  await s.push({ salesLog: [s.sale('p2')] });
  const back = await s.owner({ action: 'unmigrate' });
  assert.equal(back.changed, true, JSON.stringify(back));
  assert.ok(s.state().salesLog.some((x) => x.id === 'p2'));
  await assertFenceConsistent(s, 'unmigrate');
});

// ---------------------------------------------------------------------------------------------------------- C: returns of sets, and the produced-item tickbox
import { boot } from './helpers.mjs';
const INV = () => [
  { code: 'FLR', type: 'item', name: 'Flour', category: 'Raw', price: 0, wholesalePrice: 100, qty: 10, unit: 'kg', vatCategory: 'A' },
  { code: 'SGR', type: 'item', name: 'Sugar', category: 'Raw', price: 0, wholesalePrice: 150, qty: 5, unit: 'kg', vatCategory: 'A' },
  { code: 'CAKE', type: 'item', name: 'Cake', category: 'Baked', price: 900, wholesalePrice: 0, qty: 0, unit: 'pcs', vatCategory: 'A', productionRecipe: [{ code: 'FLR', qty: 2 }, { code: 'SGR', qty: 1 }] },
  { code: 'KIT', type: 'set', name: 'Baking Kit', category: 'Sets', price: 500, wholesalePrice: 0, qty: 0, unit: 'pcs', vatCategory: 'A', setComponents: [{ code: 'FLR', qty: 3 }, { code: 'SGR', qty: 1 }] },
  { code: 'TEA', type: 'item', name: 'Tea', category: 'Raw', price: 20, wholesalePrice: 0, qty: 10, unit: 'pcs', vatCategory: 'A' },
];
async function prod() {
  const b = await boot('production/index.html', { storage: { pos_inventory: JSON.stringify(INV()) }, wait: 1200 });
  b.w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; queuePrintJob = function () { return Promise.resolve(); }; renderReceipt = function () {};");
  return b;
}
const sell = async (w, codes) => {
  w.eval(`currentCart = {}; currentPaymentMethod = 'cash'; ${codes.map((c) => `addToCart('${c}')`).join('; ')}; document.getElementById('cash-tendered-input').value = '100000'`);
  await w.eval('checkoutCart()'); await sleep(80);
};
const qty = (w, c) => J(w, `inventory.find(i => i.code === '${c}').qty`);
const lastSale = (w) => J(w, 'salesLog[salesLog.length - 1]');
const ret = (b, code, cond, n = 1) => {
  const sale = lastSale(b.w), it = sale.items.find((l) => l.code === code);
  b.w.eval(`selectReturnRefItem('${sale.id}', ${sale.items.indexOf(it)}); returnMode = 'return'`);
  b.d = b.w.document;
  b.d.getElementById('return-qty-input').value = String(n);
  b.d.getElementById('return-condition-select').value = cond;
  b.w.eval('updateReturnConditionHint()');
};

test('C: returning a SET puts its COMPONENTS back, scaled by qty (what the sale line really used); Damaged puts nothing back; the set itself is never restocked', async () => {
  const b = await prod(); const { w } = b;
  await sell(w, ['KIT', 'KIT', 'KIT']);
  assert.equal(qty(w, 'FLR'), 1); assert.equal(qty(w, 'SGR'), 2, 'sold 3 sets: 9 flour and 3 sugar taken');
  const sale = lastSale(w);
  const line = sale.items.find((l) => l.code === 'KIT');
  assert.ok(Array.isArray(line.componentsUsed) && line.componentsUsed.length === 2, 'the sale line recorded what it used');
  assert.equal(line.componentsUsed.find((c) => c.code === 'FLR').qty, 9);
  // a per-line record that differs from the current setComponents list wins (the sale's own record, like componentsUsed for produced items)
  w.eval(`salesLog[salesLog.length - 1].items.find(l => l.code === 'KIT').componentsUsed = [{ code: 'FLR', name: 'Flour', qty: 12 }, { code: 'SGR', name: 'Sugar', qty: 3 }]`);
  // return 2 of the 3 through the Returns screen path
  ret(b, 'KIT', 'good', 2); w.eval('saveSimpleReturn()');
  assert.equal(qty(w, 'FLR'), 1 + 2 * 4, 'flour: 12/3 = 4 per set (what the sale line says it used) x 2');
  assert.equal(qty(w, 'SGR'), 2 + 2, 'sugar: 1 per set x 2');
  assert.equal(qty(w, 'KIT'), 0, 'no set unit invented');
  assert.ok(J(w, "stockMovementLog.some(m => m.code === 'FLR' && /components restored/.test(m.reason || ''))"), 'a stock movement explains the shelf');
  // Damaged: nothing goes back
  const f = qty(w, 'FLR'), s = qty(w, 'SGR');
  ret(b, 'KIT', 'damaged', 1); w.eval('saveSimpleReturn()');
  assert.equal(qty(w, 'FLR'), f); assert.equal(qty(w, 'SGR'), s);
  b.close();
});
test('C: a set sold before componentsUsed was recorded falls back to its setComponents list; a void after a partial return gives back only the rest', async () => {
  const b = await prod(); const { w } = b;
  w.eval("restockReturnedItem(inventory.find(i => i.code === 'KIT'), 2, {}, 'x')");
  assert.equal(qty(w, 'FLR'), 16); assert.equal(qty(w, 'SGR'), 7); assert.equal(qty(w, 'KIT'), 0);
  w.eval("inventory.find(i => i.code === 'FLR').qty = 10; inventory.find(i => i.code === 'SGR').qty = 5");
  await sell(w, ['KIT', 'KIT']);
  assert.equal(qty(w, 'FLR'), 4); assert.equal(qty(w, 'SGR'), 3);
  const sale = lastSale(w);
  w.eval(`restockReturnedItem(inventory.find(i => i.code === 'KIT'), 1, returnSelectionFromSaleItem(${JSON.stringify(sale.items[0])}, ${JSON.stringify(sale)}), 'r')`);
  w.eval(`returns.push({ id: 'r1', refNumber: '${sale.refNumber}', itemCode: 'KIT', qty: 1 })`);
  w.eval(`pendingVoidSaleSource = 'sales'; pendingVoidReason = 'x'; performVoidSale('${sale.id}')`);
  assert.equal(qty(w, 'FLR'), 10); assert.equal(qty(w, 'SGR'), 5, 'return + void restored each unit once');
  b.close();
});
test('C: an ordinary item and a set WITHOUT components behave as before', async () => {
  const b = await prod(); const { w } = b;
  w.eval("inventory.find(i => i.code === 'KIT').setComponents = []");
  w.eval("restockReturnedItem(inventory.find(i => i.code === 'KIT'), 2, {}, 'x')");
  assert.equal(qty(w, 'KIT'), 2, 'nothing to restore: the old restock of the item itself');
  w.eval("restockReturnedItem(inventory.find(i => i.code === 'TEA'), 2, {}, 'x')");
  assert.equal(qty(w, 'TEA'), 12);
  b.close();
});

test('C: the Returns screen has the tickbox for a produced item: hidden for other items and for Damaged, off by default, and ticking it puts the FINISHED item back instead of its materials', async () => {
  const b = await prod(); const { w } = b; const d = w.document;
  await sell(w, ['CAKE', 'CAKE', 'TEA', 'KIT']);
  const row = () => d.getElementById('return-reusable-row').style.display, box = () => d.getElementById('return-reusable-check');
  assert.match(d.getElementById('return-reusable-row').textContent, /Put the finished item back on the shelf instead of its materials/);
  ret(b, 'CAKE', 'good');
  assert.equal(row(), 'block'); assert.equal(box().checked, false, 'off by default');
  assert.equal(w.eval('selectedReturnItem.reusableFinished'), undefined);
  // Damaged hides and unticks it
  box().checked = true; w.eval('updateReturnReusableRow()');
  assert.equal(w.eval('selectedReturnItem.reusableFinished'), true);
  d.getElementById('return-condition-select').value = 'damaged'; w.eval('updateReturnConditionHint()');
  assert.equal(row(), 'none'); assert.equal(box().checked, false); assert.equal(w.eval('selectedReturnItem.reusableFinished'), undefined);
  // other items never show it
  ret(b, 'TEA', 'good'); assert.equal(row(), 'none');
  ret(b, 'KIT', 'good'); assert.equal(row(), 'none', 'a set returns its components, there is no finished-item choice');
  // default (off): materials go back
  ret(b, 'CAKE', 'good'); w.eval('saveSimpleReturn()');
  assert.equal(qty(w, 'CAKE'), 0); assert.equal(qty(w, 'FLR'), 10 - 4 - 3 + 2, 'materials of one cake came back (flour ' + qty(w, 'FLR') + ')');
  // ticked: the finished item goes back, the materials stay used
  const flr = qty(w, 'FLR'), sgr = qty(w, 'SGR');
  ret(b, 'CAKE', 'good'); box().checked = true; w.eval('updateReturnReusableRow()');
  assert.equal(w.eval('selectedReturnItem.reusableFinished'), true);
  w.eval('saveSimpleReturn()');
  assert.equal(qty(w, 'CAKE'), 1, 'the finished cake is back on the shelf');
  assert.equal(qty(w, 'FLR'), flr); assert.equal(qty(w, 'SGR'), sgr);
  assert.ok(J(w, "stockMovementLog.some(m => m.code === 'CAKE' && m.delta > 0)"), 'a movement for the finished item');
  // picking another item / resetting the form clears the tickbox
  w.eval('resetReturnForm()'); assert.equal(box().checked, false); assert.equal(row(), 'none');
  b.close();
});

// ---------------------------------------------------------------------------------------------------------- E: the refill log cap is no longer silent
test('E: when the 500-entry cap drops old refill entries the tank says so (refillLogTruncated, at least N); a re-merge does not inflate it; short logs have no field', async () => {
  const M = await load('_merge.js');
  const e = (i) => ({ id: 'r' + i, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), litersAdded: 1, cost: 0, supplier: 'S', servedBy: 'x' });
  const many = Array.from({ length: 520 }, (_, i) => e(i));
  const tank = (log, x = {}) => ({ id: 'tank-1', name: 'T', updatedAt: 1000, refillLog: log, ...x });
  const m1 = M.mergeRecordsById([tank(many.slice(0, 300))], [tank(many.slice(200), { updatedAt: 2000 })], false, 'tanks')[0];
  assert.equal(m1.refillLog.length, 500); assert.equal(m1.refillLogTruncated, 20);
  const m2 = M.mergeRecordsById([m1], [tank(many.slice(200), { updatedAt: 3000 })], false, 'tanks')[0];
  assert.equal(m2.refillLogTruncated, 20, 'merging again with the same data does not add up');
  const short = M.mergeRecordsById([tank([e(1)])], [tank([e(2)], { updatedAt: 2000 })], false, 'tanks')[0];
  assert.equal('refillLogTruncated' in short, false);
  assert.equal(M.mergeRefillLogs(tank(many), tank([]), 500).length, 500, 'the two-argument form still returns the array');
  // the client's pull merge follows the same rule
  const { boot } = await import('./helpers.mjs');
  const b = await boot('water/index.html', { storage: { aqua_biz_name: 'Aqua Test' } });
  const info = b.w.eval(`(() => { const i = {}; const l = mergeRefillLogs({ refillLog: ${JSON.stringify(many.slice(0, 300))} }, { refillLog: ${JSON.stringify(many.slice(200))} }, undefined, i); return JSON.stringify({ n: l.length, d: i.dropped }); })()`);
  assert.deepEqual(JSON.parse(info), { n: 500, d: 20 });
  b.close();
});
