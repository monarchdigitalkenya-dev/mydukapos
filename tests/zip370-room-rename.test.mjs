import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 370: rename a room (Reception + Rooms list); the guest, reservations, bills, room type and requests follow it.
const QUIET = "window.__toasts = []; showToast = function (m, e) { window.__toasts.push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.print = () => {};";
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (days) => new Date(Date.now() + 3 * 3600000 + days * 86400000).toISOString().slice(0, 10);
const setVal = (w, id, v) => { const e = w.document.getElementById(id); e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); };
const open = () => boot('hotel/index.html', { storage: { pos_rooms: JSON.stringify(['Room 01', 'Room 02', 'Room 03']), pos_tables: JSON.stringify(['Table 1']), pos_inventory: JSON.stringify([]) },
  fetch: async (u) => (/qr-order|facility-book/.test(String(u)) ? new Response('{"ok":true}', { status: 200 }) : new Response('{}', { status: 404 })), wait: 1500 });

async function furnish(w) {
  w.eval(QUIET); w.eval('currentServer = null');
  w.eval("openCheckInRoomModal('Room 01')"); setVal(w, 'checkin-guest-name-input', 'Achieng'); setVal(w, 'checkin-nightly-rate-input', '3000'); w.eval('confirmCheckIn()');
  w.eval("openCheckInRoomModal('Room 02')"); setVal(w, 'checkin-guest-name-input', 'Wanjiru'); setVal(w, 'checkin-nightly-rate-input', '2500');
  setVal(w, 'checkin-date-input', ymd(5)); w.document.getElementById('checkin-date-input').dispatchEvent(new w.Event('change', { bubbles: true }));
  w.eval('confirmCheckIn()'); await sleep(300);
}

test('rename carries the guest, bill, reservation, room type, status and open requests to the new name', async () => {
  const d = await open();
  try {
    const w = d.w; await furnish(w);
    assert.equal(J(w, "roomStayFor('Room 01').guestName"), 'Achieng');
    w.eval("hospConfig.roomTypes = [{id:'t1',name:'Deluxe',rate:3000,capacity:2}]; hospSetRoomType('Room 01','t1'); hospSetRoomType('Room 02','t1');");
    w.eval("hospAddServiceRequest({room:'Room 01', type:'other', notes:'extra towels'})");
    const openBill = J(w, "tabs.filter(t => t.status === 'OPEN' && t.label === 'Room 01').length");
    const r1 = J(w, "HotelFD.renameRoom('Room 01', '  Room   Ten ')");
    assert.equal(r1.ok, true, r1.msg); assert.equal(r1.name, 'Room Ten');
    assert.deepEqual(J(w, 'rooms'), ['Room Ten', 'Room 02', 'Room 03']);
    assert.equal(J(w, "roomStayFor('Room Ten').guestName"), 'Achieng'); assert.equal(J(w, "roomStayFor('Room 01')"), null);
    assert.equal(J(w, "roomStates['Room 01'] || null"), null);
    assert.equal(J(w, "tabs.filter(t => t.status === 'OPEN' && t.label === 'Room Ten').length"), openBill);
    assert.equal(J(w, "tabs.filter(t => t.label === 'Room 01' && t.status === 'OPEN').length"), 0);
    assert.equal(J(w, "hospRoomType('Room Ten').name"), 'Deluxe'); assert.equal(J(w, "hospRoomType('Room 01')"), null);
    assert.equal(J(w, "serviceRequests.filter(r => r.room === 'Room Ten').length"), 1);
    // saved to storage too (survives a reload)
    assert.deepEqual(JSON.parse(w.localStorage.getItem('pos_rooms')), ['Room Ten', 'Room 02', 'Room 03']);
    assert.ok(JSON.parse(w.localStorage.getItem('pos_room_stays'))['Room Ten']);
    // the coming reservation follows the room
    const r2 = J(w, "HotelFD.renameRoom('Room 02', 'Garden View')"); assert.equal(r2.ok, true, r2.msg);
    const bk = J(w, "facilityBookings.filter(b => b.kind === 'room' && b.status === 'BOOKED')");
    assert.equal(bk.length, 1); assert.deepEqual([bk[0].resourceName, bk[0].resourceId], ['Garden View', 'room:Garden View']);
    // the printed QR code is renamed (queued, so it also works offline)
    assert.match(w.localStorage.getItem('pos_hosp_qr_outbox') || JSON.stringify(J(w, 'hospQrOutbox()')), /Garden View/);
  } finally { d.close(); }
});

test('after a rename the guest can still be checked out and the reservation still checked in under the new name', async () => {
  const d = await open();
  try {
    const w = d.w; await furnish(w);
    w.eval("HotelFD.renameRoom('Room 01', 'Suite A')");
    w.eval("openCheckOutRoomModal('Suite A')");
    w.eval('confirmCheckOut()');
    const folio = J(w, "tabs.find(t => t.status === 'OPEN' && t.checkoutOf === 'Suite A')");
    assert.ok(folio, 'check-out built the folio under the new name'); assert.equal(folio.label, 'Suite A');
    assert.ok(folio.orders.some((o) => o.roomFolio), 'the room charge is on it');
    assert.equal(J(w, "roomStayFor('Suite A').guestName"), 'Achieng');
    // reservation: rename, then it still blocks double-booking on the new name and shows in Reception
    w.eval("HotelFD.renameRoom('Room 02', 'Suite B')");
    const busy = J(w, `hospRoomFree('Suite B', Date.parse('${ymd(5)}T12:00:00+03:00'), Date.parse('${ymd(6)}T10:00:00+03:00'))`);
    assert.ok(busy, 'Suite B is still held for the reservation');
    w.document.getElementById('front-desk-tab-btn').click(); await sleep(200);
    const t = w.document.getElementById('front-desk-tab').textContent;
    assert.match(t, /Suite A/); assert.match(t, /Suite B/); assert.doesNotMatch(t, /Room 01|Room 02/);
  } finally { d.close(); }
});

test('rename is refused for empty, same, duplicate (any case), table-name and over-long names; nothing changes', async () => {
  const d = await open();
  try {
    const w = d.w; await furnish(w);
    const before = JSON.stringify(J(w, 'rooms'));
    for (const bad of ['', '   ', 'Room 01', 'room 02', 'ROOM 03', 'Table 1', 'x'.repeat(41)]) {
      const r = J(w, `HotelFD.renameRoom('Room 01', ${JSON.stringify(bad)})`); assert.equal(r.ok, false, 'refused: ' + JSON.stringify(bad));
    }
    assert.equal(JSON.stringify(J(w, 'rooms')), before); assert.equal(J(w, "roomStayFor('Room 01').guestName"), 'Achieng');
    assert.equal(J(w, "HotelFD.renameRoom('Nope', 'Zed')").ok, false);
    // you can rename a room to the same letters in another case of ITS OWN name
    assert.equal(J(w, "HotelFD.renameRoom('Room 03', 'ROOM 03')").ok, true);
    assert.deepEqual(J(w, 'rooms').slice(-1), ['ROOM 03']);
  } finally { d.close(); }
});

test('the Rename button in Reception and in the Rooms list works; a read-only branch view cannot rename', async () => {
  const d = await open();
  try {
    const w = d.w; await furnish(w);
    w.document.getElementById('front-desk-tab-btn').click(); await sleep(200);
    const btn = w.document.querySelector('#front-desk-tab [data-fd="rename"][data-room="Room 03"]'); assert.ok(btn, 'a Rename button on each room card');
    assert.equal(w.document.querySelectorAll('#front-desk-tab [data-fd="rename"]').length, 3);
    w.prompt = () => 'Pool Side'; btn.click(); await sleep(100);
    assert.ok(J(w, 'rooms').includes('Pool Side')); assert.match(w.document.getElementById('front-desk-tab').textContent, /Pool Side/);
    assert.ok(w.__toasts.some((m) => /now Pool Side/.test(m)));
    // Rooms list card
    w.eval('renderTablesRoomsLists()');
    const cards = [...w.document.querySelectorAll('#rooms-list button[title="Rename this room"]')]; assert.equal(cards.length, 3, 'one Rename button per room in the Rooms list');
    w.prompt = () => 'Pool Deck'; cards.find((b) => /Pool Side/.test(b.getAttribute('onclick'))).click();
    assert.ok(J(w, 'rooms').includes('Pool Deck'));
    // cancelling the prompt changes nothing
    w.prompt = () => null; w.eval("HotelFD.askRename('Pool Deck')"); assert.ok(J(w, 'rooms').includes('Pool Deck'));
    // read-only branch view
    w.eval("viewedBranchId = 'branch-x'");
    const ro = J(w, "HotelFD.renameRoom('Pool Deck', 'Zed')"); assert.equal(ro.ok, false); assert.match(ro.msg, /viewing another branch/);
    w.eval("viewedBranchId = 'self'");
  } finally { d.close(); }
});
