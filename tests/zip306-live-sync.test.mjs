import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLiveServer, openLiveDevice } from './live-sync-harness.mjs';
import { deviceStorage, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';
import { hasSqlite } from './do-fake.mjs';

// zip 306: devices with a healthy live connection ask the shop's live-sync room "anything new?" over that connection instead of asking the server
// over HTTP every 30 s. These tests run the REAL Shop app on two devices (A = till, B = the admin's device) against the REAL server code, the
// REAL shop database and the REAL live-sync room, and check what the owner asked for:
//   1. a sale on A shows on B          2. a restock on A shows on B, never goes back and never adds itself again
//   3. stock matches on A, B and the server          + the HTTP checks really stop when nothing changes, and every fallback still works.
const ITEMS = [
  { code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 20, unit: 'pcs', vatCategory: 'A' },
  { code: 'B', type: 'item', name: 'Beta', price: 10, wholesalePrice: 5, qty: 30, unit: 'pcs', vatCategory: 'A' },
];
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");
const qty = (w, c = 'A') => w.eval(`inventory.find(p => p.code === '${c}').qty`);
const stockMap = (w) => JSON.parse(w.eval("JSON.stringify(Object.fromEntries(inventory.map(p => [p.code, p.qty])))"));
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0) && !dev.w.eval('window.__pullInFlight'), 10000);
const sell = async (dev, code = 'A', n = 1) => {
  for (let i = 0; i < n; i++) dev.w.eval(`addToCart('${code}')`);
  dev.w.eval("currentPaymentMethod = 'cash'");
  dev.w.document.getElementById('cash-tendered-input').value = '100000';
  await dev.w.eval('checkoutCart()');
  return dev.w.eval('salesLog[salesLog.length - 1].refNumber');
};
const restock = (w, code, n) => w.eval(`restockDraft = [{ rowId: 1, code: '${code}', name: '', unit: 'pcs', qty: '${n}', cost: '40', sellPrice: '', wholesaleSell: '' }]; window.__lastRestockAt = 0; completeRestock()`);
// "this connection has been up for a while and answers pings" (the app waits 15 s before trusting it; tests do not wait)
const makeLive = (w) => w.eval('window.__wsOpenedAt = Date.now() - 20000; window.__wsPongSeen = true; window.__wsLastRxAt = Date.now()');
// one poll tick, as if 30 s had passed since the last "anything new?" (and, optionally, since the last HTTP pull)
const tick = (w, { sincePull } = {}) => w.eval(`window.__wsLastRxAt = Date.now(); window.__roomAskAt = 0; ${sincePull != null ? `window.__pullStartedAt = Date.now() - ${sincePull};` : ''} syncPollTick()`);
const serverStock = async (s) => Object.fromEntries((await s.dbState()).inventory.map((p) => [p.code, p.qty]));

async function twoDevices(t) {
  const s = await makeLiveServer();
  const a = await openLiveDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()'); await settled(a);
  const st = deviceStorage(a.w);
  delete st.pos_device_id; delete st.pos_till_no; delete st.pos_till_ref_seq;          // a different physical device (the admin's)
  const b = await openLiveDevice('index.html', s, st, 900); quiet(b.w);
  await b.w.eval('pushNow()'); await b.w.eval('pullState()'); await settled(b);
  await until(() => s.room.rooms.get('C1') && s.room.rooms.get('C1').sockets.size >= 2, 5000);
  makeLive(a.w); makeLive(b.w);
  t.after(() => { try { a.close(); } catch (e) {} try { b.close(); } catch (e) {} });
  return { s, a, b };
}

test('1. a sale on device A shows on the admin\'s device B - by the instant push, and also when that push is lost', { skip: !hasSqlite }, async (t) => {
  const { s, a, b } = await twoDevices(t);
  const ref = await sell(a, 'A', 2); await settled(a);
  await until(() => b.w.eval(`salesLog.some(x => x.refNumber === '${ref}')`), 8000);
  await settled(b);
  assert.equal(qty(b.w), 18, 'B sees the stock come off');
  // the instant push is LOST (a phone missed it): the next "anything new?" over the connection finds it
  await sleep(6000); await settled(b);                             // let B's follow-up checks after the first sale finish (0.8 s / 2.5 s retries)
  s.room.flags.mute = true;
  b.w.eval('window.__roomAskAt = Date.now() + 1e9; window.__pokeRetries = 0');            // B's own timer must not ask before the test does
  const ref2 = await sell(a, 'A', 1); await settled(a);
  await sleep(200);
  assert.equal(b.w.eval(`salesLog.some(x => x.refNumber === '${ref2}')`), false, 'B has not heard yet');
  tick(b.w);
  await until(() => b.w.eval(`salesLog.some(x => x.refNumber === '${ref2}')`), 8000);
  await settled(b);
  assert.equal(qty(b.w), 17); assert.equal(qty(a.w), 17);
  assert.deepEqual(stockMap(b.w), await serverStock(s));
  a.close(); b.close();
});

test('2. a restock of 2 on A reaches B, does not go back when B syncs, and never adds itself again', { skip: !hasSqlite }, async (t) => {
  const { s, a, b } = await twoDevices(t);
  restock(a.w, 'A', 2); await settled(a);
  assert.equal(qty(a.w), 22);
  await until(() => qty(b.w) === 22, 8000); await settled(b);
  // B keeps working and syncing: pushes, pulls, a refresh, more pushes - and A syncs too
  for (let i = 0; i < 4; i++) {
    await b.w.eval('pushNow()'); await settled(b); await b.w.eval('flushThenPull()'); await settled(b);
    await a.w.eval('flushThenPull()'); await settled(a);
    tick(a.w, { sincePull: 200000 }); tick(b.w, { sincePull: 200000 }); await settled(a); await settled(b);
  }
  const st = deviceStorage(b.w); b.close();
  const b2 = await openLiveDevice('index.html', s, st, 1200); quiet(b2.w); makeLive(b2.w); t.after(() => { try { b2.close(); } catch (e) {} });
  await b2.w.eval('flushThenPull()'); await settled(b2);
  await a.w.eval('flushThenPull()'); await settled(a);
  assert.equal(qty(a.w), 22, 'A: 20 + 2, once');
  assert.equal(qty(b2.w), 22, 'B after many syncs and a refresh: still 22 (no going back to 20, no 24)');
  assert.equal((await serverStock(s)).A, 22, 'server: 22');
  const moves = ((await s.dbState()).stockMovementLog || []).filter((m) => (m.code === 'A' || m.itemCode === 'A') && Number(m.delta || m.qty || 0) > 0);
  assert.equal(moves.length, 1, 'exactly one restock movement on the server');
  a.close(); b2.close();
});

test('2b. B sells from an OLD copy (it missed the restock): both changes count, nothing goes back', { skip: !hasSqlite }, async (t) => {
  const { s, a, b } = await twoDevices(t);
  await sleep(3000); await settled(b);
  s.room.flags.mute = true;                                   // B hears nothing ...
  b.w.eval('window.__liveDue = () => false; window.__pokeRetries = 0');                 // ... and does not check (a phone that was asleep)
  restock(a.w, 'A', 2); await settled(a);
  assert.equal(qty(b.w), 20, 'B still shows the old 20');
  await sell(b, 'A', 1); await settled(b);                    // B's push carries its old idea of the stock
  s.room.flags.mute = false;
  await a.w.eval('flushThenPull()'); await settled(a); await b.w.eval('flushThenPull()'); await settled(b);
  assert.equal((await serverStock(s)).A, 21, 'server: 20 + 2 - 1');
  assert.equal(qty(a.w), 21); assert.equal(qty(b.w), 21);
  a.close(); b.close();
});

test('3. stock matches everywhere after a busy mix of sales and restocks on both devices', { skip: !hasSqlite }, async (t) => {
  const { s, a, b } = await twoDevices(t);
  await sell(a, 'A', 2); restock(b.w, 'B', 5); await sell(b, 'A', 1); restock(a.w, 'A', 3); await sell(a, 'B', 4); await sell(b, 'B', 1);
  for (const d of [a, b, a, b]) { await settled(d); await d.w.eval('flushThenPull()'); await settled(d); }
  const want = { A: 20 - 2 - 1 + 3, B: 30 + 5 - 4 - 1 };
  assert.deepEqual(await serverStock(s), want, 'server');
  assert.deepEqual(stockMap(a.w), want, 'device A');
  assert.deepEqual(stockMap(b.w), want, 'device B');
  a.close(); b.close();
});

test('cost: while nothing changes, a healthy device makes NO HTTP checks - only small messages on its open connection', { skip: !hasSqlite }, async (t) => {
  const { s, a, b } = await twoDevices(t);
  // warm-up round: a device whose last push left it 'behind' (it pushed stock movements) catches up once, then everything is quiet
  tick(a.w, { sincePull: 60000 }); tick(b.w, { sincePull: 60000 }); await sleep(6000); await settled(a); await settled(b);
  const pulls0 = s.httpPulls(), ws0 = s.room.stats.wsIn;
  for (let i = 0; i < 10; i++) { tick(a.w, { sincePull: 60000 }); tick(b.w, { sincePull: 60000 }); await sleep(30); }   // ten "30 s" rounds = 5 minutes
  await settled(a); await settled(b);
  assert.equal(s.httpPulls() - pulls0, 0, 'no HTTP pull at all');
  assert.equal(s.room.stats.wsIn - ws0, 20, 'one "anything new?" message per device per round');
  // the 3-minute backstop still pulls over HTTP
  tick(b.w, { sincePull: 181000 }); await settled(b);
  assert.equal(s.httpPulls() - pulls0, 1, 'backstop pull after 3 minutes');
  a.close(); b.close();
});

test('fallbacks: an old router that never answers, or a dropped connection, keep the old polling exactly', { skip: !hasSqlite }, async (t) => {
  const { s, a, b } = await twoDevices(t);
  s.room.flags.dead = true;                                   // the room does not answer 'v?' (router not updated yet)
  b.w.eval('window.__roomVerAt = 0');
  await sleep(6000); await settled(a); await settled(b);
  const p0 = s.httpPulls(); const log0 = s.state.log.length;
  tick(b.w, { sincePull: 31000 }); await settled(b);
  assert.equal(s.httpPulls() - p0, 1, 'no answer from the room -> the 30 s HTTP check, as before: ' + s.state.log.slice(log0).join(' ; '));
  // the connection drops: every 6.5 s tick pulls over HTTP, as before
  b.w.eval('syncSocket.close()'); await sleep(50);
  const p1 = s.httpPulls();
  b.w.eval('window.__pullStartedAt = Date.now() - 7000; syncPollTick()'); await settled(b);
  assert.equal(s.httpPulls() - p1, 1, 'connection down -> fast HTTP polling');
  // and a sale on A still reaches B that way
  s.room.flags.dead = false;
  const ref = await sell(a, 'A', 1); await settled(a);
  b.w.eval('window.__pullStartedAt = Date.now() - 7000; syncPollTick()');
  await until(() => b.w.eval(`salesLog.some(x => x.refNumber === '${ref}')`), 8000);
  a.close(); b.close();
});

// Every app (not only Shop) uses the cheap check: quiet -> no HTTP pull; the room knows a newer version -> exactly one pull, at once.
for (const [app, tickFn] of [['index.html', 'syncPollTick'], ['hotel/index.html', 'syncPollTick'], ['hospital/index.html', 'syncPollTick'], ['pharmacy/index.html', 'syncPollTick'], ['production/index.html', 'syncPollTick'], ['services/index.html', 'syncPollTick'], ['water/index.html', 'waterPollTick']]) {
  test(`${app}: the live check is wired in (quiet = no HTTP pull; a newer version = one pull)`, { skip: !hasSqlite }, async (t) => {
    const s = await makeLiveServer();
    // the shop already has data on the server, so the device has a version of its own after its first pull
    await s.env.SHOP_STORE.get('C1').fetch('https://shop-store/push', { method: 'POST', body: JSON.stringify({ body: { businessName: 'Biz', inventory: [{ code: 'A', name: 'Alpha', qty: 5, price: 10, updatedAt: 1 }] }, serverNow: Date.now(), _shop: 'C1' }) });
    const d = await openLiveDevice(app, s, {}, 1500); quiet(d.w); t.after(() => d.close());
    try { await d.w.eval('typeof flushThenPull === "function" ? flushThenPull() : null'); } catch (e) { /* the poll still runs */ }
    try { await d.w.eval('typeof pullFromServer === "function" ? pullFromServer() : pullState()'); } catch (e) { /* the poll still runs */ }
    try { d.w.eval('typeof connectSyncSocket === "function" && connectSyncSocket()'); } catch (e) { /* already connected */ }
    await until(() => s.room.rooms.get('C1') && s.room.rooms.get('C1').sockets.size >= 1, 6000);
    await sleep(5000);                                          // start-up pulls and pushes finish
    const local = () => Math.max(Number(d.w.eval("localStorage.getItem('pos_last_synced_at')")) || 0, Number(d.w.eval("localStorage.getItem('aqua_last_synced_at')")) || 0);
    // the room knows the version this device already has
    await s.env.SYNC_ROOM.get('C1').fetch('https://sync-room/ver', { method: 'POST', body: JSON.stringify({ ver: Math.max(local(), 1) }) });
    const t2 = (sincePull) => d.w.eval(`window.__wsOpenedAt = Date.now() - 20000; window.__wsPongSeen = true; window.__wsLastRxAt = Date.now(); window.__roomAskAt = 0; window.__pullStartedAt = Date.now() - ${sincePull}; ${tickFn}()`);
    t2(60000); await sleep(300); t2(60000); await sleep(300);
    const p0 = s.httpPulls();
    for (let i = 0; i < 5; i++) { t2(60000); await sleep(100); }
    assert.ok(local() > 0, 'the device holds a version');
    assert.equal(s.httpPulls() - p0, 0, 'quiet: no HTTP pull: ' + s.state.log.slice(-6).join(' ; '));
    // another device changed something: the room knows a newer version -> this device pulls right away
    await s.env.SYNC_ROOM.get('C1').fetch('https://sync-room/ver', { method: 'POST', body: JSON.stringify({ ver: Math.max(local(), 1) + 5000 }) });
    t2(60000);
    await until(() => s.httpPulls() - p0 >= 1, 5000);
    assert.equal(s.httpPulls() - p0, 1, 'one pull for the new version');
  });
}
