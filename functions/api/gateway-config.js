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

import { loadGatewayConfig, saveGatewayConfig, clearGatewayProvider, hasPaystackConfig, hasDarajaConfig, hasKcbConfig, hasPaywaveConfig } from './_gateway-config.js';
import { requireValidLicense } from './_license.js';
import { deviceGuard } from './_device-auth.js';
import { corsHeadersFor } from './_cors.js';
import { getCallbackKey, ensureCallbackKey, withKey } from './_callback-key.js';

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

  return jsonResponse({
    hasPaystackKey: hasPaystackConfig(cfg),
    hasDarajaConfig: hasDarajaConfig(cfg),
    hasKcbConfig: hasKcbConfig(cfg),
    hasPaywaveConfig: hasPaywaveConfig(cfg),
    mpesaEnv: cfg.mpesaEnv,
    kcbEnv: cfg.kcbEnv,
    kcbSharedShortCode: cfg.kcbSharedShortCode,
    paywaveEmail: cfg.paywaveEmail,
    forcedProvider: cfg.forcedProvider || '',
    paystackWebhookUrl: `${origin}/api/paystack-webhook?c=${encodeURIComponent(clientId)}`,
    mpesaCallbackUrl: `${origin}/api/mpesa-callback?c=${encodeURIComponent(clientId)}`,
    paywaveWebhookUrl: `${origin}/api/paywave-webhook?c=${encodeURIComponent(clientId)}`,
    kcbIpnUrl: withKey(`${origin}/api/kcb-ipn?c=${encodeURIComponent(clientId)}`, await getCallbackKey(env, clientId, 'kcb')),
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

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  await saveGatewayConfig(env, clientId, body);
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

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const which = ['paystack', 'daraja', 'kcb', 'paywave'].includes(body.which) ? body.which : null;
  if (!which) return jsonResponse({ error: 'Unknown provider.' }, 400);

  await clearGatewayProvider(env, clientId, which);
  return jsonResponse({ ok: true });
}
