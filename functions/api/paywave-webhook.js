import { recordGatewayTxn } from './_ledger.js';
import { checkCallback, shopKnown, readCallbackJson } from './_callback-key.js';
// functions/api/paywave-webhook.js — Cloudflare Pages Function
//
// Receives Paywave Express's payment notifications, scoped to one client
// link. Paywave Express's STK push request has no callback_url param at
// all (unlike Daraja/KCB) — instead you configure ONE webhook URL in your
// own Paywave Express account dashboard, so each shop must paste the URL
// shown in Settings -> Payment Gateway on their own link — it already
// includes ?c=<their client id> — into their own Paywave Express dashboard.
// That's how this single shared route knows which shop's transaction record
// to update.
//
// Only needed if you're using Paywave Express as the payment gateway (see
// mpesa-stkpush.js). Requires a KV namespace bound as `mydukapos_kv`.
//
// Paywave Express's docs don't describe a signature scheme for their
// webhooks (unlike Paystack's HMAC-signed payload), so this trusts the
// payload's own ResponseCode the same way their own sample PHP handler
// does — there's nothing stronger to verify against.

function txKey(clientId, id) {
  return `mpesa-tx:${clientId}:${id}`;
}

function ack() {
  return new Response(JSON.stringify({ status: 'received' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientId = new URL(request.url).searchParams.get('c') || '';
  if (!clientId) {
    // No client id in the webhook URL — nothing we can attribute this to.
    return ack();
  }

  // zip 185: this webhook was believed with nothing but ?c=<shop id> (visible to anyone with the shop's link): a forged "payment received"
  // could be written for any shop, or for an id that is not a shop at all. Now: a real shop only, a bounded body, and either this shop's key
  // (new shops get one; their Settings shows the URL with &k=) or — for a shop with no key yet — an id that matches a prompt THIS shop sent.
  if (!(await shopKnown(env, clientId))) return ack();
  const data = await readCallbackJson(request);
  if (!data || typeof data !== 'object') return ack();
  const signed = await checkCallback(env, clientId, 'paywave', request.url);

  // Tries several plausible field names for the transaction identifier —
  // built from Paywave's public docs without a live account to verify the
  // exact webhook payload shape against, so this stays lenient on purpose
  // rather than silently dropping a real webhook over a field-name guess
  // that turns out wrong.
  const checkoutId = data && (data.CheckoutRequestID || data.checkout_request_id || data.CheckoutRequestId
    || data.transaction_reference || data.TransactionReference || data.reference);
  if (!checkoutId) {
    return ack();
  }

  if (String(checkoutId).length > 100) return ack();
  const kvKey = txKey(clientId, checkoutId);
  const existingRaw = await env.mydukapos_kv.get(kvKey);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};
  // zip 185: no valid key -> the id must be one this shop's own STK prompt created (mpesa-stkpush.js stores a pending record under it).
  if (!signed.ok ? !(existing.createdAt && existing.createdAt < signed.keyCreatedAt) : (signed.legacy && !existing.createdAt)) return ack();
  // A completed payment is final: a repeated or late notification never turns it back into "failed" (or re-stamps it).
  if (existing.status === 'success') return ack();

  const statusText = (data.status || data.Status || data.TransactionStatus || '').toString().toLowerCase();
  const succeeded = String(data.ResponseCode) === '0'
    || statusText.includes('success') || statusText.includes('complet')
    || data.success === true || String(data.success).toLowerCase() === 'true';

  await env.mydukapos_kv.put(kvKey, JSON.stringify({
    ...existing,
    provider: 'paywave',
    status: succeeded ? 'success' : 'failed',
    resultDesc: data.ResponseDescription || (succeeded ? 'Payment received.' : 'Payment was not completed.'),
    receiptNumber: succeeded ? (data.TransactionReceipt || data.TransactionID) : existing.receiptNumber,
    phone: data.Msisdn || existing.phone,
    amount: typeof data.TransactionAmount === 'number' ? data.TransactionAmount : existing.amount,
    transactionDate: data.TransactionDate,
    completedAt: succeeded ? Date.now() : existing.completedAt,
  }));
  await recordGatewayTxn(env, clientId, { provider: 'paywave', txnId: checkoutId, code: succeeded ? (data.TransactionReceipt || data.TransactionID) : null,
    amount: typeof data.TransactionAmount === 'number' ? data.TransactionAmount : existing.amount, phone: data.Msisdn || existing.phone, status: succeeded ? 'RECEIVED' : 'FAILED' });

  return ack();
}

export async function onRequest() {
  return ack();
}
