import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { boot, ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { sleep } from './e2e-harness.mjs';

// Zip 132: the open HMIS items (separate Pharmacy and Cashier stations, search-first appointment picker, void / discount requests
// approved by a manager, cancelled charges not shown as "Unpaid"), radiology images (compressed, uploaded, viewable) and
// "Add item" photos from the device only (never the camera).
const APP = 'hospital/index.html';
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const P = (id, name) => ({ id, name, age: 40, sex: 'male', phone: '0711000' + id.replace(/\D/g, ''), allergies: '', registeredAt: Date.now() - 86400000 });
const PATIENTS = [P('PT-1', 'John Otieno'), P('PT-2', 'Mary Wanjiru')];
const INV = [{ code: 'AX', type: 'item', name: 'Amoxicillin 500mg', price: 30, wholesalePrice: 15, qty: 40, unit: 'pcs', vatCategory: 'A' }];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app(extra = {}) {
  const b = await boot(APP, { storage: { pos_patients: JSON.stringify(PATIENTS), pos_inventory: JSON.stringify(INV), ...(extra.storage || {}) }, indexedDB: extra.indexedDB, fetch: extra.fetch, wait: 1500 });
  b.w.eval("showToast = function (m) { (window.__toasts = window.__toasts || []).push(m); }; window.confirm = () => (window.__confirmAnswer !== undefined ? window.__confirmAnswer : true); window.prompt = (m, d) => (window.__promptAnswers && window.__promptAnswers.length ? window.__promptAnswers.shift() : 'test reason'); window.print = () => {}");
  return b;
}

const ADD_ITEM_APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];
for (const a of ADD_ITEM_APPS) {
  test(`${a}: adding an item offers "upload from device" only — the camera is never opened`, async () => {
    const b = await boot(a, { wait: 900 });
    b.w.eval('window.__gum = 0; navigator.mediaDevices = { getUserMedia: () => { window.__gum++; return new Promise(() => {}); } }');
    b.w.eval(`document.querySelector('.tab-link[data-tab="add-item-tab"]').click()`);
    await sleep(50);
    const d = b.d;
    assert.equal(d.getElementById('src-camera-btn'), null, 'no "Use Camera" button');
    assert.equal(d.getElementById('camera-wrapper'), null, 'no camera view');
    assert.ok(d.getElementById('upload-wrapper').classList.contains('show'), 'the upload box is shown');
    const input = d.getElementById('image-file-input');
    assert.ok(input && input.getAttribute('accept') === 'image/*' && !input.hasAttribute('capture'), 'a plain file picker (no capture)');
    b.w.eval("setImageSource('camera')");                    // even an old call cannot switch the camera on
    assert.equal(b.w.eval('window.__gum'), 0, 'getUserMedia never called');
    b.close();
  });
}

test('Pharmacy and Cashier are separate stations: clinic → Pharmacy (unpaid → Cashier) → Cashier takes payment → Pharmacy dispenses', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("renderReceptionTab(); onReceptionPatientPicked('PT-1'); receptionSendTo('PT-1', 'consultation')");
  const id = w.eval("queue.find(q => q.patientId === 'PT-1').id");
  w.eval("hmisCallNext('consultation')");
  w.eval(`hmisOpenConsult('${id}')`);
  d.getElementById('visit-diagnosis-input').value = 'Chest infection';
  w.eval("visitMedicationDraft = [{ code: 'AX', qty: 6, dosage: '1 x 3' }]");
  w.eval('saveVisit()');
  await sleep(20);
  assert.equal(d.getElementById('hmis-route-dest').value, 'pharmacy');
  w.eval('hmisConfirmRoute()');
  // two tabs, two queues
  assert.ok(d.querySelector('.tab-link[data-tab="pharmacy-tab"]'), 'a Pharmacy (Dispensing) tab');
  assert.match(d.querySelector('.tab-link[data-tab="sales-tab"]').textContent, /Cashier/);
  w.eval(`document.querySelector('.tab-link[data-tab="pharmacy-tab"]').click()`);
  assert.match(d.getElementById('pharmacy-station-board').innerHTML, /PH-001/);
  w.eval("hmisCallNext('pharmacy')");
  w.eval(`hmisShowDispenseFor('${id}')`);
  assert.match(d.getElementById('hmis-modal-body').innerHTML, /Not paid yet[\s\S]*Amoxicillin[\s\S]*Send to Cashier/);
  assert.equal(J(w, `hmisSuggestNext(queue.find(q => q.id === '${id}'))`), 'cashier');
  w.eval(`hmisCloseModal(); hmisUiRoute('${id}','cashier','Medicines to pay for')`);
  // Cashier: the counter takes the payment (stock comes off here, as before)
  w.eval("hmisCallNext('cashier')");
  w.eval(`hmisUiCounter('${id}')`);
  await sleep(120);
  w.eval('confirmMedicationCarry()');
  w.eval("currentPaymentMethod = 'cash'"); d.getElementById('cash-tendered-input').value = '100000';
  await w.eval('checkoutCart()');
  assert.equal(Number(w.eval("inventory.find(p => p.code === 'AX').qty")), 34);
  assert.equal(J(w, "pharmacyAwaiting('PT-1').length"), 1, 'paid, waiting to be handed over');
  assert.equal(J(w, `hmisSuggestNext(queue.find(q => q.id === '${id}'))`), 'pharmacy', 'after paying: to the Pharmacy');
  w.eval(`hmisUiRoute('${id}','pharmacy','Collect medicines')`);
  w.eval(`document.querySelector('.tab-link[data-tab="pharmacy-tab"]').click()`);
  assert.match(d.getElementById('pharmacy-dispense-list').innerHTML, /John Otieno[\s\S]*Amoxicillin/);
  w.eval("pharmacyDispenseAll('PT-1')");
  const c = J(w, "patientCharges.find(c => c.patientId === 'PT-1' && c.kind === 'medication')");
  assert.equal(c.dispenseState, 'dispensed'); assert.ok(c.dispensedAt && c.dispensedBy);
  assert.equal(J(w, "pharmacyAwaiting().length"), 0);
  assert.match(d.getElementById('pharmacy-dispensed-list').innerHTML, /Amoxicillin/);
  assert.equal(J(w, `hmisSuggestNext(queue.find(q => q.id === '${id}'))`), 'discharge');
  assert.ok(J(w, `queue.find(q => q.id === '${id}').events`).some((e) => e.action === 'dispensed'), 'the journey records the dispensing');
  assert.equal(Number(w.eval("inventory.find(p => p.code === 'AX').qty")), 34, 'dispensing does not take stock twice');
  b.close();
});

test('a paid medicine not collected is recorded with a reason (and never shown as waiting again)', async () => {
  const b = await app(); const { w } = b;
  w.eval("patientCharges.push({ id: 'ch1', ref: 'V1', patientId: 'PT-2', patientName: 'Mary Wanjiru', kind: 'medication', name: 'Amoxicillin 500mg', code: 'AX', qty: 2, price: 30, status: 'paid', dispenseState: 'awaiting', paidAt: Date.now() })");
  w.eval("window.__promptAnswers = ['patient left']; pharmacyNotCollected('ch1')");
  const c = J(w, "patientCharges.find(c => c.id === 'ch1')");
  assert.deepEqual([c.dispenseState, c.notCollectedReason], ['not_collected', 'patient left']);
  assert.equal(J(w, 'pharmacyAwaiting().length'), 0);
  // charges paid before this release (no dispensing state) are not listed as waiting
  w.eval("patientCharges.push({ id: 'old1', ref: 'V0', patientId: 'PT-2', kind: 'medication', name: 'X', qty: 1, price: 1, status: 'paid' })");
  assert.equal(J(w, 'pharmacyAwaiting().length'), 0);
  b.close();
});

test('Appointments: patients are found by search (no drop-down of every patient) and the appointment is booked', async () => {
  const b = await app(); const { w, d } = b;
  w.eval(`document.querySelector('.tab-link[data-tab="appointments-tab"]').click()`);
  w.eval('populateAppointmentPatientSelect()');
  assert.equal(d.querySelector('select#appt-patient-select'), null, 'no drop-down');
  const q = d.getElementById('appt-patient-picker-q');
  assert.ok(q, 'a search box');
  q.value = 'wanj'; w.eval("runPatientSearchPicker('appt-patient-picker','appt-patient-select')");
  assert.match(d.getElementById('appt-patient-picker-results').innerHTML, /Mary Wanjiru/);
  assert.doesNotMatch(d.getElementById('appt-patient-picker-results').innerHTML, /John Otieno/);
  w.eval("pickPatientFromSearch('appt-patient-picker','appt-patient-select','PT-2')");
  d.getElementById('appt-datetime-input').value = '2030-01-02T09:30';
  w.eval('scheduleAppointment()');
  assert.equal(J(w, "appointments.filter(a => a.patientId === 'PT-2').length"), 1);
  assert.equal(d.getElementById('appt-patient-select').value, '', 'cleared for the next booking');
  b.close();
});

const CASHIER = { id: 'st1', name: 'Cashier Cate', roles: ['daily-sales-tab', 'cash-shift-tab'] };
const MANAGER = { id: 'st2', name: 'Manager Mo', isManager: true, roles: ['daily-sales-tab', 'cash-shift-tab'] };
test('a cashier REQUESTS a void; nothing changes until a manager approves it (then stock returns); a rejection needs a reason', async () => {
  const sale = { id: 's1', refNumber: 'R-1', timestamp: new Date().toISOString(), paid: true, paymentMethod: 'cash', items: [{ code: 'AX', name: 'Amoxicillin 500mg', qty: 2, price: 30, unit: 'pcs' }], servedBy: 'Cashier Cate' };
  const b = await app({ storage: { pos_staff: JSON.stringify([CASHIER, MANAGER]), pos_sales_log: JSON.stringify([sale]) } });
  const { w } = b;
  w.eval("currentServer = staff.find(s => s.id === 'st1')");
  w.eval("window.__confirmAnswer = true; window.__promptAnswers = ['wrong item']; requestVoidSale('s1', 'sales')");
  let r = J(w, "approvalRequests.find(r => r.type === 'void')");
  assert.equal(r.status, 'pending'); assert.equal(r.requestedBy, 'Cashier Cate');
  assert.equal(J(w, "salesLog[0].voided || false"), false, 'the sale still counts');
  assert.equal(w.eval(`decideVoidOrDiscount('${r.id}', true, '')`), false, 'a cashier cannot approve');
  w.eval("currentServer = staff.find(s => s.id === 'st2')");
  assert.equal(w.eval(`decideVoidOrDiscount('${r.id}', false, '')`), false, 'rejecting needs a reason');
  const qtyBefore = Number(w.eval("inventory.find(p => p.code === 'AX').qty"));
  assert.equal(w.eval(`decideVoidOrDiscount('${r.id}', true, 'ok')`), true);
  r = J(w, "approvalRequests.find(r => r.type === 'void')");
  assert.deepEqual([r.status, r.decidedBy], ['approved', 'Manager Mo']);
  assert.equal(J(w, 'salesLog[0].voided'), true);
  assert.match(J(w, 'salesLog[0].voidReason'), /wrong item.*requested by Cashier Cate.*approved by Manager Mo/);
  assert.equal(Number(w.eval("inventory.find(p => p.code === 'AX').qty")), qtyBefore + 2, 'stock returned once');
  assert.ok(J(w, 'auditLog').some((a) => a.action === 'Void approved'));
  b.close();
});

test('a discount request is tied to its cart: approved on another device, applied once here, refused if the cart changed', async () => {
  const b = await app({ storage: { pos_staff: JSON.stringify([CASHIER, MANAGER]), pos_require_cart_price_pw: 'true' } });
  const { w, d } = b;
  w.eval("currentServer = staff.find(s => s.id === 'st1')");
  w.eval("addToCart && addToCart('AX'); currentCart[Object.keys(currentCart)[0]].qty = 4; renderCart()");
  assert.equal(Number(w.eval('cartTotal()')), 120);
  w.eval("requestDiscountApproval(120, 100, 'loyal patient'); renderCart()");
  assert.match(d.getElementById('discount-request-status').textContent, /waiting for a manager/);
  const id = w.eval("approvalRequests.find(r => r.type === 'discount').id");
  w.eval("currentServer = staff.find(s => s.id === 'st2')");
  assert.equal(w.eval(`decideVoidOrDiscount('${id}', true, '')`), true);
  w.eval("currentServer = staff.find(s => s.id === 'st1'); renderCart()");
  assert.match(d.getElementById('discount-request-status').textContent, /approved by Manager Mo/);
  w.eval(`applyApprovedDiscount('${id}')`);
  assert.equal(Number(w.eval('cartTotal()')), 100, 'the approved total');
  assert.ok(J(w, `approvalRequests.find(r => r.id === '${id}').appliedAt`));
  w.eval(`applyApprovedDiscount('${id}')`);
  assert.equal(Number(w.eval('cartTotal()')), 100, 'used once only');
  // a second request, then the cart changes: the approval cannot be used
  w.eval("requestDiscountApproval(100, 90, 'x')");
  const id2 = w.eval("approvalRequests.filter(r => r.type === 'discount').pop().id");
  w.eval("currentServer = staff.find(s => s.id === 'st2')");
  w.eval(`decideVoidOrDiscount('${id2}', true, '')`);
  w.eval("currentServer = staff.find(s => s.id === 'st1'); currentCart[Object.keys(currentCart)[0]].qty = 5; renderCart()");
  w.eval(`applyApprovedDiscount('${id2}')`);
  assert.notEqual(Number(w.eval('cartTotal()')), 90, 'not applied to a changed cart');
  b.close();
});

test("a cancelled charge no longer shows the patient's bill as Unpaid", async () => {
  const b = await app(); const { w, d } = b;
  w.eval("patientCharges.push({ id: 'c1', ref: 'V9', patientId: 'PT-1', kind: 'radiology', name: 'Imaging: X-ray Chest', qty: 1, price: 800, status: 'cancelled', createdAt: Date.now() })");
  w.eval("patientCharges.push({ id: 'c2', ref: 'V8', patientId: 'PT-1', kind: 'service', name: 'Consultation', qty: 1, price: 500, status: 'paid', createdAt: Date.now() - 1000 }, { id: 'c3', ref: 'V8', patientId: 'PT-1', kind: 'service', name: 'Dressing', qty: 1, price: 200, status: 'cancelled', createdAt: Date.now() - 1000 })");
  let el = d.getElementById('patient-billing-history-list');
  if (!el) { el = d.createElement('div'); el.id = 'patient-billing-history-list'; d.body.appendChild(el); }
  w.eval("renderPatientBillingHistory('PT-1')");
  const html = el.innerHTML;
  assert.match(html, /Ref V9<\/strong> — KES 0\.00 <span>⚪ Cancelled/);
  assert.match(html, /Ref V8<\/strong> — KES 500\.00 <span>✅ Paid/, 'the cancelled line does not make a paid bill "partially paid"');
  assert.doesNotMatch(html, /Unpaid/);
  b.close();
});

test('server: radiology images are stored per shop, idempotently, size-checked, and readable only by that shop', async () => {
  const kv = makeKV(); seedShop(kv, 'C1'); seedShop(kv, 'C2');
  const env = { mydukapos_kv: kv };
  const m = await load('radiology-image.js');
  const post = (c, body) => m.onRequestPost({ request: new Request(`https://x.pages.dev/api/radiology-image?c=${c}`, { method: 'POST', body: JSON.stringify(body) }), env });
  const get = (c, id) => m.onRequestGet({ request: new Request(`https://x.pages.dev/api/radiology-image?c=${c}&id=${id}`), env });
  const img = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2997)]).toString('base64');   // a real JPEG signature (zip 133 checks it)
  let r = await post('C1', { id: 'ri-0001', orderId: 'o1', dataUrl: img });
  assert.equal(r.status, 200); assert.equal((await r.json()).bytes, 3000);
  r = await post('C1', { id: 'ri-0001', orderId: 'o1', dataUrl: img });
  assert.equal(r.status, 200, 'a retried upload is fine');
  r = await get('C1', 'ri-0001'); assert.equal(r.status, 200); assert.equal((await r.json()).dataUrl, img);
  assert.equal((await get('C2', 'ri-0001')).status, 404, 'another shop cannot read it');
  assert.equal((await post('C1', { id: 'ri-0002', dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(m.MAX_DATAURL_CHARS) })).status, 413);
  assert.equal((await post('C1', { id: 'ri-0003', dataUrl: 'data:text/html;base64,AAAA' })).status, 400, 'only images');
  assert.equal((await post('C1', { id: '../x', dataUrl: img })).status, 400);
  await post('C1', { action: 'delete', id: 'ri-0001' });
  assert.equal((await get('C1', 'ri-0001')).status, 404);
});

test('radiology images: compressed on the device, kept while offline, uploaded when back, viewable; the order syncs only the list', async () => {
  let online = false; const posted = [];
  const fetch = async (url, opts = {}) => {
    const u = String(url);
    if (/radiology-image/.test(u)) {
      if (!online) throw new TypeError('Failed to fetch');
      if ((opts.method || 'GET') === 'POST') { posted.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
      return new Response(JSON.stringify({ dataUrl: 'data:image/jpeg;base64,SERVER' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  const b = await app({ indexedDB: new IDBFactory(), fetch }); const { w, d } = b;
  // compression stub: what compressImageToTarget returns for a 5 MB phone photo
  w.eval("window.__radCompress = (f, o) => { window.__radOpts = o; return Promise.resolve({ dataUrl: 'data:image/jpeg;base64,COMPRESSED', originalBytes: 5000000, compressedBytes: 260000 }); }");
  const o = J(w, "requestRadiology('PT-1', 'X-ray', 'Chest PA', 'cough', 'routine')");
  w.eval(`markRadiologyPerformed('${o.id}', '')`);
  const file = "new File(['x'], 'film.jpg', { type: 'image/jpeg' })";
  const nAdded = await w.eval(`radHandleImageFiles('${o.id}', [${file}, new File(['x'], 'notes.pdf', { type: 'application/pdf' })])`);
  assert.equal(nAdded, 1, 'only the image is taken');
  assert.deepEqual(J(w, 'window.__radOpts'), { maxW: 1600, maxH: 1600, maxBytes: 350 * 1024 });
  assert.equal(await w.eval('radUploadPending()'), 0, 'offline: nothing uploaded');
  let im = J(w, `radiologyOrders.find(x => x.id === '${o.id}').images[0]`);
  assert.deepEqual([im.status, im.bytes, im.originalBytes], ['pending', 260000, 5000000]);
  assert.ok(!JSON.stringify(J(w, 'radiologyOrders')).includes('COMPRESSED'), 'the picture itself is not in the synced order');
  assert.match(w.localStorage.getItem('pos_radiology_orders'), /"status":"pending"/);
  w.eval('renderRadiologyTab()');
  assert.match(d.getElementById('radiology-body').innerHTML, /🖼️ 1[\s\S]*254 KB[\s\S]*uploading/);
  // back online: uploaded, marked
  online = true;
  await w.eval('radUploadPending()');
  assert.equal(posted.length, 1); assert.equal(posted[0].dataUrl, 'data:image/jpeg;base64,COMPRESSED');
  im = J(w, `radiologyOrders.find(x => x.id === '${o.id}').images[0]`);
  assert.equal(im.status, 'uploaded');
  assert.equal(await w.eval('radUploadPending()'), 0, 'nothing sent twice');
  // view: from this device's copy
  await w.eval(`radViewImage('${o.id}', '${im.id}')`);
  assert.match(d.getElementById('hmis-modal-body').innerHTML, /COMPRESSED/);
  // a device without the copy fetches it from the server
  await w.eval(`radImgTx('cache', 'readwrite', st => st.delete('${im.id}'))`);
  await w.eval(`radViewImage('${o.id}', '${im.id}')`);
  assert.match(d.getElementById('hmis-modal-body').innerHTML, /SERVER/);
  // the add-images picker is a plain file picker (no camera)
  w.eval(`HTMLInputElement.prototype.click = function () {}; radAddImages('${o.id}')`);
  const input = d.getElementById('rad-image-input');
  assert.ok(input.multiple && input.accept === 'image/*' && !input.hasAttribute('capture'));
  b.close();
});

test('server merge: two devices adding images to the same imaging order keep both; an upload/removal is never undone', async () => {
  const { mergeRecordsById } = await load('_merge.js');
  const stored = { id: 'o1', updatedAt: 5, status: 'verified', images: [{ id: 'a', status: 'uploaded' }, { id: 'b', status: 'pending' }] };
  const incoming = { id: 'o1', updatedAt: 6, status: 'reported', images: [{ id: 'a', status: 'pending' }, { id: 'c', status: 'pending', removedAt: 1 }] };
  const [m] = mergeRecordsById([stored], [incoming], false, 'radiologyOrders');
  assert.equal(m.status, 'reported', 'the newest record decides (a corrected report)');
  assert.deepEqual(m.images.map((x) => x.id).sort(), ['a', 'b', 'c']);
  assert.equal(m.images.find((x) => x.id === 'a').status, 'uploaded');
});
