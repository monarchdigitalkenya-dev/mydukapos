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

const KEY = (rail, clientId) => `callback-key:${rail}:${clientId}`;

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

export async function ensureCallbackKey(env, clientId, rail) {
  const have = await getCallbackKey(env, clientId, rail);
  if (have) return have;
  const rec = { k: randomHex(16), createdAt: Date.now() };
  await env.mydukapos_kv.put(KEY(rail, clientId), JSON.stringify(rec));
  return rec;
}

// zip 185: a shop created from now on starts with all four rails keyed (stk = Daraja/KCB STK result, c2b = Till confirmations, kcb = KCB IPN, paywave = Paywave Express webhook),
// so an unsigned callback is never believed for it. Best effort: a failure here leaves the shop in the old "legacy" state, never blocks creation.
export async function ensureShopCallbackKeys(env, clientId) {
  try { await Promise.all(['stk', 'c2b', 'kcb', 'paywave', 'pesapal'].map((r) => ensureCallbackKey(env, clientId, r))); } catch (e) { /* stays legacy until its first prompt / registration */ }
}

// -> { ok: true, legacy: boolean } | { ok: false, keyCreatedAt }
export async function checkCallback(env, clientId, rail, url) {
  const rec = await getCallbackKey(env, clientId, rail);
  if (!rec) return { ok: true, legacy: true };
  const k = new URL(url).searchParams.get('k') || '';
  return safeEqual(k, rec.k) ? { ok: true, legacy: false } : { ok: false, keyCreatedAt: Number(rec.createdAt) || 0 };
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
