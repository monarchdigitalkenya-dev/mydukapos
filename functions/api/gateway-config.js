// functions/api/gateway-config.js — Cloudflare Pages Function
//
// Backs the Settings -> Payment Gateway panel in index.html, scoped per
// client link (the `c` query param — see _license.js). Each shop's
// Paystack, Daraja, or KCB Buni credentials are stored separately, keyed by
// their own link, so one shop can never see or affect another's payment
// config.
//
// GET    -> tells the Settings panel what's configured so far for this client.
//           Never sends actual secret values back — only booleans plus the
//           non-secret fields (env, transaction type, forced provider) so the
//           dropdowns can be pre-filled. Also returns this client's own
//           paystack-webhook / mpesa-callback URLs (each includes ?c=<token>
//           so the gateway's callback lands back on the right shop) — the
//           same mpesa-callback URL is used for BOTH Daraja and KCB, since
//           KCB's callback payload is shaped identically to Safaricom's own.
// POST   -> saves whichever fields were sent in the body; any field left out
//           is untouched (see saveGatewayConfig in _gateway-config.js).
// DELETE -> clears one provider's saved credentials (body: { which: 'paystack'
//           | 'daraja' | 'kcb' }), used by the Settings panel's "Reset"
//           button for that provider.
//
// Blocked with 403 if this link's license isn't currently valid.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { loadGatewayConfig, saveGatewayConfig, clearGatewayProvider, hasPaystackConfig, hasDarajaConfig, hasKcbConfig, hasPaywaveConfig, hasPesapalConfig, hasCoopConfig } from './_gateway-config.js';
import { requireValidLicense } from './_license.js';
import { deviceGuard } from './_device-auth.js';
import { corsHeadersFor } from './_cors.js';
import { getCallbackKey, ensureCallbackKey, withKey } from './_callback-key.js';
import { managerGuard, secLimit, secNum } from './_sec-guard.js';
import { readMode, verifyToken, staffTokenOf } from './_staff-auth.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet(context) {
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
  const origin = new URL(request.url).origin;

  // zip 185: the KCB IPN / Paywave webhook URLs carry this shop's secret callback key (&k=...), and the owner needs the FULL url to give to KCB /
  // paste into Paywave, so it is shown in full as before — except when the shop requires staff sessions and the caller is not the Admin / a
  // manager: they get the key masked (the same mask mpesa-c2b-register.js uses).
  let showKey = true;
  try {
    if ((await readMode(env, clientId)) === 'enforce') {
      const tok = staffTokenOf(request);
      const claims = tok ? await verifyToken(env, clientId, tok) : null;
      showKey = !!(claims && !claims.expired && claims.mgr);
    }
  } catch (e) { showKey = false; }
  const shown = (u) => (showKey ? u : u.replace(/&k=[^&]*/, '&k=•••'));

  return jsonResponse({
    hasPaystackKey: hasPaystackConfig(cfg),
    hasDarajaConfig: hasDarajaConfig(cfg),
    hasKcbConfig: hasKcbConfig(cfg),
    hasPaywaveConfig: hasPaywaveConfig(cfg),
    hasPesapalConfig: hasPesapalConfig(cfg),
    hasCoopConfig: hasCoopConfig(cfg),
    pesapalEnv: cfg.pesapalEnv,
    coopTokenUrl: cfg.coopTokenUrl || '',
    coopStkUrl: cfg.coopStkUrl || '',
    coopShortcode: cfg.coopShortcode || '',
    coopTransactionType: cfg.coopTransactionType,
    pesapalIpnUrl: shown(withKey(`${origin}/api/pesapal-ipn?c=${encodeURIComponent(clientId)}`, await getCallbackKey(env, clientId, 'pesapal'))),
    mpesaEnv: cfg.mpesaEnv,
    kcbEnv: cfg.kcbEnv,
    kcbSharedShortCode: cfg.kcbSharedShortCode,
    paywaveEmail: cfg.paywaveEmail,
    forcedProvider: cfg.forcedProvider || '',
    paystackWebhookUrl: `${origin}/api/paystack-webhook?c=${encodeURIComponent(clientId)}`,
    mpesaCallbackUrl: `${origin}/api/mpesa-callback?c=${encodeURIComponent(clientId)}`,
    paywaveWebhookUrl: shown(withKey(`${origin}/api/paywave-webhook?c=${encodeURIComponent(clientId)}`, await getCallbackKey(env, clientId, 'paywave'))),   // zip 185: keyed for shops created from now on
    kcbIpnUrl: shown(withKey(`${origin}/api/kcb-ipn?c=${encodeURIComponent(clientId)}`, await getCallbackKey(env, clientId, 'kcb'))),
  });
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

  // zip 185: payment credentials — only the Admin / a manager when the shop requires staff sessions (no change otherwise), and a per-shop hourly cap
  const mgrDenied = await managerGuard(request, env, clientId, {});
  if (mgrDenied) return mgrDenied;
  const capped = await secLimit(env, 'gwcfg', clientId, secNum(env.GATEWAY_CONFIG_HOURLY_LIMIT, 60), 3600, 'payment-gateway changes');
  if (capped) return capped;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  // zip 210: Co-op's token / STK addresses come from the owner, so they must be plain public https addresses (never a local / private one)
  for (const k of ['coopTokenUrl', 'coopStkUrl']) {
    if (body && body[k]) {
      let u; try { u = new URL(String(body[k])); } catch (e) { return jsonResponse({ error: 'That address is not valid.' }, 400); }
      const h = u.hostname.toLowerCase();
      if (u.protocol !== 'https:' || !h.includes('.') || /^(localhost|.*\.local|.*\.internal)$/.test(h) || /^[\d.]+$/.test(h) || h.startsWith('[')) return jsonResponse({ error: 'Use the full https:// address of the bank (a website name, not an IP).' }, 400);
    }
  }
  await saveGatewayConfig(env, clientId, body);
  if (body && Object.keys(body).some((k) => /^pesapal/i.test(k))) { try { await ensureCallbackKey(env, clientId, 'pesapal'); } catch (e) { /* URL stays unsigned */ } }
  // zip 143: KCB settings saved -> this shop's IPN URL (shown in Settings, given to KCB) carries a secret key from now on
  if (body && Object.keys(body).some((k) => /^kcb/i.test(k))) { try { await ensureCallbackKey(env, clientId, 'kcb'); } catch (e) { /* URL stays unsigned */ } }
  return jsonResponse({ ok: true });
}

export async function onRequestDelete(context) {
  const { request, env } = context;

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const clientId = license.clientId;
  // PAIRED DEVICES ONLY when the shop has switched that on (see _device-auth.js); otherwise no change
  const deviceDenied = await deviceGuard(request, env, clientId, corsHeadersFor(request, env));
  if (deviceDenied) return deviceDenied;

  const mgrDenied = await managerGuard(request, env, clientId, {});   // zip 185: see POST above
  if (mgrDenied) return mgrDenied;
  const capped = await secLimit(env, 'gwcfg', clientId, secNum(env.GATEWAY_CONFIG_HOURLY_LIMIT, 60), 3600, 'payment-gateway changes');
  if (capped) return capped;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const which = ['paystack', 'daraja', 'kcb', 'paywave', 'pesapal', 'coop'].includes(body.which) ? body.which : null;
  if (!which) return jsonResponse({ error: 'Unknown provider.' }, 400);

  await clearGatewayProvider(env, clientId, which);
  return jsonResponse({ ok: true });
}
