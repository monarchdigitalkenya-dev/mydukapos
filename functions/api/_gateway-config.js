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

const KV_KEY_PREFIX = 'gateway-config:v1:';

async function readStored(env, clientId) {
  try {
    const raw = await env.mydukapos_kv.get(KV_KEY_PREFIX + clientId);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

const PROVIDER_FIELDS = {
  paystack: { paystackSecretKey: 'PAYSTACK_SECRET_KEY' },
  daraja: { mpesaConsumerKey: 'MPESA_CONSUMER_KEY', mpesaConsumerSecret: 'MPESA_CONSUMER_SECRET', mpesaShortcode: 'MPESA_SHORTCODE', mpesaPasskey: 'MPESA_PASSKEY' },
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
  const stored = await readStored(env, clientId);
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

// Saves only the fields present in `updates`, merged field-by-field into
// whatever's already stored for this client — never wipes fields the caller
// didn't send.
export async function saveGatewayConfig(env, clientId, updates) {
  const stored = await readStored(env, clientId);
  const merged = { ...stored };

  if (updates.provider !== undefined) merged.forcedProvider = updates.provider;
  if (updates.kcbSharedShortCode !== undefined) merged.kcbSharedShortCode = !!updates.kcbSharedShortCode;

  const fields = [
    'paystackSecretKey',
    'mpesaEnv',
    'mpesaConsumerKey',
    'mpesaConsumerSecret',
    'mpesaShortcode',
    'mpesaPasskey',
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
  fields.forEach((key) => {
    if (updates[key] !== undefined && updates[key] !== '') merged[key] = updates[key];
  });

  await env.mydukapos_kv.put(KV_KEY_PREFIX + clientId, JSON.stringify(merged));
  return merged;
}

// Used by the Settings panel's "Reset" button for one provider — clears just
// that provider's fields (and, if it was the forced choice, the force too)
// without touching the other providers' saved config.
export async function clearGatewayProvider(env, clientId, which) {
  const stored = await readStored(env, clientId);
  const merged = { ...stored };

  const fieldsByProvider = {
    paystack: ['paystackSecretKey'],
    daraja: ['mpesaConsumerKey', 'mpesaConsumerSecret', 'mpesaShortcode', 'mpesaPasskey'],
    kcb: ['kcbConsumerKey', 'kcbConsumerSecret', 'kcbOrgShortCode', 'kcbOrgPassKey'],
    paywave: ['paywaveApiKey', 'paywaveEmail'],
    pesapal: ['pesapalConsumerKey', 'pesapalConsumerSecret'],
    coop: ['coopConsumerKey', 'coopConsumerSecret', 'coopTokenUrl', 'coopStkUrl', 'coopShortcode', 'coopPasskey'],
  };
  const fields = fieldsByProvider[which] || [];
  fields.forEach((key) => { delete merged[key]; });
  if (merged.forcedProvider === which) delete merged.forcedProvider;

  await env.mydukapos_kv.put(KV_KEY_PREFIX + clientId, JSON.stringify(merged));
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
