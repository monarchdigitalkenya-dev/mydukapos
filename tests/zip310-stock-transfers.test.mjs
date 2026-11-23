import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';

// zip 310: stock locations, internal moves, transfers between branches. The REAL org.js / _xfer-actions.js / _stock.js against the real shop
// databases (ShopStore on SQLite, the till's own stock ledger) and the transaction database (D1 fake on SQLite). Brief tests 17-24.
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);

async function business() {
  const kv = makeKV(), shop = await makeBinding();
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), SHOP_STORE: shop, LICENSE_CACHE_MS: '0', EDGE_CACHE_MS: '0' };
  const G = 'GRP1';
  const lic = (id, slug, extra) => { kv.data.set('license:' + id, { value: JSON.stringify({ id, type: 'permanent', slug, label: slug, branchGroupId: G, createdAt: 1, ...extra }) }); kv.data.set('slug:' + slug, { value: id }); kv.data.set('pos-data:mode:' + id, { value: 'do' }); };
  lic('M', 'main', { isMainBranch: true }); lic('B', 'westlands');
  kv.data.set('branch-group:' + G, { value: JSON.stringify(['M', 'B']) });
  kv.data.set('license-index:v1', { value: JSON.stringify([]) });
  const push = (id, body) => shop.get(id).fetch('https://shop-store/push', { method: 'POST', body: JSON.stringify({ body, serverNow: Date.now(), _shop: id }) });
  await push('M', { businessName: 'Biz', adminPwHash: sha('ownerpass'), pwHash: sha('ownerpass'), staff: [
    { id: 's-otis', name: 'Otis', pinHash: sha('2222'), roles: ['inventory-tab'], isManager: true, updatedAt: 1 },
    { id: 's-amy', name: 'Amy', pinHash: sha('4444'), roles: ['inventory-tab'], isManager: true, updatedAt: 1 }],
    inventory: [{ code: 'SUG', name: 'Sugar 1kg', unit: 'pcs', qty: 100, price: 200, wholesalePrice: 150, updatedAt: 1 }, { code: 'OIL', name: 'Oil 1L', unit: 'pcs', qty: 10, price: 400, wholesalePrice: 320, updatedAt: 1 }] });
  await push('B', { businessName: 'Westlands', staff: [], inventory: [] });
  const org = await load('org.js');
  const call = async (slug, body, token) => {
    const res = await org.onRequestPost({ request: new Request(`https://${slug}.mydukapos.store/api/org`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'X-HQ-Token': token } : {}) }, body: JSON.stringify(body) }), env, waitUntil() {} });
    return { status: res.status, ...(await res.json()) };
  };
  const state = async (id) => JSON.parse(await (await shop.get(id).fetch('https://shop-store/export', { method: 'POST', body: '{}' })).text());
  const floor = async (id, code) => { const i = ((await state(id)).inventory || []).find((x) => String(x.code) === code); return i ? Number(i.qty) : null; };
  const owner = (await call('main', { action: 'login', proof: sha('ownerpass') })).token;
  const O = (body) => call('main', body, owner);
  return { env, kv, shop, call, state, floor, owner, O, push };
}
const locQty = async (b, clientId, locId, code) => ((await b.O({ action: 'inv.stock', clientId, locId })).items.find((i) => i.code === code) || { qty: 0 }).qty;

test('locations: a main store per branch, no duplicates, "Shop floor" is reserved; opening stock needs a reason', { skip: !hasSqlite }, async () => {
  const b = await business();
  const r = await b.O({ action: 'inv.location.create', clientId: 'M', name: 'Main store', kind: 'store' });
  assert.equal(r.ok, true);
  assert.equal((await b.O({ action: 'inv.location.create', clientId: 'M', name: 'main STORE' })).status, 400);
  assert.equal((await b.O({ action: 'inv.location.create', clientId: 'M', name: 'Shop floor' })).status, 400);
  assert.equal((await b.O({ action: 'inv.location.create', clientId: 'B', name: 'Main store' })).ok, true, 'another branch may use the same name');
  const L = r.location.location_id;
  assert.equal((await b.O({ action: 'inv.receive', clientId: 'M', locId: L, lines: [{ code: 'SUG', qty: 50 }] })).status, 400, 'reason required');
  assert.equal((await b.O({ action: 'inv.receive', clientId: 'M', locId: L, key: 'open1', reason: 'opening balance', lines: [{ code: 'SUG', qty: 50 }] })).ok, true);
  assert.equal((await b.O({ action: 'inv.receive', clientId: 'M', locId: L, key: 'open1', reason: 'opening balance', lines: [{ code: 'SUG', qty: 50 }] })).repeated, true, 'the same receipt twice counts once');
  assert.equal(await locQty(b, 'M', L, 'SUG'), 50);
  assert.equal((await b.O({ action: 'inv.adjust', clientId: 'M', locId: L, key: 'count1', reason: 'monthly count', lines: [{ code: 'SUG', qty: 48 }] })).ok, true);
  assert.equal(await locQty(b, 'M', L, 'SUG'), 48, 'a count sets the quantity (a -2 movement)');
  const mv = (await b.O({ action: 'inv.movements', clientId: 'M' })).movements.filter((m) => m.location_id === L).map((m) => m.qty).sort();
  assert.deepEqual(mv, [-2, 50]);
});

test('17-19: store -> floor reduces the store and raises the floor; a reversal restores both; the branch total never changes', { skip: !hasSqlite }, async () => {
  const b = await business();
  const L = (await b.O({ action: 'inv.location.create', clientId: 'M', name: 'Main store' })).location.location_id;
  await b.O({ action: 'inv.receive', clientId: 'M', locId: L, key: 'o', reason: 'opening', lines: [{ code: 'SUG', qty: 40 }] });
  const total = async () => (await b.floor('M', 'SUG')) + (await locQty(b, 'M', L, 'SUG'));
  const before = await total();
  const m = await b.O({ action: 'inv.move', clientId: 'M', fromLoc: L, toLoc: 'floor', lines: [{ code: 'SUG', qty: 15 }], notes: 'restock shelves' });
  assert.equal(m.ok, true); assert.equal(m.status, 'completed'); assert.match(m.ref, /^MV-\d{5}$/);
  assert.equal(await locQty(b, 'M', L, 'SUG'), 25, 'store reduced');
  assert.equal(await b.floor('M', 'SUG'), 115, 'floor increased (through the till\'s own stock ledger)');
  assert.equal(await total(), before, 'branch total unchanged');
  // floor -> store
  assert.equal((await b.O({ action: 'inv.move', clientId: 'M', fromLoc: 'floor', toLoc: L, lines: [{ code: 'SUG', qty: 5 }] })).ok, true);
  assert.equal(await b.floor('M', 'SUG'), 110); assert.equal(await locQty(b, 'M', L, 'SUG'), 30); assert.equal(await total(), before);
  // more than the store has: refused, nothing moved
  const over = await b.O({ action: 'inv.move', clientId: 'M', fromLoc: L, toLoc: 'floor', lines: [{ code: 'SUG', qty: 31 }] });
  assert.equal(over.status, 409); assert.equal(await locQty(b, 'M', L, 'SUG'), 30);
  // reversal of the first move: a NEW move the other way; the original stays
  const rev = await b.O({ action: 'xfer.reverse', xferId: m.xferId, reason: 'wrong item' });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  assert.equal(await locQty(b, 'M', L, 'SUG'), 45); assert.equal(await b.floor('M', 'SUG'), 95); assert.equal(await total(), before);
  assert.equal((await b.O({ action: 'xfer.reverse', xferId: m.xferId })).status, 409, 'reversed once only');
  const orig = await b.O({ action: 'xfer.get', xferId: m.xferId });
  assert.equal(orig.transfer.status, 'completed'); assert.ok(orig.events.some((e) => e.action === 'reversed'), 'history kept');
  const back = await b.O({ action: 'xfer.get', xferId: rev.xferId });
  assert.equal(back.transfer.reverses, m.xferId);
  // a move never creates a sale or a purchase
  const st = await b.state('M');
  assert.equal((st.sales || []).length, 0); assert.equal((st.purchases || st.purchaseOrders || []).length, 0);
});

test('20-22: transfer between branches - approval, dispatch puts stock in transit, partial receipt with damaged / missing, resolution', { skip: !hasSqlite }, async () => {
  const b = await business();
  await b.O({ action: 'inv.settings', save: { approval_mode: 'always' } });     // zip 311: approvals are off by default; this test turns them on
  const c = await b.O({ action: 'xfer.create', fromClient: 'M', fromLoc: 'floor', toClient: 'B', toLoc: 'floor', lines: [{ code: 'SUG', qty: 20 }, { code: 'OIL', qty: 4 }], notes: 'weekly' });
  assert.equal(c.ok, true); assert.equal(c.status, 'pending'); assert.match(c.ref, /^TR-\d{5}$/);
  assert.equal((await b.O({ action: 'xfer.dispatch', xferId: c.xferId })).status, 409, 'not before approval');
  assert.equal((await b.O({ action: 'xfer.approve', xferId: c.xferId })).ok, true);
  const d = await b.O({ action: 'xfer.dispatch', xferId: c.xferId });
  assert.equal(d.ok, true); assert.equal(d.status, 'in_transit');
  assert.equal(await b.floor('M', 'SUG'), 80, 'left the source at dispatch');
  assert.equal(await b.floor('B', 'SUG'), null, 'not yet at the destination');
  assert.equal((await b.O({ action: 'xfer.dispatch', xferId: c.xferId })).status, 409, 'a second dispatch takes nothing');
  assert.equal(await b.floor('M', 'SUG'), 80);
  let g = await b.O({ action: 'xfer.get', xferId: c.xferId });
  const [lOil, lSug] = [g.lines.find((l) => l.code === 'OIL'), g.lines.find((l) => l.code === 'SUG')];
  assert.equal(lSug.in_transit, 20);
  // first receipt: 15 sugar good, 1 damaged; oil all good
  const r1 = await b.O({ action: 'xfer.receive', xferId: c.xferId, receiptId: 'r1', lines: [{ lineId: lSug.line_id, received: 15, damaged: 1 }, { lineId: lOil.line_id, received: 4 }] });
  assert.equal(r1.ok, true); assert.equal(r1.status, 'partial');
  assert.equal(await b.floor('B', 'SUG'), 15, 'only received stock reaches the destination'); assert.equal(await b.floor('B', 'OIL'), 4);
  const again = await b.O({ action: 'xfer.receive', xferId: c.xferId, receiptId: 'r1', lines: [{ lineId: lSug.line_id, received: 15, damaged: 1 }] });
  assert.equal(again.repeated, true); assert.equal(await b.floor('B', 'SUG'), 15, 'the same receipt twice adds nothing');
  assert.equal((await b.O({ action: 'xfer.receive', xferId: c.xferId, receiptId: 'r2', lines: [{ lineId: lSug.line_id, received: 5 }] })).status, 400, 'cannot receive more than is on the way (4)');
  const r2 = await b.O({ action: 'xfer.receive', xferId: c.xferId, receiptId: 'r2', lines: [{ lineId: lSug.line_id, received: 3, missing: 1 }] });
  assert.equal(r2.status, 'discrepancy');
  g = await b.O({ action: 'xfer.get', xferId: c.xferId });
  const s2 = g.lines.find((l) => l.code === 'SUG');
  assert.deepEqual([s2.qty_disp, s2.qty_recv, s2.qty_damaged, s2.qty_missing, s2.in_transit], [20, 18, 1, 1, 0], 'dispatched = received + damaged + missing');
  // resolve: needs a note; found at destination adds there, write off adds nowhere
  assert.equal((await b.O({ action: 'xfer.resolve', xferId: c.xferId, lines: [{ lineId: s2.line_id, resolution: 'write_off' }] })).status, 400);
  const res = await b.O({ action: 'xfer.resolve', xferId: c.xferId, lines: [{ lineId: s2.line_id, resolution: 'found_at_destination', note: 'counted again, both found in the back' }] });
  assert.equal(res.status, 'completed');
  assert.equal(await b.floor('B', 'SUG'), 20);
  assert.equal((await b.floor('M', 'SUG')) + (await b.floor('B', 'SUG')), 100, 'stock in the business is conserved');
  g = await b.O({ action: 'xfer.get', xferId: c.xferId });
  for (const e of ['created', 'approved', 'dispatched', 'received', 'resolved', 'completed']) assert.ok(g.events.some((x) => x.action === e), e);
  assert.equal((await b.O({ action: 'xfer.cancel', xferId: c.xferId, reason: 'x' })).status, 409, 'a closed transfer cannot be changed');
  const list = (await b.O({ action: 'xfer.list', status: 'completed' })).transfers;
  assert.equal(list.length, 1);
});

test('23: duplicate and concurrent requests never double stock; concurrent dispatch cannot oversell', { skip: !hasSqlite }, async () => {
  const b = await business();
  await b.O({ action: 'inv.settings', save: { approval_mode: 'never' } });
  // two transfers of 8 oil each, only 10 on the shelf: both created (each fits), only one can be dispatched
  const t1 = await b.O({ action: 'xfer.create', fromClient: 'M', toClient: 'B', lines: [{ code: 'OIL', qty: 8 }] });
  const t2 = await b.O({ action: 'xfer.create', fromClient: 'M', toClient: 'B', lines: [{ code: 'OIL', qty: 8 }] });
  assert.equal(t1.status, 'approved'); assert.equal(t2.status, 'approved');
  const [d1, d2, d1b] = await Promise.all([b.O({ action: 'xfer.dispatch', xferId: t1.xferId }), b.O({ action: 'xfer.dispatch', xferId: t2.xferId }), b.O({ action: 'xfer.dispatch', xferId: t1.xferId })]);
  const okCount = [d1, d2, d1b].filter((x) => x.ok).length;
  assert.equal(okCount, 1, 'exactly one dispatch went through: ' + JSON.stringify([d1, d2, d1b].map((x) => x.status + ':' + (x.error || x.ok))));
  assert.equal(await b.floor('M', 'OIL'), 2, 'never below zero, never taken twice');
  const loser = d2.ok ? t1 : t2;
  assert.equal((await b.O({ action: 'xfer.get', xferId: loser.xferId })).transfer.status, 'approved', 'the refused one waits (can be cancelled or dispatched after a restock)');
  // concurrent receipts with the same id
  const winner = d2.ok ? t2 : t1;
  const ln = (await b.O({ action: 'xfer.get', xferId: winner.xferId })).lines[0];
  const rs = await Promise.all([1, 2, 3].map(() => b.O({ action: 'xfer.receive', xferId: winner.xferId, receiptId: 'same', lines: [{ lineId: ln.line_id, received: 8 }] })));
  assert.ok(rs.every((r) => r.ok), JSON.stringify(rs));
  assert.equal(await b.floor('B', 'OIL'), 8, 'added once');
  assert.equal((await b.O({ action: 'xfer.get', xferId: winner.xferId })).transfer.status, 'completed');
  // a sale at the source between create and dispatch: the dispatch re-checks inside the branch database
  const t3 = await b.O({ action: 'xfer.create', fromClient: 'M', toClient: 'B', lines: [{ code: 'OIL', qty: 2 }] });
  await b.push('M', { stockMovementLog: [{ id: 'sale-mv-1', code: 'OIL', delta: -1, type: 'removed', reason: 'sale', timestamp: new Date().toISOString() }] });
  const d3 = await b.O({ action: 'xfer.dispatch', xferId: t3.xferId });
  assert.equal(d3.status, 409); assert.equal(d3.code, 'short'); assert.equal(await b.floor('M', 'OIL'), 1);
});

test('24 + security: independent approval, scope, permissions, reject needs a reason, only the owner sets the rules', { skip: !hasSqlite }, async () => {
  const b = await business();
  await b.O({ action: 'inv.settings', save: { approval_mode: 'always' } });
  // Otis: inventory + approvals over Main only; Amy: inventory over Westlands only
  assert.equal((await b.O({ action: 'admin.save', personId: 's-otis', homeClientId: 'M', perms: ['inventory.manage', 'transfers.approve'], branches: ['M'] })).ok, true);
  assert.equal((await b.O({ action: 'admin.save', personId: 's-amy', homeClientId: 'M', perms: ['inventory.manage'], branches: ['B'] })).ok, true);
  const otis = (await b.call('main', { action: 'login', personId: 's-otis', proof: sha('2222') })).token;
  const amy = (await b.call('main', { action: 'login', personId: 's-amy', proof: sha('4444') })).token;
  assert.ok(otis && amy);
  const c = await b.call('main', { action: 'xfer.create', fromClient: 'M', toClient: 'B', lines: [{ code: 'SUG', qty: 5 }] }, otis);
  assert.equal(c.ok, true);
  const self = await b.call('main', { action: 'xfer.approve', xferId: c.xferId }, otis);
  assert.equal(self.status, 403, 'cannot approve own request'); assert.match(self.error, /someone else/);
  assert.equal((await b.call('main', { action: 'xfer.approve', xferId: c.xferId }, amy)).status, 403, 'no approval permission');
  assert.equal((await b.call('main', { action: 'xfer.reject', xferId: c.xferId }, b.owner)).status, 400, 'reason needed');
  assert.equal((await b.O({ action: 'xfer.approve', xferId: c.xferId })).ok, true, 'the owner may approve');
  assert.equal((await b.call('main', { action: 'xfer.dispatch', xferId: c.xferId }, amy)).status, 403, 'Amy does not manage the source');
  assert.equal((await b.call('main', { action: 'xfer.dispatch', xferId: c.xferId }, otis)).ok, true);
  const ln = (await b.O({ action: 'xfer.get', xferId: c.xferId })).lines[0];
  assert.equal((await b.call('main', { action: 'xfer.receive', xferId: c.xferId, receiptId: 'x', lines: [{ lineId: ln.line_id, received: 5 }] }, otis)).status, 403, 'Otis does not manage the destination');
  assert.equal((await b.call('main', { action: 'xfer.receive', xferId: c.xferId, receiptId: 'x', lines: [{ lineId: ln.line_id, received: 5 }] }, amy)).ok, true);
  assert.equal((await b.call('main', { action: 'inv.location.create', clientId: 'M', name: 'Hidden' }, amy)).status, 403, 'out of scope');
  assert.equal((await b.call('main', { action: 'inv.settings', save: { approval_mode: 'never' } }, otis)).status, 403);
  const audit = (await b.O({ action: 'audit.list' })).audit.map((a) => a.action);
  for (const x of ['transfer.create', 'transfer.approve']) assert.ok(audit.includes(x), x);
});

test('a store item reaching another branch\'s shop floor keeps its selling price; a dispatch that broke off is finished once', { skip: !hasSqlite }, async () => {
  const b = await business();
  await b.O({ action: 'inv.settings', save: { approval_mode: 'never' } });
  const L = (await b.O({ action: 'inv.location.create', clientId: 'M', name: 'Main store' })).location.location_id;
  await b.O({ action: 'inv.receive', clientId: 'M', locId: L, key: 'o', reason: 'opening', lines: [{ code: 'OIL', qty: 30 }] });
  const t = await b.O({ action: 'xfer.create', fromClient: 'M', fromLoc: L, toClient: 'B', toLoc: 'floor', lines: [{ code: 'OIL', qty: 6 }] });
  // simulate a dispatch cut off after the claim: status 'dispatching', nothing taken yet
  await b.env.LEDGER_DB.prepare("UPDATE xfer SET status = 'dispatching' WHERE xfer_id = ?").bind(t.xferId).run();
  const d = await b.O({ action: 'xfer.dispatch', xferId: t.xferId });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(await locQty(b, 'M', L, 'OIL'), 24);
  const ln = (await b.O({ action: 'xfer.get', xferId: t.xferId })).lines[0];
  await b.O({ action: 'xfer.receive', xferId: t.xferId, receiptId: 'a', lines: [{ lineId: ln.line_id, received: 6 }] });
  const item = ((await b.state('B')).inventory || []).find((i) => i.code === 'OIL');
  assert.equal(Number(item.qty), 6); assert.equal(Number(item.price), 400, 'priced like the source till, not 0');
  assert.equal((await b.O({ action: 'inv.adjust', clientId: 'M', locId: L, key: 'c', reason: 'count', lines: [{ code: 'OIL', qty: 24 }] })).ok, true, 'a count equal to the current quantity is fine');
});

test('migration 0016 is exactly what the server creates by itself', async () => {
  const fs = await import('node:fs');
  const { STOCK_SQL } = await load('_stock.js');
  const { ROLE_SQL_TEXT } = await load('_hq-reports.js');
  const mig = fs.readFileSync(path.join(ROOT, 'migrations/0016_stock.sql'), 'utf8');
  assert.ok(mig.includes(STOCK_SQL) && mig.includes(ROLE_SQL_TEXT), 'regenerate migrations/0016_stock.sql from STOCK_SQL + ROLE_SQL_TEXT');
});

test('zip 311 simple mode: no approval by default, Send goes out at once, one list per branch with a Main store made for it', { skip: !hasSqlite }, async () => {
  const b = await business();
  const it = await b.O({ action: 'inv.items', clientId: 'M' });
  assert.equal(it.ok, true); assert.deepEqual(it.locations.map((l) => l.name), ['Main store'], 'a Main store is there without setting it up');
  const sug = it.items.find((i) => i.code === 'SUG');
  assert.equal(sug.floor, 100); assert.deepEqual(sug.at, {});
  const L = it.locations[0].location_id;
  await b.O({ action: 'inv.receive', clientId: 'M', locId: L, key: 'k1', reason: 'Delivery to store', lines: [{ code: 'SUG', qty: 12 }] });
  assert.equal((await b.O({ action: 'inv.items', clientId: 'M' })).items.find((i) => i.code === 'SUG').at[L], 12);
  assert.equal((await b.O({ action: 'inv.items', clientId: 'M' })).locations.length, 1, 'made once');
  const s = await b.O({ action: 'xfer.create', send: true, fromClient: 'M', fromLoc: 'floor', toClient: 'B', toLoc: 'floor', lines: [{ code: 'SUG', qty: 7 }] });
  assert.equal(s.ok, true); assert.equal(s.status, 'in_transit', 'sent at once');
  assert.equal(await b.floor('M', 'SUG'), 93);
  const short = await b.O({ action: 'xfer.create', send: true, fromClient: 'M', fromLoc: 'floor', toClient: 'B', lines: [{ code: 'OIL', qty: 11 }] });
  assert.equal(short.status, 409, 'more than there is: refused before anything moves');
  const ln = (await b.O({ action: 'xfer.get', xferId: s.xferId })).lines[0];
  assert.equal((await b.O({ action: 'xfer.receive', xferId: s.xferId, receiptId: 'z', lines: [{ lineId: ln.line_id, received: 7 }] })).status, 'completed');
  assert.equal(await b.floor('B', 'SUG'), 7);
});
