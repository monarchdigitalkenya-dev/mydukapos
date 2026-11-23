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
import { atomicHit, atomicRelease } from './_atomic-counter.js';
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

// zip 381: the access token lasts an hour. A new one was asked for on EVERY prompt and every status check; Safaricom throttles token requests
// ("spike arrest"), and a busy till then had prompts refused. A token is now reused for 50 minutes (per key, per environment), and dropped at once
// if Safaricom says it is no longer valid.
const DARAJA_TOKENS = globalThis.__darajaTokens || (globalThis.__darajaTokens = new Map());
export function darajaTokenKey(cfg) { return `${(cfg.mpesaEnv || 'sandbox').toLowerCase()}|${cfg.mpesaConsumerKey}|${cfg.mpesaConsumerSecret}`; }
async function darajaAccessToken(cfg) {
  const ck = darajaTokenKey(cfg), hit = DARAJA_TOKENS.get(ck);
  if (hit && hit.until > Date.now()) return hit.token;
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
  const life = Math.max(60, Math.min(3000, (Number(data.expires_in) || 3599) - 600)) * 1000;
  DARAJA_TOKENS.set(ck, { token: data.access_token, until: Date.now() + life });
  return data.access_token;
}

// zip 378: Safaricom refuses (or silently drops) an AccountReference / TransactionDesc with symbols - a business name like "Jay's Kitchen" or
// "WHITE STAR HOTEL(ACCOMODATION)" made every prompt fail. Letters, digits, spaces and hyphens only, cut to Safaricom's length.
function darajaText(v, max, fallback) {
  const t = String(v == null ? '' : v).replace(/[^A-Za-z0-9 -]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return t || fallback;
}

async function sendViaDaraja({ phone, amount, accountRef, description }, cfg, callbackUrl) {
  const shortcode = String(cfg.mpesaShortcode || '').trim();
  const passkey = String(cfg.mpesaPasskey || '').trim();
  // zip 249: a TILL (Buy Goods) has two numbers. BusinessShortCode is the Head Office / Store number (it also goes into the Password); PartyB is the
  // TILL number that receives the money. For a Paybill both are the same number, so PartyB is only used when the type is Till AND a Till number is saved
  // (a shop whose Store number and Till number are the same simply leaves it blank, exactly as before).
  const partyB = (cfg.mpesaTransactionType === 'CustomerBuyGoodsOnline' && cfg.mpesaPartyB) ? String(cfg.mpesaPartyB).trim() : shortcode;
  const push = async () => {
    const token = await darajaAccessToken(cfg);
    const timestamp = darajaTimestamp();
    const password = btoa(`${shortcode}${passkey}${timestamp}`);
    const stkRes = await fetch(`${darajaBaseUrl(cfg)}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: cfg.mpesaTransactionType || 'CustomerPayBillOnline',
        Amount: Math.max(1, Math.round(Number(amount) || 0)),
        PartyA: phone,
        PartyB: partyB,
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: darajaText(accountRef, 12, 'POS'),
        TransactionDesc: darajaText(description, 13, 'POS Sale'),
      }),
    });
    let stkData = {};
    try { stkData = await stkRes.json(); } catch (e) { /* not JSON (e.g. an HTML error page): handled below */ }
    return { stkRes, stkData };
  };
  const hadToken = (() => { const h = DARAJA_TOKENS.get(darajaTokenKey(cfg)); return !!(h && h.until > Date.now()); })();
  let { stkRes, stkData } = await push();
  // zip 381: a reused token that Safaricom no longer accepts is dropped and the prompt is sent ONCE more with a fresh login (so a bad key / secret still
  // shows its own login error, and a good one is never stuck behind an old token)
  const authFail = stkRes.status === 401 || /invalid (access token|authentication)/i.test(String(stkData.errorMessage || '')) || String(stkData.errorCode || '') === '404.001.03';
  if (authFail) {
    DARAJA_TOKENS.delete(darajaTokenKey(cfg));
    if (hadToken) ({ stkRes, stkData } = await push());
  }
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

// zip 356 - WHY KCB STILL FAILED AFTER ZIP 350, and the fixes:
//  1. LOGIN: the token request carried grant_type only in the address. KCB's live login server (accounts.buni.kcbgroup.com/oauth2/token, a WSO2
//     identity server) reads it from the form BODY, so a correct key/secret was refused ("unsupported_grant_type" / HTTP 400). It is now sent in
//     the body (and still in the address for the sandbox gateway), and a key / secret pasted with a space or line break is trimmed.
//  2. LIVE ADDRESS: production pushes went to buni.kcbgroup.com, which is KCB's developer PORTAL (a web page), not the API gateway, so the push
//     came back as an HTML page / 404 / 405. The live gateway is api.buni.kcbgroup.com; buni.kcbgroup.com is still tried if the gateway does not
//     answer like an API (KCB has never published one address for every account). The same for the login: accounts.buni.kcbgroup.com first,
//     then the gateway's own /token.
//  3. messageId: KCB accepts at most 32 characters; a 36-character UUID (zip 350) made the gateway refuse the push. Now 32 hex characters.
//  4. Shared short code: the Settings box was ticked by default and saved ticked, so a shop with its OWN Till + Pass Key was sent as "shared"
//     (KCB's 522522) and declined. Now the Pass Key decides: own Till + Pass Key = not shared; no Pass Key (or 522522) = shared.
//  5. Shared (no Pass Key - most shops): the request now has KCB's documented shape - orgShortCode / orgPassKey empty and
//     invoiceNumber "<KCB account or Till>-<reference>" - so KCB knows whose account the money goes to.
//  Override, only if KCB gives you different addresses: Cloudflare env vars KCB_STK_URL (full stkpush URL) and KCB_TOKEN_URL.
const KCB_STK_PATH = '/mm/api/request/1.0.0/stkpush';
function kcbEnvName(cfg) { return String(cfg.kcbEnv || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox'; }
function kcbStkUrls(cfg) {
  if (cfg.kcbStkUrl) return [String(cfg.kcbStkUrl)];
  return kcbEnvName(cfg) === 'production'
    ? ['https://api.buni.kcbgroup.com' + KCB_STK_PATH, 'https://buni.kcbgroup.com' + KCB_STK_PATH]
    : ['https://uat.buni.kcbgroup.com' + KCB_STK_PATH];
}
function kcbTokenUrls(cfg) {
  if (cfg.kcbTokenUrl) return [String(cfg.kcbTokenUrl)];
  return kcbEnvName(cfg) === 'production'
    ? ['https://accounts.buni.kcbgroup.com/oauth2/token', 'https://api.buni.kcbgroup.com/token?grant_type=client_credentials']
    : ['https://uat.buni.kcbgroup.com/token?grant_type=client_credentials'];
}
// kept for anything that still imports the old names
function kcbBaseUrl(cfg) { return kcbStkUrls(cfg)[0].replace(KCB_STK_PATH, ''); }
function kcbTokenUrl(cfg) { return kcbTokenUrls(cfg)[0]; }

// Reads a KCB answer as text first, so an HTML error page or an empty body can never crash with a raw SyntaxError.
async function kcbReadBody(res) {
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { text, json };
}
// An answer from something that is not the API at all (a web page, "not found", "method not allowed"): worth trying the next address.
function kcbNotTheApi(res, json) { return !json || res.status === 404 || res.status === 405; }
// The most useful sentence KCB gave us (gateway fault, header description or response description) - never any secret.
function kcbWords(json) {
  if (!json || typeof json !== 'object') return '';
  const f = json.fault || {};
  const h = json.header || {};
  const r = json.response || {};
  return String(r.ResponseDescription || h.statusDescription || f.description || f.message || json.error_description || json.error || json.errorMessage || json.message || '').slice(0, 300);
}
function kcbMessageId() {
  const hex = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(16) + Math.random().toString(16).slice(2)).padEnd(32, '0');
  return hex.slice(0, 32);                                    // KCB: messageId at most 32 characters
}

async function kcbAccessToken(cfg) {
  const envName = kcbEnvName(cfg);
  const key = String(cfg.kcbConsumerKey || '').trim(), secret = String(cfg.kcbConsumerSecret || '').trim();
  const auth = btoa(`${key}:${secret}`);
  let last = null;
  for (const url of kcbTokenUrls(cfg)) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    } catch (e) {
      last = new Error(`Could not reach KCB Buni (${envName}) to log in: ${e && e.message ? e.message : 'network error'}.`);
      continue;
    }
    const { json } = await kcbReadBody(res);
    if (res.ok && json && json.access_token) return json.access_token;
    if (!res.ok) {
      const why = kcbWords(json);
      last = new Error(`KCB Buni login failed (${envName}, HTTP ${res.status})${why ? ': ' + why : ''}. Check the Consumer Key / Consumer Secret and that Environment in Settings matches where they were created.`);
      if (kcbNotTheApi(res, json)) continue;                  // not the login server: try the next address
      throw last;                                             // a real refusal (wrong key / secret): stop here
    }
    last = new Error(`KCB Buni did not return an access token (${envName}). Could not authenticate - check the Consumer Key / Consumer Secret saved in Settings.`);
    if (!json) continue;
    throw last;
  }
  throw last || new Error(`KCB Buni login failed (${envName}).`);
}

// zip 388: in SANDBOX every prompt sent to KCB is kept (7 days) exactly as sent - address, headers (the login token hidden), JSON body - with KCB's
// answer, under kcb-debug:<shop>. Open /api/kcb-debug?c=<shop>&k=<the shop's KCB key> to read it (the key is the k= in the IPN URL in Settings).
// Never in production unless the env var KCB_DEBUG_ALL=1 is set. Best effort: a storage error never affects the prompt.
async function saveKcbDebug(dbg, rec) {
  try {
    if (!dbg || !dbg.env || !dbg.clientId || !dbg.env.mydukapos_kv) return;
    await dbg.env.mydukapos_kv.put('kcb-debug:' + dbg.clientId, JSON.stringify({ at: new Date().toISOString(), ...rec }), { expirationTtl: 7 * 24 * 3600 });
  } catch (e) { /* the prompt itself is unaffected */ }
}

async function sendViaKcb({ phone, amount, accountRef, description }, cfg, callbackUrl, dbg) {
  // Confirmed directly from a real merchant's own KCB onboarding: their
  // Till/shortcode is provisioned specifically for them as part of getting
  // production access approved — it's never optional, and there's no
  // generic fallback code that works for everyone. Silently defaulting to
  // a guessed shortcode here would mean money going to the wrong place, so
  // this fails loudly instead if it's missing.
  if (!cfg.kcbOrgShortCode) {
    throw new Error('No KCB Till/Short Code saved. Enter the Till Number KCB provisioned for this shop in Settings — there is no shared/default code that works for every merchant.');
  }
  const p = String(phone || '');
  if (!/^254(7|1)\d{8}$/.test(p)) throw new Error(`KCB Buni needs a Kenyan mobile number like 0712 345 678 (got "${p}").`);

  const token = await kcbAccessToken(cfg);
  const passKey = String(cfg.kcbOrgPassKey || '').trim();
  // Own Till = its own Pass Key; KCB's shared short code (522522) has none. The Settings box was ticked by default and saved that way, so a shop
  // with its own Till + Pass Key was sent as "shared" and KCB refused or ignored its Till. The Pass Key decides.
  const shared = !passKey || String(cfg.kcbOrgShortCode).trim() === '522522';

  const till = String(cfg.kcbOrgShortCode).trim();
  const ref = String(accountRef || 'POS').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 12) || 'POS';
  // KCB's documented shared-code request: sharedShortCode true, orgShortCode and orgPassKey EMPTY, and the money is routed by invoiceNumber =
  // "<your KCB account / Till number>-<reference>" (e.g. 1234567-INV001). Before, the shop's Till went in orgShortCode and invoiceNumber was just
  // "POS Sale", so KCB had no account to put the money in and declined. Own short code (with a Pass Key): orgShortCode + Pass Key, plain reference.
  const payload = {
    phoneNumber: p,
    amount: String(Math.max(1, Math.round(Number(amount) || 0))),     // whole shillings, as text
    invoiceNumber: shared && till !== '522522' ? `${till}-${ref}` : ref,
    sharedShortCode: shared,
    orgShortCode: shared ? '' : till,
    orgPassKey: shared ? '' : passKey,
    callbackUrl,
    transactionDescription: String(description || 'POS Sale').slice(0, 13),
  };

  const envName = kcbEnvName(cfg);
  const keep = envName === 'sandbox' || String((dbg && dbg.env && dbg.env.KCB_DEBUG_ALL) || '') === '1';
  const bodyText = JSON.stringify(payload);
  const sent = [];                                            // what went to KCB, attempt by attempt (for the sandbox record)
  let stkRes = null, stkData = null, stkText = '';
  const urls = kcbStkUrls(cfg);
  for (let i = 0; i < urls.length; i++) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // KCB's gateway routes and traces the call with these three headers.
      routeCode: String(cfg.kcbRouteCode || '207'),
      operation: 'STKPush',
      messageId: kcbMessageId(),
    };
    const shown = { method: 'POST', url: urls[i], headers: { ...headers, Authorization: 'Bearer <access token from ' + kcbTokenUrl(cfg) + '>' }, body: payload };
    try {
      stkRes = await fetch(urls[i], { method: 'POST', headers, body: bodyText });
    } catch (e) {
      sent.push({ ...shown, error: e && e.message ? e.message : 'network error' });
      if (i < urls.length - 1) continue;
      if (keep) await saveKcbDebug(dbg, { provider: 'kcb', environment: envName, requests: sent });
      const ne = new Error(`Could not reach KCB Buni (${envName}) to send the prompt: ${e && e.message ? e.message : 'network error'}.`);
      if (keep) ne.kcbDebug = { provider: 'kcb', environment: envName, requests: sent };
      throw ne;
    }
    const rb = await kcbReadBody(stkRes);
    stkData = rb.json; stkText = rb.text;
    sent.push({ ...shown, response: { status: stkRes.status, body: stkData || String(stkText || '').slice(0, 2000) } });
    if (!kcbNotTheApi(stkRes, stkData) || i === urls.length - 1) break;   // the API answered (yes or no): that is the answer
  }
  if (keep) await saveKcbDebug(dbg, { provider: 'kcb', environment: envName, requests: sent });
  // zip 389: in sandbox the exact request also goes back to the till, which shows it in a popup with a Copy button (the kcb-sandbox block)
  const kcbDebug = keep ? { provider: 'kcb', environment: envName, requests: sent } : null;

  const resp = stkData && stkData.response;
  const headerOk = !stkData || !stkData.header || stkData.header.statusCode === undefined || String(stkData.header.statusCode) === '0';
  if (!stkRes.ok || !resp || String(resp.ResponseCode) !== '0' || !headerOk) {
    const why = kcbWords(stkData);
    const ke = new Error(`KCB Buni did not send the prompt (${envName}, HTTP ${stkRes.status})${why ? ': ' + why : ''}.`);
    if (kcbDebug) ke.kcbDebug = kcbDebug;
    throw ke;
  }

  return {
    id: resp.CheckoutRequestID,
    merchantRequestId: resp.MerchantRequestID,
    customerMessage: resp.CustomerMessage || 'Prompt sent to customer phone.',
    ...(kcbDebug ? { kcbDebug } : {}),
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
  // zip 381: Nairobi time, like Daraja (zip 249). Co-op wraps Safaricom's STK, and the server clock is UTC: a UTC timestamp made the Password 3 hours off.
  const timestamp = darajaTimestamp();
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
    AccountReference: darajaText(accountRef, 12, 'POS'),      // zip 381: plain text, like Daraja
    TransactionDesc: darajaText(description, 13, 'POS Sale'),
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

// zip 273: a payment ATTEMPT is written down BEFORE the provider is called, so a request that dies half way (timeout, lost connection, a worker
// restart) leaves a record instead of an invisible prompt on a customer's phone. States: initiating -> sent | declined | unknown. 'unknown' means the
// provider may or may not have received the request: it is never treated as failed, and a second prompt to the same phone is refused for a short
// while so the customer is not asked twice (nor the till double-charged). The existing tx record (status pending | success | failed, keyed by the
// provider's id) is unchanged, so every till, callback and status poll keeps working; it only gains `attemptId` and `phase`.
const attKey = (clientId, id) => `mpesa-att:${clientId}:${id}`;
const idemKey = (clientId, key) => `mpesa-idem:${clientId}:${key}`;
const STK_TIMEOUT_MS = (env) => { const n = Number(env && env.STK_PROVIDER_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 25000; };
export const UNKNOWN_HOLD_SEC = 45;           // after an unknown outcome the same phone + amount is not prompted again for this long
export const DUPLICATE_WINDOW_SEC = 20;       // an identical request inside this window (double-tap, refresh) gets the first answer instead of a second prompt

function isNetworkFailure(e) {
  if (!e) return false;
  if (e.code === 'stk_timeout') return true;
  return e.name === 'TypeError' || /fetch failed|network|connection|socket|ECONN|ETIMEDOUT|timed out|timeout|abort|reset by peer|lost/i.test(String(e.message || ''));
}
function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('The payment service did not answer in time.'), { code: 'stk_timeout' })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
async function putAttempt(env, clientId, id, rec) {
  try { await env.mydukapos_kv.put(attKey(clientId, id), JSON.stringify(rec), { expirationTtl: 30 * 86400 }); } catch (e) { /* the prompt itself must not fail because the note could not be saved */ }
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

  const attemptId = crypto.randomUUID();
  const attempt = { attemptId, status: 'initiating', provider, phone, amount, accountRef, createdAt: Date.now() };
  await putAttempt(env, clientId, attemptId, attempt);          // written BEFORE the provider is called

  let result;
  try {
    const call = provider === 'kcb'
      ? sendViaKcb({ phone, amount, accountRef, description }, cfg, callbackUrl, { env, clientId })
      : provider === 'paywave'
        ? sendViaPaywaveExpress({ phone, amount, accountRef, description }, cfg)
        : provider === 'coop'
          ? sendViaCoop({ phone, amount, accountRef, description }, cfg, callbackUrl)
          : provider === 'pesapal'
            ? (async () => sendViaPesapal({ phone, amount, accountRef, description }, cfg, { env, clientId, ipnUrl: withKey(`${origin}/api/pesapal-ipn?c=${encodeURIComponent(clientId)}`, await ensureCallbackKey(env, clientId, 'pesapal')), returnUrl: `${origin}/pesapal-done.html` }))()
            : sendViaDaraja({ phone, amount, accountRef, description }, cfg, callbackUrl);
    result = await withTimeout(call, STK_TIMEOUT_MS(env));
  } catch (e) {
    if (isNetworkFailure(e)) {
      // The provider may have received it: NOT a failure. Keep the note, tell the caller plainly, never "failed".
      await putAttempt(env, clientId, attemptId, { ...attempt, status: 'unknown', finishedAt: Date.now(), error: String(e.message || e).slice(0, 200) });
      const err = new Error('The payment service did not answer in time, so it is not known whether the prompt reached the customer. Do not send it again for a minute: ask the customer to check their phone, or use Check payment.');
      err.code = 'stk_unknown'; err.attemptId = attemptId; err.retryAfter = UNKNOWN_HOLD_SEC;
      throw err;
    }
    await putAttempt(env, clientId, attemptId, { ...attempt, status: 'declined', finishedAt: Date.now(), error: String(e.message || e).slice(0, 200) });
    throw e;
  }

  // Save a "pending" placeholder — keyed by the same id in both gateways —
  // so the status endpoint (and, for Paystack, the webhook) has an immediate
  // record to find and update.
  // zip 263: some Paywave answers carry only transaction_request_id; the record is then kept under that, never under "undefined"
  result.id = result.id || result.transactionRequestId;
  // zip 381: a provider "success" with no id at all could never be followed up (the record was saved under "undefined" and every such prompt
  // shared it). Treated as not sent, with the provider's own message.
  if (!result.id) {
    await putAttempt(env, clientId, attemptId, { ...attempt, status: 'declined', finishedAt: Date.now(), error: 'no request id in the answer' });
    throw new Error('The payment service accepted the request but did not return a request number, so the payment cannot be followed. Please try again.');
  }
  await env.mydukapos_kv.put(txKey(clientId, result.id), JSON.stringify({
    provider,
    status: 'pending',
    phase: 'awaiting_customer',
    attemptId,
    phone,
    amount,
    accountRef,
    transactionRequestId: result.transactionRequestId,
    merchantReference: result.merchantReference,
    createdAt: Date.now(),
  }));
  await putAttempt(env, clientId, attemptId, { ...attempt, status: 'sent', providerId: result.id, finishedAt: Date.now() });
  result.attemptId = attemptId;

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

  // zip 273: the same request twice (a double tap, a refresh, a retry after a lost answer) must not send two prompts. The key is the till's own
  // idempotencyKey when it sends one, else the shop + phone + amount + reference; the FIRST request of a window claims it atomically (ledger D1) and the
  // others get that first answer. After an UNKNOWN outcome the same phone + amount is held for UNKNOWN_HOLD_SEC instead of being prompted again.
  const dkey = String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || `d.${phone}.${amount}.${accountRef.replace(/[^A-Za-z0-9]/g, '')}`;
  const explicit = !!(body.idempotencyKey || request.headers.get('Idempotency-Key'));
  const ikey = idemKey(clientId, dkey);
  const seenRaw = await env.mydukapos_kv.get(ikey);
  const seen = seenRaw ? JSON.parse(seenRaw) : null;
  if (seen) {
    const age = (Date.now() - seen.at) / 1000;
    if (seen.state === 'unknown' && age < UNKNOWN_HOLD_SEC) return reply({ error: 'A prompt to this phone may already have been sent a moment ago and its outcome is not known yet. Ask the customer to check their phone, or use Check payment. You can send again in about ' + Math.ceil(UNKNOWN_HOLD_SEC - age) + ' seconds.', code: 'stk_unknown', retryAfter: Math.ceil(UNKNOWN_HOLD_SEC - age), attemptId: seen.attemptId }, 409);
    if (seen.state === 'sent' && (explicit || age < DUPLICATE_WINDOW_SEC)) return reply({ checkoutRequestId: seen.id, merchantRequestId: seen.merchantRequestId, customerMessage: seen.customerMessage, ...(seen.paymentUrl ? { paymentUrl: seen.paymentUrl } : {}), duplicate: true });
  }
  const claimKey = `stkclaim:${clientId}:${dkey}:${Math.floor(Date.now() / (DUPLICATE_WINDOW_SEC * 1000))}`;
  const claim = await atomicHit(env, claimKey, 1, 120);
  if (claim !== null && claim > 1) {
    // another request with the same key is sending right now: give it a moment and return its answer, never send a second prompt
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const again = await env.mydukapos_kv.get(ikey);
      if (again) { const o = JSON.parse(again); if (o.state === 'sent') return reply({ checkoutRequestId: o.id, merchantRequestId: o.merchantRequestId, customerMessage: o.customerMessage, ...(o.paymentUrl ? { paymentUrl: o.paymentUrl } : {}), duplicate: true }); if (o.state === 'unknown') return reply({ error: 'The payment service did not answer in time, so it is not known whether the prompt reached the customer. Ask the customer to check their phone, or use Check payment.', code: 'stk_unknown', retryAfter: UNKNOWN_HOLD_SEC, attemptId: o.attemptId }, 409); }
    }
    return reply({ error: 'This prompt is already being sent. Wait a few seconds, then check the customer\u2019s phone.', code: 'stk_in_progress', retryAfter: 5 }, 409);
  }

  // Per-shop hourly cap — a leaked link must not be able to spam customers' phones with payment prompts.
  const limited = await checkRateLimit(env, 'stk', clientId, 1);
  if (!limited.ok) return rateLimitResponse('M-Pesa payment prompts', limited, cors);
  // zip 247: ...and a cap per customer phone, so one number cannot be pestered with prompts (a customer who cancels can still be asked a few times)
  const limitedPhone = await checkRateLimit(env, 'stkPhone', clientId + ':' + phone, 1);
  if (!limitedPhone.ok) return rateLimitResponse('payment prompts to this phone number', limitedPhone, cors);

  try {
    const result = await sendStk(env, request, clientId, cfg, provider, { phone, amount, accountRef, description });
    try { await env.mydukapos_kv.put(ikey, JSON.stringify({ state: 'sent', at: Date.now(), id: result.id, merchantRequestId: result.merchantRequestId, customerMessage: result.customerMessage, paymentUrl: result.paymentUrl, attemptId: result.attemptId }), { expirationTtl: explicit ? 600 : 120 }); } catch (e) { /* the prompt is out; only the double-tap guard is lost */ }

    return reply({
      checkoutRequestId: result.id,
      merchantRequestId: result.merchantRequestId,
      customerMessage: result.customerMessage,
      attemptId: result.attemptId,
      ...(result.paymentUrl ? { paymentUrl: result.paymentUrl } : {}),
      ...(result.kcbDebug ? { kcbDebug: result.kcbDebug } : {}),
    });
  } catch (err) {
    if (err && err.code === 'stk_unknown') {
      try { await env.mydukapos_kv.put(ikey, JSON.stringify({ state: 'unknown', at: Date.now(), attemptId: err.attemptId }), { expirationTtl: 180 }); } catch (e) { /* none */ }
      return reply({ error: err.message, code: 'stk_unknown', retryAfter: err.retryAfter || UNKNOWN_HOLD_SEC, attemptId: err.attemptId, ...(err.kcbDebug ? { kcbDebug: err.kcbDebug } : {}) }, 504);
    }
    await atomicRelease(env, claimKey);                      // nothing was sent: the same request may be tried again at once
    return reply({ error: err.message || 'Unexpected error contacting the payment gateway.', ...(err && err.kcbDebug ? { kcbDebug: err.kcbDebug } : {}) }, 500);
  }
}
