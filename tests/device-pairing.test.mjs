import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';

// #6 (zip 120): server-checked devices that still work offline. Real apps + real server code.
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const PW = 'shop-secret';
const PWH = crypto.createHash('sha256').update(PW).digest('hex');
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0), 8000);
const api = (s, body, headers = {}) => s.fetch('https://x/api/device-pair', { method: 'POST', body: JSON.stringify(body), headers });
async function shop() {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz', pos_pw_hash: PWH }); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  await a.w.eval('devicePairNow()');                                            // what it does by itself a few seconds after opening
  assert.ok(a.w.localStorage.getItem('pos_device_token'), 'the set-up device paired itself with the password it already has');
  return { s, a };
}

test('an open shop behaves exactly as before, and its devices pair themselves in the background', async () => {
  const { s, a } = await shop();
  const other = await openDevice('index.html', s, {}, 900); quiet(other.w);      // a stranger with the link, no token
  const r = await s.fetch('https://x/api/pos-sync', { method: 'GET' });
  assert.equal(r.status, 200, 'open: no pairing needed');
  const list = await (await s.fetch('https://x/api/device-pair', { headers: { 'X-Device-Id': a.w.eval('getOrCreateDeviceId()'), 'X-Device-Token': a.w.localStorage.getItem('pos_device_token') } })).json();
  assert.equal(list.mode, 'open'); assert.ok(list.devices.some((d) => d.me && d.paired));
  assert.ok(list.devices.find((d) => d.me).version, 'the device list knows its app release (#11)');
  a.close(); other.close();
});

test('"paired devices only": a stranger with the link is refused; the paired till syncs; everyone still works offline', async () => {
  const { s, a } = await shop();
  const h = { 'X-Device-Id': a.w.eval('getOrCreateDeviceId()'), 'X-Device-Token': a.w.localStorage.getItem('pos_device_token') };
  assert.equal((await api(s, { action: 'mode', mode: 'paired', proof: 'wrong'.padEnd(64, '0') }, h)).status, 403, 'needs the password');
  assert.equal((await api(s, { action: 'mode', mode: 'paired', proof: PWH })).status, 401, 'an unpaired device cannot switch it on (no lock-out)');
  assert.equal((await api(s, { action: 'mode', mode: 'paired', proof: PWH }, h)).status, 200);
  // a stranger: no token -> the shop's data is refused
  const r = await s.fetch('https://x/api/pos-sync', { method: 'GET' });
  assert.equal(r.status, 401); assert.equal((await r.json()).code, 'device_not_paired');
  const w = await s.fetch('https://x/api/pos-sync', { method: 'POST', body: JSON.stringify({ inventory: [{ code: 'A', qty: 0, updatedAt: Date.now() + 1e6 }] }) });
  assert.equal(w.status, 401, 'nor may it write');
  // the paired till sells and syncs normally
  a.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); a.w.document.getElementById('cash-tendered-input').value = '1000';
  await a.w.eval('checkoutCart()'); await settled(a);
  assert.equal(s.serverState().salesLog.length, 1);
  // an unpaired copy of the till (same data, token lost) keeps selling OFFLINE and shows the pairing screen
  const st = deviceStorage(a.w); delete st.pos_device_token; st.pos_device_id = 'dev_other';
  const b = await openDevice('index.html', s, st, 1200); quiet(b.w);
  await b.w.eval('pushNow()'); await sleep(100);
  assert.ok(b.d.getElementById('device-pair-screen'), 'asked to pair');
  b.d.getElementById('dps-later').click();                                      // "keep working offline"
  b.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); b.w.document.getElementById('cash-tendered-input').value = '1000';
  await b.w.eval('checkoutCart()');
  assert.equal(b.w.eval('salesLog.length'), 2, 'the sale is saved on the device');
  assert.equal(s.serverState().salesLog.length, 1, 'but not accepted by the server yet');
  // it pairs with a 6-digit code made on the paired till, then its sale syncs
  const code = (await (await api(s, { action: 'code' }, h)).json()).code;
  assert.match(code, /^\d{6}$/);
  b.w.eval('showDevicePairScreen()');
  b.d.getElementById('dps-code').value = code;
  await b.w.eval("document.getElementById('dps-go').onclick()");
  assert.ok(b.w.localStorage.getItem('pos_device_token'));
  b.w.eval('window.__pushBackoffUntil = 0');
  await b.w.eval('flushThenPull()');
  assert.equal(s.serverState().salesLog.length, 2, 'its offline sale arrived once paired');
  assert.equal((await api(s, { action: 'pair', deviceId: 'dev_x', code })).status, 403, 'a code works once');
  a.close(); b.close();
});

test('revoking a device stops it syncing; a brand-new device pairs with the shop password; guessing is rate-limited', async () => {
  const { s, a } = await shop();
  const h = { 'X-Device-Id': a.w.eval('getOrCreateDeviceId()'), 'X-Device-Token': a.w.localStorage.getItem('pos_device_token') };
  await api(s, { action: 'mode', mode: 'paired', proof: PWH }, h);
  const t = await (await api(s, { action: 'pair', deviceId: 'dev_new', proof: PWH })).json();
  assert.ok(t.token);
  const nh = { 'X-Device-Id': 'dev_new', 'X-Device-Token': t.token };
  assert.equal((await s.fetch('https://x/api/pos-sync', { method: 'GET', headers: nh })).status, 200);
  assert.equal((await api(s, { action: 'revoke', deviceId: 'dev_new', proof: PWH }, h)).status, 200);
  assert.equal((await s.fetch('https://x/api/pos-sync', { method: 'GET', headers: nh })).status, 401, 'revoked');
  assert.equal((await api(s, { action: 'revoke', deviceId: h['X-Device-Id'], proof: PWH }, h)).status, 400, 'a device cannot revoke itself (lock-out)');
  // a brand-new device with nothing stored: the app opens the pairing screen, pairs with the password, and reloads into the shop
  const fresh = await openDevice('index.html', s, {}, 1500); quiet(fresh.w);
  await until(() => !!fresh.d.getElementById('device-pair-screen'), 8000);
  fresh.w.__devicePairReload = () => { fresh.w.__reloaded = true; };
  fresh.d.getElementById('dps-pw').value = PW;
  await fresh.w.eval("document.getElementById('dps-go').onclick()");
  assert.ok(fresh.w.localStorage.getItem('pos_device_token')); assert.equal(fresh.w.__reloaded, true);
  let refused = 0;
  for (let i = 0; i < 25; i++) { const r = await api(s, { action: 'pair', deviceId: 'dev_g' + i, proof: String(i).padEnd(64, '0') }); if (r.status === 429) refused++; }
  assert.ok(refused > 0, 'password guessing is cut off');
  a.close(); fresh.close();
});

test('Aqua POS pairs the same way (its own password key) and is refused / allowed the same way', async () => {
  const s = makeServer();
  const { boot } = await import('./helpers.mjs');
  const b = await boot('water/index.html', { url: 'https://x.mydukapos.store/water/?c=x#shop', fetch: s.fetch, storage: { aqua_pw_hash: PWH }, wait: 1200 });
  quiet(b.w);
  await b.w.eval('doPush()');
  await b.w.eval('devicePairNow()');
  assert.ok(b.w.localStorage.getItem('pos_device_token'));
  const h = { 'X-Device-Id': b.w.eval('getOrCreateDeviceId()'), 'X-Device-Token': b.w.localStorage.getItem('pos_device_token') };
  assert.equal((await api(s, { action: 'mode', mode: 'paired', proof: PWH }, h)).status, 200);
  assert.equal((await s.fetch('https://x/api/pos-sync', { method: 'GET' })).status, 401);
  await b.w.eval('doPush()'); await b.w.eval('pullFromServer()');
  assert.ok(!b.d.getElementById('device-pair-screen'), 'the paired Aqua device keeps syncing');
  b.close();
});
