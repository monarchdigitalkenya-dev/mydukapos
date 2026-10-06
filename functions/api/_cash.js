// functions/api/_cash.js — Cash Register (zip 234): the rules of the Sales Counter's cash sessions. See _cash-schema.js for the tables and what the database itself enforces.
//   One session per shop (link) + site + device, shared by every employee using that device; opened with a counted float; closed with a counted drawer.
//   Expected cash = opening float + cash sales + cash put in - cash refunds - cash expenses/payouts. Difference = counted - expected. Money is whole cents.
import { CASH_SCHEMA, CASH_SCHEMA_VERSION } from './_cash-schema.js';

export class CashError extends Error { constructor(error, code = 'bad_request', status = 400, extra = null) { super(error); this.error = error; this.code = code; this.status = status; this.extra = extra; } }
const ready = new WeakMap();
export async function ensureCashSchema(db) {
  if (!db) return false;
  if (ready.get(db)) return true;
  let ok = false;
  try { const r = await db.prepare(`SELECT v FROM cash_meta WHERE k = 'schema'`).first(); ok = !!(r && Number(r.v) >= CASH_SCHEMA_VERSION); } catch (e) { ok = false; }
  if (!ok) {
    await db.batch(CASH_SCHEMA.map((s) => db.prepare(s)));
    await db.prepare(`INSERT INTO cash_meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(CASH_SCHEMA_VERSION)).run();
  }
  ready.set(db, true);
  return true;
}

const cents = (v) => { if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return NaN; const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const kes = (c) => (c == null ? null : c / 100);
const str = (v, n = 80) => (v == null ? '' : String(v).trim().slice(0, n));
const id = (v) => { const s = String(v || '').trim(); if (!/^[A-Za-z0-9_.:-]{6,64}$/.test(s)) throw new CashError('Missing or invalid id.', 'bad_id'); return s; };
const money = (v, what, { allowZero = true } = {}) => {
  const c = cents(v);
  if (!Number.isFinite(c) || c < 0 || c > 10_000_000_00) throw new CashError(`Enter ${what} as a number (KES), zero or more.`, 'bad_amount');
  if (!allowZero && c === 0) throw new CashError(`${what[0].toUpperCase() + what.slice(1)} must be more than zero.`, 'bad_amount');
  return c;
};
const nowMs = () => Date.now();
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
let seq = 0;
const auditId = () => Date.now().toString(36).padStart(9, '0') + (seq = (seq + 1) % 1679616).toString(36).padStart(4, '0') + uid().slice(0, 6);   // sorts in the order things happened

// a session row -> what the apps see (KES, not cents)
export function view(r, extra) {
  if (!r) return null;
  const o = {
    id: r.session_id, site: r.site_id || '', device: r.device_id, deviceName: r.device_name || '', status: r.status,
    openedBy: r.opened_by, openedById: r.opened_by_id || '', openedAt: r.opened_at, openingFloat: kes(r.opening_float_cents),
  };
  if (r.status === 'closed') Object.assign(o, {
    closedBy: r.closed_by, closedById: r.closed_by_id || '', closedAt: r.closed_at, cashSales: kes(r.cash_sales_cents), nonCashSales: kes(r.noncash_sales_cents), salesCount: r.sales_count || 0,
    refunds: kes(r.refunds_cents), expenses: kes(r.expenses_cents), cashIn: kes(r.cash_in_cents), expected: kes(r.expected_cents), counted: kes(r.counted_cents), difference: kes(r.difference_cents), note: r.close_note || '',
  });
  return extra ? Object.assign(o, extra) : o;
}
const regKey = (b) => ({ site: str(b.site, 60), device: id(b.device) });

async function audit(db, c, sessionId, action, by, byId, detail) {
  await db.prepare(`INSERT INTO cash_audit (client_id, audit_id, session_id, ts, action, by_name, by_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(c, auditId(), sessionId, nowMs(), action, by, byId, detail ? JSON.stringify(detail).slice(0, 1500) : null).run();
}
const getSession = (db, c, sid) => db.prepare(`SELECT * FROM cash_sessions WHERE client_id = ? AND session_id = ?`).bind(c, sid).first();
const getOpen = (db, c, site, device) => db.prepare(`SELECT * FROM cash_sessions WHERE client_id = ? AND site_id = ? AND device_id = ? AND status = 'open'`).bind(c, site, device).first();
async function moves(db, c, sid) {
  const rs = await db.prepare(`SELECT * FROM cash_movements WHERE client_id = ? AND session_id = ? ORDER BY ts, move_id`).bind(c, sid).all();
  return (rs.results || []).map((m) => ({ id: m.move_id, at: m.ts, kind: m.kind, amount: kes(m.amount_cents), note: m.note || '', by: m.by_name || '' }));
}
// manual movements -> the totals that feed Expected Cash
export function moveTotals(list) {
  const t = { in: 0, refund: 0, expense: 0, payout: 0 };
  (list || []).forEach((m) => { t[m.kind === 'cash_in' ? 'in' : m.kind] += Math.round(m.amount * 100); });
  return t;
}

export async function handleCash(ctx) {
  const { db, c, body: b } = ctx;
  const action = String(b.action || '');
  const by = str(b.by, 60) || 'Staff', byId = str(b.byId, 60);

  if (action === 'status') {
    const { site, device } = regKey(b);
    const s = await getOpen(db, c, site, device);
    if (!s) return { session: null };
    return { session: view(s, { moves: await moves(db, c, s.session_id) }) };
  }

  if (action === 'open') {
    const { site, device } = regKey(b);
    const sid = id(b.sessionId), float = money(b.openingFloat, 'the opening float');
    const same = await getSession(db, c, sid);
    if (same) {                                              // a resend of the same request (offline queue, double tap): nothing changes
      if (same.site_id !== site || same.device_id !== device) throw new CashError('That session belongs to another register.', 'wrong_register', 409);
      return { session: view(same, same.status === 'open' ? { moves: await moves(db, c, sid) } : null), replay: true };
    }
    const other = await getOpen(db, c, site, device);
    if (other) throw new CashError('This register already has an open cash session.', 'already_open', 409, { session: view(other, { moves: await moves(db, c, other.session_id) }) });
    const at = Number.isFinite(Number(b.openedAt)) && Number(b.openedAt) > 1e12 && Number(b.openedAt) <= nowMs() + 600000 ? Math.round(Number(b.openedAt)) : nowMs();
    try {
      await db.batch([
        db.prepare(`INSERT INTO cash_sessions (client_id, session_id, site_id, device_id, device_name, status, opened_by, opened_by_id, opened_at, opening_float_cents) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
          .bind(c, sid, site, device, str(b.deviceName, 60), by, byId, at, float),
        db.prepare(`INSERT INTO cash_audit (client_id, audit_id, session_id, ts, action, by_name, by_id, detail) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`)
          .bind(c, auditId(), sid, nowMs(), by, byId, JSON.stringify({ openingFloat: kes(float), site, device })),
      ]);
    } catch (e) {                                            // two devices raced to open the same register: the loser adopts the winner's session
      const w = await getOpen(db, c, site, device);
      if (w) throw new CashError('This register already has an open cash session.', 'already_open', 409, { session: view(w, { moves: await moves(db, c, w.session_id) }) });
      throw e;
    }
    return { session: view(await getSession(db, c, sid), { moves: [] }) };
  }

  if (action === 'move') {
    const sid = id(b.sessionId), mid = id(b.moveId);
    const kind = String(b.kind || '');
    if (!['cash_in', 'refund', 'expense', 'payout'].includes(kind)) throw new CashError('Choose what the cash was for.', 'bad_kind');
    const amt = money(b.amount, 'the amount', { allowZero: false });
    const s = await getSession(db, c, sid);
    if (!s) throw new CashError('Cash session not found.', 'not_found', 404);
    if (s.status !== 'open') throw new CashError('This cash session is closed.', 'closed', 409);
    const dup = await db.prepare(`SELECT 1 AS x FROM cash_movements WHERE client_id = ? AND move_id = ?`).bind(c, mid).first();
    if (!dup) {
      const at = Number.isFinite(Number(b.at)) && Number(b.at) > 1e12 && Number(b.at) <= nowMs() + 600000 ? Math.round(Number(b.at)) : nowMs();
      await db.batch([
        db.prepare(`INSERT INTO cash_movements (client_id, move_id, session_id, ts, kind, amount_cents, note, by_name, by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(c, mid, sid, at, kind, amt, str(b.note, 160), by, byId),
        db.prepare(`INSERT INTO cash_audit (client_id, audit_id, session_id, ts, action, by_name, by_id, detail) VALUES (?, ?, ?, ?, 'move', ?, ?, ?)`).bind(c, auditId(), sid, nowMs(), by, byId, JSON.stringify({ kind, amount: kes(amt), note: str(b.note, 160) })),
      ]);
    }
    return { session: view(await getSession(db, c, sid), { moves: await moves(db, c, sid) }) };
  }

  if (action === 'close') {
    const sid = id(b.sessionId);
    const s = await getSession(db, c, sid);
    if (!s) throw new CashError('Cash session not found.', 'not_found', 404);
    if (s.status === 'closed') return { session: view(s), replay: true };             // already closed (a resend): the permanent record stands
    const counted = money(b.counted, 'the counted cash');
    const sn = b.snapshot && typeof b.snapshot === 'object' ? b.snapshot : {};
    const cashSales = money(sn.cashSales || 0, 'cash sales'), nonCash = money(sn.nonCashSales || 0, 'non-cash sales'), autoRef = money(sn.refunds || 0, 'cash refunds'), autoExp = money(sn.expenses || 0, 'cash expenses');
    const t = moveTotals(await moves(db, c, sid));
    const refunds = autoRef + t.refund, expenses = autoExp + t.expense + t.payout, cashIn = t.in;
    const expected = s.opening_float_cents + cashSales + cashIn - refunds - expenses;
    const diff = counted - expected;
    const at = Number.isFinite(Number(b.closedAt)) && Number(b.closedAt) > s.opened_at && Number(b.closedAt) <= nowMs() + 600000 ? Math.round(Number(b.closedAt)) : nowMs();
    await db.batch([
      db.prepare(`UPDATE cash_sessions SET status = 'closed', closed_by = ?, closed_by_id = ?, closed_at = ?, cash_sales_cents = ?, noncash_sales_cents = ?, sales_count = ?, refunds_cents = ?, expenses_cents = ?, cash_in_cents = ?, cash_out_cents = ?,
        expected_cents = ?, counted_cents = ?, difference_cents = ?, close_note = ? WHERE client_id = ? AND session_id = ? AND status = 'open'`)
        .bind(by, byId, at, cashSales, nonCash, Math.max(0, Math.round(Number(sn.salesCount) || 0)), refunds, expenses, cashIn, refunds + expenses, expected, counted, diff, str(b.note, 200), c, sid),
      db.prepare(`INSERT INTO cash_audit (client_id, audit_id, session_id, ts, action, by_name, by_id, detail) VALUES (?, ?, ?, ?, 'close', ?, ?, ?)`)
        .bind(c, auditId(), sid, nowMs(), by, byId, JSON.stringify({ expected: kes(expected), counted: kes(counted), difference: kes(diff), cashSales: kes(cashSales), refunds: kes(refunds), expenses: kes(expenses) })),
    ]);
    return { session: view(await getSession(db, c, sid)) };
  }

  if (action === 'history') {
    const limit = Math.max(1, Math.min(100, Math.round(Number(b.limit) || 30)));
    const dev = str(b.device, 64);
    const rs = await db.prepare(`SELECT * FROM cash_sessions WHERE client_id = ? ${dev ? 'AND device_id = ?' : ''} ORDER BY opened_at DESC LIMIT ?`).bind(...(dev ? [c, dev, limit] : [c, limit])).all();
    return { sessions: (rs.results || []).map((r) => view(r)) };
  }

  if (action === 'detail') {
    const sid = id(b.sessionId);
    const s = await getSession(db, c, sid);
    if (!s) throw new CashError('Cash session not found.', 'not_found', 404);
    const au = await db.prepare(`SELECT ts, action, by_name, detail FROM cash_audit WHERE client_id = ? AND session_id = ? ORDER BY ts, audit_id`).bind(c, sid).all();
    return { session: view(s, { moves: await moves(db, c, sid), audit: (au.results || []).map((a) => ({ at: a.ts, action: a.action, by: a.by_name || '', detail: a.detail ? JSON.parse(a.detail) : null })) }) };
  }

  throw new CashError('Unknown action.', 'unknown_action', 400);
}
