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
// zip 247 — CHANGING PAYMENT SETTINGS NEEDS A TYPED PROOF, EVERY TIME (POST and DELETE): the Admin / management password or a manager's PIN, sent in
// the X-Pay-Proof header and checked on the server (_pay-guard.js) — a shop's link alone can no longer redirect its money. Replacing a key the shop
// ALREADY has is also HELD for PAYMENT_CHANGE_COOLDOWN_MIN minutes (default 60; the old keys keep working meanwhile): the owner is told by SMS /
// WhatsApp / email (_pay-alert.js) and the change can be cancelled (DELETE { cancelPending: true }). First-time setup applies at once. zip 249: so does
// replacing Daraja keys that were saved under SANDBOX (no money moves through them) — pasting the production keys is never held; only replacing
// keys that were already saved as production keys is. Saved keys are
// kept encrypted (_secret-box.js) when the PAYMENT_SECRETS_KEY secret is set.
//
// Blocked with 403 if this link's license isn't currently valid.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { loadGatewayConfig, saveGatewayConfig, clearGatewayProvider, getPendingChange, cancelPendingChange, hasPaystackConfig, hasDarajaConfig, hasKcbConfig, hasPaywaveConfig, hasPesapalConfig, hasCoopConfig } from './_gateway-config.js';
import { requireValidLicense } from './_license.js';
import { deviceGuard } from './_device-auth.js';
import { corsHeadersFor } from './_cors.js';
import { getCallbackKey, ensureCallbackKey, ensureShopCallbackKeysGrace, withKey } from './_callback-key.js';
import { managerGuard, secLimit, secNum } from './_sec-guard.js';
import { readMode, verifyToken, staffTokenOf } from './_staff-auth.js';
import { requirePayProof } from './_pay-guard.js';
import { notifyPayChange, recentPayChanges, alertable } from './_pay-alert.js';

// zip 247: a shop that has no payment-callback keys yet is given them the first time its Settings > Payment Gateway opens (see _callback-key.js)
const keysEnsured = new Set();
const cooldownMinutes = (env) => { const m = Number(env && env.PAYMENT_CHANGE_COOLDOWN_MIN); return Number.isFinite(m) && m >= 0 ? m : 60; };
// the alert may take a few seconds (SMS / email providers): the save does not wait longer than that, and the alert still finishes in the background
async function alertWithin(context, clientId, ev, ms = 5000) {
  const p = notifyPayChange(context.env, clientId, ev, context.request).catch(() => ({ alerted: false }));
  try { if (context.waitUntil) context.waitUntil(p); } catch (e) { /* none */ }
  return Promise.race([p, new Promise((r) => setTimeout(() => r({ alerted: null }), ms))]);
}

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

  if (!keysEnsured.has(clientId)) { try { await ensureShopCallbackKeysGrace(env, clientId); keysEnsured.add(clientId); } catch (e) { /* tried again next time */ } }
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

  if (cfg.secretsUnreadable) return jsonResponse({ error: 'The saved payment keys cannot be read right now — contact support.', code: 'secrets_unreadable' }, 503);
  return jsonResponse({
    pendingChange: await getPendingChange(env, clientId),          // zip 247: { effectiveAt, providers } for a held change (never the values)
    recentChanges: await recentPayChanges(env, clientId, 5),
    changeHoldMinutes: cooldownMinutes(env),
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
    mpesaTransactionType: cfg.mpesaTransactionType,         // zip 249: pre-fills the Paybill / Till choice
    mpesaPartyB: cfg.mpesaPartyB || '',                      // zip 249: the Till number (public, printed on receipts) — never a secret
    kcbEnv: cfg.kcbEnv,
    kcbSharedShortCode: cfg.kcbSharedShortCode,
    paywaveEmail: cfg.paywaveEmail,
    forcedProvider: cfg.forcedProvider || '',
    mpesaCallbackUrl: `${origin}/api/pay-cb-stk?c=${encodeURIComponent(clientId)}`,   // zip 250: no "mpesa" in the address (Safaricom production drops those)
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
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'Invalid JSON body' }, 400);

  // zip 262: Paystack is retired - a new Paystack key is refused (an old one can still be removed with DELETE which:'paystack'); forcing it is refused too
  if (body.paystackSecretKey !== undefined || String(body.provider || '').toLowerCase() === 'paystack') return jsonResponse({ error: 'Paystack is no longer supported. Use Daraja, KCB Buni, Paywave Express, Pesapal or Co-op Bank.', code: 'paystack_retired' }, 410);
  // zip 249: a Till number is digits only
  if (body && body.mpesaPartyB !== undefined && body.mpesaPartyB !== '' && !/^\d{4,10}$/.test(String(body.mpesaPartyB).trim())) return jsonResponse({ error: 'The Till number must be digits only (4 to 10 digits).' }, 400);
  if (body && typeof body.mpesaPartyB === 'string') body.mpesaPartyB = body.mpesaPartyB.trim();
  // zip 210: Co-op's token / STK addresses come from the owner, so they must be plain public https addresses (never a local / private one)
  for (const k of ['coopTokenUrl', 'coopStkUrl']) {
    if (body && body[k]) {
      let u; try { u = new URL(String(body[k])); } catch (e) { return jsonResponse({ error: 'That address is not valid.' }, 400); }
      const h = u.hostname.toLowerCase();
      if (u.protocol !== 'https:' || !h.includes('.') || /^(localhost|.*\.local|.*\.internal)$/.test(h) || /^[\d.]+$/.test(h) || h.startsWith('[')) return jsonResponse({ error: 'Use the full https:// address of the bank (a website name, not an IP).' }, 400);
    }
  }
  // zip 247: the typed Admin password / manager PIN — every change, every time (see _pay-guard.js)
  const proof = await requirePayProof(request, env, clientId, {});
  if (proof.denied) return proof.denied;

  let result;
  try {
    result = await saveGatewayConfig(env, clientId, body, { cooldownMs: cooldownMinutes(env) * 60000, who: proof.who.name });
  } catch (e) {
    if (e && e.code === 'secrets_unreadable') return jsonResponse({ error: 'The saved payment keys cannot be opened right now, so nothing was changed — contact support.', code: 'secrets_unreadable' }, 503);
    throw e;
  }
  if (body && Object.keys(body).some((k) => /^pesapal/i.test(k))) { try { await ensureCallbackKey(env, clientId, 'pesapal'); } catch (e) { /* URL stays unsigned */ } }
  // zip 143: KCB settings saved -> this shop's IPN URL (shown in Settings, given to KCB) carries a secret key from now on
  if (body && Object.keys(body).some((k) => /^kcb/i.test(k))) { try { await ensureCallbackKey(env, clientId, 'kcb'); } catch (e) { /* URL stays unsigned */ } }

  // zip 247: tell the owner (what changed, never the values)
  const now = result.immediate.filter(alertable);
  let alerted = null;
  if (result.held) alerted = (await alertWithin(context, clientId, { kind: 'held', providers: result.held.providers, who: proof.who, effectiveAt: result.held.effectiveAt })).alerted;
  else if (now.length) alerted = (await alertWithin(context, clientId, { kind: 'changed', providers: now, who: proof.who })).alerted;
  return jsonResponse({ ok: true, held: result.held, alerted, confirmedBy: proof.who.name });
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

  const proof = await requirePayProof(request, env, clientId, {});     // zip 247: typed Admin password / manager PIN, every time
  if (proof.denied) return proof.denied;

  // zip 247: cancel a held change before it starts
  if (body && body.cancelPending === true) {
    let had = false;
    try { had = await cancelPendingChange(env, clientId); } catch (e) { return jsonResponse({ error: 'The saved payment keys cannot be opened right now — contact support.', code: 'secrets_unreadable' }, 503); }
    if (had) await alertWithin(context, clientId, { kind: 'cancelled', providers: [], who: proof.who });
    return jsonResponse({ ok: true, cancelled: had });
  }

  const which = ['paystack', 'daraja', 'kcb', 'paywave', 'pesapal', 'coop'].includes(body && body.which) ? body.which : null;
  if (!which) return jsonResponse({ error: 'Unknown provider.' }, 400);

  try { await clearGatewayProvider(env, clientId, which); } catch (e) {
    if (e && e.code === 'secrets_unreadable') return jsonResponse({ error: 'The saved payment keys cannot be opened right now, so nothing was changed — contact support.', code: 'secrets_unreadable' }, 503);
    throw e;
  }
  const alerted = (await alertWithin(context, clientId, { kind: 'reset', providers: [which], who: proof.who })).alerted;
  return jsonResponse({ ok: true, alerted });
}
