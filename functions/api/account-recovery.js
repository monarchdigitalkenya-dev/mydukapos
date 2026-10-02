// functions/api/account-recovery.js — Cloudflare Pages Function
//
// OPT-IN per-shop email recovery for the unified login/management
// password — see index.html's Settings → Security & Access → "Email
// Recovery" card. Existing offline PIN login and the local password
// hashes (pos_pw_hash / pos_admin_pw_hash) are completely untouched by
// this — nothing here is required, and a client that never links an
// email keeps working exactly as before, fully offline.
//
// Once linked, a client can:
//   - request a password-reset email if they forget their password
//     everywhere (action 'forgot-password' + 'reset-password')
//   - "sign in" with email+password on a brand-new device that has no
//     cached local hash yet (action 'verify') — the device then computes
//     its own local hash from the password just entered and caches it,
//     same as any normal login, so it works offline from then on too.
//   - "sign in" the SAME way but password-only, from inside a specific
//     link that's already claimed (actions 'verify-for-client' and
//     'forgot-password-for-client') — the link's own license already
//     identifies the one account and one password, so no email needs to
//     be typed. This is what index.html's login-recovery-step (and the
//     auto-adopt check on a brand-new device — see attemptClaimedLinkAutoLogin())
//     use instead of the public 'verify'/'forgot-password' actions above.
//
// MULTI-BRANCH UPDATE (spec: "Branch Access Flow" — staff/managers at a
// secondary branch log into the branch link using the main Admin's
// registered Email & Master Password): one email can now be linked to
// SEVERAL client ids at once, all sharing ONE password record. Linking a
// second/third client under an email that's already linked elsewhere
// requires the SAME password as the existing link (checked against the
// existing hash) — this is what makes it a genuinely unified password
// across branches rather than just multiple independent recovery records
// that happen to share an email. A password reset updates every linked
// client's shared record in one go, since there is only one record per
// email now (not one per client).
//
// STORAGE (current shape — see migrateLegacyRecord-style helpers below for
// the one-email-per-client shape this replaces, and why reads still fall
// back to it):
//   account-recovery-account:<email>    -> { email, salt, passwordHash,
//                                             linkedAt, clientIds: [...] }
//   account-recovery-client:<clientId>  -> email  (reverse lookup for the
//                                                   'status'/'link'/'unlink'
//                                                   actions, which are
//                                                   scoped to the calling
//                                                   device's own client id)
//   account-recovery-reset:<token>      -> email  (reset token, replaces
//                                                   the old token->clientId
//                                                   shape since a reset now
//                                                   has to update every
//                                                   linked client at once)
//   account-recovery-reset-rate:<email> -> per-email rate limit, unchanged
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { loginBlocked, noteLoginFailure } from './_ratelimit.js';
import { requireValidLicense } from './_license.js';
import { deviceGuard } from './_device-auth.js';
import { corsHeadersFor } from './_cors.js';
import { managerGuard } from './_sec-guard.js';
import { sendEmail } from './_email.js';
import { hashPassword, checkPassword, upgradeOnLogin } from './_password.js';

// zip 177: PBKDF2 (see _password.js). Checks a password against a recovery record and, when the record still has the old one-round hash and
// the password is right, rewrites it in the new form (best effort — a failed upgrade never fails the sign-in).
async function passwordOk(env, record, password) {
  if (!(await checkPassword(record, password))) return false;
  try { const up = await upgradeOnLogin(record, password); if (up) { record.salt = up.salt; record.passwordHash = up.passwordHash; await saveAccountRecord(env, record); } } catch (e) { /* next time */ }
  return true;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

const ACCOUNT_PREFIX = 'account-recovery-account:'; // account-recovery-account:<email> -> shared record
const CLIENT_LINK_PREFIX = 'account-recovery-client:'; // account-recovery-client:<clientId> -> email
const RESET_PREFIX = 'account-recovery-reset:'; // reset token -> email
const RESET_RATE_PREFIX = 'account-recovery-reset-rate:';
const RESET_TOKEN_TTL_SECONDS = 60 * 60;
const RESET_RATE_MAX = 3;
const RESET_RATE_WINDOW_SECONDS = 60 * 60;

// Legacy (pre-multi-branch) key shape — one record per client, keyed by
// clientId, with no clientIds array and no reverse client-link index.
const LEGACY_RECORD_PREFIX = 'account-recovery:';
const LEGACY_EMAIL_INDEX_PREFIX = 'account-recovery-email:';

function randomToken(len = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return '';
  const visible = user.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(user.length - 1, 1))}@${domain}`;
}

async function getAccountRecord(env, email) {
  const raw = await env.mydukapos_kv.get(ACCOUNT_PREFIX + email);
  return raw ? JSON.parse(raw) : null;
}

async function saveAccountRecord(env, record) {
  await env.mydukapos_kv.put(ACCOUNT_PREFIX + record.email, JSON.stringify(record));
  await Promise.all(record.clientIds.map((id) => env.mydukapos_kv.put(CLIENT_LINK_PREFIX + id, record.email)));
}

// Finds this clientId's linked email, migrating a legacy single-client
// record into the new shared shape the first time it's touched. Returns
// '' if the client has never linked an email at all — the normal, fully
// offline case that most clients stay in forever.
async function emailForClient(env, clientId) {
  const direct = await env.mydukapos_kv.get(CLIENT_LINK_PREFIX + clientId);
  if (direct) return direct;

  const legacyRaw = await env.mydukapos_kv.get(LEGACY_RECORD_PREFIX + clientId);
  if (!legacyRaw) return '';
  const legacy = JSON.parse(legacyRaw);
  // Migrate: this client's old record becomes the seed of the new
  // shared-by-email record (or joins an existing one, on the off chance
  // two clients were separately linked to the same email under the old
  // one-record-per-client scheme — same password wins if they differ,
  // arbitrarily the one migrated first, since there's no way to know
  // which is "current" from storage alone).
  let record = await getAccountRecord(env, legacy.email);
  if (!record) {
    record = { email: legacy.email, salt: legacy.salt, passwordHash: legacy.passwordHash, linkedAt: legacy.linkedAt, clientIds: [] };
  }
  if (!record.clientIds.includes(clientId)) record.clientIds.push(clientId);
  await saveAccountRecord(env, record);
  await env.mydukapos_kv.delete(LEGACY_RECORD_PREFIX + clientId);
  await env.mydukapos_kv.delete(LEGACY_EMAIL_INDEX_PREFIX + legacy.email);
  return legacy.email;
}

// Same migration, entered from the email side (verify/forgot-password,
// which only have an email, not a clientId, to start from).
async function getAccountRecordMigrating(env, email) {
  const existing = await getAccountRecord(env, email);
  if (existing) return existing;
  const legacyClientId = await env.mydukapos_kv.get(LEGACY_EMAIL_INDEX_PREFIX + email);
  if (!legacyClientId) return null;
  await emailForClient(env, legacyClientId); // performs the migration as a side effect
  return getAccountRecord(env, email);
}

// Shared by 'forgot-password' (public, caller supplies the email) and
// 'forgot-password-for-client' (license-scoped, email is derived from the
// link itself) — same rate limit, same token, same message either way.
async function sendResetEmail(env, request, email) {
  const rateKey = RESET_RATE_PREFIX + email;
  const rawCount = await env.mydukapos_kv.get(rateKey);
  const count = rawCount ? parseInt(rawCount, 10) : 0;
  if (count >= RESET_RATE_MAX) return;

  const record = await getAccountRecordMigrating(env, email);
  if (record) {
    const token = randomToken();
    await env.mydukapos_kv.put(RESET_PREFIX + token, email, { expirationTtl: RESET_TOKEN_TTL_SECONDS });
    const origin = new URL(request.url).origin;
    const resetLink = `${origin}/?account-reset=${token}`;
    await sendEmail(env, {
      to: email,
      subject: 'Reset your shop password',
      html: `
        <p>Someone requested a password reset for the shop${record.clientIds.length > 1 ? 's' : ''} linked to this email.</p>
        <p>Click the link below to set a new password — it applies everywhere this email is linked, including any branches. It expires in 1 hour.</p>
        <p><a href="${resetLink}">${resetLink}</a></p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
    });
  }
  await env.mydukapos_kv.put(rateKey, String(count + 1), { expirationTtl: RESET_RATE_WINDOW_SECONDS });
}

// Removes one clientId's email link entirely — same cleanup as the
// 'unlink' action below, but callable directly by other endpoints (not
// just over HTTP), so a link that's been PERMANENTLY DELETED (Owner
// Console's "delete", or a demo account deleting its own demo) frees up
// its email immediately rather than leaving a dangling reverse-index
// entry that would make that email look "already linked" forever, even
// though the client it pointed to no longer exists. Safe to call for a
// clientId that was never linked — it's then just a no-op.
// Links a brand-new client (typically a freshly created branch — see
// branches.js's 'create' action) into whatever email account an EXISTING
// client is already linked to, so the two immediately share one email +
// password the same way any two branches linked by hand would. A no-op
// (returns false) if the existing client has never linked an email at
// all — most clients never do, and that's fine; the branch still works
// via its seeded local password hash (see seedInitialState in
// pos-sync.js), it just won't have email recovery until someone opts in.
export async function linkNewClientToSameAccount(env, existingClientId, newClientId) {
  const email = await emailForClient(env, existingClientId);
  if (!email) return false;
  const record = await getAccountRecordMigrating(env, email);
  if (!record) return false;
  if (!record.clientIds.includes(newClientId)) record.clientIds.push(newClientId);
  await saveAccountRecord(env, record);
  return true;
}

export async function removeClientLink(env, clientId) {
  const email = await emailForClient(env, clientId);
  if (!email) return;
  const record = await getAccountRecord(env, email);
  if (record) {
    record.clientIds = record.clientIds.filter((id) => id !== clientId);
    if (record.clientIds.length === 0) {
      await env.mydukapos_kv.delete(ACCOUNT_PREFIX + email);
    } else {
      await env.mydukapos_kv.put(ACCOUNT_PREFIX + email, JSON.stringify(record));
    }
  }
  await env.mydukapos_kv.delete(CLIENT_LINK_PREFIX + clientId);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const action = body.action;

  /* ---------------- actions scoped to THIS device's own client link ---------------- */

  if (action === 'status' || action === 'link' || action === 'unlink' || action === 'change-password' || action === 'verify-for-client' || action === 'forgot-password-for-client') {
    const license = await requireValidLicense(request, env);
    if (!license.valid) return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
    const clientId = license.clientId;
    // zip 185: link / unlink / change-password change who can recover the shop — paired devices only when the shop has switched that on (no change
    // otherwise). 'verify-for-client' and 'forgot-password-for-client' are SIGN-IN paths for a device that has no cached hash yet (often an unpaired
    // new device), so they are deliberately NOT guarded here — they keep their own rate limits.
    if (action === 'link' || action === 'unlink' || action === 'change-password') {
      const deviceDenied = await deviceGuard(request, env, clientId, corsHeadersFor(request, env));
      if (deviceDenied) return deviceDenied;
    }

    if (action === 'status') {
      const email = await emailForClient(env, clientId);
      return jsonResponse({ linked: !!email, email: email ? maskEmail(email) : null });
    }

    // Password-only sign-in for a device that has no cached local hash yet
    // (a fresh device, or one that lost it) — the link that was opened
    // already determines which account this is (every signup/login links
    // its email, so a claimed link always has one — see 'status' above),
    // so unlike the public 'verify' action below, the caller never needs
    // to type an email.
    if (action === 'verify-for-client') {
      const password = String(body.password || '');
      const email = await emailForClient(env, clientId);
      if (!email) return jsonResponse({ error: 'This link has no account set up yet.' }, 404);
      const record = await getAccountRecordMigrating(env, email);
      if (!record) return jsonResponse({ error: 'This link has no account set up yet.' }, 404);
      const blocked = await loginBlocked(env, request, 'recovery:' + clientId);
      if (blocked) return blocked;
      if (!(await passwordOk(env, record, password))) { await noteLoginFailure(env, request, 'recovery:' + clientId); return jsonResponse({ error: 'Incorrect password.' }, 401); }
      return jsonResponse({ ok: true });
    }

    // Same idea for the reset-email request — no email to type, it's
    // derived from the link.
    if (action === 'forgot-password-for-client') {
      const genericResponse = { ok: true, message: "If this link has an account set up, we've sent a password reset link to its email." };
      const email = await emailForClient(env, clientId);
      if (email) await sendResetEmail(env, request, email);
      return jsonResponse(genericResponse);
    }

    if (action === 'link') {
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      if (!isValidEmail(email)) return jsonResponse({ error: 'Enter a valid email address.' }, 400);
      if (password.length < 4) return jsonResponse({ error: 'Password must be at least 4 characters.' }, 400);

      // zip 185: this shop already has a recovery email. Anyone holding the link could replace it with THEIR email + password (saveAccountRecord
      // overwrites account-recovery-client:<clientId>). Pointing the shop at a DIFFERENT email now needs proof of the current recovery password
      // (body.currentPassword), counted and rate-limited like any password guess. First-time linking (no email yet) and re-linking the same email are unchanged.
      const curEmail = await emailForClient(env, clientId);
      if (curEmail && curEmail !== email) {
        const blockedCur = await loginBlocked(env, request, 'recovery:' + clientId);
        if (blockedCur) return blockedCur;
        const curRec = await getAccountRecord(env, curEmail);
        if (curRec && !(await checkPassword(curRec, String(body.currentPassword || '')))) {
          await noteLoginFailure(env, request, 'recovery:' + clientId);
          return jsonResponse({ error: 'This shop already has a recovery email. Unlink it first, or enter the current recovery password to replace it.', code: 'already_linked' }, 409);
        }
        await removeClientLink(env, clientId);                  // proven: the old email is released, then the new one is linked below
      }

      const blockedEmail = await loginBlocked(env, request, 'recovery-email:' + email);   // zip 185: password guesses against an email were unlimited here
      if (blockedEmail) return blockedEmail;
      const existing = await getAccountRecordMigrating(env, email);
      if (existing) {
        // Joining an email that's already linked to one or more shops —
        // this is the Branch Access Flow: the password must match the
        // one already on file, so it stays genuinely one password across
        // every branch rather than silently forking on whichever branch
        // links second.
        if (!(await checkPassword(existing, password))) {
          await noteLoginFailure(env, request, 'recovery-email:' + email);   // zip 185
          return jsonResponse({ error: 'That email is already linked elsewhere with a different password. Use the same password to add this branch, or reset it first.' }, 409);
        }
        if (!existing.clientIds.includes(clientId)) existing.clientIds.push(clientId);
        await saveAccountRecord(env, existing);
        return jsonResponse({ ok: true, email: maskEmail(email) });
      }

      const { salt, passwordHash } = await hashPassword(password);
      const record = { email, salt, passwordHash, linkedAt: Date.now(), clientIds: [clientId] };
      await saveAccountRecord(env, record);
      return jsonResponse({ ok: true, email: maskEmail(email) });
    }

    if (action === 'unlink') {
      // zip 185: unlinking is what lets someone else link THEIR email next. When the shop requires staff sessions, only the Admin / a manager.
      // The app sends no password here today, so a password is checked only when one is supplied (body.currentPassword) — or required for every
      // unlink when ACCOUNT_RECOVERY_STRICT=1 is set (once the app asks for it).
      const mgrDenied = await managerGuard(request, env, clientId, CORS_HEADERS);
      if (mgrDenied) return mgrDenied;
      const linkedEmail = await emailForClient(env, clientId);
      if (linkedEmail && (body.currentPassword != null || String(env.ACCOUNT_RECOVERY_STRICT) === '1')) {
        const blockedU = await loginBlocked(env, request, 'recovery:' + clientId);
        if (blockedU) return blockedU;
        const recU = await getAccountRecord(env, linkedEmail);
        if (recU && !(await checkPassword(recU, String(body.currentPassword || '')))) {
          await noteLoginFailure(env, request, 'recovery:' + clientId);
          return jsonResponse({ error: 'Current password is incorrect.' }, 401);
        }
      }
      await removeClientLink(env, clientId);
      return jsonResponse({ ok: true });
    }

    if (action === 'change-password') {
      // Keeps the linked-email recovery record in sync when the password
      // is changed from Settings (rather than via the forgot-password
      // reset-link flow) — see water/index.html's changePassword(), which
      // calls this right after updating its own local hash. Requires the
      // CURRENT password, same proof-of-knowledge bar as 'link' joining an
      // already-linked email, and — since one record now covers every
      // branch linked to this email — updates all of them at once, not
      // just this device's own client id.
      const email = await emailForClient(env, clientId);
      if (!email) return jsonResponse({ error: 'No email is linked to this device.' }, 404);
      const record = await getAccountRecord(env, email);
      if (!record) return jsonResponse({ error: 'No email is linked to this device.' }, 404);

      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');
      const confirmNewPassword = String(body.confirmNewPassword || '');
      const blockedC = await loginBlocked(env, request, 'recovery:' + clientId);   // zip 185: the current-password check had no guess limit
      if (blockedC) return blockedC;
      if (!(await checkPassword(record, currentPassword))) { await noteLoginFailure(env, request, 'recovery:' + clientId); return jsonResponse({ error: 'Current password is incorrect.' }, 401); }
      if (newPassword.length < 4) return jsonResponse({ error: 'New password must be at least 4 characters.' }, 400);
      if (newPassword !== confirmNewPassword) return jsonResponse({ error: 'New passwords do not match.' }, 400);

      const fresh = await hashPassword(newPassword);
      record.passwordHash = fresh.passwordHash;
      record.salt = fresh.salt;
      await saveAccountRecord(env, record);
      return jsonResponse({ ok: true });
    }
  }

  /* ---------------- public actions (no active-device license needed) ---------------- */

  if (action === 'verify') {
    // Signing in with email+password on a brand-new device — no reset
    // token needed, just proves they still know the password. The client
    // uses success here to provision itself (compute and cache its own
    // local hash), never anything returned by this endpoint. Works
    // identically whether the email is linked to one shop or several —
    // this endpoint doesn't need to know which client the new device is
    // for; that's decided by which link the device was opened from.
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const blocked = await loginBlocked(env, request, 'recovery-email:' + email);
    if (blocked) return blocked;
    const record = await getAccountRecordMigrating(env, email);
    // zip 185: an unknown email used to answer 404 "No shop is linked" while a known one answered 401 — that told anyone which emails have shops.
    // Both now give the same 401 (the app shows data.error either way).
    if (!record || !(await passwordOk(env, record, password))) { await noteLoginFailure(env, request, 'recovery-email:' + email); return jsonResponse({ error: 'Incorrect email or password.' }, 401); }
    return jsonResponse({ ok: true });
  }

  if (action === 'forgot-password') {
    const email = normalizeEmail(body.email);
    const genericResponse = { ok: true, message: "If that email is linked to a shop, we've sent a password reset link to it." };
    if (!isValidEmail(email)) return jsonResponse(genericResponse);

    await sendResetEmail(env, request, email);
    return jsonResponse(genericResponse);
  }

  if (action === 'reset-password') {
    const token = String(body.token || '');
    const password = String(body.password || '');
    const confirmPassword = String(body.confirmPassword || '');
    if (!token) return jsonResponse({ error: 'Missing reset token.' }, 400);
    if (password.length < 4) return jsonResponse({ error: 'Password must be at least 4 characters.' }, 400);
    if (password !== confirmPassword) return jsonResponse({ error: 'Passwords do not match.' }, 400);

    const email = await env.mydukapos_kv.get(RESET_PREFIX + token);
    if (!email) return jsonResponse({ error: 'This reset link has expired or already been used. Please request a new one.' }, 400);

    const record = await getAccountRecordMigrating(env, email);
    if (!record) return jsonResponse({ error: 'This email is no longer linked to a shop.' }, 404);

    const fresh = await hashPassword(password);
    record.passwordHash = fresh.passwordHash;
    record.salt = fresh.salt;
    await saveAccountRecord(env, record); // updates every linked clientId's reverse index too, harmlessly re-writing unchanged entries
    await env.mydukapos_kv.delete(RESET_PREFIX + token);

    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}
