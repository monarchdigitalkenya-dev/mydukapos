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
import { mapShortcodes, saveRegistration } from './_till-diag.js';

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
  // zip 358: the shop and its key travel in the PATH (/api/pcb/<shop>/<key>/c), not a query string - Safaricom documents nothing about query strings in
  // Register URL addresses and refuses the word "query". Neutral words only (no mpesa / m-pesa / safaricom / exe / cmd / sql). The legacy query-string
  // form still works for shops that registered it before (pay-cb-till-confirm).
  const legacyForm = String((env && env.C2B_URL_FORM) || '').toLowerCase() === 'query';
  const confirmationUrl = legacyForm ? withKey(`${origin}/api/pay-cb-till-confirm?c=${encodeURIComponent(clientId)}`, cbKey) : `${origin}/api/pcb/${encodeURIComponent(clientId)}/${encodeURIComponent(cbKey.k)}/c`;
  const validationUrl = legacyForm ? withKey(`${origin}/api/pay-cb-till-validate?c=${encodeURIComponent(clientId)}`, cbKey) : `${origin}/api/pcb/${encodeURIComponent(clientId)}/${encodeURIComponent(cbKey.k)}/v`;
  const shown = (url) => url.replace(/&k=[^&]*/, '&k=•••').replace(/(\/api\/pcb\/[^/]+\/)[^/]+(\/[cv])$/, '$1•••$2');
  // zip 358: for a Till (Buy Goods) Safaricom's own guides tie the live app to the STORE / Head Office number, while some accounts only accept the Till
  // number - and nothing official says which one notifications are sent for. So BOTH numbers are registered (each one once; production refuses a
  // second registration of the same number, reported as "already registered"). A payment arriving on either is captured.
  const isTill = cfg.mpesaTransactionType === 'CustomerBuyGoodsOnline';
  const till = String(cfg.mpesaPartyB || '').trim(), code = String(cfg.mpesaShortcode || '').trim();
  const candidates = [...new Set((isTill ? [code, till] : [code, till]).filter(Boolean))];
  if (!candidates.length) return jsonResponse({ error: 'Enter the Till number and the Shortcode (Store / Head Office number) in Settings > Payment Gateway first.' }, 400);

  try {
    const token = await darajaAccessToken(cfg);
    // zip 358: C2B v2 first (Safaricom's current version; v1 is legacy), v1 when the app answers 401 for v2 (an app is subscribed to one version only).
    const first = String((env && env.DARAJA_C2B_VERSION) || 'v2').toLowerCase() === 'v1' ? 'v1' : 'v2';
    const post = (ver, sc) => fetch(`${darajaBaseUrl(cfg)}/mpesa/c2b/${ver}/registerurl`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ShortCode: sc, ResponseType: 'Completed', ConfirmationURL: confirmationUrl, ValidationURL: validationUrl }),
    });
    const results = [];
    for (const sc of candidates) {
      let usedVersion = first, res = await post(first, sc);
      if (res.status === 401) { const alt = first === 'v1' ? 'v2' : 'v1'; const r2 = await post(alt, sc); if (r2.status !== 401) { res = r2; usedVersion = alt; } }
      let data = {};
      try { data = await res.json(); } catch (e) { /* not JSON (an HTML error page) */ }
      const ok = res.ok && !(data.ResponseCode !== undefined && String(data.ResponseCode) !== '0');
      const msg = ok ? (data.ResponseDescription || 'Registered.') : (data.errorMessage || data.ResponseDescription || `Safaricom declined the URL registration (HTTP ${res.status}).`);
      const already = !ok && /duplicate notification|already registered/i.test(msg);
      results.push({ shortCode: sc, ok, already, version: usedVersion, status: res.status, message: msg + (data.errorCode ? ` [${data.errorCode}]` : '') });
    }
    // every number Safaricom accepted (or already had) points at this shop: a callback that arrives without the shop in its address is matched by number
    await mapShortcodes(env, clientId, results.filter((r) => r.ok || r.already).map((r) => r.shortCode));
    await saveRegistration(env, clientId, { results, confirmationUrl: shown(confirmationUrl), validationUrl: shown(validationUrl), form: legacyForm ? 'query' : 'path' });

    const good = results.filter((r) => r.ok);
    if (good.length) {
      const extra = results.filter((r) => !r.ok).map((r) => `${r.shortCode}: ${r.already ? 'already registered earlier (see below)' : r.message}`);
      return jsonResponse({ success: true, shortCode: good.map((r) => r.shortCode).join(' + '), results, confirmationUrl: shown(confirmationUrl), validationUrl: shown(validationUrl),
        message: `Registered with Safaricom for ${good.map((r) => r.shortCode + ' (C2B ' + r.version + ')').join(' and ')}.` + (extra.length ? ' Also: ' + extra.join('; ') + '.' : '') + ' Pay KES 10 to the Till from a phone and watch Settings > Payment Gateway > Till health: it should say "Received" within a minute.',
        c2bVersion: good[0].version });
    }
    // nothing accepted: explain the most useful reason
    const all = results.map((r) => r.message).join(' | ');
    let hint = '';
    if (results.some((r) => r.already)) hint = ' Safaricom already has addresses registered for ' + results.filter((r) => r.already).map((r) => r.shortCode).join(' / ') + ' and production accepts them only ONCE. If payments are not showing, those old addresses are the reason: an admin deletes them in the M-PESA / Daraja portal (Self Services > URL Management) or emails apisupport@safaricom.co.ke asking to delete the C2B URLs for that number - then press Register again here.';
    else if (results.some((r) => r.status === 401 || /invalid access token|401\.003\.01/i.test(r.message))) hint = ' Your keys work for the payment prompt but Safaricom has not switched the C2B (customer-to-business) service on for this app, on either v2 or v1. In the Daraja portal open My Apps and make sure the C2B product is on the live app; at Go Live pick the Store / Head Office number for a Till. Nothing in MyDukaPOS can bypass that step.';
    else if (results.every((r) => /invalid (short)?code|shortcode|400\.003\.02/i.test(r.message))) hint = ` Numbers tried: ${candidates.join(', ')}. Safaricom refused all of them: the live Daraja app must belong to one of these numbers (for a Till it is usually the Store / Head Office number).`;
    else if (results.some((r) => /url/i.test(r.message))) hint = ' The address must be public https and must not contain the words mpesa / safaricom / query / exe / cmd / sql.';
    return jsonResponse({ error: all + hint, results, confirmationUrl: shown(confirmationUrl) }, 500);
  } catch (err) {
    return jsonResponse({ error: err.message || 'Unexpected error contacting Safaricom.' }, 500);
  }
}
