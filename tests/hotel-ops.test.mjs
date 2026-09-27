import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 138 — hotel: room types & rates, reservations (no double selling), check-in from a reservation, room QR / room service,
// charge any outlet's bill to the room (folio), housekeeping workflow, service requests (master prompt §30–31, §90–93, §95 HOTEL).
const INV = [{ code: 'BRK', type: 'service', name: 'Full English Breakfast', category: 'Breakfast', price: 900, unit: 'pcs', vatCategory: 'A' },
  { code: 'TSK', type: 'item', name: 'Tusker Lager', category: 'Beer', price: 300, wholesalePrice: 180, qty: 48, unit: 'pcs', vatCategory: 'A' }];
const STAFF = [{ id: 'r1', name: 'Reception', roles: ['hotel-tab'] }, { id: 'm1', name: 'Mo', isManager: true, roles: ['hotel-tab'] }];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const ymd = (days) => new Date(Date.now() + 3 * 3600000 + days * 86400000).toISOString().slice(0, 10);
async function app() {
  const fetch = async (url) => (/facility-book/.test(String(url)) ? new Response('{"ok":true}', { status: 200 }) : new Response('{}', { status: 404 }));
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_rooms: JSON.stringify(['Room 205', 'Room 206']), pos_tables: JSON.stringify(['Table 05']), pos_staff: JSON.stringify(STAFF), pos_kitchen_ticket_enabled: 'true' }, fetch, wait: 1500 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => (window.__promptAnswers && window.__promptAnswers.length ? window.__promptAnswers.shift() : d); window.__tickets = []; queuePrintJob = function () { window.__tickets.push(lastKitchenTicketText); return Promise.resolve(); }");
  b.w.eval("currentServer = staff.find(s => s.id === 'm1')");
  return b;
}

test('HOTEL end to end: room type & rate → reservation → no double selling → check-in with the deposit → room service → restaurant bill charged to the room → checkout folio → housekeeping', async () => {
  const b = await app(); const { w, d } = b;
  const deluxe = J(w, "hospAddRoomType('Deluxe', 8000, 2)");
  w.eval(`hospSetRoomType('Room 205', '${deluxe}')`);
  // reservation: 2 nights at the room type's rate; the same room cannot be sold twice
  const rv = JSON.parse(await w.eval(`hospReserveRoom({ room: 'Room 205', arrive: '${ymd(0)}', depart: '${ymd(2)}', guest: 'Achieng', phone: '0712000000', deposit: 5000 }).then(x => JSON.stringify(x))`));
  assert.deepEqual([rv.nights, rv.nightlyRate, rv.status], [2, 8000, 'BOOKED']);
  assert.equal(await w.eval(`hospReserveRoom({ room: 'Room 205', arrive: '${ymd(1)}', depart: '${ymd(3)}', guest: 'Other' }).then(x => x)`), null, 'overlapping dates refused');
  assert.ok(await w.eval(`hospReserveRoom({ room: 'Room 205', arrive: '${ymd(2)}', depart: '${ymd(4)}', guest: 'Next guest' }).then(x => !!x)`), 'arriving the day the first one leaves is fine');
  assert.equal(J(w, "getLocState('room', 'Room 205').status"), 'reserved');
  w.eval(`document.querySelector('.tab-link[data-tab="hotel-tab"]').click()`);
  assert.match(d.getElementById('hotel-body').textContent, /Arrivals[\s\S]*Room 205[\s\S]*Achieng/);
  // check-in from the reservation
  assert.equal(w.eval(`hospCheckInReservation('${rv.id}')`), true);
  const stay = J(w, "roomStayFor('Room 205')");
  assert.deepEqual([stay.guestName, stay.nightlyRate, stay.depositAmount, stay.checkOutDue], ['Achieng', 8000, 5000, ymd(2)]);
  assert.equal(J(w, "getLocState('room', 'Room 205').status"), 'occupied');
  assert.match(await w.eval(`hospReserveRoom({ room: 'Room 205', arrive: '${ymd(0)}', depart: '${ymd(1)}', guest: 'Walk-in' }).then(x => String(x))`), /null/, 'an occupied room cannot be reserved for tonight');
  // room service to the room (kitchen ticket says ROOM SERVICE)
  await w.eval("routeOrderToTab('Room 205'); currentPaymentMethod = 'tab'; addToCart('BRK'); checkoutCart()");
  assert.match(w.eval('window.__tickets[window.__tickets.length - 1]'), /ROOM 205 · Room service[\s\S]*Full English Breakfast/);
  // drinks at the restaurant, charged to the room (folio)
  await w.eval("routeOrderToTab('Table 05'); currentPaymentMethod = 'tab'; addToCart('TSK'); addToCart('TSK'); checkoutCart()");
  const t5 = J(w, "findOpenTabByLabel('Table 05').id");
  assert.equal(w.eval(`hospChargeToRoom('${t5}', 'Room 206')`), false, 'no guest in 206');
  assert.equal(w.eval(`hospChargeToRoom('${t5}', 'Room 205')`), true);
  assert.equal(w.eval("!!findOpenTabByLabel('Table 05')"), false, 'the table bill is closed (moved to the room)');
  assert.equal(J(w, "getLocState('table', 'Table 05').status"), 'available');
  const folio = J(w, "hospTabLines(findOpenTabByLabel('Room 205')).map(l => l.name + ' ' + l.qty)");
  assert.deepEqual(folio.sort(), ['Full English Breakfast 1', 'Tusker Lager 2'].sort());
  // a service request with a charge goes to the folio when done
  const srq = J(w, "hospAddServiceRequest({ room: 'Room 205', type: 'honeymoon', notes: 'Rose petals', charge: 2500 })");
  assert.equal(srq.department, 'front_desk');
  for (let i = 0; i < 3; i++) w.eval(`hospAdvanceServiceRequest('${srq.id}', null, 'Joy')`);
  assert.equal(J(w, `serviceRequests.find(r => r.id === '${srq.id}').status`), 'DONE');
  assert.ok(J(w, "hospTabLines(findOpenTabByLabel('Room 205')).some(l => /Honeymoon setup/.test(l.name) && l.price === 2500)"));
  // checkout: nights + breakfast + drinks + setup − deposit, one receipt; the room goes to housekeeping as DIRTY
  w.eval("openCheckOutRoomModal('Room 205'); confirmCheckOut()");
  d.getElementById('tab-settle-cash-tendered-input').value = '100000';
  w.eval('confirmTabSettle()');
  const sale = J(w, 'salesLog[salesLog.length - 1]');
  const names = sale.items.map((i) => i.name).join(' | ');
  assert.match(names, /Breakfast[\s\S]*Tusker[\s\S]*Honeymoon[\s\S]*Deposit/i);
  assert.equal(sale.cashAmount, 8000 + 900 + 600 + 2500 - 5000);
  assert.equal(J(w, "roomStayFor('Room 205')"), null);
  assert.equal(J(w, `facilityBookings.find(b => b.id === '${rv.id}').status`), 'COMPLETED');
  assert.equal(J(w, "getLocState('room', 'Room 205').status"), 'dirty');
  // housekeeping: dirty → cleaning → clean → inspected (available), logged
  for (const st of ['cleaning', 'clean', 'available']) assert.equal(w.eval(`hospHousekeeping('Room 205', '${st}')`), true);
  assert.equal(J(w, "getLocState('room', 'Room 205').status"), 'available');
  assert.deepEqual(J(w, "hospConfig.hkLog.filter(x => x.room === 'Room 205').map(x => x.to)"), ['cleaning', 'clean', 'available']);
  b.close();
});

test('charge to room respects the guest\'s credit limit; a reservation can be cancelled and frees the room', async () => {
  const b = await app(); const { w } = b;
  w.eval("roomStays['Room 206'] = { guestName: 'Brian', checkInAt: new Date().toISOString(), checkOutDue: null, nightlyRate: 5000, depositAmount: 0, creditLimit: 6000 }; setLocStatus('room', 'Room 206', 'occupied')");
  await w.eval("routeOrderToTab('Table 05'); currentPaymentMethod = 'tab'; addToCart('TSK'); addToCart('TSK'); addToCart('TSK'); addToCart('TSK'); checkoutCart()");
  const t5 = J(w, "findOpenTabByLabel('Table 05').id");
  assert.equal(w.eval(`hospChargeToRoom('${t5}', 'Room 206')`), false, '5000 night + 1200 > 6000 limit');
  assert.ok((w.eval('window.__toasts') || []).some((t) => /credit limit/.test(t)));
  const rv = JSON.parse(await w.eval(`hospReserveRoom({ room: 'Room 205', arrive: '${ymd(0)}', depart: '${ymd(1)}', guest: 'Zed', rate: 4000 }).then(x => JSON.stringify(x))`));
  assert.equal(J(w, "getLocState('room', 'Room 205').status"), 'reserved');
  assert.equal(w.eval(`hospCancelReservation('${rv.id}', 'changed plans')`), true);
  assert.equal(J(w, "getLocState('room', 'Room 205').status"), 'available');
  b.close();
});
