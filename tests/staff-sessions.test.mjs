import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';

// Zip 141 — per-staff server sessions: the server checks WHO is working (their PIN, against the staff record it holds), signs a
// session with their permissions, checks every sale's staff signature on sync (never dropping a sale), and — when the shop requires
// it — refuses staff actions without a valid session or without the permission.
const imp = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = (k, m) => crypto.createHmac('sha256', Buffer.from(String(k), 'utf8')).update(String(m)).digest('hex');
const sealed = (pin, salt = 'saltsalt', iter = 1000) => `p2$${iter}$${salt}$${crypto.pbkdf2Sync(sha(pin), salt, iter, 32, 'sha256').toString('hex')}`;
const STAFF = [
  { id: 'w1', name: 'Wanjiru', pinHash: sealed('1111'), roles: ['service-tab', 'hosp-role:waiter'], updatedAt: 1 },
  { id: 'c1', name: 'Cashier Cate', pinHash: sealed('2222'), roles: ['service-tab', 'bills-tab', 'hosp-role:cashier', 'perm:payments', 'perm:orders.viewAll'], updatedAt: 1 },
  { id: 's1', name: 'Supervisor Sam', pinHash: sealed('3333'), roles: ['hosp-role:supervisor', 'perm:payments', 'perm:orders.manage', 'perm:reports'], updatedAt: 1 },
  { id: 'o1', name: 'Old Staff', pinHash: sha('4444'), roles: ['service-tab'], updatedAt: 1 },
  { id: 'x1', name: 'Gone', pinHash: sealed('5555'), roles: [], removed: true, updatedAt: 1 },
];
async function shop() {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const sync = await imp('pos-sync.js');
  await sync.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ businessName: 'Biz', updatedAt: Date.now(), pwHash: sealed('shoppass'), staff: STAFF }) }), env, waitUntil() {} });
  return { kv, env, sync };
}
const ss = await imp('staff-session.js');
const login = async (env, body, headers = {}) => { const r = await ss.onRequestPost({ request: new Request('https://x.pages.dev/api/staff-session?c=C1', { method: 'POST', body: JSON.stringify(body), headers }), env }); return { status: r.status, d: await r.json() }; };
const push = (sync, env, body) => sync.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ updatedAt: Date.now(), ...body }) }), env, waitUntil() {} });
const pull = async (sync, env) => (await sync.onRequestGet({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1'), env, waitUntil() {} })).json();
const saleMsg = (r) => `${r.id}|${r.deviceTimestamp || r.timestamp}|${Math.round(r.items.reduce((s, i) => s + i.price * i.qty, 0) * 100)}`;
const sign = (sess, r) => ({ ...r, staffAuth: { s: sess.sessionId, m: hmac(sess.secret, saleMsg(r)).slice(0, 32) } });
const SALE = (id, price = 300) => ({ id, refNumber: 'R-' + id, timestamp: new Date().toISOString(), paymentMethod: 'cash', cashAmount: price, items: [{ code: 'TSK', name: 'Tusker', qty: 1, price }], servedBy: 'x', updatedAt: Date.now() });

test('server PIN check: right PIN -> a signed session with that person\'s permissions; wrong PIN, a device\'s sealed hash, removed staff -> no', async () => {
  const { env } = await shop();
  assert.equal((await login(env, { staffId: 'c1', proof: sha('9999') })).status, 401, 'wrong PIN');
  assert.equal((await login(env, { staffId: 'c1', proof: STAFF[1].pinHash })).status, 400, 'the sealed hash every device keeps is not the PIN');
  assert.equal((await login(env, { staffId: 'x1', proof: sha('5555') })).status, 403, 'removed');
  assert.equal((await login(env, { staffId: 'nobody', proof: sha('1') })).d.code, 'unknown_staff');
  const c = await login(env, { staffId: 'c1', proof: sha('2222') });
  assert.equal(c.status, 200);
  assert.deepEqual(c.d.perms, ['payments', 'orders.viewAll']);
  assert.match(c.d.token, /^s1\./); assert.match(c.d.sessionId, /^[0-9a-f]{20}$/);
  assert.deepEqual((await login(env, { staffId: 'w1', proof: sha('1111') })).d.perms, [], 'a waiter: orders only');
  assert.deepEqual((await login(env, { staffId: 'o1', proof: sha('4444') })).d.perms, ['*'], 'staff from before roles: unchanged');
  const a = await login(env, { admin: true, proof: sha('shoppass') });
  assert.equal(a.status, 200); assert.deepEqual(a.d.perms, ['*']);
  // a forged token (claims edited to add permissions) is refused
  const [v, body, sig] = (await login(env, { staffId: 'w1', proof: sha('1111') })).d.token.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString()); claims.perms = ['*'];
  const forged = [v, Buffer.from(JSON.stringify(claims)).toString('base64url'), sig].join('.');
  const { verifyToken } = await imp('_staff-auth.js');
  assert.equal(await verifyToken(env, 'C1', forged), null);
  assert.equal(await verifyToken(env, 'C2', c.d.token), null, 'another shop\'s session is never valid here');
});

test('PIN guessing is rate-limited per staff member', async () => {
  const { env } = await shop();
  let last;
  for (let i = 0; i < 21; i++) last = await login(env, { staffId: 'w1', proof: sha('0000' + i) });
  assert.equal(last.status, 429);
  assert.equal((await login(env, { staffId: 'c1', proof: sha('2222') })).status, 200, 'other staff unaffected');
});

test('sales: the server checks each sale\'s staff signature and stamps it — never trusting the device, never dropping a sale; the stamp survives re-syncs', async () => {
  const { kv, env, sync } = await shop();
  const cate = (await login(env, { staffId: 'c1', proof: sha('2222') })).d;
  const wanj = (await login(env, { staffId: 'w1', proof: sha('1111') })).d;
  const good = sign(cate, SALE('g1'));
  const tampered = { ...sign(cate, SALE('t1')), items: [{ code: 'TSK', name: 'Tusker', qty: 1, price: 1 }] };
  const byWaiter = sign(wanj, SALE('w1'));
  const forged = { ...SALE('f1'), _auth: { ok: true, sid: 'c1', name: 'Cashier Cate' } };
  const unsigned = SALE('u1');
  assert.equal((await push(sync, env, { salesLog: [good, tampered, byWaiter, forged, unsigned] })).status, 200);
  const by = Object.fromEntries((await pull(sync, env)).salesLog.map((s) => [s.id, s._auth]));
  assert.equal(Object.keys(by).length, 5, 'every sale kept');
  assert.equal(by.g1.ok, true); assert.equal(by.g1.sid, 'c1');
  assert.equal(by.t1.reason, 'changed-after-signing');
  assert.equal(by.w1.reason, 'no-payment-permission');
  assert.equal(by.f1, undefined, 'a device cannot claim a stamp');
  assert.equal(by.u1, undefined);
  // re-sent later from another device (with the server's stamp), long after the session record is gone: the stamp stays
  for (const k of [...kv.data.keys()]) if (k.startsWith('staff-sess:')) kv.data.delete(k);
  const back = (await pull(sync, env)).salesLog.find((s) => s.id === 'g1');
  await push(sync, env, { salesLog: [{ ...back, note: 'resent', updatedAt: Date.now() + 5 }] });
  assert.equal((await pull(sync, env)).salesLog.find((s) => s.id === 'g1')._auth.ok, true);
  // …but a stamp copied onto an edited sale does not verify
  await push(sync, env, { salesLog: [{ ...back, items: [{ code: 'TSK', name: 'Tusker', qty: 2, price: 300 }], updatedAt: Date.now() + 9 }] });
  assert.equal((await pull(sync, env)).salesLog.find((s) => s.id === 'g1')._auth.reason, 'unknown-session');
});

test('"staff sessions required": QR codes need a supervisor, bookings a signed-in staff member; only a manager can switch it; off = unchanged', async () => {
  const { env } = await shop();
  const qr = await imp('qr-order.js');
  const call = async (body, tok) => (await qr.onRequestPost({ request: new Request('https://x.pages.dev/api/qr-order?c=C1', { method: 'POST', body: JSON.stringify(body), headers: tok ? { 'X-Staff-Token': tok } : {} }), env })).status;
  assert.equal(await call({ action: 'create', kind: 'table', label: 'Table 1' }), 200, 'off: exactly as before');
  const wanj = (await login(env, { staffId: 'w1', proof: sha('1111') })).d;
  const sam = (await login(env, { staffId: 's1', proof: sha('3333') })).d;
  const admin = (await login(env, { admin: true, proof: sha('shoppass') })).d;
  assert.equal((await login(env, { action: 'mode', mode: 'enforce' }, { 'X-Staff-Token': wanj.token })).status, 403, 'a waiter cannot switch it');
  assert.equal((await login(env, { action: 'mode', mode: 'enforce' }, { 'X-Staff-Token': admin.token })).status, 200);
  assert.equal(await call({ action: 'create', kind: 'table', label: 'Table 2' }), 401, 'no session');
  assert.equal(await call({ action: 'create', kind: 'table', label: 'Table 2' }, wanj.token), 403, 'a waiter cannot manage QR codes');
  assert.equal(await call({ action: 'create', kind: 'table', label: 'Table 2' }, sam.token), 200, 'a supervisor can');
  assert.equal(await call({ action: 'pending' }, wanj.token), 200, 'a waiter can see incoming orders');
  const fb = await imp('facility-book.js');
  const book = async (tok) => (await fb.onRequestPost({ request: new Request('https://x.pages.dev/api/facility-book?c=C1', { method: 'POST', body: JSON.stringify({ booking: { id: 'bk-1', resourceId: 'r', start: Date.now() + 1e6, end: Date.now() + 2e6, status: 'BOOKED' } }), headers: tok ? { 'X-Staff-Token': tok } : {} }), env })).status;
  assert.equal(await book(null), 401); assert.equal(await book(wanj.token), 200);
  assert.equal((await login(env, { action: 'mode', mode: 'off' }, { 'X-Staff-Token': admin.token })).d.mode, 'off');
  assert.equal(await book(null), 200);
});

test('database shops: the PIN is checked against the shop database\'s own staff record', { skip: !hasSqlite }, async () => {
  const { kv, env } = await shop();
  const denv = { mydukapos_kv: kv, SHOP_STORE: await makeBinding() };
  kv.data.set('owner-session:tok', { value: '1' });
  const os = await imp('owner-storage.js');
  const mig = await os.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-storage', { method: 'POST', body: JSON.stringify({ action: 'migrate', clientId: 'C1' }), headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' } }), env: denv });
  assert.equal(mig.status, 200);
  assert.equal((await login(denv, { staffId: 'c1', proof: sha('2222') })).status, 200);
  assert.equal((await login(denv, { staffId: 'c1', proof: sha('0000') })).status, 401);
  assert.equal((await login(denv, { staffId: 'x1', proof: sha('5555') })).status, 403);
  // a sale pushed to the database is stamped too
  const cate = (await login(denv, { staffId: 'c1', proof: sha('2222') })).d;
  const sync = await imp('pos-sync.js');
  await push(sync, denv, { salesLog: [sign(cate, SALE('d1'))] });
  const st = await (await sync.onRequestGet({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1&hot=all'), env: denv, waitUntil() {} })).json();
  assert.equal(st.salesLog.find((s) => s.id === 'd1')._auth.ok, true);
});

test('on the till: the PIN also opens a server session; sales are signed (also the ones made offline before it arrived); API calls carry it', async () => {
  const { env, sync } = await shop();
  let online = false; const seen = [];
  const fetch = async (url, opts = {}) => {
    const u = String(url);
    if (/staff-session/.test(u)) {
      if (!online) throw new TypeError('Failed to fetch');
      return ss.onRequestPost({ request: new Request('https://x.pages.dev/api/staff-session?c=C1', { method: 'POST', body: opts.body }), env });
    }
    if (/qr-order/.test(u)) { seen.push(new Headers(opts.headers || {}).get('X-Staff-Token')); return new Response('{"codes":[]}'); }
    return new Response('{}', { status: 404 });
  };
  const INV = [{ code: 'TSK', type: 'item', name: 'Tusker', category: 'Beer', price: 300, qty: 40, unit: 'pcs', vatCategory: 'A' }];
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_staff: JSON.stringify(STAFF.map((x) => (x.id === 'c1' ? { ...x, pinHash: sha('2222') } : x))) }, fetch, wait: 1500 });
  const { w } = b;   // (the test browser has no PBKDF2: the device keeps the plain form, the server the sealed one)
  w.eval("showToast = function () {}; window.confirm = () => true; queuePrintJob = function () { return Promise.resolve(); }; renderReceipt = function () {}");
  // the device's HMAC is the standard one (the server checks with Web Crypto)
  assert.equal(w.eval("staffSessionHmac('k3y', 'a|b|c')"), hmac('k3y', 'a|b|c'));
  // Cate signs in while OFFLINE and sells: the sale is kept, unsigned for now
  w.eval(`pendingLoginStaffId = 'c1'; document.getElementById('login-staffpin-input').value = '2222'`);
  await w.eval('submitLoginStaffPin()');
  assert.equal(w.eval('currentServer && currentServer.id'), 'c1', w.eval("document.getElementById('login-staffpin-error').textContent + '|' + staff.length"));
  await w.eval("currentPaymentMethod = 'cash'; addToCart('TSK'); document.getElementById('cash-tendered-input').value = '500'; checkoutCart()");
  assert.equal(w.eval('salesLog.length'), 1);
  assert.equal(w.eval('!!salesLog[0].staffAuth'), false);
  // back online: the session arrives and the waiting sale is signed
  online = true;
  w.dispatchEvent(new w.Event('online'));
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(w.eval("staffSessionFor('c1')"), 'session held');
  assert.equal(w.eval('!!salesLog[0].staffAuth'), true, 'signed once the session arrived');
  // a new sale is signed immediately
  await w.eval("addToCart('TSK'); document.getElementById('cash-tendered-input').value = '500'; checkoutCart()");
  assert.equal(w.eval('salesLog.length'), 2);
  assert.ok(w.eval('salesLog[1].staffAuth && salesLog[1].staffAuth.s'));
  // the server confirms both
  await push(sync, env, { salesLog: JSON.parse(w.eval('JSON.stringify(salesLog)')) });
  const got = (await pull(sync, env)).salesLog;
  assert.deepEqual(got.map((s) => s._auth && s._auth.ok), [true, true]);
  assert.deepEqual(got.map((s) => s._auth.name), ['Cashier Cate', 'Cashier Cate']);
  // staff actions carry the session
  await w.eval("fetch('/api/qr-order?c=C1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })");
  assert.match(seen[0] || '', /^s1\./);
  // the report shows who the server confirmed
  w.eval(`(function (g) { salesLog.forEach((s, i) => { s._auth = g[i]._auth; }); })(${JSON.stringify(got)})`);
  const r = JSON.parse(w.eval('JSON.stringify(hospBuildReport({ from: Date.now() - 3600000, to: Date.now() + 60000 }).staffAuth)'));
  assert.equal(r.confirmed, 2); assert.equal(r.flagged.length, 0);
  b.close();
});
