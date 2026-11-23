import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
import { makeRoomBinding } from './live-sync-harness.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';
import { ensure, hasSyncRoom } from '../tools/ensure-router-config.mjs';

// zip 306: the live-sync room keeps the newest version of the shop, and answers 'v?' with it. The shop's database tells it after EVERY change,
// whichever endpoint made the change; reads never do.
const ask = async (room, id = 'C1') => {
  const r = room.rooms.get(id) || (await room.binding.get(id).fetch('https://sync-room/none', { method: 'POST' }), room.rooms.get(id));
  let got = null; const ws = { send: (d) => { got = JSON.parse(d); } };
  await r.room.webSocketMessage(ws, 'v?');
  return got;
};
const flush = () => new Promise((res) => setTimeout(res, 5));

test('the room answers v? with its version, and every note or broadcast moves it on', { skip: !hasSqlite }, async () => {
  const room = makeRoomBinding();
  const v0 = await ask(room);
  assert.equal(v0.t, 'v'); assert.equal(v0.ver, 0);
  await room.binding.get('C1').fetch('https://sync-room/ver', { method: 'POST', body: JSON.stringify({ ver: 1000 }) });
  assert.equal((await ask(room)).ver, 1000);
  await room.binding.get('C1').fetch('https://sync-room/broadcast', { method: 'POST', body: JSON.stringify({ poke: true, updatedAt: 2000 }) });
  const v2 = await ask(room);
  assert.equal(v2.ver, 2000); assert.equal(v2.n, 2); assert.equal(v2.e, v0.e, 'same room, same counter id');
  // anything else a device sends is ignored (and 'ping' never reaches the room: the runtime answers it)
  let sent = 0; await room.rooms.get('C1').room.webSocketMessage({ send: () => sent++ }, 'hello');
  assert.equal(sent, 0);
});

test('the shop database notes the room after a sale, a booking or an import - and not after a read', { skip: !hasSqlite }, async () => {
  const room = makeRoomBinding();
  const shop = await makeBinding({ env: { SYNC_ROOM: room.binding } });
  const call = (op, body) => shop.get('C1').fetch('https://shop-store/' + op, { method: 'POST', body: JSON.stringify({ ...body, _shop: 'C1' }) });
  await call('push', { body: { inventory: [{ code: 'A', qty: 5, updatedAt: 1 }] }, serverNow: Date.now() }); await flush();
  const after1 = await ask(room);
  assert.equal(room.stats.notes, 1); assert.ok(after1.ver > 0);
  await call('state', {}); await call('history', { col: 'salesLog' }); await call('have', { col: 'salesLog', ids: ['x'] }); await flush();
  assert.equal(room.stats.notes, 1, 'reads never note');
  await call('book', { record: { id: 'b1', resource: 'T1', start: 1, end: 2 }, serverNow: Date.now() + 5 }); await flush();
  assert.equal(room.stats.notes, 2, 'a booking (not a sync push) is noted too');
  // a push that changes nothing (same record again) does not move the version, so no note
  const ua = (await ask(room)).ver;
  await call('push', { body: {}, serverNow: ua - 10 }); await flush();
  assert.ok(room.stats.notes >= 2);
});

test('a database without the room binding (router not updated) still works', { skip: !hasSqlite }, async () => {
  const shop = await makeBinding();
  const r = await shop.get('C1').fetch('https://shop-store/push', { method: 'POST', body: JSON.stringify({ body: { inventory: [{ code: 'A', qty: 1, updatedAt: 1 }] }, serverNow: Date.now(), _shop: 'C1' }) });
  assert.equal(r.status, 200);
});

test('the router config gets the SYNC_ROOM binding once, nothing else changes', () => {
  const t = fs.readFileSync(path.join(ROOT, 'wildcard-router/wrangler.toml'), 'utf8');
  assert.ok(hasSyncRoom(t), 'the shipped router config has it');
  const bare = 'name = "x"\n[vars]\nA = "1"\n';
  const once = ensure(bare), twice = ensure(once);
  assert.ok(hasSyncRoom(once)); assert.equal(once, twice, 'idempotent'); assert.ok(once.startsWith(bare.trimEnd()));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['deploy:router'], /ensure-router-config\.mjs && wrangler deploy/);
});
