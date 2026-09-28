import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';

// Zip 134 — Hospitality OS phase 1: ONE order engine on the existing tabs. Waiter orders, kitchen / bar split, only the change
// prints, exchange, settle for billing → cashier, service charge, move / split / merge, audit.
const APP = 'hotel/index.html';
const INV = [
  { code: 'BRG', type: 'service', name: 'Beef Burger', category: 'Mains', price: 650, wholesalePrice: 0, unit: 'pcs', vatCategory: 'A' },
  { code: 'CHP', type: 'service', name: 'Chips', category: 'Sides', price: 200, wholesalePrice: 0, unit: 'pcs', vatCategory: 'A' },
  { code: 'WNG', type: 'service', name: 'Chicken Wings', category: 'Mains', price: 550, wholesalePrice: 0, unit: 'pcs', vatCategory: 'A' },
  { code: 'FNT', type: 'item', name: 'Fanta 500ml', category: 'Soft drinks', price: 100, wholesalePrice: 60, qty: 24, unit: 'pcs', vatCategory: 'A' },
  { code: 'CKE', type: 'item', name: 'Coke 500ml', category: 'Soft drinks', price: 120, wholesalePrice: 60, qty: 24, unit: 'pcs', vatCategory: 'A' },
  { code: 'TSK', type: 'item', name: 'Tusker Lager', category: 'Beer', price: 300, wholesalePrice: 180, qty: 48, unit: 'pcs', vatCategory: 'A' },
];
const STAFF = [{ id: 'w1', name: 'Wanjiru', roles: ['service-tab', 'tabs-tab'] }, { id: 'w2', name: 'Otieno', roles: ['service-tab'] }, { id: 'm1', name: 'Mo', isManager: true, roles: ['service-tab', 'tabs-tab', 'bills-tab'] }];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app() {
  const b = await boot(APP, { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 05', 'Table 06']), pos_rooms: JSON.stringify(['Room 205']), pos_staff: JSON.stringify(STAFF), pos_kitchen_ticket_enabled: 'true' }, wait: 1500 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => (window.__promptAnswers && window.__promptAnswers.length ? window.__promptAnswers.shift() : 'test reason'); window.print = () => {}");
  b.w.eval('window.__tickets = []; queuePrintJob = function () { window.__tickets.push(lastKitchenTicketText); return Promise.resolve(); }');
  return b;
}
const as = (w, id) => w.eval(`currentServer = staff.find(s => s.id === '${id}') || null`);
const lastTicket = (w) => J(w, 'window.__tickets[window.__tickets.length - 1] || ""');
const qty = (w, code) => Number(w.eval(`inventory.find(p => p.code === '${code}').qty`));
const tabOf = (w, label) => J(w, `tabs.find(t => t.label === '${label}' && t.status === 'OPEN')`);
const lineOf = (w, label, code) => J(w, `hospTabLines(tabs.find(t => t.label === '${label}' && t.status === 'OPEN')).find(l => l.code === '${code}')`);

test('RESTAURANT end to end: waiter opens Table 05 → kitchen gets food, bar gets drinks → an added item prints ALONE → exchange → settle for billing → cashier takes payment → one receipt', async () => {
  const b = await app(); const { w, d } = b;
  as(w, 'w1');
  w.eval(`document.querySelector('.tab-link[data-tab="service-tab"]').click()`);
  d.getElementById('svc-new-location').value = 'Table 05'; d.getElementById('svc-new-type').value = 'DINE_IN';
  // zip 147: the waiter builds the order ON THE ORDERS TAB (a waiter has no Sales Counter) — round 1: 2 burgers, 1 chips, 1 fanta, 2 beers
  w.eval("svcAdd('BRG'); svcAdd('BRG'); svcAdd('CHP'); svcAdd('FNT'); svcAdd('TSK'); svcAdd('TSK'); svcPostOrder()");
  let tab = tabOf(w, 'Table 05');
  assert.deepEqual([tab.waiter, tab.orderType, tab.source], ['Wanjiru', 'DINE_IN', 'WAITER']);
  assert.ok(d.getElementById('service-tab').classList.contains('active'), 'the waiter stays on the Orders tab');
  const t1 = lastTicket(w);
  const [kitchen, bar] = [t1.slice(t1.indexOf('KITCHEN'), t1.indexOf('BAR')), t1.slice(t1.indexOf('BAR'))];
  assert.match(kitchen, /KOT[\s\S]*2x\s+Beef Burger[\s\S]*1x\s+Chips/);
  assert.doesNotMatch(kitchen, /Tusker|Fanta/, 'no drinks on the kitchen ticket');
  assert.match(bar, /BOT[\s\S]*1x\s+Fanta[\s\S]*2x\s+Tusker/);
  assert.doesNotMatch(bar, /Burger|Chips/, 'no food on the bar ticket');
  assert.equal(qty(w, 'TSK'), 46);
  // waiter adds wings: ONLY the wings print
  tab = tabOf(w, 'Table 05');
  w.eval(`hospAddProduct('${tab.id}', 'WNG', 1)`);
  const t2 = lastTicket(w);
  assert.match(t2, /ADDED:\s+1x\s+Chicken Wings/);
  assert.doesNotMatch(t2, /Burger|Chips|Tusker|Fanta/, 'the original order is NOT printed again');
  assert.doesNotMatch(t2, /BAR ORDER/, 'nothing for the bar');
  // exchange Fanta → Coke: the bar gets the change only; stock follows; price difference follows
  const fanta = lineOf(w, 'Table 05', 'FNT');
  w.eval(`window.__promptAnswers = []; hospExchangeLine('${tab.id}', '${fanta.lineId}', 'CKE', 'Customer changed mind')`);
  const t3 = lastTicket(w);
  assert.match(t3, /CANCEL:\s+1x\s+Fanta[\s\S]*INSTEAD:\s+1x\s+Coke/);
  assert.doesNotMatch(t3, /KITCHEN/);
  assert.equal(qty(w, 'FNT'), 24, 'Fanta back in stock'); assert.equal(qty(w, 'CKE'), 23);
  // reduce with a reason; without a reason it is refused
  const chips = lineOf(w, 'Table 05', 'CHP');
  assert.equal(w.eval(`hospReduceLine('${tab.id}', '${chips.lineId}', 1, '')`), false);
  assert.equal(w.eval(`hospReduceLine('${tab.id}', '${chips.lineId}', 1, 'Too slow')`), true);
  assert.match(lastTicket(w), /REMOVED:\s+1x\s+Chips[\s\S]*Reason: Too slow/);
  // the bill: net lines (2 burgers 1300 + wings 550 + coke 120 + 2 beers 600 = 2570) + 10% service charge on dine-in
  w.eval("hospConfig.serviceChargePct = 10; saveHospConfig()");
  assert.equal(Number(w.eval(`hospNetTotal(tabs.find(t => t.id === '${tab.id}'))`)), 2570);
  assert.equal(Number(w.eval(`hospTabDue(tabs.find(t => t.id === '${tab.id}'))`)), 2827);
  // settle for billing: bill printed, the order is locked for the waiter, it waits in Bills for the cashier
  w.eval(`hospSettleForBilling('${tab.id}')`);
  // zip 147: the customer's bill is printed on the RECEIPT printer (it went to the kitchen printer before)
  assert.match(d.getElementById('receipt-body').textContent, /RESTAURANT BILL[\s\S]*Service charge 10%[\s\S]*TOTAL[\s\S]*2,?827\.00[\s\S]*NOT PAID/);
  assert.equal(w.eval(`hospAddProduct('${tab.id}', 'CHP', 1)`), null, 'the waiter cannot add to a printed bill');
  assert.equal(J(w, `salesLog.length`), 0, 'settling for billing is NOT payment');
  w.eval(`document.querySelector('.tab-link[data-tab="bills-tab"]').click()`);
  assert.match(d.getElementById('bills-awaiting-orders').textContent, /Table 05[\s\S]*2,?827/);
  // the cashier takes the payment: one receipt, net items + service charge
  as(w, 'm1');
  w.eval(`settleTabDirect('${tab.id}')`);
  d.getElementById('tab-settle-cash-tendered-input').value = '3000';
  w.eval('confirmTabSettle()');
  const sale = J(w, 'salesLog[salesLog.length - 1]');
  assert.equal(sale.cashAmount, 2827); assert.equal(sale.change, 173);
  const names = sale.items.map((i) => `${i.qty}x ${i.name}`);
  assert.deepEqual(names.sort(), ['1x Chicken Wings', '1x Coke 500ml', '1x Service charge 10%', '2x Beef Burger', '2x Tusker Lager'].sort());
  assert.equal(J(w, `tabs.find(t => t.id === '${tab.id}').status`), 'CLOSED');
  assert.equal(J(w, "getLocState('table', 'Table 05').status"), 'available');
  const audit = J(w, 'buildAuditEvents().filter(e => e.module === "Orders").map(e => e.action)');
  assert.ok(audit.includes('Order changed') && audit.includes('Order settled for billing'));
  b.close();
});

test('a line note after sending prints as a NOTE to that station only; the history keeps every round', async () => {
  const b = await app(); const { w } = b;
  as(w, 'w1');
  w.eval("routeOrderToTab('Table 06'); currentPaymentMethod = 'tab'; addToCart('BRG'); addToCart('TSK'); checkoutCart()");
  const tab = tabOf(w, 'Table 06');
  const brg = lineOf(w, 'Table 06', 'BRG');
  w.eval(`hospNoteLine('${tab.id}', '${brg.lineId}', 'no onions')`);
  const t = lastTicket(w);
  assert.match(t, /KITCHEN[\s\S]*NOTE:\s+Beef Burger — no onions/);
  assert.doesNotMatch(t, /BAR ORDER|Tusker/);
  assert.equal(lineOf(w, 'Table 06', 'BRG').note, 'no onions');
  assert.equal(tabOf(w, 'Table 06').orders.length, 2);
  b.close();
});

test('move / split / merge: items move between tables with no second stock deduction and nothing re-cooked; an emptied order closes and frees its table', async () => {
  const b = await app(); const { w } = b;
  as(w, 'm1');
  w.eval("routeOrderToTab('Table 05'); currentPaymentMethod = 'tab'; addToCart('BRG'); addToCart('TSK'); addToCart('TSK'); checkoutCart()");
  const tab = tabOf(w, 'Table 05');
  const printed = J(w, 'window.__tickets.length');
  const beer = lineOf(w, 'Table 05', 'TSK');
  const dst = J(w, `(hospMoveLines('${tab.id}', ['${beer.lineId}'], 'Table 06') || {}).label`);
  assert.equal(dst, 'Table 06');
  assert.equal(qty(w, 'TSK'), 46, 'no second deduction');
  assert.equal(J(w, 'window.__tickets.length'), printed, 'nothing re-sent to the kitchen or bar');
  assert.deepEqual(J(w, "hospTabLines(tabs.find(t => t.label === 'Table 05' && t.status === 'OPEN')).map(l => l.code)"), ['BRG']);
  assert.deepEqual(J(w, "hospTabLines(tabs.find(t => t.label === 'Table 06' && t.status === 'OPEN')).map(l => l.code + ':' + l.qty)"), ['TSK:2']);
  // merge Table 06 back into Table 05: Table 06 closes (kept, marked MOVED) and is free again
  const t6 = tabOf(w, 'Table 06');
  assert.equal(w.eval(`hospMergeInto('${tab.id}', '${t6.id}')`), true);
  assert.equal(J(w, `tabs.find(t => t.id === '${t6.id}').status`), 'MOVED');
  assert.equal(J(w, "getLocState('table', 'Table 06').status"), 'available');
  assert.equal(Number(w.eval(`hospNetTotal(tabs.find(t => t.id === '${tab.id}'))`)), 650 + 600);
  b.close();
});

test('a waiter sees only their own active orders; a manager (or the setting) sees all', async () => {
  const b = await app(); const { w, d } = b;
  as(w, 'w1'); w.eval("hospOpenTabFor('Table 05', { waiter: 'Wanjiru' })");
  as(w, 'w2'); w.eval("hospOpenTabFor('Table 06', { waiter: 'Otieno' })");
  w.eval('renderServiceOrders()');
  let txt = d.getElementById('svc-active-orders').textContent;
  assert.match(txt, /Table 06/); assert.doesNotMatch(txt, /Table 05/);
  as(w, 'm1'); w.eval('renderServiceOrders()');
  txt = d.getElementById('svc-active-orders').textContent;
  assert.match(txt, /Table 05/); assert.match(txt, /Table 06/);
  as(w, 'w2'); w.eval('hospConfig.waiterSeesAll = true; renderServiceOrders()');
  assert.match(d.getElementById('svc-active-orders').textContent, /Table 05/);
  b.close();
});

test('the side panel: opens on the right, lists the current lines, and a printed bill can only be reopened by a manager', async () => {
  const b = await app(); const { w, d } = b;
  as(w, 'w1');
  w.eval("routeOrderToTab('Table 05'); currentPaymentMethod = 'tab'; addToCart('BRG'); checkoutCart()");
  const tab = tabOf(w, 'Table 05');
  w.eval(`openHospPanel('${tab.id}')`);
  const panel = d.getElementById('svc-panel');
  assert.ok(panel.classList.contains('open'));
  assert.match(panel.textContent, /1× Beef Burger[\s\S]*Kitchen/);
  w.eval(`hospSettleForBilling('${tab.id}')`);
  assert.equal(w.eval(`hospReopenBill('${tab.id}')`), false, 'a waiter cannot reopen');
  as(w, 'm1');
  assert.equal(w.eval(`hospReopenBill('${tab.id}')`), true);
  assert.ok(w.eval(`hospAddProduct('${tab.id}', 'CHP', 1)`), 'reopened: the order can change again');
  b.close();
});

test('an order from before this release (no line ids) still totals, changes and settles correctly', async () => {
  const b = await app(); const { w } = b;
  as(w, 'm1');
  w.eval("tabs.push({ id: 'old1', label: 'Table 05', kind: 'table', status: 'OPEN', openedAt: new Date().toISOString(), orders: [{ id: 'r1', timestamp: new Date().toISOString(), servedBy: 'X', entries: [{ code: 'TSK', name: 'Tusker Lager', qty: 3, price: 300, unit: 'pcs', vatCategory: 'A' }] }] })");
  const l = J(w, "hospTabLines(tabs.find(t => t.id === 'old1'))[0]");
  assert.equal(l.lineId, 'r1:0'); assert.equal(l.station, undefined);
  w.eval("hospReduceLine('old1', 'r1:0', 1, 'spilt')");
  assert.equal(Number(w.eval("hospNetTotal(tabs.find(t => t.id === 'old1'))")), 600);
  assert.match(lastTicket(w), /BAR[\s\S]*LESS:\s+1x\s+Tusker/, 'the change goes to the station the item belongs to');
  b.close();
});

test('server merge: a tab whose items all moved away (MOVED) never comes back as open', async () => {
  const { mergeRecordsById } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_merge.js')).href);
  const stored = { id: 't1', status: 'OPEN', updatedAt: 10, orders: [{ id: 'a' }] };
  const incoming = { id: 't1', status: 'MOVED', updatedAt: 5, orders: [{ id: 'a' }, { id: 'b' }] };
  const [m] = mergeRecordsById([stored], [incoming], false, 'tabs');
  assert.equal(m.status, 'MOVED');
  assert.deepEqual(m.orders.map((o) => o.id), ['a', 'b']);
});

/* ---------------- zip 135: kitchen & bar display, stations, printer routing, modifiers ---------------- */
test('KDS: the kitchen sees only food, the bar only drinks; items move New → Ready; the waiter is told; late orders turn red; rush goes first', async () => {
  const b = await app(); const { w, d } = b;
  as(w, 'w1');
  await w.eval("routeOrderToTab('Table 05'); currentPaymentMethod = 'tab'; addToCart('BRG'); addToCart('TSK'); checkoutCart()");
  await w.eval("routeOrderToTab('Table 06'); currentPaymentMethod = 'tab'; addToCart('CHP'); checkoutCart()");
  w.eval(`document.querySelector('.tab-link[data-tab="kds-tab"]').click()`);
  w.eval("kdsStation = 'kitchen'; renderKds()");
  let board = d.getElementById('kds-board').textContent;
  assert.match(board, /Table 05[\s\S]*Beef Burger/); assert.match(board, /Table 06[\s\S]*Chips/);
  assert.doesNotMatch(board, /Tusker/, 'no drinks in the kitchen');
  w.eval("kdsStation = 'bar'; renderKds()");
  board = d.getElementById('kds-board').textContent;
  assert.match(board, /Tusker/); assert.doesNotMatch(board, /Burger|Chips/);
  // statuses
  const t5 = tabOf(w, 'Table 05'); const brg = lineOf(w, 'Table 05', 'BRG');
  w.eval('hospNotifyReady()');                                     // baseline
  for (const st of ['ACCEPTED', 'PREPARING', 'READY']) w.eval(`hospSetLineStatus('${t5.id}', '${brg.lineId}', '${st}')`);
  assert.equal(w.eval(`hospLineStatus(tabs.find(t => t.id === '${t5.id}'), '${brg.lineId}')`), 'READY');
  w.eval('hospNotifyReady()');
  assert.ok((w.eval('window.__toasts') || []).some((t) => /Ready to serve: Beef Burger \(Table 05\)/.test(t)), 'the waiter is told once');
  w.eval('renderServiceOrders()');
  assert.match(d.getElementById('svc-active-orders').textContent, /🔔 1 ready/);
  // late: Table 06's chips were ordered 20 minutes ago (kitchen default 15 min)
  w.eval("tabs.find(t => t.label === 'Table 06' && t.status === 'OPEN').orders[0].timestamp = new Date(Date.now() - 20 * 60000).toISOString(); kdsStation = 'kitchen'; renderKds()");
  assert.equal(d.querySelectorAll('#kds-board .kds-late').length, 1);
  // rush first
  w.eval(`hospSetPriority('${t5.id}', true); renderKds()`);
  assert.match(d.querySelector('#kds-board .kds-card').textContent, /Table 05[\s\S]*RUSH/);
  b.close();
});

test('stations: a category can go to a new station (e.g. Bakery); its items get their own ticket section and display', async () => {
  const b = await app(); const { w } = b;
  as(w, 'm1');
  w.eval("inventory.push({ code: 'CAK', type: 'service', name: 'Black Forest Slice', category: 'Cakes', price: 350, unit: 'pcs', vatCategory: 'A' })");
  w.eval("document.getElementById('service-tab') && renderHospStationSettings(); hospConfig.stations.push({ id: 'bakery', label: '🧁 Bakery', print: 'local' }); hospSetCategoryStation('Cakes', 'bakery')");
  w.eval("routeOrderToTab('Table 05'); currentPaymentMethod = 'tab'; addToCart('CAK'); addToCart('BRG'); checkoutCart()");
  const t = lastTicket(w);
  assert.match(t, /BAKERY[\s\S]*Black Forest/); assert.match(t, /KITCHEN[\s\S]*Beef Burger/);
  assert.doesNotMatch(t.slice(t.indexOf('BAKERY'), t.indexOf('KITCHEN') > t.indexOf('BAKERY') ? t.indexOf('KITCHEN') : undefined), /Burger/);
  assert.equal(J(w, "hospKdsCards('bakery').length"), 1);
  b.close();
});

test('printer routing: a station on its own printer gets only its items through the print network; if that printer is unreachable the ticket prints here (fallback)', async () => {
  const b = await app(); const { w } = b;
  as(w, 'm1');
  w.eval("window.__relayed = []; window.__relayOk = true; submitPrintRelayJob = async (type, text) => { window.__relayed.push({ type, text }); return window.__relayOk; }");
  w.eval("hospConfig.stations.find(s => s.id === 'bar').print = 'relay'");
  w.eval("routeOrderToTab('Table 05'); currentPaymentMethod = 'tab'; addToCart('BRG'); addToCart('TSK'); checkoutCart()");
  await new Promise((r) => setTimeout(r, 50));
  const relayed = J(w, 'window.__relayed');
  assert.equal(relayed.length, 1); assert.equal(relayed[0].type, 'ticket:bar');
  assert.match(relayed[0].text, /Tusker/); assert.doesNotMatch(relayed[0].text, /Burger/);
  assert.match(lastTicket(w), /Burger/); assert.doesNotMatch(lastTicket(w), /Tusker/, 'the bar item is not printed here too');
  // the bar printer is down: printed here, with a warning
  w.eval("window.__relayOk = false; addToCart('TSK'); checkoutCart()");
  await new Promise((r) => setTimeout(r, 50));
  assert.match(lastTicket(w), /Tusker/);
  assert.ok((w.eval('window.__toasts') || []).some((t) => /Bar printer not reachable/.test(t)));
  b.close();
});

test('server print network: "ticket:bar" uses the bar rule; a station without its own rule uses the order-ticket rule', async () => {
  const { makeKV, seedShop } = await import('./kv-fake.mjs');
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/print-relay.js')).href);
  const call = async (body) => (await m.onRequestPost({ request: new Request('https://x.pages.dev/api/print-relay?c=C1', { method: 'POST', body: JSON.stringify(body) }), env })).json();
  for (const [id, station] of [['dev-bar', 'Bar'], ['dev-kit', 'Kitchen'], ['dev-front', 'Front Counter']]) await call({ action: 'registerDevice', deviceId: id, name: id, station, printerMode: 'usb', hasPrinter: true, acceptsRelay: true });
  await call({ action: 'saveRules', rules: [{ id: 'r1', trigger: 'ticket:bar', destinations: ['Bar'], active: true }, { id: 'r2', trigger: 'kitchen-ticket', destinations: ['Kitchen'], active: true }] });
  await call({ action: 'submit', jobType: 'ticket:bar', text: 'BAR: 2x Tusker' });
  await call({ action: 'submit', jobType: 'ticket:bakery', text: 'BAKERY: 1x Cake' });
  const bar = await call({ action: 'poll', deviceId: 'dev-bar' });
  const kit = await call({ action: 'poll', deviceId: 'dev-kit' });
  const front = await call({ action: 'poll', deviceId: 'dev-front' });
  assert.deepEqual((bar.jobs || []).map((j) => j.text), ['BAR: 2x Tusker']);
  assert.deepEqual((kit.jobs || []).map((j) => j.text), ['BAKERY: 1x Cake'], 'no bakery rule: the order-ticket rule');
  assert.equal((front.jobs || []).length, 0);
});

test('modifiers: an item with extras asks for them, the price follows, the kitchen ticket and display show them; a required choice must be made', async () => {
  const b = await app(); const { w, d } = b;
  as(w, 'm1');
  w.eval("hospAddModifierGroup({ name: 'Extras', options: [{ name: 'Extra cheese', price: 50 }, { name: 'No onions', price: 0 }], categories: ['Mains'] })");
  w.eval("hospAddModifierGroup({ name: 'Cooking', options: [{ name: 'Medium', price: 0 }, { name: 'Well done', price: 0 }], required: true, max: 1, categories: ['Mains'] })");
  w.eval("routeOrderToTab('Table 05'); addToCart('BRG')");
  assert.equal(d.getElementById('hosp-mod-modal').style.display, 'flex', 'asks for the extras');
  const pick = (name) => w.eval(`Array.from(document.querySelectorAll('.hosp-mod-pick')).find(el => el.parentElement.textContent.includes('${name}')).checked = true`);
  pick('Extra cheese'); pick('No onions');
  w.eval('hospConfirmModifiers()');
  assert.match(d.getElementById('hosp-mod-error').textContent, /Choose Cooking/);
  pick('Well done');
  w.eval('hospConfirmModifiers()');
  const line = J(w, 'Object.values(currentCart)[0]');
  assert.equal(line.price, 700); assert.match(line.name, /Beef Burger \(Extra cheese, No onions, Well done\)/);
  w.eval("currentPaymentMethod = 'tab'; checkoutCart()");
  assert.match(lastTicket(w), /Beef Burger[\s\S]*\+ Extra cheese[\s\S]*\+ No onions[\s\S]*\+ Well done/);
  w.eval("kdsStation = 'kitchen'; document.querySelector('.tab-link[data-tab=\"kds-tab\"]').click(); renderKds()");
  assert.match(d.getElementById('kds-board').textContent, /\+ Extra cheese/);
  assert.equal(Number(w.eval("hospNetTotal(tabs.find(t => t.label === 'Table 05' && t.status === 'OPEN'))")), 700);
  // drinks without modifier groups go straight in
  w.eval("addToCart('TSK')");
  assert.equal(J(w, 'Object.values(currentCart).length'), 1);
  b.close();
});
