// functions/api/till-payments.js — Cloudflare Pages Function. zip 259 (Sales Counter -> Till Payments).
//
// Money customers paid straight to the shop's M-PESA Till (no STK push), captured by the Daraja C2B confirmation callback
// (mpesa-c2b-confirmation.js; Safaricom calls us - nothing here ever polls Safaricom). Rows live in the D1 table `till_payments`
// (functions/api/_till-store.js). Older deployments with no D1 keep working from the KV list.
//
//   GET  ?status=UNLINKED|APPLIED&before=<ms>&limit=50  -> { payments:[{code, amount, paidAt, name, ref, phoneHint, status, targetType, targetId, targetLabel, appliedBy, appliedAt}], more, next }
//   POST { action:'apply',   code, targetType:'sale'|'bill', targetId, label? }  -> links the payment ONCE. 409 if it is already linked elsewhere.
//   POST { action:'release', code, targetType, targetId }                         -> undoes an apply the till could not finish (same target only)
//   POST { transId, matched }  (legacy Settings panel) -> manual flag, same one-time rule.
//
// Same rules as every staff action: valid shop link, paired-device rule, and a signed-in staff member WITH the `payments` permission
// when the shop requires staff sessions.

import { requireValidLicense } from './_license.js';
import { deviceGuard } from './_device-auth.js';
import { staffGuard } from './_staff-auth.js';
import { corsHeadersFor } from './_cors.js';
import { tillDb, ensureTillSchema, applyTill, releaseTill, listTill, purgeOldApplied, cleanCode } from './_till-store.js';

function jsonResponse(body, status = 200, cors = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
}
function tillPaymentKey(clientId, transId) { return `till-payment:${clientId}:${transId}`; }
function tillPaymentIndexKey(clientId) { return `till-payment-index:${clientId}`; }

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

async function gate(context, perm) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const license = await requireValidLicense(request, env);
  if (!license.valid) return { res: jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403, cors) };
  const clientId = license.clientId;
  const deviceDenied = await deviceGuard(request, env, clientId, cors);
  if (deviceDenied) return { res: deviceDenied };
  const sg = await staffGuard(request, env, clientId, perm, cors);
  if (sg.denied) return { res: sg.denied };
  return { clientId, cors, who: (sg.claims && sg.claims.name) || '' };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const g = await gate(context, null);
  if (g.res) return g.res;
  const { clientId, cors } = g;
  const u = new URL(request.url);
  const db = tillDb(env);
  if (db) {
    try {
      await ensureTillSchema(db);
      const out = await listTill(db, clientId, { status: (u.searchParams.get('status') || '').toUpperCase(), before: Number(u.searchParams.get('before')) || 0, limit: Number(u.searchParams.get('limit')) || 50 });
      // retention: at most once a day per shop, a bounded delete of old LINKED rows (unlinked money is never purged)
      try {
        const pk = `till-purge:${clientId}`;
        if (!(await env.mydukapos_kv.get(pk))) { await env.mydukapos_kv.put(pk, '1', { expirationTtl: 86400 }); await purgeOldApplied(db, clientId); }
      } catch (e) { /* retention is housekeeping */ }
      return jsonResponse(out, 200, cors);
    } catch (e) { /* fall through to the KV list */ }
  }
  const idxRaw = await env.mydukapos_kv.get(tillPaymentIndexKey(clientId));
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  const recs = (await Promise.all(idx.slice(0, 50).map(async (t) => { const raw = await env.mydukapos_kv.get(tillPaymentKey(clientId, t)); return raw ? JSON.parse(raw) : null; }))).filter(Boolean);
  const payments = recs.map((r) => ({ code: r.transId, amount: r.amount, paidAt: r.receivedAt, name: r.customerName || '', ref: r.accountRef || '', phoneHint: '', status: r.matched ? 'APPLIED' : 'UNLINKED', targetType: r.matched ? 'manual' : '', targetId: '', targetLabel: '', appliedBy: '', appliedAt: 0 }));
  return jsonResponse({ payments, more: false, next: 0 }, 200, cors);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid request body.' }, 400); }
  body = body || {};
  const action = body.action || (body.transId ? 'legacy' : '');
  const g = await gate(context, 'payments');
  if (g.res) return g.res;
  const { clientId, cors, who } = g;
  const code = cleanCode(body.code || body.transId);
  if (!code) return jsonResponse({ error: 'Missing payment code.' }, 400, cors);
  const db = tillDb(env);

  if (!db) {   // older deployment: KV flag only (the previous behaviour)
    const key = tillPaymentKey(clientId, body.transId || code);
    const raw = await env.mydukapos_kv.get(key);
    if (!raw) return jsonResponse({ error: 'Payment not found.' }, 404, cors);
    const record = JSON.parse(raw);
    record.matched = action === 'release' ? false : action === 'apply' ? true : !!body.matched;
    await env.mydukapos_kv.put(key, JSON.stringify(record), { expirationTtl: 45 * 24 * 3600 });
    return jsonResponse({ success: true, ok: true }, 200, cors);
  }
  try { await ensureTillSchema(db); } catch (e) { return jsonResponse({ error: 'The payment database is not ready - try again.' }, 503, cors); }
  const by = who || String(body.by || '').slice(0, 60);

  if (action === 'apply' || (action === 'legacy' && body.matched)) {
    const t = action === 'apply' ? { type: String(body.targetType || ''), id: String(body.targetId || ''), label: body.label, by } : { type: 'manual', id: '', label: 'marked as matched', by };
    const r = await applyTill(db, clientId, code, t);
    if (r.ok) return jsonResponse({ ok: true, success: true, repeated: !!r.repeated, payment: r.row }, 200, cors);
    if (r.code === 'not_found') return jsonResponse({ ok: false, error: 'Payment not found.' }, 404, cors);
    if (r.code === 'bad_target') return jsonResponse({ ok: false, error: 'Choose a sale or a bill to link this payment to.' }, 400, cors);
    return jsonResponse({ ok: false, code: 'already_applied', error: 'This payment was already applied' + (r.row && r.row.targetType ? ` to ${r.row.targetType} ${r.row.targetLabel || r.row.targetId}` : '') + '.', payment: r.row }, 409, cors);
  }
  if (action === 'release' || action === 'legacy') {
    const m = action === 'release' ? { type: String(body.targetType || ''), id: String(body.targetId || '') } : { type: 'manual', id: '' };
    const r = await releaseTill(db, clientId, code, m);
    return jsonResponse({ ok: r.ok, success: r.ok }, r.ok ? 200 : 409, cors);
  }
  return jsonResponse({ error: 'Unknown action.' }, 400, cors);
}
