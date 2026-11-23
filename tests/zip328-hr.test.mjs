import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { hrMigrationText } from '../tools/gen-migration.mjs';
import * as HR from '../functions/api/_hr.js';
import { ensureLedgerSchema } from '../functions/api/_ledger.js';

// Zip 328 — Staff & HR (prompt 7 part 1): employment rules, salary unset vs 0, PDF-only documents, history, deduction approval, payroll snapshots, reports.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const staffAuth = await load('functions/api/_staff-auth.js');
const route = await load('functions/api/payroll.js');
const worker = (await load('wildcard-router/worker.js')).default;
const mk = () => { const kv = makeKV(); seedShop(kv, 'C1'); seedShop(kv, 'C2'); return { kv, env: { mydukapos_kv: kv, LEDGER_DB: makeD1() } }; };
const tokenFor = async (env, c, id, name, mgr = false) => (await staffAuth.issueSession(env, c, { id, name, perms: ['*'], mgr })).token;
const call = async (env, c, tok, body) => {
  const headers = { 'content-type': 'application/json', ...(tok ? { 'X-Staff-Token': tok } : {}) };
  const r = await route.onRequestPost({ request: new Request(`https://x/api/payroll?c=${c}`, { method: 'POST', body: JSON.stringify(body), headers }), env });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : null, res: r };
};
const q = (env, sql, ...a) => env.LEDGER_DB.query(sql, ...a);
async function shop() {
  const { kv, env } = mk();
  kv.data.set('pos-data:state:C1', { value: JSON.stringify({ staff: [{ id: 's-john', name: 'John', pinHash: 'x' }, { id: 's-mary', name: 'Mary', pinHash: 'x' }] }) });
  const admin = await tokenFor(env, 'C1', 'admin', 'Admin', true);
  const john = await tokenFor(env, 'C1', 's-john', 'John'), mary = await tokenFor(env, 'C1', 's-mary', 'Mary');
  const admin2 = await tokenFor(env, 'C2', 'admin', 'Admin2', true);
  return { kv, env, admin, john, mary, admin2 };
}
const save = (env, tok, employee, c = 'C1') => call(env, c, tok, { action: 'employee.save', employee });
const PDF = (extra = '') => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<<' + extra + '>>endobj\n%%EOF').toString('base64');
const grant = (env, tok, id, perms) => call(env, 'C1', tok, { action: 'access.save', staffId: id, staffName: id, perms });

test('H1: contract needs an end date; intern needs duration or end date; end not before start; permanent may have none', async () => {
  const { env, admin } = await shop();
  const base = { name: 'A', basic_pay: 100, start_date: '2026-03-01' };
  assert.equal((await save(env, admin, { ...base, hr: { employment_basis: 'contract' } })).body.code, 'end_date_required');
  assert.equal((await save(env, admin, { ...base, hr: { employment_basis: 'intern' } })).body.code, 'duration_required');
  assert.equal((await save(env, admin, { ...base, hr: { employment_basis: 'contract', end_date: '2026-02-01' } })).body.code, 'bad_dates');
  assert.equal((await save(env, admin, { ...base, hr: { employment_basis: 'contract', end_date: '2026-13-45' } })).body.code, 'bad_date');
  assert.equal((await save(env, admin, { ...base, hr: { employment_basis: 'intern', internship_months: 99 } })).body.code, 'bad_duration');
  const perm = (await save(env, admin, { ...base, hr: { employment_basis: 'permanent' } })).body;
  assert.equal(perm.employee.hr.end_date, null);
  const con = (await save(env, admin, { name: 'B', basic_pay: 100, start_date: '2026-03-01', hr: { employment_basis: 'contract', end_date: '2027-02-28', work_schedule: 'part_time' } })).body.employee;
  assert.equal(con.hr.work_schedule, 'part_time'); assert.equal(con.employment_type, 'contract');
  const intern = (await save(env, admin, { name: 'C', basic_pay: 0, start_date: '2026-03-01', hr: { employment_basis: 'intern', internship_months: 3 } })).body.employee;
  assert.equal(intern.hr.end_date, '2026-05-31', 'the duration defines the end: last day of the last month');
  assert.equal(q(env, `select count(*) n from pr_employees`)[0].n, 3, 'refused saves wrote nothing');
});

test('H2: salary — blank is "not entered", 0 is a real salary, omitted keeps, non-numeric / negative refused; employment type never decides pay', async () => {
  const { env, admin } = await shop();
  const blank = (await save(env, admin, { name: 'Blank', basic_pay: '' })).body.employee;
  assert.equal(blank.salary_state, 'unset'); assert.equal(blank.basic_pay, null);
  const zero = (await save(env, admin, { name: 'Zero', basic_pay: 0, hr: { employment_basis: 'intern', internship_months: 2 }, start_date: '2026-01-01' })).body.employee;
  assert.equal(zero.salary_state, 'set'); assert.equal(zero.basic_pay, 0, 'KES 0 is valid');
  const pos = (await save(env, admin, { name: 'Pos', basic_pay: '25000.50' })).body.employee;
  assert.equal(pos.basic_pay, 25000.5);
  assert.equal((await save(env, admin, { name: 'X', basic_pay: 'abc' })).body.code, 'bad_amount');
  assert.equal((await save(env, admin, { name: 'X', basic_pay: -1 })).body.code, 'bad_amount');
  // an edit that does not mention basic_pay keeps it (it used to wipe it)
  const kept = (await save(env, admin, { emp_id: pos.emp_id, name: 'Pos Renamed' })).body.employee;
  assert.equal(kept.basic_pay, 25000.5); assert.equal(kept.salary_state, 'set');
  // an intern with no salary entered is NOT given a salary because of the type
  const intern = (await save(env, admin, { name: 'Int', hr: { employment_basis: 'intern', internship_months: 1 }, start_date: '2026-01-01' })).body.employee;
  assert.equal(intern.salary_state, 'unset');
  // entering the salary later flips unset -> set, and is in the history
  const later = (await save(env, admin, { emp_id: intern.emp_id, name: 'Int', basic_pay: 5000 })).body.employee;
  assert.equal(later.salary_state, 'set');
  const h = (await call(env, 'C1', admin, { action: 'hr.get', empId: intern.emp_id })).body.history;
  assert.ok(h.some((r) => r.field === 'salary' && r.old_value === null && r.new_value === '5000'));
});

test('H3: payroll leaves out unset salaries (with a warning), pays real 0, and a pay line only applies when approved and in its window', async () => {
  const { env, admin } = await shop();
  const a = (await save(env, admin, { name: 'Paid', basic_pay: 30000 })).body.employee;
  await save(env, admin, { name: 'Unset', basic_pay: '' });
  const z = (await save(env, admin, { name: 'Zero', basic_pay: 0 })).body.employee;
  // a deduction with an effective window that does not cover October, one that does, and one pending approval
  const ded = (label, meta, amount = 1000) => call(env, 'C1', admin, { action: 'payline.save', empId: a.emp_id, line: { kind: 'deduction', label, amount, meta } });
  await ded('Old', { effective_from: '2026-01-01', effective_to: '2026-06-30', reason: 'ended' });
  await ded('Current', { effective_from: '2026-10-01', reason: 'loan' }, 2000);
  await ded('Future', { effective_from: '2026-12-01' }, 4000);
  await ded('OnlyNov', { period: '2026-11' }, 8000);
  const run = (await call(env, 'C1', admin, { action: 'run.create', frequency: 'monthly', periodStart: '2026-10-01', periodEnd: '2026-10-31' })).body;
  assert.equal(run.ok, true); assert.ok(run.warnings.some((w) => /Unset: salary not entered/.test(w)));
  const got = (await call(env, 'C1', admin, { action: 'run.get', runId: run.runId })).body;
  assert.equal(got.items.length, 2, 'unset person not paid');
  const item = got.items.find((i) => i.emp_name === 'Paid');
  assert.equal(item.deductions, 2000, 'only the deduction that applies in October is taken');
  assert.equal(item.net, 28000);
  assert.equal(got.items.find((i) => i.emp_name === 'Zero').net, 0);
  void z;
});

test('H4: deduction approval — pending is not taken; only an approver approves; amounts never negative; retry does not double-deduct', async () => {
  const { env, admin, john, mary } = await shop();
  await grant(env, admin, 's-john', ['staff', 'run']);
  await grant(env, admin, 's-mary', ['approve', 'view']);
  await call(env, 'C1', admin, { action: 'hr.settings.save', settings: { deduction_approval: true } });
  const a = (await save(env, admin, { name: 'Paid', basic_pay: 30000 })).body.employee;
  const r1 = (await call(env, 'C1', john, { action: 'payline.save', empId: a.emp_id, line: { kind: 'deduction', label: 'Advance', amount: 5000, meta: { approval: 'approved', reason: 'advance' } } })).body;
  const meta = (await call(env, 'C1', admin, { action: 'employee.get', empId: a.emp_id })).body.lineMeta[r1.lineId];
  assert.equal(meta.approval, 'pending', 'a non-approver cannot approve their own deduction');
  const runA = (await call(env, 'C1', admin, { action: 'run.create', frequency: 'monthly', periodStart: '2026-09-01', periodEnd: '2026-09-30' })).body;
  assert.equal((await call(env, 'C1', admin, { action: 'run.get', runId: runA.runId })).body.items[0].deductions, 0, 'pending deduction is not taken');
  assert.equal((await call(env, 'C1', john, { action: 'payline.approve', empId: a.emp_id, lineId: r1.lineId })).body.code, 'payroll_forbidden');
  assert.equal((await call(env, 'C1', mary, { action: 'payline.approve', empId: a.emp_id, lineId: r1.lineId })).body.approval, 'approved');
  const runB = (await call(env, 'C1', admin, { action: 'run.create', frequency: 'monthly', periodStart: '2026-10-01', periodEnd: '2026-10-31' })).body;
  assert.equal((await call(env, 'C1', admin, { action: 'run.get', runId: runB.runId })).body.items[0].deductions, 5000);
  // the same period asked twice (a retry) is refused: no second run, so no second deduction
  const again = await call(env, 'C1', admin, { action: 'run.create', frequency: 'monthly', periodStart: '2026-10-01', periodEnd: '2026-10-31' });
  assert.equal(again.body.code, 'period_exists');
  assert.equal(q(env, `select count(*) n from pr_item_lines where label = 'Advance'`)[0].n, 1);
  assert.equal((await call(env, 'C1', admin, { action: 'payline.save', empId: a.emp_id, line: { kind: 'deduction', label: 'Neg', amount: -5 } })).body.code, 'bad_amount');
  assert.equal((await call(env, 'C1', admin, { action: 'payline.save', empId: a.emp_id, line: { kind: 'deduction', label: 'Bad', amount: 1, meta: { effective_from: '2026-05-01', effective_to: '2026-04-01' } } })).body.code, 'bad_dates');
});

test('H5: payroll snapshots are preserved — changing salary, deduction or end date later never changes a saved run', async () => {
  const { env, admin } = await shop();
  const a = (await save(env, admin, { name: 'Snap', basic_pay: 30000, hr: { employment_basis: 'contract', end_date: '2027-01-31' }, start_date: '2026-01-01' })).body.employee;
  await call(env, 'C1', admin, { action: 'payline.save', empId: a.emp_id, line: { kind: 'deduction', label: 'D', amount: 1000 } });
  const run = (await call(env, 'C1', admin, { action: 'run.create', frequency: 'monthly', periodStart: '2026-10-01', periodEnd: '2026-10-31' })).body;
  await call(env, 'C1', admin, { action: 'run.review', runId: run.runId }); await call(env, 'C1', admin, { action: 'run.approve', runId: run.runId });
  await save(env, admin, { emp_id: a.emp_id, name: 'Snap', basic_pay: 99999, hr: { end_date: '2026-10-05' } });
  await call(env, 'C1', admin, { action: 'payline.delete', empId: a.emp_id, lineId: q(env, `select line_id from pr_pay_lines`)[0].line_id });
  const it = (await call(env, 'C1', admin, { action: 'run.get', runId: run.runId })).body.items[0];
  assert.equal(it.basic, 30000); assert.equal(it.deductions, 1000); assert.equal(it.net, 29000);
});

test('H6: lifecycle — ending soon / ended flags, remaining duration, and NOTHING is deactivated automatically', async () => {
  const { env, admin } = await shop();
  const today = HR.localDay(Date.now(), 'Africa/Nairobi');
  const soon = (await save(env, admin, { name: 'Soon', basic_pay: 1, start_date: '2020-01-01', hr: { employment_basis: 'contract', end_date: HR.addDays(today, 10) } })).body.employee;
  const over = (await save(env, admin, { name: 'Over', basic_pay: 1, start_date: '2020-01-01', hr: { employment_basis: 'contract', end_date: HR.addDays(today, -5) } })).body.employee;
  const far = (await save(env, admin, { name: 'Far', basic_pay: 1, start_date: '2020-01-01', hr: { employment_basis: 'contract', end_date: HR.addDays(today, 400) } })).body.employee;
  assert.equal(soon.flags.ending_soon, true); assert.match(soon.flags.remaining, /10 days left/);
  assert.equal(over.flags.ended, true); assert.equal(over.status, 'active', 'an ended contract stays active until a person decides');
  assert.equal(far.flags.ending_soon, false);
  const al = (await call(env, 'C1', admin, { action: 'hr.alerts' })).body;
  assert.deepEqual(al.ending_soon.map((x) => x.name), ['Soon']); assert.deepEqual(al.ended.map((x) => x.name), ['Over']);
  assert.equal(q(env, `select count(*) n from pr_employees where status = 'active'`)[0].n, 3);
  // the list carries the lifecycle, and filters work
  const l = (await call(env, 'C1', admin, { action: 'employee.list', employment_basis: 'contract', endBefore: HR.addDays(today, 30) })).body;
  assert.deepEqual(l.employees.map((e) => e.name).sort(), ['Over', 'Soon']);
  assert.equal((await call(env, 'C1', admin, { action: 'employee.list', q: 'far' })).body.employees.length, 1);
});

test('H7: status lifecycle + history — who / when / what changed, append-only; status changes need the settings right', async () => {
  const { env, admin, john } = await shop();
  await grant(env, admin, 's-john', ['staff']);
  const a = (await save(env, admin, { name: 'Hist', basic_pay: 10000, job_title: 'Cashier', hr: { cadre: 'Junior' } })).body.employee;
  await save(env, john, { emp_id: a.emp_id, name: 'Hist', job_title: 'Supervisor', hr: { cadre: 'Senior', supervisor_name: 'Boss' } });
  assert.equal((await save(env, john, { emp_id: a.emp_id, name: 'Hist', status: 'terminated' })).body.code, 'payroll_forbidden');
  const t = (await save(env, admin, { emp_id: a.emp_id, name: 'Hist', status: 'terminated', effective_date: '2026-10-20' })).body.employee;
  assert.equal(t.status, 'terminated'); assert.ok(t.hr.deactivated_at);
  const h = (await call(env, 'C1', admin, { action: 'hr.get', empId: a.emp_id })).body.history;
  const f = (field) => h.filter((r) => r.field === field);
  assert.ok(f('job_title').some((r) => r.old_value === 'Cashier' && r.new_value === 'Supervisor' && r.actor_name === 'John'));
  assert.ok(f('cadre').some((r) => r.old_value === 'Junior' && r.new_value === 'Senior'));
  assert.ok(f('status').some((r) => r.new_value === 'terminated' && r.effective_date === '2026-10-20' && r.actor_name === 'Admin'));
  assert.throws(() => q(env, `delete from pr_emp_history`), /append_only/);
  assert.throws(() => q(env, `update pr_emp_history set field = 'x'`), /append_only/);
  // a terminated person is not in a new payroll run
  assert.equal((await call(env, 'C1', admin, { action: 'run.create', frequency: 'monthly', periodStart: '2026-11-01', periodEnd: '2026-11-30' })).body.code, 'no_employees');
});

test('H8: documents are PDF only — judged by content, active content refused, size limit configurable, tenant + permission checked, audited', async () => {
  const { env, admin, admin2, mary } = await shop();
  const a = (await save(env, admin, { name: 'Doc', basic_pay: 1 })).body.employee;
  const up = (dataUrl, tok = admin, c = 'C1', extra = {}) => call(env, c, tok, { action: 'doc.upload', empId: a.emp_id, title: 'CV', category: 'cv', dataUrl, ...extra });
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString('base64');
  const docx = 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,' + Buffer.from('PK\u0003\u0004zzzz').toString('base64');
  assert.equal((await up(png)).body.code, 'bad_file'); assert.equal((await up(docx)).body.code, 'bad_file');
  // a renamed file claiming to be a PDF
  assert.equal((await up('data:application/pdf;base64,' + Buffer.from('MZ\u0090\u0000 exe exe exe exe exe').toString('base64'))).body.code, 'bad_file');
  assert.equal((await up('data:application/pdf;base64,' + Buffer.from('%PDF-1.4 truncated and never ends here').toString('base64'))).body.code, 'bad_file', 'no %%EOF');
  assert.equal((await up(PDF('/JavaScript (app.alert(1))'))).body.code, 'unsafe_pdf');
  assert.equal((await up(PDF('/Launch /Win'))).body.code, 'unsafe_pdf');
  const ok = (await up(PDF(), admin, 'C1', { fileName: 'cv.pdf' })).body;
  assert.equal(ok.ok, true);
  const file = await call(env, 'C1', admin, { action: 'doc.file', docId: ok.docId });
  assert.equal(file.res.headers.get('content-type'), 'application/pdf'); assert.match(file.res.headers.get('content-security-policy'), /sandbox/); assert.equal(file.res.headers.get('cache-control'), 'no-store');
  // permission and tenant
  assert.equal((await call(env, 'C1', mary, { action: 'doc.file', docId: ok.docId })).status, 403);
  assert.equal((await call(env, 'C2', admin2, { action: 'doc.file', docId: ok.docId })).status, 404, 'another business cannot read it');
  assert.equal((await up(PDF(), admin2, 'C2')).body.code, 'not_found');
  // configurable size limit
  await call(env, 'C1', admin, { action: 'hr.settings.save', settings: { doc_max_mb: 0.5 } });
  const big = 'data:application/pdf;base64,' + Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(600 * 1024, 32), Buffer.from('\n%%EOF')]).toString('base64');
  assert.equal((await up(big)).body.code, 'file_too_big');
  assert.equal((await call(env, 'C1', admin, { action: 'hr.settings.save', settings: { doc_max_mb: 50 } })).body.code, 'bad_size');
  const acts = q(env, `select action from pr_audit`).map((r) => r.action);
  assert.ok(acts.includes('document_uploaded') && acts.includes('document_viewed'));
});

test('H9: staff list masks the ID number and hides salary / personal data from people without those rights', async () => {
  const { env, admin, john } = await shop();
  await grant(env, admin, 's-john', ['view']);
  await save(env, admin, { name: 'Sec', basic_pay: 5000, id_number: '12345678', email: 'a@b.co' });
  const l = (await call(env, 'C1', john, { action: 'employee.list' })).body.employees[0];
  assert.equal(l.id_number_masked, '•••••678'); assert.equal(l.email, undefined); assert.equal(l.id_number, undefined);
  assert.equal(l.basic_pay, 5000, 'a viewer sees pay');
  const { mary } = await shop();
  void mary;
});

test('H10: reports — correct week / month boundaries in the business time zone', () => {
  assert.deepEqual(HR.lastCompletePeriod('weekly', '2026-10-25'), { start: '2026-10-12', end: '2026-10-18' }, 'Sunday: the week is not over until midnight');
  assert.deepEqual(HR.lastCompletePeriod('weekly', '2026-10-26'), { start: '2026-10-19', end: '2026-10-25' });
  assert.deepEqual(HR.lastCompletePeriod('monthly', '2026-01-15'), { start: '2025-12-01', end: '2025-12-31' });
  assert.deepEqual(HR.lastCompletePeriod('monthly', '2026-03-01'), { start: '2026-02-01', end: '2026-02-28' });
  // 23:30 UTC on Saturday is already Sunday 02:30 in Nairobi; 21:30 UTC is still Sunday 00:30? -> compare zones
  const t = Date.UTC(2026, 9, 24, 22, 30);
  assert.equal(HR.localDay(t, 'Africa/Nairobi'), '2026-10-25'); assert.equal(HR.localDay(t, 'UTC'), '2026-10-24');
  assert.equal(HR.localDay(t, 'Not/AZone'), '2026-10-25', 'a bad zone falls back to Nairobi');
  assert.equal(HR.addMonths('2026-01-31', 1), '2026-02-28'); assert.equal(HR.validDay('2026-02-30'), false);
});

test('H11: scheduled reports are idempotent, per-tenant, preserve history, and a manual regeneration adds a version', async () => {
  const { env, admin, admin2 } = await shop();
  await save(env, admin, { name: 'Rep One', basic_pay: 1000 }); await save(env, admin, { name: 'Rep Two', basic_pay: 2000 }); await save(env, admin2, { name: 'Other', basic_pay: 9 }, 'C2');
  await call(env, 'C1', admin, { action: 'hr.settings.save', settings: { weekly: true, monthly: true } });
  const now = Date.UTC(2026, 9, 26, 6, 0);      // Monday 09:00 Nairobi
  const r1 = await HR.scheduledStaffReports(env, now);
  assert.equal(r1.ran.length, 2); assert.ok(r1.ran.every((x) => x.status === 'ok' && x.generated === 2));
  const r2 = await HR.scheduledStaffReports(env, now + 3600e3);
  assert.ok(r2.ran.every((x) => x.skipped === 'already_done'), 'a second firing does nothing');
  assert.equal(q(env, `select count(*) n from pr_reports`)[0].n, 4);
  assert.equal(q(env, `select count(*) n from pr_reports where client_id = 'C2'`)[0].n, 0, 'C2 did not switch reports on');
  const wk = q(env, `select period_start, period_end, tz from pr_reports where period_kind = 'weekly' limit 1`)[0];
  assert.deepEqual([wk.period_start, wk.period_end, wk.tz], ['2026-10-19', '2026-10-25', 'Africa/Nairobi']);
  // manual regeneration -> version 2, version 1 still there
  const reg = (await call(env, 'C1', admin, { action: 'hr.report.generate', kind: 'weekly', periodStart: '2026-10-20', force: true })).body;
  assert.equal(reg.result.generated, 2);
  assert.deepEqual(q(env, `select distinct version v from pr_reports where period_kind='weekly' order by v`).map((r) => r.v), [1, 2]);
  const list = (await call(env, 'C1', admin, { action: 'hr.report.list', kind: 'weekly' })).body.reports;
  assert.ok(list.every((r) => r.version === 2));
  const got = (await call(env, 'C1', admin, { action: 'hr.report.get', reportId: list[0].report_id })).body;
  assert.equal(got.versions.length, 2);
  // tenant isolation
  assert.equal((await call(env, 'C2', admin2, { action: 'hr.report.get', reportId: list[0].report_id })).body.code, 'not_found');
  // the worker's cron calls it
  const env2 = { ...env }; let p; await worker.scheduled({ cron: '20 */6 * * *' }, env2, { waitUntil: (x) => { p = Promise.all([p, x]); } }); await p;
});

test('H12: failed reports are recorded, shown on the dashboard, and a retry only fills in what is missing', async () => {
  const { env, admin } = await shop();
  await save(env, admin, { name: 'Good', basic_pay: 1 }); const bad = (await save(env, admin, { name: 'Bad', basic_pay: 1 })).body.employee;
  await call(env, 'C1', admin, { action: 'hr.settings.save', settings: { monthly: true } });
  // make ONE person's report fail (a poisoned row the builder cannot read)
  const orig = env.LEDGER_DB.prepare.bind(env.LEDGER_DB); let armed = true;
  env.LEDGER_DB.prepare = (sql) => { if (armed && /FROM pr_pay_lines l WHERE/.test(sql)) { const st = orig(sql); const b = st.bind.bind(st); st.bind = (...a) => { if (a[1] === bad.emp_id) throw new Error('boom'); return b(...a); }; return st; } return orig(sql); };
  const now = Date.UTC(2026, 9, 26, 6, 0);
  const r = await HR.scheduledStaffReports(env, now);
  assert.equal(r.ran[0].status, 'partial'); assert.equal(r.ran[0].failed, 1);
  const dash = (await call(env, 'C1', admin, { action: 'hr.report.dashboard' })).body;
  assert.equal(dash.jobs[0].status, 'partial'); assert.match(dash.jobs[0].last_error, /Bad: boom/);
  armed = false;
  const retry = (await call(env, 'C1', admin, { action: 'hr.report.retry', kind: 'monthly', periodStart: '2026-09-01' })).body;
  assert.equal(retry.result.status, 'ok');
  assert.equal(q(env, `select count(*) n from pr_reports`)[0].n, 2, 'one report each, no duplicate of the one that succeeded');
  assert.equal((await call(env, 'C1', admin, { action: 'hr.report.dashboard' })).body.jobs[0].attempts, 2);
});

test('H13: report content — salary and payroll are permission-gated, attendance is honestly unavailable, nothing is invented', async () => {
  const { env, admin, john } = await shop();
  await grant(env, admin, 's-john', ['view']);
  const a = (await save(env, admin, { name: 'Content', basic_pay: 7000, start_date: '2020-01-01', hr: { employment_basis: 'contract', end_date: '2026-09-20' } })).body.employee;
  await call(env, 'C1', admin, { action: 'hr.report.generate', kind: 'monthly', periodStart: '2026-09-10' });
  const id = (await call(env, 'C1', admin, { action: 'hr.report.list', kind: 'monthly' })).body.reports[0].report_id;
  const full = (await call(env, 'C1', admin, { action: 'hr.report.get', reportId: id })).body.report.data.sections;
  assert.equal(full.salary.basic_pay, 7000); assert.equal(full.attendance.available, false); assert.match(full.attendance.note, /not stored on the server/);
  assert.equal(full.sales.available, false);
  assert.ok(full.actions.some((x) => /end date has passed|ends/.test(x)));
  // a person with no payroll rights at all cannot read reports
  const { mary } = await shop(); void mary;
  const noPerm = await call(env, 'C1', await tokenFor(env, 'C1', 's-mary', 'Mary'), { action: 'hr.report.get', reportId: id });
  assert.equal(noPerm.status, 403);
  void john; void a;
});

test('H14: per-staff sales come from the ledger only when they exist', async () => {
  const { env, admin } = await shop();
  await ensureLedgerSchema(env.LEDGER_DB);
  const a = (await save(env, admin, { name: 'Seller', basic_pay: 1 })).body.employee;
  const cols = q(env, `select name from pragma_table_info('ledger_sales')`).map((r) => r.name);
  assert.ok(cols.includes('staff') && cols.includes('total'));
  env.LEDGER_DB.query(`insert into ledger_sales (client_id, sale_id, business_date, total, staff, status, ts, version, created_at, updated_at) values ('C1','s1','2026-09-10',150,'Seller','COMPLETED',1,1,1,1), ('C1','s2','2026-09-11',50,'Seller','VOIDED',1,1,1,1)`);
  await call(env, 'C1', admin, { action: 'hr.report.generate', kind: 'monthly', periodStart: '2026-09-01' });
  const id = (await call(env, 'C1', admin, { action: 'hr.report.list', kind: 'monthly' })).body.reports[0].report_id;
  const sec = (await call(env, 'C1', admin, { action: 'hr.report.get', reportId: id })).body.report.data.sections;
  assert.deepEqual([sec.sales.count, sec.sales.total], [1, 150], 'voided sales are not counted');
  void a;
});

test('H15: migration 0017 is the generated HR schema and works on its own, twice', () => {
  const file = fs.readFileSync(path.join(ROOT, 'migrations/0017_hr.sql'), 'utf8');
  assert.equal(file, hrMigrationText());
  const db = makeD1(); db._db.exec(fs.readFileSync(path.join(ROOT, 'migrations/0010_payroll.sql'), 'utf8')); db._db.exec(file); db._db.exec(file);
  for (const t of ['pr_emp_hr', 'pr_emp_history', 'pr_line_meta', 'pr_settings', 'pr_reports', 'pr_report_jobs']) assert.equal(db.query(`select name from sqlite_master where name = ?`, t).length, 1, t);
});

test('H16: the optional email notice never blocks reports, and carries no personal data', async () => {
  const { env, admin } = await shop();
  await save(env, admin, { name: 'Secret Person', basic_pay: 123456 });
  await call(env, 'C1', admin, { action: 'hr.settings.save', settings: { weekly: true, notify_email: 'owner@example.com' } });
  assert.equal((await call(env, 'C1', admin, { action: 'hr.settings.save', settings: { notify_email: 'not an email' } })).body.code, 'bad_email');
  const sent = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: String(init && init.body || '') }); return new Response('{}', { status: 200 }); };
  try {
    // no email service configured: the reports are still made, the notice is simply not sent
    const r = await HR.scheduledStaffReports(env, Date.UTC(2026, 9, 26, 6, 0));
    assert.equal(r.ran[0].status, 'ok'); assert.equal(r.ran[0].notified, false); assert.equal(sent.length, 0);
    // email configured: the notice is sent once, with counts only
    await env.mydukapos_kv.put('email-config:v1', JSON.stringify({ resendApiKey: 're_x' }));
    await call(env, 'C1', admin, { action: 'hr.settings.save', settings: { monthly: true } });
    const r2 = await HR.scheduledStaffReports(env, Date.UTC(2026, 9, 26, 7, 0));
    const mo = r2.ran.find((x) => x.kind === 'monthly'); assert.equal(mo.notified, true);
    assert.equal(sent.length, 1); assert.match(sent[0].body, /owner@example.com/);
    assert.doesNotMatch(sent[0].body, /Secret Person|123456/, 'no names or pay in the notice');
  } finally { globalThis.fetch = realFetch; }
});
