// zip 330: hotel "Room services price list" — dry cleaning / laundry items with prices, picked into a room service request, charged to the room's bill once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const STAFF = [{ id: 'm1', name: 'Mo', isManager: true, roles: ['hotel-tab'] }];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app() {
  const fetch = async (url) => (/facility-book/.test(String(url)) ? new Response('{"ok":true}', { status: 200 }) : new Response('{}', { status: 404 }));
  const b = await boot('hotel/index.html', { storage: { pos_inventory: '[]', pos_rooms: JSON.stringify(['Room 101', 'Room 102']), pos_tables: '[]', pos_staff: JSON.stringify(STAFF) }, fetch, wait: 900 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true;");
  b.w.eval("currentServer = staff.find(s => s.id === 'm1')");
  b.w.eval("roomStays['Room 101'] = { guestName: 'Brian', checkInAt: new Date().toISOString(), checkOutDue: null, nightlyRate: 5000, depositAmount: 0, creditLimit: 0 }; setLocStatus('room', 'Room 101', 'occupied')");
  return b;
}

test('R1 the price board loads (25 items, free items at 0), is not duplicated, and prices / names can be edited and items removed', async () => {
  const { w, d, close } = await app();
  try {
    assert.equal(w.eval('hospRoomServices().length'), 0);
    assert.equal(w.eval('hospLoadStarterServices()'), 25);
    assert.equal(w.eval('hospRoomServices().length'), 25);
    assert.equal(w.eval('hospLoadStarterServices()'), 0, 'a second load adds nothing');
    const suit = J(w, "hospRoomServices().find(x => x.group === 'Dry cleaning' && x.name === 'Suits')");
    assert.equal(suit.price, 600);
    assert.equal(J(w, "hospRoomServices().find(x => x.group === 'Laundry' && x.name === 'Tie')").price, 0);
    assert.equal(J(w, "hospRoomServices().find(x => x.group === 'Laundry' && x.name === 'Trousers')").price, 100, 'same name in two groups keeps two prices');
    w.eval(`hospSetRoomServicePrice('${suit.id}', 650)`); assert.equal(J(w, `hospRoomServices().find(x => x.id === '${suit.id}')`).price, 650);
    w.eval(`hospSetRoomServicePrice('${suit.id}', -5)`); assert.equal(J(w, `hospRoomServices().find(x => x.id === '${suit.id}')`).price, 650, 'a negative price is refused');
    const id = w.eval("hospAddRoomService('Ironing', 'Shirt pressing', 80)"); assert.ok(id);
    assert.equal(w.eval("hospAddRoomService('Ironing', 'shirt pressing', 90)"), id, 'the same service is updated, not duplicated');
    assert.equal(J(w, `hospRoomServices().find(x => x.id === '${id}')`).price, 90);
    assert.equal(w.eval("hospAddRoomService('Ironing', '', 10)"), null, 'a name is required');
    w.eval(`hospRemoveRoomService('${id}')`); assert.equal(w.eval(`hospRoomServices().some(x => x.id === '${id}')`), false);
    // it shows on the Hotel screen
    w.eval("renderHotel()");
    assert.ok(d.getElementById('hotel-body').textContent.includes('Room services price list'));
    assert.ok(d.getElementById('hotel-body').textContent.includes('Leather jacket'));
  } finally { close(); }
});

test('R2 a request built from the list is priced from it, and goes on the guest\'s room bill as one line per item - once', async () => {
  const { w, close } = await app();
  try {
    w.eval('hospLoadStarterServices()');
    const shirt = J(w, "hospRoomServices().find(x => x.group === 'Dry cleaning' && x.name === 'Shirt')");
    const trs = J(w, "hospRoomServices().find(x => x.group === 'Laundry' && x.name === 'Trousers')");
    const tie = J(w, "hospRoomServices().find(x => x.name === 'Tie')");
    w.eval(`hospSrCartAdd('${shirt.id}', 2); hospSrCartAdd('${trs.id}', 3); hospSrCartAdd('${tie.id}', 1); hospSrCartAdd('${shirt.id}', 1)`);
    assert.equal(w.eval('hospSrCartTotal()'), 3 * 200 + 3 * 100, 'shirts merged into one line of 3');
    const r = J(w, "hospAddServiceRequest({ room: 'Room 101', type: 'dry_cleaning', notes: '', charge: '', items: window.__srCart })");
    assert.equal(r.charge, 900); assert.match(r.notes, /3× Shirt/); assert.equal(r.items.length, 3);
    // a later price change does not alter this request
    w.eval(`hospSetRoomServicePrice('${shirt.id}', 999)`);
    assert.equal(J(w, `serviceRequests.find(x => x.id === '${r.id}')`).charge, 900);
    for (let i = 0; i < 3; i++) w.eval(`hospAdvanceServiceRequest('${r.id}', null, 'Joy')`);
    assert.equal(J(w, `serviceRequests.find(x => x.id === '${r.id}')`).status, 'DONE');
    const lines = J(w, "hospTabLines(findOpenTabByLabel('Room 101')).map(l => [l.name, l.qty, l.price])");
    assert.deepEqual(lines.sort(), [['Dry cleaning — Shirt', 3, 200], ['Laundry — Trousers', 3, 100]].sort(), 'one folio line per priced item; the free tie adds no line');
    w.eval(`hospAdvanceServiceRequest('${r.id}', 'DONE')`);
    assert.equal(J(w, "hospTabLines(findOpenTabByLabel('Room 101')).reduce((t, l) => t + l.qty * l.price, 0)"), 900, 'never charged twice');
  } finally { close(); }
});

test('R3 a plain single-charge request still works as before, and the item picker refuses an unknown service', async () => {
  const { w, close } = await app();
  try {
    assert.equal(w.eval("hospSrCartAdd('nope', 1)"), false);
    const r = J(w, "hospAddServiceRequest({ room: 'Room 101', type: 'laundry', notes: 'Bag of clothes', charge: 400 })");
    assert.equal(r.charge, 400); assert.ok(!r.items);
    for (let i = 0; i < 3; i++) w.eval(`hospAdvanceServiceRequest('${r.id}', null, 'Joy')`);
    assert.ok(J(w, "hospTabLines(findOpenTabByLabel('Room 101')).some(l => /Laundry/.test(l.name) && l.price === 400)"));
  } finally { close(); }
});
