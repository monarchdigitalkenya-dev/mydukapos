// functions/api/kcb-ipn.js — Cloudflare Pages Function
//
// KCB Buni's equivalent of Daraja C2B: their Instant Payment Notification
// (IPN) service. KCB calls THIS endpoint automatically whenever a customer
// pays directly into a shop's KCB account, Vooma Till, or Lipa Na KCB till
// — no STK Push, no app involvement — the same "captured with zero action
// on the app's part" idea as mpesa-c2b-confirmation.js, just KCB's own rail
// instead of Safaricom's.
//
// Unlike Daraja's C2B (registered via a live API call — see
// mpesa-c2b-register.js), KCB has NO self-service registration for this in
// production: it's a manual step, same category as the KCB STK Push
// production-approval email already documented in mpesa-stkpush.js. Email
// buni@kcbgroup.com with this shop's KCB account/Till number and the
// Callback URL shown in Settings -> Payment Gateway (this endpoint) to get
// it registered. Sandbox has no registration step at all — KCB's own docs
// note it's tested by posting directly to their sandbox IPN endpoint.
//
// Stored in the exact same KV shape as till-payment records from Daraja C2B
// (see mpesa-c2b-confirmation.js) so till-payments.js and the Settings
// panel that lists them don't need to know which rail a payment came in on.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { checkCallback, shopKnown, readCallbackJson } from './_callback-key.js';
import { recordGatewayTxn } from './_ledger.js';

function tillPaymentKey(clientId, transId) {
  return `till-payment:${clientId}:${transId}`;
}

function tillPaymentIndexKey(clientId) {
  return `till-payment-index:${clientId}`;
}

// KCB's own documented acknowledgment shape — different from Daraja's
// {ResultCode, ResultDesc}, so this can't reuse the same ack() helper.
function ack(transactionId) {
  return new Response(JSON.stringify({
    transactionID: transactionId || '',
    statusCode: 0,
    statusMessage: 'Notification received',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientId = new URL(request.url).searchParams.get('c') || '';
  if (!clientId) {
    // No client id in the callback URL — nothing we can attribute this to,
    // but KCB still needs a valid acknowledgment or it may retry.
    return ack();
  }

  const data = await readCallbackJson(request);      // zip 185: size-bounded
  if (!data || typeof data !== 'object') return ack();

  const transId = data.transactionReference != null ? String(data.transactionReference) : '';
  if (!transId || transId.length > 60) return ack();
  if (!(await shopKnown(env, clientId))) return ack(transId);   // zip 185: not a real shop -> nothing is written

  const signed = await checkCallback(env, clientId, 'kcb', request.url);
  const record = {
    transId,
    transTime: data.timestamp || '',
    amount: parseFloat(data.transactionAmount) || 0,
    phone: data.customerMobileNumber || '',
    customerName: data.customerName || '',
    accountRef: data.customerReference || '',
    businessShortCode: data.organizationShortCode || data.tillNumber || '',
    orgBalance: data.balance || '',
    matched: false,
    receivedAt: Date.now(),
    // zip 143: false when the URL did not carry this shop's key (see _callback-key.js) — kept for the record, never proof of payment
    trusted: signed.ok,
    ...(signed.legacy ? { legacy: true } : {}),   // zip 185: accepted only because this shop has no KCB key yet (save KCB settings to create one)
    provider: 'kcb',
  };

  // IDEMPOTENT: providers re-send the same notification (a timeout on their side, a retry). The first copy is the payment; a
  // repeat must not overwrite it — that reset `matched` to false, so a payment already attached to a sale showed as unused again
  // and could be attached to a second sale — and must not add the id to the index twice.
  const already = await env.mydukapos_kv.get(tillPaymentKey(clientId, transId));
  const isRepeat = !!already;
  // An unsigned post for a shop that has a key is not stored where the till looks for payments: it cannot pre-empt the real one.
  if (!signed.ok) {
    await env.mydukapos_kv.put(`till-payment-rejected:${clientId}:${transId}`, JSON.stringify(record), { expirationTtl: 30 * 24 * 3600 });
    return ack();
  }
  if (!isRepeat) await env.mydukapos_kv.put(tillPaymentKey(clientId, transId), JSON.stringify(record));
  // zip 153: recorded in the D1 ledger too (idempotent on the transaction id) — money received, awaiting a sale to be attached to
  await recordGatewayTxn(env, clientId, { provider: 'kcb-till', txnId: transId, code: transId, amount: record.amount, phone: record.phone, status: 'RECEIVED', trusted: true });

  try {
    const idxRaw = await env.mydukapos_kv.get(tillPaymentIndexKey(clientId));
    const idx = idxRaw ? JSON.parse(idxRaw) : [];
    if (!isRepeat && !idx.includes(transId)) {
      idx.unshift(transId);
      await env.mydukapos_kv.put(tillPaymentIndexKey(clientId), JSON.stringify(idx.slice(0, 100)));
    }
  } catch (e) {
    // Index update failing shouldn't fail the notification itself.
  }

  return ack(transId);
}

export async function onRequest() {
  return ack();
}
