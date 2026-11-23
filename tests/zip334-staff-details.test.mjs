import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { hr0018MigrationText } from '../tools/gen-migration.mjs';
import fs from 'node:fs';

// zip 334: any number of labelled registration numbers per person (all optional), documents capped at 1.5 MB.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const staffAuth = await load('functions/api/_staff-auth.js');
const route = await load('functions/api/payroll.js');
const mk = () => { const kv = makeKV(); seedShop(kv, 'C1'); seedShop(kv, 'C2'); return { kv, env: { mydukapos_kv: kv, LEDGER_DB: makeD1() } }; };
const tokenFor = async (env, c, id, name, mgr = false) => (await staffAuth.issueSession(env, c, { id, name, perms: ['*'], mgr })).token;
const call = async (env, c, tok, body) => {
  const r = await route.onRequestPost({ request: new Request(`https://x/api/payroll?c=${c}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(tok ? { 'X-Staff-Token': tok } : {}) } }), env });
  const ct = r.headers.get('content-type') || ''; return { status: r.status, body: ct.includes('json') ? await r.json() : null };
};
async function shop() {
  const { kv, env } = mk();
  kv.data.set('pos-data:state:C1', { value: JSON.stringify({ staff: [{ id: 's-john', name: 'John', pinHash: 'x' }] }) });
  const admin = await tokenFor(env, 'C1', 'admin', 'Admin', true), john = await tokenFor(env, 'C1', 's-john', 'John'), admin2 = await tokenFor(env, 'C2', 'admin', 'Admin2', true);
  const e = (await call(env, 'C1', admin, { action: 'employee.save', employee: { name: 'Wanjiku Kamau', basic_pay: 30000 } })).body.employee;
  return { env, admin, john, admin2, e };
}
const pdf = (bytes) => 'data:application/pdf;base64,' + Buffer.concat([Buffer.from('%PDF-1.4\n%x\n'), Buffer.alloc(bytes, 32), Buffer.from('\n%%EOF')]).toString('base64');

test('N1: a person can have many labelled numbers (ID, licence, employment ID, KRA PIN, phones, custom); blanks are ignored; order is kept', async () => {
  const { env, admin, e } = await shop();
  const r = await call(env, 'C1', admin, { action: 'numbers.save', empId: e.emp_id, numbers: [
    { kind: 'national_id', value: '12345678' }, { kind: 'driving_licence', value: 'DL-998877' }, { kind: 'employment_id', value: 'EMP/2026/14' },
    { kind: 'phone', value: '0712 345 678' }, { kind: 'phone', value: '0733 000 111' }, { kind: 'other', label: 'Boda permit', value: 'BP-5' }, { kind: 'kra_pin', value: '' }, { kind: 'nssf', value: '   ' } ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.numbers.map((n) => [n.kind, n.label, n.value]), [['national_id', null, '12345678'], ['driving_licence', null, 'DL-998877'], ['employment_id', null, 'EMP/2026/14'], ['phone', null, '0712 345 678'], ['phone', null, '0733 000 111'], ['other', 'Boda permit', 'BP-5']]);
  const g = (await call(env, 'C1', admin, { action: 'employee.get', empId: e.emp_id })).body;
  assert.equal(g.numbers.length, 6, 'employee.get carries them');
});

test('N2: numbers are optional (an empty list is fine), saving replaces the old set, exact duplicates collapse, unknown kinds become "other"', async () => {
  const { env, admin, e } = await shop();
  const save = (numbers) => call(env, 'C1', admin, { action: 'numbers.save', empId: e.emp_id, numbers });
  assert.equal((await save([])).status, 200);
  await save([{ kind: 'passport', value: 'A1' }, { kind: 'passport', value: 'a1' }, { kind: 'zzz', value: 'Q9' }]);
  let g = (await call(env, 'C1', admin, { action: 'employee.get', empId: e.emp_id })).body.numbers;
  assert.deepEqual(g.map((n) => [n.kind, n.value]), [['passport', 'A1'], ['other', 'Q9']]);
  await save([{ kind: 'kra_pin', value: 'A001' }]);
  g = (await call(env, 'C1', admin, { action: 'employee.get', empId: e.emp_id })).body.numbers;
  assert.deepEqual(g.map((n) => n.value), ['A001'], 'the new list replaced the old');
  assert.equal((await save(Array.from({ length: 41 }, (_, i) => ({ kind: 'other', value: 'n' + i })))).body.code, 'too_many');
  assert.equal((await call(env, 'C1', admin, { action: 'employee.get', empId: e.emp_id })).body.numbers.length, 1, 'a refused save changed nothing');
});

test('N3: only the staff-record right sees or edits numbers; another shop cannot; the audit log never holds the numbers', async () => {
  const { env, admin, john, admin2, e } = await shop();
  await call(env, 'C1', admin, { action: 'numbers.save', empId: e.emp_id, numbers: [{ kind: 'national_id', value: '99887766' }] });
  assert.equal((await call(env, 'C1', john, { action: 'numbers.save', empId: e.emp_id, numbers: [] })).status, 403);
  assert.equal((await call(env, 'C1', john, { action: 'numbers.all' })).status, 403);
  assert.equal((await call(env, 'C2', admin2, { action: 'numbers.save', empId: e.emp_id, numbers: [{ kind: 'phone', value: '1' }] })).status, 404, 'other shop: not found');
  const o2 = await call(env, 'C2', admin2, { action: 'numbers.all' }); assert.equal(o2.status, 200, JSON.stringify(o2.body)); assert.equal(o2.body.numbers.length, 0);
  const rows = env.LEDGER_DB.query(`SELECT detail FROM pr_audit WHERE action = 'numbers_saved'`);
  assert.ok(rows.length >= 1); assert.ok(rows.every((r) => !String(r.detail).includes('99887766')));
  const all = (await call(env, 'C1', admin, { action: 'numbers.all' })).body;
  assert.deepEqual(all.numbers.map((n) => n.value), ['99887766']);
});

test('D1: documents are capped at 1.5 MB (just under passes, just over is refused with a clear message)', async () => {
  const { env, admin, e } = await shop();
  const up = (n) => call(env, 'C1', admin, { action: 'doc.upload', empId: e.emp_id, title: 'Contract', category: 'contract', fileName: 'c.pdf', dataUrl: pdf(n) });
  assert.equal((await up(1.4 * 1024 * 1024)).status, 200);
  const big = await up(1.6 * 1024 * 1024);
  assert.equal(big.status, 413); assert.match(big.body.error, /1\.5 MB/);
});

test('M1: the 0018 migration file matches the schema source', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'migrations/0018_hr_numbers.sql'), 'utf8'), hr0018MigrationText());
});
