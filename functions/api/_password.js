// functions/api/_password.js — shared helper, NOT a route.
//
// Password hashing for every account record on the server (website / demo accounts, the Owner Console owner, the per-shop email-recovery
// account). Zip 177. Until now a password was stored as ONE round of SHA-256 over salt + password — fast to brute-force if the store ever
// leaked. Records are now written as PBKDF2-SHA256 with 100,000 iterations (the most Cloudflare Workers allow; Argon2id is not available in the
// Workers runtime) in the SAME "p2$<iterations>$<salt>$<hex>" shape the device-pairing code already uses.
//
// Nothing breaks for existing accounts: a record that still holds the old hash keeps verifying with the old rule, and is rewritten in the new
// form the moment its owner signs in successfully (`upgradeOnLogin`). The record keeps its `salt` and `passwordHash` fields, so the signed
// session keys derived from them keep working exactly as before (a password change always ended older sessions; so does this upgrade, except
// for sessions whose KV record still exists, which are still accepted — see _account.js / _owner-auth.js).

export const PW_ITERATIONS = 100000;                 // Workers' ceiling for PBKDF2

function hex(bytes) { return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join(''); }
export function randomSalt(bytes = 16) { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return hex(a); }

async function sha256Hex(text) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)))); }
async function pbkdf2Hex(password, salt, iterations) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(String(salt)), iterations: Math.min(PW_ITERATIONS, Number(iterations) || PW_ITERATIONS) }, key, 256);
  return hex(bits);
}
function sameText(a, b) {                           // constant time for equal lengths
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const parse = (h) => { const p = String(h || '').split('$'); return p.length === 4 && p[0] === 'p2' ? { iter: p[1], salt: p[2], hex: p[3] } : null; };

export const isModernHash = (h) => !!parse(h);

// -> { salt, passwordHash } to store on the record (both fields, as before)
export async function hashPassword(password) {
  const salt = randomSalt(16);
  return { salt, passwordHash: `p2$${PW_ITERATIONS}$${salt}$${await pbkdf2Hex(password, salt, PW_ITERATIONS)}` };
}

// Does `password` match the record's stored hash? (modern or legacy)
export async function checkPassword(record, password) {
  if (!record || !record.passwordHash) return false;
  const p = parse(record.passwordHash);
  try {
    if (p) return sameText(await pbkdf2Hex(String(password == null ? '' : password), p.salt, p.iter), p.hex);
    return sameText(await sha256Hex(String(record.salt || '') + String(password == null ? '' : password)), record.passwordHash);
  } catch (e) { return false; }
}

// After a SUCCESSFUL sign-in: if the record still holds the old one-round hash, return the new salt + hash to store (else null).
export async function upgradeOnLogin(record, password) {
  if (!record || isModernHash(record.passwordHash)) return null;
  return hashPassword(password);
}

// Password policy for NEW website passwords (registration, reset): at least 8 characters, not one repeated character, not an obvious one.
const COMMON = new Set(['12345678', '123456789', '1234567890', 'password', 'password1', 'qwertyui', 'qwerty123', '11111111', '00000000', 'iloveyou', 'abc12345', 'mydukapos']);
export function passwordProblem(password) {
  const p = String(password == null ? '' : password);
  if (p.length < 8) return 'Use at least 8 characters.';
  if (p.length > 100) return 'That password is too long (100 characters at most).';
  if (/^(.)\1+$/.test(p)) return 'A password of one repeated character is too easy to guess.';
  if (COMMON.has(p.toLowerCase())) return 'That password is too common. Choose something less obvious.';
  return '';
}
