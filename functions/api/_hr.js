// functions/api/_hr.js — Staff & HR records (zip 328): employment basis / schedule / end date rules, employee history, deduction approval and
// effective dates, the staff reports (weekly / monthly, scheduled), and the lifecycle flags. It EXTENDS Create Payroll (_payroll.js) — same tables,
// same permissions, same audit — and adds a side table for the new facts (see _hr-schema.js). Nothing here deletes or rewrites existing payroll data.
import { HR_SCHEMA, HR_SCHEMA_0018, HR_SCHEMA_VERSION } from './_hr-schema.js';
import { sendEmail } from './_email.js';

export const BASES = ['permanent', 'contract', 'intern'];
export const SCHEDULES = ['full_time', 'part_time'];
export const LEAVER_STATUSES = new Set(['inactive', 'terminated', 'former']);
export const DEFAULT_TZ = 'Africa/Nairobi';
export const DEFAULT_WARN_DAYS = 60;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const validDay = (v) => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

// ---------- schema ----------
const ready = new WeakMap();
export async function ensureHrSchema(db) {
  if (!db) return false;
  if (ready.get(db)) return true;
  let ok = false;
  try { const r = await db.prepare(`SELECT v FROM pr_meta WHERE k = 'hr_schema'`).first(); ok = !!(r && Number(r.v) >= HR_SCHEMA_VERSION); } catch (e) { ok = false; }
  if (!ok) {
    await db.batch(HR_SCHEMA.concat(HR_SCHEMA_0018).map((s) => db.prepare(s)));
    await db.prepare(`INSERT INTO pr_meta (k, v) VALUES ('hr_schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(HR_SCHEMA_VERSION)).run();
  }
  ready.set(db, true);
  return true;
}

// ---------- dates (calendar days as YYYY-MM-DD, no time zones in the arithmetic) ----------
const dayNum = (d) => Math.floor(Date.parse(d + 'T00:00:00Z') / 86400000);
export const daysBetween = (a, b) => dayNum(b) - dayNum(a);
export function addDays(d, n) { return new Date((dayNum(d) + n) * 86400000).toISOString().slice(0, 10); }
export function addMonths(d, n) {
  const [y, m, dd] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(dd, last))).toISOString().slice(0, 10);
}
export function wholeMonthsBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number);
  let n = (y2 - y1) * 12 + (m2 - m1); if (d2 < d1) n -= 1; return Math.max(0, n);
}
// today's date in a time zone (an invalid zone falls back to the default)
export function localDay(ms, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
  catch (e) { return new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
}
export const validTz = (tz) => { try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return typeof tz === 'string' && tz.length > 2; } catch (e) { return false; } };
const weekdayOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();          // 0 = Sunday
export const weekStart = (d) => addDays(d, -((weekdayOf(d) + 6) % 7));        // the Monday of that day's week
export const monthStart = (d) => d.slice(0, 8) + '01';
export const monthEnd = (d) => addDays(addMonths(monthStart(d), 1), -1);

// The last COMPLETED period of a kind as of a local day: weekly = last Monday..Sunday, monthly = last calendar month.
export function lastCompletePeriod(kind, today) {
  if (kind === 'weekly') { const s = addDays(weekStart(today), -7); return { start: s, end: addDays(s, 6) }; }
  const s = addMonths(monthStart(today), -1); return { start: s, end: monthEnd(s) };
}
export function periodOf(kind, day) {
  if (kind === 'weekly') { const s = weekStart(day); return { start: s, end: addDays(s, 6) }; }
  return { start: monthStart(day), end: monthEnd(day) };
}

// ---------- employment rules ----------
const mapBasis = (employmentType) => { const t = String(employmentType || '').toLowerCase(); return t.includes('intern') ? 'intern' : t.includes('contract') ? 'contract' : 'permanent'; };

// Validates the HR part of a save. Returns the cleaned facts or throws (via `bad`). `start` is the employee's start date (already validated).
export function hrClean(raw, { start, oldHr, oldEmp, isNew, bad, str }) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(r, k);
  const basis = BASES.includes(r.employment_basis) ? r.employment_basis : (oldHr ? oldHr.employment_basis : mapBasis(oldEmp && oldEmp.employment_type));
  const schedule = SCHEDULES.includes(r.work_schedule) ? r.work_schedule : (oldHr ? oldHr.work_schedule : 'full_time');
  let end = has('end_date') ? (r.end_date ? r.end_date : null) : (oldHr ? oldHr.end_date : null);
  if (end && !validDay(end)) throw bad('bad_date', 'The employment end date must be a valid date.');
  let months = has('internship_months') ? (r.internship_months === '' || r.internship_months == null ? null : Number(r.internship_months)) : (oldHr ? oldHr.internship_months : null);
  if (months != null && !(Number.isInteger(months) && months >= 1 && months <= 36)) throw bad('bad_duration', 'The internship duration must be a whole number of months (1 to 36).');
  if (basis === 'contract' && !end) throw bad('end_date_required', 'A contract needs an employment end date.');
  if (basis === 'intern') {
    if (!start) throw bad('start_date_required', 'An internship needs a start date.');
    if (!end && months == null) throw bad('duration_required', 'An internship needs its duration (months) or an end date.');
    if (!end && months != null) end = addDays(addMonths(start, months), -1);       // the duration defines the end: the last day of the last month
    if (end && months == null) months = Math.max(1, wholeMonthsBetween(start, addDays(end, 1)));
  } else if (basis === 'permanent') { months = null; }
  else months = null;
  if (end && start && end < start) throw bad('bad_dates', 'The end date cannot be before the start date.');
  const sup = has('supervisor_name') ? str(r.supervisor_name, 80) : (oldHr ? oldHr.supervisor_name : null);
  const supId = has('supervisor_emp_id') ? str(r.supervisor_emp_id, 40) : (oldHr ? oldHr.supervisor_emp_id : null);
  let branches = has('branch_ids') ? r.branch_ids : (oldHr && oldHr.branch_ids ? safeJson(oldHr.branch_ids, []) : []);
  if (!Array.isArray(branches)) branches = [];
  branches = [...new Set(branches.map((b) => String(b).trim().slice(0, 60)).filter(Boolean))].slice(0, 20);
  return {
    cadre: has('cadre') ? str(r.cadre, 60) : (oldHr ? oldHr.cadre : null), designation: has('designation') ? str(r.designation, 60) : (oldHr ? oldHr.designation : null),
    supervisor_name: sup, supervisor_emp_id: supId, employment_basis: basis, work_schedule: schedule, end_date: end, internship_months: months,
    branch_ids: JSON.stringify(branches), end_note: has('end_note') ? str(r.end_note, 200) : (oldHr ? oldHr.end_note : null),
  };
}
function safeJson(s, d) { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } }

// The lifecycle shown for a person. It is only a LABEL computed from the dates: nothing is deactivated or ended automatically.
export function employmentFlags(emp, hr, today, warnDays = DEFAULT_WARN_DAYS) {
  const basis = hr ? hr.employment_basis : mapBasis(emp.employment_type);
  const end = hr ? hr.end_date : null;
  const out = { basis, schedule: hr ? hr.work_schedule : 'full_time', end_date: end || null, days_left: null, ending_soon: false, ended: false, lifecycle: emp.status || 'active', remaining: '' };
  if (LEAVER_STATUSES.has(emp.status) || emp.status === 'suspended' || emp.status === 'on_leave') return out;
  const noun = basis === 'intern' ? 'internship' : 'contract';
  if ((basis === 'contract' || basis === 'intern') && end) {
    const left = daysBetween(today, end);
    out.days_left = left;
    if (left < 0) { out.ended = true; out.lifecycle = noun + '_ended'; out.remaining = 'Ended ' + (-left) + ' day' + (left === -1 ? '' : 's') + ' ago'; }
    else if (left <= warnDays) { out.ending_soon = true; out.lifecycle = noun + '_ending_soon'; out.remaining = left === 0 ? 'Ends today' : left + ' day' + (left === 1 ? '' : 's') + ' left'; }
    else { out.lifecycle = basis === 'intern' ? 'intern' : 'active'; out.remaining = left > 60 ? Math.round(left / 30.4) + ' months left' : left + ' days left'; }
  } else if (basis === 'intern') out.lifecycle = 'intern';
  return out;
}
export const maskId = (v) => { const s = String(v == null ? '' : v); return s ? '•'.repeat(Math.max(0, s.length - 3)) + s.slice(-3) : ''; };

// A recurring line applies to a pay period when it is approved and the period overlaps its effective window. No metadata = always applies (as before).
export function lineApplies(meta, periodStart, periodEnd) {
  if (!meta) return { ok: true };
  if (meta.approval && meta.approval !== 'approved') return { ok: false, why: meta.approval === 'pending' ? 'waiting for approval' : 'rejected' };
  if (meta.effective_from && periodEnd && meta.effective_from > periodEnd) return { ok: false, why: 'starts ' + meta.effective_from };
  if (meta.effective_to && periodStart && meta.effective_to < periodStart) return { ok: false, why: 'ended ' + meta.effective_to };
  if (meta.period && /^\d{4}-\d{2}$/.test(meta.period) && periodStart && periodEnd && !(periodStart.slice(0, 7) <= meta.period && meta.period <= periodEnd.slice(0, 7))) return { ok: false, why: 'only for ' + meta.period };
  return { ok: true };
}
export async function lineMetaMap(db, c, empId) {
  const rows = (await db.prepare(`SELECT * FROM pr_line_meta WHERE client_id = ? AND emp_id = ?`).bind(c, empId).all()).results || [];
  return new Map(rows.map((r) => [r.line_id, r]));
}

// ---------- settings ----------
export async function getSettings(db, c) {
  const rows = (await db.prepare(`SELECT k, v FROM pr_settings WHERE client_id = ?`).bind(c).all()).results || [];
  const m = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  return {
    tz: validTz(m.tz) ? m.tz : DEFAULT_TZ,
    weekly: m.report_weekly === '1', monthly: m.report_monthly === '1',
    deduction_approval: m.deduction_approval === '1',
    doc_max_mb: num(m.doc_max_mb, 1.5, 0.5, 1.5),       // zip 334: staff documents are 1.5 MB at most (the screen shrinks bigger files first)
    warn_days: Math.round(num(m.warn_days, DEFAULT_WARN_DAYS, 7, 180)),
    notify_email: m.notify_email || '',
  };
}

// ---------- reports ----------
// What is in a staff report. Only facts that are really stored; anything that is not collected on the server says so instead of being invented.
export async function buildStaffReport(db, c, emp, hr, period, kind, settings) {
  const today = localDay(Date.now(), settings.tz);
  const flags = employmentFlags(emp, hr, period.end, settings.warn_days);
  const sections = {};
  sections.profile = {
    name: emp.name, emp_no: emp.emp_no, cadre: (hr && hr.cadre) || null, job_title: emp.job_title || null, designation: (hr && hr.designation) || null, department: emp.department || null,
    branch: emp.branch_name || null, employment_basis: flags.basis, work_schedule: flags.schedule, status: emp.status, lifecycle: flags.lifecycle,
    start_date: emp.start_date || null, end_date: flags.end_date, internship_months: hr ? hr.internship_months : null, remaining_at_period_end: flags.remaining || null,
    supervisor: (hr && hr.supervisor_name) || null,
  };
  const lines = ((await db.prepare(`SELECT l.line_id, l.kind, l.label, l.calc, l.rate, l.amount, l.active FROM pr_pay_lines l WHERE l.client_id = ? AND l.emp_id = ? AND l.active = 1`).bind(c, emp.emp_id).all()).results) || [];
  const meta = await lineMetaMap(db, c, emp.emp_id);
  const applicable = lines.filter((l) => lineApplies(meta.get(l.line_id), period.start, period.end).ok);
  const unsetSalary = hr && hr.salary_state === 'unset';
  sections.salary = {
    sensitive: true, state: unsetSalary ? 'not_entered' : 'set', basic_pay: unsetSalary ? null : Number(emp.basic_pay), pay_frequency: emp.pay_frequency,
    allowances: applicable.filter((l) => l.kind === 'earning').map((l) => ({ label: l.label, calc: l.calc, amount: l.amount, rate: l.rate })),
    deductions: applicable.filter((l) => l.kind === 'deduction').map((l) => ({ label: l.label, calc: l.calc, amount: l.amount, rate: l.rate })),
    pending_deductions: lines.filter((l) => { const m = meta.get(l.line_id); return m && m.approval === 'pending'; }).map((l) => l.label),
  };
  const items = ((await db.prepare(`SELECT r.ref, r.status, r.period_start, r.period_end, i.basic, i.additions, i.deductions, i.net FROM pr_items i JOIN pr_runs r ON r.client_id = i.client_id AND r.run_id = i.run_id WHERE i.client_id = ? AND i.emp_id = ? AND r.period_start <= ? AND r.period_end >= ? AND r.status IN ('approved','paid') ORDER BY r.period_start`).bind(c, emp.emp_id, period.end, period.start).all()).results) || [];
  sections.payroll = { sensitive: true, runs: items.map((i) => ({ ref: i.ref, status: i.status, period_start: i.period_start, period_end: i.period_end, basic: i.basic, additions: i.additions, deductions: i.deductions, net: i.net })), net_total: Math.round(items.reduce((n, i) => n + (Number(i.net) || 0), 0) * 100) / 100 };
  const docs = ((await db.prepare(`SELECT title, category, expiry_date FROM pr_documents WHERE client_id = ? AND emp_id = ? AND status = 'active'`).bind(c, emp.emp_id).all()).results) || [];
  sections.documents = { count: docs.length, expired: docs.filter((d) => d.expiry_date && d.expiry_date < period.end).map((d) => d.title), expiring_soon: docs.filter((d) => d.expiry_date && d.expiry_date >= period.end && daysBetween(period.end, d.expiry_date) <= settings.warn_days).map((d) => d.title) };
  // sales activity: only when the shop's sales reach the ledger database under this person's name
  try {
    const row = await db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total), 0) t FROM ledger_sales WHERE client_id = ? AND staff = ? COLLATE NOCASE AND business_date >= ? AND business_date <= ? AND status = 'COMPLETED'`).bind(c, emp.name, period.start, period.end).first();
    sections.sales = row && Number(row.n) > 0 ? { available: true, count: Number(row.n), total: Math.round(Number(row.t) * 100) / 100 } : { available: false, note: 'No completed sales are recorded under this staff name in the period (or this shop\'s sales are not stored in the ledger database).' };
  } catch (e) { sections.sales = { available: false, note: 'Sales figures were not available when this report was made.' }; }
  sections.attendance = { available: false, note: 'Attendance and working hours are recorded on the till and are not stored on the server, so they are not included. Nothing has been estimated.' };
  const actions = [];
  if (flags.ended) actions.push('Employment end date has passed (' + flags.end_date + ') — renew, change or end the employment.');
  else if (flags.ending_soon) actions.push((flags.basis === 'intern' ? 'Internship' : 'Contract') + ' ends ' + flags.end_date + ' (' + flags.remaining + ').');
  if (unsetSalary) actions.push('Salary has not been entered.');
  if (sections.salary.pending_deductions.length) actions.push('Deductions waiting for approval: ' + sections.salary.pending_deductions.join(', ') + '.');
  if (sections.documents.expired.length) actions.push('Expired documents: ' + sections.documents.expired.join(', ') + '.');
  sections.actions = actions;
  return { kind, period_start: period.start, period_end: period.end, employee: { emp_id: emp.emp_id, name: emp.name, emp_no: emp.emp_no }, sections };
}

const SENSITIVE = ['salary', 'payroll'];
export function redactReport(data, allowSensitive) {
  if (allowSensitive) return data;
  const out = { ...data, sections: { ...data.sections } };
  SENSITIVE.forEach((k) => { if (out.sections[k]) out.sections[k] = { sensitive: true, hidden: true }; });
  return out;
}

// Generates the reports of one business for one period. Safe to repeat: a person's report for a period is written with INSERT OR IGNORE on
// (person, kind, period, version 1), so a retry only fills in what is missing. `force` (a manual regeneration) writes the NEXT version instead.
export async function generateReports(db, c, kind, period, { actor = 'cron', force = false, empIds = null, settings = null, now = Date.now(), rid } = {}) {
  settings = settings || await getSettings(db, c);
  const mkId = rid || ((p) => p + now.toString(36) + Math.random().toString(36).slice(2, 8));
  let emps = ((await db.prepare(`SELECT * FROM pr_employees WHERE client_id = ? ORDER BY name COLLATE NOCASE`).bind(c).all()).results) || [];
  // someone who had already left before the period began has no report; everybody else (including interns and people who left during it) does
  const hrRows = ((await db.prepare(`SELECT * FROM pr_emp_hr WHERE client_id = ?`).bind(c).all()).results) || [];
  const hrBy = new Map(hrRows.map((h) => [h.emp_id, h]));
  emps = emps.filter((e) => !(LEAVER_STATUSES.has(e.status) && hrBy.get(e.emp_id) && hrBy.get(e.emp_id).deactivated_at && localDay(hrBy.get(e.emp_id).deactivated_at, settings.tz) < period.start));
  if (Array.isArray(empIds) && empIds.length) { const set = new Set(empIds.map(String)); emps = emps.filter((e) => set.has(e.emp_id)); }
  const job = { generated: 0, failed: 0, errors: [] };
  for (const e of emps) {
    try {
      const data = await buildStaffReport(db, c, e, hrBy.get(e.emp_id) || null, period, kind, settings);
      const cur = await db.prepare(`SELECT MAX(version) v FROM pr_reports WHERE client_id = ? AND emp_id = ? AND period_kind = ? AND period_start = ?`).bind(c, e.emp_id, kind, period.start).first();
      const have = cur && cur.v != null ? Number(cur.v) : 0;
      if (have && !force) continue;                                                   // already made: never a second copy
      const version = have + 1;
      const r = await db.prepare(`INSERT OR IGNORE INTO pr_reports (client_id, report_id, emp_id, period_kind, period_start, period_end, version, generated_at, generated_by, tz, data) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(c, mkId('RP'), e.emp_id, kind, period.start, period.end, version, now, String(actor), settings.tz, JSON.stringify(data)).run();
      if (r.meta && r.meta.changes) job.generated++;
    } catch (err) { job.failed++; job.errors.push(e.name + ': ' + String((err && err.message) || err).slice(0, 120)); }
  }
  return job;
}

// One business, one period kind: claim the job row, generate, record the outcome. Another run of the same job at the same moment cannot double up
// (the claim is a conditional UPDATE and the reports themselves are idempotent).
export async function runReportJob(db, c, kind, period, opts = {}) {
  const now = opts.now || Date.now();
  await db.prepare(`INSERT OR IGNORE INTO pr_report_jobs (client_id, period_kind, period_start, period_end, status, attempts) VALUES (?,?,?,?, 'pending', 0)`).bind(c, kind, period.start, period.end).run();
  const claim = await db.prepare(`UPDATE pr_report_jobs SET attempts = attempts + 1, started_at = ?, status = CASE WHEN status = 'ok' AND ? = 0 THEN status ELSE 'pending' END WHERE client_id = ? AND period_kind = ? AND period_start = ? AND (status <> 'ok' OR ? = 1)`).bind(now, opts.force ? 1 : 0, c, kind, period.start, opts.force ? 1 : 0).run();
  if (!(claim.meta && claim.meta.changes)) return { skipped: 'already_done' };
  let res;
  try { res = await generateReports(db, c, kind, period, opts); }
  catch (e) { res = { generated: 0, failed: 1, errors: [String((e && e.message) || e).slice(0, 160)] }; }
  const status = res.failed ? (res.generated ? 'partial' : 'failed') : 'ok';
  await db.prepare(`UPDATE pr_report_jobs SET status = ?, generated = generated + ?, failed = ?, last_error = ?, finished_at = ? WHERE client_id = ? AND period_kind = ? AND period_start = ?`)
    .bind(status, res.generated, res.failed, res.errors.length ? res.errors.join(' | ').slice(0, 500) : null, Date.now(), c, kind, period.start).run();
  return { status, ...res };
}

// The scheduled entry point (called by the daily cron). For every business that switched the schedule on: the last completed week / month in ITS time zone.
export async function scheduledStaffReports(env, now = Date.now()) {
  const db = env && (env.LEDGER_DB || env.DB);
  if (!db) return { skipped: 'no_db' };
  await ensureHrSchema(db).catch(() => {});
  let clients = [];
  try { clients = ((await db.prepare(`SELECT DISTINCT client_id FROM pr_settings WHERE k IN ('report_weekly','report_monthly') AND v = '1' LIMIT 500`).all()).results || []).map((r) => r.client_id); } catch (e) { return { skipped: 'no_schema' }; }
  const out = [];
  for (const c of clients) {
    try {
      const s = await getSettings(db, c);
      const today = localDay(now, s.tz);
      for (const kind of ['weekly', 'monthly']) {
        if (!s[kind]) continue;
        const period = lastCompletePeriod(kind, today);
        const res = await runReportJob(db, c, kind, period, { actor: 'schedule', settings: s, now });
        // an optional notice, only when an address is set AND the platform has email configured. Counts only: no salary, no names, no personal data.
        if (s.notify_email && res.generated > 0) {
          try {
            const mail = await sendEmail(env, { to: s.notify_email, subject: `Staff ${kind} reports are ready (${period.start} to ${period.end})`, html: `<p>${res.generated} staff ${kind} report(s) were made for ${period.start} to ${period.end}${res.failed ? `; ${res.failed} could not be made and can be retried in Payroll → Settings` : ''}. Open Payroll to read them.</p>` });
            res.notified = !!(mail && mail.ok);
          } catch (e) { res.notified = false; }
        }
        out.push({ c, kind, ...res });
      }
    } catch (e) { out.push({ c, error: String((e && e.message) || e).slice(0, 120) }); }
  }
  return { ran: out };
}

// ---------- registration into the payroll actions ----------
export function registerHr(A, h) {
  const { need, can, bad, one, all, auditStmt, str, num, rid, nowMs, PERMS } = h;
  const sensitiveOk = (who) => can(who, ...PERMS);

  // hr.get: the HR facts + the change history of one person
  A['hr.get'] = async ({ db, c, who, body }) => {
    need(who, ...PERMS);
    const e = await one(db, `SELECT * FROM pr_employees WHERE client_id = ? AND emp_id = ?`, c, String(body.empId || ''));
    if (!e) throw bad('not_found', 'That employee was not found.', 404);
    const hr = await one(db, `SELECT * FROM pr_emp_hr WHERE client_id = ? AND emp_id = ?`, c, e.emp_id);
    const s = await getSettings(db, c);
    const history = await all(db, `SELECT at, effective_date, actor_name, field, old_value, new_value FROM pr_emp_history WHERE client_id = ? AND emp_id = ? ORDER BY at DESC, id DESC LIMIT ?`, c, e.emp_id, Math.min(500, Math.max(1, Math.round(num(body.limit, 200)))));
    return { hr: hr ? { ...hr, branch_ids: safeJson(hr.branch_ids, []) } : null, flags: employmentFlags(e, hr, localDay(Date.now(), s.tz), s.warn_days), history, salary_state: hr ? hr.salary_state : 'set' };
  };

  // hr.alerts: contracts / internships ending soon or already over, salaries not entered, deductions waiting - for the staff list banner
  A['hr.alerts'] = async ({ db, c, who }) => {
    need(who, ...PERMS);
    const s = await getSettings(db, c), today = localDay(Date.now(), s.tz);
    const emps = await all(db, `SELECT e.emp_id, e.name, e.emp_no, e.status, e.employment_type, h.employment_basis, h.end_date, h.salary_state FROM pr_employees e LEFT JOIN pr_emp_hr h ON h.client_id = e.client_id AND h.emp_id = e.emp_id WHERE e.client_id = ?`, c);
    const out = { ending_soon: [], ended: [], salary_not_entered: [], pending_deductions: 0 };
    for (const e of emps) {
      const f = employmentFlags(e, e.employment_basis ? { employment_basis: e.employment_basis, end_date: e.end_date, work_schedule: 'full_time' } : null, today, s.warn_days);
      if (f.ending_soon) out.ending_soon.push({ emp_id: e.emp_id, name: e.name, end_date: f.end_date, days_left: f.days_left, basis: f.basis });
      if (f.ended) out.ended.push({ emp_id: e.emp_id, name: e.name, end_date: f.end_date, basis: f.basis });
      if (e.salary_state === 'unset' && !LEAVER_STATUSES.has(e.status)) out.salary_not_entered.push({ emp_id: e.emp_id, name: e.name });
    }
    out.pending_deductions = Number((await one(db, `SELECT COUNT(*) n FROM pr_line_meta WHERE client_id = ? AND approval = 'pending'`, c)).n) || 0;
    return out;
  };

  // settings
  A['hr.settings.get'] = async ({ db, c, who }) => { need(who, ...PERMS); return { settings: await getSettings(db, c) }; };
  A['hr.settings.save'] = async ({ db, c, who, body }) => {
    need(who, 'settings');
    const f = body.settings || {};
    const put = [];
    const set = (k, v) => put.push(db.prepare(`INSERT INTO pr_settings (client_id, k, v, updated_at) VALUES (?,?,?,?) ON CONFLICT(client_id, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`).bind(c, k, String(v), nowMs()));
    if (f.tz !== undefined) { if (!validTz(f.tz)) throw bad('bad_tz', 'That time zone is not valid (for example Africa/Nairobi).'); set('tz', f.tz); }
    if (f.weekly !== undefined) set('report_weekly', f.weekly ? '1' : '0');
    if (f.monthly !== undefined) set('report_monthly', f.monthly ? '1' : '0');
    if (f.deduction_approval !== undefined) set('deduction_approval', f.deduction_approval ? '1' : '0');
    if (f.doc_max_mb !== undefined) { const n = num(f.doc_max_mb, NaN); if (!(n >= 0.5 && n <= 1.5)) throw bad('bad_size', 'The document size limit must be between 0.5 and 1.5 MB.'); set('doc_max_mb', n); }
    if (f.warn_days !== undefined) { const n = Math.round(num(f.warn_days, NaN)); if (!(n >= 7 && n <= 180)) throw bad('bad_days', 'Warn between 7 and 180 days before an end date.'); set('warn_days', n); }
    if (f.notify_email !== undefined) { const v = String(f.notify_email || '').trim(); if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw bad('bad_email', 'That email address does not look right.'); set('notify_email', v); }
    if (put.length) await db.batch([...put, auditStmt(db, c, who, 'hr_settings_saved', 'settings', null, f)]);
    return { settings: await getSettings(db, c) };
  };

  // deduction / allowance metadata: effective dates, reference, approval
  const baseLineSave = A['payline.save'];
  A['payline.save'] = async (ctx) => {
    const { db, c, who, body } = ctx;
    const m = body.line && body.line.meta && typeof body.line.meta === 'object' ? body.line.meta : null;
    let clean = null;
    if (m) {
      const from = m.effective_from || null, to = m.effective_to || null;
      if ((from && !validDay(from)) || (to && !validDay(to))) throw bad('bad_date', 'Check the effective dates.');
      if (from && to && to < from) throw bad('bad_dates', 'The "until" date cannot be before the "from" date.');
      if (m.period && !/^\d{4}-\d{2}$/.test(m.period)) throw bad('bad_period', 'The pay period must look like 2026-10.');
      const s = await getSettings(db, c);
      let approval = ['approved', 'pending', 'rejected'].includes(m.approval) ? m.approval : (s.deduction_approval && body.line.kind === 'deduction' ? 'pending' : 'approved');
      if (approval === 'approved' && s.deduction_approval && body.line.kind === 'deduction' && !(who.admin || who.perms.has('approve'))) approval = 'pending';   // only an approver can approve
      clean = { from, to, period: m.period || null, reference: str(m.reference, 80), reason: str(m.reason, 200), approval };
    }
    const res = await baseLineSave(ctx);
    if (clean) {
      const t = nowMs(), approvedNow = clean.approval === 'approved';
      await db.batch([
        db.prepare(`INSERT INTO pr_line_meta (client_id, emp_id, line_id, effective_from, effective_to, period, reference, reason, approval, approved_by, approved_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(client_id, emp_id, line_id) DO UPDATE SET effective_from=excluded.effective_from, effective_to=excluded.effective_to, period=excluded.period, reference=excluded.reference, reason=excluded.reason, approval=excluded.approval, approved_by=excluded.approved_by, approved_at=excluded.approved_at, updated_at=excluded.updated_at`)
          .bind(c, String(body.empId), res.lineId, clean.from, clean.to, clean.period, clean.reference, clean.reason, clean.approval, approvedNow ? String(who.sid) : null, approvedNow ? t : null, t),
        auditStmt(db, c, who, 'pay_line_terms_saved', 'employee', String(body.empId), { lineId: res.lineId, ...clean }),
      ]);
    }
    return res;
  };
  A['payline.approve'] = async ({ db, c, who, body }) => {
    need(who, 'approve');
    const st = body.approve === false ? 'rejected' : 'approved', t = nowMs();
    const line = await one(db, `SELECT line_id FROM pr_pay_lines WHERE client_id = ? AND emp_id = ? AND line_id = ?`, c, String(body.empId || ''), String(body.lineId || ''));
    if (!line) throw bad('not_found', 'That earning / deduction was not found.', 404);
    await db.batch([
      db.prepare(`INSERT INTO pr_line_meta (client_id, emp_id, line_id, approval, approved_by, approved_at, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(client_id, emp_id, line_id) DO UPDATE SET approval = excluded.approval, approved_by = excluded.approved_by, approved_at = excluded.approved_at, updated_at = excluded.updated_at`)
        .bind(c, String(body.empId), String(body.lineId), st, String(who.sid), t, t),
      auditStmt(db, c, who, 'pay_line_' + st, 'employee', String(body.empId), { lineId: body.lineId }),
    ]);
    return { approval: st };
  };

  // the employee list / one employee, with the HR facts, masked ID numbers and the filters of the staff screen
  const baseGet = A['employee.get'];
  A['employee.get'] = async (ctx) => {
    const out = await baseGet(ctx);
    const { db, c, body } = ctx;
    const hr = await one(db, `SELECT * FROM pr_emp_hr WHERE client_id = ? AND emp_id = ?`, c, String(body.empId || ''));
    const s = await getSettings(db, c);
    out.employee.hr = hr ? { ...hr, branch_ids: safeJson(hr.branch_ids, []) } : null;
    out.employee.salary_state = hr ? hr.salary_state : 'set';
    out.employee.flags = employmentFlags(await one(db, `SELECT * FROM pr_employees WHERE client_id = ? AND emp_id = ?`, c, String(body.empId || '')), hr, localDay(Date.now(), s.tz), s.warn_days);
    const meta = await all(db, `SELECT line_id, effective_from, effective_to, period, reference, reason, approval FROM pr_line_meta WHERE client_id = ? AND emp_id = ?`, c, String(body.empId || ''));
    out.lineMeta = Object.fromEntries(meta.map((m) => [m.line_id, m]));
    return out;
  };
  A['employee.list'] = async ({ db, c, who, body }) => {
    need(who, ...PERMS);
    const rows = await all(db, `SELECT e.*, h.cadre, h.designation, h.supervisor_name, h.employment_basis, h.work_schedule, h.end_date, h.internship_months, h.salary_state, h.branch_ids FROM pr_employees e LEFT JOIN pr_emp_hr h ON h.client_id = e.client_id AND h.emp_id = e.emp_id WHERE e.client_id = ? ORDER BY CASE e.status WHEN 'active' THEN 0 WHEN 'on_leave' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END, e.name COLLATE NOCASE`, c);
    const s = await getSettings(db, c), today = localDay(Date.now(), s.tz);
    const q = String(body.q || '').toLowerCase().trim();
    const eq = (a, b) => !b || String(a || '').toLowerCase() === String(b).toLowerCase();
    const personal = can(who, 'staff');
    const list = [];
    for (const r of rows) {
      const hr = r.employment_basis ? { employment_basis: r.employment_basis, work_schedule: r.work_schedule, end_date: r.end_date } : null;
      const flags = employmentFlags(r, hr, today, s.warn_days);
      if (q && ![r.name, r.emp_no, r.job_title, r.phone, r.cadre, r.department].some((x) => String(x || '').toLowerCase().includes(q))) continue;
      if (!eq(r.cadre, body.cadre) || !eq(r.department, body.department) || !eq(r.branch_name, body.branch) || !eq(flags.basis, body.employment_basis) || !eq(flags.schedule, body.work_schedule)) continue;
      if (body.status && body.status !== 'all' && r.status !== body.status && flags.lifecycle !== body.status) continue;
      if (body.endBefore && !(flags.end_date && flags.end_date <= body.endBefore)) continue;
      if (body.endAfter && !(flags.end_date && flags.end_date >= body.endAfter)) continue;
      const o = {
        emp_id: r.emp_id, emp_no: r.emp_no, name: r.name, phone: r.phone, job_title: r.job_title, department: r.department, branch_name: r.branch_name, start_date: r.start_date, status: r.status, pos_staff_id: r.pos_staff_id,
        pay_frequency: r.pay_frequency, cadre: r.cadre || null, designation: r.designation || null, supervisor_name: r.supervisor_name || null, employment_type: r.employment_type,
        employment_basis: flags.basis, work_schedule: flags.schedule, end_date: flags.end_date, internship_months: r.internship_months, lifecycle: flags.lifecycle, days_left: flags.days_left, remaining: flags.remaining,
        salary_state: r.salary_state || 'set', branch_ids: safeJson(r.branch_ids, []),
        id_number_masked: maskId(r.id_number),
      };
      if (sensitiveOk(who)) { o.basic_pay = r.salary_state === 'unset' ? null : r.basic_pay; o.rate_unit = r.rate_unit; }
      if (personal) o.email = r.email;
      list.push(o);
    }
    return { employees: list, filters: { cadres: [...new Set(rows.map((r) => r.cadre).filter(Boolean))].sort(), departments: [...new Set(rows.map((r) => r.department).filter(Boolean))].sort(), branches: [...new Set(rows.map((r) => r.branch_name).filter(Boolean))].sort() } };
  };

  // reports
  A['hr.report.generate'] = async ({ db, c, who, body }) => {
    need(who, 'run', 'settings');
    const kind = body.kind === 'weekly' ? 'weekly' : body.kind === 'monthly' ? 'monthly' : null;
    if (!kind) throw bad('bad_kind', 'Choose a weekly or a monthly report.');
    const s = await getSettings(db, c);
    const day = body.periodStart || null;
    if (day && !validDay(day)) throw bad('bad_date', 'Choose a valid date inside the period.');
    const period = day ? periodOf(kind, day) : lastCompletePeriod(kind, localDay(Date.now(), s.tz));
    if (period.start > localDay(Date.now(), s.tz)) throw bad('future_period', 'That period has not started yet.');
    const r = await runReportJob(db, c, kind, period, { actor: who.name || who.sid, force: !!body.force, empIds: body.empIds, settings: s });
    await auditStmt(db, c, who, body.force ? 'staff_reports_regenerated' : 'staff_reports_generated', 'report', null, { kind, period_start: period.start, ...(r.skipped ? { skipped: r.skipped } : { generated: r.generated, failed: r.failed }) }).run();
    return { period, result: r };
  };
  A['hr.report.retry'] = async ({ db, c, who, body }) => {
    need(who, 'run', 'settings');
    const kind = body.kind === 'weekly' ? 'weekly' : 'monthly';
    if (!validDay(body.periodStart)) throw bad('bad_date', 'Choose the period to retry.');
    const period = periodOf(kind, body.periodStart);
    await db.prepare(`UPDATE pr_report_jobs SET status = 'pending' WHERE client_id = ? AND period_kind = ? AND period_start = ? AND status <> 'ok'`).bind(c, kind, period.start).run();
    const r = await runReportJob(db, c, kind, period, { actor: who.name || who.sid });
    return { period, result: r };
  };
  A['hr.report.list'] = async ({ db, c, who, body }) => {
    need(who, ...PERMS);
    const kind = body.kind === 'weekly' ? 'weekly' : 'monthly';
    const day = body.periodStart && validDay(body.periodStart) ? body.periodStart : null;
    const where = [`r.client_id = ?`, `r.period_kind = ?`], args = [c, kind];
    if (day) { where.push(`r.period_start = ?`); args.push(periodOf(kind, day).start); }
    if (body.empId) { where.push(`r.emp_id = ?`); args.push(String(body.empId)); }
    const rows = await all(db, `SELECT r.report_id, r.emp_id, r.period_kind, r.period_start, r.period_end, r.version, r.generated_at, r.generated_by, r.tz, e.name, e.emp_no FROM pr_reports r JOIN pr_employees e ON e.client_id = r.client_id AND e.emp_id = r.emp_id WHERE ${where.join(' AND ')} AND r.version = (SELECT MAX(version) FROM pr_reports x WHERE x.client_id = r.client_id AND x.emp_id = r.emp_id AND x.period_kind = r.period_kind AND x.period_start = r.period_start) ORDER BY r.period_start DESC, e.name COLLATE NOCASE LIMIT 300`, ...args);
    return { reports: rows };
  };
  A['hr.report.get'] = async ({ db, c, who, body }) => {
    need(who, ...PERMS);
    const r = await one(db, `SELECT r.*, e.name, e.emp_no FROM pr_reports r JOIN pr_employees e ON e.client_id = r.client_id AND e.emp_id = r.emp_id WHERE r.client_id = ? AND r.report_id = ?`, c, String(body.reportId || ''));
    if (!r) throw bad('not_found', 'That report was not found.', 404);
    const versions = await all(db, `SELECT report_id, version, generated_at, generated_by FROM pr_reports WHERE client_id = ? AND emp_id = ? AND period_kind = ? AND period_start = ? ORDER BY version DESC`, c, r.emp_id, r.period_kind, r.period_start);
    return { report: { report_id: r.report_id, emp_id: r.emp_id, name: r.name, emp_no: r.emp_no, period_kind: r.period_kind, period_start: r.period_start, period_end: r.period_end, version: r.version, generated_at: r.generated_at, generated_by: r.generated_by, tz: r.tz, data: redactReport(safeJson(r.data, {}), sensitiveOk(who)) }, versions };
  };
  A['hr.report.dashboard'] = async ({ db, c, who }) => {
    need(who, ...PERMS);
    const s = await getSettings(db, c), today = localDay(Date.now(), s.tz);
    const jobs = await all(db, `SELECT period_kind, period_start, period_end, status, attempts, generated, failed, last_error, started_at, finished_at FROM pr_report_jobs WHERE client_id = ? ORDER BY period_start DESC, period_kind LIMIT 24`, c);
    const due = ['weekly', 'monthly'].map((kind) => ({ kind, enabled: s[kind], ...lastCompletePeriod(kind, today) }));
    return { settings: s, today, jobs, due };
  };
}
