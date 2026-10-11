// functions/api/_ledger.js — the D1 transactional ledger (zip 153). NOT a route.
//
// WHAT THIS IS. Cloudflare D1 (SQL) is the authoritative, durable record of every transaction and money record of every module —
// sales, payments (cash / M-Pesa / split / part), bills, returns, expenses, purchases, trade credits, debts, cash shifts, stock
// movements, gateway transactions, facility tickets. KV keeps carrying the working copy the tills sync between themselves (settings,
// inventory, the live open tabs ...); nothing in KV is what a report or a reconciliation trusts for money.
//
// HOW IT STAYS TRUE.
//  * A push from a till is written to D1 FIRST. If D1 does not accept it, the push is NOT acknowledged (HTTP 503): the till keeps the
//    sale and sends it again — a failed transaction never appears successful, and nothing is lost.
//  * Every write is an idempotent upsert keyed by the record's own id (sale id, payment id ...). The same request twice — a double tap,
//    a mobile retry, a refresh, two tills sending the same sale — is the same row. Nothing is ever inserted twice, so nothing is inflated.
//  * The statements for ONE record (the record, its lines, its payments, its bill) go to D1 in ONE batch = ONE SQL transaction:
//    a payment can never exist without its sale/bill, nor a bill be "paid" without its payment.
//  * A record only moves FORWARD: an older copy (a device that was offline) never overwrites a newer one.
//  * Money tables refuse DELETE and log every change in an append-only audit (database triggers — see _ledger-schema.js).
//  * Webhooks (M-Pesa, cards) that cannot be retried by the sender are parked in a KV outbox if D1 is briefly down and replayed on
//    the next request — the provider gets its answer, the money is still recorded exactly once.
import { LPG_SCHEMA } from './_lpg-schema.js';
import { lpgMovementStatements, lpgSaleStatements } from './_lpg.js';
import { LEDGER_SCHEMA, LEDGER_SCHEMA_0007, LEDGER_SCHEMA_VERSION, VOLATILE_FIELDS, sqlStripVolatile } from './_ledger-schema.js';
import { withRetry, isStorageFull } from './_retry.js';
import { auditDb, writeAuditRows, detachMainAuditTriggers, snapshotOf } from './_audit-db.js';

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v, n = 120) => (v == null ? null : String(v).slice(0, n));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// The D1 binding. `LEDGER_DB` is the documented name; `DB` is accepted too.
export function ledgerDb(env) { return (env && (env.LEDGER_DB || env.DB)) || null; }

const ready = new WeakMap();
export async function ensureLedgerSchema(db) {
  if (!db) return false;
  if (ready.get(db)) return true;
  let ok = false;
  try { const r = await db.prepare(`SELECT v FROM ledger_meta WHERE k = 'schema'`).first(); ok = !!(r && Number(r.v) >= LEDGER_SCHEMA_VERSION); } catch (e) { ok = false; }
  if (!ok) {
    await db.batch(LEDGER_SCHEMA.concat(LEDGER_SCHEMA_0007, LPG_SCHEMA).map((s) => db.prepare(s)));      // zip 186: 0007 = quiet audit triggers, kill switch, guarded audit delete (same list as migrations/0007)
    await db.prepare(`INSERT INTO ledger_meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(LEDGER_SCHEMA_VERSION)).run();
  }
  ready.set(db, true);
  return true;
}

// ---------- small helpers ----------
// Business date (YYYY-MM-DD) in the shop's zone: minutes east of UTC, Nairobi (+180) unless the shop says otherwise.
export function bizDate(ts, offMin = 180) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return new Date(Date.now() + offMin * 60000).toISOString().slice(0, 10);
  return new Date(t + offMin * 60000).toISOString().slice(0, 10);
}
export function tsOf(v, dflt) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && /^\d{9,}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : (dflt == null ? Date.now() : dflt);
}
// Deterministic JSON (sorted keys): the same record from two devices hashes the same, so a re-push is recognised as "nothing new".
export function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
export function saleTotal(s) {
  return round2((Array.isArray(s && s.items) ? s.items : []).reduce((n, it) => n + num(it.price) * num(it.qty), 0));
}
function saleCost(s) {
  return round2((Array.isArray(s && s.items) ? s.items : []).reduce((n, it) => (it.unit === 'payment' || it.isPayment ? n : n + num(it.wholesalePrice) * num(it.qty)), 0));
}
const METHODS = new Set(['cash', 'mpesa', 'card', 'bank', 'credit']);

// What money a sale actually received, by method. A sale on account / an unpaid delivery received nothing yet (its total is a receivable).
export function salePayments(s, total) {
  const m = String(s.paymentMethod || s.method || '').toLowerCase();
  const out = [];
  const push = (method, amount, code) => { amount = round2(amount); if (amount > 0) out.push({ method, amount, code: code ? str(code, 40) : null }); };
  if (s.paid === false || ['tab', 'credit', 'account', 'debt', 'pod', 'unpaid'].includes(m)) return out;
  const cash = num(s.cashAmount), mp = num(s.mpesaAmount), card = num(s.cardAmount);
  const bank = num(s.bankAmount);
  if (cash + mp + card + bank > 0) { push('cash', cash); push('mpesa', mp, s.mpesaReceiptNumber || s.mpesaCode); push('card', card); push('bank', bank); return out; }
  if (m === 'mpesa') push('mpesa', total, s.mpesaReceiptNumber || s.mpesaCode);
  else if (m === 'card') push('card', total);
  else if (m === 'bank') push('bank', total);
  else if (m === 'split') { /* amounts are on the record; nothing to derive */ }
  else if (m === 'parts') { /* the parts are their own sales */ }
  else push('cash', total);
  return out;
}
function saleStatus(s) { return s._deleted ? 'REMOVED' : s.voided ? 'VOIDED' : s.refunded ? 'REFUNDED' : 'COMPLETED'; }

// ---------- record mapping (one function per kind of money record) ----------
// Each returns { kind, id, ts, amount, status, actor, data } or null (not a money record we can key).
const COLLECTIONS = {
  returns:        { kind: 'return',        amount: (r) => num(r.refundAmount || r.amount || r.topUpAmount), actor: (r) => r.servedBy },
  expenses:       { kind: 'expense',       amount: (r) => num(r.amount), actor: (r) => r.by || r.recordedBy },
  tradeCredits:   { kind: 'trade_credit',  amount: (r) => num(r.amount), status: (r) => r.status, actor: (r) => r.by },
  debts:          { kind: 'debt',          amount: (r) => num(r.amount), status: (r) => (num(r.amount) - (Array.isArray(r.payments) ? r.payments : []).reduce((n, p) => n + num(p.amount), 0) <= 0.004 ? 'settled' : 'open') },
  purchaseOrders: { kind: 'purchase',      amount: (r) => round2((r.items || []).reduce((n, i) => n + num(i.cost) * num(i.qty), 0)), status: (r) => r.status, actor: (r) => r.createdBy },
  patientCharges: { kind: 'patient_charge', amount: (r) => num(r.amount || (num(r.price) * (num(r.qty) || 1))), status: (r) => r.status },
  cashShifts:     { kind: 'cash_shift',    amount: (r) => num(r.closingCash != null ? r.closingCash : r.openingCash), status: (r) => r.status, actor: (r) => r.by || r.staffName },
  bills:          { kind: 'credit_bill',   amount: (r) => saleTotal(r) || num(r.amount || r.total), status: (r) => (r.voided ? 'VOIDED' : r.settledAt || r.paid === true ? 'PAID' : 'OPEN'), actor: (r) => r.servedBy },
  resourceSessions: { kind: 'facility_session', amount: (r) => num(r.charge), status: (r) => r.status, actor: (r) => r.soldBy || r.endedBy || r.startedBy },
  facilityBookings: { kind: 'facility_booking', amount: (r) => num(r.amount || r.total || r.price), status: (r) => r.status },
  stockMovementLog: { kind: 'stock_move', amount: (r) => round2(num(r.qty) * num(r.unitCost || r.cost)), status: () => 'RECORDED', actor: (r) => r.by || r.user },
};
export const LEDGER_COLLECTIONS = Object.keys(COLLECTIONS).concat(['salesLog', 'tabs']);

function idOf(r) { return r && (r.id != null ? String(r.id) : null); }

// zip 186 (INCIDENT: 21.8M audit rows from a retry storm). The client stamps retry counters (`tries`) INTO a pending record, so every resend had different
// `data`, passed the old `excluded.data <> ledger_records.data` test, UPDATEd the row and the audit trigger logged a new row each time. Now:
//  * VOLATILE_FIELDS are removed from the record before it is stored / fingerprinted (stripVolatile), and
//  * the test compares against the STORED data minus the same fields (so a row stored BEFORE this fix, which still carries `tries`, is not "changed" by a
//    resend either): a resend whose only difference is a retry counter is a pure no-op: no UPDATE, no audit row.
// (json_valid guard: a stored value that is not JSON compares as-is instead of failing the whole batch.)
// zip 251 (COST INCIDENT: D1 writes). The same kind of churn, one level up: a till whose clock is 2+ minutes behind has every record's `updatedAt` shifted
// by correctClockDrift before it gets here, and the apps re-send whole lists (bills, debts, tabs, cash shifts ...) on every push. The shifted `updatedAt` is
// INSIDE `data`, so every re-send "differed", UPDATEd the row and (in the same transaction) wrote an audit row - measured: 70 records = 140 D1 row changes per
// push, against 0 with a correct clock (tests/zip251-clock-drift-writes.test.mjs). The test now ignores `updatedAt` on both sides; the `version` column still
// carries it, a real edit still changes `data` (or status / amount) and is still written, and what is stored is unchanged. LEDGER_STAMP_GUARD=0 (a variable
// on the Pages project) restores the old comparison.
const UPSERT_RECORD_BASE = (cmp) => `INSERT INTO ledger_records (client_id, kind, rec_id, version, ts, business_date, amount, status, actor, source, data, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (client_id, kind, rec_id) DO UPDATE SET version = excluded.version, ts = excluded.ts, business_date = excluded.business_date, amount = excluded.amount,
  status = excluded.status, actor = excluded.actor, source = excluded.source, data = excluded.data, updated_at = excluded.updated_at
WHERE excluded.version >= ledger_records.version AND ${cmp}`;
const UPSERT_RECORD_LEGACY = UPSERT_RECORD_BASE(`excluded.data <> (CASE WHEN json_valid(ledger_records.data) THEN ${sqlStripVolatile('ledger_records.data')} ELSE ledger_records.data END)`);
const UPSERT_RECORD_GUARDED = UPSERT_RECORD_BASE(`(CASE WHEN json_valid(excluded.data) AND json_valid(ledger_records.data) THEN json_remove(excluded.data, '$.updatedAt') <> json_remove(${sqlStripVolatile('ledger_records.data')}, '$.updatedAt') ELSE excluded.data <> ledger_records.data END)`);
// read per request from the env (free); anything but 0 / off / false keeps the guard on
const stampGuardOn = (env) => { const v = env && env.LEDGER_STAMP_GUARD; return !(v === '0' || v === 0 || v === false || String(v).toLowerCase() === 'off'); };
const VOLATILE = new Set(VOLATILE_FIELDS);
// A shallow copy without the client-only retry / telemetry fields (top level only: that is where the apps stamp them). Returns the same object when there is nothing to strip.
export function stripVolatile(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
  let hit = false;
  for (const k of VOLATILE_FIELDS) if (k in r) { hit = true; break; }
  if (!hit) return r;
  const out = {};
  for (const k of Object.keys(r)) if (!VOLATILE.has(k)) out[k] = r[k];
  return out;
}

// ---------- "already written" memory (zip 159) ----------
// A push carries the WHOLE of every list that is not a slimmed log (open tabs, bills, debts, cash shifts, purchase orders ...), every time, changed or not
// (measured: 40 open tabs + 100 bills = 180 SQL statements in 3 D1 round trips on EVERY push, of which nothing was new). Each such statement was
// a no-op in D1 (the upsert's WHERE finds the data equal), but it still costs a round trip and a row read. This instance remembers, per record, the
// fingerprint of what it last got D1 to commit (only after the batch really committed), and leaves an unchanged record out of the next push.
// Safe because a record only moves forward in D1: writing the same content again is, by construction, a no-op. The memory lives 5 minutes
// (LEDGER_SEEN_MS; 0 = off) and only in this instance, so a D1 restore or another instance's write is never hidden for longer than that.
// The fingerprint is two independent 53-bit hashes of the record's canonical JSON plus its length (about 106 bits: an accidental collision needs
// ~10^15 records).
const cyrb53 = (str, seed) => {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};
export const fingerprint = (str) => str.length.toString(36) + '.' + cyrb53(str, 0).toString(36) + '.' + cyrb53(str, 7).toString(36);
const SEEN_MS = 5 * 60000, SEEN_MAX = 30000;
const seenByDb = new WeakMap();                                       // D1 binding -> Map("client|kind|id" -> { sig, at })
const seenMs = (env) => { const n = env && env.LEDGER_SEEN_MS != null && env.LEDGER_SEEN_MS !== '' ? Number(env.LEDGER_SEEN_MS) : SEEN_MS; return Number.isFinite(n) && n >= 0 ? n : SEEN_MS; };
const seenMap = (db) => { let m = seenByDb.get(db); if (!m) { m = new Map(); seenByDb.set(db, m); } return m; };
export function clearLedgerSeen(db) { seenByDb.delete(db); }

// Build ALL statements for one incoming push, grouped per record (a group is executed as one atomic batch).
export function buildGroups(db, clientId, body, opt = {}) {
  const now = opt.now || Date.now();
  const off = Number.isFinite(Number(opt.tzMin)) ? Number(opt.tzMin) : (Number.isFinite(Number(body && body._tzMin)) ? Number(body._tzMin) : 180);
  const app = str((body && body._dev && body._dev.app) || opt.app, 20);
  const source = str(opt.source || 'sync', 40);
  const groups = [];
  let lastCanon = '';                                                   // the canonical text of the record last passed to rec(): its fingerprint says whether a group changed
  let lastAudit = null;                                                 // zip 187: what the audit database logs if this record really changed
  // NOTE (zip 252): the repeat-send fingerprint (g.sig) deliberately KEEPS updatedAt: the memory records what was last SENT, not what is stored, so a stamp-blind
  // fingerprint would swallow 'edit back to the original' after a stale copy (tests/zip185-syncsrv-mpesa-ledger.test.mjs). The SQL guards below carry the saving.
  const guardOn = opt.stampGuard !== false;                            // zip 252: a time stamp alone is not a change (LEDGER_STAMP_GUARD=0 restores the old behaviour)
  const rec = (kind, id, version, ts, amount, status, actor, data) => { lastCanon = canon(stripVolatile(data)); lastAudit = { kind, recId: id, version, amount: round2(amount), status: str(status, 30), actor: str(actor, 60), source, at: now, data: lastCanon }; return db.prepare(opt.stampGuard === false ? UPSERT_RECORD_LEGACY : UPSERT_RECORD_GUARDED).bind(clientId, kind, id, version, ts, bizDate(ts, off), round2(amount), str(status, 30), str(actor, 60), source, lastCanon, now, now); };
  const tag = (g, kind, id) => { g.audit = lastAudit; g.key = clientId + '|' + kind + '|' + id; g.kind = kind; g.rid = id; g.len = lastCanon.length; g.sig = fingerprint(lastCanon + '|' + off + '|' + app + '|' + source); return g; };

  // --- sales (+ lines + payments) ---
  for (const s of Array.isArray(body && body.salesLog) ? body.salesLog : []) {
    const id = idOf(s); if (!id) continue;
    const ts = tsOf(s.timestamp, now), version = num(s.updatedAt) || ts;
    const total = saleTotal(s), status = saleStatus(s);
    const pays = salePayments(s, total);
    const st = [];
    st.push(rec('sale', id, version, ts, total, status, s.servedBy, s));
    const cash = pays.filter((p) => p.method === 'cash').reduce((n, p) => n + p.amount, 0), mp = pays.filter((p) => p.method === 'mpesa').reduce((n, p) => n + p.amount, 0), card = pays.filter((p) => p.method === 'card').reduce((n, p) => n + p.amount, 0);
    const paid = pays.reduce((n, p) => n + p.amount, 0);
    const code = (pays.find((p) => p.code) || {}).code || null;
    // a whole bill settled in one go (not a part payment): the database allows ONE such sale per bill
    const fullSettle = (s.tabId && s.tabOrderCount != null && !s.partOfTab && status === 'COMPLETED') ? 1 : 0;
    st.push(db.prepare(`INSERT INTO ledger_sales (client_id, sale_id, ref_number, ts, business_date, app, outlet, location, tab_id, bill_id, order_id, total, cost, method, cash_amount, mpesa_amount, card_amount, credit_amount, mpesa_code, staff, till, customer, status, full_settle, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (client_id, sale_id) DO UPDATE SET ref_number = excluded.ref_number, ts = excluded.ts, business_date = excluded.business_date, app = excluded.app, outlet = excluded.outlet, location = excluded.location,
        tab_id = excluded.tab_id, bill_id = excluded.bill_id, order_id = excluded.order_id, total = excluded.total, cost = excluded.cost, method = excluded.method, cash_amount = excluded.cash_amount,
        mpesa_amount = excluded.mpesa_amount, card_amount = excluded.card_amount, credit_amount = excluded.credit_amount, mpesa_code = excluded.mpesa_code, staff = excluded.staff, till = excluded.till,
        customer = excluded.customer, status = excluded.status, full_settle = excluded.full_settle, version = excluded.version, updated_at = excluded.updated_at
      WHERE (excluded.version > ledger_sales.version AND NOT (ledger_sales.status = 'DUPLICATE' AND excluded.status = 'COMPLETED')) OR (excluded.version = ledger_sales.version AND ((excluded.status <> ledger_sales.status AND NOT (ledger_sales.status = 'DUPLICATE' AND excluded.status = 'COMPLETED')) OR excluded.total <> ledger_sales.total))`)
      .bind(clientId, id, str(s.refNumber, 40), ts, bizDate(ts, off), app, str(s.outlet, 40), str(s.tableOrRoom || s.location, 80), str(s.tabId || s.partOfTab, 60), str(s.billId || s.billNo, 60), str(s.qrOrderId, 60),
        total, saleCost(s), str(s.paymentMethod, 20), round2(cash), round2(mp), round2(card), round2(Math.max(0, total - paid)), code, str(s.servedBy, 60), str(s._till || s.till, 60), str(s.customerName, 80), status, fullSettle, version, now, now));
    const items = Array.isArray(s.items) ? s.items : [];
    items.forEach((it, i) => st.push(db.prepare(`INSERT INTO ledger_sale_items (client_id, sale_id, line_no, code, name, qty, price, cost, station)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ledger_sales WHERE client_id = ? AND sale_id = ? AND version = ?)
      ON CONFLICT (client_id, sale_id, line_no) DO UPDATE SET code = excluded.code, name = excluded.name, qty = excluded.qty, price = excluded.price, cost = excluded.cost, station = excluded.station${guardOn ? `
        WHERE ledger_sale_items.code IS NOT excluded.code OR ledger_sale_items.name IS NOT excluded.name OR ledger_sale_items.qty IS NOT excluded.qty OR ledger_sale_items.price IS NOT excluded.price OR ledger_sale_items.cost IS NOT excluded.cost OR ledger_sale_items.station IS NOT excluded.station` : ''}`)
      .bind(clientId, id, i, str(it.code, 60), str(it.name, 120), num(it.qty), num(it.price), num(it.wholesalePrice) * 1, str(it.station, 20), clientId, id, version)));
    st.push(db.prepare(`DELETE FROM ledger_sale_items WHERE client_id = ? AND sale_id = ? AND line_no >= ? AND EXISTS (SELECT 1 FROM ledger_sales WHERE client_id = ? AND sale_id = ? AND version = ?)`).bind(clientId, id, items.length, clientId, id, version));
    if (items.some((it) => it && it.lpg)) lpgSaleStatements(db, clientId, id, items, { ts, date: bizDate(ts, off), app, version }).forEach((x) => st.push(x));       // zip 216: gas lines
    const payStatus = status === 'COMPLETED' ? 'CONFIRMED' : 'REVERSED';
    pays.forEach((p) => st.push(db.prepare(`INSERT INTO ledger_payments (client_id, payment_id, sale_id, bill_id, method, amount, mpesa_code, status, confirmed_by, source, ts, business_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (client_id, payment_id) DO UPDATE SET status = excluded.status, mpesa_code = COALESCE(excluded.mpesa_code, ledger_payments.mpesa_code)
      WHERE (ledger_payments.status <> excluded.status AND NOT (ledger_payments.status = 'DUPLICATE' AND excluded.status = 'CONFIRMED') AND (excluded.status <> 'CONFIRMED' OR (ABS(ledger_payments.amount - excluded.amount) < 0.005 AND EXISTS (SELECT 1 FROM ledger_sales x WHERE x.client_id = ledger_payments.client_id AND x.sale_id = ledger_payments.sale_id AND x.version = ?)))) OR (ledger_payments.mpesa_code IS NULL AND excluded.mpesa_code IS NOT NULL)`)
      .bind(clientId, `sale:${id}:${p.method}`, id, str(s.billId || s.billNo || s.tabId || s.partOfTab, 60), p.method, p.amount, p.code, payStatus, str(s.servedBy, 60), source, ts, bizDate(ts, off), now, version)));
    // zip 185: an EDITED sale (amount / method changed) used to leave its old payment row CONFIRMED with the old figure (the payment_amount_locked
    // trigger refuses a re-amount, and the upsert above only moves the status). Now, once this version is the sale's current one: every CONFIRMED
    // payment row of the sale that is not part of the wanted set (method + amount) is REVERSED (a status change, which the trigger allows), and a
    // changed amount is recorded as a NEW row 'sale:<id>:<method>:a<cents>' (revived if an earlier edit had already used that amount). The base
    // upsert above no longer revives a REVERSED row whose amount differs. Nothing is deleted; the audit keeps every version.
    const wantKeys = payStatus === 'CONFIRMED' ? pays.map((p) => `${p.method}|${Math.round(p.amount * 100)}`) : [];
    const pfx = `sale:${id}:`;
    const curVer = `EXISTS (SELECT 1 FROM ledger_sales x WHERE x.client_id = ? AND x.sale_id = ? AND x.version = ?)`;
    st.push(db.prepare(`UPDATE ledger_payments SET status = 'REVERSED' WHERE client_id = ? AND sale_id = ? AND substr(payment_id, 1, ?) = ? AND status = 'CONFIRMED'
      AND (method || '|' || CAST(ROUND(amount * 100) AS INTEGER)) NOT IN (${(wantKeys.length ? wantKeys : ['-']).map(() => '?').join(',')}) AND ${curVer}`)
      .bind(clientId, id, pfx.length, pfx, ...(wantKeys.length ? wantKeys : ['-']), clientId, id, version));
    pays.forEach((p) => {
      const baseId = `sale:${id}:${p.method}`;
      st.push(db.prepare(`INSERT INTO ledger_payments (client_id, payment_id, sale_id, bill_id, method, amount, mpesa_code, status, confirmed_by, source, ts, business_date, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ? WHERE ? = 'CONFIRMED' AND ${curVer}
          AND EXISTS (SELECT 1 FROM ledger_payments b WHERE b.client_id = ? AND b.payment_id = ? AND ABS(b.amount - ?) >= 0.005)
        ON CONFLICT (client_id, payment_id) DO UPDATE SET status = 'CONFIRMED' WHERE ledger_payments.status = 'REVERSED'`)
        .bind(clientId, `${baseId}:a${Math.round(p.amount * 100)}`, id, str(s.billId || s.billNo || s.tabId || s.partOfTab, 60), p.method, p.amount, p.code, str(s.servedBy, 60), source, ts, bizDate(ts, off), now,
          payStatus, clientId, id, version, clientId, baseId, p.amount));
    });
    if (fullSettle) {
      // DOUBLE / CONCURRENT SETTLEMENT: D1 runs writes one at a time, so whichever till's sale lands second sees the first and is marked
      // DUPLICATE (with its payments): kept for the audit, never counted in Daily Sales or the bill's paid amount, and reported to the till.
      st.push(db.prepare(`UPDATE ledger_sales SET status = 'DUPLICATE' WHERE client_id = ? AND sale_id = ? AND status = 'COMPLETED' AND EXISTS (SELECT 1 FROM ledger_sales o WHERE o.client_id = ? AND o.sale_id <> ? AND o.status = 'COMPLETED' AND o.full_settle = 1 AND (o.bill_id = ? OR o.tab_id = ?))`)
        .bind(clientId, id, clientId, id, str(s.billId || s.billNo || s.tabId, 60), str(s.tabId, 60)));
      st.push(db.prepare(`UPDATE ledger_payments SET status = 'DUPLICATE' WHERE client_id = ? AND sale_id = ? AND status = 'CONFIRMED' AND EXISTS (SELECT 1 FROM ledger_sales x WHERE x.client_id = ? AND x.sale_id = ? AND x.status = 'DUPLICATE')`)
        .bind(clientId, id, clientId, id));
    }
    groups.push(tag(st, 'sale', id));
  }

  // --- tabs / bills: identity + owner; what is paid is the sum of payments (view), never stored ---
  for (const t of Array.isArray(body && body.tabs) ? body.tabs : []) {
    const id = idOf(t); if (!id) continue;
    const billId = str(t.billNo || t.billId, 60); if (!billId) continue;
    const ts = tsOf(t.openedAt, now), version = num(t.updatedAt) || ts;
    const due = round2(t.due != null ? t.due : (t.orders || []).reduce((n, o) => n + (o.entries || []).reduce((s, l) => s + num(l.price) * num(l.qty), 0), 0));
    const status = t.status === 'VOID' ? 'VOID' : t.status === 'CLOSED' ? 'CLOSED' : t.status === 'MOVED' ? 'MOVED' : 'OPEN';
    const tabRec = rec('tab', id, version, ts, due, status, t.owner || t.waiter || t.openedBy, t);
    groups.push(tag([
      tabRec,
      db.prepare(`INSERT INTO ledger_bills (client_id, bill_id, tab_id, location_id, location, owner, total, status, opened_at, closed_at, version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (client_id, bill_id) DO UPDATE SET location = excluded.location, location_id = COALESCE(excluded.location_id, ledger_bills.location_id), owner = COALESCE(excluded.owner, ledger_bills.owner),
          total = excluded.total, status = excluded.status, closed_at = excluded.closed_at, version = excluded.version, updated_at = excluded.updated_at
        WHERE excluded.version >= ledger_bills.version${guardOn ? ` AND (ledger_bills.location IS NOT excluded.location OR ledger_bills.location_id IS NOT COALESCE(excluded.location_id, ledger_bills.location_id) OR ledger_bills.owner IS NOT COALESCE(excluded.owner, ledger_bills.owner)
          OR ledger_bills.total IS NOT excluded.total OR ledger_bills.status IS NOT excluded.status OR ledger_bills.closed_at IS NOT excluded.closed_at)` : ''}`)
        .bind(clientId, billId, id, str(t.locId, 60), str(t.label, 80), str(t.owner || t.waiter, 60), due, status, ts, t.closedAt ? tsOf(t.closedAt, now) : null, version, now),
    ], 'tab', id));
  }

  // --- every other money collection: one ledger_records row per record (+ payments carried inside bills / debts) ---
  for (const [field, spec] of Object.entries(COLLECTIONS)) {
    for (const r of Array.isArray(body && body[field]) ? body[field] : []) {
      const id = idOf(r); if (!id) continue;
      const ts = tsOf(r.timestamp || r.createdAt || r.at || r.date, now), version = num(r.updatedAt) || ts;
      const status = r._deleted ? 'REMOVED' : (spec.status ? spec.status(r) : (r.voided ? 'VOIDED' : 'RECORDED'));
      const st = [rec(spec.kind, id, version, ts, spec.amount(r), status, spec.actor ? spec.actor(r) : null, r)];
      const hist = Array.isArray(r.paymentHistory) ? r.paymentHistory : Array.isArray(r.payments) ? r.payments : [];
      hist.forEach((p, i) => {
        const amt = round2(num(p.amount)); if (!(amt > 0)) return;
        const pts = tsOf(p.timestamp || p.at || p.date, ts);
        const m = METHODS.has(String(p.method).toLowerCase()) ? String(p.method).toLowerCase() : 'cash';
        st.push(db.prepare(`INSERT INTO ledger_payments (client_id, payment_id, sale_id, bill_id, method, amount, mpesa_code, status, confirmed_by, source, ts, business_date, created_at)
          VALUES (?, ?, NULL, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?) ON CONFLICT (client_id, payment_id) DO NOTHING`)
          .bind(clientId, `${spec.kind}:${id}:${p.id || i}`, `${spec.kind}:${id}`, m, amt, str(p.reference || p.code, 40), str(p.by || p.servedBy, 60), source, pts, bizDate(pts, off), now));
      });
      if (field === 'stockMovementLog' && r.lpg) lpgMovementStatements(db, clientId, r, { ts, date: bizDate(ts, off), app }).forEach((x) => st.push(x));       // zip 216: gas movements
      groups.push(tag(st, spec.kind, id));
    }
  }
  return groups;
}

// Group the statements into batches of at most `max` statements without ever splitting one record's statements. Returns arrays of GROUPS.
function packBatches(groups, max = 80) {
  const out = []; let cur = []; let n = 0;
  for (const g of groups) {
    if (cur.length && n + g.length > max) { out.push(cur); cur = []; n = 0; }
    cur.push(g); n += g.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

// The outbox (money events parked while D1 was down) used to be read from KV on EVERY push. It can only be non-empty after a D1 failure, so once a
// check has found it empty it is not read again for OUTBOX_CHECK_MS in this instance; parking something here re-arms the check at once.
const OUTBOX_CHECK_MS = 20000;
const outboxEmptyAt = new WeakMap();                                  // KV binding -> Map(clientId -> time the outbox was last found empty)
const outboxMap = (env) => { const kv = env && env.mydukapos_kv; if (!kv || typeof kv !== 'object') return null; let m = outboxEmptyAt.get(kv); if (!m) { m = new Map(); outboxEmptyAt.set(kv, m); } return m; };
async function drainOutboxThrottled(env, clientId, db) {
  const m = outboxMap(env);
  const gap = env && env.LEDGER_OUTBOX_CHECK_MS != null && env.LEDGER_OUTBOX_CHECK_MS !== '' ? Number(env.LEDGER_OUTBOX_CHECK_MS) : OUTBOX_CHECK_MS;
  if (m && gap > 0) { const at = m.get(clientId); if (at && Date.now() - at < gap) return 0; }
  const found = await drainOutbox(env, clientId, db, { emptyAsMinusOne: true });        // -1 = there was nothing to drain
  if (m) { if (found === -1) m.set(clientId, Date.now()); else m.delete(clientId); }
  return found === -1 ? 0 : found;
}

// ---------- zip 186: guards against a retry storm (see the incident notes in docs/INCIDENT_LEDGER_AUDIT_186.md) ----------
const flagOn = (v) => v != null && /^(1|true|on|yes)$/i.test(String(v).trim());
// Per-isolate memory of the audit kill switch: the env var is read every request (free); the KV flag `audit:disabled` at most every 30 s.
const killStates = new WeakMap();                                     // D1 binding -> { kvAt, kvOn, mirroredAt }
// AUDIT KILL SWITCH. The audit rows are written by database triggers, which read ledger_meta k='audit_disabled'. This mirrors the env var AUDIT_WRITES_DISABLED
// (or the KV flag audit:disabled) into that row, ONE WAY: it only turns the switch ON (once per 5 minutes per isolate, and only when the row is not already '1').
// Turning it OFF again is deliberate and manual (POST /api/ledger-health {audit:'on'} or the SQL in docs/INCIDENT_LEDGER_AUDIT_186.md): an audit trail that
// silently resumed, or flapped, would be worse. Sales and records are always saved; only the history rows are skipped.
// zip 187: the SQL kill switch (ledger_meta audit_disabled = '1') is read by the old triggers; the server-side audit writer reads it too, at most every 30 s per isolate.
const flagCache = new WeakMap();
async function auditFlagOff(db) {
  try {
    const now = Date.now(); const c = flagCache.get(db);
    if (c && now - c.at < 30000) return c.off;
    const r = await db.prepare(`SELECT v FROM ledger_meta WHERE k = 'audit_disabled'`).first();
    const off = !!(r && String(r.v) === '1');
    flagCache.set(db, { at: now, off });
    return off;
  } catch (e) { return false; }
}
async function mirrorAuditKillSwitch(env, db) {
  try {
    let on = flagOn(env && env.AUDIT_WRITES_DISABLED);
    const now = Date.now();
    let killState = killStates.get(db); if (!killState) { killState = { kvAt: 0, kvOn: false, mirroredAt: 0 }; killStates.set(db, killState); }
    if (!on && env && env.mydukapos_kv && typeof env.mydukapos_kv.get === 'function') {
      if (now - killState.kvAt > 30000) { killState.kvAt = now; try { killState.kvOn = flagOn(await env.mydukapos_kv.get('audit:disabled')); } catch (e) { killState.kvOn = false; } }
      on = killState.kvOn;
    }
    if (!on || now - killState.mirroredAt < 300000) return on;
    killState.mirroredAt = now;
    await db.prepare(`INSERT INTO ledger_meta (k, v) VALUES ('audit_disabled', '1') ON CONFLICT (k) DO UPDATE SET v = '1' WHERE v <> '1'`).run();
    return true;
  } catch (e) { return false; }
}

// PER-RECORD RATE GUARD. A record that really CHANGES more than AUDIT_REC_RATE_PER_MIN times (default 20; 0 = off) in a minute is a client bug, not a person:
// further changes of that (shop, kind, id) are not written until the minute is over. Only writes that changed a row count (a re-send of the same record is
// a no-op and is never counted or refused). Kept in this isolate's memory: no KV / D1 write per request.
const recRates = new WeakMap();                                       // D1 binding -> Map("client|kind|id" -> { t0, n })
const recRateMap = (db) => { let m = recRates.get(db); if (!m) { m = new Map(); recRates.set(db, m); } return m; };
const RATE_MAX_KEYS = 20000;
const recRateMax = (env) => { const v = env && env.AUDIT_REC_RATE_PER_MIN; if (v == null || v === '') return 20; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 20; };
export function clearRecRate(db) { if (db) recRates.delete(db); }
function recRateLeft(recRate, key, max, now) {                         // -> seconds to wait when over the limit, else 0
  if (!max) return 0;
  const r = recRate.get(key);
  if (!r) return 0;
  if (now - r.t0 >= 60000) { recRate.delete(key); return 0; }
  return r.n >= max ? Math.max(1, Math.ceil((r.t0 + 60000 - now) / 1000)) : 0;
}
function recRateNote(recRate, key, now) {
  const r = recRate.get(key);
  if (!r || now - r.t0 >= 60000) {
    if (recRate.size >= RATE_MAX_KEYS) for (const k of recRate.keys()) { recRate.delete(k); if (recRate.size <= RATE_MAX_KEYS * 0.8) break; }
    recRate.set(key, { t0: now, n: 1 });
  } else r.n++;
}

// PERMANENTLY BAD ITEMS. An item that can never be stored (an id that is not a string / number or longer than 200 characters, a record bigger than
// MAX_REC_BYTES) will fail the same way on every resend. It is left out of the write and reported in `rejected`; if NOTHING valid is left in the push the answer
// is a terminal 422 {ok:false, permanent:true} so the client can stop retrying (and move the item to its needs-attention list) instead of looping.
const MAX_REC_BYTES = 512 * 1024;
function splitBad(body) {
  const rejected = [];
  if (!body || typeof body !== 'object') return { body, rejected };
  let out = null;
  for (const field of LEDGER_COLLECTIONS) {
    const arr = body[field];
    if (!Array.isArray(arr)) continue;
    const kept = [];
    for (const r of arr) {
      if (r && typeof r === 'object' && !Array.isArray(r) && r.id != null && (typeof r.id === 'object' || String(r.id).length > 200)) { rejected.push({ field, id: String(typeof r.id === 'object' ? '[object]' : r.id).slice(0, 40), reason: 'bad_id' }); continue; }
      kept.push(r);
    }
    if (kept.length !== arr.length) { out = out || { ...body }; out[field] = kept; }
  }
  return { body: out || body, rejected };
}

// Write a push's money records. Returns { ok:true, records } | { ok:true, skipped:'no_db' } | { ok:false, error, code?, status?, retryAfter? }.
// Reliability (zip 159): each batch is an atomic transaction of idempotent upserts, so a transient D1 failure (network blip, overloaded primary) is
// retried twice with backoff + jitter before the push is refused (503, the till keeps the sale and sends it again — unchanged).
// zip 186 additions (all ADD fields; the existing ones are unchanged): `unchanged` (records already stored as sent), `duplicate:true` (EVERY record was already stored:
// a pure re-send), `rateLimited` / `rejected` (items left out, see above), and the terminal / pausing failures `storage_full` (507), `record_rate` (429), `bad_record` (422).
export async function recordPush(env, clientId, body, opt = {}) {
  const db = ledgerDb(env);
  if (!db) return { ok: true, skipped: 'no_db' };
  try {
    await ensureLedgerSchema(db);
    const killed = await mirrorAuditKillSwitch(env, db);
    // zip 187: with the separate audit database bound, the server writes the audit rows itself (after the main batch committed) and the main ledger's
    // audit triggers are removed. Without the binding nothing changes: the triggers keep writing.
    const adb = auditDb(env);
    const auditOn = !!adb && !killed && !(await auditFlagOff(db));
    if (adb) await detachMainAuditTriggers(db);
    await drainOutboxThrottled(env, clientId, db).catch(() => {});
    const split = splitBad(body);
    const groups = buildGroups(db, clientId, split.body, { ...opt, stampGuard: stampGuardOn(env) });      // zip 251: see UPSERT_RECORD_GUARDED
    let rejected = split.rejected;
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i].len > MAX_REC_BYTES) { rejected = rejected.concat({ field: groups[i].kind, id: String(groups[i].rid).slice(0, 40), reason: 'too_large' }); groups.splice(i, 1); }
    }
    if (!groups.length) {
      if (rejected.length) return { ok: false, permanent: true, code: 'bad_record', status: 422, error: 'This push holds only records the server can never accept.', rejected };
      return { ok: true, records: 0 };
    }
    const ttl = seenMs(env), now = Date.now(), seen = ttl > 0 ? seenMap(db) : null;
    const notSeen = seen ? groups.filter((g) => { const h = g.key && seen.get(g.key); return !(h && h.sig === g.sig && now - h.at < ttl); }) : groups;
    const max = recRateMax(env), rates = recRateMap(db);
    const limited = [];
    let wait = 0;
    const todo = notSeen.filter((g) => { const w = g.key ? recRateLeft(rates, g.key, max, now) : 0; if (w) { limited.push({ kind: g.kind, id: String(g.rid).slice(0, 60) }); wait = Math.max(wait, w); return false; } return true; });
    if (limited.length && !todo.length && notSeen.length === limited.length) {
      return { ok: false, code: 'record_rate', status: 429, retryAfter: wait, error: 'The same record is being changed too often. Wait and send it again.', limited, ...(rejected.length ? { rejected } : {}) };
    }
    let batches = 0, changed = 0;
    for (const batch of packBatches(todo)) {
      const stmts = batch.flat();
      const res = await withRetry(() => db.batch(stmts), { tries: 3, baseMs: 40, env });
      batches++;
      let at = 0; const t = Date.now();
      const auditRows = [];
      for (const g of batch) {
        const first = res && res[at] && res[at].meta;
        if (first && Number(first.changes) > 0) {
          changed++; if (g.key && max) recRateNote(rates, g.key, t);
          if (auditOn && g.audit) { const a = g.audit; auditRows.push({ clientId, kind: a.kind, recId: a.recId, action: 'WRITE', version: a.version, amount: a.amount, status: a.status, actor: a.actor, source: a.source, at: a.at, snapshot: snapshotOf(a.kind, a.data, a.status, a.amount, a.version) }); }
        }
        at += g.length;
        if (seen && g.key) { seen.delete(g.key); seen.set(g.key, { sig: g.sig, at: t }); }
      }
      if (auditRows.length) await writeAuditRows(env, auditRows, t);      // never throws; a failure only pauses the audit, the sale is already saved
    }
    if (seen && seen.size > SEEN_MAX) for (const k of seen.keys()) { seen.delete(k); if (seen.size <= SEEN_MAX * 0.8) break; }
    // tell the till if any sale it just sent turned out to be a second settlement of a bill somebody else already settled
    let duplicates;
    const ids = (Array.isArray(body && body.salesLog) ? body.salesLog : []).filter((s) => s && s.tabId && s.tabOrderCount != null).map(idOf).filter(Boolean).slice(0, 50);
    if (ids.length) {
      const rows = ((await withRetry(() => db.prepare(`SELECT sale_id, bill_id, total FROM ledger_sales WHERE client_id = ? AND status = 'DUPLICATE' AND sale_id IN (${ids.map(() => '?').join(',')})`).bind(clientId, ...ids).all(), { tries: 2, baseMs: 40, env })).results) || [];
      if (rows.length) duplicates = rows;
    }
    const unchanged = groups.length - changed - limited.length;
    return {
      ok: true, records: groups.length, written: todo.length, batches, ...(duplicates ? { duplicates } : {}),
      unchanged, ...(changed === 0 && !limited.length ? { duplicate: true } : {}), ...(limited.length ? { rateLimited: limited, retryAfter: wait } : {}), ...(rejected.length ? { rejected } : {}),
    };
  } catch (e) {
    try { console.error('ledger write failed:', e && e.message); } catch (x) { /* logging only */ }
    // zip 186: a full database (SQLITE 7500, the 10 GB cap) is not "busy": it will not clear by retrying. 507 + retryAfter lets the till PAUSE and tell the cashier.
    if (isStorageFull(e)) return { ok: false, code: 'storage_full', status: 507, retryAfter: 300, error: 'The transaction database is full.' };
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

// ---------- one-off money events from server code (webhooks, QR payments, facility tickets) ----------
// A payment received. Idempotent on paymentId. Never throws: on a D1 failure the event is parked in a KV outbox and replayed later.
export async function recordPayment(env, clientId, p) {
  const db = ledgerDb(env);
  const now = Date.now();
  const ev = {
    paymentId: String(p.paymentId), saleId: p.saleId || null, billId: p.billId || null, orderId: p.orderId || null, method: String(p.method || 'mpesa').toLowerCase(),
    amount: round2(p.amount), code: p.code || null, by: p.by || null, source: p.source || 'server', ts: p.ts || now, status: p.status || 'CONFIRMED',
  };
  if (!(ev.amount > 0)) return { ok: false, error: 'amount' };
  if (!db) return { ok: true, skipped: 'no_db' };
  try {
    await ensureLedgerSchema(db);
    await db.batch(paymentStatements(db, clientId, ev, now));
    return { ok: true };
  } catch (e) {
    await parkInOutbox(env, clientId, { type: 'payment', ev });
    return { ok: true, parked: true, error: String((e && e.message) || e).slice(0, 160) };
  }
}
function paymentStatements(db, clientId, ev, now) {
  const st = [db.prepare(`INSERT INTO ledger_payments (client_id, payment_id, sale_id, bill_id, order_id, method, amount, mpesa_code, status, confirmed_by, source, ts, business_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (client_id, payment_id) DO UPDATE SET mpesa_code = COALESCE(ledger_payments.mpesa_code, excluded.mpesa_code), status = excluded.status
    WHERE ledger_payments.status <> excluded.status`)
    .bind(clientId, ev.paymentId, ev.saleId, ev.billId, ev.orderId, ev.method, ev.amount, str(ev.code, 40), ev.status, str(ev.by, 60), str(ev.source, 40), ev.ts, bizDate(ev.ts), now)];
  return st;
}

// ---------- gateway notifications (M-Pesa STK / till, card, KCB, PayWave) ----------
// The provider says "this much arrived". Recorded once per (provider, transaction id) — a repeated callback changes nothing, and a completed
// one is never turned back into "failed". Not a sale payment: it becomes one when a cashier attaches it (its code then appears on a
// ledger_payments row); until then it shows as unaccounted. Never throws: D1 trouble parks it in the KV outbox for replay.
export async function recordGatewayTxn(env, clientId, g) {
  const db = ledgerDb(env);
  const now = Date.now();
  const ev = { txnId: `${g.provider}:${g.txnId}`, provider: String(g.provider), code: g.code ? String(g.code).toUpperCase().slice(0, 40) : null, amount: round2(g.amount), phone: g.phone ? String(g.phone).slice(0, 20) : null,
    status: g.status || 'RECEIVED', ts: g.ts || now, trusted: g.trusted === false ? 0 : 1, raw: g.raw || null };
  if (!db) return { ok: true, skipped: 'no_db' };
  try {
    await ensureLedgerSchema(db);
    await db.batch(gatewayStatements(db, clientId, ev, now));
    return { ok: true };
  } catch (e) {
    await parkInOutbox(env, clientId, { type: 'gateway', ev, key: ev.txnId });
    return { ok: true, parked: true, error: String((e && e.message) || e).slice(0, 160) };
  }
}
function gatewayStatements(db, clientId, ev, now) {
  return [db.prepare(`INSERT INTO ledger_gateway (client_id, txn_id, provider, code, amount, phone, status, ts, business_date, trusted, raw, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (client_id, txn_id) DO UPDATE SET status = excluded.status, code = COALESCE(ledger_gateway.code, excluded.code), updated_at = excluded.updated_at
    WHERE (ledger_gateway.status = 'PENDING' AND excluded.status <> 'PENDING') OR (ledger_gateway.status = 'FAILED' AND excluded.status = 'RECEIVED')`)
    .bind(clientId, ev.txnId, ev.provider, ev.code, ev.amount, ev.phone, ev.status, ev.ts, bizDate(ev.ts), ev.trusted, ev.raw ? canon(ev.raw) : null, now, now)];
}
const outboxKey = (c) => `ledger-outbox:${c}`;
async function parkInOutbox(env, clientId, item) {
  try { const m = outboxMap(env); if (m) m.delete(clientId); } catch (e) { /* re-arms the outbox check */ }
  try {
    const raw = await env.mydukapos_kv.get(outboxKey(clientId));
    const list = raw ? JSON.parse(raw) : [];
    // zip 185: gateway events carry `txnId`, not `paymentId` - comparing paymentId (undefined === undefined) treated every parked gateway event after the first as a duplicate and dropped it
    const evKey = (i) => (i && i.ev ? (i.ev.paymentId != null ? i.ev.paymentId : i.ev.txnId) : undefined);
    if (!list.some((x) => x.type === item.type && x.ev && evKey(x) === evKey(item))) list.push(item);
    // zip 185: the cap used to drop the OLDEST parked events silently. The number dropped is now kept beside the list (never summed down) so the loss is visible.
    const dropped = Math.max(0, list.length - 500);
    if (dropped > 0) { try { const prev = Number(await env.mydukapos_kv.get(outboxKey(clientId) + ':dropped')) || 0; await env.mydukapos_kv.put(outboxKey(clientId) + ':dropped', String(prev + dropped), { expirationTtl: 30 * 86400 }); } catch (e) { /* counter only */ } try { console.error('ledger outbox full: dropped ' + dropped + ' oldest parked event(s) for ' + clientId); } catch (e) { /* log only */ } }
    await env.mydukapos_kv.put(outboxKey(clientId), JSON.stringify(list.slice(-500)), { expirationTtl: 30 * 86400 });
  } catch (e) { /* nothing more can be done */ }
}
export async function drainOutbox(env, clientId, db, opts) {
  if (!env || !env.mydukapos_kv) return 0;
  const raw = await env.mydukapos_kv.get(outboxKey(clientId));
  if (!raw) return opts && opts.emptyAsMinusOne ? -1 : 0;
  const list = JSON.parse(raw); let done = 0; const left = [];
  for (const item of list) {
    try {
      if (item.type === 'payment') await db.batch(paymentStatements(db, clientId, item.ev, Date.now()));
      else if (item.type === 'gateway') await db.batch(gatewayStatements(db, clientId, item.ev, Date.now()));
      done++;
    } catch (e) {
      left.push(item);
      if (isStorageFull(e)) { const i = list.indexOf(item); left.push(...list.slice(i + 1)); break; }      // zip 186: a full database takes none of them: stop, keep the rest parked
    }
  }
  if (left.length) await env.mydukapos_kv.put(outboxKey(clientId), JSON.stringify(left), { expirationTtl: 30 * 86400 });
  else await env.mydukapos_kv.delete(outboxKey(clientId));
  return done;
}

// ---------- reading: the numbers reports and reconciliation use (straight from D1) ----------
export async function dailyTotals(db, clientId, from, to) {
  const sales = await db.prepare(`SELECT business_date AS day, COUNT(*) AS sales, ROUND(SUM(total), 2) AS total, ROUND(SUM(cost), 2) AS cost, ROUND(SUM(credit_amount), 2) AS on_account
    FROM ledger_sales WHERE client_id = ? AND business_date BETWEEN ? AND ? AND status = 'COMPLETED' GROUP BY business_date ORDER BY business_date`).bind(clientId, from, to).all();
  const pays = await db.prepare(`SELECT business_date AS day, method, ROUND(SUM(amount), 2) AS amount, COUNT(*) AS n
    FROM ledger_payments WHERE client_id = ? AND business_date BETWEEN ? AND ? AND status = 'CONFIRMED' GROUP BY business_date, method ORDER BY business_date, method`).bind(clientId, from, to).all();
  return { sales: sales.results || [], payments: pays.results || [] };
}
// Cross-checks that must always hold. Each item lists what is wrong (empty = healthy).
export async function reconcile(db, clientId) {
  const q = async (sql, ...a) => ((await db.prepare(sql).bind(clientId, ...a).all()).results) || [];
  return {
    duplicateRefs: await q(`SELECT ref_number, COUNT(*) n FROM ledger_sales WHERE client_id = ? AND ref_number IS NOT NULL AND status = 'COMPLETED' GROUP BY ref_number HAVING n > 1`),
    salesWithoutPayment: await q(`SELECT s.sale_id, s.total FROM ledger_sales s WHERE s.client_id = ? AND s.status = 'COMPLETED' AND s.credit_amount < s.total - 0.004 AND NOT EXISTS (SELECT 1 FROM ledger_payments p WHERE p.client_id = s.client_id AND p.sale_id = s.sale_id AND p.status = 'CONFIRMED')`),
    paymentsWithoutSale: await q(`SELECT p.payment_id, p.amount FROM ledger_payments p WHERE p.client_id = ? AND p.sale_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ledger_sales s WHERE s.client_id = p.client_id AND s.sale_id = p.sale_id)`),
    duplicateSettlements: await q(`SELECT sale_id, bill_id, total, staff FROM ledger_sales WHERE client_id = ? AND status = 'DUPLICATE'`),
    overpaidBills: await q(`SELECT bill_id, total, paid FROM ledger_bill_balances WHERE client_id = ? AND paid > total + 0.01 AND total > 0`),
  };
}
// Money the providers received that no sale/payment carries yet (the "pending / unaccounted" list a cashier works through).
export async function unaccountedGateway(db, clientId, limit = 100) {
  return ((await db.prepare(`SELECT g.txn_id, g.provider, g.code, g.amount, g.phone, g.ts, g.business_date FROM ledger_gateway g
    WHERE g.client_id = ? AND g.status = 'RECEIVED' AND g.trusted = 1 AND (g.code IS NULL OR NOT EXISTS (SELECT 1 FROM ledger_payments p WHERE p.client_id = g.client_id AND upper(p.mpesa_code) = g.code AND p.status = 'CONFIRMED'))
    ORDER BY g.ts DESC LIMIT ?`).bind(clientId, limit).all()).results) || [];
}
export async function findBill(db, clientId, q) {
  const like = '%' + String(q || '').replace(/[%_]/g, '') + '%';
  return ((await db.prepare(`SELECT * FROM ledger_bill_balances WHERE client_id = ? AND (bill_id LIKE ? OR location LIKE ?) ORDER BY opened_at DESC LIMIT 25`).bind(clientId, like, like).all()).results) || [];
}
