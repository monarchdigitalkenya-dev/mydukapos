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
