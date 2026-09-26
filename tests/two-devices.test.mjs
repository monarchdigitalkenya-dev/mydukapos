import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// Two tills, one shop, real pos-sync server code. The classic ways sync loses money or stock.
const server = async () => {
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const req = (method, body) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
  return {
    push: async (device) => (await m.onRequestPost({ request: req('POST', { businessName: 'Biz', ...device }), env, waitUntil() {} })).json(),
    pull: async () => (await m.onRequestGet({ request: req('GET'), env })).json(),
  };
};
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('an edit on one device is not reverted by a stale device that never saw it', async () => {
  const s = await server();
  const t = Date.now();
  await s.push({ updatedAt: t, inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 5, updatedAt: t - 10000 }] });
  await wait();
  await s.push({ updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Bolt', price: 12, qty: 5, updatedAt: Date.now() }] });        // till 1 raises the price
  await wait();
  // till 2 was offline: still has the old price, but adds a NEW item and pushes later
  await s.push({ updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 5, updatedAt: t - 10000 }, { code: 'B', name: 'Nut', price: 3, qty: 9, updatedAt: Date.now() }] });
  const got = await s.pull();
  assert.equal(got.inventory.find((i) => i.code === 'A').price, 12, 'newer edit survives the stale push');
  assert.ok(got.inventory.find((i) => i.code === 'B'), 'the new item from the stale device is kept too');
});

test('two tills each sell one unit while offline — both sales come off (stock ledger, zip 118)', async () => {
  const s = await server();
  const t0 = Date.now();
  await s.push({ updatedAt: t0, inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 10, updatedAt: t0 - 1000 }], stockMovementLog: [] });
  await wait(20);
  const sale = (id) => ({ id, code: 'A', name: 'Bolt', delta: -1, type: 'removed', timestamp: new Date().toISOString(), reason: 'sale' });
  await s.push({ updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 9, updatedAt: Date.now() }], stockMovementLog: [sale('m1')] });
  await wait(20);
  // till 2 also started from qty 10 and sold one, never having seen till 1's sale
  await s.push({ updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 9, updatedAt: Date.now() }], stockMovementLog: [sale('m2')] });
  const got = await s.pull();
  assert.equal(got.stockMovementLog.length, 2, 'both sales are still in the movement log for the audit trail');
  assert.equal(got.inventory.find((i) => i.code === 'A').qty, 8, 'each movement is applied once: 10 - 1 - 1');
});

test('the same push arriving twice (a retry) does not double-count', async () => {
  const s = await server();
  const t0 = Date.now();
  await s.push({ updatedAt: t0, inventory: [{ code: 'A', name: 'Bolt', qty: 10, updatedAt: t0 - 1000 }], stockMovementLog: [] });
  await wait(20);
  const body = { updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Bolt', qty: 9, updatedAt: Date.now() }], stockMovementLog: [{ id: 'm1', code: 'A', delta: -1, timestamp: new Date().toISOString() }] };
  await s.push(body); await wait(10); await s.push(body); await wait(10); await s.push(body);
  const got = await s.pull();
  assert.equal(got.stockMovementLog.length, 1);
  assert.equal(got.inventory.find((i) => i.code === 'A').qty, 9);
});

test('a device with a badly wrong clock cannot overwrite a newer edit', async () => {
  const s = await server();
  const t = Date.now();
  await s.push({ updatedAt: t, inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 5, updatedAt: t }] });
  await wait(10);
  await s.push({ updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Bolt', price: 15, qty: 5, updatedAt: Date.now() }] });
  await wait(10);
  // this device's clock is 3 hours FAST: everything it stamps looks "newer", but its own push time reveals the skew
  const fast = 3 * 3600 * 1000;
  await s.push({ updatedAt: Date.now() + fast, inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 5, updatedAt: t + fast }] });
  const got = await s.pull();
  assert.equal(got.inventory.find((i) => i.code === 'A').price, 15);
});
