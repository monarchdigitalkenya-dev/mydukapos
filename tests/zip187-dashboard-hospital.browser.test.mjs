import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// zip 187: the Hospital dashboard command center - every figure reconciles with the HMIS records (sales, patient charges, visits, queue, wards ...),
// departments / payment methods add up to revenue, empty and missing-cost states are honest, a broken widget never takes the page down, the layout
// does not overflow a phone, dark mode works, a restricted role never receives money, and no patient name or diagnosis ever reaches the screen.
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const H = crypto.createHash('sha256').update('pw').digest('hex');
const NOW = Date.now(), DAY = 86400000;
const ago = (ms) => NOW - ms;
const iso = (ms) => new Date(NOW - ms).toISOString();
const dateKey = (offsetDays) => new Date(NOW + offsetDays * DAY).toISOString().slice(0, 10);

function seed(withCost = true) {
  const wp = (v) => (withCost ? v : 0);
  const inv = [
    { code: 'AX', type: 'item', name: 'Amoxicillin', price: 100, wholesalePrice: wp(60), qty: 40, unit: 'pcs', expiryDate: dateKey(400) },
    { code: 'PC', type: 'item', name: 'Paracetamol', price: 20, wholesalePrice: wp(5), qty: 2, unit: 'pcs' },
    { code: 'IB', type: 'item', name: 'Ibuprofen', price: 30, wholesalePrice: wp(10), qty: 0, unit: 'pcs' },
    { code: 'OLD', type: 'item', name: 'Old Syrup', price: 50, wholesalePrice: wp(20), qty: 5, unit: 'pcs', expiryDate: dateKey(-1) },
    { code: 'SOON', type: 'item', name: 'Soon Tablets', price: 50, wholesalePrice: wp(20), qty: 7, unit: 'pcs', expiryDate: dateKey(10) },
    { code: 'SLOW', type: 'item', name: 'Slow Drug', price: 80, wholesalePrice: wp(40), qty: 9, unit: 'pcs' },
    { code: 'NRS1', type: 'service', name: 'Dressing', price: 300, unit: 'use' },
  ];
  const sale = (id, msAgo, items, by, method, amt, extra = {}) => ({ id, refNumber: 'ref-' + id, timestamp: iso(msAgo), items, servedBy: by, paymentMethod: method, paid: true, cashAmount: method === 'cash' ? amt : 0, mpesaAmount: method === 'mpesa' ? amt : 0, cardAmount: method === 'card' ? amt : 0, ...extra });
  const sales = [
    sale('s0', DAY, [{ name: 'Consultation Fee', price: 400, qty: 1, unit: 'use', isService: true }], 'Amina', 'cash', 400),                                                // yesterday: the comparison period
    sale('s1', 60e3, [{ name: 'Consultation Fee', price: 500, qty: 1, unit: 'use', isService: true }, { name: 'Lab Test: Malaria', price: 300, qty: 1, unit: 'use', isService: true }], 'Amina', 'cash', 800, { chargeIds: ['c1', 'c2'], patientId: 'PT-1', customerName: 'John Doe (PT-1)' }),
    sale('s2', 120e3, [{ code: 'AX', name: 'Amoxicillin', price: 100, qty: 3, unit: 'pcs', wholesalePrice: wp(60) }, { code: 'PC', name: 'Paracetamol', price: 20, qty: 2, unit: 'pcs', wholesalePrice: wp(5) }], 'Brian', 'mpesa', 340, { customerName: 'Mary Wanjiku (PT-2)' }),
    sale('s3', 180e3, [{ name: 'Imaging: X-ray Chest', price: 1000, qty: 1, unit: 'use', isService: true }], 'Amina', 'card', 1000, { chargeIds: ['c3'] }),
    sale('s4', 240e3, [{ code: 'AX', name: 'Amoxicillin', price: 100, qty: 1, unit: 'pcs', wholesalePrice: 60 }], 'Amina', 'cash', 100, { voided: true }),                      // voided: never counted
    sale('s5', 300e3, [{ code: 'AX', name: 'Amoxicillin', price: 100, qty: 1, unit: 'pcs', wholesalePrice: 60 }], 'Brian', 'cash', 100, { paid: false }),                      // unpaid: not revenue
    sale('s6', 360e3, [{ name: 'Admission Deposit — Bed 1 (General)', price: 2000, qty: 1, unit: 'payment', isService: true }], 'Amina', 'cash', 2000),
    sale('s7', 400e3, [{ name: 'Refund — Ref ref-s2', price: -40, qty: 1, unit: 'payment', isService: true }], 'Amina', 'cash', -40, { isRefund: true }),
  ];
  const pt = (id, name, regMsAgo, extra = {}) => ({ id, name, age: 30, sex: 'female', phone: '0700000000', registeredAt: ago(regMsAgo), ...extra });
  const patients = [
    pt('PT-1', 'John Doe', 120e3), pt('PT-2', 'Mary Wanjiku', 40 * DAY), pt('PT-3', 'Peter Otieno', 40 * DAY),
    pt('PT-4', 'Grace Achieng', 100e3, { maternity: { gravida: 1, parity: 0, ancVisits: [{ at: ago(90e3) }], deliveries: [{ id: 'd1', at: ago(80e3), newborns: ['NB1'] }], labour: { startedAt: ago(85e3), endedAt: ago(80e3) } } }),
  ];
  const visit = (id, pid, msAgo, by, type = 'outpatient', extra = {}) => ({ id, patientId: pid, timestamp: ago(msAgo), seenBy: by, visitType: type, diagnosis: 'Secret Diagnosis X', ...extra });
  const visits = [visit('v1', 'PT-1', 70e3, 'Dr A'), visit('v2', 'PT-2', 80e3, 'Dr A'), visit('v3', 'PT-2', 90e3, 'Dr B', 'inpatient'), visit('v4', 'PT-3', 95e3, 'Dr A', 'outpatient', { voided: { at: 1 } }), visit('v5', 'PT-3', DAY, 'Dr A')];
  const ch = (id, ref, kind, name, price, qty, status, extra = {}) => ({ id, ref, patientId: 'PT-1', patientName: 'John Doe', kind, name, code: '', qty, price, status, unit: 'use', isService: kind !== 'medication', ...extra });
  const charges = [ch('c1', 'V1', 'consultation', 'Consultation Fee', 500, 1, 'paid'), ch('c2', 'V1', 'lab', 'Lab Test: Malaria', 300, 1, 'paid', { department: 'Laboratory' }), ch('c3', 'V3', 'radiology', 'Imaging: X-ray Chest', 1000, 1, 'paid', { department: 'Radiology' }),
    ch('u1', 'V8', 'medication', 'Amoxicillin', 100, 2, 'unpaid', { code: 'AX', isService: false }), ch('u2', 'V8', 'service', 'Dressing', 300, 1, 'unpaid'), ch('u3', 'V9', 'lab', 'Lab Test: CBC', 0, 1, 'unpaid', { priceNeeded: true })];
  const queue = [
    { id: 'q1', patientId: 'PT-1', arrivedAt: ago(10 * 60e3), triageLevel: 'emergency', status: 'waiting', stage: 'triage', stationStatus: 'waiting', stationAt: ago(10 * 60e3), stageHistory: [], events: [] },
    { id: 'q2', patientId: 'PT-2', arrivedAt: ago(5 * 60e3), triageLevel: 'routine', status: 'waiting', stage: 'triage', stationStatus: 'waiting', stationAt: ago(5 * 60e3), stageHistory: [], events: [] },
    { id: 'q3', patientId: 'PT-3', arrivedAt: ago(60 * 60e3), triageLevel: 'routine', status: 'done', stage: 'triage', outcome: 'completed', completedAt: ago(30 * 60e3), stageHistory: [], events: [] },
  ];
  return {
    inv, sales, patients, visits, charges, queue,
    expenses: [{ id: 'e1', timestamp: iso(30e3), category: 'Utilities', description: 'Power', amount: 250 }],
    appointments: [{ id: 'a1', patientId: 'PT-1', patientName: 'John Doe', scheduledFor: NOW + 60e3, status: 'scheduled', type: 'consultation' }, { id: 'a2', patientId: 'PT-2', patientName: 'Mary Wanjiku', scheduledFor: ago(120e3), status: 'completed', type: 'consultation' }, { id: 'a3', patientId: 'PT-3', patientName: 'Peter Otieno', scheduledFor: ago(130e3), status: 'cancelled', type: 'consultation' }],
    admissions: [{ id: 'ad1', patientId: 'PT-1', bedLabel: 'Bed 1', status: 'admitted', admittedAt: ago(120e3) }, { id: 'ad2', patientId: 'PT-2', bedLabel: 'Bed 2', status: 'discharged', admittedAt: ago(3 * DAY), dischargedAt: ago(60e3), finalDays: 3 }],
    rooms: ['Bed 1', 'Bed 2'], roomStates: { 'Bed 1': { status: 'occupied', reservation: null } },
    labs: [{ id: 'l1', patientId: 'PT-1', testName: 'Malaria', requestedAt: ago(100e3), status: 'pending' }, { id: 'l2', patientId: 'PT-2', testName: 'CBC', requestedAt: ago(DAY), resultAt: ago(50e3), status: 'completed' }],
    radiology: [{ id: 'r1', patientId: 'PT-1', requestedAt: ago(100e3), status: 'requested' }],
    theatre: [{ id: 't1', patientId: 'PT-1', requestedAt: ago(100e3), status: 'requested' }, { id: 't2', patientId: 'PT-2', requestedAt: ago(3 * DAY), status: 'in_theatre' }],
    bills: [{ id: 'b1', items: [{ code: 'AX', name: 'Amoxicillin', price: 1000, qty: 1, unit: 'pcs' }], amountPaid: 400, timestamp: iso(2 * DAY), customerName: 'Peter Otieno' }],
    debts: [{ id: 'd1', customerName: 'Mary Wanjiku', amount: 700, payments: [{ amount: 200 }], timestamp: iso(DAY) }],
    institutions: [{ id: 'i1', name: 'SHA', balance: 800 }],
    staff: [{ id: 's1', name: 'Jane', pinHash: 'x', roles: ['reception-tab', 'dashboard-tab'], salesTabMigrated: true }],
  };
}
const EMPTY = () => ({ inv: [], sales: [], patients: [], visits: [], charges: [], queue: [], expenses: [], appointments: [], admissions: [], rooms: [], roomStates: {}, labs: [], radiology: [], theatre: [], bills: [], debts: [], institutions: [], staff: [] });
async function open(browser, base, data, width = 390) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 700, hasTouch: width < 700 });
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([h, d]) => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'Test Hospital');
    set('pos_inventory', d.inv); set('pos_sales_log', d.sales); set('pos_expenses', d.expenses); set('pos_patients', d.patients); set('pos_visits', d.visits);
    set('pos_patient_charges', d.charges); set('pos_queue', d.queue); set('pos_appointments', d.appointments); set('pos_admissions', d.admissions); set('pos_rooms', d.rooms); set('pos_room_states', d.roomStates);
    set('pos_lab_results', d.labs); set('pos_radiology_orders', d.radiology); set('pos_theatre_cases', d.theatre); set('pos_bills', d.bills); set('pos_debts', d.debts); set('pos_institutions', d.institutions); set('pos_staff', d.staff);
  }, [H, data]);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.goto(base + '/hospital/index.html'); await page.waitForTimeout(1500);
  await page.evaluate(() => { document.getElementById('login-screen').style.display = 'none'; });
  await page.evaluate(() => { document.querySelector('.tab-link[data-tab="dashboard-tab"]').click(); });
  await page.waitForSelector('#dash-hosp-root .dh-kpis', { timeout: 8000 });
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}
const txt = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);
const kpiMap = (page) => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('.dh-kpi')).map((k) => [k.querySelector('.dh-kpi-l').textContent.toLowerCase(), k.querySelector('.dh-kpi-v').textContent])));
async function withBrowser(fn) {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try { await fn(browser, base); } finally { await browser.close(); srv.close(); }
}
const reopen = async (page) => { await page.evaluate(() => { DashHosp.open(); }); await page.waitForSelector('#dash-hosp-root .dh-kpis', { timeout: 8000 }); await page.waitForTimeout(500); };

test('the tab exists, is a lockable role, and switching to it shows the panel', { skip, timeout: 90000 }, async () => withBrowser(async (browser, base) => {
  const { ctx, page, errors } = await open(browser, base, seed());
  const r = await page.evaluate(() => ({
    btn: !!document.getElementById('dashboard-tab-btn'), active: document.getElementById('dashboard-tab').classList.contains('active'),
    lockable: LOCKABLE_TABS.some((t) => t.id === 'dashboard-tab'), role: ROLE_TABS.some((t) => t.id === 'dashboard-tab'),
    staffLocked: (() => { currentServer = { id: 's1', name: 'Jane' }; staff[0].roles = ['reception-tab']; const v = isTabLocked('dashboard-tab'); currentServer = null; return v; })(),
    ownerLocked: isTabLocked('dashboard-tab'),
  }));
  assert.ok(r.btn && r.active && r.lockable && r.role);
  assert.equal(r.staffLocked, true, 'a staff member not given the Dashboard cannot reach it');
  assert.equal(r.ownerLocked, false);
  assert.deepEqual(errors, []);
  await ctx.close();
}));

test('figures reconcile with the HMIS records; departments and payment methods add up to revenue', { skip, timeout: 120000 }, async () => withBrowser(async (browser, base) => {
  const { ctx, page, errors } = await open(browser, base, seed(true));
  const k = await kpiMap(page);
  assert.equal(k["today's revenue"], 'KES 4,100');            // 800 + 340 + 1000 + 2000 - 40 refund; the voided and the unpaid sale are out
  assert.equal(k['payments'], '4');                            // refunds are not payments received
  assert.equal(k['patients seen'], '2');                       // PT-1, PT-2 (the voided visit does not count)
  assert.equal(k['consultations'], '3');
  assert.equal(k['new patients'], '2');
  assert.equal(k['in the facility now'], '2');
  assert.equal(k['admitted now'], '1');
  assert.equal(k['lab tests pending'], '1');
  assert.equal(k['low / out of stock'], '1 / 1');
  assert.equal(k['still to collect'], 'KES 2,500');            // 500 unpaid patient charges + 700 pay-later bills (600 seeded + the 100 unpaid sale the app turned into a bill) + 500 debts + 800 institutions
  const d = await page.evaluate(() => {
    const x = DashHosp.compute(DashHosp.rangeFor('today')); const ops = hospitalOpsSnapshot();
    const dept = Object.fromEntries(Object.keys(x.A.dept).map((q) => [q, x.A.dept[q].rev]));
    return { rev: x.A.revenue, count: x.A.count, cogs: x.A.cogs, dept, deptSum: Object.values(dept).reduce((a, b) => a + b, 0), meth: Object.values(x.A.method).reduce((a, b) => a + b.amt, 0), cash: x.A.method.cash.amt, mpesa: x.A.method.mpesa.amt, card: x.A.method.card.amt,
      appRev: revenueForDate(dayKeyOf(Date.now())), billOwed: x.recv.billOwed, recvTotal: x.recv.total, debtOwed: x.recv.debtOwed, appBillOwed: bills.filter((b) => !b.voided && !b.closed).reduce((s, b) => s + Math.max(0, billTotalOf(b) - (b.amountPaid || 0)), 0), appDebtOwed: debts.filter((q) => !q.removed).reduce((s, q) => s + debtBalance(q), 0), unpaidAmt: x.recv.unpaidAmt, opsUnpaid: ops.unpaidAmount, unpaidBills: x.recv.unpaidBills, opsBills: ops.unpaidBills, queue: ops.queueWaiting, emergency: ops.emergencyWaiting,
      seen: x.seen, first: x.firstTime, returning: x.returning, op: x.V.op, ip: x.V.ip, exp: x.expTotal, hasCost: x.hasCost,
      stock: [x.low.length, x.out.length, x.expired.length, x.expiring.length, x.slow.map((r) => r.name).join()], wards: x.wards, mat: x.mat, diag: x.diag, appt: x.apptStatus,
      staff: Object.fromEntries(x.staffRows.map((r) => [r.name, [r.visits, r.sales, r.rev]])), drugs: Object.fromEntries(Object.values(x.A.drug).map((r) => [r.name, [r.qty, r.rev]])) };
  });
  assert.equal(d.rev, 4100); assert.equal(d.rev, d.appRev, 'dashboard revenue equals the app\'s own Daily Sales figure');
  assert.equal(d.count, 4);
  assert.equal(d.cogs, 3 * 60 + 2 * 5);
  assert.deepEqual(d.dept, { consult: 500, lab: 300, pharmacy: 340, radiology: 1000, ward: 2000, refund: -40 });
  assert.equal(d.deptSum, d.rev, 'departments add up to revenue');
  assert.equal(d.meth, d.rev, 'payment methods add up to revenue');
  assert.deepEqual([d.cash, d.mpesa, d.card], [2760, 340, 1000]);
  assert.equal(d.billOwed, d.appBillOwed, 'pay-later balances match the app\'s own bill maths'); assert.equal(d.debtOwed, d.appDebtOwed); assert.equal(d.recvTotal, d.unpaidAmt + d.billOwed + d.debtOwed + 800);
  assert.equal(d.unpaidAmt, d.opsUnpaid, 'unpaid patient charges match the Hospital Report'); assert.equal(d.unpaidAmt, 500); assert.equal(d.unpaidBills, d.opsBills);
  assert.equal(d.queue, 2); assert.equal(d.emergency, 1);
  assert.deepEqual([d.seen, d.first, d.returning, d.op, d.ip], [2, 1, 1, 2, 1]);
  assert.equal(d.exp, 250);
  assert.deepEqual(d.stock, [1, 1, 1, 1, 'Slow Drug,Soon Tablets,Old Syrup']);   // low: Paracetamol(2) - out: Ibuprofen - expired: Old Syrup - expiring: Soon Tablets - in stock but unsold today (biggest tied-up value first): Slow Drug 360, Soon Tablets 140, Old Syrup 100
  assert.deepEqual(d.wards, { now: 1, admitted: 1, discharged: 1, beds: 2, occupied: 1 });
  assert.deepEqual(d.mat, { anc: 1, deliveries: 1, newborns: 1, labourStarted: 1, inLabour: 0, mothers: 1 });
  assert.deepEqual(d.diag, { labReq: 1, labDone: 1, labPending: 1, radReq: 1, radOpen: 1, thReq: 1, thIn: 1 });
  assert.deepEqual(d.appt, { scheduled: 1, completed: 1, cancelled: 1 });
  assert.deepEqual(d.staff['Amina'], [0, 3, 3760]); assert.deepEqual(d.staff['Brian'], [0, 1, 340]); assert.deepEqual(d.staff['Dr A'], [2, 0, 0]); assert.deepEqual(d.staff['Dr B'], [1, 0, 0]);
  assert.deepEqual(d.drugs, { Amoxicillin: [3, 300], Paracetamol: [2, 40] });
  assert.match(await txt(page, '[data-w="departments"]'), /Pharmacy/);
  assert.deepEqual(errors, []);
  await ctx.close();
}));

test('comparison with the previous period is shown only when there is something to compare', { skip, timeout: 90000 }, async () => withBrowser(async (browser, base) => {
  const { ctx, page } = await open(browser, base, seed(true));
  const d = await page.evaluate(() => { const x = DashHosp.compute(DashHosp.rangeFor('today')); return { prevRev: x.P.revenue, seenPrev: x.seenPrev }; });
  assert.equal(d.prevRev, 400); assert.equal(d.seenPrev, 1);
  assert.match(await txt(page, '.dh-kpis'), /↑ 925% vs yesterday/);
  await ctx.close();
  const e = EMPTY(); e.sales = seed().sales.filter((s) => s.id === 's1');
  const o = await open(browser, base, e);
  assert.match(await txt(o.page, '.dh-kpis'), /No earlier data to compare/);
  await o.ctx.close();
}));

test('no patient name, diagnosis or clinical detail on screen or in the export', { skip, timeout: 90000 }, async () => withBrowser(async (browser, base) => {
  const { ctx, page } = await open(browser, base, seed(true));
  for (const p of ['today', 'month', 'year']) { await page.click('[data-preset="' + p + '"]'); await page.waitForTimeout(500); }
  await page.click('[data-preset="today"]'); await page.waitForTimeout(500);
  const all = await page.evaluate(() => document.getElementById('dashboard-tab').innerHTML + ' ' + document.getElementById('dashboard-tab').innerText);
  const csv = await page.evaluate(() => JSON.stringify(DashHosp.csvRows()));
  for (const bad of ['John Doe', 'Mary Wanjiku', 'Peter Otieno', 'Grace Achieng', 'Secret Diagnosis', 'Malaria', 'PT-1', 'X-ray']) { assert.ok(!all.includes(bad), 'screen leaks ' + bad); assert.ok(!csv.includes(bad), 'export leaks ' + bad); }
  assert.match(csv, /4100/);
  await ctx.close();
}));

test('missing buying prices: profit is not invented, and a clear note is shown', { skip, timeout: 90000 }, async () => withBrowser(async (browser, base) => {
  const { ctx, page } = await open(browser, base, seed(false));
  const k = await kpiMap(page);
  assert.equal(k['gross profit'], 'No data');
  assert.match(await txt(page, '[data-w="profit"]'), /buying prices/i);
  await ctx.close();
}));

test('no records at all: honest empty states, no broken charts, no errors', { skip, timeout: 90000 }, async () => withBrowser(async (browser, base) => {
  const { ctx, page, errors } = await open(browser, base, EMPTY());
  assert.match(await txt(page, '#dash-hosp-root'), /No activity yet/);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#dash-hosp-root svg.dh-line').length), 0, 'no empty charts drawn');
  assert.match(await txt(page, '[data-w="departments"]'), /No payments received/);
  assert.match(await txt(page, '[data-w="stock"]'), /No pharmacy stock/);
  assert.deepEqual(errors, []);
  await ctx.close();
}));

test('a failing widget or helper never takes the page down', { skip, timeout: 120000 }, async () => withBrowser(async (browser, base) => {
  const { ctx, page, errors } = await open(browser, base, seed(true));
  await page.evaluate(() => { DashHosp.insights = () => { throw new Error('boom'); }; });
  await reopen(page);
  assert.match(await txt(page, '[data-w="insights"]'), /could not load/);
  assert.ok(await page.evaluate(() => !!document.querySelector('[data-w="alerts"] .dh-alerts') && !!document.querySelector('[data-w="departments"] .dh-donut')), 'other widgets still draw');
  assert.ok(await page.evaluate(() => !!document.querySelector('[data-retry="insights"]')), 'a retry button is offered');
  await page.evaluate(() => { window.hospitalOpsSnapshot = () => { throw new Error('ops down'); }; });
  await reopen(page);
  assert.match(await txt(page, '[data-w="flow"]'), /not available/);
  assert.ok(await page.evaluate(() => !!document.querySelector('.dh-kpi')));
  assert.equal(errors.filter((e) => !/boom|ops down/.test(e)).length, 0);
  await ctx.close();
}));

test('date range chips, custom range, weekly ranges, drill-down and CSV export', { skip, timeout: 120000 }, async () => withBrowser(async (browser, base) => {
  const { ctx, page, errors } = await open(browser, base, seed(true));
  await page.click('[data-preset="yesterday"]'); await page.waitForTimeout(500);
  const yk = await page.evaluate(() => { const r = DashHosp.rangeFor('yesterday'); const x = DashHosp.compute(r); return [r.fromKey, r.toKey, r.days, x.A.revenue, x.seen]; });
  assert.equal(yk[0], yk[1]); assert.equal(yk[2], 1); assert.equal(yk[3], 400); assert.equal(yk[4], 1);
  const wk = await page.evaluate(() => { const r = DashHosp.rangeFor('week', '', '', '2026-10-02'); const l = DashHosp.rangeFor('lastweek', '', '', '2026-10-02'); const m = DashHosp.rangeFor('lastmonth', '', '', '2026-01-15'); return [r.fromKey, r.toKey, l.fromKey, l.toKey, m.fromKey, m.toKey, r.days]; });
  assert.deepEqual(wk, ['2026-09-28', '2026-10-02', '2026-09-21', '2026-09-27', '2025-12-01', '2025-12-31', 5]);
  await page.click('[data-preset="month"]'); await page.waitForTimeout(500);
  const m = await page.evaluate(() => { const x = DashHosp.compute(DashHosp.rangeFor('month')); return [x.A.revenue, x.V.n, x.series.length]; });
  assert.ok(m[0] >= 4100 && m[1] >= 3 && m[2] >= 1);
  await page.click('[data-preset="custom"]'); await page.waitForTimeout(400);
  await page.evaluate(() => { document.getElementById('dh-from').value = '2000-01-01'; document.getElementById('dh-to').value = '2000-01-31'; });
  await page.click('[data-applycustom]'); await page.waitForTimeout(500);
  assert.equal((await kpiMap(page))['revenue'], 'KES 0');
  await page.click('[data-preset="today"]'); await page.waitForTimeout(500);
  // drill-down: a headline card opens the existing tab
  await page.click('.dh-kpi[data-goto="queue-tab"]'); await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => document.getElementById('queue-tab').classList.contains('active')), 'the queue card opens the Triage tab');
  await page.evaluate(() => { document.querySelector('.tab-link[data-tab="dashboard-tab"]').click(); }); await page.waitForTimeout(600);
  await page.click('[data-w="alerts"] button[data-goto="inventory-list-tab"]'); await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => document.getElementById('inventory-list-tab').classList.contains('active')), 'a stock alert opens Pharmacy Stock');
  await page.evaluate(() => { document.querySelector('.tab-link[data-tab="dashboard-tab"]').click(); }); await page.waitForTimeout(600);
  const rows = await page.evaluate(() => DashHosp.csvRows());
  assert.ok(rows.some((r) => r[0] === 'Revenue' && r[1] === 4100));
  assert.ok(rows.some((r) => r[0] === 'Patients seen' && r[1] === 2));
  assert.deepEqual(errors, []);
  await ctx.close();
}));

test('phone layout has no horizontal overflow, in light and dark mode, across periods', { skip, timeout: 150000 }, async () => withBrowser(async (browser, base) => {
  const { ctx, page, errors } = await open(browser, base, seed(true), 390);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme'); }, theme);
    for (const p of ['today', 'week', 'month', 'year']) {
      await page.click('[data-preset="' + p + '"]'); await page.waitForTimeout(700);
      const o = await page.evaluate(() => { const r = document.getElementById('dash-hosp-root'); const bad = Array.from(r.querySelectorAll('*')).filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > window.innerWidth + 1) && !e.closest('.dh-chips') && !e.closest('.dh-tbl') && !e.closest('svg'); }).slice(0, 3).map((e) => e.className + ':' + Math.round(e.getBoundingClientRect().right)); return { page: document.documentElement.scrollWidth <= window.innerWidth + 1, bad }; });
      assert.ok(o.page, theme + '/' + p + ': no horizontal page scroll on a phone');
      assert.deepEqual(o.bad, [], theme + '/' + p + ': nothing pokes out of the phone screen');
    }
  }
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.dh-kpi')).backgroundColor);
  assert.notEqual(bg, 'rgb(255, 255, 255)', 'dark theme card');
  const chip = await page.evaluate(() => getComputedStyle(document.querySelector('.dh-chip.on')).color);
  assert.ok(chip);
  await page.setViewportSize({ width: 1280, height: 900 }); await page.waitForTimeout(400);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'desktop too');
  assert.deepEqual(errors, []);
  await ctx.close();
}));

test('roles: a staff member without finance access never receives money; finance roles do; staff see only their own row', { skip, timeout: 150000 }, async () => withBrowser(async (browser, base) => {
  const data = seed(true); data.visits.push({ id: 'v9', patientId: 'PT-1', timestamp: ago(65e3), seenBy: 'Jane', visitType: 'outpatient', diagnosis: 'Secret Diagnosis X' });
  const { ctx, page, errors } = await open(browser, base, data, 1280);
  // the owner sees money, the customize button and every staff row
  assert.match(await txt(page, '.dh-kpis'), /KES 4,100/);
  assert.ok(await page.evaluate(() => !!document.querySelector('[data-act="customize"]')));
  assert.ok(await page.evaluate(() => document.querySelectorAll('[data-w="staff"] .dh-list li').length >= 4));
  // a receptionist: Dashboard + Reception only
  await page.evaluate(() => { currentServer = { id: 's1', name: 'Jane' }; applyServerVisibility(); });
  await reopen(page);
  const html = await page.evaluate(() => document.getElementById('dash-hosp-root').innerHTML + document.getElementById('dash-hosp-root').innerText);
  assert.ok(!/KES|Revenue|revenue|\bKsh\b/.test(html), 'no money anywhere on the page for a role without finance access');
  assert.ok(!/data-tip="[^"]*KES/.test(html));
  for (const w of ['departments', 'payments', 'receivables', 'profit', 'expenses']) assert.equal(await page.evaluate((x) => !!document.querySelector('[data-w="' + x + '"]'), w), false, w + ' hidden');
  assert.match(html, /Financial figures are shown only/);
  const k = await kpiMap(page); assert.ok(!('payments' in k) && !("today's revenue" in k) && !('still to collect' in k) && !('drug stock value' in k));
  assert.equal(k['patients seen'], '2'); assert.equal(k['in the facility now'], '2');
  const st = await page.evaluate(() => Array.from(document.querySelectorAll('[data-w="staff"] .dh-li-main b')).map((e) => e.textContent));
  assert.deepEqual(st, ['Jane'], 'own row only');
  assert.ok(await page.evaluate(() => !document.querySelector('[data-act="customize"]')), 'no customize for staff');
  const csv = await page.evaluate(() => JSON.stringify(DashHosp.csvRows()));
  assert.ok(!/Revenue|Expenses|Gross profit/.test(csv), 'export carries no money for this role');
  // drill-down only to tabs the role can open
  assert.equal(await page.evaluate(() => !!document.querySelector('#dash-hosp-root [data-goto="bills-tab"]')), false);
  // a billing role with Reports gets the money
  await page.evaluate(() => { staff[0].roles = ['reception-tab', 'dashboard-tab', 'reports-tab']; applyServerVisibility(); });
  await reopen(page);
  assert.match(await txt(page, '.dh-kpis'), /KES 4,100/);
  assert.ok(await page.evaluate(() => !!document.querySelector('[data-w="departments"]')));
  assert.deepEqual(errors, []);
  await ctx.close();
}));
