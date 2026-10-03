import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// Zip 148 — the native apps' releases (Owner Console ▸ Apps & Versions → Settings ▸ Install App), the owner's messages, and the web
// app talking to the Android app (printing). The security boundary is the SERVER: a shop is offered and can download only its own
// app, whatever it asks for.
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
function r2() {
  const m = new Map();
  return { m, put: async (k, v, o) => { m.set(k, { bytes: new Uint8Array(v), ct: o && o.httpMetadata && o.httpMetadata.contentType }); }, get: async (k) => (m.has(k) ? { body: new Blob([m.get(k).bytes]).stream() } : null), delete: async (k) => { m.delete(k); } };
}
function env() {
  const kv = makeKV(); seedShop(kv, 'C1', { product: 'shop' }); seedShop(kv, 'H1', { product: 'hotel' });
  kv.data.set('owner-session:tok', { value: '1' });
  return { mydukapos_kv: kv, MEDIA: r2() };
}
const OWNER = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' };
const APK = (n = 3000) => { const b = new Uint8Array(n); b.set([0x50, 0x4b, 0x03, 0x04]); for (let i = 4; i < n; i++) b[i] = i % 251; return b; };

test('releases: owner-only; a file must really be uploaded (checked) before publishing; a shop sees and downloads ONLY its own app', async () => {
  const e = env();
  const own = await load('owner-releases.js');
  const pub = await load('app-releases.js');
  const post = (body, headers = OWNER) => own.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-releases', { method: 'POST', headers, body: JSON.stringify(body) }), env: e });
  // owner only
  assert.equal((await post({ action: 'save', release: { app: 'shop', platform: 'android', kind: 'apk', version: '1.0.0' } }, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await own.onRequestGet({ request: new Request('https://x.pages.dev/api/owner-releases'), env: e })).status, 401);
  const shopRel = (await (await post({ action: 'save', release: { app: 'shop', platform: 'android', kind: 'apk', version: '1.0.0', build: 1, notes: 'First' } })).json()).release;
  const hotelRel = (await (await post({ action: 'save', release: { app: 'hotel', platform: 'android', kind: 'apk', version: '1.0.0', build: 1 } })).json()).release;
  // never the same version twice (releases are never overwritten)
  assert.equal((await post({ action: 'save', release: { app: 'shop', platform: 'android', kind: 'apk', version: '1.0.0', build: 1 } })).status, 409);
  // no file yet: cannot publish
  assert.equal((await post({ action: 'publish', id: shopRel.id })).status, 409);
  const put = (id, name, bytes, headers = OWNER) => own.onRequestPut({ request: new Request(`https://x.pages.dev/api/owner-releases?id=${id}&name=${name}`, { method: 'PUT', headers, body: bytes }), env: e });
  // a file that is not an APK is refused
  assert.equal((await put(shopRel.id, 'MyDukaPOS-1.0.0.apk', new Uint8Array([1, 2, 3, 4, 5]))).status, 400);
  assert.equal((await put(shopRel.id, 'MyDukaPOS-1.0.0.exe', APK())).status, 400, 'the extension must match the release');
  const up = await (await put(shopRel.id, 'MyDukaPOS-1.0.0.apk', APK())).json();
  assert.equal(up.release.file.size, 3000);
  const expect = [...new Uint8Array(await crypto.subtle.digest('SHA-256', APK()))].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(up.release.file.sha256, expect, 'size and SHA-256 are what the server stored');
  await put(hotelRel.id, 'MyDukaPOS-Hotel-1.0.0.apk', APK(4000));
  assert.equal((await post({ action: 'publish', id: shopRel.id })).status, 200);
  assert.equal((await post({ action: 'publish', id: hotelRel.id })).status, 200);
  assert.equal((await put(shopRel.id, 'MyDukaPOS-1.0.0.apk', APK())).status, 409, 'a published release is never overwritten');
  // the SHOP link: only the Shop app
  const list = async (c) => pub.onRequestGet({ request: new Request(`https://x.pages.dev/api/app-releases?c=${c}`), env: e });
  const shopList = await (await list('C1')).json();
  assert.equal(shopList.product, 'shop');
  assert.deepEqual(shopList.releases.map((r) => r.app), ['shop']);
  const hotelList = await (await list('H1')).json();
  assert.deepEqual(hotelList.releases.map((r) => r.app), ['hotel']);
  // download: own app OK (the real bytes), another app's id -> 404, no link -> 403
  const dl = await pub.onRequestGet({ request: new Request(`https://x.pages.dev/api/app-releases?c=C1&download=${shopRel.id}`), env: e });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="MyDukaPOS-1\.0\.0\.apk"/);
  assert.equal((await dl.arrayBuffer()).byteLength, 3000);
  const escape = await pub.onRequestGet({ request: new Request(`https://x.pages.dev/api/app-releases?c=C1&download=${hotelRel.id}`), env: e });
  assert.equal(escape.status, 404, 'a Shop link cannot download the Hotel app, even with its id');
  assert.equal((await pub.onRequestGet({ request: new Request(`https://x.pages.dev/api/app-releases?download=${shopRel.id}`), env: e })).status, 403);
  // withdrawn: no longer offered
  await post({ action: 'withdraw', id: shopRel.id });
  assert.deepEqual((await (await list('C1')).json()).releases, []);
  // the licence reports the link's product (the native launcher checks it)
  const lic = await load('license-status.js');
  const l = await (await lic.onRequestGet({ request: new Request('https://x.pages.dev/api/license-status?c=H1'), env: e })).json();
  assert.equal(l.product, 'hotel');
});

test('messages: owner-only; each shop gets what is addressed to it (all / its app / itself), in its time window, published only', async () => {
  const e = env();
  const own = await load('owner-messages.js');
  const shop = await load('messages.js');
  const post = (body, headers = OWNER) => own.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-messages', { method: 'POST', headers, body: JSON.stringify(body) }), env: e });
  assert.equal((await post({ action: 'save', message: { title: 'x' } }, { 'Content-Type': 'application/json' })).status, 401);
  const mk = async (message, publish = true) => { const m = (await (await post({ action: 'save', message })).json()).message; if (publish) await post({ action: 'publish', id: m.id }); return m; };
  await mk({ title: 'For everyone', body: 'a', targets: { all: true } });
  await mk({ title: 'Hotels only', body: 'b', targets: { all: false, products: ['hotel'] } });
  await mk({ title: 'Just C1', body: 'c', targets: { all: false, clients: ['C1'] } });
  await mk({ title: 'Later', body: 'd', startsAt: Date.now() + 3600000, targets: { all: true } });
  await mk({ title: 'Over', body: 'e', endsAt: Date.now() - 1000, targets: { all: true } });
  await mk({ title: 'Draft', body: 'f', targets: { all: true } }, false);
  const install = await mk({ title: 'Android app', body: 'g', kind: 'install', installPlatform: 'android', targets: { all: true, platforms: ['web'] } });
  const get = async (c) => (await (await shop.onRequestGet({ request: new Request(`https://x.pages.dev/api/messages?c=${c}`), env: e })).json()).messages.map((m) => m.title).sort();
  assert.deepEqual(await get('C1'), ['Android app', 'For everyone', 'Just C1']);
  assert.deepEqual(await get('H1'), ['Android app', 'For everyone', 'Hotels only']);
  // archive + delete
  assert.equal((await post({ action: 'delete', id: install.id })).status, 409, 'a published message is archived first');
  await post({ action: 'archive', id: install.id });
  assert.ok(!(await get('C1')).includes('Android app'));
  assert.equal((await post({ action: 'delete', id: install.id })).status, 200);
});

// a fake Android app bridge, as NativeBridge.java behaves: results come back through window.__myDukaNativeCb
function androidBridge(w, behaviour) {
  w.__btCalls = [];
  w.MyDukaNative = {
    info: () => JSON.stringify({ platform: 'android', module: 'shop', appName: 'MyDukaPOS', version: '1.0.0', build: 1 }),
    printPage: () => {},
    btList: (cb) => setTimeout(() => w.__myDukaNativeCb(cb, { ok: true, devices: [{ name: 'MTP-II', address: '00:11:22:33:44:55' }] }), 5),
    btPrint: (addr, b64, cb) => { w.__btCalls.push({ addr, text: Buffer.from(b64, 'base64').toString('latin1') }); setTimeout(() => w.__myDukaNativeCb(cb, behaviour.fail ? { ok: false, error: behaviour.fail } : { ok: true }), 5); },
  };
}
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha Soap', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];

test('in the Android app: choose the Bluetooth printer (real list), test print, and receipts print on it through the thermal path', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Duka Test' }, beforeParse: (w) => androidBridge(w, {}), wait: 1200 });
  const { w, d } = b;
  w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; document.getElementById('login-screen').style.display = 'none'");
  assert.equal(w.eval('nativeApp.platform'), 'android');
  w.eval("document.querySelector('.tab-link[data-tab=\"settings-tab\"]').click(); document.querySelector('[data-section=\"settings-section-install\"]').click()");
  await new Promise((r) => setTimeout(r, 100));
  assert.match(d.getElementById('native-apps-panel').textContent, /You are using the MyDukaPOS Android app[\s\S]*Version 1\.0\.0/);
  await w.eval('nativePrinterScan()');
  assert.match(d.getElementById('native-printer-list').textContent, /MTP-II/);
  await w.eval('nativePrinterPick(0)');
  assert.match(d.getElementById('native-printer-status').textContent, /Printed — the printer received the test page/);
  assert.equal(w.eval('printerMode'), 'bluetooth', 'receipts now go to the thermal path');
  assert.match(w.eval('window.__btCalls[0].text'), /printer test[\s\S]*Duka Test/);
  // a sale: the receipt is printed on the app's Bluetooth printer (ESC/POS bytes), not the dialog
  w.eval("autoPrintEnabled = false; addToCart('A'); currentPaymentMethod = 'cash'");
  d.getElementById('cash-tendered-input').value = '500';
  await w.eval('checkoutCart()');
  await w.eval('printReceipt()');
  const last = w.eval('window.__btCalls[window.__btCalls.length - 1].text');
  assert.match(last, /Alpha Soap/);
  assert.equal(w.eval('window.__btCalls[window.__btCalls.length - 1].addr'), '00:11:22:33:44:55');
  b.close();
});

test('in the Android app: a printer that fails says exactly why (never "printed")', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_native_printer_v1: JSON.stringify({ kind: 'android-bt', address: 'AA', name: 'Off printer' }), pos_printer_mode: 'bluetooth' }, beforeParse: (w) => androidBridge(w, { fail: 'read failed, socket might closed or timeout' }), wait: 1200 });
  const { w, d } = b;
  w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; document.getElementById('login-screen').style.display = 'none'");
  w.eval("autoPrintEnabled = false; addToCart('A'); currentPaymentMethod = 'cash'");
  d.getElementById('cash-tendered-input').value = '500';
  await w.eval('checkoutCart()');
  await w.eval('printReceipt()');
  assert.match(w.eval('window.__toasts.join(" | ")'), /Bluetooth print failed: read failed, socket might closed or timeout/);
  assert.equal(w.eval('salesLog.length'), 1, 'the sale itself is recorded whatever the printer does');
  b.close();
});

test('messages in the app: shown one at a time, "Don\'t Show Again" sticks, kept for offline; installation offers have their three buttons', async () => {
  let online = true;
  const msgs = [{ id: 'm1', title: 'Hello shops', body: 'New features', kind: 'announcement' }, { id: 'm2', title: 'Android app', body: 'Install it', kind: 'install', installPlatform: 'android', platforms: ['web'] }];
  const fetch = async (u) => {
    if (!online) throw new TypeError('Failed to fetch');
    if (String(u).includes('/api/messages')) return new Response(JSON.stringify({ messages: msgs }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS) }, fetch, wait: 3500 });
  const { w, d } = b;
  // the page's start-up work is slower in this simulated browser than a fixed wait allows for; wait for the bar itself (up to 25 s)
  for (let i = 0; i < 250 && !d.getElementById('owner-msg-bar'); i++) await new Promise((r) => setTimeout(r, 100));
  let bar = d.getElementById('owner-msg-bar');
  assert.ok(bar, 'the first unread message is shown');
  assert.match(bar.textContent, /Hello shops[\s\S]*1 of 2 new/);
  bar.querySelector('button').click();                                  // OK
  await new Promise((r) => setTimeout(r, 500));
  bar = d.getElementById('owner-msg-bar');
  assert.match(bar.textContent, /Android app/);
  const labels = [...bar.querySelectorAll('button')].map((x) => x.textContent);
  assert.deepEqual(labels, ['Install Android App', 'Continue Using Web App', "Don't Show Again"]);
  bar.querySelectorAll('button')[2].click();                             // Don't Show Again
  const store = JSON.parse(w.eval("JSON.stringify({ a: localStorage.getItem('pos_owner_msgs_v1'), s: localStorage.getItem('pos_owner_msgs_seen_v1') })"));
  b.close();
  // reopened OFFLINE: nothing already dismissed comes back; the list is still there (Settings ▸ Install App)
  online = false;
  const b2 = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_owner_msgs_v1: store.a, pos_owner_msgs_seen_v1: store.s }, fetch, wait: 3500 });
  assert.equal(b2.d.getElementById('owner-msg-bar'), null, "dismissed messages stay dismissed");
  assert.equal(b2.w.eval('ownerMessagesUnread()'), 0);
  b2.close();
});
