import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, boot, until } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// zip 158 item 3 - loyalty tokens (customer.tokens) were last-write-wins: two tills awarding the same customer at once ended at +1, and a stale
// copy could lower the balance. Each device now raises only its own entry of `tokenLedger`; the balance is base + every entry.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const sync = await load('functions/api/pos-sync.js');
const merge = await load('functions/api/_merge.js');
const req = (m, b) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
const newEnv = () => { const kv = makeKV(); seedShop(kv, 'C1'); return { kv, env: { mydukapos_kv: kv } }; };
const post = (env, b) => sync.onRequestPost({ request: req('POST', b), env, waitUntil() {} });
const live = (kv) => JSON.parse(kv.data.get('pos-data:state:C1').value);
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");

test('server: two tills each award tokens to the same customer from the same starting balance - both awards count, in any order, and twice changes nothing', async () => {
  const { kv, env } = newEnv();
  const start = { id: 'c1', name: 'Amina', phone: '254700000001', tokens: 5, createdAt: 1, updatedAt: 100 };
  await post(env, { businessName: 'B', customers: [start], updatedAt: Date.now() });
  const tillA = { ...start, tokenBase: 5, tokenLedger: { A: 1 }, tokens: 6, updatedAt: 200 };
  const tillB = { ...start, tokenBase: 5, tokenLedger: { B: 2 }, tokens: 7, updatedAt: 300 };
  await post(env, { businessName: 'B', customers: [tillA], updatedAt: Date.now() });
  await post(env, { businessName: 'B', customers: [tillB], updatedAt: Date.now() });
  assert.equal(live(kv).customers[0].tokens, 8, '5 + 1 + 2 (was 7: the last write won)');
  await post(env, { businessName: 'B', customers: [tillA], updatedAt: Date.now() });                // a stale copy arrives late
  await post(env, { businessName: 'B', customers: [tillB], updatedAt: Date.now() });                // and one arrives twice
  const c = live(kv).customers[0];
  assert.equal(c.tokens, 8); assert.deepEqual(c.tokenLedger, { A: 1, B: 2 }); assert.equal(c.tokenBase, 5);
  // the other fields still follow the newest copy
  await post(env, { businessName: 'B', customers: [{ ...tillA, name: 'Amina K', updatedAt: 999 }], updatedAt: Date.now() });
  assert.equal(live(kv).customers[0].name, 'Amina K'); assert.equal(live(kv).customers[0].tokens, 8);
});

test('mergeLoyaltyFields: the same answer in any order, idempotent, never below either side; a copy without a ledger (older release) is honoured', () => {
  const mk = (l, base = 10) => ({ tokenBase: base, tokenLedger: l, tokens: base + Object.values(l).reduce((a, b) => a + b, 0) });
  const a = mk({ A: 3 }), b = mk({ A: 1, B: 4 }), c = mk({ C: 2 });
  const ab = merge.mergeLoyaltyFields(a, b);
  assert.equal(ab.tokens, 10 + 3 + 4); assert.deepEqual(ab.tokenLedger, { A: 3, B: 4 });
  assert.deepEqual(merge.mergeLoyaltyFields(b, a), ab, 'order does not matter');
  assert.deepEqual(merge.mergeLoyaltyFields({ ...ab }, a), ab, 'merging again changes nothing');
  const abc = merge.mergeLoyaltyFields(ab, c), acb = merge.mergeLoyaltyFields(merge.mergeLoyaltyFields(a, c), b);
  assert.deepEqual(abc, acb, 'associative');
  // an older release still adds to `tokens` itself: 13 known here, it says 15 -> two more were awarded there
  const legacy = { tokens: 15 };
  const withLegacy = merge.mergeLoyaltyFields(a, legacy);
  assert.equal(withLegacy.tokens, 15); assert.equal(merge.mergeLoyaltyFields(withLegacy, legacy).tokens, 15, 'not counted twice');
  assert.equal(merge.mergeLoyaltyFields(a, { tokens: 4 }).tokens, 13, 'a stale legacy copy is just older');
  // no ledger anywhere: the larger balance wins (a stale copy never lowers it); nothing to merge when neither has tokens
  assert.equal(merge.mergeLoyaltyFields({ tokens: 3 }, { tokens: 9 }).tokens, 9);
  assert.equal(merge.mergeLoyaltyFields({ name: 'x' }, { name: 'y' }), null);
});

test('the device and the server compute the same merge (property check, 300 random pairs)', async () => {
  const { w, close } = await boot('index.html', { wait: 200 });
  let seed = 7; const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const rec = () => {
    if (r() < 0.25) return r() < 0.2 ? { name: 'n' } : { tokens: Math.floor(r() * 20) };
    const led = {}; ['A', 'B', 'C'].forEach((d) => { if (r() < 0.6) led[d] = 1 + Math.floor(r() * 5); });
    const base = Math.floor(r() * 10); return { tokenBase: base, tokenLedger: led, tokens: base + Object.values(led).reduce((x, y) => x + y, 0) };
  };
  for (let i = 0; i < 300; i++) {
    const a = rec(), b = rec();
    const dev = JSON.parse(w.eval(`JSON.stringify(mergeLoyaltyFields(${JSON.stringify(a)}, ${JSON.stringify(b)}))`));
    assert.deepEqual(dev, merge.mergeLoyaltyFields(a, b), JSON.stringify([a, b]));
    const m = merge.mergeLoyaltyFields(a, b);
    if (m) for (const x of [a, b]) assert.ok(m.tokens >= (x.tokens || 0) - 0, 'never below either side');
  }
  close();
});

test('device: awarding raises this device\'s own entry, keeps `tokens` as the total, and works for a customer that has plain tokens already', async () => {
  const { w, close } = await boot('index.html', { wait: 300, storage: { pos_loyalty_enabled: 'true', pos_loyalty_tiers: JSON.stringify([{ id: 't', minSpend: 0, maxSpend: null, tokens: 2 }]), pos_customers: JSON.stringify([{ id: 'c1', name: 'Amina', phone: '254700000001', tokens: 5, createdAt: 1 }]) } });
  quiet(w);
  w.eval("awardTokensForSale('254700000001', 100)"); w.eval("awardTokensForSale('254700000001', 100)");
  const c = JSON.parse(w.eval("JSON.stringify(customers[0])"));
  const dev = w.eval('getOrCreateDeviceId()');
  assert.equal(c.tokens, 9); assert.equal(c.tokenBase, 5); assert.deepEqual(c.tokenLedger, { [dev]: 4 });
  assert.equal(JSON.parse(w.localStorage.getItem('pos_customers'))[0].tokens, 9, 'saved');
  close();
});

test('two devices award the same customer while offline; after they sync every device and the server show the sum', async () => {
  const s = makeServer();
  const CUST = JSON.stringify([{ id: 'c1', name: 'Amina', phone: '254700000001', tokens: 5, createdAt: 1 }]);
  const base = { pos_loyalty_enabled: 'true', pos_loyalty_tiers: JSON.stringify([{ id: 't', minSpend: 0, maxSpend: null, tokens: 1 }]), pos_customers: CUST };
  const lines = [{ down: false }, { down: false }];
  const mk = (i) => (url, o) => (lines[i].down ? Promise.reject(new Error('offline')) : s.fetch(url, o));
  const a = await openDevice('index.html', s, base, 500, { fetch: mk(0) }); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  const st = deviceStorage(a.w); delete st.pos_device_id; delete st.pos_till_no; delete st.pos_till_ref_seq; delete st.pos_last_synced_at;
  const b = await openDevice('index.html', s, st, 500, { fetch: mk(1) }); quiet(b.w);
  await b.w.eval('pushNow()'); await b.w.eval('pullState()');
  assert.notEqual(a.w.eval('getOrCreateDeviceId()'), b.w.eval('getOrCreateDeviceId()'));
  lines[0].down = lines[1].down = true;                          // both tills lose the line and keep selling
  for (let i = 0; i < 2; i++) a.w.eval("awardTokensForSale('254700000001', 100)");
  for (let i = 0; i < 3; i++) b.w.eval("awardTokensForSale('254700000001', 100)");
  lines[0].down = lines[1].down = false;
  for (let round = 0; round < 3; round++) for (const d of [a, b]) { d.w.eval('window.__pushBackoffUntil = 0'); try { await d.w.eval('flushThenPull()'); } catch (e) { /* next round */ } await sleep(60); }
  const tok = (d) => d.w.eval("customers.find(c => c.id === 'c1').tokens");
  assert.equal(s.serverState().customers.find((c) => c.id === 'c1').tokens, 10, 'server: 5 + 2 + 3');
  assert.equal(tok(a), 10, 'device A'); assert.equal(tok(b), 10, 'device B');
  a.close(); b.close();
});

import { fakeDoState, hasSqlite } from './do-fake.mjs';
test('the shop database (Durable Object store) merges tokens, trade credits and shifts the same way as the KV store', { skip: !hasSqlite }, async () => {
  const { ShopStore } = await load('wildcard-router/shop-store.js');
  const store = new ShopStore(fakeDoState(), {});
  const push = async (b) => (await store.fetch(new Request('https://s/push', { method: 'POST', body: JSON.stringify({ body: { businessName: 'Biz', ...b }, serverNow: Date.now() }) }))).json();
  const state = () => JSON.parse(store.stateText(null));
  const start = { id: 'c1', name: 'Amina', phone: '254700000001', tokens: 5, createdAt: 1, updatedAt: 100 };
  const open = { id: 'T1', timestamp: new Date().toISOString(), partyName: 'Acme', amount: 500, status: 'open', settledAt: null };
  await push({ customers: [start], tradeCredits: [open], attendanceLog: [{ id: 'A1', clockIn: new Date().toISOString(), clockOut: null }], updatedAt: Date.now() });
  await push({ customers: [{ ...start, tokenBase: 5, tokenLedger: { A: 1 }, tokens: 6, updatedAt: 200 }], tradeCredits: [{ ...open, status: 'settled', settledAt: new Date().toISOString() }], attendanceLog: [{ id: 'A1', clockIn: new Date().toISOString(), clockOut: new Date().toISOString() }], updatedAt: Date.now() });
  await push({ customers: [{ ...start, tokenBase: 5, tokenLedger: { B: 2 }, tokens: 7, updatedAt: 300 }], tradeCredits: [open], attendanceLog: [{ id: 'A1', clockIn: new Date().toISOString(), clockOut: null }], updatedAt: Date.now() });
  const st = state();
  assert.equal(st.customers[0].tokens, 8); assert.deepEqual(st.customers[0].tokenLedger, { A: 1, B: 2 });
  assert.equal(st.tradeCredits[0].status, 'settled', 'a stale open copy does not reopen the debt');
  assert.ok(st.attendanceLog[0].clockOut, 'nor the shift');
});
