import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 269 - the full-screen Kitchen and Bar boards: routing by station, New / Preparing / Ready, overdue, and the waiter seeing the same statuses.
const APP = 'hotel/index.html';
const INV = [
  { code: 'BRG', type: 'service', name: 'Beef Burger', category: 'Mains', price: 650, unit: 'pcs', vatCategory: 'A', sizes: [{ id: 'sL', name: 'Large', price: 900, factor: 1 }, { id: 'sR', name: 'Regular', price: 650, factor: 1 }] },
  { code: 'CHP', type: 'service', name: 'Chips', category: 'Sides', price: 200, unit: 'pcs', vatCategory: 'A' },
  { code: 'TSK', type: 'item', name: 'Tusker Lager', category: 'Beer', price: 300, wholesalePrice: 180, qty: 48, unit: 'pcs', vatCategory: 'A' },
];
const STAFF = [{ id: 'w1', name: 'Wanjiru', roles: ['service-tab', 'hosp-role:waiter'], salesTabMigrated: true }];
const J = (w, e) => JSON.parse(w.eval(`JSON.stringify(${e})`));
async function app() {
  const b = await boot(APP, { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 05', 'Table 06']), pos_staff: JSON.stringify(STAFF), pos_kitchen_ticket_enabled: 'true' }, wait: 1500 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.print = () => {}; queuePrintJob = function () { return Promise.resolve(); }; kdsBeep = function () { window.__beeps = (window.__beeps || 0) + 1; }");
  return b;
}
// as a waiter does it: open the Orders tab (it draws the order form), then type the table, add the items and post
const post = (w, d, table, adds) => {
  w.eval(`(function () { const b = document.querySelector('.tab-link[data-tab="service-tab"]'); const t = document.getElementById('service-tab'); if (b && t && !t.classList.contains('active')) b.click(); })()`);
  d.getElementById('svc-new-location').value = table; w.eval(adds); w.eval('svcPostOrder()');
};
const text = (d) => d.getElementById('kds-full').textContent;
const tab = (d, w, id) => { w.eval(`document.querySelector('.tab-link[data-tab="${id}"]').click()`); return d.getElementById('kds-body-' + (id === 'kds-bar-tab' ? 'bar' : 'kitchen')); };

test('food goes to the Kitchen board, drinks to the Bar board; one order with both appears on each, with only its own items', async () => {
  const b = await app(); const { w, d } = b;
  post(w, d, 'Table 05', "svcAdd('BRG', 'sL'); svcAdd('CHP'); svcAdd('TSK'); svcAdd('TSK')");
  w.eval("kdsOpenFull('kitchen')");
  const el = d.getElementById('kds-full');
  assert.equal(el.style.display, 'flex');
  assert.match(text(d), /Kitchen/); assert.match(text(d), /Beef Burger — Large/); assert.match(text(d), /Chips/);
  assert.doesNotMatch(text(d), /Tusker/, 'no drinks on the kitchen board');
  assert.equal(el.querySelectorAll('.kf-col.new .kf-card').length, 1, 'the order is in New');
  assert.match(el.querySelector('.kf-ref').textContent, /Table 05/i, 'the table is on the card (the location badge shows it in capitals)');
  assert.match(el.querySelector('.kf-time').textContent, /\d{2}:\d{2} · \d+ min/, 'time received and waiting time');
  w.eval("kdsOpenFull('bar')");
  assert.match(text(d), /Tusker Lager/); assert.match(text(d), /2×/); assert.doesNotMatch(text(d), /Burger|Chips/, 'no food on the bar board');
  b.close();
});

test('statuses: Start → Ready → Served moves the order across the columns and the waiter sees the same status', async () => {
  const b = await app(); const { w, d } = b;
  post(w, d, 'Table 05', "svcAdd('CHP'); svcAdd('BRG', 'sR')");
  const tabId = J(w, "tabs.find(t => t.status === 'OPEN').id");
  w.eval("kdsOpenFull('kitchen')");
  const el = d.getElementById('kds-full');
  const click = (sel) => el.querySelector(sel).click();
  click('.kf-col.new .go-prep');
  assert.equal(el.querySelectorAll('.kf-col.prep .kf-card').length, 1); assert.equal(el.querySelectorAll('.kf-col.new .kf-card').length, 0);
  assert.deepEqual(J(w, `hospTabLines(tabs.find(t => t.id === '${tabId}')).filter(l => l.station === 'kitchen').map(l => hospLineStatus(tabs.find(t => t.id === '${tabId}'), l.lineId))`), ['PREPARING', 'PREPARING']);
  // what the waiter's own screen says
  assert.match(J(w, `hospStatusChips(tabs.find(t => t.id === '${tabId}'))`), /2 preparing/);
  click('.kf-col.prep .go-ready');
  assert.equal(el.querySelectorAll('.kf-col.ready .kf-card').length, 1);
  assert.match(J(w, `hospStatusChips(tabs.find(t => t.id === '${tabId}'))`), /2 ready/);
  assert.equal(Number(w.eval(`hospReadyCount(tabs.find(t => t.id === '${tabId}'))`)), 2, 'the existing "ready" alert for the waiter still counts them');
  // one item can be moved on its own; a mistake can be stepped back
  click('.kf-col.ready .back');
  assert.equal(el.querySelectorAll('.kf-col.prep .kf-card').length, 1, 'back to Preparing');
  click('.kf-col.prep .go-ready'); click('.kf-col.ready .go-served');
  assert.equal(el.querySelectorAll('.kf-card').length, 0, 'served orders leave the board');
  assert.match(text(d), /No new orders/, 'the empty state says what to expect');
  b.close();
});

test('overdue and rush: an order past its preparation time is flagged late and sorted first; a new item beeps once', async () => {
  const b = await app(); const { w, d } = b;
  post(w, d, 'Table 05', "svcAdd('CHP')");
  w.eval("kdsOpenFull('kitchen')");                                  // first paint only remembers what is there
  assert.equal(Number(w.eval('window.__beeps || 0')), 0);
  post(w, d, 'Table 06', "svcAdd('BRG', 'sR')");
  w.eval('kdsFullRender()');
  assert.equal(Number(w.eval('window.__beeps || 0')), 1, 'one beep for the new order');
  w.eval('kdsFullRender()');
  assert.equal(Number(w.eval('window.__beeps || 0')), 1, 'not again for the same order');
  // make the first order 40 minutes old: late (kitchen items are due after 15 min)
  w.eval("tabs.filter(t => t.status === 'OPEN')[0].orders.forEach(o => { o.timestamp = new Date(Date.now() - 40 * 60000).toISOString(); (o.entries || []).forEach(e => { e.roundAt = o.timestamp; }); })");
  w.eval('kdsFullRender()');
  const el = d.getElementById('kds-full');
  const cards = [...el.querySelectorAll('.kf-col.new .kf-card')];
  assert.equal(cards.length, 2); assert.ok(cards[0].classList.contains('late'), 'the late order is first and flagged');
  assert.match(cards[0].textContent, /LATE/); assert.equal(cards[1].classList.contains('late'), false);
  assert.match(el.querySelector('.kf-count.late').textContent, /1 late/);
  w.eval('kdsToggleSound()'); assert.match(el.querySelector('[aria-pressed]').textContent, /Sound off/);
  w.eval('kdsCloseFull()'); assert.equal(el.style.display, 'none');
  b.close();
});


test('TABS: Kitchen Orders and Bar Orders are two separate tabs; each shows only its own items and a red number counts what is waiting', async () => {
  const b = await app(); const { w, d } = b;
  const nav = [...d.querySelectorAll('.tab-link')].map((x) => x.dataset.tab);
  assert.ok(nav.includes('kds-kitchen-tab') && nav.includes('kds-bar-tab'), 'two tabs'); assert.ok(!nav.includes('kds-tab'), 'the single mixed display is gone');
  assert.match(d.getElementById('kds-bar-tab-btn').textContent, /Bar Orders/); assert.match(d.getElementById('kds-kitchen-tab-btn').textContent, /Kitchen Orders/);
  assert.match(d.querySelector('.tab-link[data-tab="kitchen-tab"]').textContent, /Food Tracking/, 'the production tab no longer shares the Kitchen name');
  post(w, d, 'Table 05', "svcAdd('BRG', 'sL'); svcAdd('CHP'); svcAdd('TSK'); svcAdd('TSK')");
  post(w, d, 'Table 06', "svcAdd('TSK')");
  w.eval('kdsTick()');
  assert.equal(d.getElementById('kds-kitchen-badge').style.display, ''); assert.equal(d.getElementById('kds-kitchen-badge').textContent, '1', 'one order is waiting in the kitchen');
  assert.equal(d.getElementById('kds-bar-badge').textContent, '2', 'two orders are waiting at the bar');
  const kit = tab(d, w, 'kds-kitchen-tab');
  assert.match(kit.textContent, /Beef Burger — Large/); assert.doesNotMatch(kit.textContent, /Tusker/);
  assert.equal(kit.querySelectorAll('.kf-col.new .kf-card').length, 1);
  const bar = tab(d, w, 'kds-bar-tab');
  assert.match(bar.textContent, /Tusker Lager/); assert.doesNotMatch(bar.textContent, /Burger|Chips/); assert.equal(bar.querySelectorAll('.kf-col.new .kf-card').length, 2, 'two orders have drinks');
  bar.querySelector('.kf-col.new .go-prep').click();
  assert.equal(d.getElementById('kds-bar-badge').textContent, '1', 'the badge counts down as the bar starts orders');
  assert.equal(bar.ownerDocument.getElementById('kds-body-bar').querySelectorAll('.kf-col.prep .kf-card').length, 1);
  // a station tab can go full screen and the device can be made that station's permanent screen
  w.eval("kdsOpenFull('bar')"); assert.equal(d.getElementById('kds-full').style.display, 'flex'); w.eval('kdsCloseFull()');
  w.eval("kdsSetDevice('bar')"); assert.equal(w.localStorage.getItem('pos_kds_device'), 'bar'); w.eval("kdsSetDevice('')"); assert.equal(w.localStorage.getItem('pos_kds_device'), null);
  b.close();
});

test('roles: kitchen staff get the Kitchen tab, bar staff the Bar tab; staff who had the old single display keep both', async () => {
  const b = await app(); const { w } = b;
  assert.ok(J(w, 'HOSP_ROLE_PRESETS.kitchen.tabs').includes('kds-kitchen-tab')); assert.ok(!J(w, 'HOSP_ROLE_PRESETS.kitchen.tabs').includes('kds-bar-tab'));
  assert.ok(J(w, 'HOSP_ROLE_PRESETS.bartender.tabs').includes('kds-bar-tab')); assert.ok(!J(w, 'HOSP_ROLE_PRESETS.bartender.tabs').includes('kds-kitchen-tab'));
  assert.ok(J(w, "kdsLegacyRole(['kds-tab'], 'kds-bar-tab')") && J(w, "kdsLegacyRole(['kds-tab'], 'kds-kitchen-tab')"));
  assert.equal(J(w, "kdsLegacyRole(['sales-tab'], 'kds-bar-tab')"), false);
  b.close();
});
