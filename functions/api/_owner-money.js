// functions/api/_owner-money.js — the ONE money record of the Owner Console (zip 304). NOT a route (owner-money.js is the route).
//
// WHY. Money used to be counted in several places that did not know about each other:
//   1. the billing ledger (bill-evt / bill-ref in KV): every permanent-link purchase, renewal and add-on, written by the server when a payment was
//      confirmed (M-Pesa prompt, or the owner's "Confirm payment");
//   2. the console's own sales book (salesLog in the owner's POS state), fed BY HAND from two different forms: the per-link "💰 Income recorded" toggle
//      and the per-person "Quote & Payments" list. Both pushed a sale; neither checked the other, nor the billing ledger.
// The Dashboard's "Revenue" added up (2) only, the Billing tab listed (1) only. A KES 3,000 link confirmed by the owner was in (1) automatically, and the
// confirmation then told the owner to "record its income with the 💰 toggle" - so it went into (2) as well; recording the same person in "Quote &
// Payments" put it in (2) a second time. That is how one KES 3,000 sale became KES 6,000 or more. "Make permanent" also wrote a KES 3,000 purchase into (1)
// for links that were given away free.
//
// NOW. One table, owner_money, in the owner database (OWNER_DB, D1). Every row is ONE commercial event with a STABLE ref (its primary key), so a retried
// callback, a double click, two tabs or a re-run import can never add it twice (INSERT ... ON CONFLICT DO NOTHING). An M-Pesa receipt can be counted only
// once (a partial UNIQUE index); a second row with the same receipt is kept but marked "review" and not counted. Rows are never deleted or edited in place:
// a refund is its own row linked to the original, a correction is an audited status change with a reason.
// The SAME function (summarize) computes every total the console shows (Dashboard, Money tab, exports), so two screens with the same filters always agree.
//
// Without OWNER_DB the rows live in KV (key omoney:<ref>, row in the key's metadata, so a list needs no extra reads). KV cannot make the ref check atomic;
// that limitation is reported on the Money tab (store: 'kv').
//
// Amounts are integer cents (KES x 100).

import { randomToken } from './_license.js';

export const MONEY_SCHEMA_VERSION = 1;
export const MONEY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS owner_money (
  ref TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL DEFAULT '',
  group_key TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  amount_c INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'KES',
  status TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  provider_ref TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  related_ref TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS ix_money_created ON owner_money (created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_money_client ON owner_money (client_id)`,
  `CREATE INDEX IF NOT EXISTS ix_money_status ON owner_money (status)`,
  // one M-Pesa / bank receipt = one counted payment
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_money_receipt ON owner_money (provider_ref) WHERE provider_ref <> '' AND status = 'success' AND kind <> 'refund'`,
  `CREATE TABLE IF NOT EXISTS owner_money_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  before_json TEXT,
  after_json TEXT
)`,
  `CREATE INDEX IF NOT EXISTS ix_money_log_at ON owner_money_log (at)`,
  `CREATE TABLE IF NOT EXISTS owner_meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`,
];

// What each kind of row is. `money: true` = money received (counts in collected revenue when status is success).
export const KINDS = {
  link_sale: { label: 'Permanent link sale', money: true },
  branch_sale: { label: 'Branch link sale', money: true },
  subscription: { label: 'Subscription renewal', money: true },
  addon: { label: 'Add-on (branches / staff)', money: true },
  other_income: { label: 'Other income', money: true },
  refund: { label: 'Refund / reversal', money: false },
  charge: { label: 'Amount agreed (not money)', money: false },
};
export const STATUSES = ['success', 'pending', 'failed', 'cancelled', 'complimentary', 'review', 'excluded', 'reversed', 'open'];
// Metric definitions, shown on screen next to every figure (one definition, used everywhere).
export const DEFINITIONS = {
  linkSales: 'Permanent-link sales value: permanent and branch links that were actually paid for (status success), counted once each. Free, test and complimentary links are not sales.',
  collected: 'Collected revenue: every successful payment received (link sales, renewals, add-ons, other income), each counted once. Pending, failed and cancelled payments are not included.',
  pending: 'Pending payments: payments requested or claimed but not confirmed yet. Not money received.',
  failed: 'Failed or cancelled payments: shown for follow-up only. Never counted.',
  refunds: 'Refunds: money returned, recorded as its own row linked to the original payment.',
  net: 'Net collected revenue = collected revenue − refunds.',
  outstanding: 'Outstanding: amounts you recorded as agreed with a client minus what they have paid towards them.',
  review: 'Needs review: entries MyDuka could not safely count (probable duplicates, a receipt already used). Not counted until you decide.',
};

const clamp = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
export const toCents = (kes) => { const n = Number(kes); if (!Number.isFinite(n)) return NaN; const c = n * 100; return c < 0 ? -Math.round(-c) : Math.round(c); };
export const db = (env) => (env && env.OWNER_DB) || null;
const ready = new WeakMap();
export async function ensureMoneySchema(d) {
  if (!d) return false;
  if (ready.get(d)) return true;
  let ok = false;
  try { const r = await d.prepare(`SELECT v FROM owner_meta WHERE k = 'money_schema'`).first(); ok = !!(r && Number(r.v) >= MONEY_SCHEMA_VERSION); } catch (e) { ok = false; }
  if (!ok) {
    await d.batch(MONEY_SCHEMA.map((s) => d.prepare(s)));
    await d.prepare(`INSERT INTO owner_meta (k, v) VALUES ('money_schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(MONEY_SCHEMA_VERSION)).run();
  }
  ready.set(d, true);
  return true;
}

function normRow(r, now = Date.now()) {
  const kind = KINDS[r.kind] ? r.kind : 'other_income';
  const status = STATUSES.includes(r.status) ? r.status : 'success';
  const amount = Number.isFinite(Number(r.amount_c)) ? Math.round(Number(r.amount_c)) : 0;
  return {
    ref: clamp(r.ref, 200), kind, client_id: clamp(r.client_id, 80), group_key: clamp(r.group_key, 120).toLowerCase(), label: clamp(r.label, 160),
    amount_c: Math.max(0, amount), currency: 'KES', status, method: clamp(r.method, 30), provider: clamp(r.provider, 40), provider_ref: clamp(r.provider_ref, 60).toUpperCase(),
    verified: r.verified ? 1 : 0, source: clamp(r.source, 40), related_ref: clamp(r.related_ref, 200), created_at: Number(r.created_at) || now,
    confirmed_at: r.confirmed_at == null ? null : Number(r.confirmed_at) || null, note: clamp(r.note, 600), actor: clamp(r.actor, 60),
    meta_json: typeof r.meta_json === 'string' ? r.meta_json.slice(0, 4000) : JSON.stringify(r.meta || {}).slice(0, 4000), updated_at: now,
  };
}
const COLS = ['ref', 'kind', 'client_id', 'group_key', 'label', 'amount_c', 'currency', 'status', 'method', 'provider', 'provider_ref', 'verified', 'source', 'related_ref', 'created_at', 'confirmed_at', 'note', 'actor', 'meta_json', 'updated_at'];
const INSERT = `INSERT INTO owner_money (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')}) ON CONFLICT(ref) DO NOTHING`;
const KV_PREFIX = 'omoney:';
// KV metadata is limited to 1024 bytes: the row without its long fields
const kvMeta = (row) => {
  const m = { ...row }; m.meta_json = '{}'; m.note = m.note.slice(0, 160); m.label = m.label.slice(0, 80);
  for (const [k, n] of [['note', 60], ['label', 40], ['group_key', 40], ['related_ref', 120], ['note', 0], ['actor', 20]]) { if (JSON.stringify(m).length <= 1000) break; m[k] = String(m[k] || '').slice(0, n); }
  return m;
};

// -> { inserted: true, row } the first time this ref is seen; { inserted: false, existing } after (nothing changes). Never throws for a duplicate.
// A row whose receipt was already counted under another ref is stored as status 'review' (kept, visible, not counted).
export async function recordMoney(env, input) {
  const row = normRow(input);
  if (!row.ref) throw new Error('money row without ref');
  const d = db(env);
  if (d) {
    await ensureMoneySchema(d);
    let r;
    try { r = await d.prepare(INSERT).bind(...COLS.map((c) => row[c])).run(); }
    catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message))) throw e;
      const prior = await d.prepare(`SELECT ref FROM owner_money WHERE provider_ref = ? AND status = 'success' AND kind <> 'refund' LIMIT 1`).bind(row.provider_ref).first();
      row.status = 'review'; row.related_ref = row.related_ref || (prior && prior.ref) || ''; row.note = (`Receipt ${row.provider_ref} was already counted (${row.related_ref}). ` + row.note).slice(0, 600);
      r = await d.prepare(INSERT).bind(...COLS.map((c) => row[c])).run();
    }
    if (r && r.meta && Number(r.meta.changes) > 0) { await log(env, { action: 'record', ref: row.ref, actor: row.actor || row.source, note: row.kind + ' ' + row.status, after: row }); return { inserted: true, row }; }
    const existing = await d.prepare(`SELECT * FROM owner_money WHERE ref = ?`).bind(row.ref).first();
    return { inserted: false, existing };
  }
  const key = KV_PREFIX + row.ref;
  const seen = await env.mydukapos_kv.getWithMetadata(key);
  if (seen && seen.value != null) return { inserted: false, existing: seen.metadata || null };
  if (row.provider_ref && row.status === 'success' && row.kind !== 'refund') {
    const all = await listAll(env);
    const dup = all.find((x) => x.provider_ref === row.provider_ref && x.status === 'success' && x.kind !== 'refund');
    if (dup) { row.status = 'review'; row.related_ref = dup.ref; row.note = (`Receipt ${row.provider_ref} was already counted (${dup.ref}). ` + row.note).slice(0, 600); }
  }
  await env.mydukapos_kv.put(key, JSON.stringify(row), { metadata: kvMeta(row) });
  await log(env, { action: 'record', ref: row.ref, actor: row.actor || row.source, note: row.kind + ' ' + row.status, after: row });
  return { inserted: true, row };
}

// The ONLY way a row changes after it was written: a status change with a reason, logged with before / after. Amounts never change.
export async function setStatus(env, ref, status, { actor = 'owner', reason = '' } = {}) {
  if (!STATUSES.includes(status)) return { ok: false, error: 'Unknown status.' };
  if (!clamp(reason, 300)) return { ok: false, error: 'Give a reason for this change.' };
  const before = await getRow(env, ref);
  if (!before) return { ok: false, error: 'No such entry.' };
  if (before.status === status) return { ok: true, row: before, unchanged: true };
  const now = Date.now();
  const d = db(env);
  if (status === 'success' && before.provider_ref) {
    const clash = (await listAll(env)).find((x) => x.ref !== ref && x.provider_ref === before.provider_ref && x.status === 'success' && x.kind !== 'refund');
    if (clash) return { ok: false, error: `Receipt ${before.provider_ref} is already counted in ${clash.ref}. Exclude that one first if this is the right one.` };
  }
  const after = { ...before, status, updated_at: now, note: (before.note + ` [${new Date(now).toISOString().slice(0, 16)} ${status}: ${clamp(reason, 200)}]`).slice(-600) };
  if (d) await d.prepare(`UPDATE owner_money SET status = ?, note = ?, updated_at = ? WHERE ref = ?`).bind(after.status, after.note, now, ref).run();
  else await env.mydukapos_kv.put(KV_PREFIX + ref, JSON.stringify(after), { metadata: kvMeta(after) });
  await log(env, { action: 'status', ref, actor, note: `${before.status} -> ${status}: ${clamp(reason, 300)}`, before: { status: before.status }, after: { status } });
  return { ok: true, row: after };
}

// Links a payment to the agreed amount it pays towards (only when it is not linked yet). Not an amount or status change.
export async function linkToCharge(env, ref, chargeRef) {
  const d = db(env);
  if (d) { await d.prepare(`UPDATE owner_money SET related_ref = ? WHERE ref = ? AND related_ref = ''`).bind(chargeRef, ref).run(); return; }
  const raw = await env.mydukapos_kv.get(KV_PREFIX + ref); if (!raw) return;
  const row = JSON.parse(raw); if (row.related_ref) return;
  row.related_ref = chargeRef; await env.mydukapos_kv.put(KV_PREFIX + ref, JSON.stringify(row), { metadata: kvMeta(row) });
}

// Only for a claim whose follow-up work FAILED (the payment was not applied): the row is taken back so the retry starts clean. Logged.
export async function deleteFailedRow(env, ref) {
  const d = db(env);
  if (d) await d.prepare(`DELETE FROM owner_money WHERE ref = ?`).bind(String(ref)).run();
  else await env.mydukapos_kv.delete(KV_PREFIX + String(ref));
  await log(env, { action: 'rollback', ref, actor: 'server', note: 'payment work failed; row withdrawn so the retry can finish it' });
}

export async function getRow(env, ref) {
  const d = db(env);
  if (d) { await ensureMoneySchema(d); return (await d.prepare(`SELECT * FROM owner_money WHERE ref = ?`).bind(String(ref)).first()) || null; }
  const raw = await env.mydukapos_kv.get(KV_PREFIX + String(ref));
  return raw ? JSON.parse(raw) : null;
}

export async function listAll(env) {
  const d = db(env);
  if (d) { await ensureMoneySchema(d); return ((await d.prepare(`SELECT * FROM owner_money ORDER BY created_at DESC, ref`).all()).results || []); }
  const out = []; let cursor;
  for (let i = 0; i < 200; i++) {
    const page = await env.mydukapos_kv.list({ prefix: KV_PREFIX, cursor, limit: 1000 });
    for (const k of page.keys) if (k.metadata) out.push(k.metadata);
    if (page.list_complete || !page.cursor) break; cursor = page.cursor;
  }
  return out.sort((a, b) => (b.created_at - a.created_at) || (a.ref < b.ref ? -1 : 1));
}

async function log(env, { action, ref = '', actor = '', note = '', before, after }) {
  const at = Date.now(), id = String(9999999999999 - at).padStart(13, '0') + ':' + randomToken(4);
  const d = db(env);
  try {
    if (d) await d.prepare(`INSERT INTO owner_money_log (id, at, actor, action, ref, note, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, at, clamp(actor, 60), clamp(action, 40), clamp(ref, 200), clamp(note, 600), before === undefined ? null : JSON.stringify(before).slice(0, 4000), after === undefined ? null : JSON.stringify(after).slice(0, 4000)).run();
    else await env.mydukapos_kv.put('omoney-log:' + id, JSON.stringify({ at, actor, action, ref, note }), { expirationTtl: 5 * 365 * 86400, metadata: { at, actor: clamp(actor, 40), action, ref: clamp(ref, 120), note: clamp(note, 300) } });
  } catch (e) { /* the log never blocks the money row itself */ }
}
export async function listLog(env, { limit = 100 } = {}) {
  const d = db(env);
  if (d) { await ensureMoneySchema(d); return ((await d.prepare(`SELECT id, at, actor, action, ref, note FROM owner_money_log ORDER BY id LIMIT ?`).bind(Math.min(500, limit)).all()).results || []); }
  const page = await env.mydukapos_kv.list({ prefix: 'omoney-log:', limit: Math.min(500, limit) });
  return page.keys.map((k) => k.metadata).filter(Boolean);
}

/* ================================================================ ONE calculation */
// rows: what listAll returned. filters: { from, to (ms, on created_at), kind, status, clientId, q }
export function filterRows(rows, f = {}) {
  const q = String(f.q || '').trim().toLowerCase();
  return rows.filter((r) => {
    if (f.from && r.created_at < f.from) return false;
    if (f.to && r.created_at > f.to) return false;
    if (f.kind && r.kind !== f.kind) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.clientId && r.client_id !== f.clientId) return false;
    if (q && !(`${r.ref} ${r.label} ${r.client_id} ${r.provider_ref} ${r.note} ${r.method}`.toLowerCase().includes(q))) return false;
    return true;
  });
}
export function summarize(rows) {
  const s = { linkSalesC: 0, linkSalesN: 0, collectedC: 0, collectedN: 0, pendingC: 0, pendingN: 0, failedC: 0, failedN: 0, refundsC: 0, refundsN: 0, reviewC: 0, reviewN: 0,
    complimentaryN: 0, byKind: {}, byMonth: {}, verifiedC: 0, manualC: 0, outstandingC: 0, outstandingClients: 0 };
  const charges = {}, paidToCharge = {}, linkIds = {};
  for (const r of rows) if (r.kind === 'charge' && (r.status === 'open' || r.status === 'success')) charges[r.ref] = { a: Number(r.amount_c) || 0, client: r.client_id || r.group_key };
  for (const r of rows) {
    const k = KINDS[r.kind] || KINDS.other_income, a = Number(r.amount_c) || 0;
    if (r.kind === 'charge') continue;
    if (r.kind === 'refund') { if (r.status === 'success') { s.refundsC += a; s.refundsN++; } continue; }
    if (!k.money) continue;
    if (r.status === 'success') {
      s.collectedC += a; s.collectedN++;
      if (r.kind === 'link_sale' || r.kind === 'branch_sale') { s.linkSalesC += a; linkIds[r.client_id || r.ref] = 1; }
      if (r.verified) s.verifiedC += a; else s.manualC += a;
      (s.byKind[r.kind] = s.byKind[r.kind] || { c: 0, n: 0 }).c += a; s.byKind[r.kind].n++;
      const m = new Date(r.created_at + 3 * 3600000).toISOString().slice(0, 7);         // the month in Nairobi time
      s.byMonth[m] = (s.byMonth[m] || 0) + a;
      if (r.related_ref && charges[r.related_ref]) paidToCharge[r.related_ref] = (paidToCharge[r.related_ref] || 0) + a;
    } else if (r.status === 'pending') { s.pendingC += a; s.pendingN++; }
    else if (r.status === 'failed' || r.status === 'cancelled') { s.failedC += a; s.failedN++; }
    else if (r.status === 'review') { s.reviewC += a; s.reviewN++; }
    else if (r.status === 'complimentary') s.complimentaryN++;
  }
  const owing = {};
  for (const ref of Object.keys(charges)) { const left = Math.max(0, charges[ref].a - (paidToCharge[ref] || 0)); if (left > 0) { s.outstandingC += left; owing[charges[ref].client] = 1; } }
  s.outstandingClients = Object.keys(owing).length;
  s.linkSalesN = Object.keys(linkIds).length;                                    // links sold (a link paid in two parts is one sale)
  s.netC = s.collectedC - s.refundsC;
  return s;
}

/* ================================================================ writers used by the payment paths */
// From claimRef (the billing ledger): purchase / renewal / addon / reversal. ref = the billing ref, so the two can never disagree about "once".
export function rowFromBillingEvent(evt, extra = {}) {
  if (!evt || !evt.ref) return null;
  const kindMap = { purchase: 'link_sale', renewal: 'subscription', addon: 'addon', reversal: 'refund' };
  const kind = kindMap[evt.kind];
  if (!kind) return null;                                                                 // flags, addon-confirm markers: not money
  const method = String(evt.method || '');
  const verified = method === 'stk' || method === 'gateway' || method === 'paywave' || method === 'daraja';
  const complimentary = method === 'complimentary' || (evt.data && evt.data.complimentary);
  const amount = Math.abs(Number(evt.amount) || 0);
  return {
    ref: evt.ref, kind: kind === 'link_sale' && evt.data && evt.data.branch ? 'branch_sale' : kind, client_id: evt.clientId || '', label: extra.label || '',
    amount_c: complimentary ? 0 : toCents(amount), status: complimentary ? 'complimentary' : 'success', method: verified ? 'mpesa' : (method === 'owner-confirmed' ? 'owner-confirmed' : method),
    provider: verified ? 'gateway' : method || 'owner', provider_ref: evt.receipt || '', verified, source: verified ? 'gateway' : 'owner-confirmed',
    related_ref: kind === 'refund' && evt.data ? evt.data.of || '' : '', created_at: evt.at || Date.now(), confirmed_at: evt.at || Date.now(),
    note: clamp(evt.note || '', 300), actor: evt.actor || (verified ? 'payment gateway' : 'owner'), meta: { billing: true, data: evt.data || {}, listAmountC: complimentary ? toCents((evt.data && evt.data.listAmount) || amount) : undefined },
  };
}
