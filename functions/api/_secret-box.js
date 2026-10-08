// functions/api/_secret-box.js — shared helper, NOT a route. (zip 247)
//
// Payment and SMS credentials used to sit in KV as plain JSON, so anyone who could READ the KV namespace (a Cloudflare login without 2FA, an
// exported backup, a leaked token) held every shop's live Daraja / Paystack / KCB / SMS keys. This wraps a record in AES-256-GCM with a key that
// lives ONLY as a Cloudflare secret (PAYMENT_SECRETS_KEY) — never in KV, never in the repo — so a KV read or a backup alone is useless.
//
//   stored form      {"_enc":"enc1.<keyid>.<iv>.<ciphertext>"}        (base64url parts)
//   key              PAYMENT_SECRETS_KEY (>= 24 characters, random).  PAYMENT_SECRETS_KEY_OLD may hold the previous key while rotating.
//   bound to a shop  the shop's id is part of what GCM authenticates, so one shop's record cannot be pasted over another's.
//
// SAFE BY DEFAULT: with no key set, records stay plain JSON exactly as before (nothing breaks on the day this deploys). With a key set,
// every write is sealed and every plain record found on read is sealed the next time it is touched (or all at once from the Owner Console,
// owner-secrets.js). A sealed record whose key is missing or wrong is reported as UNREADABLE — callers must never overwrite it.
const enc = new TextEncoder();
const dec = new TextDecoder();
const PREFIX = 'enc1';

const b64u = (bytes) => { let s = ''; const a = new Uint8Array(bytes); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (t) => { const s = atob(String(t).replace(/-/g, '+').replace(/_/g, '/')); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };
const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

const MIN_KEY = 24;
function keysOf(env) {
  const out = [];
  const cur = String((env && env.PAYMENT_SECRETS_KEY) || '').trim();
  if (cur.length >= MIN_KEY) out.push(cur);
  String((env && env.PAYMENT_SECRETS_KEY_OLD) || '').split(',').map((s) => s.trim()).filter((s) => s.length >= MIN_KEY).forEach((k) => out.push(k));
  return out;
}
export const boxConfigured = (env) => keysOf(env).length > 0;

async function keyId(secret) { return hex(await crypto.subtle.digest('SHA-256', enc.encode('kid|' + secret))).slice(0, 8); }
async function aesKey(secret, usage) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('aes|' + secret));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
}

// -> "enc1.<keyid>.<iv>.<ct>" using the CURRENT key (throws if none is set)
export async function sealText(env, aad, text) {
  const [secret] = keysOf(env);
  if (!secret) throw new Error('PAYMENT_SECRETS_KEY is not set');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(String(aad)) }, await aesKey(secret, 'encrypt'), enc.encode(String(text)));
  return `${PREFIX}.${await keyId(secret)}.${b64u(iv)}.${b64u(ct)}`;
}

// -> plaintext, or throws (wrong key, tampered, another shop's record)
export async function openText(env, aad, blob) {
  const p = String(blob || '').split('.');
  if (p.length !== 4 || p[0] !== PREFIX) throw new Error('not an enc1 value');
  for (const secret of keysOf(env)) {
    if ((await keyId(secret)) !== p[1]) continue;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(p[2]), additionalData: enc.encode(String(aad)) }, await aesKey(secret, 'decrypt'), unb64u(p[3]));
    return dec.decode(pt);
  }
  throw new Error('no key for this record');
}

// What to put in KV for `obj`: sealed when a key is set, otherwise plain JSON (unchanged behaviour).
export async function sealRecord(env, aad, obj) {
  if (!boxConfigured(env)) return JSON.stringify(obj);
  return JSON.stringify({ _enc: await sealText(env, aad, JSON.stringify(obj)) });
}

// Reads what is in KV (a string or null). -> { ok, value, encrypted, needsSeal }
//   ok:false  the record is sealed and cannot be opened (key missing / rotated away / tampered) — NEVER write over it.
//   needsSeal true when a key is set but this record is still plain (or sealed with an old key): the caller may re-seal it.
export async function openRecord(env, aad, raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: {}, encrypted: false, needsSeal: false, empty: true };
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return { ok: true, value: {}, encrypted: false, needsSeal: false, empty: true }; }
  if (obj && typeof obj === 'object' && typeof obj._enc === 'string') {
    try {
      const value = JSON.parse(await openText(env, aad, obj._enc));
      const cur = keysOf(env)[0];
      const needsSeal = !!cur && obj._enc.split('.')[1] !== (await keyId(cur));         // sealed with an OLD key: re-seal with the current one
      return { ok: true, value: value && typeof value === 'object' ? value : {}, encrypted: true, needsSeal };
    } catch (e) { return { ok: false, value: {}, encrypted: true, needsSeal: false }; }
  }
  const value = obj && typeof obj === 'object' ? obj : {};
  return { ok: true, value, encrypted: false, needsSeal: boxConfigured(env) && Object.keys(value).length > 0 };
}
