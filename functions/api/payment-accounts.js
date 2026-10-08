// functions/api/payment-accounts.js — Cloudflare Pages Function
//
// A shop's payment accounts (tills, bank accounts, mobile money lines) are a
// branch-group-wide resource, not something each branch keeps its own copy
// of — add one from any branch and every branch sees it immediately, and
// connecting an account to a branch from anywhere updates for everyone. For
// a standalone shop with no branches, it's just that shop's own account
// list. Either way it lives in its own KV entry (payment-accounts:<groupId>
// or payment-accounts:<clientId> when there's no group), completely
// separate from any individual client's synced state — same pattern as
// store.js, for the same reason.
//
// Actions (all POST, JSON body — caller identified by license the same way
// as every other endpoint in this app):
//   { action: 'get' }
//     Returns the current account list for the caller's branch group.
//   { action: 'add', name }
//     Adds a new account, starting out not connected to any branch.
//   { action: 'setBranch', accountId, branchClientId }
//     Connects (or, with branchClientId empty/null, disconnects) an account
//     to a specific branch. branchClientId, when set, must be a member of
//     the caller's own branch group.
//   { action: 'remove', accountId }
//     Deletes an account entirely.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense, getLicense, getBranchGroupMembers, randomToken } from './_license.js';
import { deviceGuard } from './_device-auth.js';
import { corsHeadersFor } from './_cors.js';
import { managerGuard, secLimit, secNum } from './_sec-guard.js';

// zip 247: no more `Access-Control-Allow-Origin: *` — the answer names the shop's own origin only (the apps call this on their own origin, so nothing
// else ever needed `*`), and adding / re-pointing / removing a payment account needs the Admin or a manager when the shop requires staff sessions.
const CORS_OPTS = { methods: 'POST, OPTIONS', headers: 'Content-Type, X-Device-Id, X-Device-Token, X-Staff-Token' };

function jsonResponse(body, status = 200, cors = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, CORS_OPTS) });
}

function accountsKey(groupId) {
  return `payment-accounts:${groupId}`;
}

async function getAccounts(env, groupId) {
  const raw = await env.mydukapos_kv.get(accountsKey(groupId));
  return raw ? JSON.parse(raw) : [];
}

async function saveAccounts(env, groupId, accounts) {
  await env.mydukapos_kv.put(accountsKey(groupId), JSON.stringify(accounts));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env, CORS_OPTS);
  const reply = (b, st = 200) => jsonResponse(b, st, cors);

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return reply({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  // PAIRED DEVICES ONLY when the shop has switched that on (see _device-auth.js); otherwise no change
  const deviceDenied = await deviceGuard(request, env, license.clientId, cors);
  if (deviceDenied) return deviceDenied;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return reply({ error: 'Invalid JSON body' }, 400);
  }

  const record = await getLicense(env, license.clientId);
  if (!record) return reply({ error: 'Client not found.' }, 404);
  // A shop in a branch group shares one account list with every branch
  // (keyed by the group). A standalone shop with no branches still gets an
  // account list of its own, keyed to itself.
  const groupId = record.branchGroupId || record.id;

  if (body.action === 'get') {
    const accounts = await getAccounts(env, groupId);
    return reply({ accounts });
  }

  if (body.action === 'add' || body.action === 'setBranch' || body.action === 'remove') {
    const mgrDenied = await managerGuard(request, env, license.clientId, cors);
    if (mgrDenied) return mgrDenied;
    const capped = await secLimit(env, 'payacct', license.clientId, secNum(env.PAYMENT_ACCOUNTS_HOURLY_LIMIT, 120), 3600, 'payment-account changes', cors);
    if (capped) return capped;
  }

  if (body.action === 'add') {
    const name = String(body.name || '').trim();
    if (!name) return reply({ error: 'Enter an account name.' }, 400);
    const accounts = await getAccounts(env, groupId);
    accounts.push({ id: randomToken(10), name, branchClientId: null, createdAt: Date.now() });
    await saveAccounts(env, groupId, accounts);
    return reply({ accounts });
  }

  if (body.action === 'setBranch') {
    const accounts = await getAccounts(env, groupId);
    const account = accounts.find((a) => a.id === body.accountId);
    if (!account) return reply({ error: 'Account not found.' }, 404);

    const branchClientId = String(body.branchClientId || '').trim();
    if (branchClientId) {
      const memberIds = record.branchGroupId ? await getBranchGroupMembers(env, record.branchGroupId) : [record.id];
      if (!memberIds.includes(branchClientId)) {
        return reply({ error: 'That branch is not part of this shop\u2019s branch group.' }, 400);
      }
      account.branchClientId = branchClientId;
    } else {
      account.branchClientId = null;
    }
    await saveAccounts(env, groupId, accounts);
    return reply({ accounts });
  }

  if (body.action === 'remove') {
    const accounts = await getAccounts(env, groupId);
    const remaining = accounts.filter((a) => a.id !== body.accountId);
    await saveAccounts(env, groupId, remaining);
    return reply({ accounts: remaining });
  }

  return reply({ error: 'Unknown action.' }, 400);
}
