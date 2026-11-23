// functions/api/sms-config.js — Cloudflare Pages Function
//
// Saves/reports each shop's OWN SMS gateway account. Every client picks
// ONE provider, pays for, and sends their own bulk SMS through their own
// account there — same pattern as the payment gateway keys and the
// Pixabay key: nothing is ever shared or baked into this codebase.
//
// Supported providers (see sms-send.js for the actual send logic):
//   'africastalking' — username + API key
//   'mobitech'        — API key + Sender Name
//   'celcom'          — API key + Partner ID + Shortcode (Celcom Africa)
//   'advanta'         — API key + Partner ID + Shortcode (Advanta SMS —
//                        same underlying gateway platform as Celcom, just
//                        a different reseller/domain)
//   'talksasa'        — API key + Sender ID (TalkSasa REST v3)
//   'onfon'           — Access Key + API Key + Client ID + Sender ID (Onfon Media REST, zip 327; see _onfon.js)
//
// Existing shops saved before `provider` existed have no value here,
// which is treated as 'africastalking' everywhere it's read (see
// sms-send.js) — the only provider that ever existed until now, so
// nobody needs to re-save.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense } from './_license.js';
import { deviceGuard } from './_device-auth.js';
import { corsHeadersFor } from './_cors.js';
import { readSmsConfigFull, writeSmsConfig } from './_sms-store.js';
import { managerGuard, secLimit, secNum } from './_sec-guard.js';
import { requirePayProof } from './_pay-guard.js';
import { notifyPayChange } from './_pay-alert.js';

// zip 247 — CHANGING THE SMS ACCOUNT (its keys) needs the same typed Admin password / manager PIN as the payment keys (X-Pay-Proof, checked on the
// server) and tells the owner; templates and the thank-you switch stay as free as before. A shop that requires staff sessions also needs a manager
// session. The CORS answer is the shop's own origin only (the apps call the API on their own origin, so nothing else ever needed `*`).
const SMS_CREDENTIAL_FIELDS = ['onfonAccessKey', 'onfonApiKey', 'onfonClientId', 'onfonSenderId', 'atUsername', 'atApiKey', 'mobitechApiKey', 'mobitechSenderName', 'celcomApiKey', 'celcomPartnerId', 'celcomShortcode', 'advantaApiKey', 'advantaPartnerId', 'advantaShortcode', 'talksasaApiKey', 'talksasaSenderId'];
const CORS_OPTS = { methods: 'GET, POST, OPTIONS', headers: 'Content-Type, X-Device-Id, X-Device-Token, X-Staff-Token, X-Pay-Proof' };

const VALID_PROVIDERS = ['africastalking', 'mobitech', 'celcom', 'advanta', 'talksasa', 'onfon'];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, CORS_OPTS) });
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

  const full = await readSmsConfigFull(env, clientId);
  if (!full.ok) return jsonResponse({ error: 'The saved SMS account cannot be read right now — contact support.', code: 'secrets_unreadable' }, 503);
  const config = full.config;

  const provider = VALID_PROVIDERS.includes(config.provider) ? config.provider : 'africastalking';

  const configuredByProvider = {
    africastalking: !!(config.atUsername && config.atApiKey),
    mobitech: !!(config.mobitechApiKey && config.mobitechSenderName),
    celcom: !!(config.celcomApiKey && config.celcomPartnerId && config.celcomShortcode),
    advanta: !!(config.advantaApiKey && config.advantaPartnerId && config.advantaShortcode),
    talksasa: !!(config.talksasaApiKey && config.talksasaSenderId),
    onfon: !!(config.onfonAccessKey && config.onfonApiKey && config.onfonClientId && config.onfonSenderId),
  };
  const configured = configuredByProvider[provider];

  // The account label shown in Settings so the shop can confirm which
  // account is active without ever seeing the secret key itself back.
  const usernameByProvider = {
    africastalking: config.atUsername || null,
    mobitech: config.mobitechSenderName || null,
    celcom: config.celcomShortcode || null,
    advanta: config.advantaShortcode || null,
    talksasa: config.talksasaSenderId || null,
    onfon: config.onfonSenderId || null,
  };

  return jsonResponse({
    configured,
    provider,
    username: usernameByProvider[provider],
    senderName: config.mobitechSenderName || null,
    // zip 327: Onfon - which parts are saved, never the secrets themselves (the Client ID and Sender ID are identifiers, not secrets)
    onfon: { hasAccessKey: !!config.onfonAccessKey, hasApiKey: !!config.onfonApiKey, clientId: config.onfonClientId || '', senderId: config.onfonSenderId || '', enabled: config.onfonEnabled !== false },
    autoThankYouEnabled: !!config.autoThankYouEnabled,
    thankYouTemplate: config.thankYouTemplate || null,
    hireConfirmationTemplate: config.hireConfirmationTemplate || null,
    clientId,
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
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'Invalid request body.' }, 400);

  const full = await readSmsConfigFull(env, clientId);
  if (!full.ok) return jsonResponse({ error: 'The saved SMS account cannot be opened, so nothing was changed — contact support.', code: 'secrets_unreadable' }, 503);
  const existing = full.config;

  // zip 247: does this save change the ACCOUNT (keys / sender / provider)? Only then is the typed proof needed.
  const credChanged = SMS_CREDENTIAL_FIELDS.some((k) => k in body && String(typeof body[k] === 'string' ? body[k].trim() : '') !== String(existing[k] || ''))
    || (VALID_PROVIDERS.includes(body.provider) && body.provider !== (existing.provider || 'africastalking'));
  let proof = null;
  if (credChanged) {
    const mgrDenied = await managerGuard(request, env, clientId, {});
    if (mgrDenied) return mgrDenied;
    const capped = await secLimit(env, 'smscfg', clientId, secNum(env.SMS_CONFIG_HOURLY_LIMIT, 30), 3600, 'SMS account changes');
    if (capped) return capped;
    proof = await requirePayProof(request, env, clientId, {});
    if (proof.denied) return proof.denied;
  }

  // A blank field for the active provider clears its credentials (the
  // "reset"/"turn off" path) without needing a separate DELETE handler —
  // same convention as the Pixabay config endpoint.
  const provider = VALID_PROVIDERS.includes(body.provider) ? body.provider : (existing.provider || 'africastalking');
  const str = (v, fallback) => (typeof v === 'string' ? v.trim() : fallback);

  const atUsername = str(body.atUsername, existing.atUsername);
  const atApiKey = str(body.atApiKey, existing.atApiKey);
  const mobitechApiKey = str(body.mobitechApiKey, existing.mobitechApiKey);
  const mobitechSenderName = str(body.mobitechSenderName, existing.mobitechSenderName);
  const celcomApiKey = str(body.celcomApiKey, existing.celcomApiKey);
  const celcomPartnerId = str(body.celcomPartnerId, existing.celcomPartnerId);
  const celcomShortcode = str(body.celcomShortcode, existing.celcomShortcode);
  const advantaApiKey = str(body.advantaApiKey, existing.advantaApiKey);
  const advantaPartnerId = str(body.advantaPartnerId, existing.advantaPartnerId);
  const advantaShortcode = str(body.advantaShortcode, existing.advantaShortcode);
  const talksasaApiKey = str(body.talksasaApiKey, existing.talksasaApiKey);
  const talksasaSenderId = str(body.talksasaSenderId, existing.talksasaSenderId);
  const onfonAccessKey = str(body.onfonAccessKey, existing.onfonAccessKey);
  const onfonApiKey = str(body.onfonApiKey, existing.onfonApiKey);
  const onfonClientId = str(body.onfonClientId, existing.onfonClientId);
  const onfonSenderId = str(body.onfonSenderId, existing.onfonSenderId);
  const onfonEnabled = typeof body.onfonEnabled === 'boolean' ? body.onfonEnabled : existing.onfonEnabled !== false;
  const autoThankYouEnabled = typeof body.autoThankYouEnabled === 'boolean' ? body.autoThankYouEnabled : !!existing.autoThankYouEnabled;
  const thankYouTemplate = str(body.thankYouTemplate, existing.thankYouTemplate);
  const hireConfirmationTemplate = str(body.hireConfirmationTemplate, existing.hireConfirmationTemplate);

  const updated = {
    provider,
    atUsername: atUsername || '',
    atApiKey: atApiKey || '',
    mobitechApiKey: mobitechApiKey || '',
    mobitechSenderName: mobitechSenderName || '',
    celcomApiKey: celcomApiKey || '',
    celcomPartnerId: celcomPartnerId || '',
    celcomShortcode: celcomShortcode || '',
    advantaApiKey: advantaApiKey || '',
    advantaPartnerId: advantaPartnerId || '',
    advantaShortcode: advantaShortcode || '',
    talksasaApiKey: talksasaApiKey || '',
    talksasaSenderId: talksasaSenderId || '',
    onfonAccessKey: onfonAccessKey || '',
    onfonApiKey: onfonApiKey || '',
    onfonClientId: onfonClientId || '',
    onfonSenderId: onfonSenderId || '',
    onfonEnabled,
    autoThankYouEnabled,
    thankYouTemplate: thankYouTemplate || '',
    hireConfirmationTemplate: hireConfirmationTemplate || '',
  };
  await writeSmsConfig(env, clientId, updated);

  let alerted = null;
  if (credChanged) {
    const p = notifyPayChange(env, clientId, { kind: 'sms', providers: ['sms'], who: proof.who, smsConfig: existing }, request).catch(() => ({ alerted: false }));
    try { if (context.waitUntil) context.waitUntil(p); } catch (e) { /* none */ }
    alerted = (await Promise.race([p, new Promise((r) => setTimeout(() => r({ alerted: null }), 5000))])).alerted;
  }
  return jsonResponse({ success: true, alerted });
}
