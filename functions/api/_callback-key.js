// functions/api/_callback-key.js — signed payment-callback URLs (zip 143).
//
// Safaricom (STK results, C2B confirmations) and KCB (IPN) do not sign what they send: the only thing that said "this is shop X's
// payment" was ?c=<shop id> in the URL — and a shop's id is visible to anyone who opens its link. A forged confirmation could therefore
// make a made-up M-Pesa code pass /api/mpesa-verify ("verified") and be used to record a fake M-Pesa sale.
//
// Each shop now gets a random key per payment rail (kept in KV, never sent to the apps). The URLs given to Safaricom / KCB carry it
// (&k=...), and a callback is trusted only when the key matches.
//
// BACKWARD COMPATIBLE: a shop that has no key for a rail yet (URLs registered before this release) works exactly as before ("legacy").
// The key is created the moment new URLs are handed out: every STK prompt (the URL is sent with each prompt), "Register Till URLs"
// (C2B), and saving KCB settings. From then on an unsigned callback for that rail is not trusted.
import { getLicenseCached } from './_license.js';
import { checkRateLimit } from './_ratelimit.js';
import { secEvent } from './_sec-events.js';

const KEY = (rail, clientId) => `callback-key:${rail}:${clientId}`;

// zip 247 — THE END OF "LEGACY". A shop whose payment URLs were registered before callback keys existed has no key, and its unsigned callbacks have been
// believed ever since (so far as a real pending prompt exists, or — for Till / KCB — as an unverified record). That grace now has an end date:
//   * every shop is given a key for each money rail (ensureShopCallbackKeysGrace — run for all shops from the Owner Console, owner-secrets.js, and
//     for a single shop whenever its Settings > Payment Gateway opens). A key created this way is marked `grace`: until the cutoff, an unsigned
//     callback is STILL accepted for it (the URL registered with Safaricom / KCB / Paywave has no key yet and must keep working).
//   * the first callback that DOES carry the key proves the provider now uses the new URL, so the grace ends for that rail on the spot.
//   * from the cutoff, an unsigned callback is refused for every money rail, keyed or not.
// CALLBACK_LEGACY_CUTOFF (any date string, e.g. 2026-12-01T00:00:00Z) moves the date; the default gives the shops time to register the new URLs.
// The 'sms' rail (STOP / START replies) is exempt: its worst case is one number unsubscribed, and a shop must never lose a real STOP.
export const DEFAULT_LEGACY_CUTOFF = '2026-12-01T00:00:00Z';
export const MONEY_RAILS = ['stk', 'c2b', 'kcb', 'paywave', 'pesapal'];
export function legacyCutoffMs(env) {
  const t = Date.parse(String((env && env.CALLBACK_LEGACY_CUTOFF) || DEFAULT_LEGACY_CUTOFF));
  return Number.isFinite(t) ? t : Date.parse(DEFAULT_LEGACY_CUTOFF);
}
export const legacyStillAllowed = (env, rail, now = Date.now()) => rail === 'sms' || now < legacyCutoffMs(env);

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function getCallbackKey(env, clientId, rail) {
  try {
    const raw = await env.mydukapos_kv.get(KEY(rail, clientId));
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && o.k ? o : null;
  } catch (e) { return null; }
}

export async function ensureCallbackKey(env, clientId, rail, { grace = false } = {}) {
  const have = await getCallbackKey(env, clientId, rail);
  if (have) return have;
  const rec = { k: randomHex(16), createdAt: Date.now(), ...(grace ? { grace: true } : {}) };
  await env.mydukapos_kv.put(KEY(rail, clientId), JSON.stringify(rec));
  return rec;
}

// zip 247: gives a keyless shop a key on every money rail, marked `grace` (see above) so what is registered today keeps working until the cutoff.
// -> the rails that were created now.
export async function ensureShopCallbackKeysGrace(env, clientId) {
  const made = [];
  for (const rail of MONEY_RAILS) {
    try {
      if (await getCallbackKey(env, clientId, rail)) continue;
      await ensureCallbackKey(env, clientId, rail, { grace: true });
      made.push(rail);
    } catch (e) { /* stays legacy; tried again next time */ }
  }
  return made;
}

// A callback arrived WITH the key: the provider is using the new URL, so the grace for that rail is over.
async function endGrace(env, clientId, rail, rec) {
  try { const next = { ...rec }; delete next.grace; await env.mydukapos_kv.put(KEY(rail, clientId), JSON.stringify(next)); } catch (e) { /* ends at the next one */ }
}

// zip 185: a shop created from now on starts with all four rails keyed (stk = Daraja/KCB STK result, c2b = Till confirmations, kcb = KCB IPN, paywave = Paywave Express webhook),
// so an unsigned callback is never believed for it. Best effort: a failure here leaves the shop in the old "legacy" state, never blocks creation.
export async function ensureShopCallbackKeys(env, clientId) {
  try { await Promise.all(['stk', 'c2b', 'kcb', 'paywave', 'pesapal'].map((r) => ensureCallbackKey(env, clientId, r))); } catch (e) { /* stays legacy until its first prompt / registration */ }
}

// -> { ok: true, legacy: boolean } | { ok: false, keyCreatedAt }
export async function checkCallback(env, clientId, rail, url) {
  // zip 273: a flood of callbacks for one shop + rail is ignored (real callbacks are a handful an hour; the limit is far above that)
  const rlw = await checkRateLimit(env, 'webhook', `${rail}:${clientId}`);
  if (!rlw.ok) return { ok: false, limited: true, keyCreatedAt: 0 };
  const res = await checkCallbackKey(env, clientId, rail, url);
  if (!res.ok && !res.limited) await secEvent(env, 'callback_rejected', { route: rail, shop: clientId });
  return res;
}
async function checkCallbackKey(env, clientId, rail, url) {
  const rec = await getCallbackKey(env, clientId, rail);
  if (!rec) return legacyStillAllowed(env, rail) ? { ok: true, legacy: true } : { ok: false, keyCreatedAt: 0 };
  const k = new URL(url).searchParams.get('k') || '';
  if (safeEqual(k, rec.k)) {
    if (rec.grace) await endGrace(env, clientId, rail, rec);
    return { ok: true, legacy: false };
  }
  // a key made by ensureShopCallbackKeysGrace: the provider still has the old, unsigned URL until the cutoff
  if (rec.grace && legacyStillAllowed(env, rail)) return { ok: true, legacy: true };
  return { ok: false, keyCreatedAt: Number(rec.createdAt) || 0 };
}

// zip 255: the address Safaricom is told to POST results to. Normally the host the request came in on; PAY_CALLBACK_ORIGIN (e.g. https://yourbusiness.co.ke)
// overrides it when that host is a pages.dev address or contains a word Safaricom's production system drops.
export function callbackOrigin(request, env) {
  const o = String((env && env.PAY_CALLBACK_ORIGIN) || '').trim().replace(/\/+$/, '');
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)) return o;
  return new URL(request.url).origin;
}

export function withKey(url, rec) {
  return rec && rec.k ? `${url}&k=${encodeURIComponent(rec.k)}` : url;
}

// zip 185: payment callbacks name the shop only by ?c=. A callback for an id that is not a real licensed shop must write nothing (it used to
// create mpesa-tx / till-payment / ledger rows for any made-up id). A storage hiccup is NOT a reason to drop a real payment, so a
// failed lookup counts as "known" (the old behaviour).
export async function shopKnown(env, clientId) {
  if (!clientId || String(clientId).length > 80) return false;
  try { return !!(await getLicenseCached(env, clientId)); } catch (e) { return true; }
}

// zip 185: the JSON body of a provider callback, or null when it is missing, not JSON, or larger than `max` bytes (real callbacks are < 3 KB).
export async function readCallbackJson(request, max = 32768) {
  try {
    const len = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(len) && len > max) return null;
    const text = await request.text();
    if (text.length > max) return null;
    return JSON.parse(text);
  } catch (e) { return null; }
}
