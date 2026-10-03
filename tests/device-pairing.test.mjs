import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';

// zip 194: device pairing is NOT required any more. Real apps + real server code. (Was: #6 zip 120, server-checked devices.)
// What is kept: the device list and the optional quiet registration. What is gone: any refusal, the pairing screen.
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

test('every device with the link syncs; a device may still register quietly so it shows in the list', async () => {
  const { s, a } = await shop();
  const other = await openDevice('index.html', s, {}, 900); quiet(other.w);      // a stranger with the link, no token
  const r = await s.fetch('https://x/api/pos-sync', { method: 'GET' });
  assert.equal(r.status, 200, 'no pairing needed');
  const list = await (await s.fetch('https://x/api/device-pair', { headers: { 'X-Device-Id': a.w.eval('getOrCreateDeviceId()'), 'X-Device-Token': a.w.localStorage.getItem('pos_device_token') } })).json();
  assert.equal(list.mode, 'open'); assert.ok(list.devices.some((d) => d.me));
  assert.ok(list.devices.find((d) => d.me).version, 'the device list knows its app release (#11)');
  a.close(); other.close();
});

test('switching a shop to "paired" has NO effect: a device without a token still reads, writes, sells and syncs; no pairing screen', async () => {
  const { s, a } = await shop();
  const h = { 'X-Device-Id': a.w.eval('getOrCreateDeviceId()'), 'X-Device-Token': a.w.localStorage.getItem('pos_device_token') };
  assert.equal((await api(s, { action: 'mode', mode: 'paired', proof: 'wrong'.padEnd(64, '0') }, h)).status, 403, 'still needs the password to change anything');
  const m = await api(s, { action: 'mode', mode: 'paired', proof: PWH }, h);
  assert.equal(m.status, 200); assert.equal((await m.json()).mode, 'open', 'accepted but not enforced');
  // even a record written straight into KV (an old deployment, the owner console) is ignored
  s.kv.data.set('device-auth:C1', { value: JSON.stringify({ mode: 'paired', devices: {} }) });
  const r = await s.fetch('https://x/api/pos-sync', { method: 'GET' });
  assert.equal(r.status, 200, 'a stranger with no token is NOT refused');
  const w = await s.fetch('https://x/api/pos-sync', { method: 'POST', body: JSON.stringify({ inventory: [{ code: 'A', qty: 49, updatedAt: Date.now() + 1e6 }] }) });
  assert.equal(w.status, 200, 'nor refused when writing');
  // a copy of the till with no token sells and syncs, and is never shown a pairing screen
  const st = deviceStorage(a.w); delete st.pos_device_token; st.pos_device_id = 'dev_other';
  const b = await openDevice('index.html', s, st, 1200); quiet(b.w);
  await b.w.eval('pushNow()'); await sleep(100);
  assert.ok(!b.d.getElementById('device-pair-screen'), 'no pairing screen');
  b.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); b.w.document.getElementById('cash-tendered-input').value = '1000';
  await b.w.eval('checkoutCart()'); await settled(b);
  assert.equal(b.w.eval('salesLog.length'), 1);
  assert.equal(s.serverState().salesLog.length, 1, 'and the server accepted it, no pairing');
  assert.ok(!b.d.getElementById('device-pair-screen'));
  a.close(); b.close();
});

test('revoke is harmless (it no longer stops syncing); a brand-new device just syncs; guessing the password is still rate-limited', async () => {
  const { s, a } = await shop();
  const h = { 'X-Device-Id': a.w.eval('getOrCreateDeviceId()'), 'X-Device-Token': a.w.localStorage.getItem('pos_device_token') };
  const t = await (await api(s, { action: 'pair', deviceId: 'dev_new', proof: PWH })).json();
  assert.ok(t.token);
  const nh = { 'X-Device-Id': 'dev_new', 'X-Device-Token': t.token };
  assert.equal((await api(s, { action: 'revoke', deviceId: 'dev_new', proof: PWH }, h)).status, 200);
  assert.equal((await s.fetch('https://x/api/pos-sync', { method: 'GET', headers: nh })).status, 200, 'a revoked device still syncs: pairing is not enforced');
  assert.equal((await api(s, { action: 'revoke', deviceId: h['X-Device-Id'], proof: PWH }, h)).status, 400, 'a device cannot revoke itself');
  // a brand-new device with nothing stored: no pairing screen
  const fresh = await openDevice('index.html', s, {}, 1500); quiet(fresh.w);
  await sleep(300);
  assert.ok(!fresh.d.getElementById('device-pair-screen'), 'no pairing screen on a brand-new device');
  let refused = 0;
  for (let i = 0; i < 25; i++) { const r = await api(s, { action: 'pair', deviceId: 'dev_g' + i, proof: String(i).padEnd(64, '0') }); if (r.status === 429) refused++; }
  assert.ok(refused > 0, 'password guessing is cut off');
  a.close(); fresh.close();
});

test('Aqua POS: same — stored "paired" mode is ignored and it keeps syncing', async () => {
  const s = makeServer();
  const { boot } = await import('./helpers.mjs');
  const b = await boot('water/index.html', { url: 'https://x.mydukapos.store/water/?c=x#shop', fetch: s.fetch, storage: { aqua_pw_hash: PWH }, wait: 1200 });
  quiet(b.w);
  await b.w.eval('doPush()');
  await b.w.eval('devicePairNow()');
  assert.ok(b.w.localStorage.getItem('pos_device_token'));
  const h = { 'X-Device-Id': b.w.eval('getOrCreateDeviceId()'), 'X-Device-Token': b.w.localStorage.getItem('pos_device_token') };
  assert.equal((await api(s, { action: 'mode', mode: 'paired', proof: PWH }, h)).status, 200);
  assert.equal((await s.fetch('https://x/api/pos-sync', { method: 'GET' })).status, 200);
  await b.w.eval('doPush()'); await b.w.eval('pullFromServer()');
  assert.ok(!b.d.getElementById('device-pair-screen'));
  b.close();
});
