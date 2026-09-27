import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 139 — custom orders (cakes, meals, platters), catering & events, packages (master prompt §27–29, §65, §71–72, §93, §95 CUSTOM CAKE).
const INV = [{ code: 'BRG', type: 'service', name: 'Beef Burger', category: 'Mains', price: 650, unit: 'pcs', vatCategory: 'A' },
  { code: 'SODA', type: 'item', name: 'Soda', category: 'Soft drinks', price: 100, wholesalePrice: 50, qty: 30, unit: 'pcs', vatCategory: 'A' }];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app(extraFetch) {
  const media = new Map(); const sms = [];
  const fetch = async (url, opts = {}) => {
    const u = String(url);
    if (/\/api\/media/.test(u) && opts.method === 'POST') { const b = JSON.parse(opts.body); media.set(b.id, b); return new Response(JSON.stringify({ ok: true, url: `/api/media?k=${b.k}&id=${b.id}` }), { status: 200 }); }
    if (/\/api\/media\?k=ref/.test(u)) { const id = /id=([^&]+)/.exec(u)[1]; return media.has(id) ? new Response(new Blob(['x'], { type: 'image/jpeg' }), { status: 200 }) : new Response('{}', { status: 404 }); }
    if (/sms-config/.test(u)) return new Response(JSON.stringify({ configured: false }), { status: 200 });
    if (/sms-send/.test(u)) { sms.push(JSON.parse(opts.body)); return new Response('{"success":true}', { status: 200 }); }
    if (/facility-book/.test(u)) return new Response('{"ok":true}', { status: 200 });
    return extraFetch ? extraFetch(url, opts) : new Response('{}', { status: 404 });
  };
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_kitchen_ticket_enabled: 'true', pos_biz_name: 'Sweet Bakes' }, fetch, wait: 1500 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; window.__tickets = []; queuePrintJob = function () { window.__tickets.push(lastKitchenTicketText); return Promise.resolve(); }; renderReceipt = function (s) { window.__receipt = s; }; window.URL.createObjectURL = () => 'blob:x'");
  b.media = media; b.sms = sms;
  return b;
}

test('CUSTOM CAKE end to end: request + reference picture → quote → approval → deposit (receipt) → schedule → production ticket → QC → ready (customer told) → balance → collected → completed', async () => {
  const b = await app(); const { w } = b;
  w.eval("hospConfig.stations.push({ id: 'bakery', label: '🧁 Bakery', print: 'local' })");
  const o = J(w, "hospCreateCustomOrder({ kind: 'cake', title: '2-tier birthday cake', customerName: 'Njeri', phone: '0712345678', dueAt: Date.now() + 3 * 86400000, deliveryMode: 'delivery', address: 'Kilimani', size: '3 kg', flavor: 'Red velvet', tiers: '2', message: 'Happy 30th Njeri', allergies: 'nuts', depositPct: 50 })");
  assert.equal(o.number, 'CO-001'); assert.equal(o.status, 'REQUESTED');
  assert.deepEqual([o.details.flavor, o.details.message, o.details.allergies], ['Red velvet', 'Happy 30th Njeri', 'nuts']);
  // reference picture: compressed, stored privately (kind "ref"), viewable
  w.eval("window.__refCompress = () => Promise.resolve({ dataUrl: 'data:image/jpeg;base64,/9j/AAAA', compressedBytes: 120000, originalBytes: 3000000 })");
  const imgId = await w.eval(`hospAddReferenceImage('${o.id}', new File(['x'], 'design.jpg', { type: 'image/jpeg' }))`);
  assert.ok(imgId && b.media.get(imgId).k === 'ref');
  assert.equal(await w.eval(`hospAddReferenceImage('${o.id}', new File(['x'], 'evil.svg', { type: 'image/svg+xml' }))`), null, 'only real image types');
  await w.eval(`hospViewReferenceImage('${o.id}', '${imgId}')`);
  assert.match(w.document.getElementById('hosp-simple-modal').innerHTML, /blob:x/);
  // cannot take money before a quote is approved
  assert.equal(J(w, `hospPayCustomOrder('${o.id}', 1000, 'cash')`), null);
  assert.equal(w.eval(`hospQuoteCustomOrder('${o.id}', [{ name: '2-tier cake 3 kg', qty: 1, price: 9000 }, { name: 'Delivery', qty: 1, price: 500 }])`), true);
  assert.equal(J(w, `customOrders[0].status`), 'AWAITING_APPROVAL');
  const wa = w.eval(`hospWhatsappQuote('${o.id}')`);
  assert.match(decodeURIComponent(wa), /wa\.me\/254712345678[\s\S]*TOTAL: KES 9,?500\.00[\s\S]*Deposit to confirm \(50%\): KES 4,?750\.00/);
  assert.equal(w.eval(`hospApproveCustomOrder('${o.id}', 'WhatsApp')`), true);
  // scheduling needs the deposit
  assert.equal(w.eval(`hospScheduleCustomOrder('${o.id}', Date.now() + 86400000, 'Baker Ann')`), false);
  const dep = J(w, `hospPayCustomOrder('${o.id}', 4750, 'mpesa', 'QWE123RTY')`);
  assert.equal(dep.mpesaAmount, 4750); assert.match(dep.items[0].name, /Deposit — CO-001/);
  assert.equal(J(w, 'window.__receipt.id'), dep.id, 'a deposit receipt');
  assert.equal(J(w, 'salesLog.filter(s => s.customOrderId).length'), 1, 'the deposit is a real sale');
  assert.equal(J(w, `customOrders[0].status`), 'DEPOSIT_PAID');
  assert.equal(J(w, `hospPayCustomOrder('${o.id}', 99999, 'cash')`), null, 'cannot take more than is owed');
  assert.equal(w.eval(`hospScheduleCustomOrder('${o.id}', Date.now() + 86400000, 'Baker Ann')`), true);
  // production: the bakery gets a ticket with the message and the ALLERGY warning
  assert.equal(w.eval(`hospAdvanceCustomOrder('${o.id}', 'IN_PRODUCTION')`), true);
  const t = w.eval('window.__tickets[window.__tickets.length - 1]');
  assert.match(t, /BAKERY[\s\S]*CUSTOM ORDER[\s\S]*2-tier cake 3 kg \[CO-001\][\s\S]*Message: Happy 30th Njeri[\s\S]*ALLERGIES: nuts/);
  w.eval(`hospAdvanceCustomOrder('${o.id}', 'QUALITY_CHECK')`);
  assert.equal(await w.eval(`hospQualityCheck('${o.id}', false, '')`), false, 'a failed QC must say why');
  assert.equal(await w.eval(`hospQualityCheck('${o.id}', false, 'Icing cracked')`), true);
  assert.equal(J(w, `customOrders[0].status`), 'IN_PRODUCTION');
  w.eval(`hospAdvanceCustomOrder('${o.id}', 'QUALITY_CHECK')`);
  assert.equal(await w.eval(`hospQualityCheck('${o.id}', true, 'Looks great', true)`), true);
  assert.equal(J(w, `customOrders[0].status`), 'READY');
  assert.ok(J(w, 'window.__opened').some((u) => /wa\.me\/254712345678[\s\S]*ready/i.test(decodeURIComponent(u))), 'SMS not set up → told so, and WhatsApp offered');
  assert.ok((w.eval('window.__toasts') || []).some((x) => /SMS is not set up/.test(x)), 'never pretends an SMS was sent');
  // delivered, then complete only when paid in full
  w.eval(`hospAdvanceCustomOrder('${o.id}', 'DELIVERED')`);
  assert.equal(w.eval(`hospAdvanceCustomOrder('${o.id}', 'COMPLETED')`), false, 'balance still owed');
  w.eval(`hospPayCustomOrder('${o.id}', 4750, 'cash')`);
  assert.equal(w.eval(`hospAdvanceCustomOrder('${o.id}', 'COMPLETED')`), true);
  const inv = w.eval(`hospCustomOrderInvoice('${o.id}')`);
  assert.match(inv, /^SWEET BAKES\nINVOICE CO-001[\s\S]*TOTAL: KES 9,?500\.00[\s\S]*deposit\): -KES 4,?750\.00[\s\S]*BALANCE: KES 0\.00/);
  assert.equal(J(w, 'customOrders[0].history.map(h => h.status)').filter((s, i, a) => a.indexOf(s) === i).join(' > '), 'REQUESTED > QUOTED > AWAITING_APPROVAL > APPROVED > DEPOSIT_PAID > SCHEDULED > IN_PRODUCTION > QUALITY_CHECK > READY > DELIVERED > COMPLETED');
  b.close();
});

test('catering / event: the venue is booked through the clash-proof reservations; a second event cannot take the same hall', async () => {
  const b = await app(); const { w } = b;
  const hall = J(w, "hospAddResource({ type: 'event_space', name: 'Garden Hall', capacity: 150, pricing: { mode: 'per_day', rate: 30000 } }).id");
  const e1 = J(w, "hospCreateCustomOrder({ kind: 'event', title: 'Wedding reception', customerName: 'Kamau', guests: '120', menu: 'Buffet', dietary: '10 vegetarian' })");
  const e2 = J(w, "hospCreateCustomOrder({ kind: 'catering', title: 'Corporate lunch', customerName: 'Acme' })");
  const start = Date.now() + 10 * 86400000;
  assert.ok(await w.eval(`hospBookEventVenue('${e1.id}', '${hall}', ${start}, ${start + 8 * 3600000}).then(x => !!x)`));
  assert.equal(J(w, `customOrders.find(o => o.id === '${e1.id}').details.venue`), 'Garden Hall');
  assert.equal(await w.eval(`hospBookEventVenue('${e2.id}', '${hall}', ${start + 3600000}, ${start + 5 * 3600000}).then(x => x)`), null);
  b.close();
});

test('PACKAGE: one priced line; its food & drinks go to kitchen / bar and come off stock; its pool access makes passes', async () => {
  const b = await app(); const { w } = b;
  const pool = J(w, "hospAddResource({ type: 'pool', name: 'Main Pool', capacity: 50, pricing: { mode: 'per_person', rate: 0 } }).id");
  w.eval(`resourceById('${pool}').passes = [{ id: 'fam', name: 'Family entry', price: 0, durationMin: 240, people: 4 }]`);
  const pkg = J(w, `hospAddPackage({ name: 'Family Pool Package', price: 3500, items: [{ code: 'BRG', qty: 2 }, { code: 'SODA', qty: 2 }], passes: [{ resourceId: '${pool}', passId: 'fam', people: 4 }] })`);
  const tabId = J(w, `hospSellPackage('${pkg.id}', 'Guest: Otieno family').id`);
  const lines = J(w, `hospTabLines(tabs.find(t => t.id === '${tabId}')).map(l => l.name + ':' + l.price)`);
  assert.deepEqual(lines, ['📦 Family Pool Package:3500', 'Beef Burger (Family Pool Package):0', 'Soda (Family Pool Package):0']);
  assert.equal(Number(w.eval(`hospTabDue(tabs.find(t => t.id === '${tabId}'))`)), 3500);
  assert.equal(Number(w.eval("inventory.find(p => p.code === 'SODA').qty")), 28);
  const ticket = w.eval('window.__tickets[window.__tickets.length - 1]');
  assert.match(ticket, /KITCHEN[\s\S]*2x\s+Beef Burger/); assert.match(ticket, /BAR[\s\S]*2x\s+Soda/);
  assert.doesNotMatch(ticket, /📦 Family Pool Package/, 'the package line itself is not cooked');
  assert.equal(Number(w.eval(`hospPoolOccupancy('${pool}')`)), 4);
  b.close();
});
