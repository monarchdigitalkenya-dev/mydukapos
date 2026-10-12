// functions/api/mpesa-c2b-register.js — Cloudflare Pages Function
//
// Runs Safaricom's C2B RegisterURL call, telling them where to send
// Validation/Confirmation notifications for this shop's Paybill/Till from
// now on. A ONE-TIME step (re-run it if the shop's Shortcode ever changes),
// triggered from "Register Till URLs" in Settings -> Payment Gateway.
// Requires Daraja credentials (Option B) to already be saved for this shop.
//
// After this succeeds, any customer paying directly to the till — no STK
// Push, no app involvement — gets captured automatically by
// mpesa-c2b-confirmation.js.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { ensureCallbackKey, withKey, callbackOrigin } from './_callback-key.js';
import { loadGatewayConfig, hasDarajaConfig } from './_gateway-config.js';
import { requireValidLicense } from './_license.js';
import { deviceGuard } from './_device-auth.js';
import { corsHeadersFor } from './_cors.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function darajaBaseUrl(cfg) {
  const envName = (cfg.mpesaEnv || 'sandbox').toLowerCase();
  return envName === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}

async function darajaAccessToken(cfg) {
  const auth = btoa(`${cfg.mpesaConsumerKey}:${cfg.mpesaConsumerSecret}`);
  const res = await fetch(`${darajaBaseUrl(cfg)}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || !data.access_token) {
    // zip 250: say why (wrong environment for these keys is the usual cause)
    const envName = (cfg.mpesaEnv || 'sandbox').toLowerCase();
    const detail = data.errorMessage || data.error_description || data.error || '';
    throw new Error(`Could not authenticate with M-Pesa (HTTP ${res.status}${detail ? ': ' + detail : ''}). The Environment is set to ${envName.toUpperCase()}: use the Consumer Key / Secret of a ${envName} app.`);
  }
  return data.access_token;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const clientId = license.clientId;
  // PAIRED DEVICES ONLY when the shop has switched that on (see _device-auth.js); otherwise no change
  const deviceDenied = await deviceGuard(request, env, clientId, corsHeadersFor(request, env));
  if (deviceDenied) return deviceDenied;

  const cfg = await loadGatewayConfig(env, clientId);
  if (!hasDarajaConfig(cfg)) {
    return jsonResponse({ error: 'Save your Daraja credentials (Option B) in Settings -> Payment Gateway first \u2014 registering till URLs needs them.' }, 400);
  }

  const origin = callbackOrigin(request, env);
  // zip 143: registered with this shop's secret key, so a forged "payment received" can no longer be posted for the shop
  const cbKey = await ensureCallbackKey(env, clientId, 'c2b');
  // zip 250: the addresses must NOT contain "mpesa", "m-pesa" or "safaricom": Safaricom's production RegisterURL filters those out (sandbox does not).
  // pay-cb-till-confirm / pay-cb-till-validate are the same handlers as mpesa-c2b-confirmation / -validation under neutral names.
  const confirmationUrl = withKey(`${origin}/api/pay-cb-till-confirm?c=${encodeURIComponent(clientId)}`, cbKey);
  const validationUrl = withKey(`${origin}/api/pay-cb-till-validate?c=${encodeURIComponent(clientId)}`, cbKey);
  // zip 250: the number that RECEIVES the customers' money. For a Till (Buy Goods) shop that is the Till number (the Store / Head Office number is only
  // for the STK prompt's BusinessShortCode + password); for a Paybill it is the Paybill. Registering the Store number would listen on the wrong number.
  const isTill = cfg.mpesaTransactionType === 'CustomerBuyGoodsOnline';
  // zip 263: the Till number and the Shortcode (Store / Head Office / Paybill) can be different numbers, and which one C2B accepts depends on the app's C2B version
  // and the account. So both are tried, one at a time, preferred one first (Till for a Till shop, Shortcode otherwise), until Safaricom accepts one.
  const till = String(cfg.mpesaPartyB || '').trim(), code = String(cfg.mpesaShortcode || '').trim();
  const candidates = [...new Set((isTill ? [till, code] : [code, till]).filter(Boolean))];
  let shortCode = candidates[0] || '';

  try {
    const token = await darajaAccessToken(cfg);
    // zip 262: "Invalid Access Token [401.003.01]" on RegisterURL while STK Push works means the token is real but this app is not allowed on THAT version of the C2B
    // API (an app can be subscribed to v1 or v2 only). So when the first version answers 401, the other one is tried once, and the version that worked is reported.
    const first = String((env && env.DARAJA_C2B_VERSION) || 'v1').toLowerCase() === 'v2' ? 'v2' : 'v1';
    const post = (ver, sc) => fetch(`${darajaBaseUrl(cfg)}/mpesa/c2b/${ver}/registerurl`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ShortCode: sc, ResponseType: 'Completed', ConfirmationURL: confirmationUrl, ValidationURL: validationUrl }),
    });
    let usedVersion = first, res, data, why = '';
    for (const sc of candidates.length ? candidates : ['']) {
      shortCode = sc;
      usedVersion = first;
      res = await post(first, sc);
      if (res.status === 401) { const alt = first === 'v1' ? 'v2' : 'v1'; const r2 = await post(alt, sc); if (r2.status !== 401) { res = r2; usedVersion = alt; } }
      data = {};
      try { data = await res.json(); } catch (e) { /* not JSON (an HTML error page): handled below */ }
      if (res.ok && !(data.ResponseCode !== undefined && String(data.ResponseCode) !== '0')) { why = ''; break; }
      why = data.errorMessage || data.ResponseDescription || `Safaricom declined the URL registration (HTTP ${res.status}).`;
      // only a "wrong number" answer moves on to the next number; anything else (already registered, no C2B access, bad URL) is the real answer
      if (!/invalid (short)?code|shortcode|400\.003\.02/i.test(why + (data.errorCode || ''))) break;
    }
    if (why) {
      let hint = '';
      // production lets a shortcode's URLs be registered ONCE; changing them means deleting the old ones first
      if (/duplicate notification/i.test(why)) hint = ' These URLs are already registered for this number. If you changed the address, delete the old URLs in the Daraja portal (My Apps > your app > URL Management / Self Services), then press Register again - or email apisupport@safaricom.co.ke.';
      else if (/invalid (short)?code|shortcode/i.test(why)) hint = ` Numbers tried: ${candidates.join(', ') || 'none'} (Till number box and Shortcode). Safaricom refused all of them: the number must be the one that receives the money, and the C2B API must be enabled on your live Daraja app for it.`;
      else if (res.status === 401 || /invalid access token|401\.003\.01/i.test(why + (data.errorCode || ''))) hint = ' Your keys work for the payment prompt but Safaricom has not switched the C2B (customer-to-business) service on for this app, on either v1 or v2. In the Daraja portal open My Apps, edit this app and make sure the C2B API is ticked; for a live Till also ask Safaricom (apis@safaricom.co.ke, or the Go-Live request) to enable C2B URL registration for the Till number ' + shortCode + ' - it is granted per number, not per key. Nothing in MyDukaPOS can bypass that step.';
      else if (/url/i.test(why)) hint = ' The address must be public https and must not contain the words mpesa / safaricom.';
      throw new Error(`${why}${data.errorCode ? ` [${data.errorCode}]` : ''}${hint}`);
    }
    // The key went to Safaricom server-to-server; the page is shown the URLs without it (zip 143).
    const shown = (u) => u.replace(/&k=[^&]*/, '&k=•••');
    return jsonResponse({ success: true, shortCode, confirmationUrl: shown(confirmationUrl), validationUrl: shown(validationUrl), message: (data.ResponseDescription || 'Registered.') + (usedVersion !== first ? ' (accepted on C2B ' + usedVersion + ')' : '') + (shortCode !== candidates[0] ? ' (number ' + shortCode + ' accepted after ' + candidates[0] + ' was refused)' : ''), c2bVersion: usedVersion });
  } catch (err) {
    return jsonResponse({ error: err.message || 'Unexpected error contacting Safaricom.' }, 500);
  }
}
