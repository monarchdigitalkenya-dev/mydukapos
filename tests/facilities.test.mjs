import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';

// Zip 137 — the facility / resource engine (master prompt §32–41, §69–70, §89, §95 POOL and POOL TABLE scenarios).
const INV = [{ code: 'TSK', type: 'item', name: 'Tusker Lager', category: 'Beer', price: 300, wholesalePrice: 180, qty: 48, unit: 'pcs', vatCategory: 'A' },
  { code: 'CHP', type: 'service', name: 'Chips', category: 'Sides', price: 200, unit: 'pcs', vatCategory: 'A' }];
const STAFF = [{ id: 'a1', name: 'Attendant', roles: ['facilities-tab'] }, { id: 'm1', name: 'Mo', isManager: true, roles: ['facilities-tab'] }];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const MIN = 60000;
async function app(fetch) {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_staff: JSON.stringify(STAFF), pos_kitchen_ticket_enabled: 'true' }, fetch, wait: 1500 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => (window.__promptAnswers && window.__promptAnswers.length ? window.__promptAnswers.shift() : d); window.__tickets = []; queuePrintJob = function () { window.__tickets.push(lastKitchenTicketText); return Promise.resolve(); }");
  b.w.eval("currentServer = staff.find(s => s.id === 'm1')");
  return b;
}

test('POOL TABLE end to end: session starts → timer → drinks go to the bar on the same bill → pause is not charged → end → table time + drinks on ONE bill → payment', async () => {
  const b = await app(); const { w, d } = b;
  const t1 = J(w, "hospAddResource({ type: 'pool_table', name: 'Pool Table 1', pricing: { mode: 'per_hour', rate: 500, minMinutes: 30 } })");
  w.eval(`document.querySelector('.tab-link[data-tab="facilities-tab"]').click()`);
  assert.match(d.getElementById('facilities-body').textContent, /Pool Table 1[\s\S]*Available/);
  const s = J(w, `hospStartSession('${t1.id}', { customerName: 'Kevin' })`);
  assert.equal(J(w, `resourceById('${t1.id}').status`), 'IN_USE');
  assert.equal(J(w, `hospStartSession('${t1.id}', {})`), null, 'cannot start twice');
  // the players order drinks: they go to the bar, on the session's bill
  await w.eval(`routeOrderToTab('${s.tabLabel}'); currentPaymentMethod = 'tab'; addToCart('TSK'); addToCart('TSK'); checkoutCart()`);
  assert.match(w.eval('window.__tickets[window.__tickets.length - 1]'), /BAR[\s\S]*2x\s+Tusker/);
  // 90 minutes played, with a 30-minute pause in the middle → 60 minutes charged at KES 500/h
  w.eval(`(function () { const x = resourceSessions.find(v => v.id === '${s.id}'); const now = Date.now(); x.startAt = now - 90 * ${MIN}; x.pauses = [{ from: now - 60 * ${MIN}, to: now - 30 * ${MIN} }]; })()`);
  assert.equal(J(w, `hospSessionCharge(resourceSessions.find(v => v.id === '${s.id}')).amount`), 500);
  const ended = J(w, `hospEndSession('${s.id}')`);
  assert.equal(ended.status, 'ENDED'); assert.equal(ended.charge, 500);
  assert.equal(J(w, `resourceById('${t1.id}').status`), 'AVAILABLE');
  assert.equal(w.eval('window.__tickets.length'), 1, 'table time is not sent to the kitchen or bar');
  const tab = J(w, `findOpenTabByLabel('${s.tabLabel}')`);
  assert.deepEqual(J(w, `hospTabLines(findOpenTabByLabel('${s.tabLabel}')).map(l => l.name)`), ['Tusker Lager', 'Pool Table 1 — 1 h 0 min']);
  assert.equal(Number(w.eval(`hospTabDue(findOpenTabByLabel('${s.tabLabel}'))`)), 1100);
  // one payment, one receipt
  w.eval(`settleTabDirect('${tab.id}')`);
  d.getElementById('tab-settle-cash-tendered-input').value = '1100';
  w.eval('confirmTabSettle()');
  const sale = J(w, 'salesLog[salesLog.length - 1]');
  assert.deepEqual(sale.items.map((i) => i.name), ['Tusker Lager', 'Pool Table 1 — 1 h 0 min']);
  assert.equal(sale.cashAmount, 1100);
  b.close();
});

test('pricing rules: per minute, per 30 min (rounded up), per hour by the quarter, minimum session, peak hours (Kenya time), member rate, fixed', async () => {
  const b = await app(); const { w } = b;
  const mk = (pricing) => J(w, `hospAddResource({ type: 'snooker', name: 'T${Math.random()}', pricing: ${JSON.stringify(pricing)} }).id`);
  const charge = (id, mins, extra = '') => J(w, `hospSessionCharge({ resourceId: '${id}', startAt: Date.UTC(2026, 8, 27, 7, 0) , endAt: Date.UTC(2026, 8, 27, 7, 0) + ${mins} * ${MIN}, pauses: [] ${extra} }).amount`);
  assert.equal(charge(mk({ mode: 'per_minute', rate: 10 }), 17), 170);
  assert.equal(charge(mk({ mode: 'per_30', rate: 250 }), 31), 500, '31 minutes = two half hours');
  assert.equal(charge(mk({ mode: 'per_hour', rate: 600 }), 50), 600, '50 min → 60 min (quarters)');
  assert.equal(charge(mk({ mode: 'per_hour', rate: 600, minMinutes: 60 }), 20), 600, 'minimum session');
  assert.equal(charge(mk({ mode: 'fixed', rate: 1000 }), 200), 1000);
  // 10:00 EAT = 07:00 UTC. Peak 10:00–12:00 at 800/h vs 500/h off-peak
  const pk = mk({ mode: 'per_hour', rate: 500, peakFrom: '10:00', peakTo: '12:00', peakRate: 800 });
  assert.equal(charge(pk, 60), 800, 'inside peak (Kenya time)');
  assert.equal(charge(pk, 60, ", member: true"), 500, 'members do not pay peak');
  const mem = mk({ mode: 'per_hour', rate: 500, memberRate: 400 });
  assert.equal(charge(mem, 60, ", member: true"), 400);
  b.close();
});

test('session controls: move to another table, manager-only adjustment with a reason, maintenance blocks play', async () => {
  const b = await app(); const { w } = b;
  const a = J(w, "hospAddResource({ type: 'pool_table', name: 'Table A', pricing: { mode: 'per_hour', rate: 500 } }).id");
  const c = J(w, "hospAddResource({ type: 'pool_table', name: 'Table B', pricing: { mode: 'per_hour', rate: 500 } }).id");
  const s = J(w, `hospStartSession('${a}', {}).id`);
  assert.equal(w.eval(`hospTransferSession('${s}', '${c}')`), true);
  assert.deepEqual([J(w, `resourceById('${a}').status`), J(w, `resourceById('${c}').status`)], ['AVAILABLE', 'IN_USE']);
  w.eval("currentServer = staff.find(s => s.id === 'a1')");
  assert.equal(w.eval(`hospAdjustSession('${s}', -100, 'loyal')`), false, 'an attendant cannot adjust');
  w.eval("currentServer = staff.find(s => s.id === 'm1')");
  assert.equal(w.eval(`hospAdjustSession('${s}', -100, '')`), false, 'a reason is required');
  assert.equal(w.eval(`hospAdjustSession('${s}', -100, 'Cue broken')`), true);
  w.eval(`resourceSessions.find(v => v.id === '${s}').startAt = Date.now() - 60 * ${MIN}`);
  assert.equal(J(w, `hospSessionCharge(resourceSessions.find(v => v.id === '${s}')).amount`), 400);
  w.eval(`hospEndSession('${s}')`);
  assert.equal(w.eval(`hospSetResourceStatus('${a}', 'MAINTENANCE')`), true);
  assert.equal(J(w, `hospStartSession('${a}', {})`), null);
  b.close();
});

test('POOL end to end: passes with capacity and expiry; poolside food goes on the pass\'s bill; closed pool sells nothing', async () => {
  const b = await app(); const { w } = b;
  const pool = J(w, "hospAddResource({ type: 'pool', name: 'Main Pool', capacity: 3, pricing: { mode: 'per_person', rate: 0 } }).id");
  w.eval(`resourceById('${pool}').passes = [{ id: 'adult', name: 'Adult entry', price: 500, durationMin: 180, people: 1, perPerson: true }, { id: 'family', name: 'Family package', price: 1800, durationMin: 0, people: 4 }]`);
  const p1 = J(w, `hospSellPass('${pool}', 'adult', { people: 2, customerName: 'Amina' })`);
  assert.equal(p1.charge, 1000); assert.equal(p1.number, 'P-001');
  assert.equal(Number(w.eval(`hospPoolOccupancy('${pool}')`)), 2);
  assert.equal(J(w, `hospSellPass('${pool}', 'family', {})`), null, 'full: 2 + 4 > 3');
  assert.ok((w.eval('window.__toasts') || []).some((t) => /Main Pool is full \(2 of 3\)/.test(t)));
  // poolside order on the same bill
  await w.eval(`routeOrderToTab('${p1.tabLabel}'); currentPaymentMethod = 'tab'; addToCart('CHP'); checkoutCart()`);
  assert.equal(Number(w.eval(`hospTabDue(findOpenTabByLabel('${p1.tabLabel}'))`)), 1200);
  assert.match(w.eval('window.__tickets[window.__tickets.length - 1]'), /KITCHEN[\s\S]*Chips/);
  // expiry
  w.eval(`resourceSessions.find(v => v.id === '${p1.id}').expiresAt = Date.now() - 1; hospExpirePasses()`);
  assert.equal(J(w, `resourceSessions.find(v => v.id === '${p1.id}').status`), 'EXPIRED');
  assert.equal(Number(w.eval(`hospPoolOccupancy('${pool}')`)), 0);
  w.eval(`hospSetResourceStatus('${pool}', 'OUT_OF_SERVICE')`);
  assert.equal(J(w, `hospSellPass('${pool}', 'adult', { people: 1 })`), null);
  b.close();
});

test('reservations: no double booking (this till, and the server for every till); check-in starts the session; cancel and reschedule', async () => {
  let serverClash = false;
  const fetch = async (url) => (/facility-book/.test(String(url)) ? new Response(JSON.stringify(serverClash ? { ok: false, conflict: { customerName: 'Otieno' } } : { ok: true }), { status: serverClash ? 409 : 200 }) : new Response('{}', { status: 404 }));
  const b = await app(fetch); const { w } = b;
  const r = J(w, "hospAddResource({ type: 'pool_table', name: 'Table 1', pricing: { mode: 'per_hour', rate: 500 } }).id");
  const t0 = Date.now() + 2 * 3600 * 1000;
  const b1 = await w.eval(`hospBookResource({ resourceId: '${r}', start: ${t0}, end: ${t0 + 3600000}, customerName: 'Wanjiru', deposit: 200 }).then(x => JSON.stringify(x))`);
  assert.ok(JSON.parse(b1).id);
  assert.equal(await w.eval(`hospBookResource({ resourceId: '${r}', start: ${t0 + 1800000}, end: ${t0 + 5400000}, customerName: 'X' }).then(x => x)`), null, 'overlap refused on this till');
  assert.ok(await w.eval(`hospBookResource({ resourceId: '${r}', start: ${t0 + 3600000}, end: ${t0 + 7200000}, customerName: 'Back to back' }).then(x => !!x)`), 'back-to-back is fine');
  serverClash = true;
  assert.equal(await w.eval(`hospBookResource({ resourceId: '${r}', start: ${t0 + 8000000}, end: ${t0 + 9000000}, customerName: 'Late' }).then(x => x)`), null, 'another till booked it first (server says so)');
  assert.ok((w.eval('window.__toasts') || []).some((t) => /just booked on another till \(Otieno\)/.test(t)));
  // deposit on its own bill line
  assert.ok(J(w, "tabs.some(t => t.status === 'OPEN' && hospTabLines(t).some(l => /^Deposit: Table 1/.test(l.name) && l.price === 200))"));
  // reschedule into a clash is refused; into a free slot works
  const id1 = JSON.parse(b1).id;
  assert.equal(w.eval(`hospRescheduleBooking('${id1}', ${t0 + 3600000}, ${t0 + 7200000})`), false);
  assert.equal(w.eval(`hospRescheduleBooking('${id1}', ${t0 - 3600000}, ${t0})`), true);
  // check-in starts the table's session on the booking's bill
  const ses = J(w, `hospCheckInBooking('${id1}')`);
  assert.equal(ses.bookingId, id1);
  assert.equal(J(w, `resourceById('${r}').status`), 'IN_USE');
  // a clash that slipped through offline: every till keeps the EARLIER booking
  w.eval(`facilityBookings.push({ id: 'bk-z', resourceId: '${r}', resourceName: 'Table 1', start: ${t0 + 3600000}, end: ${t0 + 7200000}, status: 'BOOKED', createdAt: Date.now() + 5 })`);
  w.eval('hospResolveBookingClashes()');
  assert.equal(J(w, "facilityBookings.find(b => b.id === 'bk-z').clash"), true);
  b.close();
});

test('server: facility-book refuses an overlapping booking (single-record store) and books atomically in a shop database', async () => {
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/facility-book.js')).href);
  const kv = makeKV(); seedShop(kv, 'C1');
  const book = (env, booking) => m.onRequestPost({ request: new Request('https://x.pages.dev/api/facility-book?c=C1', { method: 'POST', body: JSON.stringify({ booking }) }), env });
  const t = Date.now() + 86400000;
  const B = (id, s, e, extra = {}) => ({ id, resourceId: 'res-1', start: s, end: e, status: 'BOOKED', customerName: id, ...extra });
  const sync = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);
  await sync.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ businessName: 'Biz', updatedAt: Date.now(), facilityBookings: [B('bk-a', t, t + 3600000)] }) }), env: { mydukapos_kv: kv }, waitUntil() {} });
  assert.equal((await book({ mydukapos_kv: kv }, B('bk-b', t + 1800000, t + 5400000))).status, 409);
  assert.equal((await book({ mydukapos_kv: kv }, B('bk-c', t + 3600000, t + 7200000))).status, 200, 'back to back');
  assert.equal((await book({ mydukapos_kv: kv }, B('bk-d', t, t + 3600000, { resourceId: 'res-2' }))).status, 200, 'another resource');
  if (!hasSqlite) return;
  // database shop: the check and the insert are one step
  const env = { mydukapos_kv: kv, SHOP_STORE: await makeBinding() };
  kv.data.set('owner-session:tok', { value: '1' });
  const os = await import(pathToFileURL(path.join(ROOT, 'functions/api/owner-storage.js')).href);
  const mig = await os.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-storage', { method: 'POST', body: JSON.stringify({ action: 'migrate', clientId: 'C1' }), headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' } }), env });
  assert.equal(mig.status, 200, 'the shop moved to its own database');
  assert.equal(kv.data.get('pos-data:mode:C1').value, 'do');
  const [r1, r2] = await Promise.all([book(env, B('bk-x', t + 20 * 3600000, t + 21 * 3600000)), book(env, B('bk-y', t + 20.5 * 3600000, t + 21.5 * 3600000))]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409], 'two tills at the same moment: exactly one wins');
  const st = await (await sync.onRequestGet({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1&hot=all'), env, waitUntil() {} })).json();
  assert.ok(st.facilityBookings.some((x) => x.id === 'bk-x' || x.id === 'bk-y'), 'the winner is stored');
  assert.equal(st.facilityBookings.filter((x) => x.id === 'bk-x' || x.id === 'bk-y').length, 1);
});

test('billing grace (zip 142): a game ending a moment after the hour is not charged an extra quarter; 30 seconds into the next quarter is', async () => {
  const b = await app(); const { w } = b;
  const t = J(w, "hospAddResource({ type: 'pool_table', name: 'Pool Table 9', pricing: { mode: 'per_hour', rate: 500 } })");
  const s = J(w, `hospStartSession('${t.id}', {})`);
  const at = (ms) => J(w, `(function () { const x = resourceSessions.find(v => v.id === '${s.id}'); x.startAt = 1e12; x.pauses = []; return hospSessionCharge(x, 1e12 + ${ms}).amount; })()`);
  assert.equal(at(60 * MIN + 2000), 500, '60 min 2 s');
  assert.equal(at(60 * MIN + 29000), 500, '60 min 29 s');
  assert.equal(at(60 * MIN + 31000), 625, '60 min 31 s: the next quarter has started');
  assert.equal(at(15 * MIN), 125);
  b.close();
});
