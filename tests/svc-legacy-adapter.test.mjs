// B1-D: the read-only legacy adapter (SERVICES_ARCHITECTURE.md 4.1). Fixtures are built from the REAL legacy shapes written by services/index.html
// (saveClientRegistryJob / saveServicesCounterLeftItem / completeServiceJob / resolveJobBillStatuses / saveBooking): tests/fixtures/legacy-*.json.
// Guarantees tested: 1:1 mapping with zero data loss, legacy data NEVER mutated (by any adapter / engine call), views frozen, engine writes refuse legacy rows,
// promoted rows are hidden, money derives like the old Client Registry, and the real page keeps running its old screens on the same rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { boot, ROOT } from './helpers.mjs';
import { loadSvc, blockScripts, toPlain } from './svc-helpers.mjs';

const R = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures', f), 'utf8'));
const JOBS = R('legacy-service-jobs.json'), BOOKINGS = R('legacy-bookings.json'), CUSTOMERS = R('legacy-customers.json'), BILLS = R('legacy-bills.json'), INVENTORY = R('legacy-inventory.json');
const T0 = Date.UTC(2026, 8, 30, 9, 0, 0);

function mk(over = {}) {
  const win = { __svcNow: T0 };
  const g = { window: win, queuePush() {}, currentServer: null, serviceJobs: R('legacy-service-jobs.json'), bookings: R('legacy-bookings.json'), customers: R('legacy-customers.json'), bills: R('legacy-bills.json'), inventory: R('legacy-inventory.json'), staff: [], ...over };
  const ctx = loadSvc(['svc-core', 'svc-templates'], g);
  blockScripts('svc-store').forEach((js) => vm.runInContext(js, ctx));
  return { ctx, win, legacySnapshot: () => JSON.stringify({ j: ctx.serviceJobs, b: ctx.bookings, c: ctx.customers, bl: ctx.bills, i: ctx.inventory }) };
}

// the reverse of the adapter: rebuild the legacy record from the view. If this equals the original, nothing was lost.
function recover(v) {
  const d = v.data || {};
  const o = {
    id: v.legacyId, createdAt: d.leg_created_at, clientName: v.customer.name, clientPhone: v.customer.phone, idNumber: d.leg_id_number || '', itemDetails: d.leg_item_details || '',
    servicesRequired: v.jobServices.map((s) => ({ code: s.legacyCode, name: s.name })), serviceNotes: d.leg_notes || '', quoteAmount: v.quoteAmount, promisedPickup: d.leg_promised_pickup || '',
    status: d.leg_status, components: v.materials.map((m) => ({ code: m.code, name: m.name, qty: m.qty, price: m.price, unit: m.unit })),
    laborFee: v.charges.filter((c) => c.kind === 'labour').reduce((n, c) => n + c.amount, 0), finalAmount: v.finalAmount, saleId: v.saleId, billId: v.billId,
    paymentMethod: d.leg_payment_method || '', completedAt: d.leg_completed_at || '',
  };
  Object.assign(o, d.leg_extra || {});
  return o;
}
const norm = (l) => ({ idNumber: '', itemDetails: '', servicesRequired: [], serviceNotes: '', quoteAmount: 0, promisedPickup: '', components: [], laborFee: 0, finalAmount: null, saleId: null, billId: null, paymentMethod: '', completedAt: '', ...l });
const sortKeys = (o) => JSON.parse(JSON.stringify(o, Object.keys(o).sort()));
const byId = (list, id) => list.find((x) => x.id === id);

test('every legacy job maps 1:1 to a view and can be rebuilt from it field for field (zero data loss), including unknown fields of newer releases', () => {
  const { ctx } = mk();
  for (const l of JOBS) {
    const v = toPlain(ctx.svcLegacyToJob(l));
    assert.deepEqual(sortKeys(recover(v)), sortKeys(norm(l)), l.id);
  }
  assert.equal(toPlain(ctx.svcAllJobs()).length, JOBS.length, 'the merged view shows every legacy row');
});

test('view shape: same id, J-<last 6>, legacy flags, dates in ms, status vocabulary mapped, phases, closedAt, due date, customer link, phone snapshot unvalidated', () => {
  const { ctx } = mk();
  const V = (id) => toPlain(ctx.svcLegacyToJob(byId(JOBS, id)));
  const a = V('JOB-MG4K2QX1-7QF');
  assert.equal(a.id, 'JOB-MG4K2QX1-7QF'); assert.equal(a.legacyId, a.id); assert.equal(a.no, 'J-X1-7QF'); assert.equal(a._legacy, true); assert.equal(a.source, 'legacy');
  assert.equal(a.serviceType, 'phone_repair'); assert.equal(a.createdAt, Date.parse(JOBS[0].createdAt)); assert.equal(a.rev, 0); assert.equal(a.updatedAt, 0);
  assert.equal(a.status, 'received', 'pending -> received'); assert.equal(a.phase, 0); assert.equal(a.closedAt, null);
  assert.equal(a.dueAt, Date.parse('2026-09-21T16:00'), 'datetime-local promised pickup (no zone) parses like the old screens parse it');
  assert.equal(a.assetSnap.kind, 'phone'); assert.equal(a.assetSnap.label, 'iPhone 11 black, IMEI 356789012345678, cracked screen, face ID not working'.slice(0, 60));
  assert.equal(a.data.leg_item_details, JOBS[0].itemDetails, 'IMEI stays inside the text: nothing is parsed or invented');
  assert.equal(a.customer.id, '1789900000000-aa11bb22cc', 'linked to the existing customer by phone'); assert.equal(a.customer.phoneKey, '712345678');
  assert.equal(a.jobServices[0].name, 'Screen Replacement'); assert.equal(a.jobServices[0].price, 0); assert.equal(a.jobServices[0].id, 'lg-SV001');
  assert.equal(a.quoteVersions[0].total, 5700); assert.equal(a.quoteLog[0].act, 'draft', 'no final amount yet: only a draft');
  for (const k of ['audit', 'jobStaff', 'valuables', 'photos', 'notify', 'payments', 'charges', 'materials']) assert.ok(Array.isArray(a[k]), k + ' is an array (R6)');
  const b = V('JOB-MG4M91AB-K2D');
  assert.equal(b.customer.id, '1789900000001-dd33ee44ff', '+254 722 889 100 matches the customer stored as 254722889100'); assert.equal(b.dueAt, Date.parse(JOBS[1].promisedPickup));
  assert.equal(b.data.leg_id_number, '24681357'); assert.equal(b.assetSnap.label, 'Samsung A14', 'first line only'); assert.deepEqual(b.jobServices.map((s) => s.id), ['lg-SV003', 'lg-SV002']);
  const d = V('JOB-MG4Q5D02-A1B');
  assert.deepEqual([d.status, d.phase], ['collected', 3]); assert.equal(d.closedAt, Date.parse(JOBS[3].completedAt)); assert.equal(d.completedAt, d.closedAt); assert.equal(d.quoteLog[0].act, 'approve', 'final amount present: the quote was accepted');
  assert.equal(d.materials[0].id, 'lg-0-00210'); assert.equal(d.materials[0].chargeable, true); assert.equal(d.charges[0].kind, 'labour'); assert.equal(d.charges[0].amount, 1500); assert.deepEqual(d.saleIds, ['1790000000000-k3j9a8s7d6']);
  const g = V('JOB-MG4U0H46-J0K');
  assert.equal(g.status, 'on_hold', 'an unknown status is kept as it is (R3)'); assert.equal(g.phase, 0); assert.deepEqual(g.data.leg_extra, { technician: 'Brian', warrantyUntil: '2026-12-31', tags: ['laptop', 'vip'] });
  assert.deepEqual(g.jobServices.map((s) => s.id), ['lg-SV003', 'lg-1-SV003'], 'duplicate service codes stay distinct');
  const old = V('JOB-LGCY0001-AAA');
  assert.deepEqual([old.status, old.phase, old.quoteVersions.length, old.dueAt], ['completed', 3, 0, null]); assert.equal(old.closedAt, old.createdAt, 'a completed row without completedAt closes at creation');
  assert.equal(old.customer.id, null);
});

test('legacy data is NEVER mutated: adapter, merged views, history, business-type switch, engine jobs for the same customers and sync apply/collect all leave serviceJobs / bookings / customers / bills / inventory byte-identical', () => {
  const { ctx, legacySnapshot } = mk();
  const before = legacySnapshot();
  ctx.svcAllJobs(); ctx.svcAllJobs({ types: ['phone_repair'], q: '356789012345678' }); ctx.svcAllApptsView();
  JOBS.forEach((l) => { ctx.svcGetJob(l.id); ctx.svcLegacyToJob(l); });
  BOOKINGS.forEach((b) => ctx.svcLegacyBookingToAppt(b));
  ctx.svcCustomerHistory('0712345678');
  ctx.svcSetBusinessType('car_wash', { source: 'settings' }); ctx.svcSetBusinessType('salon', { source: 'settings' });
  // an engine job for a customer that already exists (links to the legacy customer, may only fill a blank name)
  ctx.svcJobCreate('salon', { customer: { name: 'Wanjiru K', phone: '+254712345678' }, services: [{ name: 'Braids', price: 2500 }] });
  assert.equal(legacySnapshot().replace(/"name":""/g, '"name":""'), before.replace(/"name":""/g, '"name":""'), 'nothing legacy changed (existing customer names are kept)');
  // engine jobs that happen to reuse a legacy job id as their own legacyId do not alter the legacy row either
  ctx.svcSyncApply({ svcJobs: [{ id: 'sj-lg-JOB-MG4K2QX1-7QF', legacyId: 'JOB-MG4K2QX1-7QF', serviceType: 'phone_repair', createdAt: 1, status: 'received', statusHistory: [], customer: {} }] });
  ctx.svcSyncCollect();
  assert.equal(legacySnapshot(), before);
  assert.ok(!('serviceJobs' in toPlain(ctx.svcSyncCollect())) && !('bookings' in toPlain(ctx.svcSyncCollect())), 'the engine never sends legacy lists');
  assert.equal(Object.keys(toPlain(ctx.svcSyncCollect())).every((k) => /^svc/.test(k)), true);
});

test('views are frozen: no write reaches a legacy row through a view, at any depth', () => {
  'use strict';
  const { ctx, legacySnapshot } = mk();
  const before = legacySnapshot();
  const v = ctx.svcAllJobs().find((x) => x.id === 'JOB-MG4Q5D02-A1B');
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.customer) && Object.isFrozen(v.materials) && Object.isFrozen(v.materials[0]) && Object.isFrozen(v.data));
  assert.throws(() => { v.status = 'ready'; }, TypeError);
  assert.throws(() => { v.customer.name = 'x'; }, TypeError);
  assert.throws(() => { v.materials.push({}); }, TypeError);
  assert.throws(() => { v.materials[0].qty = 99; }, TypeError);
  const a = ctx.svcAllApptsView()[0];
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.services)); assert.throws(() => { a.status = 'cancelled'; }, TypeError);
  assert.equal(legacySnapshot(), before);
  assert.equal(Object.isFrozen(ctx.serviceJobs[0]), false, 'the legacy row itself is left as it was (the old screens still edit it)');
});

test('engine write functions refuse a legacy row with {code:"legacy", action:"promote"}; svcCanEnter / svcAllowedNext offer nothing', () => {
  const { ctx, legacySnapshot } = mk();
  const before = legacySnapshot(), id = 'JOB-MG4M91AB-K2D';
  assert.deepEqual(toPlain(ctx.svcJobUpdate(id, { notes: 'x' })), { ok: false, code: 'legacy', action: 'promote' });
  assert.deepEqual(toPlain(ctx.svcJobSetStatus(id, 'ready')), { ok: false, code: 'legacy', action: 'promote' });
  assert.deepEqual(toPlain(ctx.svcJobCancel(id, { reason: 'x' })), { ok: false, code: 'legacy', action: 'promote' });
  assert.deepEqual(toPlain(ctx.svcJobDelete(id, { reason: 'x' })), { ok: false, code: 'legacy', action: 'promote' });
  assert.deepEqual(toPlain(ctx.svcCommit(() => ({}), { list: 'svcJobs', id })), { ok: false, code: 'notfound' }, 'the store has no such engine record');
  assert.equal(ctx.svcCommit('svcJobs', ctx.svcGetJob(id)).code, 'legacy');
  const v = ctx.svcGetJob(id);
  assert.deepEqual(toPlain(ctx.svcAllowedNext(v)), []); assert.equal(ctx.svcCanEnter(v, 'ready').code, 'legacy');
  assert.equal(legacySnapshot(), before);
  assert.equal(toPlain(ctx.__eval('svcJobs')).length, 0);
});

test('money of a legacy row derives exactly like the old Client Registry: open bill = items - amountPaid, sale = paid, agreed price override honoured, settled bill = paid', () => {
  const { ctx } = mk();
  const T = (id) => toPlain(ctx.svcTotals(ctx.svcGetJob(id)));
  let t = T('JOB-MG4Q5D02-A1B');      // parts 4200 + labour 1500 = 5700, agreed 5500 (SERVICE-ADJUSTMENT -200), paid via saleId
  assert.deepEqual([t.total, t.paid, t.balance, t.paymentStatus], [5500, 5500, 0, 'paid']);
  t = T('JOB-MG4R8E13-C4D');          // the open bill: 1750 total, deposit 1000  (registry shows "Balance: KES 750.00")
  const bill = BILLS[0], itemsTotal = bill.items.reduce((n, l) => n + l.price * l.qty, 0);
  assert.deepEqual([t.total, t.paid, t.balance], [itemsTotal, bill.amountPaid, itemsTotal - bill.amountPaid]); assert.equal(t.balance, 750); assert.equal(t.paymentStatus, 'partial');
  t = T('JOB-MG4S2F24-E6F'); assert.deepEqual([t.total, t.paid, t.balance], [500, 500, 0], 'bill settled in the Bills tab (vanished): collected + billed = paid');
  t = T('JOB-MG4K2QX1-7QF'); assert.deepEqual([t.total, t.paid, t.balance], [5700, 0, 5700], 'intake with a quote only');
  t = T('JOB-MG4P0C77-X9Z'); assert.deepEqual([t.total, t.paid], [1150, 0], 'parts 350 + labour 800, unbilled');
  assert.equal(ctx.svcGetJob('JOB-MG4T6G35-G8H').moneyKnown, false, 'collected by hand, never billed: flagged so reports do not count the quote as owed');
  assert.equal(ctx.svcGetJob('JOB-MG4R8E13-C4D').moneyKnown, true);
  // the bill disappears (settled): the next read shows it paid, nothing was stored
  ctx.bills.length = 0;
  ctx.serviceJobs.find((j) => j.id === 'JOB-MG4R8E13-C4D').billId = null;
  ctx.serviceJobs.find((j) => j.id === 'JOB-MG4R8E13-C4D').status = 'collected';
  assert.deepEqual([T('JOB-MG4R8E13-C4D').paid, T('JOB-MG4R8E13-C4D').balance], [1750, 0]);
});

test('the legacy type is derived, then fixed at the first choice; switching the business type never re-labels old rows; types filter follows it', () => {
  const { ctx } = mk();
  assert.equal(ctx.svcLegacyType(), 'phone_repair'); assert.equal(ctx.svcBusinessType(), 'phone_repair'); assert.equal(ctx.svcClassicMode(), true);
  assert.equal(toPlain(ctx.svcAllJobs({ types: ['phone_repair'] })).length, JOBS.length);
  ctx.svcSetBusinessType('car_wash', { source: 'settings' });
  assert.equal(ctx.svcBusinessType(), 'car_wash');
  assert.equal(toPlain(ctx.svcAllJobs({ types: ['car_wash'] })).length, 0, 'the old rows are not car wash jobs');
  assert.equal(toPlain(ctx.svcAllJobs({ types: ['phone_repair'] })).length, JOBS.length, 'they keep their type under All types / their own type');
  ctx.serviceJobs.length = 0;           // every legacy job gone: the label stays fixed for rows that may come back through an archive
  assert.equal(ctx.svcLegacyType(), 'phone_repair');
  const empty = mk({ serviceJobs: [], bookings: [] });
  assert.equal(empty.ctx.svcLegacyType(), 'other'); assert.equal(empty.ctx.svcBusinessType(), 'other');
  const onlyBookings = mk({ serviceJobs: [] });
  assert.equal(onlyBookings.ctx.svcBusinessType(), 'other', 'bookings + services but no jobs: generic type (5.3)');
});

test('promotion marker: a legacy row whose id is the legacyId of an engine job is hidden from the merged list and svcGetJob returns the engine job', () => {
  const { ctx } = mk();
  const lid = 'JOB-MG4K2QX1-7QF';
  assert.equal(ctx.svcGetJob(lid)._legacy, true);
  ctx.svcSyncApply({ svcJobs: [{ id: 'sj-lg-' + lid, no: 'PR-260930-T1-001', legacyId: lid, serviceType: 'phone_repair', templateVersion: 1, createdAt: Date.parse(JOBS[0].createdAt), status: 'received', statusHistory: [{ id: 'h1', s: 'received', at: 1, p: 0 }], customer: { name: 'Wanjiru Kamau' }, updatedAt: 5 }] });
  const all = toPlain(ctx.svcAllJobs());
  assert.equal(all.length, JOBS.length, 'one engine job replaces one legacy row: no duplicates');
  assert.equal(all.filter((j) => j.legacyId === lid).length, 1); assert.equal(all.find((j) => j.legacyId === lid)._legacy, undefined);
  assert.equal(ctx.svcGetJob(lid).id, 'sj-lg-' + lid);
  assert.equal(toPlain(ctx.svcAllJobs({ includeLegacy: false })).length, 1);
  // the marker can be lost (another till never pulled it): the rule is on svcJobs, so the row is simply shown again
  ctx.svcSyncApply({ svcJobs: [] });
  assert.equal(toPlain(ctx.svcAllJobs()).length, JOBS.length); assert.equal(ctx.svcGetJob(lid)._legacy, true);
});

test('bookings map to appointment views: ids kept, status vocabulary, Kenya-time start/end, service name from inventory, unknown service kept by code, extras never lost on the row', () => {
  const { ctx } = mk();
  const A = (id) => toPlain(ctx.svcLegacyBookingToAppt(byId(BOOKINGS, id)));
  const a = A('BK-1790001000000-a1b2c3d4e5');
  assert.equal(a.id, 'BK-1790001000000-a1b2c3d4e5'); assert.equal(a.legacyBookingId, a.id); assert.equal(a._legacy, true);
  assert.equal(a.status, 'confirmed'); assert.equal(a.date, '2026-10-02'); assert.equal(a.start, '10:00'); assert.equal(a.end, '13:00');
  assert.equal(a.startAt, Date.parse('2026-10-02T10:00:00+03:00')); assert.equal(a.endAt, Date.parse('2026-10-02T13:00:00+03:00')); assert.equal(a.durationMin, 180);
  assert.deepEqual(a.services, [{ catalogId: null, code: 'SV004', name: 'Braids - Full Head', price: 2500, durationMin: 180 }]); assert.deepEqual(a.staffIds, ['st-lucy']); assert.equal(a.notes, 'knotless, medium length');
  assert.equal(a.customer.phoneKey, '722100200'); assert.equal(a.closedAt, null);
  assert.equal(A('BK-1790001000001-f6g7h8i9j0').status, 'cancelled'); assert.ok(A('BK-1790001000001-f6g7h8i9j0').closedAt);
  assert.equal(A('BK-1790001000002-k1l2m3n4o5').status, 'no_show'); assert.equal(A('BK-1790001000003-p6q7r8s9t0').status, 'completed');
  const z = A('BK-1790001000004-u1v2w3x4y5');
  assert.equal(z.services[0].name, 'GONE', 'service no longer in inventory: the code is shown'); assert.equal(z.customer.phoneKey, ''); assert.equal(z.durationMin, 30);
  const all = toPlain(ctx.svcAllApptsView());
  assert.deepEqual(all.map((x) => x.date + ' ' + x.start), ['2026-09-27 16:00', '2026-09-28 09:00', '2026-10-01 14:30', '2026-10-02 10:00', '2026-10-05 11:15'], 'sorted by start');
  assert.equal(toPlain(ctx.svcAllApptsView({ includeLegacy: false })).length, 0);
});

test('svcLegacyAction routes to the EXISTING legacy functions and reports a missing one', () => {
  const calls = [];
  const win = { __svcNow: T0, setJobStatusQuick: (...a) => calls.push(['status', ...a]), openClientRegistryModal: (...a) => calls.push(['edit', ...a]), sendJobToServicesCounter: (...a) => calls.push(['bill', ...a]), deleteClientRegistryJob: (...a) => calls.push(['remove', ...a]) };
  const { ctx } = mk({ window: win });
  assert.ok(ctx.svcLegacyAction('JOB-1', 'status', 'ready').ok); assert.ok(ctx.svcLegacyAction('JOB-1', 'edit').ok); assert.ok(ctx.svcLegacyAction('JOB-1', 'bill').ok); assert.ok(ctx.svcLegacyAction('JOB-1', 'remove').ok);
  assert.deepEqual(calls, [['status', 'JOB-1', 'ready'], ['edit', 'JOB-1'], ['bill', 'JOB-1'], ['remove', 'JOB-1']]);
  assert.equal(ctx.svcLegacyAction('JOB-1', 'tag').code, 'noaction'); assert.equal(ctx.svcLegacyAction('JOB-1', 'zzz').code, 'noaction');
});

test('mixed list: engine jobs and legacy rows are sorted together, search finds a legacy job by IMEI text / client / phone, history spans both', () => {
  const { ctx } = mk();
  ctx.svcJobCreate('phone_repair', { customer: { name: 'Wanjiru Kamau', phone: '0712 345 678' }, asset: { kind: 'phone', attrs: { brand: 'Apple', model: 'iPhone 11', imei: '356789012345678' } }, services: [{ name: 'Screen Replacement', price: 5700 }] });
  const all = toPlain(ctx.svcAllJobs());
  assert.equal(all.length, JOBS.length + 1); assert.equal(all[0]._legacy, undefined, 'the new engine job is the newest'); assert.equal(all.slice(1).every((j) => j._legacy), true);
  assert.deepEqual(all.map((j) => j.createdAt), all.map((j) => j.createdAt).slice().sort((a, b) => b - a));
  assert.deepEqual(toPlain(ctx.svcAllJobs({ q: 'iphone 11' })).map((j) => j._legacy === true), [false, true, true], 'text search covers the legacy item text (the new job + the two legacy iPhone 11 rows)');
  assert.equal(toPlain(ctx.svcAllJobs({ q: '+254 722 889 100' })).length, 1, 'phone search ignores formatting');
  const h = toPlain(ctx.svcCustomerHistory('0712345678'));
  assert.equal(h.jobs.length, 2); assert.deepEqual(h.jobs.map((x) => x.legacy), [false, true]); assert.equal(h.totalBilled, 5700 + 5700);
});

// ------------------------------------------------------------------------------------------------------------------------------------------
// the real page (one jsdom boot): the old screens keep running on the same rows, engine calls do not touch them
// ------------------------------------------------------------------------------------------------------------------------------------------
test('real page: an existing phone-repair shop boots in classic mode, the Client Registry still lists and edits its rows, the engine sees the same rows and never rewrites pos_service_jobs', { timeout: 120000 }, async () => {
  const storage = { pos_service_jobs: JSON.stringify(JOBS), pos_bookings: JSON.stringify(BOOKINGS), pos_customers: JSON.stringify(CUSTOMERS), pos_bills: JSON.stringify(BILLS), pos_inventory: JSON.stringify(INVENTORY) };
  const { w, d, close } = await boot('services/index.html', { storage, wait: 700 });
  try {
    assert.equal(w.eval('typeof svcAllJobs'), 'function', 'the store block is in the page');
    assert.equal(w.eval('svcClassicMode()'), true); assert.equal(w.eval('svcBusinessType()'), 'phone_repair'); assert.equal(w.eval('svcLegacyType()'), 'phone_repair');
    assert.equal(JSON.parse(w.eval('JSON.stringify(svcAllJobs().map(function(j){return j.id}))')).length, JOBS.length);
    w.eval('renderClientRegistry()');
    assert.equal(d.querySelectorAll('#client-registry-table tbody tr').length, JOBS.length, 'the classic Client Registry lists every row');
    const raw = w.localStorage.getItem('pos_service_jobs');
    // engine activity: choose a type, create jobs, change status, cancel, sync apply/collect
    w.eval("quietToast = 1; window.confirm = function () { return true; }");
    w.eval("svcSetBusinessType('car_wash', { source: 'settings' })");
    const cr = JSON.parse(w.eval("JSON.stringify(svcJobCreate('car_wash', { customer: { name: 'Jane', phone: '0712345678' }, asset: { kind: 'vehicle', attrs: { plate: 'KDA 123A', make: 'Toyota', model: 'Premio' } }, services: [{ name: 'Wash', price: 500 }] }).job.id)"));
    assert.ok(cr);
    w.eval(`svcJobSetStatus(${JSON.stringify(cr)}, 'in_progress', { force: true, note: 'go' })`);
    w.eval('svcSyncApply(svcSyncCollect())');
    assert.equal(w.localStorage.getItem('pos_service_jobs'), raw, 'pos_service_jobs is byte-identical after engine activity');
    assert.equal(w.localStorage.getItem('pos_bookings'), JSON.stringify(BOOKINGS));
    assert.equal(w.eval('svcClassicMode()'), false, 'chosen: engine mode');
    assert.equal(JSON.parse(w.eval('JSON.stringify(svcAllJobs({types:["phone_repair"]}).length)')), JOBS.length, 'legacy rows still listed under their own type');
    // the OLD screen changes a legacy row; the view follows, and only that row changed
    w.eval("setJobStatusQuick('JOB-MG4K2QX1-7QF', 'ready')");
    assert.equal(w.eval("svcGetJob('JOB-MG4K2QX1-7QF').status"), 'ready');
    const after = JSON.parse(w.localStorage.getItem('pos_service_jobs'));
    assert.deepEqual(after.filter((j) => j.id !== 'JOB-MG4K2QX1-7QF'), JOBS.filter((j) => j.id !== 'JOB-MG4K2QX1-7QF'), 'the other rows are untouched');
    assert.equal(w.eval("svcLegacyAction('JOB-MG4M91AB-K2D', 'status', 'ready').ok"), true, 'the dispatcher calls the real old function');
    assert.equal(w.eval("svcGetJob('JOB-MG4M91AB-K2D').status"), 'ready');
    // classic removal of a row removes it from the view too (legacy stays the source of truth for its rows)
    w.eval("deleteClientRegistryJob('JOB-LGCY0001-AAA')");
    assert.equal(w.eval("svcGetJob('JOB-LGCY0001-AAA')"), null);
    const pl = JSON.parse(w.eval('JSON.stringify((function(){ var p = collectSyncPayload(); return { jobs: p.svcJobs.length, legacy: p.serviceJobs.length, assets: p.svcAssets.length, cfg: p.svcConfig.length, appts: p.svcAppointments === undefined } })())'));
    assert.ok(pl.cfg >= 1, 'engine config (incl. catalog seed) rides along'); pl.cfg = 1;
    assert.deepEqual(pl, { jobs: 1, legacy: JOBS.length - 1, assets: 1, cfg: 1, appts: true }, 'engine lists ride the payload next to the untouched legacy list; empty lists are not sent');
  } finally { close(); }
});
