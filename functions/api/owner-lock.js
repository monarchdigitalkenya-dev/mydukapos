// functions/api/owner-lock.js — Cloudflare Pages Function
//
// Manual controls for a client link, shown in the 🔗 Licenses tab: force-lock
// it early, unlock it again, give a demo more time without payment, rename
// it, reset a forgotten password, or delete it outright. Body: { c: "<client
// id>", action: "lock" | "unlock" | "extend" | "edit" | "resetPassword" |
// "delete", ... }. Direct replacement for master-lock.js, gated by owner
// session instead of MASTER_ADMIN_PASSWORD.
//
// "edit" changes the label (the client's display name), and/or clientName /
// preferredName (the owner's own record of who this actually is — never
// shown to the client, never touches the subdomain slug, which stays
// whatever it was assigned at creation so existing bookmarks never break).
//
// "extend" adds `hours` (default 72, matching the old fixed button) to a
// demo's expiry, from whichever is later: now, or its current expiry (so
// extending an already-future expiry adds on top of it rather than pulling
// it backward).
//
// "resetPassword" is the forgot-password fallback: a client's login/admin
// password is only ever stored as a SHA-256 hash inside their own synced
// STATE blob (pos-data:state:<id> — a completely different KV entry from
// this license record, written by pos-sync.js), so nothing here can look up
// or show what a password currently is. Instead this generates a fresh
// temporary password, hashes it the exact same way the client apps do
// (plain SHA-256, no salt — see hashPassword() in index.html), writes that
// hash directly into their state, and returns the new password in plain
// text ONCE so the owner can pass it on. This reaches an already-locked-out
// device on its own — every client polls the server in the background even
// while sitting on its login screen (see the pullState() call in
// DOMContentLoaded), so the new password takes effect within moments,
// without the device needing to do anything itself.
//
// "delete" is permanent — see deleteClient() in _license.js for exactly
// what it removes. There's no undo, so the front-end confirms with the
// owner before ever sending this action.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireOwnerAuth } from './_owner-auth.js';
import { readState, writeState } from './_state-store.js';
import { getLicense, saveLicense, deleteClient, PRODUCTS, getDemoDurationHours } from './_license.js';
import { removeClientLink } from './account-recovery.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A per-PERSON running ledger of quotes/payments — separate from the
// per-LINK agreedAmount/paidAmount/revenue fields the "billing" and
// "recordRevenue" actions below write (those stay exactly as they were,
// untouched, for anything already using them). One person can have several
// links (see groupNameKey() in owner/index.html); this tracks money
// agreed/paid against the PERSON as a whole, as more than one entry over
// time — e.g. the original quote, then a later entry for an extra service
// — rather than a single one-time figure tied to one link. Keyed by the
// same case-insensitive, trimmed name key the client list already groups
// by, so it lines up with whichever links currently carry that name.
const GROUP_INCOME_KEY = 'owner-group-income:v1';

async function readGroupIncome(env) {
  const raw = await env.mydukapos_kv.get(GROUP_INCOME_KEY);
  return raw ? JSON.parse(raw) : {};
}

async function writeGroupIncome(env, data) {
  await env.mydukapos_kv.put(GROUP_INCOME_KEY, JSON.stringify(data));
}

function stateKey(clientId) {
  return `pos-data:state:${clientId}`;
}

async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Readable, unambiguous characters only (no 0/O, 1/I/l) — this gets read
// aloud over a phone call or typed from a screenshot, so it needs to survive
// that without a support call over "was that a zero or a letter O".
const TEMP_PASSWORD_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function generateTempPassword(length = 8) {
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) out += TEMP_PASSWORD_CHARS[bytes[i] % TEMP_PASSWORD_CHARS.length];
  return out;
}

export async function onRequestPost(context) {
  const ok = await requireOwnerAuth(context);
  if (!ok) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  if (body.action === 'recordGroupIncome') {
    // c is any one client id belonging to this person's group — used only
    // as a light sanity check that this is a real link the owner can see,
    // not as the record being written to (see the comment on
    // GROUP_INCOME_KEY above for why this is separate from that record).
    const anyRecord = await getLicense(context.env, body.c);
    if (!anyRecord) return jsonResponse({ error: 'Client not found.' }, 404);
    const groupKey = String(body.groupKey || '').trim().toLowerCase();
    if (!groupKey) return jsonResponse({ error: 'Missing group.' }, 400);
    const agreed = Number(body.agreedAmount);
    const paidRaw = body.paidAmount;
    const paid = paidRaw === undefined || paidRaw === null || paidRaw === '' ? 0 : Number(paidRaw);
    if (!Number.isFinite(agreed) || agreed <= 0) return jsonResponse({ error: 'Enter the money agreed.' }, 400);
    if (!Number.isFinite(paid) || paid < 0) return jsonResponse({ error: 'Enter the money paid (0 if nothing yet).' }, 400);
    if (paid > agreed + 0.004) return jsonResponse({ error: 'The money paid cannot be more than the money agreed.' }, 400);
    const note = String(body.note || '').trim().slice(0, 200);
    const method = body.method === 'cash' ? 'cash' : 'mpesa';

    const all = await readGroupIncome(context.env);
    const group = all[groupKey] || { label: String(body.groupLabel || groupKey).trim(), entries: [] };
    group.label = String(body.groupLabel || group.label || groupKey).trim(); // keeps the display name current if it was renamed since
    group.entries.push({ id: crypto.randomUUID(), at: Date.now(), agreed, paid, method, note });
    all[groupKey] = group;
    await writeGroupIncome(context.env, all);
    return jsonResponse({ entries: group.entries });
  }

  if (body.action === 'delete') {
    const removed = await deleteClient(context.env, body.c);
    if (!removed) return jsonResponse({ error: 'Client not found.' }, 404);
    // Also frees up any email this link was signed up/logged in with (see
    // account-recovery.js) — otherwise that email would still show as
    // "already linked" to a client id that no longer exists, permanently
    // blocking it from ever being used to set up a new link.
    await removeClientLink(context.env, body.c);
    return jsonResponse({ deleted: true });
  }

  if (body.action === 'resetPassword') {
    const record = await getLicense(context.env, body.c);
    if (!record) return jsonResponse({ error: 'Client not found.' }, 404);

    const target = body.target === 'admin' ? 'admin' : body.target === 'both' ? 'both' : 'login';
    const state = await readState(context.env, stateKey(body.c), {});

    const tempPassword = generateTempPassword();
    const hash = await hashPassword(tempPassword);
    const now = Date.now();
    // Stamping _fieldTimes here is what makes this reset actually stick.
    // Without it, any device that's still active on this shop (mid-sale,
    // editing stock — anything that triggers its own routine sync) keeps
    // pushing its own stale, unaware copy of the OLD password hash, and
    // since that push carries no competing stamp of its own, plain
    // last-write-wins let it silently overwrite this reset within moments —
    // "the reset isn't working" because it never had a chance to survive.
    // A stamped field only loses to a push that itself carries an equal-or-
    // newer stamp, which a device that doesn't know the password changed
    // never sends (see the same rule in _merge.js/mergeIncomingState and
    // shop-store.js/push()).
    const fieldTimes = { ...(state._fieldTimes || {}) };
    if (target === 'login' || target === 'both') { state.pwHash = hash; fieldTimes.pwHash = now; }
    if (target === 'admin' || target === 'both') { state.adminPwHash = hash; fieldTimes.adminPwHash = now; }
    state._fieldTimes = fieldTimes;

    await writeState(context.env, stateKey(body.c), { ...state, updatedAt: now });
    return jsonResponse({ tempPassword, target });
  }

  const record = await getLicense(context.env, body.c);
  if (!record) return jsonResponse({ error: 'Client not found.' }, 404);

  if (body.action === 'lock') {
    record.locked = true;
  } else if (body.action === 'unlock') {
    record.locked = false;
  } else if (body.action === 'extend') {
    if (record.type === 'demo') {
      // Default is whatever the owner has currently configured as the
      // standard demo duration (see getDemoDurationHours in _license.js) —
      // matches the "72 hours" label this button used to show verbatim,
      // now tracking that setting instead of a fixed number.
      const hours = Number.isFinite(body.hours) && body.hours > 0 ? body.hours : await getDemoDurationHours(context.env);
      const now = Date.now();
      const base = record.expiresAt && record.expiresAt > now ? record.expiresAt : now;
      record.expiresAt = base + hours * 60 * 60 * 1000;
    }
  } else if (body.action === 'edit') {
    // notesOnly: true skips the label requirement entirely — this is the
    // Notes textarea in a client's detail view saving on its own, not a
    // full rename, so nothing else about the record should be touched or
    // required to be re-sent.
    if (body.notesOnly) {
      if (typeof body.notes === 'string') record.notes = body.notes.trim();
    } else {
      const label = String(body.label || '').trim();
      if (!label) return jsonResponse({ error: 'Label cannot be empty.' }, 400);
      record.label = label;
      if (typeof body.clientName === 'string') record.clientName = body.clientName.trim();
      if (typeof body.preferredName === 'string') record.preferredName = body.preferredName.trim();
      if (typeof body.notes === 'string') record.notes = body.notes.trim();
      if (typeof body.phone === 'string') record.phone = body.phone.trim();
      if (typeof body.email === 'string') record.email = body.email.trim();
      // Lets a wrongly-generated (or later-changed) client be corrected
      // without breaking their existing bookmarked link — the slug/subdomain
      // stays the same, only which app folder it resolves to changes.
      // PRODUCTS is the same lookup clientLink()/productPath() use, so an
      // invalid value here is silently ignored rather than corrupting the
      // record, same as createClient() already does at creation time.
      if (typeof body.product === 'string' && PRODUCTS[body.product]) {
        record.product = body.product;
      }
    }
  } else if (body.action === 'billing') {
    // Updates just the agreed/paid billing figures on a client link — used
    // by both the Leads tab (recording extra payment against a bill left
    // over from closing a lead) and the client's own detail view in the
    // Demo/Permanent Links tabs ("Record Payment"). Doesn't touch label,
    // notes, or anything else, same spirit as the notesOnly edit above.
    if (typeof body.agreedAmount === 'number') record.agreedAmount = Math.max(0, body.agreedAmount);
    if (typeof body.paidAmount === 'number') record.paidAmount = Math.max(0, body.paidAmount);
    record.balanceOwed = Math.max(0, (record.agreedAmount || 0) - (record.paidAmount || 0));
  } else if (body.action === 'recordRevenue') {
    // The owner's toggle under Permanent links: the money AGREED and the money PAID for this link. Recorded once; this is the only thing that
    // puts a permanent link's income into the owner's sales (making a link permanent adds nothing by itself). Whatever is still owing becomes
    // a bill in the owner's Bills tab, which the owner settles and reminds from there.
    if (record.type !== 'permanent') return jsonResponse({ error: 'Income can only be recorded for a permanent link.' }, 400);
    if (record.revenue) return jsonResponse({ error: 'Income is already recorded for this link.' }, 409);
    const agreed = Number(body.agreedAmount), paid = Number(body.paidAmount);
    if (!Number.isFinite(agreed) || agreed <= 0) return jsonResponse({ error: 'Enter the money agreed.' }, 400);
    if (!Number.isFinite(paid) || paid < 0) return jsonResponse({ error: 'Enter the money paid (0 if nothing yet).' }, 400);
    if (paid > agreed + 0.004) return jsonResponse({ error: 'The money paid cannot be more than the money agreed.' }, 400);
    record.agreedAmount = agreed;
    record.paidAmount = paid;
    record.balanceOwed = Math.max(0, agreed - paid);
    record.revenue = { at: Date.now(), agreed, paid, method: body.method === 'cash' ? 'cash' : 'mpesa' };
  } else if (body.action === 'remind') {
    // A payment reminder for the admin of this link: shown to them inside their POS the next time it checks in (license-status), until they
    // dismiss it. One reminder at a time; a new one replaces the last.
    if (record.type !== 'permanent') return jsonResponse({ error: 'Reminders are for permanent links.' }, 400);
    const message = String(body.message || '').trim().slice(0, 500);
    if (!message) return jsonResponse({ error: 'Write the reminder message.' }, 400);
    record.notice = { id: crypto.randomUUID(), message, at: Date.now(), ackAt: null, balance: Math.max(0, Number(body.balance) || 0) };
  } else {
    return jsonResponse({ error: 'Unknown action.' }, 400);
  }

  await saveLicense(context.env, record);
  return jsonResponse({ client: record });
}
