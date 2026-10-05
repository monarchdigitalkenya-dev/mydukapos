import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { payrollMigrationText } from '../tools/gen-migration.mjs';
import { calcItem, lineAmount, STATUTORY_TEMPLATE } from '../functions/api/_payroll.js';

// Zip 216 — Create Payroll: the server engine, its permissions, the frozen-run database rules, branch isolation. REAL SQL (node:sqlite behind the D1 fake).
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const staffAuth = await load('functions/api/_staff-auth.js');
const route = await load('functions/api/payroll.js');
const mk = () => { const kv = makeKV(); seedShop(kv, 'C1'); seedShop(kv, 'C2'); return { kv, env: { mydukapos_kv: kv, LEDGER_DB: makeD1() } }; };
const tokenFor = async (env, c, id, name, mgr = false) => (await staffAuth.issueSession(env, c, { id, name, perms: ['*'], mgr })).token;
const call = async (env, c, tok, body) => {
  const headers = { 'content-type': 'application/json', ...(tok ? { 'X-Staff-Token': tok } : {}) };
  const r = await route.onRequestPost({ request: new Request(`https://x/api/payroll?c=${c}`, { method: 'POST', body: JSON.stringify(body), headers }), env });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : null, res: r };
};
const q = (env, sql, ...a) => env.LEDGER_DB.query(sql, ...a);
async function shop(extra = {}) {
  const { kv, env } = mk();
  kv.data.set('pos-data:state:C1', { value: JSON.stringify({ staff: [{ id: 's-john', name: 'John', pinHash: 'x' }, { id: 's-mary', name: 'Mary', pinHash: 'x' }, { id: 's-pam', name: 'Pam', pinHash: 'x' }] }) });
  const admin = await tokenFor(env, 'C1', 'admin', 'Admin', true);
  const john = await tokenFor(env, 'C1', 's-john', 'John'), mary = await tokenFor(env, 'C1', 's-mary', 'Mary');
  return { kv, env, admin, john, mary, ...extra };
}
const emp = async (env, tok, f = {}) => (await call(env, 'C1', tok, { action: 'employee.save', employee: { name: 'John Doe', job_title: 'Cashier', basic_pay: 30000, pay_frequency: 'monthly', ...f } })).body.employee;
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF').toString('base64');

test('P2: the calculation — gross + additions - deductions = net, percentages, caps, bands, rounding', () => {
  const r = calcItem({ rate: 30000, rate_unit: 'period', units: 1 }, [
    { kind: 'earning', label: 'House', calc: 'fixed', amount: 5000 },
    { kind: 'deduction', label: 'Advance', calc: 'fixed', amount: 2000 },
  ]);
  assert.deepEqual([r.basic, r.additions, r.deductions, r.net], [30000, 5000, 2000, 33000]);
  // percent of gross with a base cap and a minimum, banded tax with relief and "less" lines
  const nssf = STATUTORY_TEMPLATE.find((x) => x.type_id === 'stat_nssf'), paye = STATUTORY_TEMPLATE.find((x) => x.type_id === 'stat_paye');
  assert.equal(lineAmount({ calc: 'percent_gross', rate: 6, cfg: nssf.cfg }, 200000, 200000), 6480, 'NSSF 6% of the capped base');
  assert.equal(lineAmount({ calc: 'percent_gross', rate: 2.75, cfg: { min: 300 } }, 5000, 5000), 300, 'minimum applies');
  const t = calcItem({ rate: 100000, rate_unit: 'period', units: 1 }, [
    { kind: 'deduction', type_id: 'stat_nssf', label: 'NSSF', calc: 'percent_gross', rate: 6, cfg: { base_cap: 108000 } },
    { kind: 'deduction', type_id: 'stat_paye', label: 'PAYE', calc: 'bands', rate: 0, cfg: paye.cfg },
  ]);
  const nss = t.lines[0].amount, tax = t.lines[1].amount;
  assert.equal(nss, 6000);
  // taxable = 100000 - (6000 + stat_shif 0 + stat_ahl 0) = 94000: 24000*10% + 8333*25% + 61667*30% - 2400
  assert.equal(tax, Math.round((2400 + 2083.25 + 18500.1 - 2400) * 100) / 100);
  assert.equal(t.net, Math.round((100000 - 6000 - tax) * 100) / 100);
  // daily pay uses days worked; an adjustment has no basic
  assert.equal(calcItem({ rate: 1500, rate_unit: 'day', units: 22 }, []).net, 33000);
  assert.equal(calcItem({ rate: 1500, rate_unit: 'day', units: 22 }, [{ kind: 'earning', calc: 'fixed', amount: 100 }], { adjustment: true }).net, 100);
  assert.equal(lineAmount({ calc: 'fixed', amount: -5 }, 0, 0), 0, 'a negative never goes through');
});

test('P1: employee -> salary -> ID copy -> run -> review -> approve -> pay -> payslip with the right earnings, deductions and net; audit trail and ledger record written', async () => {
  const { env, admin } = await shop();
  const e = await emp(env, admin);
  assert.match(e.emp_no, /^EMP-001$/); assert.equal(e.branch_id, 'C1');
  assert.equal((await emp(env, admin, { name: 'Jane' })).emp_no, 'EMP-002', 'numbers keep counting');
  await call(env, 'C1', admin, { action: 'payline.save', empId: e.emp_id, line: { kind: 'earning', label: 'House allowance', amount: 5000 } });
  await call(env, 'C1', admin, { action: 'payline.save', empId: e.emp_id, line: { kind: 'deduction', label: 'Salary advance', amount: 1500 } });
  const up = await call(env, 'C1', admin, { action: 'doc.upload', empId: e.emp_id, title: 'National ID copy', category: 'national_id', dataUrl: PDF, fileName: 'id.pdf', expiryDate: '2030-01-01' });
  assert.equal(up.body.ok, true);
  const f = await call(env, 'C1', admin, { action: 'doc.file', docId: up.body.docId });
  assert.equal(f.status, 200); assert.equal(f.res.headers.get('content-type'), 'application/pdf');
  const run = (await call(env, 'C1', admin, { action: 'run.create', frequency: 'monthly', periodStart: '2026-10-01', periodEnd: '2026-10-31' })).body;
  assert.match(run.ref, /^PR-202610-001$/);
  const got = (await call(env, 'C1', admin, { action: 'run.get', runId: run.runId })).body;
  const it = got.items.find((i) => i.emp_id === e.emp_id);
  assert.deepEqual([it.basic, it.additions, it.deductions, it.net], [30000, 5000, 1500, 33500]);
  assert.equal(got.run.total_net, got.items.reduce((n, i) => n + i.net, 0), 'run total = sum of the people');
  assert.equal((await call(env, 'C1', admin, { action: 'run.pay', runId: run.runId, method: 'bank' })).body.code, 'wrong_state', 'cannot pay before approval');
  assert.equal((await call(env, 'C1', admin, { action: 'run.approve', runId: run.runId })).body.code, 'wrong_state', 'cannot approve before review');
  assert.equal((await call(env, 'C1', admin, { action: 'run.review', runId: run.runId })).body.ok, true);
  assert.equal((await call(env, 'C1', admin, { action: 'run.approve', runId: run.runId })).body.run.status, 'approved');
  const paid = await call(env, 'C1', admin, { action: 'run.pay', runId: run.runId, method: 'mpesa', reference: 'QWE123', payDate: '2026-10-31' });
  assert.equal(paid.body.run.status, 'paid');
  const slip = (await call(env, 'C1', admin, { action: 'payslip.get', runId: run.runId, empId: e.emp_id, audit: true, how: 'print' })).body;
  assert.equal(slip.item.net, 33500); assert.equal(slip.run.pay_method, 'mpesa'); assert.equal(slip.run.pay_reference, 'QWE123');
  assert.ok(slip.lines.some((l) => l.label === 'House allowance' && l.amount === 5000)); assert.ok(slip.lines.some((l) => l.label === 'Salary advance' && l.amount === 1500));
  const actions = q(env, `select action from pr_audit where client_id = 'C1' order by id`).map((r) => r.action);
  for (const a of ['employee_created', 'document_uploaded', 'document_viewed', 'payroll_run_created', 'payroll_reviewed', 'payroll_approved', 'payroll_paid', 'payslip_generated']) assert.ok(actions.includes(a), a + ' is audited');
  const led = q(env, `select * from ledger_records where client_id = 'C1' and kind = 'payroll_run'`);
  assert.equal(led.length, 1); assert.equal(led[0].amount, got.run.total_net); assert.equal(led[0].status, 'PAID');
  assert.equal((await call(env, 'C1', admin, { action: 'run.pay', runId: run.runId, method: 'mpesa' })).body.already, true, 'a second Pay tap changes nothing');
  assert.equal(q(env, `select count(*) n from ledger_records where kind = 'payroll_run'`)[0].n, 1);
  assert.equal(q(env, `select count(*) n from pr_audit where action = 'payroll_paid'`)[0].n, 1);
});

test('P3: permissions are enforced by the server — no session, no grant, own-only, and ACCESS DENIED for another employee\'s documents and payslips', async () => {
  const { env, admin, john, mary } = await shop();
  const eJohn = await emp(env, admin, { name: 'John', pos_staff_id: 's-john', basic_pay: 25000 });
  const eMary = await emp(env, admin, { name: 'Mary', pos_staff_id: 's-mary', basic_pay: 41000 });
  const doc = await call(env, 'C1', admin, { action: 'doc.upload', empId: eMary.emp_id, title: 'Mary ID', category: 'national_id', dataUrl: PDF });
  assert.equal((await call(env, 'C1', null, { action: 'employee.list' })).status, 401, 'no session');
  for (const a of [{ action: 'employee.list' }, { action: 'run.list' }, { action: 'dashboard' }, { action: 'types.list' }, { action: 'audit.list' }, { action: 'doc.list', empId: eMary.emp_id }, { action: 'employee.get', empId: eMary.emp_id }, { action: 'run.create', frequency: 'monthly', periodStart: '2026-10-01', periodEnd: '2026-10-31' }]) {
    const r = await call(env, 'C1', john, a);
    assert.equal(r.status, 403, a.action); assert.match(r.body.error, /ACCESS DENIED/);
  }
  const f = await call(env, 'C1', john, { action: 'doc.file', docId: doc.body.docId });
  assert.equal(f.status, 403); assert.match(f.body.error, /ACCESS DENIED/, 'another employee\'s private document');
  assert.equal((await call(env, 'C1', john, { action: 'employee.save', employee: { name: 'Hacker' } })).status, 403);
  assert.equal((await call(env, 'C1', john, { action: 'access.save', staffId: 's-john', perms: ['view', 'staff', 'run', 'approve', 'settings'] })).status, 403, 'cannot grant yourself');
  // a paid run: Mary can open HER payslip only
  const run = (await call(env, 'C1', admin, { action: 'run.create', frequency: 'monthly', periodStart: '2026-10-01', periodEnd: '2026-10-31' })).body;
  await call(env, 'C1', admin, { action: 'run.review', runId: run.runId });
  const me0 = (await call(env, 'C1', mary, { action: 'me' })).body;
  assert.equal(me0.payslips.length, 0, 'nothing before it is paid');
  assert.equal((await call(env, 'C1', mary, { action: 'payslip.get', runId: run.runId, empId: eMary.emp_id })).status, 403, 'not while a draft/review');
  await call(env, 'C1', admin, { action: 'run.approve', runId: run.runId });
  await call(env, 'C1', admin, { action: 'run.pay', runId: run.runId, method: 'cash' });
  const me = (await call(env, 'C1', mary, { action: 'me' })).body;
  assert.equal(me.payslips.length, 1); assert.equal(me.employee.name, 'Mary'); assert.equal(me.payslips[0].net, 41000);
  assert.equal((await call(env, 'C1', mary, { action: 'payslip.get', runId: run.runId, empId: eMary.emp_id })).status, 200);
  const other = await call(env, 'C1', mary, { action: 'payslip.get', runId: run.runId, empId: eJohn.emp_id });
  assert.equal(other.status, 403); assert.match(other.body.error, /ACCESS DENIED/);
  assert.equal(JSON.stringify(me).includes('25000'), false, 'no other salary leaks');
  // a payroll manager with only view: sees salaries, cannot edit or see documents
  await call(env, 'C1', admin, { action: 'access.save', staffId: 's-john', staffName: 'John', perms: ['view'] });
  const list = (await call(env, 'C1', john, { action: 'employee.list' })).body.employees;
  assert.ok(list.every((x) => x.id_number === undefined) && list.some((x) => x.basic_pay === 41000));
  assert.equal((await call(env, 'C1', john, { action: 'doc.file', docId: doc.body.docId })).status, 403);
  assert.equal((await call(env, 'C1', john, { action: 'run.create', frequency: 'monthly', periodStart: '2026-11-01', periodEnd: '2026-11-30' })).status, 403);
  // revoking is immediate; a removed staff account loses it even with a live session
  await call(env, 'C1', admin, { action: 'access.save', staffId: 's-john', perms: ['view', 'run'] });
  assert.equal((await call(env, 'C1', john, { action: 'run.list' })).status, 200);
  const st = JSON.parse(env.mydukapos_kv.data.get('pos-data:state:C1').value); st.staff[0].removed = true;
  env.mydukapos_kv.data.set('pos-data:state:C1', { value: JSON.stringify(st) });
  assert.equal((await call(env, 'C1', john, { action: 'run.list' })).status, 403, 'removed staff: no payroll');
});

test('P4: a finalized payroll cannot be changed — not by the API, not by the database; a correction is an auditable adjustment/reversal', async () => {
  const { env, admin } = await shop();
  const e = await emp(env, admin, { basic_pay: 30000 });
  await call(env, 'C1', admin, { action: 'payline.save', empId: e.emp_id, line: { kind: 'earning', label: 'Transport', amount: 3000 } });
  const run = (await call(env, 'C1', admin, { action: 'run.create', frequency: 'monthly', periodStart: '2026-10-01', periodEnd: '2026-10-31' })).body;
  await call(env, 'C1', admin, { action: 'run.review', runId: run.runId });
  assert.equal((await call(env, 'C1', admin, { action: 'item.save', runId: run.runId, empId: e.emp_id, units: 1 })).body.code, 'run_not_draft', 'reviewed = locked');
  await call(env, 'C1', admin, { action: 'run.approve', runId: run.runId });
  for (const a of [{ action: 'item.save', runId: run.runId, empId: e.emp_id, lines: [] }, { action: 'run.reopen', runId: run.runId }, { action: 'run.delete', runId: run.runId }, { action: 'run.removeEmployee', runId: run.runId, empId: e.emp_id }]) {
    const r = await call(env, 'C1', admin, a);
    assert.ok([409].includes(r.status), a.action + ' ' + r.status);
  }
  const bypass = (sql) => assert.throws(() => q(env, sql), /payroll_run_is_final|payroll_audit_is_append_only/);
  bypass(`update pr_items set net = 1 where run_id = '${run.runId}'`);
  bypass(`update pr_item_lines set amount = 1 where run_id = '${run.runId}'`);
  bypass(`delete from pr_item_lines where run_id = '${run.runId}'`);
  bypass(`delete from pr_items where run_id = '${run.runId}'`);
  bypass(`update pr_runs set total_net = 1 where run_id = '${run.runId}'`);
  bypass(`update pr_runs set status = 'draft' where run_id = '${run.runId}'`);
  bypass(`delete from pr_runs where run_id = '${run.runId}'`);
  bypass(`insert into pr_items (client_id, run_id, emp_id, payslip_no, emp_name) values ('C1', '${run.runId}', 'zz', 'zz', 'zz')`);
  bypass(`update pr_audit set action = 'x'`); bypass(`delete from pr_audit`);
  assert.equal(q(env, `select total_net from pr_runs where run_id = '${run.runId}'`)[0].total_net, 33000);
  // the right way: a reversal
  const rev = await call(env, 'C1', admin, { action: 'run.adjust', runId: run.runId, mode: 'reverse' });
  assert.equal(rev.body.ok, true);
  const g = (await call(env, 'C1', admin, { action: 'run.get', runId: rev.body.runId })).body;
  assert.equal(g.run.kind, 'adjustment'); assert.equal(g.run.adjusts_run_id, run.runId); assert.equal(g.run.total_net, -33000);
  assert.equal((await call(env, 'C1', admin, { action: 'run.adjust', runId: run.runId, mode: 'reverse' })).body.code, 'already_reversed');
  assert.ok(q(env, `select 1 from pr_audit where action = 'payroll_adjustment_created'`).length === 1);
  // a hand-made adjustment on a paid run: +2000 forgotten bonus, edited while draft, then finalized the normal way
  const adj = (await call(env, 'C1', admin, { action: 'run.adjust', runId: run.runId, mode: 'blank', empIds: [e.emp_id] })).body;
  const sv = await call(env, 'C1', admin, { action: 'item.save', runId: adj.runId, empId: e.emp_id, lines: [{ kind: 'earning', label: 'Forgotten bonus', amount: 2000 }] });
  assert.equal(sv.body.item.net, 2000);
});

test('P5: draft editing — days worked, percentage lines recalc, negatives and a bad review are refused; double Approve = one approval', async () => {
  const { env, admin } = await shop();
  const d = await emp(env, admin, { name: 'Dan', pay_frequency: 'daily', rate_unit: 'day', basic_pay: 1500 });
  const run = (await call(env, 'C1', admin, { action: 'run.create', frequency: 'daily', periodStart: '2026-10-05', periodEnd: '2026-10-05' })).body;
  assert.equal((await call(env, 'C1', admin, { action: 'run.review', runId: run.runId })).body.code, 'needs_fixing', 'days worked not entered: nothing invented');
  const s = await call(env, 'C1', admin, { action: 'item.save', runId: run.runId, empId: d.emp_id, units: 1, lines: [{ kind: 'earning', label: 'Overtime', amount: 250 }, { kind: 'deduction', label: 'Absence', amount: 100 }] });
  assert.deepEqual([s.body.item.basic, s.body.item.net], [1500, 1650]);
  assert.equal((await call(env, 'C1', admin, { action: 'item.save', runId: run.runId, empId: d.emp_id, lines: [{ kind: 'earning', label: 'x', amount: -5 }] })).body.code, 'bad_amount');
  assert.equal((await call(env, 'C1', admin, { action: 'item.save', runId: run.runId, empId: d.emp_id, lines: [{ kind: 'deduction', label: 'Too much', amount: 99999 }] })).body.item.net, -98499);
  assert.equal((await call(env, 'C1', admin, { action: 'run.review', runId: run.runId })).body.code, 'needs_fixing', 'deductions more than pay');
  await call(env, 'C1', admin, { action: 'item.save', runId: run.runId, empId: d.emp_id, lines: [{ kind: 'earning', label: 'Overtime', amount: 250 }] });
  assert.equal((await call(env, 'C1', admin, { action: 'run.review', runId: run.runId })).body.ok, true);
  const [a, b] = await Promise.all([call(env, 'C1', admin, { action: 'run.approve', runId: run.runId }), call(env, 'C1', admin, { action: 'run.approve', runId: run.runId })]);
  assert.equal(a.body.ok && b.body.ok, true);
  assert.equal(q(env, `select count(*) n from pr_audit where action = 'payroll_approved'`)[0].n, 1, 'one approval, one audit row');
  assert.equal((await call(env, 'C1', admin, { action: 'run.create', frequency: 'daily', periodStart: '2026-10-05', periodEnd: '2026-10-05' })).body.code, 'period_exists', 'no second run for the same period');
});

test('P6: statutory deductions exist only when the owner configures and switches them on; nothing is invented', async () => {
  const { env, admin } = await shop();
  const e = await emp(env, admin, { basic_pay: 50000 });
  const run1 = (await call(env, 'C1', admin, { action: 'run.create', frequency: 'monthly', periodStart: '2026-09-01', periodEnd: '2026-09-30' })).body;
  assert.equal((await call(env, 'C1', admin, { action: 'run.get', runId: run1.runId })).body.items[0].deductions, 0, 'no deductions unless configured');
  await call(env, 'C1', admin, { action: 'types.template' });
  const types = (await call(env, 'C1', admin, { action: 'types.list' })).body.types;
  assert.ok(types.filter((t) => t.statutory).every((t) => t.active === 0 && t.auto_apply === 0), 'the template arrives switched off');
  const run2 = (await call(env, 'C1', admin, { action: 'run.create', frequency: 'monthly', periodStart: '2026-08-01', periodEnd: '2026-08-31' })).body;
  assert.equal((await call(env, 'C1', admin, { action: 'run.get', runId: run2.runId })).body.items[0].deductions, 0, 'still nothing: switched off');
  for (const id of ['stat_nssf', 'stat_shif', 'stat_ahl', 'stat_paye']) { const t = types.find((x) => x.type_id === id); await call(env, 'C1', admin, { action: 'type.save', type: { ...t, active: 1, auto_apply: 1 } }); }
  const run3 = (await call(env, 'C1', admin, { action: 'run.create', frequency: 'monthly', periodStart: '2026-07-01', periodEnd: '2026-07-31' })).body;
  const it = (await call(env, 'C1', admin, { action: 'run.get', runId: run3.runId })).body.items[0];
  assert.deepEqual(it.lines.map((l) => l.label).sort(), ['Housing Levy (employee)', 'NSSF (employee)', 'PAYE (income tax)', 'SHIF (health)'].sort());
  assert.equal(it.basic - it.deductions, it.net);
  assert.ok(it.deductions > 0);
  assert.equal(it.lines.find((l) => l.label.startsWith('NSSF')).amount, 3000);
  assert.equal((await call(env, 'C1', admin, { action: 'type.save', type: { kind: 'deduction', label: 'x', calc: 'bands', cfg: { bands: [] } } })).body.code, 'bad_bands');
});

test('P7: loans count down when a run is paid and stop themselves at zero', async () => {
  const { env, admin } = await shop();
  const e = await emp(env, admin, { basic_pay: 20000 });
  await call(env, 'C1', admin, { action: 'payline.save', empId: e.emp_id, line: { kind: 'deduction', label: 'Staff loan', amount: 3000, balance: 4000 } });
  const pay = async (m, d) => { const r = (await call(env, 'C1', admin, { action: 'run.create', frequency: 'monthly', periodStart: `2026-${m}-01`, periodEnd: `2026-${m}-${d}` })).body; for (const a of ['run.review', 'run.approve']) await call(env, 'C1', admin, { action: a, runId: r.runId }); await call(env, 'C1', admin, { action: 'run.pay', runId: r.runId, method: 'cash' }); return (await call(env, 'C1', admin, { action: 'run.get', runId: r.runId })).body.items[0]; };
  assert.equal((await pay('01', '31')).deductions, 3000);
  assert.equal(q(env, `select balance from pr_pay_lines`)[0].balance, 1000);
  assert.equal((await pay('02', '28')).deductions, 1000, 'only what is still owed');
  const l = q(env, `select balance, active from pr_pay_lines`)[0];
  assert.deepEqual([l.balance, l.active], [0, 0]);
  assert.equal((await pay('03', '31')).deductions, 0);
});

test('P8: branches — every branch has its own staff register and payroll; one can never read or change another\'s', async () => {
  const { env, kv } = await shop();
  const a1 = await tokenFor(env, 'C1', 'admin', 'Admin', true), a2 = await tokenFor(env, 'C2', 'admin', 'Admin', true);
  const e1 = await emp(env, a1, { name: 'Main person' });
  const e2 = (await call(env, 'C2', a2, { action: 'employee.save', employee: { name: 'Branch 2 person', basic_pay: 10000 } })).body.employee;
  assert.equal(e2.emp_no, 'EMP-001', 'numbers are per branch'); assert.equal(e2.branch_id, 'C2');
  assert.deepEqual((await call(env, 'C1', a1, { action: 'employee.list' })).body.employees.map((x) => x.name), ['Main person']);
  assert.deepEqual((await call(env, 'C2', a2, { action: 'employee.list' })).body.employees.map((x) => x.name), ['Branch 2 person']);
  const r1 = (await call(env, 'C1', a1, { action: 'run.create', frequency: 'monthly', periodStart: '2026-10-01', periodEnd: '2026-10-31' })).body;
  assert.equal((await call(env, 'C2', a2, { action: 'run.get', runId: r1.runId })).status, 404);
  assert.equal((await call(env, 'C2', a2, { action: 'run.approve', runId: r1.runId })).status, 404);
  assert.equal((await call(env, 'C2', a2, { action: 'employee.get', empId: e1.emp_id })).status, 404);
  assert.equal((await call(env, 'C2', a2, { action: 'run.list' })).body.runs.length, 0);
  assert.equal((await call(env, 'C2', a1, { action: 'employee.list' })).status, 401, 'a token of one branch is useless in another');
});

test('P9: documents — only real PDF / photo / Word files within the size limit; replace, archive and delete are audited', async () => {
  const { env, admin } = await shop();
  const e = await emp(env, admin);
  const up = (extra) => call(env, 'C1', admin, { action: 'doc.upload', empId: e.emp_id, title: 'Cert', category: 'certificate', ...extra });
  assert.equal((await up({ dataUrl: 'data:application/x-msdownload;base64,TVo=' })).body.code, 'bad_file');
  assert.equal((await up({ dataUrl: 'data:application/pdf;base64,' + Buffer.from('<html>not a pdf</html>').toString('base64') })).body.code, 'bad_file', 'wrong signature');
  assert.equal((await up({ dataUrl: 'data:application/pdf;base64,' + Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(2.6 * 1024 * 1024)]).toString('base64') })).body.code, 'file_too_big');
  assert.equal((await up({ title: '', dataUrl: PDF })).body.code, 'title_required');
  const ok = (await up({ dataUrl: PDF, expiryDate: '2026-10-20' })).body;
  assert.equal((await call(env, 'C1', admin, { action: 'dashboard' })).body.expiring.length, 1, 'expiring soon shows on the dashboard');
  const jpg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]).toString('base64');
  assert.equal((await call(env, 'C1', admin, { action: 'doc.replace', docId: ok.docId, dataUrl: jpg, fileName: 'new.jpg' })).body.ok, true);
  assert.equal((await call(env, 'C1', admin, { action: 'doc.file', docId: ok.docId })).res.headers.get('content-type'), 'image/jpeg');
  assert.equal((await call(env, 'C1', admin, { action: 'doc.archive', docId: ok.docId })).body.ok, true);
  assert.equal((await call(env, 'C1', admin, { action: 'doc.list', empId: e.emp_id })).body.documents[0].status, 'archived');
  assert.equal((await call(env, 'C1', admin, { action: 'doc.delete', docId: ok.docId })).body.ok, true);
  assert.equal((await call(env, 'C1', admin, { action: 'doc.file', docId: ok.docId })).status, 404);
  const acts = q(env, `select action from pr_audit`).map((r) => r.action);
  for (const a of ['document_replaced', 'document_archived', 'document_deleted']) assert.ok(acts.includes(a), a);
});

test('P10: salary changes are audited with before / after; employee status; linking one POS sign-in to two people is refused', async () => {
  const { env, admin } = await shop();
  const e = await emp(env, admin, { basic_pay: 20000, pos_staff_id: 's-john' });
  await call(env, 'C1', admin, { action: 'employee.save', employee: { ...e, emp_id: e.emp_id, basic_pay: 25000 } });
  const row = q(env, `select detail from pr_audit where action = 'salary_changed'`)[0];
  assert.match(row.detail, /"basic_pay":20000/); assert.match(row.detail, /"basic_pay":25000/);
  assert.equal((await call(env, 'C1', admin, { action: 'employee.save', employee: { name: 'Twin', pos_staff_id: 's-john' } })).body.code, 'already_linked');
  assert.equal((await call(env, 'C1', admin, { action: 'employee.save', employee: { name: '' } })).body.code, 'name_required');
  assert.equal((await call(env, 'C1', admin, { action: 'employee.save', employee: { name: 'Neg', basic_pay: -5 } })).body.code, 'bad_amount');
  // an employee who is not active is not paid
  await call(env, 'C1', admin, { action: 'employee.save', employee: { ...e, emp_id: e.emp_id, status: 'suspended' } });
  assert.equal((await call(env, 'C1', admin, { action: 'run.create', frequency: 'monthly', periodStart: '2026-10-01', periodEnd: '2026-10-31' })).body.code, 'no_employees');
});

test('P11: migration 0010 is the generated schema and creates a working database by itself', () => {
  const file = fs.readFileSync(path.join(ROOT, 'migrations/0010_payroll.sql'), 'utf8');
  assert.equal(file, payrollMigrationText());
  const db = makeD1(); db._db.exec(file); db._db.exec(file);          // twice: safe to re-run
  assert.ok(db.query(`select name from sqlite_master where name = 'pr_runs_guard'`).length === 1);
});
