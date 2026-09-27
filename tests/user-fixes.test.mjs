import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { boot, ROOT, until } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INV = JSON.stringify([
  { code: 'A1', type: 'item', name: 'Tea Leaves', price: 100, wholesalePrice: 60, qty: 20, unit: 'pcs', vatCategory: 'A' },
  { code: 'B2', type: 'item', name: 'Teapot', price: 500, wholesalePrice: 300, qty: 5, unit: 'pcs', vatCategory: 'A' },
  { code: 'C3', type: 'item', name: 'Sugar 1kg', price: 200, wholesalePrice: 150, qty: 40, unit: 'kg', vatCategory: 'A' },
]);

// ---------- 1. Aqua POS: a refill size that is added shows up ----------
test('Aqua POS: adding a refill size shows it in the Refill Prices list at once, keeps it after a reload, and refuses a duplicate', async () => {
  const { w, d, errors, close } = await boot('water/index.html', { wait: 1500 });
  w.eval("showToast = function () {}");
  w.eval('seedDefaultSizesIfEmpty(); ensureRefillSizesForEverySite(); renderRefillPriceRows(); renderRefillSizeGrid()');
  assert.doesNotMatch(d.getElementById('refill-price-rows').textContent, /2\.5L/);
  const add = (label, ml, price) => { w.eval('openAddCustomRefillSize()'); d.getElementById('custom-size-label-input').value = label; d.getElementById('custom-size-ml-input').value = ml; d.getElementById('custom-size-price-input').value = price; w.eval('saveCustomRefillSize()'); };
  add('2.5L', '2500', '40');
  assert.match(d.getElementById('refill-price-rows').textContent, /2\.5L/, 'the new size is in the list straight away');
  assert.ok(JSON.parse(w.localStorage.getItem('aqua_refill_sizes')).some((s) => s.sizeML === 2500 && s.price === 40), 'and saved on the device');
  add('2.5 litres', '2500', '45');
  assert.match(d.getElementById('custom-size-error').textContent, /already exists/);
  assert.equal(w.eval('refillSizes.filter(s => s.sizeML === 2500).length'), 1);
  assert.deepEqual(errors, []);
  close();
});

// ---------- 2. Owner Console: staff are not asked for the owner's email ----------
test('Owner Console: a staff invite / staff link opens for the staff member (PIN), not the owner sign-in; the links carry the shop; the owner still gets the sign-in', async () => {
  const fetch = async (url) => (String(url).includes('/api/owner-auth') ? { ok: true, status: 200, json: async () => ({ hasAccount: true, authenticated: false }) } : Promise.reject(new Error('offline')));
  const screenOf = async (url, storage = {}) => { const b = await boot('owner/index.html', { url, fetch, storage, wait: 1200 }); const r = { display: b.d.getElementById('owner-auth-screen').style.display, client: b.w.eval('clientToken'), b }; return r; };
  let r = await screenOf('https://mydukapos.store/owner/?c=CLIENT1&invite=TOK123');
  assert.equal(r.display, 'none', 'invite link: no owner sign-in'); assert.equal(r.client, 'CLIENT1', 'it works on the shop the link came from'); r.b.close();
  r = await screenOf('https://mydukapos.store/owner/?c=CLIENT1&staff=S1');
  assert.equal(r.display, 'none', 'personal staff link: no owner sign-in'); r.b.close();
  r = await screenOf('https://mydukapos.store/owner/', { pos_console_staff_client: 'CLIENT1' });
  assert.equal(r.display, 'none', 'a phone that already opened a staff link is not asked either'); r.b.close();
  r = await screenOf('https://mydukapos.store/owner/');
  assert.equal(r.display, 'flex', 'the owner (no staff link, nothing saved) still signs in'); r.b.close();
  // the links the owner shares carry the shop
  const b = await boot('owner/index.html', { url: 'https://mydukapos.store/owner/', fetch, wait: 800 });
  b.w.eval("clientToken = 'OWNER77'; showToast = function () {}; window.__copied = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true }); pushNow = async () => true");
  await b.w.eval("copyStaffLoginLink('S9', 'Jane')");
  assert.equal(b.w.eval('window.__copied'), 'https://mydukapos.store/owner/?c=OWNER77&staff=S9');
  b.d.getElementById('new-staff-name-input').value = 'Bob';
  await b.w.eval('generateInviteLink()');
  assert.match(b.d.getElementById('invite-link-text').value, /^https:\/\/mydukapos\.store\/owner\/\?c=OWNER77&invite=/);
  b.close();
});

// ---------- 3. "webpage not available": the service workers ----------
const SW_FILES = ['sw.js', ...['water', 'hotel', 'hospital', 'production', 'services', 'pharmacy', 'owner'].map((a) => `${a}/sw.js`)];
function loadSw(file, { fetchImpl, cachesImpl }) {
  const handlers = {};
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8').replace('NAVIGATION_NETWORK_TIMEOUT_MS = 3500', 'NAVIGATION_NETWORK_TIMEOUT_MS = 40');
  const self = { addEventListener: (t, fn) => { handlers[t] = fn; }, location: { origin: 'https://x.test' }, skipWaiting() {}, clients: { claim() {}, matchAll: async () => (handlers.__clients || []) } };
  vm.runInNewContext(code, { self, caches: cachesImpl, fetch: fetchImpl, Request, Response, URL, AbortController, setTimeout, clearTimeout, crypto: globalThis.crypto, console: { warn() {}, log() {} } });
  return handlers;
}
const memCaches = (initial = {}) => {
  const stores = new Map(Object.entries(initial).map(([n, o]) => [n, new Map(Object.entries(o))]));
  const mk = (name) => { if (!stores.has(name)) stores.set(name, new Map()); const m = stores.get(name); return { match: async (k) => { const key = typeof k === 'string' ? k : k.url || String(k); const hit = m.get(key) || [...m.entries()].find(([kk]) => key.endsWith(kk.replace(/^\.\//, '')))?.[1]; return hit && hit.clone ? hit.clone() : hit; }, /* like the real Cache API: a fresh Response each time */ put: async (k, v) => { m.set(typeof k === 'string' ? k : k.url, v); } }; };
  return { open: async (n) => mk(n), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n) };
};
const navigate = async (handlers, url = 'https://x.test/hotel/?source=pwa', kept = []) => {
  let p; handlers.fetch({ request: { method: 'GET', url, mode: 'navigate' }, respondWith: (x) => { p = x; }, waitUntil: (x) => { kept.push(x); } });
  return p;
};
const hangUntilAborted = (opts) => new Promise((_, rej) => { if (opts && opts.signal) opts.signal.addEventListener('abort', () => rej(new Error('aborted'))); });

for (const file of SW_FILES) {
  test(`${file}: with nothing cached, a slow network is waited for (not the browser's error page); a dead network shows a friendly retry page; a broken cache falls back to the network`, async () => {
    // a) slower than the limit, nothing cached: the download is waited for (zip 145: it is never aborted, so the same one wins)
    let h = loadSw(file, { cachesImpl: memCaches(), fetchImpl: () => new Promise((r) => setTimeout(() => r(new Response('THE APP', { status: 200 })), 150)) });
    let res = await navigate(h);
    assert.equal(await res.text(), 'THE APP');
    // b) network completely down, nothing cached: a page, not an exception
    h = loadSw(file, { cachesImpl: memCaches(), fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    res = await navigate(h);
    assert.equal(res.status, 503); assert.match(await res.text(), /Waiting for a connection/);
    // c) the Cache API itself throws (storage full): plain network
    h = loadSw(file, { cachesImpl: { open: async () => { throw new Error('QuotaExceededError'); }, keys: async () => [], delete: async () => true }, fetchImpl: async () => new Response('FROM NETWORK', { status: 200 }) });
    res = await navigate(h);
    assert.equal(await res.text(), 'FROM NETWORK');
  });
}
for (const file of SW_FILES) {
  test(`${file}: zip 145 — a slow network no longer strands an installed app on its old copy: the cached app opens at once, the download finishes, the copy is replaced and the open app is told`, async () => {
    const stores = { 'minimartpos-shell-pointer': { 'https://sw-internal/current-cache-name': new Response('minimartpos-shell-abc'), 'https://sw-internal/page-etag': new Response('"old"') }, 'minimartpos-shell-abc': { './index.html': new Response('OLD APP') } };
    // the same pointer / cache names whatever the app id (the test's memCaches matches by name, so point every app's names at them)
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const id = /const APP_ID = '([^']*)'/.exec(code)[1];
    const st = {}; st[`${id}-shell-pointer`] = stores['minimartpos-shell-pointer']; st[`${id}-shell-abc`] = stores['minimartpos-shell-abc'];
    st[`${id}-shell-pointer`]['https://sw-internal/current-cache-name'] = new Response(`${id}-shell-abc`);
    const caches = memCaches(st);
    const h = loadSw(file, { cachesImpl: caches, fetchImpl: () => new Promise((r) => setTimeout(() => r(new Response('NEW APP', { status: 200, headers: { etag: '"new"' } })), 200)) });
    const told = []; h.__clients = [{ postMessage: (m) => told.push(m) }];
    const kept = [];
    const res = await navigate(h, 'https://x.test/?source=pwa', kept);
    assert.equal(await res.text(), 'OLD APP', 'slow line: the cached app opens without waiting');
    await Promise.all(kept);                                                        // the worker was kept alive for the download
    const page = await (await caches.open(`${id}-shell-abc`)).match('./index.html');
    assert.equal(await page.text(), 'NEW APP', 'the cached copy was replaced — the next open is the new release');
    assert.deepEqual(told.map((m) => m.type), ['app-update-ready'], 'the open app was told a newer version is ready');
    assert.match(code, /const SW_VERSION = 'zip-\d+';/, 'the service worker carries a release stamp');
  });
}
test('every app ships the SAME service-worker release stamp (so an update reaches every installed app)', () => {
  const v = SW_FILES.map((f) => /const SW_VERSION = '([^']+)';/.exec(fs.readFileSync(path.join(ROOT, f), 'utf8'))?.[1]);
  assert.ok(v.every((x) => x && x === v[0]), v.join(', '));
});
test('a cached copy is still served when the network is slow (offline opening is unchanged)', async () => {
  const stores = { 'minimartpos-shell-pointer': { 'https://sw-internal/current-cache-name': new Response('minimartpos-shell-abc') }, 'minimartpos-shell-abc': { './index.html': new Response('CACHED APP') } };
  const h = loadSw('sw.js', { cachesImpl: memCaches(stores), fetchImpl: async (req) => hangUntilAborted(req) });
  const res = await navigate(h, 'https://x.test/?source=pwa');
  assert.equal(await res.text(), 'CACHED APP');
});

// ---------- 4. the login popup does not come back over a running session ----------
test('the login popup does not reappear when the first sync finishes after the admin has already logged in (slow connection)', async () => {
  const hash = crypto.createHash('sha256').update('secret').digest('hex');                     // (the app stores a plain SHA-256 of the password)
  const fetch = (url) => (/pos-sync/.test(String(url)) ? new Promise((r) => setTimeout(() => r({ ok: true, status: 200, json: async () => ({ updatedAt: Date.now(), unchanged: true }) }), 1800)) : Promise.reject(new Error('offline')));
  const { w, d, errors, close } = await boot('index.html', { fetch, storage: { pos_biz_name: 'Test Shop', pos_pw_hash: hash }, wait: 400 });
  w.eval("showToast = function () {}");
  assert.equal(d.getElementById('login-screen').style.display, 'flex', 'the picker is up at start');
  w.eval('selectLoginAdmin()');
  d.getElementById('login-password-input').value = 'secret';
  await w.eval('loginSubmit()');
  assert.equal(d.getElementById('login-screen').style.display, 'none', 'logged in');
  await sleep(4500);                                                                          // the slow first sync lands now
  assert.equal(d.getElementById('login-screen').style.display, 'none', 'and the login popup stayed away');
  assert.deepEqual(errors, []);
  close();
});

// ---------- 5. "Customer N" on receipts, restarting each day ----------
for (const app of ['index.html', 'hotel/index.html']) {
  test(`${app}: every receipt carries "Customer N" just above the reference number; it counts today's customers and starts again tomorrow`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: { pos_inventory: INV }, wait: 1500 });
    w.eval("showToast = function () {}; window.confirm = () => true");
    const sale = async () => { w.eval("addToCart('A1'); currentPaymentMethod = 'cash'"); d.getElementById('cash-tendered-input').value = '1000'; await w.eval('checkoutCart()'); return w.eval('lastReceiptText'); };
    const order = (text, n) => { const a = text.indexOf(`Customer ${n}`), b = text.indexOf('Ref: '); return a >= 0 && b > a && !/Customer/.test(text.slice(a + 9, b)) && text.slice(a, b).split('\n').length <= 3; };
    let t1 = await sale();
    assert.ok(order(t1, 1), 'first customer of the day: Customer 1, just above Ref\n' + t1);
    let t2 = await sale();
    assert.ok(order(t2, 2), 'second: Customer 2');
    assert.equal(w.eval('salesLog.map(s => s.customerNo).join(",")'), '1,2', 'kept on the sales');
    w.eval('renderReceipt(salesLog[0])');
    assert.ok(order(w.eval('lastReceiptText'), 1), 'a reprint of the first shows the same number, and uses no new one');
    assert.equal(w.eval('salesLog.length'), 2);
    // a Pay Later customer is a customer too
    w.eval("addToCart('A1'); currentPaymentMethod = 'bill'"); const nameEl = d.getElementById('bill-customer-name-input'); if (nameEl) nameEl.value = 'Jane';
    await w.eval('checkoutCart()');
    assert.ok(order(w.eval('lastReceiptText'), 3), 'a bill is Customer 3');
    // a payment on that bill is not a new customer
    w.eval(`openBillSettleModal('sale', '${w.eval('bills[0].id')}')`); await w.eval('confirmBillSettle(false)');
    assert.doesNotMatch(w.eval('lastReceiptText'), /Customer \d/, 'a settlement receipt has no customer number');
    // a sale recorded for a past day, and a new day
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    w.eval(`salesLog.concat(bills).forEach(s => { s.timestamp = ${JSON.stringify(yesterday)}; })`);
    let t3 = await sale();
    assert.ok(order(t3, 1), 'a new day starts again at 1 (yesterday had 1-3)');
    assert.deepEqual(errors, []);
    close();
  });
}
test('the receipt preview text is built by the same code: a sale that is not saved (a preview) does not use up a number', async () => {
  const { w, close } = await boot('index.html', { storage: { pos_inventory: INV }, wait: 1200 });
  const doc = w.eval("(() => { const s = { id: 'tmp', timestamp: new Date().toISOString(), items: [{ code: 'A1', name: 'Tea', qty: 1, price: 100 }], paymentMethod: 'cash', paid: true }; return JSON.stringify({ n: assignCustomerNo(s), log: salesLog.length }); })()");
  assert.deepEqual(JSON.parse(doc), { n: null, log: 0 });
  close();
});

// ---------- 6. restock / order name box: type, or pick from the inventory ----------
for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html']) {
  test(`${app}: the Restock and Order name boxes drop down the inventory as you type; picking fills the code, unit and buying price; a new name just stays typed`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: { pos_inventory: INV }, wait: 1500 });
    w.eval("showToast = function () {}");
    const type = (input, text) => { input.value = text; input.dispatchEvent(new w.Event('input', { bubbles: true })); };
    const box = () => d.getElementById('item-suggest-box');
    // Restock
    w.eval('addRestockRow(); renderRestockRows()');
    let input = d.querySelector('#restock-rows-tbody input[data-suggest="restock"]');
    assert.ok(input, 'the name box is a typing field with the drop-down attached');
    type(input, 'tea');
    assert.equal(box().style.display, 'block');
    assert.deepEqual([...box().querySelectorAll('.is-opt strong')].map((e) => e.textContent), ['Tea Leaves', 'Teapot'], 'matching items, best match first');
    assert.match(box().textContent, /last cost KES 60/);
    box().querySelector('.is-opt').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const row = JSON.parse(w.eval('JSON.stringify(restockDraft[0])'));
    assert.deepEqual([row.code, row.name, row.unit, row.cost], ['A1', 'Tea Leaves', 'pcs', '60'], 'code, unit and buying price filled');
    assert.equal(box().style.display, 'none');
    assert.equal(d.activeElement && d.activeElement.getAttribute('inputmode'), 'decimal', 'the cursor is in the quantity box');
    // a new item: typing a name that is not stocked keeps it, with a hint
    w.eval('addRestockRow(); renderRestockRows()');
    input = d.querySelectorAll('#restock-rows-tbody input[data-suggest="restock"]')[1];
    type(input, 'Brand New Thing');
    assert.match(box().textContent, /not in your inventory/);
    assert.equal(box().querySelectorAll('.is-opt').length, 0);
    assert.equal(w.eval('restockDraft[1].name'), 'Brand New Thing', 'the typed name is the item');
    // Orders
    w.eval('renderOrdersTab(); poOpenForm()');
    input = d.querySelector('#po-rows-tbody input[data-suggest="po"]');
    type(input, 'sug');
    box().querySelector('.is-opt').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const prow = JSON.parse(w.eval('JSON.stringify(poState().draft[0])'));
    assert.deepEqual([prow.code, prow.name, prow.unit, prow.cost], ['C3', 'Sugar 1kg', 'kg', '150']);
    assert.equal(d.activeElement && d.activeElement.id, `po-row-${prow.rowId}-qty`);
    assert.deepEqual(errors, []);
    close();
  });
}
