import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
// Zip 221 — payslip Save + automatic archive to R2 (REAL SQL behind the D1 fake).
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const staffAuth = await load('functions/api/_staff-auth.js');
const route = await load('functions/api/payroll.js');
const bucket = () => { const m = new Map(); return { m, put: async (k, v) => { m.set(k, v); }, get: async (k) => (m.has(k) ? { text: async () => m.get(k) } : null) }; };
const call = async (env, tok, body) => {
  const r = await route.onRequestPost({ request: new Request('https://x/api/payroll?c=C1', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'X-Staff-Token': tok } }), env });
  return { status: r.status, body: await r.json() };
};
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF').toString('base64');
test('Z3: Save stores the PDF, replaces on re-save, archives old copies to R2 and restores on open', async () => {
  const kv = makeKV(); seedShop(kv, 'C1'); const r2 = bucket();
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), DB_BACKUPS: r2 };
  const admin = (await staffAuth.issueSession(env, 'C1', { id: 'admin', name: 'Admin', perms: ['*'], mgr: true })).token;
  const e = (await call(env, admin, { action: 'employee.save', employee: { name: 'John Doe', job_title: 'Cashier', basic_pay: 30000, pay_frequency: 'monthly' } })).body.employee || {};
  const empId = e.emp_id || (await call(env, admin, { action: 'employee.list' })).body.employees[0].emp_id;
  const run = (await call(env, admin, { action: 'run.create', frequency: 'monthly', periodStart: '2026-10-01', periodEnd: '2026-10-31' })).body;
  const s1 = await call(env, admin, { action: 'payslip.save', runId: run.runId, empId, pdf: 'data:application/pdf;base64,' + PDF, fileName: 'a.pdf' });
  assert.equal(s1.body.ok, true); assert.ok(s1.body.size > 10);
  assert.equal((await call(env, admin, { action: 'payslip.save', runId: run.runId, empId, pdf: '' })).body.code, 'bad_file');
  assert.equal((await call(env, admin, { action: 'payslip.save', runId: run.runId, empId, pdf: PDF })).body.ok, true, 're-save replaces');
  const rows = await env.LEDGER_DB.query('SELECT COUNT(*) n FROM pr_slip_files');
  assert.equal(rows[0].n, 1);
  assert.equal((await call(env, admin, { action: 'payslip.archive', days: 0 })).body.archived, 1);
  assert.equal(r2.m.size, 1);
  const row = (await env.LEDGER_DB.query('SELECT data, r2_key FROM pr_slip_files'))[0];
  assert.equal(row.data, null); assert.ok(row.r2_key);
  const back = (await call(env, admin, { action: 'payslip.saved', runId: run.runId, empId })).body;
  assert.equal(back.found, true); assert.equal(back.archived, true); assert.equal(back.pdf, PDF);
});
