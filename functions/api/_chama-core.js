// functions/api/_chama-core.js — Chama (zip 217). The pure parts and the shared plumbing: the M-Pesa message reader, money and date helpers,
// the group settings, contribution cycles, member positions (always re-derived from the ledger) and sign-in. The actions are in _chama.js.
import { CHAMA_SCHEMA, CHAMA_SCHEMA_VERSION, CHAMA_UPGRADES } from './_chama-schema.js';
import { hashPassword, checkPassword } from './_password.js';

// ---------- errors ----------
export class ChamaError extends Error {
  constructor(error, code = 'bad_request', status = 400) { super(error); this.error = error; this.code = code; this.status = status; }
}
export const fail = (msg, code, status) => { throw new ChamaError(msg, code, status); };

// ---------- schema ----------
const ready = new WeakMap();
export async function ensureChamaSchema(db) {
  if (!db) return false;
  if (ready.get(db)) return true;
  let ok = false;
  try { const r = await db.prepare(`SELECT v FROM chama_meta WHERE k = 'schema'`).first(); ok = !!(r && Number(r.v) >= CHAMA_SCHEMA_VERSION); } catch (e) { ok = false; }
  if (!ok) {
    await db.batch(CHAMA_SCHEMA.map((s) => db.prepare(s)));
    // zip 230: bring a database made by an older release up to date (add any missing column; harmless when it is already there)
    for (const [table, col, def] of CHAMA_UPGRADES) {
      const have = await db.prepare(`SELECT 1 AS x FROM pragma_table_info('${table}') WHERE name = ?`).bind(col).first();
      if (!have) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
    }
    await db.prepare(`INSERT INTO chama_meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(CHAMA_SCHEMA_VERSION)).run();
  }
  ready.set(db, true);
  return true;
}

// ---------- small helpers ----------
export const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
export const EAT_MS = 3 * 3600 * 1000;
export const todayKey = (now = Date.now()) => new Date(now + EAT_MS).toISOString().slice(0, 10);
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s + 'T00:00:00Z'));
export const text = (v, max = 400) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
export const rows = (r) => (r && r.results) || [];

// Money: whole cents. Accepts 6000, "6,000", "6000.50", "Ksh 6,000" -> 600000. Anything else -> NaN.
export function toCents(v) {
  if (typeof v === 'number') return isFinite(v) ? Math.round(v * 100) : NaN;
  const s = String(v == null ? '' : v).replace(/ksh|kes|\s|,/gi, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}
export const kes = (cents) => 'KES ' + (Math.round(Number(cents) || 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: (Number(cents) || 0) % 100 ? 2 : 0, maximumFractionDigits: 2 });

// Kenyan phone numbers -> 2547XXXXXXXX / 2541XXXXXXXX (one canonical form, so 0712..., +254712... and 254712... are the same person)
export function normPhone(v) {
  let d = String(v == null ? '' : v).replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^0[17]\d{8}$/.test(d)) d = '254' + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
  return /^254[17]\d{8}$/.test(d) ? d : '';
}
export const showPhone = (p) => (/^254\d{9}$/.test(p) ? '0' + p.slice(3) : p);

// ---------- dates ----------
const dayNum = (s) => Math.floor(Date.parse(s + 'T00:00:00Z') / 86400000);
const fromDayNum = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
export const addDays = (s, n) => fromDayNum(dayNum(s) + n);
export function addMonths(s, n, anchorDay) {
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)) - 1, d = anchorDay || Number(s.slice(8, 10));
  const t = y * 12 + m + n, ny = Math.floor(t / 12), nm = t % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const niceDate = (s, withYear = false) => (isDate(s) ? `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1]}${withYear ? ' ' + s.slice(0, 4) : ''}` : '');

// ---------- the M-Pesa message reader ----------
// A convenience, not proof: the treasurer still verifies the money. Only the fields needed to verify the payment leave this function;
// the balance, the daily limit, the short link and everything else in the message are dropped here and never stored or shown.
export function parseMpesa(input) {
  const raw = String(input == null ? '' : input).replace(/\s+/g, ' ').trim();
  if (!raw) return { ok: false, error: 'Paste your M-Pesa confirmation message first.' };
  if (raw.length > 1500) return { ok: false, error: 'That is too long to be one M-Pesa message.' };
  // the transaction code: ten letters/digits that start the message (or sit right before "Confirmed")
  let code = null;
  let m = raw.match(/\b([A-Za-z][A-Za-z0-9]{9})\b(?=\s*\.?\s*confirmed)/i);
  if (!m) m = raw.match(/^\s*([A-Za-z][A-Za-z0-9]{9})\b/);
  if (m && /\d/.test(m[1]) && /[A-Za-z]/.test(m[1])) code = m[1].toUpperCase();
  if (!code) return { ok: false, error: 'I could not find the M-Pesa transaction code (10 letters and numbers at the start of the message).' };
  // the amount: the first Ksh/KES figure after the code (the money moved, not the balance that follows it)
  const after = raw.slice(raw.toUpperCase().indexOf(code) + code.length);
  const am = after.match(/(?:ksh|kes|kshs)\.?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const amountCents = am ? toCents(am[1]) : NaN;
  if (!am || !isFinite(amountCents) || amountCents <= 0) return { ok: false, error: 'I could not find the amount in that message.' };
  // the date (day/month/year, as Kenyan messages write it) and the time
  let date = '', time = '';
  const dm = after.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (dm) {
    const dd = Number(dm[1]), mm = Number(dm[2]); let yy = Number(dm[3]); if (yy < 100) yy += 2000;
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) { const iso = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`; if (isDate(iso)) date = iso; }
  }
  const tm = after.match(/\bat\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i) || after.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
  if (tm) {
    let hh = Number(tm[1]); const mi = Number(tm[2]), ap = (tm[3] || '').toUpperCase();
    if (ap === 'PM' && hh < 12) hh += 12; if (ap === 'AM' && hh === 12) hh = 0;
    if (hh <= 23 && mi <= 59) time = `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  }
  // who it went to (only the name — never a balance or a number)
  let recipient = '';
  const rm = after.match(/(?:sent to|paid to|transferred to|received from)\s+(.+?)(?:\s+\d{9,}|\s+on\s+\d|\s+for account|\s*\.\s+on\s|\.\s*$)/i);
  if (rm) recipient = text(rm[1].replace(/[^A-Za-z0-9 .&'\-]/g, ''), 60);
  return { ok: true, code, amountCents, date, time, recipient };
}
export const time12 = (t) => { const m = /^(\d{2}):(\d{2})$/.exec(t || ''); if (!m) return ''; let h = Number(m[1]); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${m[2]} ${ap}`; };

// ---------- the group's configuration ----------
export const DEFAULTS = {
  contribution: { enabled: true, amountCents: 0, freq: 'monthly', every: 1, unit: 'month', startDate: '', fundId: '' },
  features: { meetings: true, mgr: false, loans: false, fundraising: true, penalties: false },
  meeting: { everyDays: 0 },
  penalties: { missedMeeting: { enabled: false, amountCents: 0, repeatAmountCents: 0, repeatAfter: 0 }, lateContribution: { enabled: false, amountCents: 0 } },
  loans: { interestPct: 0, maxMultiple: 0, guarantors: 0, defaultMonths: 3 },
  privacy: { membersSeeTotals: false, showRecipient: true, showSignInNames: true },
  payInstructions: '',
  paymentTo: '',
  chama: { startedOn: '', description: '', ongoing: false, trackedFrom: '' },   // zip 230: when the chama really began, and the day it started being tracked here
};
export const FREQS = { daily: [1, 'day'], weekly: [1, 'week'], biweekly: [2, 'week'], monthly: [1, 'month'], bimonthly: [2, 'month'], quarterly: [3, 'month'], none: [0, 'none'] };
function merge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (extra && typeof extra === 'object') for (const k of Object.keys(base)) {
    if (!(k in extra)) continue;
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], extra[k]);
    else if (typeof base[k] === typeof extra[k]) out[k] = extra[k];
  }
  return out;
}
export function readSettings(json) { let o = {}; try { o = JSON.parse(json || '{}') || {}; } catch (e) { o = {}; } return merge(DEFAULTS, o); }
// -> the cleaned settings (numbers made sane, frequency resolved to every/unit); throws a plain message when something does not make sense
export function cleanSettings(input, current) {
  const s = merge(current || DEFAULTS, input || {});
  const c = s.contribution;
  c.amountCents = Math.max(0, Math.round(Number(c.amountCents) || 0));
  if (!(c.freq in FREQS) && c.freq !== 'custom') c.freq = 'monthly';
  if (c.freq in FREQS) { c.every = FREQS[c.freq][0]; c.unit = FREQS[c.freq][1]; }
  else { c.every = Math.max(1, Math.min(365, Math.round(Number(c.every) || 1))); if (!['day', 'week', 'month'].includes(c.unit)) fail('Choose days, weeks or months for the contribution period.'); }
  if (c.startDate && !isDate(c.startDate)) fail('The first contribution period needs a real start date.');
  s.meeting.everyDays = Math.max(0, Math.min(365, Math.round(Number(s.meeting.everyDays) || 0)));
  const p = s.penalties;
  p.missedMeeting.amountCents = Math.max(0, Math.round(Number(p.missedMeeting.amountCents) || 0)); p.missedMeeting.repeatAmountCents = Math.max(0, Math.round(Number(p.missedMeeting.repeatAmountCents) || 0)); p.missedMeeting.repeatAfter = Math.max(0, Math.round(Number(p.missedMeeting.repeatAfter) || 0));
  p.lateContribution.amountCents = Math.max(0, Math.round(Number(p.lateContribution.amountCents) || 0));
  s.loans.interestPct = Math.max(0, Math.min(100, Number(s.loans.interestPct) || 0)); s.loans.guarantors = Math.max(0, Math.min(10, Math.round(Number(s.loans.guarantors) || 0)));
  s.loans.maxMultiple = Math.max(0, Math.min(100, Number(s.loans.maxMultiple) || 0)); s.loans.defaultMonths = Math.max(1, Math.min(60, Math.round(Number(s.loans.defaultMonths) || 3)));
  s.payInstructions = text(s.payInstructions, 400); s.paymentTo = text(s.paymentTo, 80);
  return s;
}

// ---------- context + audit ----------
export const statement = (ctx, sql, ...args) => ctx.db.prepare(sql).bind(...args);
export async function loadGroup(ctx) {
  if (ctx.group) return ctx.group;
  const r = await ctx.db.prepare('SELECT client_id, name, settings, created_at FROM chama_group WHERE client_id = ?').bind(ctx.c).first();
  ctx.group = r ? { name: r.name, settings: readSettings(r.settings), created_at: r.created_at } : null;
  return ctx.group;
}
export const auditStmt = (ctx, action, record, before, after) => ctx.db.prepare('INSERT INTO chama_audit (client_id, ts, actor_id, actor_name, action, record, before_json, after_json) VALUES (?,?,?,?,?,?,?,?)')
  .bind(ctx.c, Date.now(), ctx.me ? ctx.me.id : null, ctx.me ? ctx.me.name : 'system', text(action, 200), text(record, 120), before == null ? null : JSON.stringify(before).slice(0, 2000), after == null ? null : JSON.stringify(after).slice(0, 2000));
export const noteStmt = (ctx, memberId, kind, title, body) => ctx.db.prepare('INSERT INTO chama_message (client_id, id, member_id, kind, title, body, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
  .bind(ctx.c, uid(), memberId || null, kind, text(title, 120), text(body, 1000), ctx.me ? ctx.me.id : null, Date.now());

// ---------- funds ----------
export const FUND_NAMES = { main: 'Main Contributions', welfare: 'Welfare', emergency: 'Emergency', investment: 'Investment', development: 'Development', loan: 'Loan Fund', mgr: 'Merry-Go-Round', fundraising: 'Fundraising', other: 'Other' };
export async function fundFor(ctx, kind) {
  const r = await ctx.db.prepare('SELECT id FROM chama_fund WHERE client_id = ? AND kind = ? AND active = 1 ORDER BY rowid LIMIT 1').bind(ctx.c, kind).first();
  if (r) return r.id;
  const id = uid();
  await ctx.db.prepare('INSERT INTO chama_fund (client_id, id, name, kind, active) VALUES (?,?,?,?,1)').bind(ctx.c, id, FUND_NAMES[kind] || 'Other', kind).run();
  return id;
}

// ---------- contribution cycles ----------
// The period that starts k periods after `anchor`.
export function periodStart(anchor, every, unit, k) {
  if (unit === 'day') return addDays(anchor, every * k);
  if (unit === 'week') return addDays(anchor, 7 * every * k);
  return addMonths(anchor, every * k, Number(anchor.slice(8, 10)));
}
export function cycleBounds(anchor, every, unit, k) { const s = periodStart(anchor, every, unit, k); return { start: s, end: addDays(periodStart(anchor, every, unit, k + 1), -1) }; }
export function cycleLabel(start, end) { const sy = start.slice(0, 4), ey = end.slice(0, 4); return `${niceDate(start, sy !== ey)} – ${niceDate(end, true)}`; }

// Make sure every period from the first one up to today has a cycle, and that every active member owes for it. Safe to call as often as you like.
export async function ensureCycles(ctx) {
  const g = await loadGroup(ctx); if (!g) return;
  const c = g.settings.contribution;
  if (!c.enabled || !c.amountCents || c.freq === 'none' || !c.startDate) return;
  const today = todayKey(), fundId = c.fundId || await fundFor(ctx, 'main');
  let k = 0, made = 0;
  const have = new Set(rows(await ctx.db.prepare('SELECT start_date FROM chama_cycle WHERE client_id = ? AND fund_id = ?').bind(ctx.c, fundId).all()).map((r) => r.start_date));
  for (; k < 240; k++) {
    const b = cycleBounds(c.startDate, c.every, c.unit, k);
    if (b.start > today) break;
    if (have.has(b.start)) continue;
    if (made >= 60) break;
    const id = uid();
    await ctx.db.batch([
      ctx.db.prepare('INSERT OR IGNORE INTO chama_cycle (client_id, id, fund_id, label, start_date, end_date, required_cents, created_at) VALUES (?,?,?,?,?,?,?,?)').bind(ctx.c, id, fundId, cycleLabel(b.start, b.end), b.start, b.end, c.amountCents, Date.now()),
      ctx.db.prepare(`INSERT OR IGNORE INTO chama_obligation (client_id, cycle_id, member_id, required_cents)
        SELECT ?, cy.id, m.id, cy.required_cents FROM chama_cycle cy JOIN chama_member m ON m.client_id = cy.client_id AND m.status = 'active' WHERE cy.client_id = ? AND cy.fund_id = ? AND cy.start_date = ?`).bind(ctx.c, ctx.c, fundId, b.start),
    ]);
    made++;
  }
}
export async function currentCycle(ctx) {
  const today = todayKey();
  return await ctx.db.prepare('SELECT id, fund_id, label, start_date, end_date, required_cents FROM chama_cycle WHERE client_id = ? AND start_date <= ? AND end_date >= ? ORDER BY start_date DESC LIMIT 1').bind(ctx.c, today, today).first();
}
export const statusOf = (req, paid) => (req <= 0 || paid >= req ? 'complete' : paid > 0 ? 'partial' : 'not_started');

// One member's standing in one cycle (derived from the ledger, never from a stored total)
export async function cyclePosition(ctx, cycleId, memberId) {
  const r = await ctx.db.prepare(`SELECT o.required_cents AS req, COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = o.client_id AND l.kind = 'contribution' AND l.ref_type = 'cycle' AND l.ref_id = o.cycle_id AND l.member_id = o.member_id), 0) AS paid
    FROM chama_obligation o WHERE o.client_id = ? AND o.cycle_id = ? AND o.member_id = ?`).bind(ctx.c, cycleId, memberId).first();
  if (!r) return null;
  return { requiredCents: r.req, paidCents: r.paid, remainingCents: Math.max(0, r.req - r.paid), extraCents: Math.max(0, r.paid - r.req), status: statusOf(r.req, r.paid) };
}
// Everything a member owes from finished cycles (their arrears)
export async function arrears(ctx, memberId) {
  const r = await ctx.db.prepare(`SELECT COALESCE(SUM(MAX(o.required_cents - COALESCE(p.paid, 0), 0)), 0) AS owed
    FROM chama_obligation o JOIN chama_cycle cy ON cy.client_id = o.client_id AND cy.id = o.cycle_id
    LEFT JOIN (SELECT ref_id, member_id, SUM(amount_cents) AS paid FROM chama_ledger WHERE client_id = ? AND kind = 'contribution' AND ref_type = 'cycle' AND member_id = ? GROUP BY ref_id, member_id) p ON p.ref_id = o.cycle_id AND p.member_id = o.member_id
    WHERE o.client_id = ? AND o.member_id = ? AND cy.end_date < ?`).bind(ctx.c, memberId, ctx.c, memberId, todayKey()).first();
  return r ? r.owed : 0;
}
export async function totalContributed(ctx, memberId) {
  const r = await ctx.db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS t FROM chama_ledger WHERE client_id = ? AND member_id = ? AND kind = 'contribution'`).bind(ctx.c, memberId).first();
  return r ? r.t : 0;
}
// A payment is applied to the oldest unpaid period first; anything left over goes on the current one (paid ahead). -> [{ cycleId, cents }]
export async function allocateContribution(ctx, memberId, cents) {
  const open = rows(await ctx.db.prepare(`SELECT o.cycle_id AS id, MAX(o.required_cents - COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = o.client_id AND l.kind = 'contribution' AND l.ref_type = 'cycle' AND l.ref_id = o.cycle_id AND l.member_id = o.member_id), 0), 0) AS rem
    FROM chama_obligation o JOIN chama_cycle cy ON cy.client_id = o.client_id AND cy.id = o.cycle_id WHERE o.client_id = ? AND o.member_id = ? AND cy.start_date <= ? ORDER BY cy.start_date`).bind(ctx.c, memberId, todayKey()).all());
  const out = []; let left = cents;
  for (const o of open) { if (left <= 0) break; if (o.rem > 0) { const take = Math.min(left, o.rem); out.push({ cycleId: o.id, cents: take }); left -= take; } }
  if (left > 0) {
    const cur = await currentCycle(ctx);
    const last = cur ? cur.id : (open.length ? open[open.length - 1].id : null);
    if (last) { const hit = out.find((x) => x.cycleId === last); if (hit) hit.cents += left; else out.push({ cycleId: last, cents: left }); } else out.push({ cycleId: null, cents: left });
  }
  return out;
}

// ---------- sign-in: phone + PIN, remembered devices ----------
const PIN_RE = /^\d{4,6}$/;
export const pinProblem = (pin) => (PIN_RE.test(String(pin || '')) ? '' : 'The PIN must be 4 to 6 digits.');
export async function sha256Hex(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))); return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join(''); }
export const hashPin = async (pin) => (await hashPassword(String(pin))).passwordHash;
export const checkPin = (hash, pin) => checkPassword({ passwordHash: hash }, String(pin));
export function newToken() { const a = new Uint8Array(32); crypto.getRandomValues(a); let s = ''; a.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export const DEVICE_DAYS = 90, SESSION_HOURS = 12, MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
export async function openDevice(ctx, memberId, remember, label) {
  const token = newToken(), id = uid(), now = Date.now();
  await ctx.db.prepare('INSERT INTO chama_device (client_id, id, member_id, token_hash, label, created_at, last_seen, expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(ctx.c, id, memberId, await sha256Hex(token), text(label, 80) || 'A phone', now, now, now + (remember ? DEVICE_DAYS * 86400000 : SESSION_HOURS * 3600000)).run();
  return { token, deviceId: id, remember: !!remember };
}
// -> the signed-in member (active, device not revoked or expired) or null
export async function memberFromToken(ctx, token) {
  if (!token || typeof token !== 'string' || token.length < 30) return null;
  const hash = await sha256Hex(token), now = Date.now();
  const r = await ctx.db.prepare(`SELECT d.id AS device_id, d.expires_at, d.last_seen, d.created_at, m.id, m.name, m.phone, m.role, m.roles, m.perms, m.status, m.must_change_pin
    FROM chama_device d JOIN chama_member m ON m.client_id = d.client_id AND m.id = d.member_id WHERE d.client_id = ? AND d.token_hash = ? AND d.revoked_at IS NULL`).bind(ctx.c, hash).first();
  if (!r || r.status !== 'active' || r.expires_at <= now) return null;
  if (now - r.last_seen > 3600000) {   // keep a remembered device alive while it is used (rolling): touch it at most once an hour
    const span = r.expires_at - r.created_at;
    await ctx.db.prepare('UPDATE chama_device SET last_seen = ?, expires_at = MAX(expires_at, ?) WHERE client_id = ? AND id = ?').bind(now, now + Math.min(span, DEVICE_DAYS * 86400000), ctx.c, r.device_id).run();
  }
  let perms = []; try { perms = JSON.parse(r.perms || '[]'); } catch (e) { perms = []; }
  const roles = rolesOf(r);
  return { id: r.id, name: r.name, phone: r.phone, role: r.role, roles, perms: roles.includes('admin') ? ['*'] : perms, mustChangePin: !!r.must_change_pin, deviceId: r.device_id };
}
export const can = (me, perm) => !!me && (me.perms.includes('*') || me.perms.includes(perm));
export const ROLE_PERMS = {
  admin: ['*'],
  secretary: ['members', 'meetings', 'messages', 'payments', 'reports', 'penalties', 'mgr'],
  treasurer: ['payments', 'money', 'loans', 'penalties', 'reports', 'messages', 'mgr'],
  chairperson: ['members', 'meetings', 'messages', 'payments', 'loans', 'reports', 'mgr'],   // zip 230
  member: [],
};
export const ALL_PERMS = ['members', 'meetings', 'messages', 'payments', 'money', 'loans', 'penalties', 'reports', 'audit', 'mgr'];
// zip 230: one person can hold several roles (Member + Secretary + Chairperson...). The database column `role` keeps the main one
// (admin / secretary / treasurer / member); `roles` (JSON) keeps the others, so Chairperson lives there. Permissions are the union of every role.
export const ROLE_NAMES = ['admin', 'secretary', 'treasurer', 'chairperson', 'member'];
export function parseRoles(json) { try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a.filter((x) => ROLE_NAMES.includes(x) && x !== 'member') : []; } catch (e) { return []; } }
export const rolesOf = (row) => { const out = []; [row && row.role].concat(parseRoles(row && row.roles)).forEach((r) => { if (r && r !== 'member' && !out.includes(r)) out.push(r); }); return out; };
export function splitRoles(list) {
  const want = (Array.isArray(list) ? list : [list]).map(String).filter((x, i, a) => ROLE_NAMES.includes(x) && x !== 'member' && a.indexOf(x) === i);
  const main = ['admin', 'secretary', 'treasurer'].find((r) => want.includes(r)) || 'member';
  return { role: main, roles: want.filter((r) => r !== main), all: want };
}
export const permsForRoles = (roles) => [...new Set(roles.flatMap((r) => (ROLE_PERMS[r] || []).filter((x) => x !== '*')))];
// who may run the merry-go-round (secretary, treasurer, chairperson, admin - or anyone given the permission)
export const canMgr = (me) => can(me, 'mgr') || can(me, 'money') || can(me, 'payments');
