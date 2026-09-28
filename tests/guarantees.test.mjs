import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep, closeWhenIdle } from './e2e-harness.mjs';
import { until } from './helpers.mjs';

// The four guarantees (zip 146), end to end — REAL apps (jsdom) talking to the REAL sync server code:
//   1. the app works offline and online;
//   2. with a connection the dot is ONLINE (green) — and comes back to green by itself after a cut, with no refresh;
//   3. a completed sale never disappears from the sales record (refresh, a pull, another till's push, back online);
//   4. with several devices, every device ends up with every device's sales.
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 500, unit: 'pcs', vatCategory: 'A' }];
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; autoPrintEnabled = false");
const sell = async (dev) => {
  dev.w.eval("addToCart('A'); currentPaymentMethod = 'cash'");
  dev.w.document.getElementById('cash-tendered-input').value = '1000';
  await dev.w.eval('checkoutCart()');
  return dev.w.eval('salesLog[salesLog.length - 1].id');
};
const ids = (dev) => new Set(dev.w.eval('JSON.stringify(salesLog.filter(s => !s.voided).map(s => s.id))') ? JSON.parse(dev.w.eval('JSON.stringify(salesLog.map(s => s.id))')) : []);
const dot = (dev) => { const el = dev.w.document.getElementById('sync-status'); return el ? el.dataset.state || '' : ''; };
const green = (dev) => { const el = dev.w.document.getElementById('sync-status'); return !!el && el.classList.contains('sync-synced'); };
// close a device the way a person does — not in the middle of its own sync (jsdom tears the page down under an unfinished fetch,
// which a real phone never does)
const shut = (d) => closeWhenIdle(d);
// what Daily Sales shows for today (the sales record the user looks at)
const dailyIds = (dev) => {
  dev.w.eval("performTabSwitch(document.getElementById('daily-sales-tab-btn'), 'daily-sales-tab'); renderDailySales();");
  const html = dev.w.document.getElementById('daily-sales-tab').innerHTML;
  return (id) => html.includes(id) || html.includes(dev.w.eval(`(salesLog.find(s => s.id === ${JSON.stringify(id)}) || {}).refNumber || '§'`));
};

for (const app of ['index.html', 'hotel/index.html']) {
  test(`${app}: 1 + 3 — offline and online: sales made offline are kept through a refresh and reach the server once back online; nothing disappears`, async () => {
    const s = makeServer();
    const a = await openDevice(app, s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
    const online1 = await sell(a);
    await until(() => (s.serverState().salesLog || []).some((x) => x.id === online1), 10000);
    s.state.down = true;                                                                   // the internet goes
    const off = [await sell(a), await sell(a), await sell(a)];
    for (const id of [online1, ...off]) assert.ok(ids(a).has(id), 'kept on the device while offline');
    // closed and reopened with no internet (the device's own storage only)
    const store = deviceStorage(a.w); await shut(a);
    const a2 = await openDevice(app, s, store, 1200); quiet(a2.w);
    const shown = dailyIds(a2);
    for (const id of [online1, ...off]) { assert.ok(ids(a2).has(id), 'still there after reopening offline'); assert.ok(shown(id), 'and in Daily Sales'); }
    // the internet is back: they reach the server by themselves (no button pressed)
    s.state.down = false;
    a2.w.dispatchEvent(new a2.w.Event('online'));
    await until(() => off.every((id) => (s.serverState().salesLog || []).some((x) => x.id === id)), 20000);
    // a pull from the server (another till's newer state) never removes them
    await a2.w.eval('pullState()');
    for (const id of [online1, ...off]) assert.ok(ids(a2).has(id), 'not removed by a pull');
    assert.equal(new Set((s.serverState().salesLog || []).map((x) => x.id)).size, (s.serverState().salesLog || []).length, 'no sale stored twice');
    await shut(a2);
  });
}

test('2 — with a connection the dot is ONLINE (green); a cut turns it black; it goes green again BY ITSELF (no refresh), even on a slow line and even if the phone wrongly reports "offline"', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  a.w.__syncDotOfflineMs = 50;
  await until(() => green(a), 15000);
  assert.equal(a.w.eval('PosNet.state'), 'online');
  // the internet goes: black (offline) — the manager checked (server AND the internet probe)
  s.state.down = true; a.w.__posNetInternetProbe = () => Promise.resolve(false);
  await a.w.eval("PosNet.check('test')");
  await until(() => dot(a) === 'offline', 8000);
  // it comes back — a slow line (health answers in 5 s), and this phone's navigator.onLine still says false
  s.state.down = false; s.state.healthDelay = 5000; a.w.__posNetInternetProbe = () => Promise.resolve(true);
  Object.defineProperty(a.w.navigator, 'onLine', { configurable: true, get: () => false });
  // NOTHING is called by hand from here: the manager's own retries (and the app's own sync) must turn it green
  await until(() => green(a), 60000);
  assert.equal(a.w.eval('PosNet.state'), 'online', 'online although navigator.onLine says false and the server took 5 s');
  await shut(a);
});

for (const serverCheck of [true, false]) test(`4 — three devices (two tills and a phone), selling online AND offline: every device ends up with every sale, none twice${serverCheck ? '' : ' (server-side write check OFF: the devices\' own check recovers what a colliding save overwrote)'}`, async () => {
  const s = makeServer();
  if (!serverCheck) s.env.SYNC_VERIFY_WRITE = '0';
  const t1 = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(t1.w);
  await t1.w.eval('pushNow()');
  const devs = [t1];
  for (let i = 0; i < 2; i++) {
    const st = deviceStorage(t1.w); delete st.pos_device_id; delete st.pos_till_no; delete st.pos_till_ref_seq;
    const d = await openDevice('index.html', s, st, 900); quiet(d.w); devs.push(d);
  }
  const made = [];
  for (const d of devs) made.push(await sell(d));                                           // online
  s.state.down = true;
  for (let r = 0; r < 2; r++) for (const d of devs) made.push(await sell(d));               // all three offline at once
  s.state.down = false;
  // NOTHING is called by hand: each device only gets the browser's own "online" event; its own sync and poll do the rest
  for (const d of devs) d.w.dispatchEvent(new d.w.Event('online'));
  await until(() => devs.every((d) => made.every((id) => ids(d).has(id))), 90000);
  const server = (s.serverState().salesLog || []).map((x) => x.id);
  assert.equal(new Set(server).size, server.length, 'no sale stored twice on the server');
  for (const id of made) assert.ok(server.includes(id), 'every sale is on the server');
  devs.forEach((d, i) => {
    const have = ids(d); const shown = dailyIds(d);
    for (const id of made) { assert.ok(have.has(id), `device ${i + 1} has every sale`); assert.ok(shown(id), `device ${i + 1} shows it in Daily Sales`); }
    assert.equal(d.w.eval('salesLog.length'), made.length, `device ${i + 1}: exactly ${made.length} sales, none twice`);
  });
  for (const d of devs) await shut(d);
});
