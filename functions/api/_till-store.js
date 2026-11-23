// functions/api/_till-store.js — shared helper, NOT a route. zip 259: Till Payments (money paid straight to the M-PESA Till).
//
// WHERE THE DATA LIVES. One narrow D1 table, `till_payments`, in the SAME ledger database the shop already has (no new service, no new
// binding). A row holds only what reconciliation needs: the M-PESA transaction code (the idempotency key), the amount, Safaricom's own
// payment time, the customer name Safaricom supplied, the bill reference the payer typed (if any), a MASKED phone hint, and - once a cashier
// links it - what it was applied to (sale / bill), who did it and when. The raw callback body is never stored.
//
// IDEMPOTENCY. PRIMARY KEY (client_id, code): Safaricom re-sends a callback -> INSERT OR IGNORE keeps the first row untouched. Applying is
// ONE conditional UPDATE ... WHERE status = 'UNLINKED' and a rows-changed check, so two tills pressing Apply at the same instant cannot
// both win. The code is also claimed in mpesa_code_claims (the same table typed M-PESA codes use), so a code applied here can never be
// typed into a second sale, and a code typed into a sale can never be applied again here.
//
// RETENTION. Linked rows are bookkeeping once the sale / bill carries the payment (its own M-PESA code + the ledger_gateway row, which is
// append-only and never deleted). They are purged after APPLIED_KEEP_DAYS. UNLINKED rows are NEVER purged (that is money nobody matched).

export const APPLIED_KEEP_DAYS = 180;
export const TILL_DDL = [
  `CREATE TABLE IF NOT EXISTS till_payments (
  client_id TEXT NOT NULL,
  code TEXT NOT NULL,
  amount REAL NOT NULL,
  paid_at INTEGER NOT NULL,
  name TEXT,
  ref TEXT,
  phone_hint TEXT,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNLINKED',
  target_type TEXT,
  target_id TEXT,
  target_label TEXT,
  applied_by TEXT,
  applied_at INTEGER,
  PRIMARY KEY (client_id, code)
) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_till_recent ON till_payments (client_id, paid_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_till_status ON till_payments (client_id, status, paid_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_till_target ON till_payments (client_id, target_type, target_id)`,
  `CREATE TABLE IF NOT EXISTS mpesa_code_claims (client_id TEXT NOT NULL, code TEXT NOT NULL, sale_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (client_id, code)) WITHOUT ROWID`,
];

const ready = new WeakSet();
export async function ensureTillSchema(db) {
  if (!db || ready.has(db)) return;
  for (const s of TILL_DDL) await db.prepare(s).run();
  ready.add(db);
}
export const tillDb = (env) => (env && (env.LEDGER_DB || env.DB)) || null;

export const cleanCode = (v) => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40);

// Safaricom TransTime is YYYYMMDDHHmmss in East Africa Time (UTC+3). -> epoch ms; falls back to `fallback`.
export function parseTransTime(s, fallback = Date.now()) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(s || ''));
  if (!m) return fallback;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 3, +m[5], +m[6]);
  return Number.isFinite(t) ? t : fallback;
}

// v1 sends the plain number; v2 sends a SHA-256 hash. Keep only a hint a cashier can recognise (never the full number, never a hash).
export function phoneHint(v) {
  const s = String(v || '').trim();
  if (!s || /^[a-f0-9]{40,}$/i.test(s)) return '';
  if (s.includes('*')) return s.slice(0, 20);
  const d = s.replace(/\D/g, '');
  return d.length >= 7 ? `${d.slice(0, 4)}***${d.slice(-3)}` : '';
}

export function tillRow(r) {
  return { code: r.code, amount: r.amount, paidAt: r.paid_at, name: r.name || '', ref: r.ref || '', phoneHint: r.phone_hint || '', receivedAt: r.received_at,
    status: r.status, source: (r.status === 'STK' || r.target_type === 'stk') ? 'stk' : 'direct', targetType: r.target_type || '', targetId: r.target_id || '', targetLabel: r.target_label || '', appliedBy: r.applied_by || '', appliedAt: r.applied_at || 0 };
}

// Insert-once. -> { inserted }
export async function insertTill(db, clientId, p) {
  const r = await db.prepare(`INSERT OR IGNORE INTO till_payments (client_id, code, amount, paid_at, name, ref, phone_hint, received_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UNLINKED')`)
    .bind(clientId, p.code, p.amount, p.paidAt, p.name ? String(p.name).slice(0, 80) : null, p.ref ? String(p.ref).slice(0, 40) : null, p.phoneHint || null, p.receivedAt).run();
  return { inserted: !!(r.meta && r.meta.changes === 1) };
}

// Apply once. Atomic: the UPDATE only matches an UNLINKED row; the claim row is written only if that UPDATE changed a row.
// -> { ok:true, row } | { ok:true, repeated:true, row } (same target again) | { ok:false, code, row? }
export async function applyTill(db, clientId, code, t, now = Date.now()) {
  const type = String(t.type || '').slice(0, 12), id = String(t.id || '').slice(0, 80);
  if (!['sale', 'bill', 'manual'].includes(type) || (type !== 'manual' && !id)) return { ok: false, code: 'bad_target' };
  const claimId = type === 'manual' ? 'till:manual' : type === 'sale' ? id : `bill:${id}`;   // a sale claims by its own id, exactly as mpesa-verify does
  const row0 = await db.prepare(`SELECT * FROM till_payments WHERE client_id = ? AND code = ?`).bind(clientId, code).first();
  if (!row0) return { ok: false, code: 'not_found' };
  // 1. claim the code (the same table typed M-PESA codes use): whoever holds it owns the payment
  await db.prepare(`INSERT OR IGNORE INTO mpesa_code_claims (client_id, code, sale_id, at) VALUES (?, ?, ?, ?)`).bind(clientId, code, claimId, now).run();
  const claim = await db.prepare(`SELECT sale_id FROM mpesa_code_claims WHERE client_id = ? AND code = ?`).bind(clientId, code).first();
  const owner = claim && claim.sale_id ? String(claim.sale_id) : claimId;
  if (owner !== claimId) {
    // another sale / bill already holds this code (e.g. it was typed into a sale and verified): report that instead of applying it twice
    const cur = await db.prepare(`SELECT * FROM till_payments WHERE client_id = ? AND code = ?`).bind(clientId, code).first();
    return { ok: false, code: 'already_applied', row: tillRow(cur || row0) };
  }
  // 2. flip UNLINKED -> APPLIED exactly once
  const r = await db.prepare(`UPDATE till_payments SET status = 'APPLIED', target_type = ?, target_id = ?, target_label = ?, applied_by = ?, applied_at = ? WHERE client_id = ? AND code = ? AND status = 'UNLINKED'`)
    .bind(type, id, t.label ? String(t.label).slice(0, 80) : null, t.by ? String(t.by).slice(0, 60) : null, now, clientId, code).run();
  const row = await db.prepare(`SELECT * FROM till_payments WHERE client_id = ? AND code = ?`).bind(clientId, code).first();
  if (r.meta && r.meta.changes === 1) return { ok: true, row: tillRow(row) };
  if (row.status === 'APPLIED' && row.target_type === type && row.target_id === id) return { ok: true, repeated: true, row: tillRow(row) };
  return { ok: false, code: 'already_applied', row: tillRow(row) };
}

// Undo an apply that the till could not finish (e.g. the bill changed meanwhile). Only the SAME target may release it.
export async function releaseTill(db, clientId, code, t) {
  const type = String(t.type || ''), id = String(t.id || '');
  const r = await db.batch([
    db.prepare(`DELETE FROM mpesa_code_claims WHERE client_id = ? AND code = ? AND EXISTS (SELECT 1 FROM till_payments WHERE client_id = ? AND code = ? AND status = 'APPLIED' AND target_type = ? AND target_id = ?)`).bind(clientId, code, clientId, code, type, id),
    db.prepare(`UPDATE till_payments SET status = 'UNLINKED', target_type = NULL, target_id = NULL, target_label = NULL, applied_by = NULL, applied_at = NULL WHERE client_id = ? AND code = ? AND status = 'APPLIED' AND target_type = ? AND target_id = ?`).bind(clientId, code, type, id),
  ]);
  return { ok: !!(r[1].meta && r[1].meta.changes === 1) };
}

export async function listTill(db, clientId, { status = '', before = 0, limit = 50 } = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  const st = status === 'UNLINKED' || status === 'APPLIED' || status === 'STK' ? status : '';
  const sql = `SELECT * FROM till_payments WHERE client_id = ?${st ? ' AND status = ?' : ''}${before ? ' AND paid_at < ?' : ''} ORDER BY paid_at DESC, code DESC LIMIT ?`;
  const args = [clientId]; if (st) args.push(st); if (before) args.push(Number(before)); args.push(lim + 1);
  const { results } = await db.prepare(sql).bind(...args).all();
  const rows = (results || []).map(tillRow);
  const more = rows.length > lim;
  // zip 283: how many direct payments are still waiting to be matched (the till's button badge), independent of the page size
  let unlinked = 0;
  try { const c = await db.prepare(`SELECT COUNT(*) AS n FROM till_payments WHERE client_id = ? AND status = 'UNLINKED'`).bind(clientId).first(); unlinked = (c && Number(c.n)) || 0; } catch (e) { /* the badge falls back to the rows */ }
  return { payments: rows.slice(0, lim), more, next: more ? rows[lim - 1].paidAt : 0, unlinked };
}

export async function purgeOldApplied(db, clientId, now = Date.now(), days = APPLIED_KEEP_DAYS) {
  const cut = now - days * 86400000;
  const r = await db.prepare(`DELETE FROM till_payments WHERE client_id = ? AND status = 'APPLIED' AND code IN (SELECT code FROM till_payments WHERE client_id = ? AND status = 'APPLIED' AND applied_at < ? LIMIT 500)`).bind(clientId, clientId, cut).run();
  // zip 264: the informational STK rows age out the same way (they are a view of money the sale already carries)
  const r2 = await db.prepare(`DELETE FROM till_payments WHERE client_id = ? AND status = 'STK' AND code IN (SELECT code FROM till_payments WHERE client_id = ? AND status = 'STK' AND received_at < ? LIMIT 500)`).bind(clientId, clientId, cut).run();
  return ((r.meta && r.meta.changes) || 0) + ((r2.meta && r2.meta.changes) || 0);
}

// zip 264: a payment confirmed through an STK push is listed beside the direct Till payments, so the owner sees every payment in one place. It is a
// record only: status 'STK' (never UNLINKED, so it is not counted as waiting and cannot be matched or applied - the sale that triggered the prompt already
// carries it). The payer's phone is kept in full (staff-only screen; the STK result itself carries it; Safaricom sends no name for a prompt).
// IDEMPOTENT: keyed on the M-PESA receipt; while the receipt is not known yet (the status query confirmed it before the callback) the row is keyed on the
// checkout id, and the real receipt replaces that row when it arrives. Best effort: it never fails the payment it describes.
export async function noteStkPayment(env, clientId, p) {
  const db = tillDb(env);
  if (!db || !clientId || !p || !p.checkoutId) return;
  try {
    await ensureTillSchema(db);
    const cid = cleanCode(p.checkoutId);
    const real = cleanCode(p.receipt);
    const code = real || ('W' + cid.slice(-20));
    const now = Date.now();
    await db.prepare(`INSERT OR IGNORE INTO till_payments (client_id, code, amount, paid_at, name, ref, phone_hint, received_at, status, target_type, target_id, target_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STK', 'stk', ?, ?)`)
      .bind(clientId, code, Number(p.amount) || 0, parseTransTime(p.transactionDate, now), null, null, String(p.phone || '').replace(/[^\d*+]/g, '').slice(0, 20) || null, now, String(p.checkoutId).slice(0, 100), String(p.provider || 'stk').slice(0, 20)).run();
    if (real) {
      await db.prepare(`DELETE FROM till_payments WHERE client_id = ? AND status = 'STK' AND target_id = ? AND code <> ?`).bind(clientId, String(p.checkoutId).slice(0, 100), code).run();
      // the same payment may already be listed from Safaricom's Till confirmation (it also fires for an STK push, and carries the payer's NAME): it is an STK
      // payment - the sale that sent the prompt carries it - so it leaves the "waiting" list, keeping the name, and gains the full phone
      await db.prepare(`UPDATE till_payments SET status = 'STK', target_type = 'stk', target_id = ?, target_label = ?, phone_hint = COALESCE(?, phone_hint) WHERE client_id = ? AND code = ? AND status = 'UNLINKED'`)
        .bind(String(p.checkoutId).slice(0, 100), String(p.provider || 'stk').slice(0, 20), String(p.phone || '').replace(/[^\d*+]/g, '').slice(0, 20) || null, clientId, code).run();
    }
  } catch (e) { /* a listing row must never break a payment */ }
}

// zip 265: Safaricom's Till (C2B) confirmation is also sent for a payment made through an STK push, and it is the only message that carries the payer's NAME
// (the STK result itself has only the phone). This joins the two, best effort:
//  1. the same M-PESA code is already listed as an STK row -> it gains the name;
//  2. the STK result never arrived (the row is still waiting for its receipt): the one pending STK prompt with the SAME amount and the SAME payer phone
//     (a plain number, or Safaricom's SHA-256 of it in C2B v2) is given this code and name, and the till's pending record gets the receipt too.
//     Two candidates, or no phone proof -> nothing is guessed.
const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function samePayer(stkPhone, msisdn) {
  const p = digitsOf(stkPhone), m = String(msisdn == null ? '' : msisdn).trim();
  if (p.length < 9 || !m) return false;
  if (/^[a-f0-9]{64}$/i.test(m)) return (await sha256Hex(p)).toLowerCase() === m.toLowerCase();
  const d = digitsOf(m);
  return !m.includes('*') && d.length >= 9 && d.slice(-9) === p.slice(-9);
}
export const PENDING_STK_WINDOW_MS = 20 * 60 * 1000;
export async function reconcileC2bWithStk(env, clientId, p) {
  const db = tillDb(env);
  if (!db || !clientId || !p || !p.code) return null;
  try {
    await ensureTillSchema(db);
    const name = p.name ? String(p.name).slice(0, 80) : '';
    const same = await db.prepare(`SELECT code FROM till_payments WHERE client_id = ? AND code = ? AND status = 'STK'`).bind(clientId, p.code).first();
    if (same) {
      if (name) await db.prepare(`UPDATE till_payments SET name = ? WHERE client_id = ? AND code = ? AND status = 'STK' AND (name IS NULL OR name = '')`).bind(name, clientId, p.code).run();
      return { joined: 'receipt' };
    }
    const now = Date.now();
    const { results } = await db.prepare(`SELECT code, target_id, phone_hint FROM till_payments WHERE client_id = ? AND status = 'STK' AND code LIKE 'W%' AND amount = ? AND received_at > ?`).bind(clientId, Number(p.amount) || 0, now - PENDING_STK_WINDOW_MS).all();
    const hits = [];
    for (const r of results || []) if (await samePayer(r.phone_hint, p.msisdn)) hits.push(r);
    if (hits.length !== 1) return null;
    const row = hits[0];
    await db.batch([
      db.prepare(`DELETE FROM till_payments WHERE client_id = ? AND code = ? AND status = 'UNLINKED'`).bind(clientId, p.code),
      db.prepare(`UPDATE till_payments SET code = ?, name = ?, paid_at = ? WHERE client_id = ? AND code = ? AND status = 'STK'`).bind(p.code, name || null, Number(p.paidAt) || now, clientId, row.code),
    ]);
    // the till is polling the pending record: give it the receipt and the name
    try {
      const k = `mpesa-tx:${clientId}:${row.target_id}`;
      const raw = await env.mydukapos_kv.get(k);
      if (raw) { const rec = JSON.parse(raw); await env.mydukapos_kv.put(k, JSON.stringify({ ...rec, receiptNumber: rec.receiptNumber || p.code, receiptPending: false, payerName: rec.payerName || name || undefined })); }
    } catch (e) { /* the list row above is already right */ }
    return { joined: 'pending' };
  } catch (e) { return null; }
}

// the payer name Safaricom's Till confirmation supplied for an STK push (by M-PESA code, or by the prompt's checkout id) - '' when not known (yet)
export async function stkPayerName(env, clientId, { code, checkoutId }) {
  const db = tillDb(env);
  if (!db || !clientId) return { name: '', code: '' };
  try {
    await ensureTillSchema(db);
    const c = cleanCode(code), id = String(checkoutId || '').slice(0, 100);
    const r = await db.prepare(`SELECT code, name FROM till_payments WHERE client_id = ? AND ((? <> '' AND code = ?) OR (? <> '' AND target_id = ?)) ORDER BY (name IS NOT NULL AND name <> '') DESC LIMIT 1`).bind(clientId, c, c, id, id).first();
    return r ? { name: r.name || '', code: /^W/.test(r.code) && !c ? '' : r.code } : { name: '', code: '' };
  } catch (e) { return { name: '', code: '' }; }
}

// zip 378: a money amount from a payment provider -> number. parseFloat("22,000.00") is 22, so a payment with a thousands separator was recorded as
// KES 22 and every sale it paid was flagged "paid less than the sale". Commas, spaces and a currency word are removed first.
export function parseMoney(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(String(v == null ? '' : v));    // the first number in it: "KES. 22,000.00" -> 22000
  const n = m ? Number(m[0].replace(/,/g, '')) : 0;
  return Number.isFinite(n) ? n : 0;
}
