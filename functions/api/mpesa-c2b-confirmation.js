// functions/api/mpesa-c2b-confirmation.js — Cloudflare Pages Function
//
// Safaricom calls THIS endpoint automatically, in real time, whenever a
// customer pays directly to a shop's Paybill/Till — typing the number into
// their own M-Pesa menu themselves, with no STK Push and no app involvement
// at all. This is the only way to capture who paid, how much, and when for
// that kind of payment; there is no polling or app-side action that could
// otherwise learn about it.
//
// Requires a ONE-TIME setup step first: the shop's Validation and
// Confirmation URLs (this file, and mpesa-c2b-validation.js) must be
// registered with Safaricom against their Paybill/Till — see
// mpesa-c2b-register.js, called from the "Register Till URLs" button in
// Settings -> Payment Gateway. Only works once Daraja credentials (Option B)
// are saved for this shop, since the registration call needs them.
//
// Scoped per client via the `c` query param baked into the URL that was
// registered — see mpesa-c2b-register.js for how that URL is built.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { checkCallback, shopKnown, readCallbackJson } from './_callback-key.js';
import { recordGatewayTxn } from './_ledger.js';
import { tillDb, ensureTillSchema, insertTill, cleanCode, parseTransTime, phoneHint } from './_till-store.js';

function tillPaymentKey(clientId, transId) {
  return `till-payment:${clientId}:${transId}`;
}

function tillPaymentIndexKey(clientId) {
  return `till-payment-index:${clientId}`;
}

function ack(extra = {}) {
  return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted', ...extra }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientId = new URL(request.url).searchParams.get('c') || '';
  if (!clientId) {
    // No client id in the confirmation URL — nothing we can attribute this
    // to, but Safaricom still needs a 200 or it'll retry indefinitely.
    return ack();
  }

  const data = await readCallbackJson(request);      // zip 185: size-bounded
  if (!data || typeof data !== 'object') return ack();

  const transId = data.TransID != null ? String(data.TransID) : '';
  if (!transId || transId.length > 40) return ack();
  if (!(await shopKnown(env, clientId))) return ack();   // zip 185: not a real shop -> nothing is written

  // A customer's registered name arrives as up to three separate fields —
  // joined here into one, skipping any that are genuinely blank (a
  // corporate line or an unregistered name sometimes leaves Middle/Last
  // blank rather than sending empty strings, so this can't just naively
  // join all three with spaces every time).
  const fullName = [data.FirstName, data.MiddleName, data.LastName]
    .filter((n) => n && String(n).trim())
    .join(' ');

  const signed = await checkCallback(env, clientId, 'c2b', request.url);
  const receivedAt = Date.now();
  const amount = parseFloat(data.TransAmount) || 0;
  // zip 259: only what reconciliation needs. The full callback body (shortcode, org balance, full MSISDN ...) is NOT kept. With Daraja C2B v2 the
  // MSISDN arrives hashed anyway; a plain number (v1) is reduced to a masked hint.
  const record = {
    transId, transTime: data.TransTime || '', amount, customerName: fullName, accountRef: String(data.BillRefNumber || '').slice(0, 40),
    receivedAt, trusted: signed.ok,
    ...(signed.legacy ? { legacy: true } : {}),   // zip 185: accepted only because this shop has no callback key yet - Owner fix: Register Till URLs again
  };

  // An unsigned post for a shop that has a key is not stored where the till looks for payments: it cannot pre-empt the real one.
  if (!signed.ok) {
    await env.mydukapos_kv.put(`till-payment-rejected:${clientId}:${transId}`, JSON.stringify({ transId, amount, receivedAt }), { expirationTtl: 30 * 24 * 3600 });
    return ack();
  }
  // IDEMPOTENT on the M-PESA code: Safaricom re-sends the same notification; the first copy is the payment, a repeat changes nothing.
  const db = tillDb(env);
  let inD1 = false, isRepeat = false;
  if (db) {
    try {
      await ensureTillSchema(db);
      const r = await insertTill(db, clientId, { code: cleanCode(transId), amount, paidAt: parseTransTime(data.TransTime, receivedAt), name: fullName, ref: record.accountRef, phoneHint: phoneHint(data.MSISDN), receivedAt });
      inD1 = true; isRepeat = !r.inserted;
    } catch (e) { inD1 = false; }
  }
  // KV copy: still what mpesa-verify reads for a typed code - now with a 45-day expiry so it cannot grow forever.
  const kvKey = tillPaymentKey(clientId, transId);
  if (!inD1) isRepeat = !!(await env.mydukapos_kv.get(kvKey));
  if (!isRepeat || inD1) { try { if (!(await env.mydukapos_kv.get(kvKey))) await env.mydukapos_kv.put(kvKey, JSON.stringify(record), { expirationTtl: 45 * 24 * 3600 }); } catch (e) { /* the D1 row is the record */ } }
  // zip 153: recorded in the D1 ledger too (idempotent on the transaction id) - money received, awaiting a sale to be attached to
  await recordGatewayTxn(env, clientId, { provider: 'till', txnId: transId, code: transId, amount, phone: phoneHint(data.MSISDN), status: 'RECEIVED', trusted: true });

  // No D1 (older deployments): keep the small KV index so the panel can still list recent payments.
  if (!inD1) {
    try {
      const idxRaw = await env.mydukapos_kv.get(tillPaymentIndexKey(clientId));
      const idx = idxRaw ? JSON.parse(idxRaw) : [];
      if (!isRepeat && !idx.includes(transId)) { idx.unshift(transId); await env.mydukapos_kv.put(tillPaymentIndexKey(clientId), JSON.stringify(idx.slice(0, 100))); }
    } catch (e) { /* the payment record above is already saved */ }
  }

  return ack();
}

export async function onRequest() {
  return ack();
}
