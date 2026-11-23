import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';




// Zip 328 — Staff & HR (prompt 7 part 1): employment rules, salary unset vs 0, PDF-only documents, history, deduction approval, payroll snapshots, reports.
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

// Zip 330 — everything about a staff member is editable from the Staff tab: personal details alone, employment alone, pay basics alone, pay lines in place,
// document details, roles & branches. Each edit keeps what it did not touch, is recorded, and is allowed only with the staff-record right.
const base = (o = {}) => ({ name: 'Wanjiku Kamau', phone: '0712345678', email: 'w@x.co', id_number: '12345678', dob: '1990-02-03', address: 'Kileleshwa', job_title: 'Receptionist', department: 'Front', branch_name: 'Main', start_date: '2026-01-05', basic_pay: 30000, pay_frequency: 'monthly', ...o });

test('E1: a personal-details-only save changes those fields and leaves employment and pay exactly as they were', async () => {
  const { env, admin } = await shop();
  const a = (await save(env, admin, base())).body.employee;
  const r = await save(env, admin, { emp_id: a.emp_id, name: 'Wanjiku W. Kamau', phone: '0799000111', email: 'new@x.co', address: 'Lavington', emergency_name: 'Peter', emergency_phone: '0711000222' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = (await call(env, 'C1', admin, { action: 'employee.get', empId: a.emp_id })).body.employee;
  assert.deepEqual([e.name, e.phone, e.email, e.address, e.emergency_name, e.emergency_phone], ['Wanjiku W. Kamau', '0799000111', 'new@x.co', 'Lavington', 'Peter', '0711000222']);
  assert.deepEqual([e.job_title, e.department, e.branch_name, e.start_date, Number(e.basic_pay), e.pay_frequency, e.id_number, e.dob], ['Receptionist', 'Front', 'Main', '2026-01-05', 30000, 'monthly', '12345678', '1990-02-03'], 'nothing else moved');
});

test('E2: a pay-basics-only save (amount, how often, how paid) and an employment-only save each leave the other parts alone and are recorded in the history', async () => {
  const { env, admin } = await shop();
  const a = (await save(env, admin, base())).body.employee;
  await save(env, admin, { emp_id: a.emp_id, name: a.name, basic_pay: 35000, pay_frequency: 'weekly', pay_method: 'mpesa', effective_date: '2026-06-01' });
  await save(env, admin, { emp_id: a.emp_id, name: a.name, job_title: 'Senior Receptionist', hr: { designation: 'Front desk lead', cadre: 'Grade 3', employment_basis: 'permanent', work_schedule: 'full_time' } });
  const d = (await call(env, 'C1', admin, { action: 'employee.get', empId: a.emp_id })).body;
  assert.deepEqual([Number(d.employee.basic_pay), d.employee.pay_frequency, d.employee.pay_method, d.employee.job_title, d.employee.hr.designation, d.employee.hr.cadre, d.employee.phone], [35000, 'weekly', 'mpesa', 'Senior Receptionist', 'Front desk lead', 'Grade 3', '0712345678']);
  const hist = (await call(env, 'C1', admin, { action: 'hr.get', empId: a.emp_id })).body.history.map((h) => h.field);
  for (const f of ['salary', 'pay_frequency', 'job_title', 'designation', 'cadre']) assert.ok(hist.includes(f), f + ' is in the change history');
});

test('E3: a pay line is edited IN PLACE (same line, no duplicate): name, amount, kind, dates, reason, switch off; a bad edit is refused and changes nothing', async () => {
  const { env, admin } = await shop();
  const a = (await save(env, admin, base())).body.employee;
  const lineId = (await call(env, 'C1', admin, { action: 'payline.save', empId: a.emp_id, line: { kind: 'earning', label: 'House allowance', amount: 5000, meta: { reason: 'start' } } })).body.lineId;
  const ed = await call(env, 'C1', admin, { action: 'payline.save', empId: a.emp_id, line: { line_id: lineId, kind: 'earning', label: 'Housing allowance', amount: 7500, calc: 'fixed', active: false, balance: '', meta: { effective_from: '2026-07-01', effective_to: '2026-12-31', reason: 'raised', reference: 'MEMO-9' } } });
  assert.equal(ed.status, 200, JSON.stringify(ed.body)); assert.equal(ed.body.lineId, lineId);
  const d = (await call(env, 'C1', admin, { action: 'employee.get', empId: a.emp_id })).body;
  assert.equal(d.payLines.length, 1, 'still one line');
  const l = d.payLines[0]; assert.deepEqual([l.label, Number(l.amount), l.active ? 1 : 0], ['Housing allowance', 7500, 0]);
  assert.deepEqual([d.lineMeta[lineId].effective_from, d.lineMeta[lineId].effective_to, d.lineMeta[lineId].reason, d.lineMeta[lineId].reference], ['2026-07-01', '2026-12-31', 'raised', 'MEMO-9']);
  const bad = await call(env, 'C1', admin, { action: 'payline.save', empId: a.emp_id, line: { line_id: lineId, kind: 'earning', label: 'Housing allowance', amount: -1 } });
  assert.equal(bad.body.code, 'bad_amount');
  assert.equal(Number((await call(env, 'C1', admin, { action: 'employee.get', empId: a.emp_id })).body.payLines[0].amount), 7500, 'the refused edit changed nothing');
  const rows = await q(env, `SELECT COUNT(*) n FROM pr_audit WHERE client_id = 'C1' AND action = 'pay_line_saved'`); assert.ok(Number(rows[0].n) >= 2, 'both saves are audited');
});

test('E4: document details (name, kind, dates) are edited without re-uploading; bad input refused; other businesses and people without the right cannot', async () => {
  const { env, admin, john, admin2 } = await shop();
  const a = (await save(env, admin, base())).body.employee;
  const up = await call(env, 'C1', admin, { action: 'doc.upload', empId: a.emp_id, title: 'ID copy', category: 'id', fileName: 'id.pdf', dataUrl: PDF() });
  assert.equal(up.status, 200, JSON.stringify(up.body)); const docId = up.body.docId;
  const ok = await call(env, 'C1', admin, { action: 'doc.update', docId, title: 'National ID (front & back)', category: 'contract', docDate: '2026-01-02', expiryDate: '2031-01-01' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const doc = (await call(env, 'C1', admin, { action: 'doc.list', empId: a.emp_id })).body.documents[0];
  assert.deepEqual([doc.title, doc.category, doc.doc_date, doc.expiry_date, doc.file_name, doc.size > 0], ['National ID (front & back)', 'contract', '2026-01-02', '2031-01-01', 'id.pdf', true], 'file untouched');
  await call(env, 'C1', admin, { action: 'doc.update', docId, expiryDate: '' });
  assert.equal((await call(env, 'C1', admin, { action: 'doc.list', empId: a.emp_id })).body.documents[0].expiry_date, null, 'an empty expiry clears it');
  assert.equal((await call(env, 'C1', admin, { action: 'doc.update', docId, title: '  ' })).body.code, 'title_required');
  assert.equal((await call(env, 'C1', admin, { action: 'doc.update', docId, docDate: '2026-13-45' })).body.code, 'bad_date');
  assert.equal((await call(env, 'C2', admin2, { action: 'doc.update', docId, title: 'Hacked' })).body.code, 'not_found', 'another business cannot touch it');
  assert.ok([401, 403].includes((await call(env, 'C1', john, { action: 'doc.update', docId, title: 'Nope' })).status), 'no staff-record right, no edit');
  assert.equal((await call(env, 'C1', admin, { action: 'doc.list', empId: a.emp_id })).body.documents[0].title, 'National ID (front & back)');
  const au = await q(env, `SELECT COUNT(*) n FROM pr_audit WHERE client_id = 'C1' AND action = 'document_edited'`); assert.ok(Number(au[0].n) >= 2);
});

test('E5: roles & branches: main branch, linked POS sign-in and extra branches are edited together and the change is recorded', async () => {
  const { env, admin } = await shop();
  const a = (await save(env, admin, base())).body.employee;
  const r = await save(env, admin, { emp_id: a.emp_id, name: a.name, branch_name: 'Westlands', pos_staff_id: 's-mary', hr: { branch_ids: ['Westlands', 'Main'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = (await call(env, 'C1', admin, { action: 'employee.get', empId: a.emp_id })).body.employee;
  assert.deepEqual([e.branch_name, e.pos_staff_id, e.hr.branch_ids], ['Westlands', 's-mary', ['Westlands', 'Main']]);
  assert.equal(e.job_title, 'Receptionist', 'the rest untouched');
  const hist = (await call(env, 'C1', admin, { action: 'hr.get', empId: a.emp_id })).body.history;
  assert.ok(hist.some((h) => h.field === 'branch_name' && h.new_value === 'Westlands'));
});
