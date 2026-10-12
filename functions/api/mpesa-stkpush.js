// functions/api/mpesa-stkpush.js — Cloudflare Pages Function
//
// Sends the M-Pesa STK push prompt to the customer's phone, scoped to one
// client link (the `c` query param — see _license.js). The POS calls this
// when the cashier clicks "Send M-Pesa Prompt", and does a GET to check which
// gateway is configured (used by the Settings panel's status readout).
//
// Three interchangeable gateways are supported — configure ONE of them from
// inside the app, in Settings -> Payment Gateway (this saves into mydukapos_kv via
// /api/gateway-config, scoped to this client's link). Nothing in the code or
// the rest of the front-end needs to change either way.
//
// (Paystack was retired in zip 262: no new prompt is ever sent through it; its old webhook/status lookups remain only for payments already in flight.)
// OPTION A (retired) — Paystack
//   Paystack secret key (sk_live_... or sk_test_...)
//   Also add a webhook in your Paystack Dashboard -> Settings -> API Keys & Webhooks,
//   using the URL shown in Settings -> Payment Gateway (already includes ?c=...).
//
// OPTION B — Safaricom Daraja directly
//   Environment (sandbox/production), Consumer Key, Consumer Secret,
//   Shortcode (Paybill/Till), Passkey, and optionally the transaction type —
//   all entered in Settings -> Payment Gateway. The callback URL is generated
//   automatically and includes this client's ?c=... token, so Safaricom's
//   callback lands back on the right shop's data.
//
// OPTION C — KCB Buni (bank-direct M-Pesa STK Push, via KCB rather than
//   Safaricom's own Daraja)
//   Environment (sandbox/production), Consumer Key, Consumer Secret, and the
//   Till/Short Code KCB provisions for this specific merchant during their
//   own onboarding — confirmed directly from a real merchant's KCB portal
//   that there's no shared/default code that works for everyone; every
//   shop's Till is specific to them. KCB's callback payload is shaped
//   identically to Safaricom's, so it's handled by the exact same
//   mpesa-callback.js — no separate callback URL needed. Also note: KCB
//   requires a manual production-approval step (emailing buni@kcbgroup.com
//   with the Consumer Key, Till, and callback URL) before a Consumer Key can
//   actually move real money — this app has no way to automate that step.
//
// OPTION D — Paywave Express (a hosted aggregator that wraps Daraja for you —
//   just an API key + the email on your Paywave Express account, no Daraja
//   app/certs of your own needed)
//   Docs: https://paywavexpress.co.ke/documentation. Their STK push endpoint
//   takes no callback_url — Paywave sends webhooks to whatever URL you paste
//   into YOUR Paywave Express dashboard, so the URL shown in Settings ->
//   Payment Gateway (already includes ?c=...) needs to be pasted in there
//   once, same as the Paystack setup step above.
//
// OPTION E — Pesapal (hosted checkout: M-Pesa, Airtel Money, card, bank) — Consumer Key + Secret. Not a phone prompt: the till shows a payment link.
// OPTION F — Co-operative Bank (M-Pesa STK through Co-op's gateway) — Consumer Key + Secret + the token / STK addresses and shortcode from the
//   shop's own Co-op API portal. Result comes back to /api/mpesa-callback like Daraja's.
//
// If you set up more than one, the first configured one is used (Daraja, KCB, Paywave, Co-op, Pesapal). Force a specific
// one with the "Force a specific provider" dropdown in Settings.
//
// Blocked with 403 if this link's license isn't currently valid (expired
// demo, admin-locked, or unknown link).
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { ensureCallbackKey, withKey, callbackOrigin } from './_callback-key.js';
import { loadGatewayConfig, resolveProvider } from './_gateway-config.js';
import { pesapalToken, pesapalIpnId, pesapalSubmitOrder } from './_pesapal.js';
import { requireValidLicense, resolveClientId } from './_license.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';
import { deviceGuard } from './_device-auth.js';
import { corsHeadersFor } from './_cors.js';
import { staffGuard } from './_staff-auth.js';

// zip 247: no more `Access-Control-Allow-Origin: *`. The apps call this endpoint on their own origin; a browser on any OTHER site is not handed the answer
// (corsHeadersFor names only this deployment, the root domain and its subdomains, and localhost). Each handler builds `cors` for its own request.
const CORS_OPTS = { methods: 'GET, POST, OPTIONS', headers: 'Content-Type, X-Device-Id, X-Device-Token, X-Staff-Token' };

function jsonResponse(body, status = 200, cors = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function txKey(clientId, id) {
  return `mpesa-tx:${clientId}:${id}`;
}

// Accepts 07XXXXXXXX, 7XXXXXXXX, 01XXXXXXXX or 2547XXXXXXXX and normalizes to 2547XXXXXXXX / 2541XXXXXXXX
function normalizePhone(raw) {
  let p = (raw || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return p;
}

/* ---------- Daraja (Safaricom) ---------- */

function darajaBaseUrl(cfg) {
  const envName = (cfg.mpesaEnv || 'sandbox').toLowerCase();
  return envName === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}

// zip 249: Safaricom's clock is Nairobi time (UTC+3). The Cloudflare Worker's own clock is UTC, so the timestamp is built from UTC + 3 hours rather than
// from the server's local time (the Password is made from the same value, so the two always agree).
function darajaTimestamp(now = Date.now()) {
  const d = new Date(now + 3 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

async function darajaAccessToken(cfg) {
  const auth = btoa(`${cfg.mpesaConsumerKey}:${cfg.mpesaConsumerSecret}`);

  const res = await fetch(`${darajaBaseUrl(cfg)}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || !data.access_token) {
    // zip 250: say WHY (a production Consumer Key used against sandbox, or the other way round, is the usual cause) instead of one fixed sentence
    const env = (cfg.mpesaEnv || 'sandbox').toLowerCase();
    const detail = data.errorMessage || data.error_description || data.error || '';
    throw new Error(`Could not authenticate with M-Pesa (HTTP ${res.status}${detail ? ': ' + detail : ''}). The Environment is set to ${env.toUpperCase()}: use the Consumer Key / Secret of a ${env} app, and check them in Settings.`);
  }
  return data.access_token;
}

async function sendViaDaraja({ phone, amount, accountRef, description }, cfg, callbackUrl) {
  const token = await darajaAccessToken(cfg);
  const shortcode = cfg.mpesaShortcode;
  const passkey = cfg.mpesaPasskey;
  const timestamp = darajaTimestamp();
  const password = btoa(`${shortcode}${passkey}${timestamp}`);
  // zip 249: a TILL (Buy Goods) has two numbers. BusinessShortCode is the Head Office / Store number (it also goes into the Password); PartyB is the
  // TILL number that receives the money. For a Paybill both are the same number, so PartyB is only used when the type is Till AND a Till number is saved
  // (a shop whose Store number and Till number are the same simply leaves it blank, exactly as before).
  const partyB = (cfg.mpesaTransactionType === 'CustomerBuyGoodsOnline' && cfg.mpesaPartyB) ? String(cfg.mpesaPartyB).trim() : shortcode;

  const stkRes = await fetch(`${darajaBaseUrl(cfg)}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: cfg.mpesaTransactionType || 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: partyB,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: accountRef,
      TransactionDesc: description,
    }),
  });

  let stkData = {};
  try { stkData = await stkRes.json(); } catch (e) { /* not JSON (e.g. an HTML error page): handled below */ }
  if (!stkRes.ok || stkData.ResponseCode !== '0') {
    // zip 249: Safaricom's own words, with its error code, so the cause (wrong shortcode / passkey / Till, app not live yet) is readable on the till
    const why = stkData.errorMessage || stkData.ResponseDescription || `M-Pesa declined the STK Push request (HTTP ${stkRes.status}).`;
    throw new Error(stkData.errorCode ? `${why} [${stkData.errorCode}]` : why);
  }

  return {
    id: stkData.CheckoutRequestID,
    merchantRequestId: stkData.MerchantRequestID,
    customerMessage: stkData.CustomerMessage || 'Prompt sent to customer phone.',
  };
}

/* ---------- KCB Buni ---------- */
// Docs: https://sandbox.buni.kcbgroup.com/devportal/apis (STK Push product).
// Sandbox/UAT base confirmed as uat.buni.kcbgroup.com by KCB's own walkthrough;
// production is the bare buni.kcbgroup.com host, dropping the "uat." prefix —
// the same pattern KCB uses for sandbox.buni.kcbgroup.com elsewhere in their
// docs. Worth double-checking with KCB directly before a first production
// run, since this specific detail wasn't in an official reference doc.

function kcbBaseUrl(cfg) {
  const envName = (cfg.kcbEnv || 'sandbox').toLowerCase();
  return envName === 'production' ? 'https://buni.kcbgroup.com' : 'https://uat.buni.kcbgroup.com';
}

// Confirmed directly from a shop's own KCB developer portal: production
// token requests go to a SEPARATE identity domain, not the same host as
// the STK push API itself (kcbBaseUrl above). Sandbox, by contrast, really
// does use the same uat.buni.kcbgroup.com host for both — confirmed by
// KCB's own widely-cited integration walkthrough. These aren't the same
// pattern with an environment swapped in; they're genuinely different URL
// shapes, so this can't be derived from kcbBaseUrl() the way the STK push
// call is.
function kcbTokenUrl(cfg) {
  const envName = (cfg.kcbEnv || 'sandbox').toLowerCase();
  return envName === 'production'
    ? 'https://accounts.buni.kcbgroup.com/oauth2/token?grant_type=client_credentials'
    : 'https://uat.buni.kcbgroup.com/token?grant_type=client_credentials';
}

async function kcbAccessToken(cfg) {
  const auth = btoa(`${cfg.kcbConsumerKey}:${cfg.kcbConsumerSecret}`);
  const res = await fetch(kcbTokenUrl(cfg), {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    throw new Error('Could not authenticate with KCB Buni. Check the Consumer Key / Consumer Secret saved in Settings.');
  }
  const data = await res.json();
  return data.access_token;
}

async function sendViaKcb({ phone, amount, accountRef, description }, cfg, callbackUrl) {
  // Confirmed directly from a real merchant's own KCB onboarding: their
  // Till/shortcode is provisioned specifically for them as part of getting
  // production access approved — it's never optional, and there's no
  // generic fallback code that works for everyone. Silently defaulting to
  // a guessed shortcode here would mean money going to the wrong place, so
  // this fails loudly instead if it's missing.
  if (!cfg.kcbOrgShortCode) {
    throw new Error('No KCB Till/Short Code saved. Enter the Till Number KCB provisioned for this shop in Settings \u2014 there is no shared/default code that works for every merchant.');
  }

  const token = await kcbAccessToken(cfg);

  const payload = {
    phoneNumber: phone,
    amount: String(amount),
    invoiceNumber: accountRef,
    // Defaults to false — a shop's own provisioned Till is normally NOT a
    // shared code (see above). This only needs to be true in the rarer
    // case KCB has actually told a merchant they're on a shared shortcode.
    sharedShortCode: cfg.kcbSharedShortCode === true,
    orgShortCode: cfg.kcbOrgShortCode,
    orgPassKey: cfg.kcbOrgPassKey || '',
    callbackUrl,
    transactionDescription: description,
  };

  const stkRes = await fetch(`${kcbBaseUrl(cfg)}/mm/api/request/1.0.0/stkpush`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const stkData = await stkRes.json();
  const resp = stkData && stkData.response;
  if (!stkRes.ok || !resp || String(resp.ResponseCode) !== '0') {
    throw new Error((resp && resp.ResponseDescription) || 'KCB declined the STK Push request.');
  }

  return {
    id: resp.CheckoutRequestID,
    merchantRequestId: resp.MerchantRequestID,
    customerMessage: resp.CustomerMessage || 'Prompt sent to customer phone.',
  };
}

/* ---------- Paywave Express ---------- */
// Docs: https://paywavexpress.co.ke/documentation — a hosted aggregator that
// wraps Daraja for you. No callback_url param on their STK push request at
// all (unlike Daraja/KCB) — Paywave posts to whatever webhook URL is saved
// in YOUR Paywave Express account dashboard instead, which is why the
// webhook route (paywave-webhook.js) exists as its own separate file rather
// than reusing mpesa-callback.js.
async function sendViaPaywaveExpress({ phone, amount, accountRef }, cfg) {
  if (!cfg.paywaveApiKey || !cfg.paywaveEmail) {
    throw new Error('Paywave Express is missing its API key or account email — enter both in Settings.');
  }

  const res = await fetch('https://paywavexpress.co.ke/v1/stkpush', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: cfg.paywaveApiKey,
      email: cfg.paywaveEmail,
      amount: String(amount),
      msisdn: phone,
      reference: accountRef,
    }),
  });

  let data;
  const rawText = await res.text();
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    // Not JSON at all — surface the raw text directly, since that's the
    // most likely place to see something like an HTML error page from an
    // upstream gateway/proxy rather than Paywave's own API.
    throw new Error(`Paywave Express returned an unexpected (non-JSON) response: ${rawText.slice(0, 300) || `HTTP ${res.status}`}`);
  }

  // Accepts several plausible shapes for "this succeeded" rather than one
  // specific field name — built from Paywave's public docs without a live
  // account to verify the exact response against, so this stays lenient on
  // purpose: any one clear success signal is enough, and the *first*
  // real-world failure's raw response (surfaced below) is what should
  // narrow this down precisely, rather than guessing a second time blind.
  const succeeded = res.ok && (
    String(data.ResponseCode) === '0' ||
    data.success === true ||
    data.success === '200' ||
    String(data.success).toLowerCase() === 'true' ||
    String(data.status).toLowerCase() === 'success' ||
    !!data.CheckoutRequestID
  );

  if (!succeeded) {
    // Includes the raw JSON so whatever Paywave actually sent back is
    // visible in the error shown to the person trying to pay — the fastest
    // way to pin down the exact field names their API really uses if this
    // still doesn't match.
    const detail = data.errorMessage || data.message || data.error || JSON.stringify(data).slice(0, 300);
    throw new Error(`Paywave Express declined the STK Push request (HTTP ${res.status}): ${detail}`);
  }

  return {
    // CheckoutRequestID matches the shape mpesa-status.js already polls by
    // for every other provider — transactionRequestId is kept alongside it
    // for refreshFromPaywaveExpress()'s own /v1/tstatus fallback query.
    id: data.CheckoutRequestID,
    transactionRequestId: data.transaction_request_id,
    merchantRequestId: data.MerchantRequestID,
    customerMessage: data.message || 'Prompt sent to customer phone.',
  };
}

/* ---------- Pesapal (zip 210) ---------- */
// Hosted checkout: an order is created and Pesapal returns a payment page link. The customer opens it (M-Pesa, Airtel Money, card, bank);
// the result arrives at pesapal-ipn.js and/or by mpesa-status.js asking Pesapal. The till shows the link (paymentUrl).
async function sendViaPesapal({ phone, amount, accountRef, description }, cfg, ctx) {
  const token = await pesapalToken(cfg);
  const ipnId = await pesapalIpnId(ctx.env, cfg, ctx.clientId, token, ctx.ipnUrl);
  const merchantReference = ('P' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).replace(/[^A-Za-z0-9]/g, '').slice(0, 50);
  const order = await pesapalSubmitOrder(cfg, token, {
    id: merchantReference,
    currency: 'KES',
    amount,
    description: String(description || 'POS Sale').slice(0, 100),
    callback_url: ctx.returnUrl,
    notification_id: ipnId,
    billing_address: { phone_number: phone, country_code: 'KE', first_name: 'Customer', last_name: String(accountRef || 'POS').slice(0, 30) },
  });
  return {
    id: order.order_tracking_id,
    merchantRequestId: merchantReference,
    merchantReference,
    paymentUrl: order.redirect_url,
    customerMessage: 'Payment page ready — the customer opens the link and pays.',
  };
}

/* ---------- Co-operative Bank (zip 210) ---------- */
// M-Pesa STK through Co-op Bank's own API gateway ("SafaricomSTKPush" on the Co-op developer portal). Co-op publishes the exact addresses and
// field names only inside the portal (login needed), so this does NOT guess them: the shop owner pastes the token address and the STK address
// from their own portal's API console (Settings -> Payment Gateway) and nothing is sent until both are saved. The request is Daraja-shaped
// (Co-op wraps Safaricom's STK) and the result comes back to the same /api/mpesa-callback as Daraja's.
async function coopAccessToken(cfg) {
  const auth = btoa(`${cfg.coopConsumerKey}:${cfg.coopConsumerSecret}`);
  const sep = cfg.coopTokenUrl.includes('?') ? '&' : '?';
  const url = /grant_type=/.test(cfg.coopTokenUrl) ? cfg.coopTokenUrl : `${cfg.coopTokenUrl}${sep}grant_type=client_credentials`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Co-op Bank rejected the Consumer Key / Secret${data && (data.error_description || data.error) ? ' (' + (data.error_description || data.error) + ')' : ''}.`);
  return data.access_token;
}

async function sendViaCoop({ phone, amount, accountRef, description }, cfg, callbackUrl) {
  const token = await coopAccessToken(cfg);
  const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const payload = {
    BusinessShortCode: cfg.coopShortcode,
    Password: cfg.coopPasskey ? btoa(`${cfg.coopShortcode}${cfg.coopPasskey}${timestamp}`) : undefined,
    Timestamp: timestamp,
    TransactionType: cfg.coopTransactionType || 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: phone,
    PartyB: cfg.coopShortcode,
    PhoneNumber: phone,
    CallBackURL: callbackUrl,
    AccountReference: accountRef,
    TransactionDesc: description,
  };
  const res = await fetch(cfg.coopStkUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const raw = await res.text();
  let data; try { data = JSON.parse(raw); } catch (e) { throw new Error(`Co-op Bank returned an unexpected response (HTTP ${res.status}): ${raw.slice(0, 200)}`); }
  const body = data && (data.response || data.Response || data);
  const checkoutId = body && (body.CheckoutRequestID || body.checkoutRequestID || body.CheckoutRequestId);
  if (!res.ok || !checkoutId || (body.ResponseCode !== undefined && String(body.ResponseCode) !== '0')) {
    throw new Error((body && (body.ResponseDescription || body.errorMessage || body.message || body.error)) || `Co-op Bank declined the STK request (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }
  return { id: checkoutId, merchantRequestId: body.MerchantRequestID, customerMessage: body.CustomerMessage || 'Prompt sent to customer phone.' };
}

// zip 263: the send itself, shared by the till's prompt (below) and by "Get my own link" (get-my-link.js, which charges the OWNER's own gateway).
// Sends through the provider already resolved from `cfg`, saves the pending record the callback / status endpoints update, returns the gateway's answer.
export async function sendStk(env, request, clientId, cfg, provider, { phone, amount, accountRef, description }) {
  const origin = callbackOrigin(request, env);
  // The client id is embedded in the callback URL itself, so Safaricom's
  // POST to mpesa-callback.js carries it right back to us.
  // zip 143: the callback URL carries this shop's secret key, so only Safaricom/KCB (who were given it) can report a result
  // zip 250: the route is called pay-cb-stk, NOT mpesa-callback: Safaricom's production system silently drops any callback URL that contains "mpesa" / "safaricom"
  const callbackUrl = withKey(`${origin}/api/pay-cb-stk?c=${encodeURIComponent(clientId)}`, await ensureCallbackKey(env, clientId, 'stk'));

  const result = provider === 'kcb'
      ? await sendViaKcb({ phone, amount, accountRef, description }, cfg, callbackUrl)
      : provider === 'paywave'
        ? await sendViaPaywaveExpress({ phone, amount, accountRef, description }, cfg)
        : provider === 'coop'
          ? await sendViaCoop({ phone, amount, accountRef, description }, cfg, callbackUrl)
          : provider === 'pesapal'
            ? await sendViaPesapal({ phone, amount, accountRef, description }, cfg, { env, clientId, ipnUrl: withKey(`${origin}/api/pesapal-ipn?c=${encodeURIComponent(clientId)}`, await ensureCallbackKey(env, clientId, 'pesapal')), returnUrl: `${origin}/pesapal-done.html` })
        : await sendViaDaraja({ phone, amount, accountRef, description }, cfg, callbackUrl);

  // Save a "pending" placeholder — keyed by the same id in both gateways —
  // so the status endpoint (and, for Paystack, the webhook) has an immediate
  // record to find and update.
  // zip 263: some Paywave answers carry only transaction_request_id; the record is then kept under that, never under "undefined"
  result.id = result.id || result.transactionRequestId;
  await env.mydukapos_kv.put(txKey(clientId, result.id), JSON.stringify({
    provider,
    status: 'pending',
    phone,
    amount,
    accountRef,
    transactionRequestId: result.transactionRequestId,
    merchantReference: result.merchantReference,
    createdAt: Date.now(),
  }));

  return result;
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, CORS_OPTS) });
}

// Lightweight status check used by the Settings panel — no charge is made.
export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env, CORS_OPTS);
  const reply = (b, st = 200) => jsonResponse(b, st, cors);
  // zip 185: this used to answer for ANY id (it disclosed which provider a shop uses without a licence check). Same guards as the POST below.
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This link is not active.', reason: license.reason }, 403);
  const clientId = license.clientId;
  const deviceDenied = await deviceGuard(request, env, clientId, cors);
  if (deviceDenied) return deviceDenied;
  const cfg = await loadGatewayConfig(env, clientId);
  if (cfg.secretsUnreadable) return reply({ error: 'The saved payment keys cannot be read right now — contact support.', code: 'secrets_unreadable' }, 503);
  return reply({ provider: resolveProvider(cfg) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env, CORS_OPTS);
  const reply = (b, st = 200) => jsonResponse(b, st, cors);

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return reply({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const clientId = license.clientId;
  // zip 262: a shared public demo never talks to a payment provider. The prompt is SIMULATED: nothing is sent, nothing is stored (the id carries
  // the time and amount, mpesa-status answers "success" a few seconds later for a DEMO- id), and the response says so.
  if (license.record && license.record.sharedDemo) {
    let b = {}; try { b = await request.json(); } catch (e) { /* none */ }
    const amt = Math.max(1, Math.round(Number(b && b.amount) || 0));
    return reply({ checkoutRequestId: 'DEMO-' + Date.now() + '-' + amt, merchantRequestId: 'DEMO', customerMessage: 'Demo mode: no real M-Pesa prompt was sent. The payment will show as received in a few seconds.', simulated: true });
  }
  // PAIRED DEVICES ONLY when the shop has switched that on (see _device-auth.js); otherwise no change
  const deviceDenied = await deviceGuard(request, env, clientId, cors);
  if (deviceDenied) return deviceDenied;

  // zip 247: a shop that requires staff sessions only lets a signed-in staff member WITH the payments permission send payment prompts (no change for other shops)
  const sg = await staffGuard(request, env, clientId, 'payments', cors);
  if (sg.denied) return sg.denied;

  const cfg = await loadGatewayConfig(env, clientId);
  if (cfg.secretsUnreadable) return reply({ error: 'The saved payment keys cannot be read right now — contact support.', code: 'secrets_unreadable' }, 503);
  const provider = resolveProvider(cfg);
  if (!provider) {
    return reply({
      error: 'No payment gateway configured. Go to Settings -> Payment Gateway and save your Daraja credentials, your KCB Buni credentials, your Paywave Express API key, your Pesapal keys or your Co-op Bank details.',
    }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return reply({ error: 'Invalid request body.' }, 400);
  }

  const phone = normalizePhone(body.phone);
  const amount = Math.max(1, Math.round(Number(body.amount) || 0));
  const accountRef = String(body.accountRef || 'POS Sale').slice(0, 12);
  const description = String(body.description || 'POS Sale').slice(0, 13);

  if (!/^254(7|1)\d{8}$/.test(phone)) {
    return reply({ error: 'Invalid phone number. Use format 07XXXXXXXX or 2547XXXXXXXX.' }, 400);
  }
  if (!amount) {
    return reply({ error: 'Invalid amount.' }, 400);
  }

  // Per-shop hourly cap — a leaked link must not be able to spam customers' phones with payment prompts.
  const limited = await checkRateLimit(env, 'stk', clientId, 1);
  if (!limited.ok) return rateLimitResponse('M-Pesa payment prompts', limited, cors);
  // zip 247: ...and a cap per customer phone, so one number cannot be pestered with prompts (a customer who cancels can still be asked a few times)
  const limitedPhone = await checkRateLimit(env, 'stkPhone', clientId + ':' + phone, 1);
  if (!limitedPhone.ok) return rateLimitResponse('payment prompts to this phone number', limitedPhone, cors);

  try {
    const result = await sendStk(env, request, clientId, cfg, provider, { phone, amount, accountRef, description });

    return reply({
      checkoutRequestId: result.id,
      merchantRequestId: result.merchantRequestId,
      customerMessage: result.customerMessage,
      ...(result.paymentUrl ? { paymentUrl: result.paymentUrl } : {}),
    });
  } catch (err) {
    return reply({ error: err.message || 'Unexpected error contacting the payment gateway.' }, 500);
  }
}
