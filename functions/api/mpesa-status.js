// functions/api/mpesa-status.js — Cloudflare Pages Function
//
// The POS polls this every few seconds after sending an STK Push, to find out
// whether the customer has completed (or cancelled) the payment yet. Scoped
// per client link (the `c` query param — see _license.js). Works the same
// regardless of which gateway sent the prompt (Paystack, Daraja, or KCB
// Buni) — the stored record's `provider` field decides which fallback check
// to use.
//
// Normally the result comes from a webhook having already written it to the
// shared store (mpesa-callback.js for Daraja AND KCB — their callback shapes
// are identical — paystack-webhook.js for Paystack). As a safety net for
// lost/delayed webhooks, this also falls back to actively asking the gateway
// directly if we've been waiting a while with no update yet — except for
// KCB, which has no documented status-query endpoint to fall back on, so it
// relies on the callback alone.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { loadGatewayConfig } from './_gateway-config.js';
import { pesapalStatus, applyPesapalStatus, indexPesapalReceipt } from './_pesapal.js';
import { requireValidLicense } from './_license.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';
import { deviceGuard } from './_device-auth.js';
import { corsHeadersFor } from './_cors.js';
import { staffGuard } from './_staff-auth.js';
import { recordGatewayTxn } from './_ledger.js';
import { noteStkPayment, stkPayerName } from './_till-store.js';

const LAST_QUERY = globalThis.__stkLastQuery || (globalThis.__stkLastQuery = new Map());   // zip 381: provider asked at most every 8 s per prompt
const FALLBACK_QUERY_AFTER_MS = 15000; // only bother querying the gateway directly after this long

// zip 247: no more `Access-Control-Allow-Origin: *` — only this deployment, the root domain and its subdomains (and localhost) are handed the answer
// (the apps call this on their own origin). A shop that requires staff sessions also needs a signed-in staff member, as mpesa-verify already does.
const CORS_OPTS = { methods: 'GET, OPTIONS', headers: 'Content-Type, X-Device-Id, X-Device-Token, X-Staff-Token' };

function jsonResponse(body, status = 200, cors = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, CORS_OPTS) });
}

function txKey(clientId, id) {
  return `mpesa-tx:${clientId}:${id}`;
}

/* ---------- Daraja fallback ---------- */

function darajaBaseUrl(cfg) {
  const envName = (cfg.mpesaEnv || 'sandbox').toLowerCase();
  return envName === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}

// zip 249 (same as mpesa-stkpush.js): Safaricom's clock is Nairobi time (UTC+3). The Cloudflare Worker's own clock is UTC, so the timestamp is built from UTC + 3 hours rather than
// from the server's local time (the Password is made from the same value, so the two always agree).
function darajaTimestamp(now = Date.now()) {
  const d = new Date(now + 3 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

// zip 381: the same 50-minute token reuse as mpesa-stkpush.js (shared cache), so status checks do not get the shop's prompts throttled
const DARAJA_TOKENS = globalThis.__darajaTokens || (globalThis.__darajaTokens = new Map());
const darajaTokenKey = (cfg) => `${(cfg.mpesaEnv || 'sandbox').toLowerCase()}|${cfg.mpesaConsumerKey}|${cfg.mpesaConsumerSecret}`;
async function darajaAccessToken(cfg) {
  const ck = darajaTokenKey(cfg), hit = DARAJA_TOKENS.get(ck);
  if (hit && hit.until > Date.now()) return hit.token;
  const auth = btoa(`${cfg.mpesaConsumerKey}:${cfg.mpesaConsumerSecret}`);
  const res = await fetch(`${darajaBaseUrl(cfg)}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error('OAuth failed');
  const data = await res.json();
  if (!data || !data.access_token) throw new Error('OAuth failed');
  const life = Math.max(60, Math.min(3000, (Number(data.expires_in) || 3599) - 600)) * 1000;
  DARAJA_TOKENS.set(ck, { token: data.access_token, until: Date.now() + life });
  return data.access_token;
}

// Directly asks Safaricom for the outcome — used only as a fallback when our
// own callback hasn't arrived yet. This endpoint confirms success/failure but does NOT return the
// M-Pesa receipt number; the callback supplies that when it arrives (zip 263: success no longer waits for it).
async function queryDarajaStatus(checkoutRequestId, cfg) {
  const shortcode = cfg.mpesaShortcode;
  const passkey = cfg.mpesaPasskey;
  if (!shortcode || !passkey) return null;

  const token = await darajaAccessToken(cfg);
  const timestamp = darajaTimestamp();
  const password = btoa(`${shortcode}${passkey}${timestamp}`);

  const res = await fetch(`${darajaBaseUrl(cfg)}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    }),
  });
  if (res.status === 401) DARAJA_TOKENS.delete(darajaTokenKey(cfg));      // zip 381: a token Safaricom no longer accepts is not reused
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export async function refreshFromDaraja(record, checkoutRequestId, cfg) {      // exported (zip 263): get-my-link.js uses the same safety-net check
  const queryResult = await queryDarajaStatus(checkoutRequestId, cfg);
  // zip 250: only a real answer counts. A reply that is an error object ("being processed", throttled, no ResultCode at all) used to read as
  // String(undefined) !== '0' and mark a prompt the customer was still typing the PIN for as FAILED.
  if (queryResult && queryResult.ResultCode !== undefined && queryResult.ResultCode !== null && queryResult.ResultCode !== '' && String(queryResult.ResultCode) !== '0') {
    return {
      ...record,
      status: 'failed',
      resultDesc: queryResult.ResultDesc || 'Payment was not completed.',
    };
  }
  // zip 263: ResultCode 0 from Safaricom's own query IS a completed payment. It used to wait for the callback (for the receipt number), so a callback that
  // never arrived left the till on "still processing" for ever after the customer had paid. It is now marked paid without a receipt; the callback, when it
  // does arrive, fills the receipt in (mpesa-callback.js). A sale does not need the code to complete.
  if (queryResult && queryResult.ResultCode !== undefined && String(queryResult.ResultCode) === '0') {
    return { ...record, status: 'success', resultDesc: queryResult.ResultDesc || 'Payment received.', receiptNumber: record.receiptNumber || '', receiptPending: !record.receiptNumber, completedAt: Date.now() };
  }
  return null;
}

/* ---------- Paywave Express fallback ---------- */
// Their /v1/tstatus endpoint returns everything needed (status, receipt,
// amount) in one call — used the same safety-net way as the Daraja/Paystack
// fallbacks above, in case their webhook is ever lost or delayed.
export async function refreshFromPaywaveExpress(record, checkoutRequestId, cfg) {
  if (!cfg.paywaveApiKey || !cfg.paywaveEmail) return null;
  // Sends whichever identifier is actually available — the initial push's
  // response may or may not have included transaction_request_id under
  // that exact name (unverified against a live Paywave account), so the
  // CheckoutRequestID this record is already keyed by is included too, on
  // the chance their status endpoint accepts either.
  if (!record.transactionRequestId && !checkoutRequestId) return null;

  const res = await fetch('https://paywavexpress.co.ke/v1/tstatus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: cfg.paywaveApiKey,
      email: cfg.paywaveEmail,
      transaction_request_id: record.transactionRequestId || checkoutRequestId,
      checkout_request_id: checkoutRequestId,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();

  const status = (data.TransactionStatus || data.status || data.ResultDesc || '').toString().toLowerCase();
  const succeeded = status.includes('complet') || status.includes('success') || String(data.ResponseCode) === '0';
  const failed = status.includes('fail') || status.includes('cancel');

  if (succeeded) {
    // zip 273: the amount must be the prompt's amount; otherwise it is not credited and is flagged (see paywave-webhook.js)
    const reported = data.TransactionAmount === undefined || data.TransactionAmount === null || data.TransactionAmount === '' ? NaN : Number(String(data.TransactionAmount).replace(/[^0-9.\-]/g, ''));   // zip 378: "22,000.00" is 22000, not NaN
    const expected = Number(record.amount);
    if (Number.isFinite(reported) && Number.isFinite(expected) && expected > 0 && Math.abs(reported - expected) > 0.5) {
      return { ...record, status: 'pending', phase: 'needs_review', needsReview: 'amount_mismatch', reportedAmount: reported, reviewAt: Date.now() };
    }
    return {
      ...record,
      phase: 'confirmed',
      ...(data.TransactionReceipt ? {} : { needsReview: 'no_receipt' }),
      status: 'success',
      resultDesc: data.ResultDesc || 'Payment received.',
      receiptNumber: data.TransactionReceipt,
      amount: Number.isFinite(reported) && reported > 0 ? reported : record.amount,
      transactionDate: data.TransactionDate,
      completedAt: Date.now(),
    };
  }
  if (failed) {
    return {
      ...record,
      status: 'failed',
      resultDesc: data.ResultDesc || 'Payment was not completed.',
    };
  }
  // Pending — leave as-is, keep waiting.
  return null;
}

/* ---------- Paystack fallback ---------- */

// Unlike Daraja's query endpoint, Paystack's Verify Transaction endpoint returns
// everything we need (status, receipt_number, amount) — so on a successful
// verify we can resolve the sale directly, without waiting for the webhook.
async function refreshFromPaystack(record, reference, cfg) {
  const secret = cfg.paystackSecretKey;
  if (!secret) return null;

  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!res.ok) return null;
  const body = await res.json();
  const data = body && body.data;
  if (!data) return null;

  if (data.status === 'success') {
    return {
      ...record,
      status: 'success',
      resultDesc: data.gateway_response || 'Payment received.',
      receiptNumber: data.receipt_number || data.reference,
      amount: typeof data.amount === 'number' ? Math.round(data.amount / 100) : record.amount,
      transactionDate: data.paid_at,
      completedAt: Date.now(),
    };
  }
  if (['failed', 'abandoned', 'reversed'].includes(data.status)) {
    return {
      ...record,
      status: 'failed',
      resultDesc: data.gateway_response || data.message || 'Payment was not completed.',
    };
  }
  // ongoing / pending / processing / queued — leave as-is, keep waiting
  return null;
}


export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env, CORS_OPTS);
  const reply = (b, st = 200) => jsonResponse(b, st, cors);
  const url = new URL(request.url);
  const checkoutRequestId = url.searchParams.get('checkoutRequestId');
  if (!checkoutRequestId) {
    return reply({ error: 'Missing checkoutRequestId' }, 400);
  }

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return reply({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const clientId = license.clientId;
  const rls = await checkRateLimit(env, 'stkStatus', clientId);        // zip 273: generous (one prompt polls ~40 times); stops a script hammering the provider query
  if (!rls.ok) return rateLimitResponse('payment status checks', rls, cors);
  // zip 262: simulated demo payment (see mpesa-stkpush.js): pending for 4 seconds, then a clearly fake receipt. Nothing is read or written.
  if (license.record && license.record.sharedDemo && /^DEMO-\d+-\d+$/.test(checkoutRequestId)) {
    const [, ts, amt] = checkoutRequestId.split('-');
    const done = Date.now() - Number(ts) > 4000;
    return reply(done ? { status: 'success', receiptNumber: 'DEMO' + Number(ts).toString(36).toUpperCase().slice(-6), phone: '2547XXXXXXXX', amount: Number(amt), resultDesc: 'Simulated payment (demo - no money moved)' } : { status: 'pending', amount: Number(amt) });
  }
  // PAIRED DEVICES ONLY when the shop has switched that on (see _device-auth.js); otherwise no change
  const deviceDenied = await deviceGuard(request, env, clientId, cors);
  if (deviceDenied) return deviceDenied;

  const sg = await staffGuard(request, env, clientId, null, cors);      // zip 247: only when the shop requires staff sessions
  if (sg.denied) return sg.denied;

  const kvKey = txKey(clientId, checkoutRequestId);
  const raw = await env.mydukapos_kv.get(kvKey);
  let record = raw ? JSON.parse(raw) : null;

  if (!record) {
    return reply({ status: 'unknown' });
  }

  // Pesapal has no callback straight to the till, so its result is asked for at once (its IPN, when it arrives first, has already filled the record)
  // zip 381: the till checks every few seconds; the PROVIDER is asked at most once every 8 seconds per prompt (it was asked on every check, and
  // Safaricom throttles a shop that asks too often - which then also refused that shop's new prompts)
  if (record.status === 'pending' && (Date.now() - (record.createdAt || 0) > FALLBACK_QUERY_AFTER_MS || (record.provider === 'pesapal' && Date.now() - (record.createdAt || 0) > 3000))
      && Date.now() - (LAST_QUERY.get(kvKey) || 0) > 8000) {
    LAST_QUERY.set(kvKey, Date.now()); if (LAST_QUERY.size > 5000) LAST_QUERY.clear();   // kept in memory: never re-written over a result the callback just saved
    try {
      const cfg = await loadGatewayConfig(env, clientId);
      const provider = record.provider || 'daraja'; // records saved before this update default to daraja
      // KCB Buni has no documented "query STK status" endpoint to fall back
      // on the way Daraja and Paystack do, so a KCB transaction just keeps
      // reporting "pending" here until its callback arrives — the callback
      // (mpesa-callback.js) is still the primary, reliable path either way;
      // this fallback only exists as a safety net for the other two.
      const updated = provider === 'paystack'
        ? await refreshFromPaystack(record, checkoutRequestId, cfg)
        : provider === 'pesapal'
          ? applyPesapalStatus(record, await pesapalStatus(cfg, checkoutRequestId))
        : provider === 'kcb' || provider === 'coop'
          ? null
          : provider === 'paywave'
            ? await refreshFromPaywaveExpress(record, checkoutRequestId, cfg)
            : await refreshFromDaraja(record, checkoutRequestId, cfg);
      // zip 381: the callback may have saved the real result (with the M-PESA code) while the provider was being asked - never write over it
      let fresh = null; try { fresh = JSON.parse((await env.mydukapos_kv.get(kvKey)) || 'null'); } catch (e) { fresh = null; }
      if (updated && fresh && fresh.status && fresh.status !== 'pending') { record = fresh; }
      else if (updated) {
        record = updated;
        await env.mydukapos_kv.put(kvKey, JSON.stringify(record));
        if (record.status === 'success') await noteStkPayment(env, clientId, { checkoutId: checkoutRequestId, receipt: record.receiptNumber, amount: record.amount, phone: record.phone, transactionDate: record.transactionDate, provider: record.provider || 'daraja' });   // zip 264
        if (record.status === 'success' && record.provider === 'pesapal') await indexPesapalReceipt(env, clientId, record, checkoutRequestId);
        if (record.status === 'success') await recordGatewayTxn(env, clientId, { provider: record.provider || 'daraja', txnId: checkoutRequestId, code: record.receiptNumber, amount: record.amount, phone: record.phone, status: 'RECEIVED' });
      }
    } catch (e) {
      // Fallback query failed (e.g. credentials not set) — just keep reporting "pending"
    }
  }

  // zip 265: the payer's NAME (and, when the STK result never arrived, the receipt) come from Safaricom's Till confirmation for the same payment
  let payerName = record.payerName || '', receiptNumber = record.receiptNumber;
  if (record.status === 'success' && (!payerName || !receiptNumber)) {
    const f = await stkPayerName(env, clientId, { code: receiptNumber, checkoutId: checkoutRequestId });
    payerName = payerName || f.name; receiptNumber = receiptNumber || f.code;
  }
  // zip 378: a payment confirmed by the status check (the callback never came) or whose code came from the Till confirmation was NOT indexed
  // by its M-PESA code, so the sale that carried that code was flagged "no M-Pesa record" / "paid less" although the customer had paid.
  // It is indexed here too (same record the callback writes), with the amount of the prompt.
  if (record.status === 'success' && receiptNumber && /^[A-Z0-9]{8,14}$/.test(String(receiptNumber).toUpperCase())) {
    const rk = `mpesa-receipt:${clientId}:${String(receiptNumber).toUpperCase()}`;
    try {
      if (!(await env.mydukapos_kv.get(rk))) await env.mydukapos_kv.put(rk, JSON.stringify({ source: 'stk', amount: Number(record.amount) || 0, phone: record.phone || '', at: Date.now(), checkoutRequestId }), { expirationTtl: 400 * 24 * 3600 });
    } catch (e) { /* the callback, when it arrives, writes it */ }
  }
  return reply({
    status: record.status,
    receiptNumber,
    payerName,
    phone: record.phone,
    amount: record.amount,
    resultDesc: record.resultDesc,
  });
}
