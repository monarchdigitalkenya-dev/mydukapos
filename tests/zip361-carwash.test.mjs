// zip 361 — the standalone Car Wash & Cleaning app (carwash/index.html, product "carwash"). The 20 mandatory scenarios of the brief, run in the
// real app page (jsdom) and against the real server code: customers and vehicles, jobs, assignment, status, SMS (event-driven, no duplicates),
// payments, loyalty 9 + 1 (earn once, free 10th, redeem, reset, refunds reverse), carpet pickup -> delivery, invoice, reports, Owner Console link
// generation, sign-in through the generated link, unauthorised access, Services no longer offering car wash, and the import of the car wash
// history a shop kept in Services (preserved, never deleted).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const ADMIN = { pos_pw_hash: sha('admin-pass'), pos_admin_pw_hash: sha('admin-pass'), pos_biz_name: 'Sparkle Wash' };

async function app(opts = {}) {
  const sent = [];
  const fetch = (u, o) => {
    const url = String(u);
    if (url.includes('/api/sms-config')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ configured: opts.smsConfigured !== false }) });
    if (url.includes('/api/sms-send')) { sent.push(JSON.parse(o.body)); return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) }); }
    return Promise.reject(new Error('offline'));
  };
  const b = await boot('carwash/index.html', { storage: { ...ADMIN, ...(opts.storage || {}) }, fetch, wait: 1300, webcrypto: true, url: opts.url });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push(m); }; window.posNetOffline = function () { return false; };");
  b.sent = sent;
  if (opts.login !== false) {
    b.d.getElementById('login-password-input').value = 'admin-pass';
    await b.w.eval('loginSubmit()');
    await new Promise((r) => setTimeout(r, 800));
  }
  b.ev = (s) => b.w.eval(s);
  b.json = (s) => JSON.parse(b.w.eval('JSON.stringify(' + s + ')'));
  return b;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('1-11: customer + vehicles, job, assignment, SMS, status, completion, payment, loyalty 9 + 1, redeem and reset', async () => {
  const A = await app();
  const { d, errors, json, ev } = A;
  assert.ok(d.body.classList.contains('cw-on'), 'the Car Wash shell is on after sign-in');
  assert.equal(d.querySelector('#cw-app .cw-nav').textContent.includes('Sales Counter'), false, 'no sales counter in the app');
  // staff to assign to
  const add = await ev("cwAddStaff({ name: 'Peter Kamau', pin: '4321', role: 'attendant', phone: '0711000111' })");
  assert.equal(add.ok, true, add.error);
  const peter = json("staff.find(function (m) { return m.name === 'Peter Kamau'; })");
  assert.equal(peter.cwRole, 'attendant'); assert.match(peter.cwNo, /^ST\d{3}$/); assert.ok(peter.pinHash && peter.pinHash !== '4321');
  // 1. new customer + vehicle through a check-in
  const r1 = json("cwCreateJob({ kind: 'car', customer: { name: 'John Mwangi', phone: '0712 345 678' }, vehicle: { plate: 'kda 123x', make: 'Toyota', model: 'Axio', category: 'saloon' }, items: [{ serviceId: 'svc-fullbody', name: 'Full Body Wash', price: 300 }, { serviceId: 'svc-vacuum', name: 'Vacuum', price: 200 }], estMinutes: 45 })");
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.customer.phone, '254712345678', 'phone normalised');
  assert.equal(r1.vehicle.plate, 'KDA123X', 'plate normalised');
  assert.match(r1.job.no, /^CW-\d{6}-001$/);
  assert.equal(r1.job.status, 'awaiting_assignment', 'no staff yet: awaiting assignment');
  // 2. another vehicle for the same customer (same phone written differently) -> still ONE customer
  const r2 = json("cwUpsertVehicle({ plate: 'KCB 456Y', make: 'Mazda', customerId: '" + r1.customer.id + "' })");
  assert.equal(r2.ok, true);
  const again = json("cwUpsertCustomer({ name: 'John M', phone: '+254 712 345678' })");
  assert.equal(again.customer.id, r1.customer.id, 'one customer per phone number');
  assert.equal(json("cwVehiclesOf('" + r1.customer.id + "').length"), 2);
  const dupe = json("cwUpsertVehicle({ plate: 'KDA-123X', customerId: 'someone-else' })");
  assert.equal(dupe.ok, false, 'a plate belongs to one customer unless moved on purpose');
  // 4. assign
  const as = json("cwAssign('" + r1.job.id + "', ['" + peter.id + "'])");
  assert.equal(as.ok, true); assert.equal(as.job.status, 'assigned');
  // 5. the check-in SMS was queued once, with the plate, services, amount and loyalty line, and sent through the gateway
  await ev('cwSmsFlush()'); await wait(150);
  const sms1 = json("cwSms.filter(function (s) { return s.jobId === '" + r1.job.id + "'; })");
  assert.equal(sms1.length, 1); assert.equal(sms1[0].event, 'checkin'); assert.equal(sms1[0].status, 'sent');
  assert.match(sms1[0].message, /KDA 123X/); assert.match(sms1[0].message, /Full Body Wash \+ Vacuum/); assert.match(sms1[0].message, /KES 500/); assert.match(sms1[0].message, /Your visit: 1\/9/);
  assert.equal(A.sent.length, 1); assert.equal(A.sent[0].to, '254712345678');
  assert.equal(ev("cwSmsQueue('checkin', cwGetJob('" + r1.job.id + "'))"), null, 'the same event for the same job is never queued twice');
  // 6. status by the attendant is recorded with who did it
  ev("currentServer = { id: '" + peter.id + "', name: 'Peter Kamau' };");
  assert.equal(json('cwMe()').role, 'attendant');
  const st = json("cwSetStatus('" + r1.job.id + "', 'washing')");
  assert.equal(st.ok, true); assert.equal(st.job.statusHistory.slice(-1)[0].by, 'Peter Kamau');
  // attendant cannot take money
  assert.equal(json("cwRecordPayment({ jobId: '" + r1.job.id + "', amount: 500, method: 'cash' })").ok, false);
  // 7. completed -> ready for collection + completion SMS
  const done = json("cwSetStatus('" + r1.job.id + "', 'completed')");
  assert.equal(done.job.status, 'ready', 'completion moves the car to Ready for Collection');
  assert.ok(done.job.completedAt);
  ev('currentServer = null;');
  await ev('cwSmsFlush()'); await wait(150);
  const comp = json("cwSms.filter(function (s) { return s.id === 'cws-completed-" + r1.job.id + "'; })[0]");
  assert.equal(comp.status, 'sent'); assert.match(comp.message, /is READY/); assert.match(comp.message, /Handled by Peter Kamau/);
  // 8 + 9. payment -> paid -> exactly one loyalty point, idempotent
  const pay = json("cwRecordPayment({ jobId: '" + r1.job.id + "', amount: 500, method: 'mpesa', ref: 'sgh7k2lmnp' })");
  assert.equal(pay.ok, true, pay.error); assert.equal(pay.totals.status, 'paid'); assert.equal(pay.payment.ref, 'SGH7K2LMNP');
  assert.equal(json("cwRecordPayment({ jobId: '" + r1.job.id + "', amount: 1, method: 'mpesa', ref: 'SGH7K2LMNP' })").ok, false, 'a payment reference is never used twice');
  ev("cwEvalLoyalty('" + r1.job.id + "'); cwEvalLoyalty('" + r1.job.id + "');");
  const key = r1.job.loyaltyKey;
  let acc = json("cwLoyaltyAccount(cwLoyalty, '" + key + "', cwCfg(), cwJobs)");
  assert.equal(acc.paid_visits, 1); assert.equal(acc.current_cycle_count, 1); assert.equal(acc.next_reward_at, 8);
  // collection record
  const col = json("cwSetStatus('" + r1.job.id + "', 'collected', { collection: { releasedBy: 'Peter Kamau', confirmed: true } })");
  assert.equal(col.job.status, 'collected'); assert.equal(col.job.collection.releasedBy, 'Peter Kamau'); assert.equal(col.job.collection.payStatus, 'paid');
  // a refund takes the point back; paying again gives it back (never twice)
  json("cwRecordPayment({ jobId: '" + r1.job.id + "', amount: 500, method: 'cash', type: 'refund', note: 'test' })");
  assert.equal(json("cwLoyaltyAccount(cwLoyalty, '" + key + "', cwCfg(), cwJobs)").paid_visits, 0, 'refund reverses the point');
  json("cwRecordPayment({ jobId: '" + r1.job.id + "', amount: 500, method: 'cash' })");
  assert.equal(json("cwLoyaltyAccount(cwLoyalty, '" + key + "', cwCfg(), cwJobs)").paid_visits, 1);
  // 10. eight more paid washes -> the 10th is FREE
  for (let i = 0; i < 8; i++) {
    const j = json("cwCreateJob({ kind: 'car', customer: { phone: '0712345678' }, vehicle: { plate: 'KDA123X' }, items: [{ serviceId: 'svc-body', name: 'Body Wash', price: 300 }] })").job;
    assert.equal(j.free, false, 'visit ' + (i + 2) + ' is paid');
    json("cwRecordPayment({ jobId: '" + j.id + "', amount: 300, method: 'cash' })");
    if (i === 6) {
      acc = json("cwLoyaltyAccount(cwLoyalty, '" + key + "', cwCfg(), cwJobs)");
      assert.equal(acc.current_cycle_count, 8);
      assert.ok(json("cwSms.some(function (s) { return s.event === 'loyalty' && /8 paid washes/.test(s.message); })"), 'one-more-wash reminder SMS');
    }
  }
  acc = json("cwLoyaltyAccount(cwLoyalty, '" + key + "', cwCfg(), cwJobs)");
  assert.equal(acc.paid_visits, 9); assert.equal(acc.free_visits_earned, 1); assert.equal(acc.available, 1); assert.equal(acc.current_cycle_count, 0);
  assert.ok(json("cwSms.some(function (s) { return s.event === 'reward'; })"), 'free-wash SMS');
  // the check-in screen shows the FREE banner for this car
  ev("cwGo('checkin'); CW_UI.ck.custId = '" + r1.customer.id + "'; CW_UI.ck.vehId = '" + r1.vehicle.id + "'; cwRender();");
  assert.match(d.getElementById('cw-main').textContent, /FREE WASH AVAILABLE/);
  const free = json("cwCreateJob({ kind: 'car', customer: { phone: '0712345678' }, vehicle: { plate: 'KDA123X' }, items: [{ serviceId: 'svc-fullbody', name: 'Full Body Wash', price: 300 }] })").job;
  assert.equal(free.free, true, 'the 10th qualifying wash is FREE automatically');
  assert.equal(json("cwTotals(cwGetJob('" + free.id + "'))").total, 0);
  assert.equal(json("cwRecordPayment({ jobId: '" + free.id + "', amount: 300, method: 'cash' })").ok, false, 'nothing to pay on a free wash');
  assert.equal(json("cwLoyaltyAccount(cwLoyalty, '" + key + "', cwCfg(), cwJobs)").available, 0, 'the reward is held by the open free job');
  // a second car of the same customer is a different programme
  assert.equal(json("cwCreateJob({ kind: 'car', customer: { phone: '0712345678' }, vehicle: { plate: 'KCB456Y' }, items: [{ name: 'Body Wash', price: 300 }] })").job.free, false);
  // 11. redeem: the free wash completes -> redeemed, never earns a point; the cycle starts again
  json("cwSetStatus('" + free.id + "', 'completed')");
  acc = json("cwLoyaltyAccount(cwLoyalty, '" + key + "', cwCfg(), cwJobs)");
  assert.equal(acc.free_visits_redeemed, 1); assert.equal(acc.paid_visits, 9, 'a free wash earns no point'); assert.equal(acc.available, 0);
  const next = json("cwCreateJob({ kind: 'car', customer: { phone: '0712345678' }, vehicle: { plate: 'KDA123X' }, items: [{ name: 'Body Wash', price: 300 }] })").job;
  assert.equal(next.free, false);
  json("cwRecordPayment({ jobId: '" + next.id + "', amount: 300, method: 'cash' })");
  acc = json("cwLoyaltyAccount(cwLoyalty, '" + key + "', cwCfg(), cwJobs)");
  assert.equal(acc.current_cycle_count, 1, 'cycle reset after redemption'); assert.equal(acc.paid_visits, 10);
  // cancelled and unpaid jobs earn nothing
  const c1 = json("cwCreateJob({ kind: 'car', customer: { phone: '0712345678' }, vehicle: { plate: 'KDA123X' }, items: [{ name: 'Body Wash', price: 300 }] })").job;
  assert.equal(json("cwSetStatus('" + c1.id + "', 'cancelled')").ok, false, 'a reason is required');
  json("cwSetStatus('" + c1.id + "', 'cancelled', { note: 'customer left' })");
  assert.equal(json("cwLoyaltyAccount(cwLoyalty, '" + key + "', cwCfg(), cwJobs)").paid_visits, 10);
  // the job drawer draws for every job without errors
  ev("cwOpenJob('" + r1.job.id + "')");
  assert.match(d.getElementById('cw-panel').textContent, /Collected/);
  ['dashboard', 'jobs', 'cleaning', 'customers', 'payments', 'loyalty', 'sms', 'staff', 'reports', 'activity', 'settings'].forEach((r) => { ev("cwGo('" + r + "')"); assert.doesNotMatch(d.getElementById('cw-main').innerHTML, /could not be drawn/, r); });
  ['business', 'services', 'loyalty', 'sms', 'payments', 'staff', 'general', 'data'].forEach((t) => { ev("CW_UI.setTab = '" + t + "'; cwRender();"); assert.doesNotMatch(d.getElementById('cw-main').innerHTML, /could not be drawn/, 'settings ' + t); });
  // audit trail
  assert.ok(json("cwAudit.some(function (a) { return a.act === 'job.assign' && a.ref === '" + r1.job.no + "'; })"));
  assert.deepEqual(errors, []);
  A.close();
});

test('12-15: carpet pickup -> delivery with SMS and photos, invoice, daily and staff reports', async () => {
  const A = await app();
  const { json, ev, errors } = A;
  await ev("cwAddStaff({ name: 'Grace Akinyi', pin: '1111', role: 'cleaner' })");
  const g = json("staff.find(function (m) { return m.name === 'Grace Akinyi'; })");
  ev("cwSaveTeam({ name: 'Team A', memberIds: ['" + g.id + "'] })");
  const team = json("cwCfg().teams[0]");
  const r = json("cwCreateJob({ kind: 'clean', customer: { name: 'Sarah Wanjiku', phone: '0722000111', location: 'Olive', house: '12B' }, items: [{ serviceId: 'svc-carpet', name: 'Carpet Cleaning (6x9)', price: 800 }], teamId: '" + team.id + "', cleaning: { type: 'carpet', dims: '6x9', qty: 1, delivery: 200, pickup: { location: 'Olive', house: '12B' }, expectedAt: Date.now() + 86400000 } })");
  assert.equal(r.ok, true, r.error);
  assert.match(r.job.no, /^CL-/);
  assert.equal(r.job.assignments[0].staffId, g.id, 'the team members are assigned');
  const id = r.job.id;
  for (const s of ['picked_up', 'in_cleaning', 'quality_check', 'ready_delivery', 'out_delivery']) assert.equal(json("cwSetStatus('" + id + "', '" + s + "')").ok, true, s);
  await ev('cwSmsFlush()'); await wait(150);
  const sms = json("cwSms.filter(function (s) { return s.jobId === '" + id + "'; })");
  const pick = sms.find((s) => s.event === 'pickup'), del = sms.find((s) => s.event === 'delivery');
  assert.match(pick.message, /6x9 carpet has been picked up from Olive, House 12B/); assert.match(pick.message, /KES 1,000/);
  assert.match(del.message, /Cleaning: KES 800\. Delivery: KES 200\. Total: KES 1,000/);
  json("cwRecordPayment({ jobId: '" + id + "', amount: 400, method: 'mpesa', type: 'deposit' })");
  assert.equal(json("cwTotals(cwGetJob('" + id + "'))").status, 'partial');
  json("cwRecordPayment({ jobId: '" + id + "', amount: 600, method: 'cash' })");
  const dl = json("cwSetStatus('" + id + "', 'delivered', { collection: { releasedBy: 'Grace Akinyi', confirmed: true, confirmedName: 'Sarah' } })");
  assert.equal(dl.job.status, 'delivered'); assert.equal(dl.job.cleaning.deliveryConfirmedBy, 'Sarah');
  assert.equal(json("cwLoyaltyAccount(cwLoyalty, 'clean|254722000111', cwCfg(), cwJobs)").paid_visits, 1, 'cleaning loyalty by phone');
  // house cleaning uses the on-site flow
  const h = json("cwCreateJob({ kind: 'clean', customer: { phone: '0722000111' }, items: [{ name: 'House Cleaning', price: 3500 }], staffIds: ['" + g.id + "'], cleaning: { type: 'house' } })").job;
  assert.equal(h.status, 'assigned'); assert.deepEqual(json("cwStatuses(cwGetJob('" + h.id + "')).map(function (s) { return s.k; })"), ['received', 'assigned', 'in_cleaning', 'quality_check', 'completed', 'cancelled']);
  // 14. invoice
  ev("window.__docs = []; window.open = function () { return { document: { open: function () {}, write: function (h) { window.__docs.push(h); }, close: function () {} } }; };");
  ev("cwInvoice('" + id + "')");
  const inv = json('window.__docs[0]');
  assert.match(inv, /INVOICE/); assert.match(inv, /INV-\d{6}-001/); assert.match(inv, /Carpet Cleaning \(6x9\)/); assert.match(inv, /BALANCE DUE \(KES\)<\/td><td class="n">0/);
  // 15. reports: daily sales from payment records, staff performance shared between the people on a job
  const S = 'cwState()';
  const daily = json("cwReportDaily(" + S + ", { from: Date.now() - 86400000, to: Date.now() + 60000 })");
  assert.equal(daily.totals.cash, 600); assert.equal(daily.totals.mpesa, 400);
  assert.equal(daily.totals.charges, 4500, 'job charges: carpet 1,000 + house cleaning 3,500');
  const staffRep = json("cwReportStaff(" + S + ", { from: Date.now() - 86400000, to: Date.now() + 60000 })");
  const gr = staffRep.data.find((x) => x.id === g.id);
  assert.equal(gr.cleans, 2); assert.equal(gr.completed, 1); assert.equal(Math.round(gr.revenue), 1000);
  // reports screen + exports
  ev("cwGo('reports'); CW_UI.rep.range = '7'; cwRender();");
  assert.match(A.d.getElementById('cw-main').textContent, /Daily Sales Report/);
  ev("window.__docs = []; cwRepExport('pdf')");
  assert.match(json('window.__docs[0]'), /Daily Sales Report/);
  assert.deepEqual(errors, []);
  A.close();
});

test('16-17: the Owner Console generates a Car Wash link that opens /carwash/, and signing in through it works', async () => {
  const kv = makeKV(); const env = { mydukapos_kv: kv };
  const lic = await load('functions/api/_license.js');
  assert.equal(lic.PRODUCTS.carwash.path, '/carwash/');
  assert.ok(lic.listProducts().some((p) => p.id === 'carwash'), 'the console\'s product list has the Car Wash app');
  const rec = await lic.createClient(env, 'permanent', 'Sparkle Car Wash', 'carwash', { clientName: 'Peter' });
  assert.equal(rec.product, 'carwash');
  const link = lic.clientLink(env, rec, 'https://mydukapos.store');
  assert.match(link, /^https:\/\/sparkle-car-wash\.mydukapos\.store\/carwash\//, link);
  const idx = JSON.parse(kv.data.get('license-index:v1').value);
  assert.ok(idx.some((s) => s.id === rec.id && s.product === 'carwash'), 'the link is saved');
  // usage figures for the console
  const { carwashUsage } = await load('functions/api/owner-carwash.js');
  const u = carwashUsage({ cwCustomers: [{ id: 'a' }], cwVehicles: [{ id: 'v' }], cwJobs: [{ id: 'j', receivedAt: Date.now(), status: 'washing', kind: 'car' }], cwPayments: [{ id: 'p', amount: 500, at: Date.now() }] });
  assert.equal(u.jobsToday, 1); assert.equal(u.open, 1); assert.equal(u.collected30, 500);
  // the console has the tab, the generate button and the product everywhere
  const owner = fs.readFileSync(path.join(ROOT, 'owner/index.html'), 'utf8');
  assert.match(owner, /GENERATE APPLICATION LINK/); assert.match(owner, /option value="carwash"/); assert.match(owner, /\/api\/owner-carwash/);
  // opening the link: the Car Wash app's own sign-in, not Services
  const A = await app({ url: 'https://sparkle-car-wash.mydukapos.store/carwash/', login: false });
  assert.equal(A.d.getElementById('login-screen').style.display, 'flex');
  assert.equal(A.d.body.classList.contains('cw-on'), false, 'nothing of the app shows before sign-in');
  assert.equal(A.d.title, 'Car Wash & Cleaning');
  A.d.getElementById('login-password-input').value = 'admin-pass';
  await A.w.eval('loginSubmit()'); await wait(800);
  assert.equal(A.d.body.classList.contains('cw-on'), true);
  A.close();
});

test('18: unauthorised users — deactivated staff are locked out, roles see only their screens and actions', async () => {
  const A = await app();
  const { json, ev, d } = A;
  await ev("cwAddStaff({ name: 'Ann', pin: '2222', role: 'attendant' })");
  await ev("cwAddStaff({ name: 'Ben', pin: '3333', role: 'cashier' })");
  const ann = json("staff.find(function (m) { return m.name === 'Ann'; })"), ben = json("staff.find(function (m) { return m.name === 'Ben'; })");
  const job = json("cwCreateJob({ kind: 'car', customer: { name: 'X', phone: '0733000000' }, vehicle: { plate: 'KDB111A' }, items: [{ name: 'Body Wash', price: 300 }] })").job;
  ev("currentServer = { id: '" + ann.id + "', name: 'Ann' }; cwTick();"); await wait(50);
  assert.equal(json("cwRouteAllowed('payments', cwMe())"), false); assert.equal(json("cwRouteAllowed('settings', cwMe())"), false); assert.equal(json("cwRouteAllowed('reports', cwMe())"), false);
  assert.equal(json("cwSetStatus('" + job.id + "', 'washing')").ok, false, 'an attendant only touches jobs assigned to them');
  assert.equal(json("cwCreateJob({ kind: 'car', customer: { phone: '0733000000' }, vehicle: { plate: 'KDB111A' }, items: [{ name: 'a', price: 1 }] })").ok, false);
  ev("currentServer = { id: '" + ben.id + "', name: 'Ben' }; cwTick();"); await wait(50);
  assert.equal(json("cwRouteAllowed('payments', cwMe())"), true); assert.equal(json("cwRouteAllowed('settings', cwMe())"), false);
  assert.equal(json("cwRecordPayment({ jobId: '" + job.id + "', amount: 100, method: 'cash', type: 'refund', note: 'x' })").ok, false, 'only the owner refunds');
  assert.equal(json("cwCan('reports.fin')"), false, 'no financial reports for the cashier');
  ev('currentServer = null;');
  assert.equal(json("cwUpdateStaff('" + ann.id + "', { active: false })").ok, true);
  ev("currentServer = { id: '" + ann.id + "', name: 'Ann' }; CW_UI.meKey = ''; cwTick();"); await wait(50);
  assert.equal(json('cwMe()').role, 'none');
  assert.match(d.getElementById('cw-main').textContent, /access to the Car Wash app is switched off/);
  A.close();
});

test('19: Services no longer offers car wash; a car wash Services shop is sent to the Car Wash app', async () => {
  const b = await boot('services/index.html', { storage: ADMIN, wait: 1200 });
  b.w.eval('showToast = function () {};');
  const types = JSON.parse(b.w.eval('JSON.stringify(svcUiTypeList())'));
  assert.equal(types.includes('car_wash'), false); assert.ok(types.includes('phone_repair'));
  b.w.eval("svcSetBusinessType('car_wash', { chosen: true })");
  b.w.eval('svcRenderHome()');
  const root = b.d.getElementById('svc-root');
  assert.match(root.textContent, /Car Wash has its own app now/); assert.match(root.innerHTML, /\/carwash\//);
  assert.equal(b.w.eval('svcOpenNewJob()'), false, 'no car wash intake left in Services');
  assert.equal(b.w.eval("typeof SVC_TYPES.car_wash"), 'object', 'the old template stays so old records still read');
  b.close();
});

test('20: car wash history kept in Services is imported (jobs, customers, vehicles, payments, loyalty) and never changed or duplicated', async () => {
  const T = Date.now() - 5 * 86400000;
  const svcJobs = [1, 2, 3].map((i) => ({ id: 'sj-' + i, no: 'CW-OLD-' + i, serviceType: 'car_wash', createdAt: T + i * 1000, customer: { name: 'Old Customer', phone: '0700111222' }, assetSnap: { plate: 'KCA 001A', make: 'Toyota', type: 'saloon' },
    jobServices: [{ id: 'l' + i, name: 'Basic Wash', price: 500, qty: 1 }], statusHistory: [{ id: 'h' + i, s: 'completed', at: T + i * 1000 + 3600000 }], status: 'completed', jobStaff: [{ id: 'js' + i, staffId: 's9', name: 'Old Staff', assignedAt: T }],
    payments: [{ id: 'p' + i, amount: 500, method: 'cash', at: T + i * 1000 + 3600000, kind: 'payment' }] }));
  svcJobs.push({ id: 'sj-salon', serviceType: 'salon', createdAt: T, customer: { name: 'Salon Lady', phone: '0700999888' }, jobServices: [{ id: 'x', name: 'Cut', price: 300 }], statusHistory: [] });
  const A = await app({ storage: { pos_svc_jobs: JSON.stringify(svcJobs) } });
  const { json, ev } = A;
  const jobs = json('cwJobs');
  assert.equal(jobs.filter((j) => j.migratedFrom).length, 3, 'only car wash jobs are imported');
  const j1 = jobs.find((j) => j.id === 'cwj-m-sj-1');
  assert.equal(j1.no, 'CW-OLD-1'); assert.equal(j1.status, 'collected'); assert.equal(j1.assignments[0].name, 'Old Staff');
  assert.equal(json('cwCustomers').length, 1); assert.equal(json('cwVehicles')[0].plate, 'KCA001A');
  assert.equal(json("cwTotals(cwGetJob('cwj-m-sj-1'))").status, 'paid');
  assert.equal(json("cwLoyaltyAccount(cwLoyalty, '" + j1.loyaltyKey + "', cwCfg(), cwJobs)").paid_visits, 3, 'loyalty history carried over');
  // a pull that carries the same Services records again changes nothing
  ev("cwSyncApply({ svcJobs: " + JSON.stringify(svcJobs) + " })");
  assert.equal(json('cwJobs').length, jobs.length, 'never imported twice');
  assert.equal(JSON.parse(A.w.localStorage.getItem('pos_svc_jobs') || 'null').length, 4, 'the Services records themselves are untouched');
  assert.equal(json('cwCfg().migration.jobs'), 3);
  // sync: the push carries the Car Wash lists; a pull merges by newest updatedAt
  const pay = json('cwSyncCollect()');
  assert.ok(pay.cwJobs.length && pay.cwCustomers.length && pay.cwPayments.length);
  const newer = JSON.parse(JSON.stringify(j1)); newer.instructions = 'from another till'; newer.updatedAt = Date.now() + 5000;
  ev('cwSyncApply({ cwJobs: [' + JSON.stringify(newer) + '] })');
  assert.equal(json("cwGetJob('cwj-m-sj-1').instructions"), 'from another till');
  A.close();
});

test('server: Car Wash lists merge per record; job history, assignments and photos from two devices both survive; closed jobs stay closed', async () => {
  const M = await load('functions/api/_merge.js');
  ['cwCustomers', 'cwVehicles', 'cwJobs', 'cwPayments', 'cwLoyalty', 'cwSms', 'cwAudit', 'cwComplaints', 'cwConfig'].forEach((f) => assert.ok(M.MERGE_BY_ID_FIELDS.includes(f), f));
  const base = { id: 'j1', no: 'CW-1', phase: 1, status: 'washing', updatedAt: 10, statusHistory: [{ id: 'a', s: 'received', at: 1 }], assignments: [{ id: 'x', staffId: 's1', rev: 0 }], photos: [] };
  const devA = { ...base, updatedAt: 20, statusHistory: base.statusHistory.concat([{ id: 'b', s: 'completed', at: 5 }]), phase: 2, status: 'ready' };
  const devB = { ...base, updatedAt: 30, photos: [{ id: 'ph1', kind: 'before' }], assignments: [{ id: 'x', staffId: 's1', rev: 1, removedAt: 9 }, { id: 'y', staffId: 's2', rev: 0 }] };
  const m1 = M.mergeIncomingState({ cwJobs: [devA], updatedAt: 20 }, { cwJobs: [devB], updatedAt: 30 });
  const j = m1.cwJobs.find((r) => r.id === 'j1');
  assert.deepEqual(j.statusHistory.map((h) => h.id).sort(), ['a', 'b']);
  assert.equal(j.photos.length, 1); assert.equal(j.assignments.length, 2); assert.ok(j.assignments.find((a) => a.id === 'x').removedAt, 'the newer assignment edit wins');
  assert.equal(j.phase, 2, 'the further-along copy decides');
  const closed = { ...base, phase: 3, status: 'collected', updatedAt: 40 };
  const stale = { ...base, updatedAt: 50 };
  const m2 = M.mergeIncomingState({ cwJobs: [closed], updatedAt: 40 }, { cwJobs: [stale], updatedAt: 50 });
  assert.equal(m2.cwJobs[0].phase, 3, 'a stale open copy never reopens a collected job');
});

test('public website and demos list the Car Wash app; the demo is seeded with the app\'s own records', async () => {
  const site = await load('functions/_site.js');
  assert.ok(site.PRODUCT_PAGES.carwash); assert.ok(site.PRIVATE_PATHS.includes('/carwash/'));
  const appHtml = fs.readFileSync(path.join(ROOT, 'public-site/app.html'), 'utf8');
  assert.match(appHtml, /carwash: \{\s*name: 'Car Wash & Cleaning'/); assert.match(appHtml, /carwash: \['carwash'\]/);
  const cards = JSON.parse(fs.readFileSync(path.join(ROOT, 'public-site/product-cards.json'), 'utf8')).cards;
  assert.ok(cards.some((c) => c.key === 'carwash'));
  assert.match(fs.readFileSync(path.join(ROOT, 'public-site/index.html'), 'utf8'), /href="\/products\/carwash"/);
  const { SHARED_DEMOS } = await load('functions/api/_shared-demos.js');
  assert.equal(SHARED_DEMOS.find((d) => d.key === 'carwash').product, 'carwash');
  const { buildDemoSeed } = await load('functions/api/_demo-seeds.js');
  const s = buildDemoSeed('carwash', Date.now());
  assert.ok(s.cwJobs.length > 100 && s.cwPayments.length > 100 && s.cwCustomers.length >= 18);
  assert.ok(s.staff.every((m) => m.cwRole && m.pinHash));
  assert.equal(new Set(s.cwJobs.map((j) => j.no)).size, s.cwJobs.length, 'job numbers are unique');
});
