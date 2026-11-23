import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';
import { until, ROOT } from './helpers.mjs';

// zip 368: ONE public "order from home" barcode in every app + the "Online Orders" tab. Real app in jsdom, the REAL /api/qr-order on real SQL.
const qr = await import(pathToFileURL(path.join(ROOT, 'functions/api/qr-order.js')).href);
const withQr = (server) => ({ ...server, fetch: async (url, opts = {}) => {
  const u = new URL(String(url), 'https://shop.mydukapos.store');
  if (!u.pathname.endsWith('/api/qr-order')) return server.fetch(url, opts);
  const method = (opts.method || 'GET').toUpperCase();
  const request = new Request('https://x.pages.dev/api/qr-order?c=C1' + (u.search ? '&' + u.search.slice(1).replace(/^c=[^&]*&?/, '') : ''), { method, body: opts.body, headers: { 'content-type': 'application/json' } });
  return (method === 'POST' ? qr.onRequestPost : qr.onRequestGet)({ request, env: server.env, waitUntil() {} });
} });
const guestPost = async (env, body) => { const r = await qr.onRequestPost({ request: new Request('https://x.pages.dev/api/qr-order?c=C1', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), env }); return { status: r.status, d: await r.json() }; };
const guestGet = async (env, q) => { const r = await qr.onRequestGet({ request: new Request('https://x.pages.dev/api/qr-order?c=C1&' + q), env }); return { status: r.status, d: await r.json() }; };

const ITEMS = [
  { code: 'A', type: 'item', name: 'Alpha Soap', price: 150, wholesalePrice: 50, qty: 40, unit: 'pcs', vatCategory: 'A', category: 'Home' },
  { code: 'B', type: 'item', name: 'Sold Out Thing', price: 90, wholesalePrice: 40, qty: 0, unit: 'pcs', vatCategory: 'A' },
  { code: 'Z', type: 'item', name: 'No Price Yet', price: 0, wholesalePrice: 0, qty: 9, unit: 'pcs', vatCategory: 'A' },
  { code: 'H', type: 'item', name: 'Archived Old', price: 70, wholesalePrice: 30, qty: 9, unit: 'pcs', vatCategory: 'A', archived: true },
];
const QUIET = "showToast = function () {}; window.confirm = () => true; window.prompt = () => 'no'; window.print = () => {}; window.__relayWaitMs = 50;";
import fs from 'node:fs';
const QRLIB = fs.readFileSync(path.join(ROOT, 'order/qrcode.js'), 'utf8');   // the page loads it from /order/qrcode.js; jsdom does not load scripts by address
const open = async (app, server, extra = {}) => { const d = await openDevice(app, withQr(server), { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz', ...extra }, 1000, { indexedDB: new IDBFactory() }); d.w.eval(QUIET); d.w.eval(QRLIB); return d; };
const ALL = ['index.html', 'water/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'carwash/index.html'];

test('every app gets the Online Orders tab, the button, the staff role and the sidebar entry - and no script error', async () => {
  for (const app of ALL) {
    const s = makeServer({ d1: true });
    const d = await openDevice(app, withQr(s), {}, 1100, { indexedDB: new IDBFactory() });
    try {
      const w = d.w; w.eval(QUIET);
      assert.ok(w.document.getElementById('online-orders-tab'), app + ': tab content');
      const btn = w.document.getElementById('online-orders-tab-btn'); assert.ok(btn, app + ': tab button');
      assert.equal(btn.getAttribute('data-tab'), 'online-orders-tab');
      assert.ok(w.eval("LOCKABLE_TABS.some(t => t.id === 'online-orders-tab')"), app + ': can be locked');
      assert.ok(w.eval("ROLE_TABS.some(t => t.id === 'online-orders-tab')"), app + ': can be given to staff');
      assert.equal(w.eval('typeof PUBO'), 'object', app + ': PUBO'); assert.equal(w.eval('typeof PSR'), 'object', app + ': PSR (stock refresh)');
      assert.equal(w.document.getElementById('psr-bar'), null, app + ': zip 379 - no stock bar on the Sales Counter');
      assert.deepEqual((d.errors || []).filter((e) => /pubo|psr|online-orders/i.test(e)), [], app + ': no script error from the new blocks');
    } finally { d.close(); }
  }
});

test('Shop: the code is made by default, EVERYTHING sellable is published, hidden / unpriced / ingredient items are not', async () => {
  const s = makeServer({ d1: true });
  const d = await open('index.html', s);
  try {
    await d.w.eval('PUBO.setup(true)'); await until(() => d.w.eval('!!PUBO.state.code'), 15000);
    const token = d.w.eval('PUBO.state.code.token');
    const g = await guestGet(s.env, 't=' + token);
    assert.equal(g.status, 200); assert.equal(g.d.location.kind, 'online');
    const codes = g.d.menu.items.map((i) => i.code);
    assert.deepEqual(codes, ['A'], 'only the item that is priced, visible, in stock and not an ingredient reaches the customer');
    assert.equal(g.d.menu.items[0].price, 150);
    const m = d.w.eval('JSON.stringify(PUBO.buildMenu())'); const menu = JSON.parse(m);
    assert.deepEqual(menu.items.map((i) => i.code).sort(), ['A', 'B'], 'B is published but marked not available (so the page can say sold out)');
    assert.equal(menu.items.find((i) => i.code === 'B').available, false);
    assert.equal(menu.style, 'shop');
    // running setup again makes no second code
    await d.w.eval('PUBO.setup(true)'); await sleep(300);
    assert.equal(d.w.eval("PUBO.state.codes.filter(c => c.kind === 'online' && c.active).length"), 1);
  } finally { d.close(); }
});

test('Shop: an order from the public code reaches the tab, is accepted once, loads into the cart, and the normal checkout settles it', async () => {
  const s = makeServer({ d1: true });
  const d = await open('index.html', s);
  try {
    const w = d.w;
    await w.eval('PUBO.setup(true)'); await until(() => w.eval('!!PUBO.state.code'), 15000);
    const token = w.eval('PUBO.state.code.token');
    // customer: details are required, then the order goes in
    const bad = await guestPost(s.env, { action: 'order', t: token, key: 'key-bad-00000001', items: [{ code: 'A', qty: 2 }] });
    assert.equal(bad.status, 400, 'no name / phone / address -> refused');
    const ok = await guestPost(s.env, { action: 'order', t: token, key: 'key-good-0000001', name: 'Mary Wanjiku', phone: '0712 345 678', mode: 'delivery', address: 'Kilimani, Rose Ave 5', note: 'call at the gate', items: [{ code: 'A', qty: 2 }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.d));
    await w.eval('PUBO.poll()');
    assert.equal(w.eval('PUBO.state.orders.length'), 1);
    assert.equal(w.document.getElementById('pubo-badge').textContent, '1', 'the tab shows 1 waiting');
    // open the tab: the card shows who, where, what
    w.document.getElementById('online-orders-tab-btn').click(); await sleep(400);
    const html = w.document.getElementById('online-orders-tab').innerHTML;
    assert.match(html, /Mary Wanjiku/); assert.match(html, /Kilimani, Rose Ave 5/); assert.match(html, /call at the gate/); assert.match(html, /2 × Alpha Soap/);
    assert.match(html, /<svg/, 'the QR picture is drawn in the tab');
    // accept (the server lets exactly one claim win)
    w.document.querySelector('#online-orders-tab [data-pubo="accept"]').click();
    await until(() => w.eval("(PUBO.state.orders[0] || {}).status") === 'CLAIMED', 10000);
    // load into the Sales Counter cart
    await sleep(300);
    w.document.querySelector('#online-orders-tab [data-pubo="sale"]').click(); await sleep(300);
    const cart = JSON.parse(w.eval('JSON.stringify(Object.values(currentCart))'));
    assert.equal(cart.length, 1); assert.equal(cart[0].code, 'A'); assert.equal(cart[0].qty, 2);
    assert.ok(w.document.getElementById('pubo-cart-banner'), 'the cashier sees whose order this is');
    assert.match(w.document.getElementById('pubo-cart-banner').textContent, /Mary Wanjiku/);
    // normal checkout (cash)
    w.eval("currentPaymentMethod = 'cash'"); w.document.getElementById('cash-tendered-input').value = '500';
    await w.eval('checkoutCart()'); await sleep(400);
    assert.equal(w.eval('Object.keys(currentCart).length'), 0, 'the sale went through the normal till');
    assert.equal(w.eval('inventory.find(p => p.code === "A").qty'), 38, 'stock came off by the normal sale');
    assert.equal(w.document.getElementById('pubo-cart-banner'), null, 'the banner is gone');
    // the order is marked paid once the sale has reached the transaction database
    await w.eval('pushNow()');
    const paid = await until(async () => {
      await w.eval('PUBO.flush()'); await sleep(400);
      return s.env.LEDGER_DB.query("select status from qr_orders")[0].status === 'PAID';
    }, 25000);
    assert.ok(paid, 'the order was marked PAID after the sale reached the ledger');
  } finally { d.close(); }
});

test('paused: "Taking online orders" off tells customers to ask; the customer page words say shop / staff, never waiter / restaurant', async () => {
  const s = makeServer({ d1: true });
  const d = await open('index.html', s);
  try {
    const w = d.w;
    await w.eval('PUBO.setup(true)'); await until(() => w.eval('!!PUBO.state.code'), 15000);
    w.eval('PUBO.cfg().open = false'); await w.eval('PUBO.publish(true)'); await sleep(300);
    const token = w.eval('PUBO.state.code.token');
    const g = await guestGet(s.env, 't=' + token);
    assert.equal(g.d.open, false); assert.equal(g.d.paused, true);
    const r = await guestPost(s.env, { action: 'order', t: token, key: 'key-paused-000001', name: 'Mary', phone: '0712345678', mode: 'pickup', items: [{ code: 'A', qty: 1 }] });
    assert.equal(r.status, 409);
  } finally { d.close(); }
  const app = fs.readFileSync(path.join(ROOT, 'order/app.js'), 'utf8');
  assert.match(app, /SHOP = menu\.style !== 'food'/);  // zip 377: neutral words for every business assert.match(app, /'Your details, so ' \+ BIZ\(\) \+ ' can reach you:'/);  // zip 376: the real business name
});

test('hospital and pharmacy never publish prescription-only items; hospital publishes no services; water publishes refill sizes', async () => {
  const rx = [{ code: 'P1', type: 'item', name: 'Paracetamol', price: 50, qty: 20, unit: 'pcs', vatCategory: 'A' }, { code: 'P2', type: 'item', name: 'Strong Antibiotic', price: 300, qty: 20, unit: 'pcs', vatCategory: 'A', requiresPrescription: true }, { code: 'S1', type: 'service', name: 'Consultation', price: 500, vatCategory: 'A' }];
  for (const app of ['pharmacy/index.html', 'hospital/index.html']) {
    const s = makeServer({ d1: true }); const d = await openDevice(app, withQr(s), { pos_inventory: JSON.stringify(rx) }, 1100, { indexedDB: new IDBFactory() });
    try { d.w.eval(QUIET); const codes = JSON.parse(d.w.eval('JSON.stringify(PUBO.buildMenu().items.map(i => i.code))'));
      assert.ok(codes.includes('P1'), app); assert.ok(!codes.includes('P2'), app + ': prescription-only is never online');
      if (app.startsWith('hospital')) assert.ok(!codes.includes('S1'), 'hospital care services are not sold by QR'); } finally { d.close(); }
  }
  const s = makeServer({ d1: true }); const d = await openDevice('water/index.html', withQr(s), {}, 1100, { indexedDB: new IDBFactory() });
  try { d.w.eval(QUIET); const m = JSON.parse(d.w.eval('JSON.stringify(PUBO.buildMenu())')); assert.ok(Array.isArray(m.items)); assert.equal(m.style, 'shop'); } finally { d.close(); }
});
