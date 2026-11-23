import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// Zip 292 - Hotel POS: per-item stations (Kitchen / Bar / None), bill printed = off the kitchen & bar board, waiter-own-orders, alert sounds.
const INV = [
  { code: 'BRG', type: 'service', name: 'Beef Burger', category: 'Mains', price: 650, wholesalePrice: 250, unit: 'pcs', vatCategory: 'A' },
  { code: 'TSK', type: 'item', name: 'Tusker Lager', category: 'Beer', price: 300, wholesalePrice: 180, qty: 48, unit: 'pcs', vatCategory: 'A' },
  { code: 'WTR', type: 'item', name: 'Mineral Water', category: 'Water', price: 100, wholesalePrice: 40, qty: 90, unit: 'pcs', vatCategory: 'A' },
  { code: 'SND', type: 'service', name: 'Club Sandwich', category: 'Mains', price: 400, wholesalePrice: 150, unit: 'pcs', vatCategory: 'A' },
];
const STAFF = [
  { id: 'w1', name: 'Wanjiru', roles: ['service-tab', 'tabs-tab', 'hosp-role:waiter'] },
  { id: 'w2', name: 'Otieno', roles: ['service-tab', 'tabs-tab', 'hosp-role:waiter'] },
  { id: 'c1', name: 'Cashier Cate', roles: ['service-tab', 'bills-tab', 'hosp-role:cashier', 'perm:payments', 'perm:orders.viewAll'] },
  { id: 's1', name: 'Supervisor Sam', roles: ['service-tab', 'hosp-role:supervisor', 'perm:payments', 'perm:orders.viewAll', 'perm:orders.void', 'perm:orders.manage'] },
];
const STORE = () => ({ pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 05', 'Table 06', 'Table 07']), pos_staff: JSON.stringify(STAFF), pos_kitchen_ticket_enabled: 'true' });
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const as = (w, id) => w.eval(`currentServer = staff.find(s => s.id === '${id}') || null`);
const quiet = (w) => w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => d; queuePrintJob = function () { return Promise.resolve(); }");
async function app() { const b = await boot('hotel/index.html', { storage: STORE(), wait: 1500 }); quiet(b.w); return b; }
async function order(w, who, table, codes) {
  as(w, who);
  await w.eval(`routeOrderToTab('${table}'); currentPaymentMethod = 'tab'; ${codes.map((c) => `addToCart('${c}')`).join('; ')}; checkoutCart()`);
  return J(w, `findOpenTabByLabel('${table}')`);
}
const board = (w, st) => J(w, `kdsBoardModel('${st}')`).cols;
const names = (w, st) => { const c = board(w, st); return [].concat(c.new, c.prep, c.ready).flatMap((x) => x.lines.map((l) => l.name)).sort(); };

test('A. a standard food order reaches the Kitchen only, as a New ticket, with a bell for the new line', async () => {
  const b = await app(); const { w } = b;
  let rings = 0;
  w.eval('window.AudioContext = window.webkitAudioContext = function () { const mk = () => ({ connect() {}, start() { window.__osc = (window.__osc || 0) + 1; }, stop() {}, frequency: { value: 0 }, gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} } }); return { state: "running", currentTime: 0, destination: {}, createOscillator: mk, createGain: mk, createDynamicsCompressor: mk, resume() {} }; }; kdsAudio = null');
  const el = w.document.createElement('div'); el.id = 'probe'; w.document.body.appendChild(el);
  w.eval("kdsPaint(document.getElementById('probe'), 'kitchen', false, true)");          // the board is open and empty
  await order(w, 'w1', 'Table 05', ['BRG']);
  w.eval("kdsPaint(document.getElementById('probe'), 'kitchen', false, true)");
  assert.deepEqual(names(w, 'kitchen'), ['Beef Burger']);
  assert.deepEqual(names(w, 'bar'), []);
  assert.ok(w.eval('window.__osc') > 0, 'the alert sound played for the new order');
  const rang = w.eval('window.__osc');
  w.eval("kdsPaint(document.getElementById('probe'), 'kitchen', false, true)");          // painting again: not new any more
  assert.equal(w.eval('window.__osc'), rang, 'no second ring for the same order');
  const tab = J(w, "findOpenTabByLabel('Table 05')"), ln = J(w, `hospTabLines(findOpenTabByLabel('Table 05'))[0]`);
  w.eval(`hospSetLineStatus('${tab.id}', '${ln.lineId}', 'PREPARING')`);
  w.eval("kdsPaint(document.getElementById('probe'), 'kitchen', false, true)");
  assert.equal(w.eval('window.__osc'), rang, 'a status change does not ring');
  b.close();
});

test('B. a bar order reaches the Bar only', async () => {
  const b = await app(); const { w } = b;
  await order(w, 'w1', 'Table 05', ['TSK']);
  assert.deepEqual(names(w, 'bar'), ['Tusker Lager']);
  assert.deepEqual(names(w, 'kitchen'), []);
  b.close();
});

test('C. a mixed order is split per station; an item can be set to Kitchen, Bar or None and it follows ONLY that; a change affects future orders only', async () => {
  const b = await app(); const { w } = b;
  await order(w, 'w1', 'Table 05', ['BRG', 'TSK']);
  assert.deepEqual(names(w, 'kitchen'), ['Beef Burger']);
  assert.deepEqual(names(w, 'bar'), ['Tusker Lager']);
  // Mineral water: explicitly "None" (nothing to prepare): on neither board, and no ticket
  w.eval("hospSetItemStation('WTR', 'none')");
  await order(w, 'w1', 'Table 06', ['WTR']);
  assert.deepEqual(names(w, 'kitchen'), ['Beef Burger']); assert.deepEqual(names(w, 'bar'), ['Tusker Lager']);
  // a sandwich forced to the Bar: only the Bar
  w.eval("hospSetItemStation('SND', 'bar')");
  await order(w, 'w1', 'Table 07', ['SND']);
  assert.deepEqual(names(w, 'bar'), ['Club Sandwich', 'Tusker Lager']); assert.deepEqual(names(w, 'kitchen'), ['Beef Burger']);
  // moving the burger to the Bar changes FUTURE orders only
  w.eval("hospSetItemStation('BRG', 'bar')");
  assert.deepEqual(names(w, 'kitchen'), ['Beef Burger'], 'the order already sent stays in the Kitchen');
  await order(w, 'w1', 'Table 05', ['BRG']);
  assert.equal(names(w, 'bar').filter((n) => n === 'Beef Burger').length, 1, 'the new burger goes to the Bar');
  assert.equal(names(w, 'kitchen').filter((n) => n === 'Beef Burger').length, 1, 'and never to both');
  // the editor shows the field and saves it
  w.eval("openInventoryEditModal('TSK')");
  const sel = w.document.getElementById('inv-edit-station-select');
  assert.ok(sel, 'the item editor has the station field');
  sel.value = 'kitchen'; sel.dispatchEvent(new w.Event('change'));
  assert.equal(w.eval("hospConfig.itemStations['TSK']"), 'kitchen');
  assert.ok(w.document.getElementById('inv-station'), 'the Add item form has it too');
  b.close();
});

test('D. printing the bill takes the order off the Kitchen and Bar boards at any stage, once, without deleting anything', async () => {
  const b = await app(); const { w } = b;
  const tab = await order(w, 'w1', 'Table 05', ['BRG', 'TSK']);
  const lines = J(w, "hospTabLines(findOpenTabByLabel('Table 05'))");
  w.eval(`hospSetLineStatus('${tab.id}', '${lines[0].lineId}', 'PREPARING')`);               // kitchen is half way; the bar item is still New
  assert.equal(w.eval(`hospSettleForBilling('${tab.id}')`), true);
  const t = J(w, `tabs.find(x => x.id === '${tab.id}')`);
  assert.ok(t.billPrintedAt, 'recorded'); assert.equal(t.billStatus, 'BILLED'); assert.equal(t.status, 'OPEN', 'not paid');
  assert.deepEqual(names(w, 'kitchen'), []); assert.deepEqual(names(w, 'bar'), []);
  assert.equal(J(w, `hospTabLines(tabs.find(x => x.id === '${tab.id}'))`).length, 2, 'lines and history stay');
  assert.equal(J(w, `tabs.find(x => x.id === '${tab.id}').lineStatus['${lines[0].lineId}'].st`), 'PREPARING', 'statuses untouched');
  // printing again: same result, nothing re-appears, only a counter moves
  const first = t.billFirstPrintedAt;
  w.eval(`hospPrintCustomerBill('${tab.id}')`);
  const t2 = J(w, `tabs.find(x => x.id === '${tab.id}')`);
  assert.equal(t2.billFirstPrintedAt, first); assert.equal(t2.billPrintCount, 2);
  assert.deepEqual(names(w, 'kitchen'), []);
  // something added after the bill (a reopen) comes back to the board; the earlier items stay off
  as(w, 's1'); w.eval(`hospReopenBill('${tab.id}')`);
  await sleep(5);
  w.eval(`hospAddProduct('${tab.id}', 'BRG', 1)`);
  assert.equal(names(w, 'kitchen').length, 1, 'only the new round');
  b.close();
});

test('E. successful payment: a printed-but-unpaid bill stays on the waiter list; partial payment keeps it; full payment clears it', async () => {
  const b = await app(); const { w } = b;
  const tab = await order(w, 'w1', 'Table 05', ['BRG', 'TSK']);                     // 950
  w.eval("renderServiceOrders()");
  w.eval(`hospSettleForBilling('${tab.id}')`);
  as(w, 'w1'); w.eval('renderServiceOrders()');
  assert.match(w.document.getElementById('svc-active-orders').innerHTML, /Table 05/i, 'billed, unpaid: still visible');
  assert.match(w.document.getElementById('svc-active-orders').innerHTML, /bill printed/);
  w.eval(`openHospPanel('${tab.id}'); closeHospPanel()`);                              // viewing does not remove it
  assert.equal(J(w, 'hospVisibleTabs().length'), 1);
  as(w, 'c1');
  w.eval(`settleTabDirect('${tab.id}'); document.getElementById('tab-settle-cash-tendered-input').value = '400'; confirmTabSettle()`);
  as(w, 'w1'); assert.equal(J(w, 'hospVisibleTabs().length'), 1, 'part-paid: still there');
  assert.equal(J(w, `tabs.find(x => x.id === '${tab.id}').status`), 'OPEN');
  as(w, 'c1');
  w.eval(`settleTabDirect('${tab.id}'); document.getElementById('tab-settle-cash-tendered-input').value = '1000'; confirmTabSettle()`);
  as(w, 'w1'); assert.equal(J(w, 'hospVisibleTabs().length'), 0, 'fully paid: gone from the waiter list');
  assert.equal(J(w, `tabs.find(x => x.id === '${tab.id}').status`), 'CLOSED');
  assert.equal(J(w, 'salesLog.length') >= 1, true, 'the sale and its history remain');
  b.close();
});

test('F. a failed bill print leaves the order on the board and un-billed; a short payment closes nothing', async () => {
  const b = await app(); const { w } = b;
  const tab = await order(w, 'w1', 'Table 05', ['BRG']);
  w.eval("window.__realRender = renderSharedReceipt; renderSharedReceipt = function () { throw new Error('printer jammed'); }");
  assert.equal(w.eval(`hospSettleForBilling('${tab.id}')`), false);
  const t = J(w, `tabs.find(x => x.id === '${tab.id}')`);
  assert.ok(!t.billPrintedAt); assert.notEqual(t.billStatus, 'BILLED');
  assert.deepEqual(names(w, 'kitchen'), ['Beef Burger'], 'still on the kitchen board');
  w.eval('renderSharedReceipt = window.__realRender');
  assert.equal(w.eval(`hospSettleForBilling('${tab.id}')`), true, 'a retry works');
  assert.deepEqual(names(w, 'kitchen'), []);
  as(w, 'c1');
  w.eval(`settleTabDirect('${tab.id}'); document.getElementById('tab-settle-cash-tendered-input').value = '100'; confirmTabSettle()`);
  assert.equal(J(w, `tabs.find(x => x.id === '${tab.id}').status`), 'OPEN', 'not paid in full: not closed');
  b.close();
});

test('G. staff access: a waiter sees and opens only their own orders; the cashier and supervisor see all with the waiter named', async () => {
  const b = await app(); const { w } = b;
  const t1 = await order(w, 'w1', 'Table 05', ['BRG']);
  const t2 = await order(w, 'w2', 'Table 06', ['TSK']);
  as(w, 'w1');
  assert.deepEqual(J(w, 'hospVisibleTabs().map(t => t.label)'), ['Table 05']);
  w.eval(`openHospPanel('${t2.id}')`);
  assert.equal(J(w, 'hospPanelTabId'), null, 'another waiter\'s order cannot be opened by id');
  assert.ok((w.eval('window.__toasts') || []).some((m) => /another waiter/.test(m)));
  assert.equal(J(w, `hospTabAllowed(tabs.find(x => x.id === '${t2.id}'))`), false);
  as(w, 'w2'); assert.deepEqual(J(w, 'hospVisibleTabs().map(t => t.label)'), ['Table 06']);
  for (const who of ['c1', 's1']) {
    as(w, who);
    assert.deepEqual(J(w, 'hospVisibleTabs().map(t => t.label).sort()'), ['Table 05', 'Table 06']);
    w.eval('renderServiceOrders()');
    const html = w.document.getElementById('svc-active-orders').innerHTML;
    assert.match(html, /svc-waiter-tag[^>]*>👤 Wanjiru/); assert.match(html, /svc-waiter-tag[^>]*>👤 Otieno/);
  }
  as(w, 'w1'); w.eval('renderServiceOrders()');
  assert.doesNotMatch(w.document.getElementById('svc-active-orders').innerHTML, /Table 06|Otieno/);
  b.close();
});

test('H. two devices: an order made on one appears on the other, and a bill printed on one takes it off the other\'s board', async () => {
  const s = makeServer();
  const a = await openDevice('hotel/index.html', s, STORE(), 1500);
  quiet(a.w);
  const tab = await order(a.w, 'w1', 'Table 05', ['BRG', 'TSK']);
  await a.w.eval('pushNow()');
  const k = await openDevice('hotel/index.html', s, deviceStorage(a.w), 1500);          // a kitchen screen
  quiet(k.w);
  await k.w.eval('pullState()');
  assert.deepEqual(names(k.w, 'kitchen'), ['Beef Burger']);
  assert.deepEqual(names(k.w, 'bar'), ['Tusker Lager']);
  as(a.w, 'w1'); a.w.eval(`hospSettleForBilling('${tab.id}')`);
  await a.w.eval('pushNow()');
  await k.w.eval('pullState()');
  assert.deepEqual(names(k.w, 'kitchen'), [], 'the bill printed elsewhere clears this board'); assert.deepEqual(names(k.w, 'bar'), []);
  assert.ok(k.w.eval(`tabs.find(x => x.id === '${tab.id}').billPrintedAt`));
  // a duplicate sync of the same state changes nothing
  await a.w.eval('pushNow()'); await k.w.eval('pullState()');
  assert.equal(k.w.eval('tabs.length'), 1);
  a.close(); k.close();
});

test('I. existing behaviour: alerts have five sounds, a preview and saved settings; a rush order, a closed tab\'s unserved items and the printers still work', async () => {
  const b = await app(); const { w } = b;
  assert.deepEqual(Object.keys(J(w, 'KDS_SOUNDS')), ['service', 'kitchen', 'chime', 'hotel', 'urgent']);
  w.eval("renderServiceChargeSetting()");
  const box = w.document.getElementById('svc-charge-settings');
  assert.match(box.innerHTML, /Kitchen &amp; bar alert sound/); assert.match(box.innerHTML, /Preview/); assert.match(box.innerHTML, /Loud/); assert.match(box.innerHTML, /Repeat the alert/);
  w.eval("kdsSoundSet('pack', 'urgent'); kdsSoundSet('volume', 90); kdsSoundSet('loud', true); kdsSoundSet('repeat', true)");
  const saved = JSON.parse(w.eval("localStorage.getItem('pos_kds_sound_cfg')"));
  assert.equal(saved.pack, 'urgent'); assert.equal(saved.volume, 90); assert.equal(saved.loud, true); assert.equal(saved.repeat, true);
  w.eval("kdsSoundSet('enabled', false)");
  assert.equal(w.eval("kdsPlay('service')"), false, 'switched off: silent');
  const tab = await order(w, 'w1', 'Table 05', ['BRG']);
  w.eval(`hospSetPriority('${tab.id}', true)`);
  assert.equal(J(w, "kdsBoardModel('kitchen').cols.new[0].rush"), true);
  // paid before it was made: still on the board, bill never printed
  as(w, 'c1');
  w.eval(`settleTabDirect('${tab.id}'); document.getElementById('tab-settle-cash-tendered-input').value = '1000'; confirmTabSettle()`);
  assert.deepEqual(names(w, 'kitchen'), ['Beef Burger'], 'paid but not billed: the kitchen still makes it');
  b.close();
});
