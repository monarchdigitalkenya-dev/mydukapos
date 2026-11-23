import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 297: table seating capacity, live occupancy derived from the open session, location badges, cancellation alerts on kitchen / bar.
const INV = [
  { code: 'BRY', type: 'item', name: 'Chicken Biryani', price: 500, wholesalePrice: 200, qty: 50, unit: 'pcs', vatCategory: 'A', category: 'Food' },
  { code: 'TSK', type: 'item', name: 'Tusker', price: 300, wholesalePrice: 150, qty: 50, unit: 'pcs', vatCategory: 'A', category: 'Drinks' },
];
const mk = async () => {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV) }, wait: 900 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => d; window.print = () => {}; tables = []; tableStates = {};");
  return b;
};

test('tables are created with their own seating capacity (4 and 5) and show it', async () => {
  const b = await mk(); const { w, d } = b;
  assert.equal(w.eval("hospAddTable('Table 1', 4)"), true);
  assert.equal(w.eval("hospAddTable('Table 2', 5)"), true);
  assert.equal(w.eval("hospSeatsOf('Table 1')"), 4); assert.equal(w.eval("hospSeatsOf('Table 2')"), 5);
  const html = d.getElementById('tables-list').innerHTML;
  assert.match(html, /value="4"/); assert.match(html, /value="5"/);
  assert.equal(w.eval("hospAddTable('table 1', 3)"), false, 'a table name is unique (case-insensitive)');
  assert.equal(w.eval("hospAddTable('Table 3', 0)"), false, 'seats must be 1-99');
  assert.equal(w.eval("hospSetSeats('Table 1', '8')"), true); assert.equal(w.eval("hospSeatsOf('Table 1')"), 8, 'capacity can be changed later');
  assert.equal(w.eval("hospSetSeats('Table 1', '500')"), false); assert.equal(w.eval("hospSeatsOf('Table 1')"), 8);
  b.close();
});

test('changing seats / adding tables needs a manager; a plain waiter is refused', async () => {
  const b = await mk(); const { w } = b;
  w.eval("hospAddTable('Table 1', 4); staff = [{ id: 's1', name: 'Jane', roles: ['hosp-role:waiter'] }]; currentServer = { id: 's1', name: 'Jane' };");
  assert.equal(w.eval("hospSetSeats('Table 1', '6')"), false); assert.equal(w.eval("hospSeatsOf('Table 1')"), 4);
  assert.equal(w.eval("hospAddTable('Table 9', 2)"), false);
  assert.equal(w.eval("tables.includes('Table 9')"), false);
  b.close();
});

test('occupancy comes from the open session: opening a table marks it Occupied; release is refused while a bill is open; settle and release are separate', async () => {
  const b = await mk(); const { w, d } = b;
  w.eval("hospAddTable('Table 1', 4)");
  assert.match(d.getElementById('tables-list').innerHTML, /Available/);
  w.eval("hospOpenTableSession('Table 1')");
  assert.equal(w.eval("getLocState('table', 'Table 1').status"), 'occupied');
  assert.match(d.getElementById('tables-list').innerHTML, /Occupied/);
  assert.match(d.getElementById('tables-list').innerHTML, /View orders/);
  assert.equal(w.eval("hospLocRelease('table', 'Table 1')"), false, 'cannot release a table that still has an open bill');
  assert.equal(w.eval("getLocState('table', 'Table 1').status"), 'occupied');
  // a stale "occupied" with no session can be released by a manager
  w.eval("tabs.forEach((t) => { t.status = 'CLOSED'; })");
  assert.equal(w.eval("hospLocRelease('table', 'Table 1')"), true);
  assert.equal(w.eval("getLocState('table', 'Table 1').status"), 'available');
  b.close();
});

test('with "needs clearing" ON, settling a table moves it to Needs clearing, not Available, until staff clear it', async () => {
  const b = await mk(); const { w, d } = b;
  w.eval("hospAddTable('Table 1', 4); hospConfig.tableClearAfterSettle = true; hospOpenTableSession('Table 1');");
  w.eval("hospCloseTab(tabs[0], { paymentMethod: 'cash', total: 0 })");
  assert.equal(w.eval("getLocState('table', 'Table 1').status"), 'cleaning');
  assert.match(d.getElementById('tables-list').innerHTML, /Needs clearing/);
  assert.equal(w.eval("hospLocRelease('table', 'Table 1')"), true);
  assert.equal(w.eval("getLocState('table', 'Table 1').status"), 'available');
  // default (OFF) keeps the old behaviour: available straight after settling
  w.eval("hospConfig.tableClearAfterSettle = false; hospOpenTableSession('Table 1'); hospCloseTab(tabs[tabs.length - 1], { paymentMethod: 'cash', total: 0 })");
  assert.equal(w.eval("getLocState('table', 'Table 1').status"), 'available');
  b.close();
});

test('status filter shows only the tables in that state', async () => {
  const b = await mk(); const { w, d } = b;
  w.eval("hospAddTable('Table 1', 4); hospAddTable('Table 2', 5); hospOpenTableSession('Table 2');");
  w.eval("hospSetLocFilter('table', 'occupied')");
  const html = d.getElementById('tables-list').innerHTML;
  assert.match(html, /Table 2/); assert.doesNotMatch(html, /Table 1/);
  w.eval("hospSetLocFilter('table', 'all')");
  assert.match(d.getElementById('tables-list').innerHTML, /Table 1/);
  b.close();
});

test('badges: TABLE 07 · 4 SEATS · ORDER #…; rooms show the room; no table/room is labelled as a direct order, never invented', async () => {
  const b = await mk(); const { w } = b;
  w.eval("hospAddTable('Table 07', 4); rooms = ['Room 12'];");
  const t = w.eval("hospOpenTableSession('Table 07')");
  assert.match(w.eval("hospLocBadgeText(tabs[0])"), /^TABLE 07 · 4 SEATS · ORDER #/);
  w.eval("tabs.push({ id: 'rm1', label: 'Room 12', kind: 'room', status: 'OPEN', orders: [] })");
  const room = w.eval("hospLocBadgeText(tabs.find((x) => x.id === 'rm1'))");
  assert.match(room, /^ROOM 12 · ORDER #/); assert.doesNotMatch(room, /SEAT/);
  w.eval("tabs.push({ id: 'g1', label: 'Guest: Mary', kind: 'guest', status: 'OPEN', orders: [] })");
  const g = w.eval("hospLocBadgeText(tabs.find((x) => x.id === 'g1'))");
  assert.match(g, /DIRECT ORDER/); assert.doesNotMatch(g, /^TABLE \d/);
  w.eval("tabs.push({ id: 'tk', label: 'Takeaway', kind: 'guest', status: 'OPEN', orders: [] })");
  assert.match(w.eval("hospLocBadgeText(tabs.find((x) => x.id === 'tk'))"), /^TAKEAWAY/);
  // the printed kitchen slip carries the table and seats
  const slip = w.eval("hospTicketText(tabs[0], { timestamp: new Date().toISOString(), entries: [{ code: 'BRY', name: 'Chicken Biryani', qty: 2, price: 500, station: 'kitchen', note: 'No onions' }] }, 'ORDER')");
  assert.match(slip, /TABLE 07 · 4 SEATS/); assert.match(slip, /! No onions/);
  b.close();
});

test('a cancelled item raises a red CANCELLED alert on the kitchen board with the table, item and reason; "Seen" clears it; other stations are unaffected', async () => {
  const b = await mk(); const { w } = b;
  w.eval("hospAddTable('Table 07', 4); svcDraft = { tabId: null, lines: [{ code: 'BRY', qty: 2 }, { code: 'TSK', qty: 1 }] }; document.getElementById('svc-new-location').innerHTML = '<option value=\"Table 07\">Table 07</option>'; document.getElementById('svc-new-location').value = 'Table 07';");
  assert.ok(w.eval('svcPostOrder()'));
  const tab = JSON.parse(w.eval("JSON.stringify(tabs[0])"));
  const bry = JSON.parse(w.eval("JSON.stringify(hospTabLines(tabs[0]).find((l) => l.code === 'BRY'))"));
  assert.ok(w.eval(`hospReduceLine(${JSON.stringify(tab.id)}, ${JSON.stringify(bry.lineId)}, 1, 'Customer changed order')`));
  const st = bry.station || w.eval("hospStationFor('BRY', 'Chicken Biryani')");
  const html = w.eval(`hospKdsAlertsHtml(${JSON.stringify(st)})`);
  assert.match(html, /CANCELLED/); assert.match(html, /TABLE 07/); assert.match(html, /Chicken Biryani/); assert.match(html, /Customer changed order/);
  const other = st === 'bar' ? 'kitchen' : 'bar';
  assert.equal(w.eval(`hospKdsAlertsHtml(${JSON.stringify(other)})`), '', 'the other station is not alerted');
  const id = JSON.parse(w.eval(`JSON.stringify(hospKdsAlerts(${JSON.stringify(st)})[0].id)`));
  w.eval(`hospKdsAck(${JSON.stringify(id)})`);
  assert.equal(w.eval(`hospKdsAlertsHtml(${JSON.stringify(st)})`), '', 'acknowledged');
  // the history is not erased: the change round is still on the order
  assert.ok(w.eval("tabs[0].orders.some((r) => r.kind === 'change' && r.reason === 'Customer changed order')"));
  b.close();
});

test('a guest cancellation REQUEST shows on that table\'s kitchen card until staff decide', async () => {
  const b = await mk(); const { w } = b;
  w.eval("hospAddTable('Table 07', 4); hospOpenTableSession('Table 07'); tabs[0].orders.push({ id: 'r-q1', kind: 'add', timestamp: new Date().toISOString(), qrOrderId: 'q1', entries: [] }); hospQrReqs = [{ id: 'rq1', orderId: 'q1', type: 'CANCEL', payload: { line: 0, name: 'Biryani' } }];");
  assert.match(w.eval("hospKdsCancelRequestHtml(tabs[0])"), /CANCELLATION REQUESTED/);
  w.eval("hospQrReqs = []");
  assert.equal(w.eval("hospKdsCancelRequestHtml(tabs[0])"), '');
  b.close();
});

test('the live indicator says Live, then Reconnecting when the last check failed', async () => {
  const b = await mk(); const { w } = b;
  w.eval("window.hospQrLastOk = Date.now(); window.hospQrLastFail = 0;");
  assert.match(w.eval("hospLiveBadgeHtml()"), /Live/);
  w.eval("window.hospQrLastFail = Date.now() + 5");
  assert.match(w.eval("hospLiveBadgeHtml()"), /Reconnecting/);
  b.close();
});
