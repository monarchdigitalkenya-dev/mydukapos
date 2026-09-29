import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// zip 156 (server) — archived history:
//   DEFECT 4   a NEWER edit of an archived record (an old credit sale being paid) was dropped with a 200 "ok": the till believed it was saved
//   DEFECT 10  an archived movement re-sent by a device whose clock is a few minutes slow was "corrected" into looking new, so it got past the
//              archive check and was applied to the stock a second time — the check must look at the raw times, before any clock correction
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const sync = await load('functions/api/pos-sync.js');
const ss = await load('functions/api/_state-store.js');
const DAY = 86400000;
const STATE = 'pos-data:state:C1';
const newEnv = (extra = {}) => { const kv = makeKV(); seedShop(kv, 'C1'); return { kv, env: { mydukapos_kv: kv, ...extra } }; };
const req = (m, b) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
const post = (env, b) => sync.onRequestPost({ request: req('POST', b), env, waitUntil() {} });
const live = (kv) => JSON.parse(kv.data.get(STATE).value);
const archivedCopies = async (kv, id) => {
  const out = [];
  for (const k of [...kv.data.keys()].filter((x) => x.startsWith('pos-data:archive:C1:'))) {
    const a = JSON.parse(await ss.decodeStateText(kv.data.get(k).value));
    for (const s of a.fields.salesLog || []) if (s.id === id) out.push(s);
  }
  return out;
};

// a shop with 60 sales, 40 of them old credit sales, that has archived itself
async function archivedShop() {
  const { kv, env } = newEnv({ SYNC_MAX_BYTES: '14000', SYNC_AUTO_COMPRESS_BYTES: 'off' });
  const now = Date.now();
  const mk = (i, ageDays) => ({ id: 'S' + i, timestamp: new Date(now - ageDays * DAY).toISOString(), items: [{ code: 'A', name: 'x'.repeat(40), price: 100, qty: 1 }], paid: false, customerName: 'Credit cust', updatedAt: now - ageDays * DAY });
  const sales = []; for (let i = 0; i < 60; i++) sales.push(mk(i, i < 40 ? 200 : 1));
  assert.equal((await post(env, { businessName: 'B', salesLog: sales, updatedAt: Date.now() })).status, 200);
  assert.equal((await post(env, { businessName: 'B', salesLog: [mk(100, 0)], updatedAt: Date.now() })).status, 200);
  const st = live(kv);
  assert.ok(st._archiveCutoff, 'the shop archived its old history');
  assert.equal(st.salesLog.some((x) => x.id === 'S0'), false, 'S0 (an old credit sale) is in the archive, not live');
  return { kv, env, mk, now };
}

test('DEFECT 4: paying an old credit sale that was archived is stored (not dropped with a 200); an old re-sent copy is still dropped', async () => {
  const { kv, env, mk } = await archivedShop();
  // an OLD copy of S0 (a device that never pulled the archive) is re-sent: dropped, as before
  let r = await post(env, { businessName: 'B', salesLog: [mk(0, 200)], updatedAt: Date.now() });
  assert.equal(r.status, 200);
  assert.equal(live(kv).salesLog.some((x) => x.id === 'S0'), false, 'the old copy did not come back');
  // the customer pays: a NEWER edit of the same sale
  const settled = { ...mk(0, 200), paid: true, amountPaid: 100, paidAt: Date.now(), updatedAt: Date.now() };
  r = await post(env, { businessName: 'B', salesLog: [settled], updatedAt: Date.now() });
  assert.equal(r.status, 200);
  const s0 = live(kv).salesLog.find((x) => x.id === 'S0');
  assert.ok(s0, 'the payment is stored on the server');
  assert.equal(s0.paid, true); assert.equal(s0.amountPaid, 100);
  // a stale copy of it (unpaid) arriving afterwards cannot undo it
  await post(env, { businessName: 'B', salesLog: [mk(0, 200)], updatedAt: Date.now() });
  assert.equal(live(kv).salesLog.find((x) => x.id === 'S0').paid, true, 'the payment stays');
  // another old archived sale that nobody edited is still not brought back by a stale device
  await post(env, { businessName: 'B', salesLog: [mk(1, 200)], updatedAt: Date.now() });
  assert.equal(live(kv).salesLog.some((x) => x.id === 'S1'), false, 'other archived sales stay archived');
  assert.ok((await archivedCopies(kv, 'S0')).length >= 1, 'the archive itself is untouched');
});

test('DEFECT 4: the edit is stored even when the device clock is a few minutes slow (its times are corrected before the "is it newer than the archive" check)', async () => {
  const { kv, env, mk } = await archivedShop();
  const slow = -400000;                                       // this till's clock is ~7 min behind
  const settled = { ...mk(2, 200), paid: true, amountPaid: 100, paidAt: Date.now() + slow, updatedAt: Date.now() + slow };
  const r = await post(env, { businessName: 'B', salesLog: [settled], updatedAt: Date.now() + slow });
  assert.equal(r.status, 200);
  const s = live(kv).salesLog.find((x) => x.id === 'S2');
  assert.ok(s && s.paid === true, 'stored');
});

test('DEFECT 10: an ARCHIVED movement re-sent by a device whose clock is 5 minutes slow is dropped, and stock is not changed twice', async () => {
  const { kv, env } = newEnv();
  const now = Date.now(), cutoff = now - 90 * DAY;
  const M = { id: 'M1', code: 'A', delta: -5, kind: 'sale', timestamp: new Date(cutoff - 30000).toISOString() };
  await post(env, { businessName: 'B', inventory: [{ code: 'A', name: 'a', qty: 95, updatedAt: 1 }], updatedAt: Date.now() });     // M1 was applied long ago (95)
  const st = live(kv); st._archiveCutoff = cutoff; kv.data.get(STATE).value = JSON.stringify(st);
  await ss.addToArchiveIndex(env, 'C1', { stockMovementLog: [M] });
  const slow = Date.now() - 300000;
  const r = await post(env, { stockMovementLog: [M], inventory: [{ code: 'A', name: 'a', qty: 95, updatedAt: 1 }], updatedAt: slow });
  assert.equal(r.status, 200);
  const s2 = live(kv);
  assert.equal(s2.inventory[0].qty, 95, 'stock unchanged');
  assert.equal((s2.stockMovementLog || []).length, 0, 'the archived movement did not come back');
});
