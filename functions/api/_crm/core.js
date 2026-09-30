// functions/api/_crm/core.js — shared helpers of the CRM (NOT a route): errors, ids, time (Africa/Nairobi), SQL statement builders,
// validation, phone/e-mail normalisation, CSV, audit / activity / notification statements.
export class HttpError extends Error {
  constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra || null; }
}
export const E = {
  bad: (message, code = 'bad_request', extra) => new HttpError(400, code, message, extra),
  unauthorized: (message = 'Sign in required', code = 'unauthorized') => new HttpError(401, code, message),
  forbidden: (message = 'You do not have permission to do that', code = 'forbidden') => new HttpError(403, code, message),
  notFound: (message = 'Not found', code = 'not_found') => new HttpError(404, code, message),
  conflict: (message, code = 'conflict', extra) => new HttpError(409, code, message, extra),
  tooMany: (message = 'Too many requests', code = 'rate_limited') => new HttpError(429, code, message),
};

export const now = () => Date.now();
export const newId = () => crypto.randomUUID();
export const DAY = 86400000;
export const NAIROBI_MS = 3 * 3600000;

// ---------- SQL ----------
const nz = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
export const st = (db, sql, ...args) => db.prepare(sql).bind(...nz(args));
export const all = async (db, sql, ...args) => (await st(db, sql, ...args).all()).results || [];
export const first = async (db, sql, ...args) => (await st(db, sql, ...args).first()) || null;
export const run = async (db, sql, ...args) => st(db, sql, ...args).run();
export const changes = (r) => Number((r && r.meta && r.meta.changes) || 0);
export const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');
export const jparse = (s, d = null) => { if (s == null || s === '') return d; try { return JSON.parse(s); } catch (e) { return d; } };
export const jstr = (v) => (v == null ? null : JSON.stringify(v));

// ---------- time (business day = Africa/Nairobi, UTC+3, no DST) ----------
export const nairobiDay = (ts = now()) => new Date(ts + NAIROBI_MS).toISOString().slice(0, 10);
export const dayStart = (day) => Date.parse(day + 'T00:00:00+03:00');
export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(dayStart(s)) && nairobiDay(dayStart(s)) === s;
export const addDays = (day, n) => nairobiDay(dayStart(day) + n * DAY);
// -> { from, to (exclusive), fromDay, toDay (inclusive), range }
export function rangeFor(range, fromQ, toQ, at = now()) {
  const today = nairobiDay(at);
  let f, t; // inclusive days
  switch (range || 'today') {
    case 'today': f = t = today; break;
    case 'yesterday': f = t = addDays(today, -1); break;
    case 'week': { const dow = (new Date(dayStart(today) + NAIROBI_MS).getUTCDay() + 6) % 7; f = addDays(today, -dow); t = today; break; }
    case '7d': f = addDays(today, -6); t = today; break;
    case 'month': f = today.slice(0, 8) + '01'; t = today; break;
    case 'lastmonth': {
      const first = today.slice(0, 8) + '01';
      t = addDays(first, -1); f = t.slice(0, 8) + '01'; break;
    }
    case 'custom': {
      if (!isDay(fromQ) || !isDay(toQ)) throw E.bad('custom range needs from and to as YYYY-MM-DD', 'invalid_range');
      f = fromQ; t = toQ; break;
    }
    default: throw E.bad('unknown range', 'invalid_range');
  }
  if (t < f) throw E.bad('from must not be after to', 'invalid_range');
  if ((dayStart(t) - dayStart(f)) / DAY > 800) throw E.bad('range too long', 'invalid_range');
  return { range: range || 'today', from: dayStart(f), to: dayStart(t) + DAY, fromDay: f, toDay: t };
}
// optional ?from=&?to= (days, inclusive); either may be missing
export function optRange(fromQ, toQ) {
  const o = { from: null, to: null };
  if (fromQ) { if (!isDay(fromQ)) throw E.bad('from must be YYYY-MM-DD', 'invalid_range'); o.from = dayStart(fromQ); }
  if (toQ) { if (!isDay(toQ)) throw E.bad('to must be YYYY-MM-DD', 'invalid_range'); o.to = dayStart(toQ) + DAY; }
  if (o.from != null && o.to != null && o.to <= o.from) throw E.bad('from must not be after to', 'invalid_range');
  return o;
}
// a timestamp field from a client: epoch ms number or ISO string
export function tsIn(v, name = 'time') {
  let t = null;
  if (typeof v === 'number' && Number.isFinite(v)) t = Math.round(v);
  else if (typeof v === 'string' && v.trim()) t = /^\d{10,}$/.test(v.trim()) ? Number(v.trim()) : Date.parse(v);
  if (!Number.isFinite(t) || t < 946684800000 || t > 4102444800000) throw E.bad(`${name} is not a valid date/time`, 'invalid_time');
  return t;
}

// ---------- text / validation ----------
export function text(v, max = 200) {
  if (v == null) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return s ? s.slice(0, max) : null;
}
// A plain address only: no query / fragment / quote characters, so it is safe to put in a mailto: link (mailto:a@b.co?bcc=x is a header-injection vector).
export const email = (v) => { const s = text(v, 254); if (!s) return null; const e = s.toLowerCase(); return /^[a-z0-9._%+'\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)*\.[a-z]{2,}$/.test(e) && !e.includes("'") ? e : false; };
// -> normalised digits (E.164 without '+', Kenya default 254), null when blank, false when invalid
export function phoneNorm(v) {
  const raw = text(v, 40);
  if (!raw) return null;
  if (/[^\d+\s()\-.]/.test(raw)) return false;
  const plus = raw.startsWith('+');
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (!plus && d.startsWith('0') && d.length === 10) d = '254' + d.slice(1);
  else if (!plus && d.length === 9 && /^[17]/.test(d)) d = '254' + d;
  else if (d.startsWith('2540') && d.length === 13) d = '254' + d.slice(4);
  if (d.startsWith('254')) return /^254[17]\d{8}$/.test(d) ? d : false;
  if (d.length < 8 || d.length > 15) return false;
  if (!plus && d.length < 11) return false;
  return d;
}
export const phoneDisplay = (norm) => (norm ? '+' + norm : null);
export const oneOf = (v, list, name) => { if (!list.includes(v)) throw E.bad(`${name} must be one of ${list.join(', ')}`, 'invalid_' + name); return v; };
export const int = (v, name, { min = -Infinity, max = Infinity, dflt } = {}) => {
  if (v == null || v === '') { if (dflt !== undefined) return dflt; throw E.bad(`${name} is required`, 'invalid_' + name); }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw E.bad(`${name} must be a whole number between ${min} and ${max}`, 'invalid_' + name);
  return n;
};
export const money = (v, name, { dflt } = {}) => {
  if (v == null || v === '') { if (dflt !== undefined) return dflt; throw E.bad(`${name} is required`, 'invalid_' + name); }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e10) throw E.bad(`${name} must be a number >= 0`, 'invalid_' + name);
  return Math.round(n * 100) / 100;
};
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const arr = (v, max = 500) => (Array.isArray(v) ? v.slice(0, max) : []);
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
// an id from a client: a short string or null (an object / array / number never reaches a SQL bind)
export const idStr = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null);
// "KES 15,000" / "15 000.50" / 15000 -> number, null when blank, false when it is not a non-negative amount
export function moneyLoose(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= 1e10 ? Math.round(v * 100) / 100 : false;
  const s = String(v).trim().replace(/^(kes|ksh|ksh\.|kshs|\$|usd)\s*/i, '').replace(/[,\s]/g, '');
  if (!s) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return false;
  const n = Number(s);
  return n <= 1e10 ? Math.round(n * 100) / 100 : false;
}
// a calendar date typed by a person: YYYY-MM-DD (optionally + time) or DD/MM/YYYY -> 'YYYY-MM-DD' | null (blank) | false (invalid)
export function dayLoose(v) {
  const s = text(v, 40);
  if (!s) return null;
  let y, m, d, m1;
  if ((m1 = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s))) { y = +m1[1]; m = +m1[2]; d = +m1[3]; }
  else if ((m1 = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})(?:[T\s].*)?$/.exec(s))) { d = +m1[1]; m = +m1[2]; y = +m1[3]; }
  else return false;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isDay(iso) ? iso : false;
}
export const like = (s) => '%' + String(s).replace(/[\\%_]/g, (c) => '\\' + c) + '%';

// ---------- statement builders (all go into ONE db.batch = one transaction) ----------
// `guard` = { sql, args }: the row is only written when the condition holds (used to chain statements to the one that won a race).
function ins(db, verb, table, cols, vals, guard) {
  const qs = cols.map(() => '?').join(',');
  if (!guard) return st(db, `${verb} INTO ${table} (${cols.join(',')}) VALUES (${qs})`, ...vals);
  return st(db, `${verb} INTO ${table} (${cols.join(',')}) SELECT ${qs} WHERE ${guard.sql}`, ...vals, ...guard.args);
}
export const auditSt = (db, actor, action, entity, entityId, prev, next, at = now(), guard) =>
  ins(db, 'INSERT', 'crm_audit', ['user_id', 'user_name', 'action', 'entity', 'entity_id', 'prev', 'next', 'ip', 'at'],
    [actor && actor.id || null, actor && actor.name || 'system', action, entity, entityId == null ? null : String(entityId), jstr(prev), jstr(next), actor && actor.ip || null, at], guard);
export const activitySt = (db, actor, leadId, type, summary, data, at = now(), guard) =>
  ins(db, 'INSERT', 'crm_activities', ['id', 'lead_id', 'user_id', 'user_name', 'type', 'summary', 'data', 'created_at'],
    [newId(), leadId, actor && actor.id || null, actor && actor.name || 'system', type, summary, jstr(data), at], guard);
export const touchLeadSt = (db, leadId, at = now(), guard) =>
  st(db, `UPDATE crm_leads SET updated_at = ?, last_activity_at = ? WHERE id = ?${guard ? ' AND ' + guard.sql : ''}`, at, at, leadId, ...(guard ? guard.args : []));
// The automation hook (spec section 50): every business event is appended to crm_events in the same transaction as the change itself.
export const emitSt = (db, actor, name, o = {}, at = now(), guard) =>
  ins(db, 'INSERT', 'crm_events', ['name', 'entity', 'entity_id', 'lead_id', 'actor_id', 'actor_name', 'data', 'at'],
    [name, o.entity || null, o.entityId == null ? null : String(o.entityId), o.leadId || null, actor && actor.id || null, actor && actor.name || null, jstr(o.data), at], guard);
export const notifySt = (db, userId, kind, title, body, o = {}) =>
  ins(db, 'INSERT OR IGNORE', 'crm_notifications', ['id', 'user_id', 'kind', 'title', 'body', 'lead_id', 'entity', 'entity_id', 'dedupe_key', 'created_at'],
    [newId(), userId, kind, String(title).slice(0, 200), body == null ? null : String(body).slice(0, 500), o.leadId || null, o.entity || null, o.entityId || null, o.dedupe || null, o.at || now()], o.guard);

// ---------- response helpers ----------
const JSON_H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_H, ...headers } });
export const errorResponse = (e, headers = {}) => {
  if (e instanceof HttpError) return json({ error: e.message, code: e.code, ...(e.extra || {}) }, e.status, headers);
  return json({ error: 'Something went wrong on the server', code: 'server_error' }, 500, headers);
};
export async function readJson(request, max = 1000000) {
  const raw = await request.text();
  if (raw.length > max) throw E.bad('request too large', 'too_large');
  if (!raw.trim()) return {};
  let v;
  try { v = JSON.parse(raw); } catch (e) { throw E.bad('body must be valid JSON', 'invalid_json'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw E.bad('body must be a JSON object', 'invalid_json');
  return v;
}
export const clientIp = (request) => (request.headers.get('CF-Connecting-IP') || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() || 'unknown').slice(0, 64);
export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const randomHex = (n = 32) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------- CSV ----------
// A cell that a spreadsheet could run as a formula (= + - @ TAB CR first) is prefixed with '. Only a cell that is nothing but a number / phone number
// ("+254 712 345 678", "-12.5") is left alone: "+1+cmd|'/C calc'!A0" starts with a digit after the sign but is still a formula.
export function csvCell(v) {
  if (v == null) return '';
  let s = typeof v === 'number' ? String(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+\-]?\d[\d\s().\-]*$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const toCsv = (columns, rows) => '﻿' + [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
export const csvResponse = (body, filename) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' } });
