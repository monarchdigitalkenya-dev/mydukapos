import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';

// Zip 142 — shots & kegs (the master update prompt §41 scenarios, and §21–23, §28–31, §33–35, §37). Hospitality only.
const INV = [
  { code: 'JWB', type: 'item', name: 'Johnnie Walker Black', category: 'Whisky', price: 7000, wholesalePrice: 3000, qty: 6, unit: 'pcs', vatCategory: 'A' },
  { code: 'JD', type: 'item', name: "Jack Daniel's", category: 'Whisky', price: 6000, wholesalePrice: 2500, qty: 2, unit: 'pcs', vatCategory: 'A' },
  { code: 'TSKK', type: 'item', name: 'Tusker Lager Keg', category: 'Draught', price: 0, wholesalePrice: 15000, qty: 3, unit: 'pcs', vatCategory: 'A' },
  { code: 'TSKB', type: 'item', name: 'Tusker Bottle 500ml', category: 'Beer', price: 300, wholesalePrice: 180, qty: 24, unit: 'pcs', vatCategory: 'A' },
  { code: 'COKE', type: 'item', name: 'Coke 500ml', category: 'Soft drinks', price: 120, wholesalePrice: 70, qty: 20, unit: 'pcs', vatCategory: 'A' },
];
const STAFF = [
  { id: 'b1', name: 'Barry Bartender', roles: ['service-tab', 'bar-tab', 'hosp-role:bartender'] },
  { id: 's1', name: 'Supervisor Sam', roles: ['bar-tab', 'hosp-role:supervisor', 'perm:payments', 'perm:bar.manage', 'perm:orders.manage', 'perm:orders.void', 'perm:reports'] },
];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app(extra = {}) {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 12']), pos_rooms: JSON.stringify(['Room 204']), pos_staff: JSON.stringify(STAFF), ...extra }, wait: 1500 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => d; queuePrintJob = function () { return Promise.resolve(); }; window.__rr = renderReceipt; renderReceipt = function (s) { (window.__printed = window.__printed || []).push(s.id); }");
  return b;
}
const toasts = (w) => w.eval('window.__toasts || []');
const sell = (w, codes, cash = 100000) => w.eval(`currentPaymentMethod = 'cash'; ${codes.map((c) => `addToCart('${c}')`).join('; ')}; document.getElementById('cash-tendered-input').value = '${cash}'; checkoutCart()`);
const ml = (w, code) => J(w, `hospBottleMlLeft(inventory.find(i => i.code === '${code}'))`);
const keg = (w, id) => J(w, `(function (k) { return { left: kegLeftMl(k), status: k.status, sold: kegSoldMl(k), waste: kegWasteMl(k) }; })(kegs.find(k => k.id === '${id}'))`);
function setupKeg(w) {
  return J(w, "hospConfigureKeg('TSKK', { capacityMl: 50000, lowMl: 5000, servings: [{ label: '300ml', ml: 300, price: 200 }, { label: '500ml', ml: 500, price: 300 }, { label: '1L', ml: 1000, price: 580 }] })");
}

test('§41 SHOT and DOUBLE: 750 ml bottle, 30 ml shot → 720, five more → 570; 60 ml double ×2 → 630; per-product sizes; the sale records the serving', async () => {
  const b = await app(); const { w } = b;
  assert.equal(J(w, 'hospDefaultShotMl()'), 30, 'the business default shot');
  J(w, "hospConfigureBottle('JWB', { bottleMl: 750, servings: [{ label: 'Shot', ml: 30, price: 350 }, { label: 'Double', ml: 60, price: 650 }], bottlePrice: 7000 })");
  J(w, "hospConfigureBottle('JD', { bottleMl: 750, servings: [{ label: 'Shot', ml: 40, price: 380 }, { label: 'Double', ml: 60, price: 700 }] })");
  assert.equal(J(w, "inventory.find(i => i.code === 'JD-shot').pourOf.ml"), 40, 'a product overrides the default');
  assert.equal(ml(w, 'JWB'), 4500);
  await sell(w, ['JWB-shot']);
  assert.deepEqual(J(w, "(p => [p.qty, p.pieceQty])(inventory.find(i => i.code === 'JWB'))"), [5, 720], '5 full + 1 open with 720 ml');
  await sell(w, Array(5).fill('JWB-shot'));
  assert.equal(J(w, "inventory.find(i => i.code === 'JWB').pieceQty"), 570);
  assert.match(J(w, "hospBottleText(inventory.find(i => i.code === 'JWB'))"), /5 full bottle\(s\) · 1 open \(570 ml\) · 4,320 ml in all/);
  // the sale says what was served
  const s = J(w, 'salesLog[salesLog.length - 1].items[0]');
  assert.equal(s.name, 'Johnnie Walker Black — Shot 30ml'); assert.equal(s.qty, 5); assert.equal(s.price, 350);
  assert.deepEqual(s.serving, { kind: 'shot', label: 'Shot', ml: 30, consumedMl: 150 });
  assert.equal(s.wholesalePrice, 120, 'cost of a 30 ml shot = 30/750 of KES 3,000');
  // double: a fresh bottle
  await sell(w, ['JD-double', 'JD-double']);
  assert.deepEqual(J(w, "(p => [p.qty, p.pieceQty])(inventory.find(i => i.code === 'JD'))"), [1, 630]);
  // a whole bottle is a sealed bottle — never the open one
  await sell(w, ['JWB']);
  assert.deepEqual(J(w, "(p => [p.qty, p.pieceQty])(inventory.find(i => i.code === 'JWB'))"), [4, 570]);
  assert.match(J(w, 'salesLog[salesLog.length - 1].items[0].name'), /Johnnie Walker Black — Bottle 750ml/);
  // the bartender's buttons
  w.eval("document.querySelector('.tab-link[data-tab=\"sales-tab\"]').click(); renderBarServePanel()");
  const panel = b.d.getElementById('bar-serve-panel').textContent.replace(/\s+/g, ' ');
  assert.match(panel, /WHISKY[\s\S]*Johnnie Walker Black[\s\S]*SHOT\s?KES 350[\s\S]*DOUBLE\s?KES 650[\s\S]*BOTTLE\s?KES 7,?000/);
  b.close();
});

test('§41 KEG: 50 L keg, 500 ml serving → 49.5 L, ten more → 44.5 L; store count; low alert; wastage needs a reason; measure → variance; replace keeps the history', async () => {
  const b = await app(); const { w, d } = b;
  assert.deepEqual(setupKeg(w), ['TSKK-k300', 'TSKK-k500', 'TSKK-k1000']);
  assert.equal(J(w, "inventory.find(i => i.code === 'TSKK-k500').wholesalePrice"), 150, 'cost: 500 ml of a KES 15,000 50 L keg');
  // nothing tapped: out of stock for staff
  w.eval("addToCart('TSKK-k500')");
  assert.ok(toasts(w).some((t) => /Tusker Lager Keg is OUT OF STOCK/.test(t)));
  const k1 = J(w, "hospAddKeg('TSKK', { tap: 'Tap 1', tag: '#001' })");
  assert.equal(k1.status, 'ACTIVE'); assert.equal(J(w, "inventory.find(i => i.code === 'TSKK').qty"), 2, 'taken from the store');
  await sell(w, ['TSKK-k500']);
  assert.equal(keg(w, k1.id).left, 49500);
  await sell(w, Array(10).fill('TSKK-k500'));
  assert.equal(keg(w, k1.id).left, 44500);
  const s = J(w, 'salesLog[salesLog.length - 1].items[0]');
  assert.deepEqual(s.serving, { kind: 'keg', label: '500ml', ml: 500, consumedMl: 5000 });
  // the customer's receipt shows the serving, never the keg's internals (keg number, litres left) — 80 mm and 58 mm
  for (const width of ['80mm', '58mm']) {
    w.eval(`receiptWidth = '${width}'; __rr(salesLog[salesLog.length - 1])`);
    const txt = String(w.eval('typeof lastReceiptText === "string" ? lastReceiptText : ""'));
    assert.match(txt, /Tusker Lager Keg — 500ml|Tusker Lager Keg —\s*500ml/, width);
    assert.doesNotMatch(txt, /#001|kegDraw|remaining|49\.5 L|44\.5 L/, width);
  }
  assert.deepEqual(s.kegDraw.map((x) => [x.tag, x.ml]), [['#001', 5000]]);
  // wastage: a reason is required; recorded with who / when / device
  assert.equal(w.eval(`hospKegWaste('${k1.id}', 500, '')`), false);
  assert.equal(w.eval(`hospKegWaste('${k1.id}', 500, 'Foam')`), true);
  assert.equal(keg(w, k1.id).left, 44000);
  // physical measure 43 L vs 44 L expected → −1 L variance
  w.eval(`hospKegMeasure('${k1.id}', 43000)`);
  const rec = J(w, `hospKegReconciliation().find(r => r.k.id === '${k1.id}')`);
  assert.deepEqual([rec.opening, rec.sold, rec.waste, rec.expected, rec.physical, rec.variance, rec.revenue], [50000, 5500, 500, 44000, 43000, -1000, 3300]);
  // low alert at 5 L
  await sell(w, Array(39).fill('TSKK-k1000'));
  assert.equal(keg(w, k1.id).left, 5000);
  assert.ok(toasts(w).some((t) => /LOW KEG LEVEL — Tusker Lager Keg #001: 5 L left/.test(t)));
  w.eval("document.querySelector('.tab-link[data-tab=\"bar-tab\"]').click()");
  assert.match(d.getElementById('bar-body').textContent, /LOW KEG LEVEL/);
  assert.equal(d.getElementById('bar-keg-badge').textContent, '1');
  // replace: #001 closed at what's left (written off, history kept), #002 on the same tap
  const k2 = J(w, `hospReplaceKeg('${k1.id}')`);
  assert.equal(keg(w, k1.id).status, 'CLOSED'); assert.equal(keg(w, k1.id).left, 0);
  assert.ok(J(w, `kegs.find(k => k.id === '${k1.id}').events.some(e => e.kind === 'waste' && e.closing && e.ml === 5000)`));
  assert.equal(k2.status, 'ACTIVE'); assert.equal(k2.tap, 'Tap 1'); assert.equal(J(w, "inventory.find(i => i.code === 'TSKK').qty"), 1);
  // audit: every keg action with who, device, reason
  const audit = d.getElementById('bar-body').textContent;
  assert.match(audit, /Bar audit[\s\S]*waste[\s\S]*Foam/);
  b.close();
});

test('§41 MULTIPLE KEGS: #001 with 2 L and #002 full — 500 ml comes from #001 (oldest first); a serving bigger than what is left is split; a full keg connects by itself', async () => {
  const b = await app(); const { w } = b;
  setupKeg(w);
  const a = J(w, "hospAddKeg('TSKK', { tap: 'Tap 1', tag: '#001' })");
  const c = J(w, "hospAddKeg('TSKK', { tag: '#002' })");                 // full, not connected
  w.eval(`kegUse(kegs.find(k => k.id === '${a.id}'), 48000)`);             // #001: 2 L left
  await sell(w, ['TSKK-k500']);
  assert.equal(keg(w, a.id).left, 1500); assert.equal(keg(w, c.id).status, 'FULL');
  await sell(w, ['TSKK-k1000', 'TSKK-k1000']);                              // 2 L: 1.5 from #001, 0.5 from #002 (connected by itself)
  assert.equal(keg(w, a.id).status, 'EMPTY'); assert.equal(keg(w, a.id).left, 0);
  assert.equal(keg(w, c.id).status, 'ACTIVE'); assert.equal(keg(w, c.id).left, 49500);
  assert.deepEqual(J(w, 'salesLog[salesLog.length - 1].items[0].kegDraw').map((x) => [x.tag, x.ml]), [['#001', 1500], ['#002', 500]]);
  // with "connect by itself" off, only active kegs count
  w.eval('hospConfig.kegAutoOpen = false');
  assert.equal(J(w, "hospKegAvailableMl('TSKK')"), 49500);
  b.close();
});

test('TABLE 12: 2 × Tusker 500 ml + 1 × Coke + 2 × whisky shots — each item uses its own stock; a removed keg serving goes back; charged to Room 204; settled through Bills', async () => {
  const b = await app(); const { w } = b;
  setupKeg(w);
  J(w, "hospConfigureBottle('JWB', { bottleMl: 750, servings: [{ label: 'Shot', ml: 30, price: 350 }] })");
  const k = J(w, "hospAddKeg('TSKK', { tap: 'Tap 1' })");
  await w.eval("routeOrderToTab('Table 12'); currentPaymentMethod = 'tab'; addToCart('TSKK-k500'); addToCart('TSKK-k500'); addToCart('COKE'); addToCart('JWB-shot'); addToCart('JWB-shot'); checkoutCart()");
  assert.equal(keg(w, k.id).left, 49000);
  assert.equal(J(w, "inventory.find(i => i.code === 'COKE').qty"), 19);
  assert.equal(ml(w, 'JWB'), 4500 - 60);
  const tab = J(w, "findOpenTabByLabel('Table 12')");
  const beer = J(w, `hospTabLines(tabs.find(t => t.id === '${tab.id}')).find(l => l.code === 'TSKK-k500')`);
  assert.deepEqual(beer.kegDraw.map((x) => x.ml), [1000]);
  assert.equal(w.eval(`hospReduceLine('${tab.id}', '${beer.lineId}', 1, 'wrong order')`), true);
  assert.equal(keg(w, k.id).left, 49500, 'only the one removed serving goes back');
  // a guest in Room 204: the table's bill goes on the folio
  w.eval("roomStays['Room 204'] = { guestName: 'Jane', checkInAt: Date.now(), nightlyRate: 5000 }; saveRoomStays()");
  assert.equal(w.eval(`hospChargeToRoom('${tab.id}', 'Room 204')`), true);
  const room = J(w, "findOpenTabByLabel('Room 204')");
  assert.deepEqual(J(w, `hospTabLines(tabs.find(t => t.id === '${room.id}')).map(l => l.name + ' x' + l.qty)`).sort(), ['Coke 500ml x1', 'Johnnie Walker Black — Shot 30ml x2', 'Tusker Lager Keg — 500ml x1']);
  assert.equal(keg(w, k.id).left, 49500, 'moving to the room serves nothing again');
  // room service straight to the room, then settled through the normal settle screen
  w.eval(`hospAddProduct('${room.id}', 'TSKK-k500', 2)`);
  assert.equal(keg(w, k.id).left, 48500);
  w.eval(`settleTabDirect('${room.id}'); document.getElementById('tab-settle-cash-tendered-input').value = '10000'; confirmTabSettle()`);
  const sale = J(w, 'salesLog[salesLog.length - 1]');
  assert.equal(sale.tableOrRoom, 'Room 204');
  assert.equal(sale.items.filter((i) => i.code === 'TSKK-k500').reduce((n, i) => n + i.qty, 0), 3);
  // reports
  const r = J(w, 'hospBuildReport({ from: Date.now() - 3600000, to: Date.now() + 60000 })');
  assert.deepEqual(r.drinks.beverages.find((x) => x[0] === 'Tusker Lager Keg'), ['Tusker Lager Keg', '500ml 500ml', 3, '1.5 L', 'KES 900']);
  assert.ok(r.kegRec.some((x) => x.k.id === k.id && x.sold === 1500 && x.revenue === 900));
  b.close();
});

test('QR ordering: keg and shot servings are on the published menu (only when there is stock) and an accepted order serves them from the keg', async () => {
  let pending = [];
  const fetch = async (url, opts = {}) => {
    if (/qr-order/.test(String(url))) {
      const body = JSON.parse(opts.body || '{}');
      if (body.action === 'publishMenu') return new Response(JSON.stringify({ ok: true, items: body.menu.items.length }));
      if (body.action === 'pending') return new Response(JSON.stringify({ orders: pending }));
      if (body.action === 'decide') return new Response(JSON.stringify({ ok: true, order: { ...pending[0], status: 'ACCEPTED' } }));
    }
    return new Response('{}', { status: 404 });
  };
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 12']) }, fetch, wait: 1500 });
  const { w } = b;
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; queuePrintJob = function () { return Promise.resolve(); }");
  setupKeg(w);
  let menu = J(w, 'hospBuildPublicMenu()');
  assert.equal(menu.items.find((i) => i.code === 'TSKK-k500').available, false, 'no keg on tap: not orderable');
  const k = J(w, "hospAddKeg('TSKK', { tap: 'Tap 1' })");
  menu = J(w, 'hospBuildPublicMenu()');
  assert.deepEqual([menu.items.find((i) => i.code === 'TSKK-k500').available, menu.items.find((i) => i.code === 'TSKK-k500').price], [true, 300]);
  pending = [{ id: 'qo-1', label: 'Table 12', kind: 'table', items: [{ code: 'TSKK-k500', name: 'Tusker Lager Keg — 500ml', qty: 2, price: 300 }], total: 600, createdAt: Date.now() }];
  w.eval(`hospQrPending = ${JSON.stringify(pending)}`);
  const tabId = await w.eval("hospAcceptQrOrder('qo-1')");
  assert.ok(tabId);
  assert.equal(keg(w, k.id).left, 49000);
  b.close();
});

test('permissions: a bartender sells shots and keg servings but cannot set up drinks, add / replace kegs or record wastage; a supervisor can', async () => {
  const b = await app(); const { w, d } = b;
  setupKeg(w);
  const k = J(w, "hospAddKeg('TSKK', { tap: 'Tap 1' })");
  w.eval("currentServer = staff.find(s => s.id === 'b1')");
  w.eval("routeOrderToTab('Table 12'); currentPaymentMethod = 'tab'; addToCart('TSKK-k500'); checkoutCart()");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(keg(w, k.id).left, 49500, 'the bartender served');
  assert.equal(J(w, "hospConfigureKeg('TSKK', { capacityMl: 30000, servings: [] })"), null);
  assert.equal(J(w, "hospAddKeg('TSKK', {})"), null);
  assert.equal(w.eval(`hospKegWaste('${k.id}', 500, 'Foam')`), false);
  assert.equal(w.eval(`hospSetKegStatus('${k.id}', 'CLOSED', 'x')`), false);
  assert.equal(w.eval("hospSetDefaultShot(40)"), false);
  w.eval("document.querySelector('.tab-link[data-tab=\"bar-tab\"]').click()");
  assert.doesNotMatch(d.getElementById('bar-body').textContent, /Set up a drink|💧 Wastage|Take a keg from the store|🔁 Replace/);
  assert.match(d.getElementById('bar-body').textContent, /🛢️ Kegs[\s\S]*Tusker Lager Keg[\s\S]*ready to serve/, 'the bartender sees the kegs');
  w.eval("currentServer = staff.find(s => s.id === 's1')");
  assert.equal(w.eval(`hospKegWaste('${k.id}', 500, 'Foam')`), true);
  assert.equal(w.eval("hospSetDefaultShot(40)"), true);
  assert.ok(J(w, 'hospConfig.barLog').some((e) => e.action === 'default shot size' && e.prev === '30 ml' && e.next === '40 ml' && e.by === 'Supervisor Sam'));
  b.close();
});

// ---------- offline + two devices: the counters add up, and a re-sent push changes nothing ----------
async function twoTills() {
  const base = await app({ pos_device_id: 'dev-A' });
  setupKeg(base.w);
  const k = J(base.w, "hospAddKeg('TSKK', { tap: 'Tap 1', tag: '#001' })");
  const invNow = base.w.eval('JSON.stringify(inventory)');
  const kegsNow = base.w.eval('JSON.stringify(kegs)');
  const A = base;
  const B = await app({ pos_device_id: 'dev-B', pos_inventory: invNow, pos_kegs: kegsNow });
  return { A, B, k };
}
test('OFFLINE + TWO TILLS: each till sells from the same keg with no internet; both sync; the keg is down by both; syncing again changes nothing; receipts still print', async () => {
  const { A, B, k } = await twoTills();
  // offline: no network at all
  for (const x of [A, B]) x.w.eval("window.posNetOffline = () => true");
  await sell(A.w, ['TSKK-k500']);                               // bartender A
  await sell(B.w, ['TSKK-k500']);                               // bartender B, same moment, other till
  await sell(A.w, ['TSKK-k500', 'TSKK-k500']);                  // 3 on A in all
  assert.equal(keg(A.w, k.id).left, 48500); assert.equal(keg(B.w, k.id).left, 49500);
  assert.equal(J(A.w, 'salesLog.length'), 2); assert.equal(J(B.w, 'salesLog.length'), 1);
  assert.equal(J(A.w, '(window.__printed || []).length'), 2, 'each offline sale got its receipt');
  // back online: both push to the real sync endpoint (single-record shop), in either order, and one pushes twice
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const sync = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);
  const push = (w) => sync.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ updatedAt: Date.now(), kegs: JSON.parse(w.eval('JSON.stringify(kegs)')), salesLog: JSON.parse(w.eval('JSON.stringify(salesLog)')) }) }), env, waitUntil() {} });
  await push(B.w); await push(A.w); await push(A.w);
  const st = await (await sync.onRequestGet({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1'), env, waitUntil() {} })).json();
  const sk = st.kegs.find((x) => x.id === k.id);
  const left = sk.capacityMl - Object.values(sk.usedBy).reduce((n, u) => n + u.ml, 0);
  assert.equal(left, 48000, '4 × 500 ml, from both tills, counted once each');
  assert.equal(st.salesLog.length, 3, 'no sale lost, none doubled');
  // each till applies the server's copy: both show 48 L — and B's own unsent change would survive a pull too
  for (const x of [A, B]) x.w.eval(`kegs = hospMergeKegLists(kegs, ${JSON.stringify(st.kegs)})`);
  assert.equal(keg(A.w, k.id).left, 48000); assert.equal(keg(B.w, k.id).left, 48000);
  await sell(B.w, ['TSKK-k500']);
  B.w.eval(`kegs = hospMergeKegLists(kegs, ${JSON.stringify(st.kegs)})`);         // a pull of the older server copy
  assert.equal(keg(B.w, k.id).left, 47500, 'an unsent serving survives a pull');
  A.close(); B.close();
});

test('two tills in a shop database (atomic per shop): the same keg served on both ends right', { skip: !hasSqlite }, async () => {
  const { A, B, k } = await twoTills();
  await sell(A.w, ['TSKK-k500']); await sell(B.w, ['TSKK-k500']);
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, SHOP_STORE: await makeBinding() };
  kv.data.set('pos-data:mode:C1', { value: 'do' });
  const sync = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);
  const push = (w) => sync.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ updatedAt: Date.now(), kegs: JSON.parse(w.eval('JSON.stringify(kegs)')) }) }), env, waitUntil() {} });
  await Promise.all([push(A.w), push(B.w)]); await push(B.w);
  const st = await (await sync.onRequestGet({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1&hot=all'), env, waitUntil() {} })).json();
  const sk = st.kegs.find((x) => x.id === k.id);
  assert.equal(sk.capacityMl - Object.values(sk.usedBy).reduce((n, u) => n + u.ml, 0), 49000);
  A.close(); B.close();
});

test('RETAIL: packaged drinks sell as before and there is no keg (or shot) management anywhere in the Retail app', async () => {
  const inv = [{ code: 'TSKB', type: 'item', name: 'Tusker Bottle 500ml', category: 'Beer', price: 300, wholesalePrice: 180, qty: 24, unit: 'pcs', vatCategory: 'A' }];
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(inv) }, wait: 1500 });
  const { w, d } = b;
  w.eval("showToast = function () {}; queuePrintJob = function () { return Promise.resolve(); }; renderReceipt = function () {}");
  await w.eval("currentPaymentMethod = 'cash'; addToCart('TSKB'); addToCart('TSKB'); document.getElementById('cash-tendered-input').value = '1000'; checkoutCart()");
  assert.equal(J(w, "inventory.find(i => i.code === 'TSKB').qty"), 22);
  for (const fn of ['hospAddKeg', 'hospConfigureKeg', 'hospKegWaste', 'hospConfigureBottle', 'renderBarTab', 'renderBarServePanel']) assert.equal(w.eval(`typeof ${fn}`), 'undefined', fn);
  assert.equal(d.querySelector('[data-tab="bar-tab"]'), null);
  const vis = d.body.cloneNode(true); vis.querySelectorAll('script, style').forEach((x) => x.remove());
  assert.doesNotMatch(vis.textContent, /Bar & Kegs|LOW KEG|Take a keg|keg/i);
  b.close();
});
