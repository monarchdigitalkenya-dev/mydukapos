// functions/api/_gateway-config.js — shared helper, NOT a route.
//
// Cloudflare Pages Functions turns every .js file under functions/api into a
// route, EXCEPT files/folders whose name starts with "_" — those are treated
// as regular JS modules that other functions can import. This file is one of
// those: gateway-config.js, mpesa-stkpush.js, mpesa-status.js, and
// paystack-webhook.js all import it.
//
// Why this file exists:
// The Settings -> Payment Gateway panel in index.html lets the shop owner
// paste in their Paystack key, Daraja credentials, or KCB Buni credentials
// and click "Save" — that calls POST /api/gateway-config, which stores them
// here in mydukapos_kv. Without this file (and the accompanying
// gateway-config.js route), that Save button had nowhere to send the keys,
// so anything typed into Settings was silently lost and the app kept
// relying on Cloudflare Pages environment variables instead — which is why
// "adding the keys through Settings" didn't actually turn payments on.
//
// TENANT CREDENTIALS ONLY (zip 119). Payment credentials come from what THIS shop saved through Settings, and nothing else. Before,
// every field fell back to a Cloudflare environment variable of the same name — so a shop that had not saved its own keys took
// payments through whoever's keys were in the environment, and a shop that saved only SOME fields got them mixed with those. Now:
//   * credentials (keys, secrets, shortcodes, pass keys, API keys, the Paywave email) are the shop's own, one provider at a time,
//     as a complete set — never mixed with anything else;
//   * the environment set of a provider is used ONLY for a shop the owner lists by id in GATEWAY_ENV_FALLBACK_CLIENTS (comma-
//     separated; for a shop that genuinely runs on the platform's own account) and only when that shop saved nothing for it;
//   * non-secret defaults (sandbox/production, transaction type, the provider choice) may still come from the environment.

// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { openRecord, sealRecord } from './_secret-box.js';

const KV_KEY_PREFIX = 'gateway-config:v1:';
const aadOf = (clientId) => 'gateway|' + clientId;

// zip 247: the record is sealed (AES-GCM, key = the PAYMENT_SECRETS_KEY Cloudflare secret) whenever that secret is set; plain records are read as before
// and sealed the next time they are touched. `ok:false` = sealed but unreadable (key missing / rotated away): it must never be written over.
async function readStoredFull(env, clientId) {
  try {
    const raw = await env.mydukapos_kv.get(KV_KEY_PREFIX + clientId);
    const r = await openRecord(env, aadOf(clientId), raw);
    return { stored: r.ok ? r.value : {}, ok: r.ok, encrypted: r.encrypted, needsSeal: r.needsSeal };
  } catch (e) {
    return { stored: {}, ok: true, encrypted: false, needsSeal: false };
  }
}
async function readStored(env, clientId) { return (await readStoredFull(env, clientId)).stored; }
async function writeStored(env, clientId, obj) {
  await env.mydukapos_kv.put(KV_KEY_PREFIX + clientId, await sealRecord(env, aadOf(clientId), obj));
}

const PROVIDER_FIELDS = {
  paystack: { paystackSecretKey: 'PAYSTACK_SECRET_KEY' },
  daraja: { mpesaConsumerKey: 'MPESA_CONSUMER_KEY', mpesaConsumerSecret: 'MPESA_CONSUMER_SECRET', mpesaShortcode: 'MPESA_SHORTCODE', mpesaPasskey: 'MPESA_PASSKEY', mpesaPartyB: 'MPESA_PARTYB' },
  kcb: { kcbConsumerKey: 'KCB_CONSUMER_KEY', kcbConsumerSecret: 'KCB_CONSUMER_SECRET', kcbOrgShortCode: 'KCB_ORG_SHORT_CODE', kcbOrgPassKey: 'KCB_ORG_PASS_KEY' },
  paywave: { paywaveApiKey: 'PAYWAVE_API_KEY', paywaveEmail: 'PAYWAVE_EMAIL' },
  pesapal: { pesapalConsumerKey: 'PESAPAL_CONSUMER_KEY', pesapalConsumerSecret: 'PESAPAL_CONSUMER_SECRET' },
  coop: { coopConsumerKey: 'COOP_CONSUMER_KEY', coopConsumerSecret: 'COOP_CONSUMER_SECRET', coopTokenUrl: 'COOP_TOKEN_URL', coopStkUrl: 'COOP_STK_URL', coopShortcode: 'COOP_SHORTCODE', coopPasskey: 'COOP_PASSKEY' },
};

export function envFallbackAllowed(env, clientId) {
  const list = String((env && env.GATEWAY_ENV_FALLBACK_CLIENTS) || '').split(',').map((x) => x.trim()).filter(Boolean);
  return !!clientId && list.includes(String(clientId));
}

// One config object every other function reads fields off of — this shop's own credentials only (see above).
export async function loadGatewayConfig(env, clientId) {
  const full = await readStoredFull(env, clientId);
  let stored = full.stored;
  // zip 247: a held change (see saveGatewayConfig) whose waiting time is over takes effect here, the first time anything reads the settings
  if (full.ok && stored._pending && Number(stored._pending.effectiveAt) <= Date.now()) {
    stored = applyPending(stored);
    try { await writeStored(env, clientId, stored); } catch (e) { /* applied in memory; written next time */ }
  } else if (full.ok && full.needsSeal) {
    try { await writeStored(env, clientId, stored); } catch (e) { /* sealed next time */ }      // plain (or old-key) record -> sealed with the current key
  }
  const allowEnv = envFallbackAllowed(env, clientId);
  const creds = {};
  for (const fields of Object.values(PROVIDER_FIELDS)) {
    const own = Object.keys(fields).some((k) => stored[k]);
    Object.entries(fields).forEach(([k, envName]) => {
      creds[k] = own ? (stored[k] || '') : (allowEnv ? (env[envName] || '') : '');
    });
  }
  return {
    ...creds,
    secretsUnreadable: !full.ok,
    mpesaEnv: stored.mpesaEnv || env.MPESA_ENV || 'sandbox',
    mpesaTransactionType: stored.mpesaTransactionType || env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
    // KCB Buni — a second way to send the exact same kind of M-Pesa STK
    // Push prompt, through KCB's bank-direct API instead of Safaricom's own
    // Daraja. sharedShortCode defaults true, matching every example in
    // KCB's own docs — most integrators pay into KCB's shared paybill
    // (522522) with their own invoiceNumber/account ref telling them apart,
    // rather than having their own dedicated Till.
    kcbEnv: stored.kcbEnv || env.KCB_ENV || 'sandbox',
    kcbSharedShortCode: stored.kcbSharedShortCode !== undefined ? stored.kcbSharedShortCode : true,
    // Paywave Express — a hosted aggregator that wraps Daraja for you (see
    // paywavexpress.co.ke/documentation): an API key + the email on the account.
    // zip 210 — Pesapal (hosted checkout) and Co-operative Bank (M-Pesa STK through Co-op's own gateway)
    pesapalEnv: stored.pesapalEnv || env.PESAPAL_ENV || 'sandbox',
    coopTransactionType: stored.coopTransactionType || env.COOP_TRANSACTION_TYPE || 'CustomerPayBillOnline',
    forcedProvider: (stored.forcedProvider !== undefined ? stored.forcedProvider : (env.PAYMENT_PROVIDER || '')).toLowerCase(),
  };
}

const FIELD_PROVIDER = {};
Object.entries(PROVIDER_FIELDS).forEach(([prov, f]) => Object.keys(f).forEach((k) => { FIELD_PROVIDER[k] = prov; }));
export const providerOfField = (k) => FIELD_PROVIDER[k] || null;

// A held change whose time has come: its fields become the saved values.
export function applyPending(stored) {
  const out = { ...stored };
  const p = out._pending;
  delete out._pending;
  if (p && p.fields && typeof p.fields === 'object') Object.keys(p.fields).forEach((k) => { if (FIELD_PROVIDER[k] && p.fields[k]) out[k] = p.fields[k]; });
  return out;
}

// What is waiting (never the values): { effectiveAt, providers } or null.
export async function getPendingChange(env, clientId) {
  const { stored, ok } = await readStoredFull(env, clientId);
  const p = ok ? stored._pending : null;
  if (!p || !p.fields || !Object.keys(p.fields).length) return null;
  return { effectiveAt: Number(p.effectiveAt) || 0, providers: Array.isArray(p.providers) ? p.providers : [], at: Number(p.at) || 0, fieldNames: Object.keys(p.fields) };
}

export async function cancelPendingChange(env, clientId) {
  const { stored, ok } = await readStoredFull(env, clientId);
  if (!ok) { const e = new Error('secrets_unreadable'); e.code = 'secrets_unreadable'; throw e; }
  if (!stored._pending) return false;
  const merged = { ...stored };
  delete merged._pending;
  await writeStored(env, clientId, merged);
  return true;
}

// Saves only the fields present in `updates`, merged field-by-field into whatever's already stored for this client — never wipes fields the
// caller didn't send.
//
// zip 247 — A CHANGED KEY IS HELD. Replacing a credential a provider ALREADY has (the destination of the shop's money) does not take effect at
// once: it waits `opts.cooldownMs` (default in gateway-config.js: 60 minutes), during which the old keys keep working, the owner is told, and the
// change can be cancelled. First-time setup of a provider, filling a blank field, and non-credential settings (sandbox/production, the provider
// choice, transaction type) apply immediately.
//
// zip 249 — THE HOLD ONLY GUARDS KEYS THAT CAN MOVE REAL MONEY. Daraja keys saved while the environment was SANDBOX carry no money, so replacing them
// (the normal step of pasting the production keys) applies at once. `mpesaKeysEnv` remembers which environment the saved Daraja keys were saved
// under; once they were saved as production keys, replacing them is held exactly as before.
// -> { immediate: [providers/settings changed now], held: { providers, effectiveAt } | null }
export async function saveGatewayConfig(env, clientId, updates, opts = {}) {
  const full = await readStoredFull(env, clientId);
  if (!full.ok) { const e = new Error('secrets_unreadable'); e.code = 'secrets_unreadable'; throw e; }
  const stored = full.stored;
  const merged = { ...stored };
  const now = Date.now();
  const cooldownMs = Math.max(0, Number(opts.cooldownMs) || 0);
  const immediate = new Set();
  const heldProviders = new Set();
  const held = (stored._pending && stored._pending.fields && typeof stored._pending.fields === 'object') ? { ...stored._pending.fields } : {};
  const priorHeldProviders = (stored._pending && Array.isArray(stored._pending.providers)) ? stored._pending.providers : [];

  if (updates.provider !== undefined && merged.forcedProvider !== updates.provider) { merged.forcedProvider = updates.provider; immediate.add('provider'); }
  if (updates.kcbSharedShortCode !== undefined && merged.kcbSharedShortCode !== !!updates.kcbSharedShortCode) { merged.kcbSharedShortCode = !!updates.kcbSharedShortCode; immediate.add('kcbSharedShortCode'); }

  const fields = [
    'paystackSecretKey',
    'mpesaEnv',
    'mpesaConsumerKey',
    'mpesaConsumerSecret',
    'mpesaShortcode',
    'mpesaPasskey',
    'mpesaPartyB',
    'mpesaTransactionType',
    'kcbEnv',
    'kcbConsumerKey',
    'kcbConsumerSecret',
    'kcbOrgShortCode',
    'kcbOrgPassKey',
    'paywaveApiKey',
    'paywaveEmail',
    'pesapalEnv', 'pesapalConsumerKey', 'pesapalConsumerSecret',
    'coopConsumerKey', 'coopConsumerSecret', 'coopTokenUrl', 'coopStkUrl', 'coopShortcode', 'coopPasskey', 'coopTransactionType',
  ];
  // zip 249: were the saved Daraja keys saved as PRODUCTION keys? (older records have no mpesaKeysEnv: the saved environment says)
  const darajaKeysLive = String(stored.mpesaKeysEnv || stored.mpesaEnv || (env && env.MPESA_ENV) || 'sandbox').toLowerCase() === 'production';
  let darajaCoreSaved = false;                             // a key / secret / shortcode / passkey was saved now (a Till number alone does not change what the keys are)
  fields.forEach((key) => {
    const v = updates[key];
    if (v === undefined || v === '') return;
    const prov = FIELD_PROVIDER[key];
    if (!prov) {                                            // sandbox/production, transaction type: not a destination
      if (merged[key] !== v) { merged[key] = v; immediate.add(key); }
      return;
    }
    if (stored[key] === v) { delete held[key]; return; }    // the value that is already saved: nothing changes (and a held replacement of it is dropped)
    const replacing = !!stored[key] && (prov !== 'daraja' || darajaKeysLive);   // a value is already there -> this would move the money (sandbox Daraja keys move none)
    if (replacing && cooldownMs > 0) { held[key] = v; heldProviders.add(prov); }
    else { merged[key] = v; delete held[key]; immediate.add(prov); if (prov === 'daraja' && key !== 'mpesaPartyB') darajaCoreSaved = true; }
  });

  if (darajaCoreSaved) merged.mpesaKeysEnv = String(merged.mpesaEnv || (env && env.MPESA_ENV) || 'sandbox').toLowerCase();

  if (Object.keys(held).length) {
    const providers = Array.from(new Set([...priorHeldProviders, ...heldProviders]));
    merged._pending = { at: now, effectiveAt: now + cooldownMs, fields: held, providers, by: String(opts.who || '').slice(0, 60) };
  } else {
    delete merged._pending;
  }

  await writeStored(env, clientId, merged);
  return {
    immediate: Array.from(immediate),
    held: merged._pending ? { providers: merged._pending.providers, effectiveAt: merged._pending.effectiveAt } : null,
  };
}

// Used by the Settings panel's "Reset" button for one provider — clears just
// that provider's fields (and, if it was the forced choice, the force too)
// without touching the other providers' saved config.
export async function clearGatewayProvider(env, clientId, which) {
  const full = await readStoredFull(env, clientId);
  if (!full.ok) { const e = new Error('secrets_unreadable'); e.code = 'secrets_unreadable'; throw e; }
  const merged = { ...full.stored };

  const fieldsByProvider = {
    paystack: ['paystackSecretKey'],
    daraja: ['mpesaConsumerKey', 'mpesaConsumerSecret', 'mpesaShortcode', 'mpesaPasskey', 'mpesaPartyB', 'mpesaKeysEnv'],
    kcb: ['kcbConsumerKey', 'kcbConsumerSecret', 'kcbOrgShortCode', 'kcbOrgPassKey'],
    paywave: ['paywaveApiKey', 'paywaveEmail'],
    pesapal: ['pesapalConsumerKey', 'pesapalConsumerSecret'],
    coop: ['coopConsumerKey', 'coopConsumerSecret', 'coopTokenUrl', 'coopStkUrl', 'coopShortcode', 'coopPasskey'],
  };
  const fields = fieldsByProvider[which] || [];
  fields.forEach((key) => { delete merged[key]; });
  if (merged.forcedProvider === which) delete merged.forcedProvider;
  if (merged._pending && merged._pending.fields) {                      // a held change for this provider goes with it
    const keep = {};
    Object.keys(merged._pending.fields).forEach((k) => { if (!fields.includes(k)) keep[k] = merged._pending.fields[k]; });
    if (Object.keys(keep).length) merged._pending = { ...merged._pending, fields: keep, providers: (merged._pending.providers || []).filter((x) => x !== which) };
    else delete merged._pending;
  }

  await writeStored(env, clientId, merged);
  return merged;
}

export function hasDarajaConfig(cfg) {
  return !!(cfg.mpesaConsumerKey && cfg.mpesaConsumerSecret && cfg.mpesaShortcode && cfg.mpesaPasskey);
}

export function hasPaystackConfig(cfg) {
  return !!cfg.paystackSecretKey;
}

export function hasKcbConfig(cfg) {
  return !!(cfg.kcbConsumerKey && cfg.kcbConsumerSecret);
}

export function hasPaywaveConfig(cfg) {
  return !!(cfg.paywaveApiKey && cfg.paywaveEmail);
}

export function hasPesapalConfig(cfg) {
  return !!(cfg.pesapalConsumerKey && cfg.pesapalConsumerSecret);
}

// Co-op Bank's gateway details (token + STK addresses, shortcode) come from the shop's own Co-op API portal; nothing is guessed.
export function hasCoopConfig(cfg) {
  return !!(cfg.coopConsumerKey && cfg.coopConsumerSecret && /^https:\/\//i.test(cfg.coopTokenUrl || '') && /^https:\/\//i.test(cfg.coopStkUrl || '') && cfg.coopShortcode);
}

// An explicit forcedProvider wins (if that provider is actually configured);
// otherwise Paystack is preferred if more than one happens to be configured.
export function resolveProvider(cfg) {
  const forced = (cfg.forcedProvider || '').trim().toLowerCase();
  if (forced === 'paystack' && hasPaystackConfig(cfg)) return 'paystack';
  if (forced === 'daraja' && hasDarajaConfig(cfg)) return 'daraja';
  if (forced === 'kcb' && hasKcbConfig(cfg)) return 'kcb';
  if (forced === 'paywave' && hasPaywaveConfig(cfg)) return 'paywave';
  if (forced === 'pesapal' && hasPesapalConfig(cfg)) return 'pesapal';
  if (forced === 'coop' && hasCoopConfig(cfg)) return 'coop';
  if (hasPaystackConfig(cfg)) return 'paystack';
  if (hasDarajaConfig(cfg)) return 'daraja';
  if (hasKcbConfig(cfg)) return 'kcb';
  if (hasPaywaveConfig(cfg)) return 'paywave';
  if (hasCoopConfig(cfg)) return 'coop';
  if (hasPesapalConfig(cfg)) return 'pesapal';
  return null;
}
