// functions/api/mpesa-callback.js — Cloudflare Pages Function
//
// This is the URL saved as this client's Daraja callback (shown in Settings
// -> Payment Gateway, and used automatically by mpesa-stkpush.js). Safaricom
// POSTs the result of the STK Push here once the customer enters their PIN
// (or cancels/times out). Only used when Daraja is the active payment
// gateway — if you're using Paystack instead, see paystack-webhook.js, which
// serves the same purpose.
//
// The URL includes ?c=<client id>, which is how this callback — a single
// shared route on the master deployment — knows which shop's transaction
// record to update. Safaricom simply POSTs back to the exact URL it was
// given, query string included, so this comes through untouched.
//
// IMPORTANT: this URL must be publicly reachable over HTTPS — Safaricom cannot
// reach localhost.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { checkCallback, shopKnown, readCallbackJson } from './_callback-key.js';
import { recordGatewayTxn } from './_ledger.js';

function txKey(clientId, id) {
  return `mpesa-tx:${clientId}:${id}`;
}

// Safaricom expects a 200 response with this exact shape, regardless of the
// ResultCode it sent us — otherwise it will retry the callback repeatedly.
function ack() {
  return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function extractMetadataValue(items, name) {
  const item = (items || []).find((i) => i.Name === name);
  return item ? item.Value : undefined;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientId = new URL(request.url).searchParams.get('c') || '';

  const body = await readCallbackJson(request);    // zip 185: size-bounded
  if (!body) return ack();

  const callback = body && body.Body && body.Body.stkCallback;
  if (!callback || !callback.CheckoutRequestID || !clientId) {
    return ack();
  }
  // zip 185: only a real, licensed shop's id is believed (a made-up ?c= used to create records for any id)
  if (String(callback.CheckoutRequestID).length > 100 || !(await shopKnown(env, clientId))) return ack();

  const kvKey = txKey(clientId, callback.CheckoutRequestID);
  const existingRaw = await env.mydukapos_kv.get(kvKey);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};
  // A completed payment is final: a repeated or late callback for the same CheckoutRequestID never turns it back into "failed".
  // (zip 263: a success the status query already confirmed has no receipt yet; the real callback may still add it, and only it)
  if (existing.status === 'success' && (existing.receiptNumber || callback.ResultCode !== 0)) return ack();
  // zip 143: only a callback carrying this shop's key is believed (see _callback-key.js). A prompt sent before the key existed (the
  // moment of an update) is still accepted for that prompt.
  const signed = await checkCallback(env, clientId, 'stk', request.url);
  if (!signed.ok && !(existing.createdAt && existing.createdAt < signed.keyCreatedAt)) return ack();
  // zip 185: a shop with no key yet (URLs handed out before zip 143) is "legacy": its callbacks carry no secret, but every REAL one answers a prompt
  // this shop created — mpesa-stkpush.js stored a pending record under that exact CheckoutRequestID. An id we never issued is not a result.
  if (signed.legacy && !existing.createdAt) return ack();

  if (callback.ResultCode === 0) {
    const items = callback.CallbackMetadata && callback.CallbackMetadata.Item;
    // zip 140: also indexed by the M-Pesa receipt number, so a code typed on a till can be checked against Safaricom's own record
    const receipt = String(extractMetadataValue(items, 'MpesaReceiptNumber') || '').toUpperCase();
    if (/^[A-Z0-9]{8,14}$/.test(receipt)) {
      await env.mydukapos_kv.put(`mpesa-receipt:${clientId}:${receipt}`, JSON.stringify({ source: 'stk', amount: Number(extractMetadataValue(items, 'Amount')) || Number(existing.amount) || 0, phone: extractMetadataValue(items, 'PhoneNumber') || existing.phone || '', at: Date.now(), checkoutRequestId: callback.CheckoutRequestID, ...(signed.legacy ? { legacy: true } : {}) }), { expirationTtl: 400 * 24 * 3600 });
    }
    await env.mydukapos_kv.put(kvKey, JSON.stringify({
      ...existing,
      status: 'success',
      resultDesc: callback.ResultDesc,
      receiptNumber: extractMetadataValue(items, 'MpesaReceiptNumber'),
      amount: extractMetadataValue(items, 'Amount') || existing.amount,
      phone: extractMetadataValue(items, 'PhoneNumber') || existing.phone,
      transactionDate: extractMetadataValue(items, 'TransactionDate'),
      completedAt: Date.now(),
    }));
    // zip 153: the same fact goes to the D1 ledger (idempotent on the CheckoutRequestID; a repeat changes nothing)
    await recordGatewayTxn(env, clientId, { provider: 'stk', txnId: callback.CheckoutRequestID, code: receipt, amount: Number(extractMetadataValue(items, 'Amount')) || Number(existing.amount) || 0,
      phone: extractMetadataValue(items, 'PhoneNumber') || existing.phone, status: 'RECEIVED' });
  } else {
    // Common causes: customer entered wrong PIN too many times, cancelled the
    // prompt, or it timed out on their phone (ResultCode 1032 = cancelled by user).
    await env.mydukapos_kv.put(kvKey, JSON.stringify({
      ...existing,
      status: 'failed',
      resultDesc: callback.ResultDesc || 'Payment was not completed.',
      completedAt: Date.now(),
    }));
    await recordGatewayTxn(env, clientId, { provider: 'stk', txnId: callback.CheckoutRequestID, amount: Number(existing.amount) || 0, phone: existing.phone, status: 'FAILED' });
  }

  return ack();
}

// Safaricom will occasionally retry with a stray GET/other verb — still ack politely.
// (onRequestPost above takes priority for actual POST callbacks.)
export async function onRequest() {
  return ack();
}
