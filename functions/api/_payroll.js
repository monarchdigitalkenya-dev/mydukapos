// functions/api/_payroll.js — Create Payroll engine (zip 216). NOT a route (see payroll.js).
//
// WHAT THIS IS. The staff register, staff documents, pay runs, payslips and the payroll audit trail — all in Cloudflare D1 (tables pr_*),
// every row carrying the shop / branch link (client_id). A paid run also writes ONE record into the money ledger (ledger_records, kind
// 'payroll_run'), so payroll sits beside sales, expenses and the rest of the shop's financial records.
//
// WHO MAY DO WHAT is decided HERE, from the signed staff session (X-Staff-Token) — never from what the page chooses to show:
//   * the Admin: everything;
//   * a staff member the Admin has given payroll rights (table pr_access): exactly those rights (view | staff | run | approve | settings);
//   * everybody else with a valid session: their OWN profile and their OWN paid payslips (found through pos_staff_id), nothing else.
//   No session -> no payroll, whatever the shop's "staff sessions required" switch says.
//
// HOW MONEY STAYS HONEST.
//   * Net pay = basic + additions - deductions, computed by the SERVER (calcItem). The page only displays what it is told.
//   * Nothing is deducted that the owner did not configure: statutory deductions exist only as types the owner switches on and rates the
//     owner types (rates / bands live in the data, not in the code), and a deduction line is always visible on the draft.
//   * Approved and Paid runs are frozen by database triggers (see _payroll-schema.js). A correction is a new 'adjustment' run.
//   * Every state change is ONE conditional UPDATE ... WHERE status = <expected> inside ONE batch: two people pressing Approve at once, or a
//     double tap on Pay, produce exactly one transition and exactly one audit row.
import { PAYROLL_SCHEMA, PAYROLL_SCHEMA_VERSION } from './_payroll-schema.js';
import { ensureLedgerSchema } from './_ledger.js';
import { mediaKey, mediaPut, mediaGet, mediaDelete } from './_media.js';
import { staffRecord } from './_staff-auth.js';
import { ensureHrSchema, registerHr, hrClean, employmentFlags, lineApplies, lineMetaMap, getSettings as hrSettings, localDay, LEAVER_STATUSES } from './_hr.js';

export const PERMS = ['view', 'staff', 'run', 'approve', 'settings'];
export const FREQUENCIES = ['monthly', 'biweekly', 'weekly', 'daily'];
export const EMP_STATUSES = ['active', 'on_leave', 'suspended', 'inactive', 'terminated', 'former'];
export const DOC_CATEGORIES = ['national_id', 'passport', 'certificate', 'academic', 'professional', 'contract', 'appointment', 'cv', 'licence', 'other'];
const PAY_METHODS = ['cash', 'mpesa', 'bank', 'cheque', 'other'];
const CALCS = ['fixed', 'percent_basic', 'percent_gross', 'bands'];
export const DOC_MAX_BYTES = 1.5 * 1024 * 1024;          // zip 334: 1.5 MB. The staff screen shrinks bigger files before sending (photos become PDFs).
const MAX_MONEY = 1e9;

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v, n = 120) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, n) : null; };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v) => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const rid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowMs = () => Date.now();
const bad = (code, error, status = 400) => Object.assign(new Error(code), { code, error, status });

// ---------- schema ----------
const ready = new WeakMap();
export async function ensurePayrollSchema(db) {
  if (!db) return false;
  if (ready.get(db)) return true;
  let ok = false;
  try { const r = await db.prepare(`SELECT v FROM pr_meta WHERE k = 'schema'`).first(); ok = !!(r && Number(r.v) >= PAYROLL_SCHEMA_VERSION); } catch (e) { ok = false; }
  if (!ok) {
    await db.batch(PAYROLL_SCHEMA.map((s) => db.prepare(s)));
    await db.prepare(`INSERT INTO pr_meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(PAYROLL_SCHEMA_VERSION)).run();
  }
  await ensureHrSchema(db);
  ready.set(db, true);
  return true;
}

// ---------- the calculation (pure: tested on its own) ----------
function cfgOf(v) { if (!v) return {}; if (typeof v === 'object') return v; try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }

// The amount of ONE line. `basic` = basic pay of the period, `gross` = basic + additions so far, `lessOf(ids)` = what the named deduction lines came to.
export function lineAmount(line, basic, gross, lessOf = () => 0) {
  const cfg = cfgOf(line.cfg);
  const rate = num(line.rate);
  let amt = 0;
  if (line.calc === 'fixed' || !line.calc) amt = num(line.amount);
  else if (line.calc === 'percent_basic') amt = basic * rate / 100;
  else if (line.calc === 'percent_gross') {
    let base = gross;
    if (num(cfg.base_cap) > 0) base = Math.min(base, num(cfg.base_cap));
    amt = base * rate / 100;
  } else if (line.calc === 'bands') {
    let taxable = gross - (Array.isArray(cfg.lessTypeIds) ? lessOf(cfg.lessTypeIds) : 0);
    if (taxable < 0) taxable = 0;
    let prev = 0, tax = 0;
    const bands = Array.isArray(cfg.bands) ? cfg.bands : [];
    for (const b of bands) {
      const upTo = b.upTo == null || b.upTo === '' ? Infinity : num(b.upTo);
      if (taxable > prev) tax += (Math.min(taxable, upTo) - prev) * num(b.rate) / 100;
      prev = upTo;
      if (taxable <= upTo) break;
    }
    amt = Math.max(0, tax - num(cfg.relief));
  }
  if (amt > 0 && num(cfg.min) > 0 && amt < num(cfg.min)) amt = num(cfg.min);
  if (amt > 0 && num(cfg.max) > 0 && amt > num(cfg.max)) amt = num(cfg.max);
  return round2(Math.max(0, amt));
}

// item = { rate_unit, rate, units, adjustment? }, lines = [{ kind, type_id, calc, rate, amount, cfg, manual }]  ->  { basic, additions, deductions, net, lines }
export function calcItem(item, lines, { adjustment = false } = {}) {
  const basic = adjustment ? 0 : round2(num(item.rate) * (item.rate_unit === 'period' ? 1 : num(item.units)));
  const out = lines.map((l) => ({ ...l }));
  let additions = 0;
  for (const l of out) if (l.kind === 'earning') { if (!l.manual) l.amount = lineAmount(l, basic, basic + additions); additions = round2(additions + num(l.amount)); }
  const gross = round2(basic + additions);
  const done = new Map();
  const lessOf = (ids) => ids.reduce((s, id) => s + (done.get(String(id)) || 0), 0);
  const deds = out.filter((l) => l.kind === 'deduction');
  for (const l of deds.filter((x) => x.calc !== 'bands')) { if (!l.manual) l.amount = lineAmount(l, basic, gross, lessOf); done.set(String(l.type_id || l.label), num(l.amount)); }
  for (const l of deds.filter((x) => x.calc === 'bands')) { if (!l.manual) l.amount = lineAmount(l, basic, gross, lessOf); done.set(String(l.type_id || l.label), num(l.amount)); }
  const deductions = round2(deds.reduce((s, l) => s + num(l.amount), 0));
  return { basic, additions, deductions, net: round2(basic + additions - deductions), lines: out };
}

// The statutory starting points the owner can add (all switched OFF until the owner reviews and turns them on). The numbers are DATA, editable
// in Payroll Settings — they change by law, so they are never hard-wired into the calculation.
export const STATUTORY_TEMPLATE = [
  { type_id: 'stat_nssf', label: 'NSSF (employee)', calc: 'percent_gross', rate: 6, cfg: { base_cap: 108000 } },
  { type_id: 'stat_shif', label: 'SHIF (health)', calc: 'percent_gross', rate: 2.75, cfg: { min: 300 } },
  { type_id: 'stat_ahl', label: 'Housing Levy (employee)', calc: 'percent_gross', rate: 1.5, cfg: {} },
  { type_id: 'stat_paye', label: 'PAYE (income tax)', calc: 'bands', rate: 0, cfg: { relief: 2400, lessTypeIds: ['stat_nssf', 'stat_shif', 'stat_ahl'], bands: [{ upTo: 24000, rate: 10 }, { upTo: 32333, rate: 25 }, { upTo: 500000, rate: 30 }, { upTo: 800000, rate: 32.5 }, { upTo: null, rate: 35 }] } },
];
const DEFAULT_TYPES = [
  ['earning', 'House allowance'], ['earning', 'Transport allowance'], ['earning', 'Meal allowance'], ['earning', 'Commission'], ['earning', 'Bonus'], ['earning', 'Overtime'], ['earning', 'Other allowance'],
  ['deduction', 'Salary advance'], ['deduction', 'Staff loan'], ['deduction', 'Absence deduction'], ['deduction', 'Other deduction'],
];

// ---------- who is asking ----------
// -> { sid, name, admin, perms:Set }. Throws bad() when the staff member was removed.
export async function whoIs(env, db, clientId, claims) {
  const sid = String(claims.sid);
  if (sid === 'admin') return { sid, name: claims.name || 'Admin', admin: true, perms: new Set(PERMS) };
  const row = await db.prepare(`SELECT perms FROM pr_access WHERE client_id = ? AND staff_id = ?`).bind(clientId, sid).first();
  let perms = new Set();
  if (row) {
    let list = []; try { list = JSON.parse(row.perms); } catch (e) { list = []; }
    perms = new Set((Array.isArray(list) ? list : []).filter((p) => PERMS.includes(p)));
    if (perms.size) {                                                // a removed staff account loses payroll rights at once, even with a live session
      let m = null;
      try { m = await staffRecord(env, clientId, sid); } catch (e) { throw bad('busy', 'Could not check your account right now — try again.', 503); }
      if (m && m.removed) perms = new Set();
    }
  }
  return { sid, name: claims.name || sid, admin: false, perms };
}
const can = (who, ...ps) => who.admin || ps.some((p) => who.perms.has(p));
const need = (who, ...ps) => { if (!can(who, ...ps)) throw bad('payroll_forbidden', 'ACCESS DENIED — you do not have permission to do this in payroll.', 403); };
const anyPerm = (who) => who.admin || who.perms.size > 0;

// ---------- audit ----------
const auditStmt = (db, c, who, action, entity, id, detail) => db.prepare(`INSERT INTO pr_audit (client_id, ts, actor_id, actor_name, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?,?,?)`)
  .bind(c, nowMs(), String(who.sid), String(who.name || '').slice(0, 60), action, entity || null, id || null, detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1500));

async function nextSeq(db, c, k) {
  const r = await db.prepare(`INSERT INTO pr_seq (client_id, k, n) VALUES (?, ?, 1) ON CONFLICT(client_id, k) DO UPDATE SET n = n + 1 RETURNING n`).bind(c, k).first();
  return Number(r && r.n) || 1;
}

// ---------- readers ----------
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const one = (db, sql, ...a) => db.prepare(sql).bind(...a).first();

function shapeEmployee(e, who) {
  const salary = can(who, ...PERMS), personal = can(who, 'staff');
  const o = { emp_id: e.emp_id, emp_no: e.emp_no, name: e.name, phone: e.phone, email: personal ? e.email : null, job_title: e.job_title, department: e.department,
    branch_id: e.branch_id, branch_name: e.branch_name, start_date: e.start_date, employment_type: e.employment_type, pay_frequency: e.pay_frequency, status: e.status, pos_staff_id: e.pos_staff_id };
  if (salary) { o.basic_pay = e.basic_pay; o.rate_unit = e.rate_unit; o.pay_method = e.pay_method; }
  if (personal) { o.id_number = e.id_number; o.dob = e.dob; o.address = e.address; o.emergency_name = e.emergency_name; o.emergency_phone = e.emergency_phone; o.pay_account = e.pay_account; }
  return o;
}

// ---------- actions ----------
const A = {};

A['whoami'] = async ({ who }) => ({ sid: who.sid, name: who.name, admin: who.admin, perms: [...who.perms], any: anyPerm(who) });

// ---- employees ----
A['employee.list'] = async ({ db, c, who, body }) => {
  need(who, ...PERMS);
  const rows = await all(db, `SELECT * FROM pr_employees WHERE client_id = ? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'on_leave' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END, name COLLATE NOCASE`, c);
  const q = String(body.q || '').toLowerCase().trim();
  const list = rows.filter((e) => !q || [e.name, e.emp_no, e.job_title, e.phone].some((x) => String(x || '').toLowerCase().includes(q)));
  return { employees: list.map((e) => shapeEmployee(e, who)) };
};

A['employee.get'] = async ({ db, c, who, body }) => {
  need(who, ...PERMS);
  const e = await one(db, `SELECT * FROM pr_employees WHERE client_id = ? AND emp_id = ?`, c, String(body.empId || ''));
  if (!e) throw bad('not_found', 'That employee was not found.', 404);
  const out = { employee: shapeEmployee(e, who) };
  if (can(who, 'staff')) out.numbers = await numbersOf(db, c, e.emp_id);
  out.payLines = await all(db, `SELECT line_id, kind, type_id, label, calc, rate, amount, cfg, balance, active FROM pr_pay_lines WHERE client_id = ? AND emp_id = ? ORDER BY kind, label`, c, e.emp_id);
  out.history = await all(db, `SELECT i.run_id, r.ref, r.label, r.kind, r.status, r.period_start, r.period_end, r.pay_date, i.payslip_no, i.basic, i.additions, i.deductions, i.net FROM pr_items i JOIN pr_runs r ON r.client_id = i.client_id AND r.run_id = i.run_id WHERE i.client_id = ? AND i.emp_id = ? ORDER BY r.period_start DESC, r.created_at DESC`, c, e.emp_id);
  return out;
};

// ---- registration numbers (zip 334): as many labelled numbers per person as they like, all optional ----
export const NUMBER_KINDS = { national_id: 'National ID', passport: 'Passport', driving_licence: 'Driving licence', employment_id: 'Employment ID', staff_id: 'Staff / payroll ID', kra_pin: 'KRA PIN', nssf: 'NSSF', sha: 'SHA / SHIF', nhif: 'NHIF', work_permit: 'Work permit', professional_licence: 'Professional licence', phone: 'Phone number', other: 'Other' };
const MAX_NUMBERS = 40;
const numbersOf = (db, c, empId) => all(db, `SELECT num_id, kind, label, value FROM pr_emp_numbers WHERE client_id = ? AND emp_id = ? ORDER BY sort, num_id`, c, empId);
A['numbers.save'] = async ({ db, c, who, body }) => {
  need(who, 'staff');
  const e = await one(db, `SELECT emp_id, name FROM pr_employees WHERE client_id = ? AND emp_id = ?`, c, String(body.empId || ''));
  if (!e) throw bad('not_found', 'That employee was not found.', 404);
  const list = Array.isArray(body.numbers) ? body.numbers : null;
  if (!list) throw bad('bad_numbers', 'Send the list of numbers.');
  const rows = [], seen = new Set();
  for (const n of list) {
    const value = str(n && n.value, 60); if (!value) continue;                         // a blank row is simply not saved: every number is optional
    const kind = Object.prototype.hasOwnProperty.call(NUMBER_KINDS, n.kind) ? n.kind : 'other';
    const label = str(n.label, 40) || null;
    const key = kind + '|' + (label || '').toLowerCase() + '|' + value.toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    rows.push({ id: String(n.num_id || '').slice(0, 40) || rid('N'), kind, label: kind === 'other' || label ? label : null, value });
  }
  if (rows.length > MAX_NUMBERS) throw bad('too_many', 'That is more than ' + MAX_NUMBERS + ' numbers for one person.');
  const t = nowMs(), ids = new Set();
  const stmts = [db.prepare(`DELETE FROM pr_emp_numbers WHERE client_id = ? AND emp_id = ?`).bind(c, e.emp_id)];
  rows.forEach((r, i) => { let id = r.id; while (ids.has(id)) id = rid('N'); ids.add(id); stmts.push(db.prepare(`INSERT INTO pr_emp_numbers (client_id, emp_id, num_id, kind, label, value, sort, updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(c, e.emp_id, id, r.kind, r.label, r.value, i, t)); });
  stmts.push(auditStmt(db, c, who, 'numbers_saved', 'employee', e.emp_id, { employee: e.name, count: rows.length }));      // the numbers themselves stay out of the audit log
  await db.batch(stmts);
  return { numbers: await numbersOf(db, c, e.emp_id) };
};
// every person's numbers at once, for the staff download (CSV) - same permission as the personal details
A['numbers.all'] = async ({ db, c, who }) => {
  need(who, 'staff');
  return { numbers: await all(db, `SELECT emp_id, kind, label, value FROM pr_emp_numbers WHERE client_id = ? ORDER BY emp_id, sort, num_id`, c), kinds: NUMBER_KINDS };
};

const HIST_EMP = ['job_title', 'department', 'branch_name', 'start_date', 'status', 'pay_frequency'];
// ---- zip 366: staff photo + the five-way employment type (permanent / full time / part time / contract / internship) ----
// Kept in a one-to-one side table created on first use (CREATE IF NOT EXISTS, so there is nothing to migrate and no existing table or row changes). The stored
// basis/schedule columns that payroll logic reads are still set by the form; this only remembers which of the five words the person picked.
export const EMP_KINDS = ['permanent', 'full_time', 'part_time', 'contract', 'internship'];
const PHOTO_MAX = 60 * 1024;                                   // the screen shrinks a photo to ~160 px (a few KB); this is only the safety ceiling
const extraReady = new WeakMap();
async function ensureExtra(db) {
  if (extraReady.get(db)) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS pr_emp_extra (client_id TEXT NOT NULL, emp_id TEXT NOT NULL, emp_kind TEXT, photo TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (client_id, emp_id)) WITHOUT ROWID`).run();
  extraReady.set(db, true);
}
A['extra.save'] = async ({ db, c, who, body }) => {
  need(who, 'staff');
  await ensureExtra(db);
  const e = await one(db, `SELECT emp_id, name FROM pr_employees WHERE client_id = ? AND emp_id = ?`, c, String(body.empId || ''));
  if (!e) throw bad('not_found', 'That employee was not found.', 404);
  const x = body.extra && typeof body.extra === 'object' ? body.extra : {};
  const cur = await one(db, `SELECT emp_kind, photo FROM pr_emp_extra WHERE client_id = ? AND emp_id = ?`, c, e.emp_id);
  let kind = cur ? cur.emp_kind : null, photo = cur ? cur.photo : null;
  if (Object.prototype.hasOwnProperty.call(x, 'emp_kind')) { if (x.emp_kind && !EMP_KINDS.includes(x.emp_kind)) throw bad('bad_kind', 'Pick one of the listed employment types.'); kind = x.emp_kind || null; }
  if (Object.prototype.hasOwnProperty.call(x, 'photo')) {
    if (!x.photo) photo = null;
    else { const ph = String(x.photo); if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(ph)) throw bad('bad_photo', 'That photo could not be used. Pick a JPG or PNG.'); if (ph.length > PHOTO_MAX) throw bad('photo_big', 'That photo is too large. Pick a smaller one.'); photo = ph; }
  }
  await db.batch([
    db.prepare(`INSERT INTO pr_emp_extra (client_id, emp_id, emp_kind, photo, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(client_id, emp_id) DO UPDATE SET emp_kind=excluded.emp_kind, photo=excluded.photo, updated_at=excluded.updated_at`).bind(c, e.emp_id, kind, photo, nowMs()),
    auditStmt(db, c, who, 'extra_saved', 'employee', e.emp_id, { employee: e.name, kind: kind || '', photo: photo ? 'yes' : 'no' }),
  ]);
  return { ok: true, emp_kind: kind, photo: !!photo };
};
// everyone's photo + employment type at once (the staff list and the staff screen draw from this)
A['extra.all'] = async ({ db, c, who }) => {
  need(who, ...PERMS);
  await ensureExtra(db);
  const rows = await all(db, `SELECT emp_id, emp_kind, photo FROM pr_emp_extra WHERE client_id = ?`, c);
  const out = {}; rows.forEach((r) => { out[r.emp_id] = { emp_kind: r.emp_kind || null, photo: r.photo || null }; });
  return { extra: out };
};

const HIST_HR = ['cadre', 'designation', 'supervisor_name', 'employment_basis', 'work_schedule', 'end_date', 'internship_months', 'salary_state'];
const hv = (v) => (v == null || v === '' ? null : String(v));
A['employee.save'] = async ({ db, c, who, body }) => {
  need(who, 'staff');
  const f = body.employee && typeof body.employee === 'object' ? body.employee : {};
  const name = str(f.name, 80);
  if (!name) throw bad('name_required', 'Enter the employee\'s full name.');
  const old = f.emp_id ? await one(db, `SELECT * FROM pr_employees WHERE client_id = ? AND emp_id = ?`, c, String(f.emp_id)) : null;
  if (f.emp_id && !old) throw bad('not_found', 'That employee was not found.', 404);
  const oldHr = old ? await one(db, `SELECT * FROM pr_emp_hr WHERE client_id = ? AND emp_id = ?`, c, old.emp_id) : null;
  // SALARY: a blank means "not entered yet" (never 0), 0 is a real salary (volunteers, interns, commission-only), omitted on an edit keeps what is stored.
  const hasPay = Object.prototype.hasOwnProperty.call(f, 'basic_pay');
  let basic, salaryState;
  if (hasPay && f.basic_pay !== '' && f.basic_pay != null) {
    const n = typeof f.basic_pay === 'number' ? f.basic_pay : (/^\s*-?\d+(\.\d+)?\s*$/.test(String(f.basic_pay)) ? Number(f.basic_pay) : NaN);
    if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) throw bad('bad_amount', 'Enter a valid salary / pay rate (0 or more).');
    basic = round2(n); salaryState = 'set';
  } else if (old && !hasPay) { basic = round2(old.basic_pay); salaryState = oldHr ? oldHr.salary_state : 'set'; }
  else { basic = 0; salaryState = 'unset'; }
  const freq = str(f.pay_frequency, 20) || (old ? old.pay_frequency : 'monthly');
  const unit = ['period', 'day', 'hour'].includes(f.rate_unit) ? f.rate_unit : (old && !f.pay_frequency ? old.rate_unit : (freq === 'daily' ? 'day' : 'period'));
  const status = EMP_STATUSES.includes(f.status) ? f.status : (old && !f.status ? old.status : 'active');
  const dob = f.dob ? (validDay(f.dob) ? f.dob : null) : null, start = f.start_date ? (validDay(f.start_date) ? f.start_date : null) : null;
  if (f.dob && !dob) throw bad('bad_date', 'Date of birth must be a valid date.');
  if (f.start_date && !start) throw bad('bad_date', 'Start date must be a valid date.');
  const posId = str(f.pos_staff_id, 80);
  if (posId) { const dup = await one(db, `SELECT emp_id FROM pr_employees WHERE client_id = ? AND pos_staff_id = ? AND emp_id <> ?`, c, posId, String(f.emp_id || '')); if (dup) throw bad('already_linked', 'That POS sign-in is already linked to another employee.'); }
  // EMPLOYMENT (cadre, supervisor, basis, schedule, end date): checked BEFORE anything is written, so a refused save changes nothing.
  const typeChanged = old && f.employment_type && String(f.employment_type) !== String(old.employment_type);
  const wantHr = !!(f.hr && typeof f.hr === 'object') || !old || typeChanged;
  const rawHr = f.hr && typeof f.hr === 'object' ? f.hr : (!old || typeChanged ? { employment_basis: undefined } : {});
  if (!old && !f.hr && f.employment_type) rawHr.employment_basis = /intern/i.test(f.employment_type) ? 'intern' : /contract/i.test(f.employment_type) ? 'contract' : 'permanent';
  const startEff = start || (old ? old.start_date : null);
  let hr = null;
  if (wantHr) hr = hrClean(rawHr, { start: startEff, oldHr, oldEmp: old, isNew: !old, bad, str });
  const leaving = LEAVER_STATUSES.has(status) && (!old || !LEAVER_STATUSES.has(old.status));
  const returning = old && LEAVER_STATUSES.has(old.status) && !LEAVER_STATUSES.has(status);
  if (old && (leaving || returning || (hr && oldHr && hr.end_date !== oldHr.end_date) || (oldHr && hr && hr.employment_basis !== oldHr.employment_basis)) && !can(who, 'settings')) throw bad('payroll_forbidden', 'ACCESS DENIED — changing a person\'s status, employment basis or end date needs the payroll "settings" right.', 403);
  const effDate = f.effective_date && validDay(f.effective_date) ? f.effective_date : null;
  if (f.effective_date && !effDate) throw bad('bad_date', 'Check the effective date.');
  const t = nowMs();
  const fields = { phone: str(f.phone, 30), email: str(f.email, 120), id_number: str(f.id_number, 40), dob, address: str(f.address, 200), emergency_name: str(f.emergency_name, 80), emergency_phone: str(f.emergency_phone, 30),
    job_title: str(f.job_title, 60), department: str(f.department, 60), branch_name: str(f.branch_name, 80), start_date: start, employment_type: (f.hr && f.hr.employment_basis && hr ? hr.employment_basis : null) || str(f.employment_type, 30) || (old ? old.employment_type : 'permanent'),
    pay_frequency: freq, rate_unit: unit, basic_pay: basic, pay_method: str(f.pay_method, 20), pay_account: str(f.pay_account, 60), status, pos_staff_id: posId };
  // a partial save (only some fields sent) keeps everything it did not mention — it never blanks a field by omission
  if (old) for (const k of ['phone', 'email', 'id_number', 'dob', 'address', 'emergency_name', 'emergency_phone', 'job_title', 'department', 'branch_name', 'pay_method', 'pay_account', 'pos_staff_id']) { if (!Object.prototype.hasOwnProperty.call(f, k)) fields[k] = old[k]; }
  const hrStmts = (empId, oldRow, who2) => {
    if (!hr && !leaving && !returning && oldRow && !(oldHr && oldHr.salary_state !== salaryState)) return [];
    const base = hr || (oldHr ? { cadre: oldHr.cadre, designation: oldHr.designation, supervisor_name: oldHr.supervisor_name, supervisor_emp_id: oldHr.supervisor_emp_id, employment_basis: oldHr.employment_basis, work_schedule: oldHr.work_schedule, end_date: oldHr.end_date, internship_months: oldHr.internship_months, branch_ids: oldHr.branch_ids, end_note: oldHr.end_note }
      : { cadre: null, designation: null, supervisor_name: null, supervisor_emp_id: null, employment_basis: /intern/i.test(oldRow ? oldRow.employment_type : '') ? 'intern' : /contract/i.test(oldRow ? oldRow.employment_type : '') ? 'contract' : 'permanent', work_schedule: 'full_time', end_date: null, internship_months: null, branch_ids: '[]', end_note: null });
    const deactAt = leaving ? t : (returning ? null : (oldHr ? oldHr.deactivated_at : null)), deactBy = leaving ? String(who2.sid) : (returning ? null : (oldHr ? oldHr.deactivated_by : null));
    return [db.prepare(`INSERT INTO pr_emp_hr (client_id, emp_id, cadre, designation, supervisor_emp_id, supervisor_name, employment_basis, work_schedule, end_date, internship_months, salary_state, salary_effective, branch_ids, end_note, deactivated_at, deactivated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(client_id, emp_id) DO UPDATE SET cadre=excluded.cadre, designation=excluded.designation, supervisor_emp_id=excluded.supervisor_emp_id, supervisor_name=excluded.supervisor_name, employment_basis=excluded.employment_basis, work_schedule=excluded.work_schedule, end_date=excluded.end_date, internship_months=excluded.internship_months, salary_state=excluded.salary_state, salary_effective=COALESCE(excluded.salary_effective, pr_emp_hr.salary_effective), branch_ids=excluded.branch_ids, end_note=excluded.end_note, deactivated_at=excluded.deactivated_at, deactivated_by=excluded.deactivated_by, updated_at=excluded.updated_at`)
      .bind(c, empId, base.cadre || null, base.designation || null, base.supervisor_emp_id || null, base.supervisor_name || null, base.employment_basis, base.work_schedule, base.end_date || null, base.internship_months == null ? null : base.internship_months, salaryState, f.salary_effective && validDay(f.salary_effective) ? f.salary_effective : null, base.branch_ids || '[]', base.end_note || null, deactAt, deactBy, t)];
  };
  const histStmts = (empId, oldRow, newRow, newHr) => {
    const out = [], when = effDate || localDay(t, 'Africa/Nairobi');
    const push = (field, o, n) => { if (hv(o) !== hv(n)) out.push(db.prepare(`INSERT INTO pr_emp_history (client_id, emp_id, at, effective_date, actor_id, actor_name, field, old_value, new_value) VALUES (?,?,?,?,?,?,?,?,?)`).bind(c, empId, t, when, String(who.sid), String(who.name || '').slice(0, 60), field, hv(o), hv(n))); };
    HIST_EMP.forEach((k) => push(k, oldRow ? oldRow[k] : null, newRow[k]));
    push('salary', oldRow ? (oldHr && oldHr.salary_state === 'unset' ? null : oldRow.basic_pay) : null, salaryState === 'unset' ? null : basic);
    if (newHr) HIST_HR.forEach((k) => push(k, oldHr ? oldHr[k] : (oldRow && k === 'employment_basis' ? (/intern/i.test(oldRow.employment_type) ? 'intern' : /contract/i.test(oldRow.employment_type) ? 'contract' : 'permanent') : null), k === 'salary_state' ? salaryState : newHr[k]));
    return out;
  };
  if (old) {
    const stmts = [db.prepare(`UPDATE pr_employees SET name=?, phone=?, email=?, id_number=?, dob=?, address=?, emergency_name=?, emergency_phone=?, job_title=?, department=?, branch_name=?, start_date=?, employment_type=?, pay_frequency=?, rate_unit=?, basic_pay=?, pay_method=?, pay_account=?, status=?, pos_staff_id=?, updated_at=? WHERE client_id=? AND emp_id=?`)
      .bind(name, fields.phone, fields.email, fields.id_number, fields.dob, fields.address, fields.emergency_name, fields.emergency_phone, fields.job_title, fields.department, fields.branch_name, fields.start_date == null && !f.start_date ? old.start_date : fields.start_date, fields.employment_type, fields.pay_frequency, fields.rate_unit, fields.basic_pay, fields.pay_method, fields.pay_account, fields.status, fields.pos_staff_id, t, c, old.emp_id)];
    if (round2(old.basic_pay) !== basic || old.pay_frequency !== freq || old.rate_unit !== unit) stmts.push(auditStmt(db, c, who, 'salary_changed', 'employee', old.emp_id, { name, from: { basic_pay: old.basic_pay, pay_frequency: old.pay_frequency, rate_unit: old.rate_unit }, to: { basic_pay: basic, pay_frequency: freq, rate_unit: unit } }));
    if (old.status !== status) stmts.push(auditStmt(db, c, who, 'employee_status_changed', 'employee', old.emp_id, { name, from: old.status, to: status }));
    stmts.push(auditStmt(db, c, who, 'employee_edited', 'employee', old.emp_id, { name }));
    stmts.push(...hrStmts(old.emp_id, old, who));
    stmts.push(...histStmts(old.emp_id, old, { ...old, ...fields, start_date: fields.start_date == null && !f.start_date ? old.start_date : fields.start_date }, hr));
    await db.batch(stmts);
    return { employee: await withHr(db, c, who, old.emp_id) };
  }
  const n = await nextSeq(db, c, 'emp');
  const empNo = str(f.emp_no, 20) || 'EMP-' + String(n).padStart(3, '0');
  const dupNo = await one(db, `SELECT emp_id FROM pr_employees WHERE client_id = ? AND emp_no = ?`, c, empNo);
  if (dupNo) throw bad('dup_emp_no', `Employee number ${empNo} is already used.`);
  const id = rid('E');
  await db.batch([
    db.prepare(`INSERT INTO pr_employees (client_id, emp_id, emp_no, name, phone, email, id_number, dob, address, emergency_name, emergency_phone, job_title, department, branch_id, branch_name, start_date, employment_type, pay_frequency, rate_unit, basic_pay, pay_method, pay_account, status, pos_staff_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(c, id, empNo, name, fields.phone, fields.email, fields.id_number, fields.dob, fields.address, fields.emergency_name, fields.emergency_phone, fields.job_title, fields.department, c, fields.branch_name, fields.start_date, fields.employment_type, fields.pay_frequency, fields.rate_unit, fields.basic_pay, fields.pay_method, fields.pay_account, fields.status, fields.pos_staff_id, String(who.sid), t, t),
    auditStmt(db, c, who, 'employee_created', 'employee', id, { name, emp_no: empNo, basic_pay: salaryState === 'unset' ? null : basic }),
    ...hrStmts(id, null, who),
    ...histStmts(id, null, { ...fields }, hr),
  ]);
  return { employee: await withHr(db, c, who, id) };
};
async function withHr(db, c, who, empId) {
  const e = await one(db, `SELECT * FROM pr_employees WHERE client_id = ? AND emp_id = ?`, c, empId);
  const o = shapeEmployee(e, who);
  const hr = await one(db, `SELECT * FROM pr_emp_hr WHERE client_id = ? AND emp_id = ?`, c, empId);
  const s = await hrSettings(db, c);
  o.hr = hr; o.salary_state = hr ? hr.salary_state : 'set';
  if (o.salary_state === 'unset' && o.basic_pay !== undefined) o.basic_pay = null;
  o.flags = employmentFlags(e, hr, localDay(Date.now(), s.tz), s.warn_days);
  return o;
}

// ---- recurring pay lines of an employee ----
A['payline.save'] = async ({ db, c, who, body }) => {
  need(who, 'staff');
  const e = await one(db, `SELECT emp_id, name FROM pr_employees WHERE client_id = ? AND emp_id = ?`, c, String(body.empId || ''));
  if (!e) throw bad('not_found', 'That employee was not found.', 404);
  const l = body.line || {};
  const kind = l.kind === 'deduction' ? 'deduction' : l.kind === 'earning' ? 'earning' : null;
  if (!kind) throw bad('bad_kind', 'Choose whether this is an earning or a deduction.');
  const label = str(l.label, 60); if (!label) throw bad('label_required', 'Give this line a name.');
  const calc = CALCS.includes(l.calc) ? l.calc : 'fixed';
  const amount = round2(num(l.amount)), rate = num(l.rate);
  if (amount < 0 || amount > MAX_MONEY || rate < 0 || rate > 100) throw bad('bad_amount', 'Enter a valid amount.');
  const balance = l.balance === '' || l.balance == null ? null : round2(num(l.balance));
  if (balance != null && (balance < 0 || balance > MAX_MONEY)) throw bad('bad_amount', 'Enter a valid balance.');
  const id = String(l.line_id || '') || rid('L');
  const t = nowMs();
  await db.batch([
    db.prepare(`INSERT INTO pr_pay_lines (client_id, emp_id, line_id, kind, type_id, label, calc, rate, amount, cfg, balance, active, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(client_id, emp_id, line_id) DO UPDATE SET kind=excluded.kind, type_id=excluded.type_id, label=excluded.label, calc=excluded.calc, rate=excluded.rate, amount=excluded.amount, cfg=excluded.cfg, balance=excluded.balance, active=excluded.active, updated_at=excluded.updated_at`)
      .bind(c, e.emp_id, id, kind, str(l.type_id, 60), label, calc, rate, amount, l.cfg ? JSON.stringify(cfgOf(l.cfg)) : null, balance, l.active === false || l.active === 0 ? 0 : 1, t),
    auditStmt(db, c, who, 'pay_line_saved', 'employee', e.emp_id, { name: e.name, kind, label, calc, amount, rate, balance }),
  ]);
  return { lineId: id };
};
A['payline.delete'] = async ({ db, c, who, body }) => {
  need(who, 'staff');
  const r = await db.prepare(`DELETE FROM pr_pay_lines WHERE client_id = ? AND emp_id = ? AND line_id = ?`).bind(c, String(body.empId || ''), String(body.lineId || '')).run();
  if (r.meta && r.meta.changes) await auditStmt(db, c, who, 'pay_line_deleted', 'employee', String(body.empId), { lineId: body.lineId }).run();
  return {};
};

// ---- earning / deduction types (settings) ----
A['types.list'] = async ({ db, c, who }) => {
  need(who, ...PERMS);
  let rows = await all(db, `SELECT * FROM pr_types WHERE client_id = ? ORDER BY kind, sort, label`, c);
  if (!rows.length) {                                              // first use: the common earning / deduction names (no amounts, applied to nobody)
    const t = nowMs();
    await db.batch(DEFAULT_TYPES.map(([kind, label], i) => db.prepare(`INSERT OR IGNORE INTO pr_types (client_id, type_id, kind, label, calc, rate, amount, cfg, statutory, auto_apply, active, sort, updated_at) VALUES (?,?,?,?, 'fixed', 0, 0, NULL, 0, 0, 1, ?, ?)`).bind(c, 'def_' + label.toLowerCase().replace(/[^a-z]+/g, '_'), kind, label, i, t)));
    rows = await all(db, `SELECT * FROM pr_types WHERE client_id = ? ORDER BY kind, sort, label`, c);
  }
  return { types: rows.map((r) => ({ ...r, cfg: cfgOf(r.cfg) })) };
};
A['type.save'] = async ({ db, c, who, body }) => {
  need(who, 'settings');
  const f = body.type || {};
  const kind = f.kind === 'deduction' ? 'deduction' : f.kind === 'earning' ? 'earning' : null;
  const label = str(f.label, 60);
  if (!kind || !label) throw bad('bad_type', 'Give the type a name and say whether it is an earning or a deduction.');
  const calc = CALCS.includes(f.calc) ? f.calc : 'fixed';
  const rate = num(f.rate), amount = round2(num(f.amount));
  if (rate < 0 || rate > 100 || amount < 0 || amount > MAX_MONEY) throw bad('bad_amount', 'Enter a valid rate or amount.');
  const id = String(f.type_id || '') || rid('T');
  const cfg = cfgOf(f.cfg);
  if (calc === 'bands') {
    const b = Array.isArray(cfg.bands) ? cfg.bands : [];
    if (!b.length || b.some((x) => num(x.rate) < 0 || num(x.rate) > 100)) throw bad('bad_bands', 'Add the tax bands (upper limit and rate for each).');
  }
  const t = nowMs();
  await db.batch([
    db.prepare(`INSERT INTO pr_types (client_id, type_id, kind, label, calc, rate, amount, cfg, statutory, auto_apply, active, sort, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(client_id, type_id) DO UPDATE SET kind=excluded.kind, label=excluded.label, calc=excluded.calc, rate=excluded.rate, amount=excluded.amount, cfg=excluded.cfg, statutory=excluded.statutory, auto_apply=excluded.auto_apply, active=excluded.active, updated_at=excluded.updated_at`)
      .bind(c, id, kind, label, calc, rate, amount, JSON.stringify(cfg), f.statutory ? 1 : 0, f.auto_apply ? 1 : 0, f.active === false || f.active === 0 ? 0 : 1, num(f.sort), t),
    auditStmt(db, c, who, 'payroll_type_saved', 'type', id, { kind, label, calc, rate, amount, auto_apply: !!f.auto_apply, active: !(f.active === false || f.active === 0) }),
  ]);
  return { typeId: id };
};
A['types.template'] = async ({ db, c, who }) => {
  need(who, 'settings');
  const t = nowMs();
  await db.batch(STATUTORY_TEMPLATE.map((x, i) => db.prepare(`INSERT OR IGNORE INTO pr_types (client_id, type_id, kind, label, calc, rate, amount, cfg, statutory, auto_apply, active, sort, updated_at) VALUES (?,?, 'deduction', ?,?,?, 0, ?, 1, 0, 0, ?, ?)`)
    .bind(c, x.type_id, x.label, x.calc, x.rate, JSON.stringify(x.cfg), 100 + i, t)).concat([auditStmt(db, c, who, 'statutory_template_added', 'type', null, 'switched off until reviewed')]));
  return {};
};

// ---- access ----
A['access.get'] = async ({ db, c, who }) => {
  need(who, 'settings');
  return { access: (await all(db, `SELECT staff_id, staff_name, perms FROM pr_access WHERE client_id = ?`, c)).map((r) => ({ staff_id: r.staff_id, staff_name: r.staff_name, perms: (() => { try { return JSON.parse(r.perms); } catch (e) { return []; } })() })) };
};
A['access.save'] = async ({ db, c, who, body }) => {
  if (!who.admin) throw bad('payroll_forbidden', 'ACCESS DENIED — only the Admin can give or take away payroll access.', 403);
  const sid = String(body.staffId || '').slice(0, 80);
  if (!sid || sid === 'admin') throw bad('bad_staff', 'Pick a staff member.');
  const perms = (Array.isArray(body.perms) ? body.perms : []).filter((p) => PERMS.includes(p));
  const t = nowMs();
  if (!perms.length) await db.batch([db.prepare(`DELETE FROM pr_access WHERE client_id = ? AND staff_id = ?`).bind(c, sid), auditStmt(db, c, who, 'access_removed', 'staff', sid, null)]);
  else await db.batch([db.prepare(`INSERT INTO pr_access (client_id, staff_id, staff_name, perms, updated_by, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(client_id, staff_id) DO UPDATE SET staff_name=excluded.staff_name, perms=excluded.perms, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .bind(c, sid, str(body.staffName, 60), JSON.stringify(perms), String(who.sid), t), auditStmt(db, c, who, 'access_granted', 'staff', sid, { name: body.staffName, perms })]);
  return {};
};

// ---- documents ----
const DOC_TYPES = { 'application/pdf': 'pdf' };
// Staff documents are PDF only (zip 328). The type is decided by the CONTENT, never by the file name or the declared type: the bytes must start with %PDF-,
// end like a PDF, and contain none of the active-content markers (JavaScript, auto-launch, embedded files) that make a PDF more than a document.
const PDF_ACTIVE = [/\/JavaScript\b/, /\/JS\s*[(<\/]/, /\/Launch\b/, /\/EmbeddedFile\b/, /\/OpenAction\b/, /\/AA\s*<</, /\/RichMedia\b/, /\/XFA\b/];
function decodeDoc(dataUrl, maxBytes = DOC_MAX_BYTES) {
  const mb = Math.round(maxBytes / 1024 / 1024 * 10) / 10;
  const m = /^data:([a-z0-9.+\/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw bad('bad_file', 'Upload a PDF file. Photos and Word files are not accepted — save or scan the document as a PDF.');
  if (m[1] !== 'application/pdf') throw bad('bad_file', 'Only PDF files are accepted. Save or scan the document as a PDF and upload that.');
  if (m[2].length > maxBytes * 1.4) throw bad('file_too_big', 'That file is too large — the limit is ' + mb + ' MB. Compress the PDF.', 413);
  let bin; try { bin = atob(m[2]); } catch (e) { throw bad('bad_file', 'That file could not be read.'); }
  if (bin.length > maxBytes) throw bad('file_too_big', 'That file is too large — the limit is ' + mb + ' MB. Compress the PDF.', 413);
  if (bin.length < 20) throw bad('bad_file', 'That PDF is empty.');
  if (!bin.startsWith('%PDF-')) throw bad('bad_file', 'That file does not look like a real PDF.');
  if (!/%%EOF\s*$/.test(bin.slice(-1024))) throw bad('bad_file', 'That PDF is incomplete or damaged (no end marker).');
  if (PDF_ACTIVE.some((re) => re.test(bin))) throw bad('unsafe_pdf', 'That PDF contains scripts or embedded files, so it was not accepted. Re-save it as a plain PDF (print to PDF) and upload that.');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, type: 'application/pdf' };
}
A['doc.list'] = async ({ db, c, who, body }) => {
  need(who, 'staff');
  const rows = await all(db, `SELECT doc_id, emp_id, title, category, file_name, mime, size, doc_date, expiry_date, status, uploaded_by, created_at FROM pr_documents WHERE client_id = ? AND emp_id = ? ORDER BY status, created_at DESC`, c, String(body.empId || ''));
  return { documents: rows };
};
A['doc.upload'] = async ({ db, c, env, who, body }) => {
  need(who, 'staff');
  const e = await one(db, `SELECT emp_id, name FROM pr_employees WHERE client_id = ? AND emp_id = ?`, c, String(body.empId || ''));
  if (!e) throw bad('not_found', 'That employee was not found.', 404);
  const title = str(body.title, 80); if (!title) throw bad('title_required', 'Name the document (for example "National ID copy").');
  const category = DOC_CATEGORIES.includes(body.category) ? body.category : 'other';
  const doc = body.docDate ? (validDay(body.docDate) ? body.docDate : null) : null, exp = body.expiryDate ? (validDay(body.expiryDate) ? body.expiryDate : null) : null;
  if ((body.docDate && !doc) || (body.expiryDate && !exp)) throw bad('bad_date', 'Check the document / expiry date.');
  const f = decodeDoc(body.dataUrl, (await hrSettings(db, c)).doc_max_mb * 1024 * 1024);
  const id = rid('D'), key = mediaKey(c, 'staffdoc', id), t = nowMs();
  await mediaPut(env, key, f.bytes, f.type, { emp: e.emp_id });
  try {
    await db.batch([db.prepare(`INSERT INTO pr_documents (client_id, doc_id, emp_id, title, category, file_name, mime, size, storage_key, doc_date, expiry_date, status, uploaded_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'active', ?,?,?)`)
      .bind(c, id, e.emp_id, title, category, str(body.fileName, 120), f.type, f.bytes.length, key, doc, exp, String(who.sid), t, t), auditStmt(db, c, who, 'document_uploaded', 'document', id, { employee: e.name, title, category })]);
  } catch (err) { await mediaDelete(env, key).catch(() => {}); throw err; }
  return { docId: id };
};
A['doc.replace'] = async ({ db, c, env, who, body }) => {
  need(who, 'staff');
  const d = await one(db, `SELECT * FROM pr_documents WHERE client_id = ? AND doc_id = ?`, c, String(body.docId || ''));
  if (!d) throw bad('not_found', 'That document was not found.', 404);
  const f = decodeDoc(body.dataUrl, (await hrSettings(db, c)).doc_max_mb * 1024 * 1024);
  const key = mediaKey(c, 'staffdoc', rid('D')), t = nowMs();
  await mediaPut(env, key, f.bytes, f.type, { emp: d.emp_id });
  await db.batch([db.prepare(`UPDATE pr_documents SET storage_key=?, mime=?, size=?, file_name=?, title=COALESCE(?, title), doc_date=COALESCE(?, doc_date), expiry_date=?, status='active', updated_at=? WHERE client_id=? AND doc_id=?`)
    .bind(key, f.type, f.bytes.length, str(body.fileName, 120), str(body.title, 80), validDay(body.docDate) ? body.docDate : null, validDay(body.expiryDate) ? body.expiryDate : d.expiry_date, t, c, d.doc_id), auditStmt(db, c, who, 'document_replaced', 'document', d.doc_id, { title: d.title })]);
  if (d.storage_key) await mediaDelete(env, d.storage_key).catch(() => {});
  return {};
};
A['doc.update'] = async ({ db, c, who, body }) => {      // zip 330: edit a document's details (name, kind, dates) without re-uploading the file
  need(who, 'staff');
  const d = await one(db, `SELECT * FROM pr_documents WHERE client_id = ? AND doc_id = ?`, c, String(body.docId || ''));
  if (!d) throw bad('not_found', 'That document was not found.', 404);
  const title = body.title === undefined ? d.title : str(body.title, 80);
  if (!title) throw bad('title_required', 'Name the document (for example "National ID copy").');
  const category = body.category === undefined ? d.category : (DOC_CATEGORIES.includes(body.category) ? body.category : 'other');
  const day = (v, old) => (v === undefined ? old : (v === '' || v == null ? null : (validDay(v) ? v : false)));
  const doc = day(body.docDate, d.doc_date), exp = day(body.expiryDate, d.expiry_date);
  if (doc === false || exp === false) throw bad('bad_date', 'Check the document / expiry date.');
  await db.batch([
    db.prepare(`UPDATE pr_documents SET title = ?, category = ?, doc_date = ?, expiry_date = ?, updated_at = ? WHERE client_id = ? AND doc_id = ?`).bind(title, category, doc, exp, nowMs(), c, d.doc_id),
    auditStmt(db, c, who, 'document_edited', 'document', d.doc_id, { employee: d.emp_id, title, category, doc_date: doc, expiry_date: exp }),
  ]);
  return {};
};
A['doc.archive'] = async ({ db, c, who, body }) => {
  need(who, 'staff');
  const arch = body.archive !== false;
  const r = await db.prepare(`UPDATE pr_documents SET status = ?, updated_at = ? WHERE client_id = ? AND doc_id = ?`).bind(arch ? 'archived' : 'active', nowMs(), c, String(body.docId || '')).run();
  if (!(r.meta && r.meta.changes)) throw bad('not_found', 'That document was not found.', 404);
  await auditStmt(db, c, who, arch ? 'document_archived' : 'document_restored', 'document', String(body.docId), null).run();
  return {};
};
A['doc.delete'] = async ({ db, c, env, who, body }) => {
  need(who, 'staff');
  const d = await one(db, `SELECT * FROM pr_documents WHERE client_id = ? AND doc_id = ?`, c, String(body.docId || ''));
  if (!d) throw bad('not_found', 'That document was not found.', 404);
  await db.batch([db.prepare(`DELETE FROM pr_documents WHERE client_id = ? AND doc_id = ?`).bind(c, d.doc_id), auditStmt(db, c, who, 'document_deleted', 'document', d.doc_id, { title: d.title })]);
  if (d.storage_key) await mediaDelete(env, d.storage_key).catch(() => {});
  return {};
};
// -> a Response with the file (handled by the route, which knows how to stream it)
export async function docFile({ db, c, env, who, body }) {
  need(who, 'staff');
  const d = await one(db, `SELECT * FROM pr_documents WHERE client_id = ? AND doc_id = ?`, c, String(body.docId || ''));
  if (!d || !d.storage_key) throw bad('not_found', 'That document was not found.', 404);
  const f = await mediaGet(env, d.storage_key);
  if (!f) throw bad('not_found', 'The stored file could not be found.', 404);
  await auditStmt(db, c, who, 'document_viewed', 'document', d.doc_id, { title: d.title }).run();
  return { bytes: f.bytes, type: d.mime || f.type, name: d.file_name || (d.title + '.' + (DOC_TYPES[d.mime] || 'bin')) };
}

// ---- runs ----
const stepOf = (run) => ({ draft: 0, reviewed: 1, approved: 2, paid: 3 })[run.status];
async function getRun(db, c, runId) {
  const r = await one(db, `SELECT * FROM pr_runs WHERE client_id = ? AND run_id = ?`, c, String(runId || ''));
  if (!r) throw bad('not_found', 'That payroll run was not found.', 404);
  return r;
}
async function linesFor(db, c, runId, empId) {
  return all(db, `SELECT line_no, kind, type_id, pay_line_id, label, calc, rate, cfg, amount, manual, note FROM pr_item_lines WHERE client_id = ? AND run_id = ? AND emp_id = ? ORDER BY line_no`, c, runId, empId);
}
const totalsStmt = (db, c, runId, t) => db.prepare(`UPDATE pr_runs SET
  total_basic = COALESCE((SELECT SUM(basic) FROM pr_items WHERE client_id = ? AND run_id = ?), 0),
  total_additions = COALESCE((SELECT SUM(additions) FROM pr_items WHERE client_id = ? AND run_id = ?), 0),
  total_deductions = COALESCE((SELECT SUM(deductions) FROM pr_items WHERE client_id = ? AND run_id = ?), 0),
  total_net = COALESCE((SELECT SUM(net) FROM pr_items WHERE client_id = ? AND run_id = ?), 0),
  employee_count = (SELECT COUNT(*) FROM pr_items WHERE client_id = ? AND run_id = ?), updated_at = ? WHERE client_id = ? AND run_id = ?`)
  .bind(c, runId, c, runId, c, runId, c, runId, c, runId, t, c, runId);

// Build one employee's item for a new run: their recurring lines + the types the owner switched on for everyone. Returns statements.
async function buildItem(db, c, run, e, slipNo, types, t) {
  const adj = run.kind === 'adjustment';
  const own = adj ? [] : await all(db, `SELECT * FROM pr_pay_lines WHERE client_id = ? AND emp_id = ? AND active = 1 ORDER BY kind, label`, c, e.emp_id);
  const meta = adj ? new Map() : await lineMetaMap(db, c, e.emp_id);
  const lines = [];
  for (const l of own) {
    if (!lineApplies(meta.get(l.line_id), run.period_start, run.period_end).ok) continue;     // not approved / not yet effective / already ended / another period
    let amt = num(l.amount);
    if (l.balance != null && l.calc === 'fixed') amt = Math.min(amt, num(l.balance));      // a loan never takes more than what is still owed
    lines.push({ kind: l.kind, type_id: l.type_id, pay_line_id: l.line_id, label: l.label, calc: l.calc, rate: l.rate, cfg: l.cfg, amount: amt, manual: 0 });
  }
  if (!adj) for (const ty of types) {
    if (!ty.auto_apply || !ty.active || lines.some((x) => x.type_id === ty.type_id)) continue;
    lines.push({ kind: ty.kind, type_id: ty.type_id, pay_line_id: null, label: ty.label, calc: ty.calc, rate: ty.rate, cfg: ty.cfg, amount: ty.amount, manual: 0 });
  }
  const units = adj ? 1 : (e.rate_unit === 'period' ? 1 : 0);
  const calc = calcItem({ rate: e.basic_pay, rate_unit: e.rate_unit, units }, lines, { adjustment: adj });
  const st = [db.prepare(`INSERT INTO pr_items (client_id, run_id, emp_id, payslip_no, emp_no, emp_name, job_title, department, branch_name, rate_unit, rate, units, basic, additions, deductions, net, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
    .bind(c, run.run_id, e.emp_id, slipNo, e.emp_no, e.name, e.job_title, e.department, e.branch_name, adj ? 'period' : e.rate_unit, adj ? 0 : e.basic_pay, units, calc.basic, calc.additions, calc.deductions, calc.net)];
  calc.lines.forEach((l, i) => st.push(db.prepare(`INSERT INTO pr_item_lines (client_id, run_id, emp_id, line_no, kind, type_id, pay_line_id, label, calc, rate, cfg, amount, manual, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
    .bind(c, run.run_id, e.emp_id, i + 1, l.kind, l.type_id || null, l.pay_line_id || null, l.label, l.calc, num(l.rate), l.cfg ? (typeof l.cfg === 'string' ? l.cfg : JSON.stringify(l.cfg)) : null, l.amount, l.manual ? 1 : 0)));
  return st;
}
const typesOf = async (db, c) => (await all(db, `SELECT * FROM pr_types WHERE client_id = ?`, c)).map((r) => ({ ...r, cfg: r.cfg }));

A['run.list'] = async ({ db, c, who }) => {
  need(who, 'view', 'run', 'approve');
  return { runs: await all(db, `SELECT run_id, ref, kind, adjusts_run_id, label, frequency, period_start, period_end, status, total_basic, total_additions, total_deductions, total_net, employee_count, created_by, created_at, approved_by, approved_at, paid_at, pay_date, pay_method FROM pr_runs WHERE client_id = ? ORDER BY period_start DESC, created_at DESC LIMIT 200`, c) };
};
A['run.get'] = async ({ db, c, who, body }) => {
  need(who, 'view', 'run', 'approve');
  const run = await getRun(db, c, body.runId);
  const items = await all(db, `SELECT * FROM pr_items WHERE client_id = ? AND run_id = ? ORDER BY payslip_no`, c, run.run_id);
  const lines = await all(db, `SELECT emp_id, line_no, kind, type_id, pay_line_id, label, calc, rate, cfg, amount, manual, note FROM pr_item_lines WHERE client_id = ? AND run_id = ? ORDER BY emp_id, line_no`, c, run.run_id);
  const by = {}; lines.forEach((l) => { (by[l.emp_id] ||= []).push(l); });
  return { run, items: items.map((i) => ({ ...i, lines: by[i.emp_id] || [] })) };
};

A['run.create'] = async ({ db, c, who, body }) => {
  need(who, 'run');
  const frequency = str(body.frequency, 20) || 'monthly';
  if (!validDay(body.periodStart) || !validDay(body.periodEnd) || body.periodEnd < body.periodStart) throw bad('bad_period', 'Choose the pay period (start and end dates).');
  const picked = Array.isArray(body.empIds) && body.empIds.length ? [...new Set(body.empIds.map(String))].slice(0, 500) : null;
  if (!picked) {
    const dup = await one(db, `SELECT ref FROM pr_runs WHERE client_id = ? AND kind = 'regular' AND frequency = ? AND period_start = ? AND period_end = ?`, c, frequency, body.periodStart, body.periodEnd);
    if (dup) throw bad('period_exists', `A ${frequency} payroll for this period already exists (${dup.ref}). Open it instead of starting another.`, 409);
  } else {
    // zip 332 (bulk payroll): ticked people may be paid in a second batch for the same period - but nobody twice
    const twice = await all(db, `SELECT DISTINCT i.emp_name, r.ref FROM pr_items i JOIN pr_runs r ON r.client_id = i.client_id AND r.run_id = i.run_id WHERE i.client_id = ? AND r.kind = 'regular' AND r.frequency = ? AND r.period_start = ? AND r.period_end = ? AND i.emp_id IN (${picked.map(() => '?').join(',')})`, c, frequency, body.periodStart, body.periodEnd, ...picked);
    if (twice.length) throw bad('already_in_period', `Already in a payroll for this period: ${twice.slice(0, 5).map((x) => `${x.emp_name} (${x.ref})`).join(', ')}${twice.length > 5 ? '…' : ''}. Untick them or open that payroll.`, 409);
  }
  let emps = await all(db, `SELECT * FROM pr_employees WHERE client_id = ? AND status = 'active' AND pay_frequency = ? ORDER BY name COLLATE NOCASE`, c, frequency);
  if (picked) { const set = new Set(picked); emps = emps.filter((e) => set.has(e.emp_id)); }
  // a person whose salary has not been entered is left out (never paid 0 by accident); the screen is told who and why
  const hrRows = await all(db, `SELECT emp_id, salary_state, end_date, employment_basis FROM pr_emp_hr WHERE client_id = ?`, c);
  const hrBy = new Map(hrRows.map((r) => [r.emp_id, r]));
  const warnings = [];
  emps = emps.filter((e) => { const h = hrBy.get(e.emp_id); if (h && h.salary_state === 'unset') { warnings.push(`${e.name}: salary not entered — left out`); return false; } if (h && h.end_date && h.end_date < body.periodStart && h.employment_basis !== 'permanent') warnings.push(`${e.name}: ${h.employment_basis} ended ${h.end_date} — still active, check before paying`); return true; });
  if (!emps.length) throw bad('no_employees', `There are no active ${frequency} employees to pay (with a salary entered). Add staff (with this pay frequency) first.`);
  const n = await nextSeq(db, c, 'run'), ym = body.periodStart.slice(0, 7).replace('-', '');
  const ref = `PR-${ym}-${String(n).padStart(3, '0')}`, id = rid('R'), t = nowMs();
  const label = str(body.label, 60) || new Date(body.periodStart + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) + ' payroll';
  const run = { run_id: id, kind: 'regular', period_start: body.periodStart, period_end: body.periodEnd };
  const types = await typesOf(db, c);
  const stmts = [db.prepare(`INSERT INTO pr_runs (client_id, run_id, ref, kind, label, frequency, period_start, period_end, branch_id, status, created_by, created_at, updated_at) VALUES (?,?,?, 'regular', ?,?,?,?,?, 'draft', ?,?,?)`).bind(c, id, ref, label, frequency, body.periodStart, body.periodEnd, c, String(who.sid), t, t)];
  for (let i = 0; i < emps.length; i++) stmts.push(...await buildItem(db, c, run, emps[i], `${ref}-${String(i + 1).padStart(3, '0')}`, types, t));
  stmts.push(totalsStmt(db, c, id, t), auditStmt(db, c, who, 'payroll_run_created', 'run', id, { ref, label, employees: emps.length }));
  await db.batch(stmts);
  return { runId: id, ref, warnings };
};

A['run.addEmployee'] = async ({ db, c, who, body }) => {
  need(who, 'run');
  const run = await getRun(db, c, body.runId);
  if (run.status !== 'draft') throw bad('run_not_draft', 'Only a draft payroll can be changed.', 409);
  const e = await one(db, `SELECT * FROM pr_employees WHERE client_id = ? AND emp_id = ?`, c, String(body.empId || ''));
  if (!e) throw bad('not_found', 'That employee was not found.', 404);
  if (run.kind === 'regular' && e.status !== 'active') throw bad('not_active', 'Only active employees can be paid.');
  if (await one(db, `SELECT 1 x FROM pr_items WHERE client_id = ? AND run_id = ? AND emp_id = ?`, c, run.run_id, e.emp_id)) throw bad('already_in', 'That employee is already in this payroll.');
  const count = (await one(db, `SELECT COUNT(*) n FROM pr_items WHERE client_id = ? AND run_id = ?`, c, run.run_id)).n;
  const slip = `${run.ref}-${String(count + 1).padStart(3, '0')}${Math.random().toString(36).slice(2, 4)}`;
  const t = nowMs();
  await db.batch([...await buildItem(db, c, run, e, slip, await typesOf(db, c), t), totalsStmt(db, c, run.run_id, t), auditStmt(db, c, who, 'payroll_employee_added', 'run', run.run_id, { employee: e.name })]);
  return {};
};
A['run.removeEmployee'] = async ({ db, c, who, body }) => {
  need(who, 'run');
  const run = await getRun(db, c, body.runId);
  if (run.status !== 'draft') throw bad('run_not_draft', 'Only a draft payroll can be changed.', 409);
  const t = nowMs();
  await db.batch([db.prepare(`DELETE FROM pr_item_lines WHERE client_id = ? AND run_id = ? AND emp_id = ?`).bind(c, run.run_id, String(body.empId)), db.prepare(`DELETE FROM pr_items WHERE client_id = ? AND run_id = ? AND emp_id = ?`).bind(c, run.run_id, String(body.empId)), totalsStmt(db, c, run.run_id, t), auditStmt(db, c, who, 'payroll_employee_removed', 'run', run.run_id, { empId: body.empId })]);
  return {};
};

// Edit ONE employee's item in a draft: days / hours worked, a note, and the lines. The server recalculates everything.
A['item.save'] = async ({ db, c, who, body }) => {
  need(who, 'run');
  const run = await getRun(db, c, body.runId);
  if (run.status !== 'draft') throw bad('run_not_draft', 'This payroll is locked. Send it back to draft first — or, if it is already approved, use an adjustment.', 409);
  const it = await one(db, `SELECT * FROM pr_items WHERE client_id = ? AND run_id = ? AND emp_id = ?`, c, run.run_id, String(body.empId || ''));
  if (!it) throw bad('not_found', 'That employee is not in this payroll.', 404);
  const adj = run.kind === 'adjustment';
  let units = it.units;
  if (body.units !== undefined && !adj) { units = num(body.units, NaN); if (!(units >= 0 && units <= 400)) throw bad('bad_units', 'Enter a valid number of days / hours.'); }
  const list = Array.isArray(body.lines) ? body.lines : null;
  let lines;
  if (list) {
    if (list.length > 60) throw bad('too_many', 'Too many lines.');
    lines = list.map((l) => {
      const kind = l.kind === 'deduction' ? 'deduction' : l.kind === 'earning' ? 'earning' : null;
      const label = str(l.label, 60);
      if (!kind || !label) throw bad('bad_line', 'Each line needs a name and must be an earning or a deduction.');
      const calc = CALCS.includes(l.calc) ? l.calc : 'fixed';
      const amount = round2(num(l.amount)), rate = num(l.rate);
      if (amount < 0 || amount > MAX_MONEY || rate < 0 || rate > 100) throw bad('bad_amount', 'Amounts cannot be negative — use a deduction instead.');
      return { kind, type_id: str(l.type_id, 60), pay_line_id: str(l.pay_line_id, 60), label, calc, rate, cfg: l.cfg ? (typeof l.cfg === 'string' ? l.cfg : JSON.stringify(l.cfg)) : null, amount, manual: l.manual || calc === 'fixed' ? 1 : 0, note: str(l.note, 120) };
    });
  } else lines = (await linesFor(db, c, run.run_id, it.emp_id)).map((l) => ({ ...l }));
  const calc = calcItem({ rate: it.rate, rate_unit: it.rate_unit, units }, lines, { adjustment: adj });
  const t = nowMs();
  const st = [db.prepare(`DELETE FROM pr_item_lines WHERE client_id = ? AND run_id = ? AND emp_id = ?`).bind(c, run.run_id, it.emp_id)];
  calc.lines.forEach((l, i) => st.push(db.prepare(`INSERT INTO pr_item_lines (client_id, run_id, emp_id, line_no, kind, type_id, pay_line_id, label, calc, rate, cfg, amount, manual, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(c, run.run_id, it.emp_id, i + 1, l.kind, l.type_id || null, l.pay_line_id || null, l.label, l.calc, num(l.rate), l.cfg || null, l.amount, l.manual ? 1 : 0, l.note || null)));
  st.push(db.prepare(`UPDATE pr_items SET units = ?, basic = ?, additions = ?, deductions = ?, net = ?, note = COALESCE(?, note) WHERE client_id = ? AND run_id = ? AND emp_id = ?`).bind(units, calc.basic, calc.additions, calc.deductions, calc.net, body.note === undefined ? null : (str(body.note, 200) || ''), c, run.run_id, it.emp_id));
  st.push(totalsStmt(db, c, run.run_id, t), auditStmt(db, c, who, 'payroll_edited', 'run', run.run_id, { employee: it.emp_name, units, net: calc.net }));
  await db.batch(st);
  return { item: { basic: calc.basic, additions: calc.additions, deductions: calc.deductions, net: calc.net, units, lines: calc.lines } };
};

// Moves a run one step, ONLY from the step the caller expects (the conditional UPDATE is the lock).
async function transition(db, c, who, run, from, to, extraSql, extraArgs, action, detail) {
  const t = nowMs();
  const res = await db.batch([
    db.prepare(`UPDATE pr_runs SET status = ?, updated_at = ?${extraSql} WHERE client_id = ? AND run_id = ? AND status = ?`).bind(to, t, ...extraArgs, c, run.run_id, from),
  ]);
  const changed = res[0] && res[0].meta && res[0].meta.changes;
  if (!changed) { const now = await getRun(db, c, run.run_id); if (now.status === to) return { already: true, run: now }; throw bad('wrong_state', `This payroll is now ${now.status} — refresh and check.`, 409); }
  await auditStmt(db, c, who, action, 'run', run.run_id, detail).run();
  return { already: false, run: await getRun(db, c, run.run_id) };
}

A['run.review'] = async ({ db, c, who, body }) => {
  need(who, 'run');
  const run = await getRun(db, c, body.runId);
  if (run.status === 'reviewed') return { run };
  if (run.status !== 'draft') throw bad('wrong_state', `This payroll is ${run.status}.`, 409);
  const items = await all(db, `SELECT emp_name, net, rate_unit, units FROM pr_items WHERE client_id = ? AND run_id = ?`, c, run.run_id);
  if (!items.length) throw bad('empty_run', 'This payroll has nobody in it.');
  const problems = [];
  for (const i of items) {
    if (run.kind === 'regular' && i.net < 0) problems.push(`${i.emp_name}: deductions are more than the pay (net ${i.net}).`);
    if (run.kind === 'regular' && i.rate_unit !== 'period' && !(i.units > 0)) problems.push(`${i.emp_name}: enter the ${i.rate_unit === 'day' ? 'days' : 'hours'} worked.`);
  }
  if (problems.length) throw Object.assign(bad('needs_fixing', 'Fix these before reviewing: ' + problems.join(' '), 422), { problems });
  return transition(db, c, who, run, 'draft', 'reviewed', ', reviewed_by = ?, reviewed_at = ?', [String(who.sid), nowMs()], 'payroll_reviewed', { ref: run.ref });
};
A['run.reopen'] = async ({ db, c, who, body }) => {
  need(who, 'run');
  const run = await getRun(db, c, body.runId);
  if (run.status === 'draft') return { run };
  if (run.status !== 'reviewed') throw bad('payroll_final', `This payroll is ${run.status} and can no longer be edited. To correct it, create an adjustment.`, 409);
  return transition(db, c, who, run, 'reviewed', 'draft', '', [], 'payroll_reopened', { ref: run.ref });
};
A['run.approve'] = async ({ db, c, who, body }) => {
  need(who, 'approve');
  const run = await getRun(db, c, body.runId);
  if (run.status === 'approved' || run.status === 'paid') return { run, already: true };
  if (run.status !== 'reviewed') throw bad('wrong_state', 'Review the payroll first, then approve it.', 409);
  return transition(db, c, who, run, 'reviewed', 'approved', ', approved_by = ?, approved_at = ?', [String(who.sid), nowMs()], 'payroll_approved', { ref: run.ref, net: run.total_net });
};
A['run.pay'] = async ({ db, c, who, body, env }) => {
  need(who, 'approve');
  const run = await getRun(db, c, body.runId);
  if (run.status === 'paid') return { run, already: true };
  if (run.status !== 'approved') throw bad('wrong_state', 'Approve the payroll before marking it paid.', 409);
  const method = PAY_METHODS.includes(body.method) ? body.method : null;
  if (!method) throw bad('method_required', 'Choose how the staff were paid (cash, M-Pesa, bank ...).');
  const payDate = validDay(body.payDate) ? body.payDate : new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  const t = nowMs();
  const items = await all(db, `SELECT l.pay_line_id, l.amount, i.emp_id FROM pr_item_lines l JOIN pr_items i ON i.client_id = l.client_id AND i.run_id = l.run_id AND i.emp_id = l.emp_id WHERE l.client_id = ? AND l.run_id = ? AND l.pay_line_id IS NOT NULL AND l.kind = 'deduction'`, c, run.run_id);
  await ensureLedgerSchema(db);
  const stmts = [db.prepare(`UPDATE pr_runs SET status = 'paid', paid_by = ?, paid_at = ?, pay_date = ?, pay_method = ?, pay_reference = ?, updated_at = ? WHERE client_id = ? AND run_id = ? AND status = 'approved'`)
    .bind(String(who.sid), t, payDate, method, str(body.reference, 80), t, c, run.run_id)];
  for (const l of items) stmts.push(db.prepare(`UPDATE pr_pay_lines SET balance = MAX(0, balance - ?), active = CASE WHEN balance - ? <= 0.005 THEN 0 ELSE active END, updated_at = ? WHERE client_id = ? AND emp_id = ? AND line_id = ? AND balance IS NOT NULL`).bind(l.amount, l.amount, t, c, l.emp_id, l.pay_line_id));
  stmts.push(db.prepare(`INSERT INTO ledger_records (client_id, kind, rec_id, version, ts, business_date, amount, status, actor, source, data, created_at, updated_at) VALUES (?, 'payroll_run', ?, 1, ?, ?, ?, 'PAID', ?, 'tengeneza-payroll', ?, ?, ?) ON CONFLICT(client_id, kind, rec_id) DO NOTHING`)
    .bind(c, run.run_id, t, payDate, run.total_net, String(who.name || who.sid).slice(0, 60), JSON.stringify({ ref: run.ref, label: run.label, period: [run.period_start, run.period_end], employees: run.employee_count, basic: run.total_basic, additions: run.total_additions, deductions: run.total_deductions, net: run.total_net, method, reference: str(body.reference, 80), payDate }), t, t));
  stmts.push(auditStmt(db, c, who, 'payroll_paid', 'run', run.run_id, { ref: run.ref, net: run.total_net, method, payDate }));
  const res = await db.batch(stmts);
  if (!(res[0].meta && res[0].meta.changes)) throw bad('wrong_state', 'This payroll was just changed by someone else — refresh.', 409);
  return { run: await getRun(db, c, run.run_id) };
};
A['run.delete'] = async ({ db, c, who, body }) => {
  need(who, 'run');
  const run = await getRun(db, c, body.runId);
  if (run.status !== 'draft') throw bad('payroll_final', 'Only a draft payroll can be deleted. A reviewed, approved or paid payroll stays on record.', 409);
  await db.batch([db.prepare(`DELETE FROM pr_item_lines WHERE client_id = ? AND run_id = ?`).bind(c, run.run_id), db.prepare(`DELETE FROM pr_items WHERE client_id = ? AND run_id = ?`).bind(c, run.run_id), db.prepare(`DELETE FROM pr_runs WHERE client_id = ? AND run_id = ? AND status = 'draft'`).bind(c, run.run_id), auditStmt(db, c, who, 'payroll_draft_deleted', 'run', run.run_id, { ref: run.ref })]);
  return {};
};

// A correction to a finished payroll: a NEW run that points at the old one. 'reverse' = every pay and deduction turned round (net = minus the original);
// 'blank' = the chosen people, empty, for the lines the owner types in (an underpayment, a forgotten bonus ...).
A['run.adjust'] = async ({ db, c, who, body }) => {
  need(who, 'approve', 'run');
  const orig = await getRun(db, c, body.runId);
  if (!['approved', 'paid'].includes(orig.status) || orig.kind === 'adjustment') throw bad('bad_adjust', 'Only an approved or paid payroll can be corrected this way.', 409);
  const mode = body.mode === 'blank' ? 'blank' : 'reverse';
  if (mode === 'reverse' && await one(db, `SELECT 1 x FROM pr_runs WHERE client_id = ? AND adjusts_run_id = ? AND note = 'reversal'`, c, orig.run_id)) throw bad('already_reversed', 'This payroll has already been reversed.', 409);
  const n = await nextSeq(db, c, 'run'), ref = `PR-${orig.period_start.slice(0, 7).replace('-', '')}-${String(n).padStart(3, '0')}A`, id = rid('R'), t = nowMs();
  const stmts = [db.prepare(`INSERT INTO pr_runs (client_id, run_id, ref, kind, adjusts_run_id, label, frequency, period_start, period_end, branch_id, status, note, created_by, created_at, updated_at) VALUES (?,?,?, 'adjustment', ?, ?,?,?,?,?, 'draft', ?, ?,?,?)`)
    .bind(c, id, ref, orig.run_id, (mode === 'reverse' ? 'Reversal of ' : 'Adjustment to ') + orig.ref, orig.frequency, orig.period_start, orig.period_end, c, mode === 'reverse' ? 'reversal' : 'adjustment', String(who.sid), t, t)];
  const items = await all(db, `SELECT * FROM pr_items WHERE client_id = ? AND run_id = ? ORDER BY payslip_no`, c, orig.run_id);
  const pick = Array.isArray(body.empIds) && body.empIds.length ? new Set(body.empIds.map(String)) : null;
  let k = 0;
  for (const it of items) {
    if (mode === 'blank' && pick && !pick.has(it.emp_id)) continue;
    if (mode === 'blank' && !pick) continue;
    k++;
    const slip = `${ref}-${String(k).padStart(3, '0')}`;
    const lines = [];
    if (mode === 'reverse') {
      if (it.basic > 0) lines.push({ kind: 'deduction', label: 'Reversal: basic pay', amount: it.basic });
      for (const l of await linesFor(db, c, orig.run_id, it.emp_id)) lines.push({ kind: l.kind === 'earning' ? 'deduction' : 'earning', label: 'Reversal: ' + l.label, amount: l.amount });
    }
    const calc = calcItem({ rate: 0, rate_unit: 'period', units: 1 }, lines.map((l) => ({ ...l, calc: 'fixed', manual: 1 })), { adjustment: true });
    stmts.push(db.prepare(`INSERT INTO pr_items (client_id, run_id, emp_id, payslip_no, emp_no, emp_name, job_title, department, branch_name, rate_unit, rate, units, basic, additions, deductions, net, note) VALUES (?,?,?,?,?,?,?,?,?, 'period', 0, 1, 0, ?,?,?, ?)`)
      .bind(c, id, it.emp_id, slip, it.emp_no, it.emp_name, it.job_title, it.department, it.branch_name, calc.additions, calc.deductions, calc.net, 'Adjusts ' + it.payslip_no));
    calc.lines.forEach((l, i) => stmts.push(db.prepare(`INSERT INTO pr_item_lines (client_id, run_id, emp_id, line_no, kind, type_id, pay_line_id, label, calc, rate, cfg, amount, manual, note) VALUES (?,?,?,?,?,NULL,NULL,?, 'fixed', 0, NULL, ?, 1, NULL)`).bind(c, id, it.emp_id, i + 1, l.kind, l.label, l.amount)));
  }
  if (!k && mode === 'blank') throw bad('pick_staff', 'Pick at least one employee to adjust.');
  stmts.push(totalsStmt(db, c, id, t), auditStmt(db, c, who, 'payroll_adjustment_created', 'run', id, { ref, adjusts: orig.ref, mode, note: str(body.note, 200) }));
  await db.batch(stmts);
  return { runId: id, ref };
};

// ---- payslips ----
A['payslip.get'] = async ({ db, c, who, body }) => {
  const run = await getRun(db, c, body.runId);
  const empId = String(body.empId || '');
  const it = await one(db, `SELECT * FROM pr_items WHERE client_id = ? AND run_id = ? AND emp_id = ?`, c, run.run_id, empId);
  if (!it) throw bad('not_found', 'That payslip was not found.', 404);
  if (!can(who, 'view', 'run', 'approve')) {                                   // an ordinary staff member: only their OWN, only once PAID
    const mine = await one(db, `SELECT emp_id FROM pr_employees WHERE client_id = ? AND pos_staff_id = ?`, c, who.sid);
    if (!mine || mine.emp_id !== empId || run.status !== 'paid') throw bad('payroll_forbidden', 'ACCESS DENIED — you can only open your own payslips.', 403);
  }
  if (body.audit) await auditStmt(db, c, who, 'payslip_generated', 'payslip', it.payslip_no, { employee: it.emp_name, how: str(body.how, 20) }).run();
  const lines = await linesFor(db, c, run.run_id, empId);
  return { run: { run_id: run.run_id, ref: run.ref, kind: run.kind, label: run.label, status: run.status, frequency: run.frequency, period_start: run.period_start, period_end: run.period_end, pay_date: run.pay_date, pay_method: run.pay_method, pay_reference: run.pay_reference, approved_by: run.approved_by }, item: it, lines };
};

// ---- saved payslip PDFs + automatic archiving (zip 221) ----
const SLIP_MAX_BYTES = 400 * 1024;
export const SLIP_ARCHIVE_DAYS = 90;
async function slipAccess(db, c, who, body) {
  const run = await getRun(db, c, body.runId);
  const empId = String(body.empId || '');
  const it = await one(db, `SELECT payslip_no, emp_name FROM pr_items WHERE client_id = ? AND run_id = ? AND emp_id = ?`, c, run.run_id, empId);
  if (!it) throw bad('not_found', 'That payslip was not found.', 404);
  if (!can(who, 'view', 'run', 'approve')) {
    const mine = await one(db, `SELECT emp_id FROM pr_employees WHERE client_id = ? AND pos_staff_id = ?`, c, who.sid);
    if (!mine || mine.emp_id !== empId || run.status !== 'paid') throw bad('payroll_forbidden', 'ACCESS DENIED — you can only open your own payslips.', 403);
  }
  return { run, it, empId };
}
const slipBucket = (env) => (env && (env.DB_BACKUPS || env.AUDIT_ARCHIVE)) || null;
// Move saved PDFs older than SLIP_ARCHIVE_DAYS out of D1 into R2. Safe to repeat; does nothing when R2 is not bound (files then simply stay in D1).
export async function archiveOldSlips(db, c, env, now = Date.now(), days = SLIP_ARCHIVE_DAYS) {
  const bucket = slipBucket(env); if (!bucket) return { archived: 0, reason: 'no_bucket' };
  const rows = await all(db, `SELECT payslip_no, data FROM pr_slip_files WHERE client_id = ? AND data IS NOT NULL AND saved_at <= ? LIMIT 50`, c, now - days * 86400000);
  let n = 0;
  for (const r of rows) {
    const key = `payslips/${c}/${r.payslip_no}.pdf.b64`;
    try { await bucket.put(key, r.data, { httpMetadata: { contentType: 'text/plain' } }); } catch (e) { continue; }
    await db.prepare(`UPDATE pr_slip_files SET data = NULL, r2_key = ?, archived_at = ? WHERE client_id = ? AND payslip_no = ?`).bind(key, now, c, r.payslip_no).run();
    n++;
  }
  return { archived: n };
}
A['payslip.save'] = async ({ db, c, who, env, body }) => {
  const { run, it, empId } = await slipAccess(db, c, who, body);
  const b64 = String(body.pdf || '').replace(/^data:[^,]*,/, '');
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) throw bad('bad_file', 'There is no PDF to save.');
  const size = Math.floor(b64.length * 3 / 4);
  if (size > SLIP_MAX_BYTES) throw bad('too_big', 'That payslip PDF is too large to store.');
  const now = Date.now();
  await db.prepare(`INSERT INTO pr_slip_files (client_id, payslip_no, run_id, emp_id, file_name, size, data, r2_key, saved_by, saved_at, archived_at) VALUES (?,?,?,?,?,?,?,NULL,?,?,NULL)
    ON CONFLICT(client_id, payslip_no) DO UPDATE SET file_name = excluded.file_name, size = excluded.size, data = excluded.data, r2_key = NULL, saved_by = excluded.saved_by, saved_at = excluded.saved_at, archived_at = NULL`)
    .bind(c, it.payslip_no, run.run_id, empId, str(body.fileName, 120), size, b64, str(who && (who.name || who.sid), 80), now).run();
  await auditStmt(db, c, who, 'payslip_generated', 'payslip', it.payslip_no, { employee: it.emp_name, how: 'saved' }).run();
  let arch = { archived: 0 }; try { arch = await archiveOldSlips(db, c, env, now); } catch (e) { /* the save already worked */ }
  return { saved: true, payslip_no: it.payslip_no, size, archived_now: arch.archived };
};
A['payslip.saved'] = async ({ db, c, who, env, body }) => {
  const { it } = await slipAccess(db, c, who, body);
  const r = await one(db, `SELECT file_name, size, data, r2_key, saved_at, archived_at FROM pr_slip_files WHERE client_id = ? AND payslip_no = ?`, c, it.payslip_no);
  if (!r) return { found: false };
  let data = r.data, restored = false;
  if (!data && r.r2_key) {
    const bucket = slipBucket(env); const o = bucket ? await bucket.get(r.r2_key) : null;
    if (!o) throw bad('archive_unavailable', 'This payslip is in the archive and the archive could not be reached right now — try again later.', 503);
    data = await o.text(); restored = true;
  }
  return { found: true, file_name: r.file_name, size: r.size, saved_at: r.saved_at, archived: !!r.archived_at, restored, pdf: data };
};
A['payslip.archive'] = async ({ db, c, who, env, body }) => {
  if (!can(who, 'view', 'run', 'approve')) throw bad('payroll_forbidden', 'ACCESS DENIED.', 403);
  const nd = Number(body.days); const days = Math.max(0, Math.min(3650, Number.isFinite(nd) && body.days !== undefined && body.days !== null ? nd : SLIP_ARCHIVE_DAYS));
  return await archiveOldSlips(db, c, env, Date.now(), days);
};

// An ordinary staff member: their own record and their own PAID payslips. Nothing else, ever.
A['me'] = async ({ db, c, who }) => {
  const e = await one(db, `SELECT * FROM pr_employees WHERE client_id = ? AND pos_staff_id = ?`, c, who.sid);
  if (!e) return { employee: null, payslips: [] };
  const slips = await all(db, `SELECT i.run_id, i.emp_id, i.payslip_no, i.basic, i.additions, i.deductions, i.net, r.label, r.ref, r.kind, r.period_start, r.period_end, r.pay_date FROM pr_items i JOIN pr_runs r ON r.client_id = i.client_id AND r.run_id = i.run_id WHERE i.client_id = ? AND i.emp_id = ? AND r.status = 'paid' ORDER BY r.period_start DESC`, c, e.emp_id);
  return { employee: { emp_no: e.emp_no, name: e.name, job_title: e.job_title, department: e.department, branch_name: e.branch_name, status: e.status, start_date: e.start_date, pay_frequency: e.pay_frequency, basic_pay: e.basic_pay, rate_unit: e.rate_unit }, payslips: slips };
};

// ---- dashboard ----
A['dashboard'] = async ({ db, c, who, body }) => {
  need(who, ...PERMS);
  const month = String(body.month || '').match(/^\d{4}-\d{2}$/) ? body.month : new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 7);
  const counts = await all(db, `SELECT status, COUNT(*) n FROM pr_employees WHERE client_id = ? GROUP BY status`, c);
  const runs = await all(db, `SELECT status, kind, COUNT(*) n, SUM(total_net) net, SUM(employee_count) people FROM pr_runs WHERE client_id = ? AND substr(period_start, 1, 7) = ? GROUP BY status, kind`, c, month);
  const last = await one(db, `SELECT frequency, period_end FROM pr_runs WHERE client_id = ? AND kind = 'regular' ORDER BY period_end DESC LIMIT 1`, c);
  let upcoming = null;
  if (last) { const d = new Date(last.period_end + 'T00:00:00Z'); const step = { monthly: 0, biweekly: 14, weekly: 7, daily: 1 }[last.frequency]; if (step) d.setUTCDate(d.getUTCDate() + step); else { d.setUTCMonth(d.getUTCMonth() + 2, 0); } upcoming = d.toISOString().slice(0, 10); }
  else { const d = new Date(month + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1, 0); upcoming = d.toISOString().slice(0, 10); }
  const alertDays = 30, lim = new Date(Date.now() + alertDays * 86400000).toISOString().slice(0, 10);
  const expiring = can(who, 'staff') ? await all(db, `SELECT d.doc_id, d.emp_id, d.title, d.expiry_date, e.name FROM pr_documents d JOIN pr_employees e ON e.client_id = d.client_id AND e.emp_id = d.emp_id WHERE d.client_id = ? AND d.status = 'active' AND d.expiry_date IS NOT NULL AND d.expiry_date <= ? ORDER BY d.expiry_date LIMIT 20`, c, lim) : [];
  const sum = (st) => runs.filter((r) => r.status === st).reduce((s, r) => s + num(r.net), 0);
  const cnt = (st) => runs.filter((r) => r.status === st).reduce((s, r) => s + num(r.people), 0);
  return { month, employees: counts.reduce((s, r) => s + (r.status === 'former' ? 0 : r.n), 0), counts: Object.fromEntries(counts.map((r) => [r.status, r.n])), monthTotal: round2(runs.reduce((s, r) => s + num(r.net), 0)), pendingApproval: cnt('reviewed') + cnt('draft'), awaitingPayment: cnt('approved'), paid: cnt('paid'), paidTotal: round2(sum('paid')), upcoming, expiring, alertDays };
};

A['audit.list'] = async ({ db, c, who, body }) => {
  need(who, 'settings');
  return { audit: await all(db, `SELECT id, ts, actor_id, actor_name, action, entity, entity_id, detail FROM pr_audit WHERE client_id = ? ORDER BY id DESC LIMIT ?`, c, Math.min(500, Math.max(1, num(body.limit, 100)))) };
};

registerHr(A, { need, can, bad, one, all, auditStmt, str, num, rid, nowMs, PERMS });
export const ACTIONS = A;
// Actions any signed-in staff member may call (their own data); every other action checks permissions inside.
export const SELF_ACTIONS = new Set(['me', 'whoami', 'payslip.get', 'payslip.save', 'payslip.saved']);
export { bad };
