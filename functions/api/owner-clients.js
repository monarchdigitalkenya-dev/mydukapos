// functions/api/owner-clients.js — Cloudflare Pages Function
//
// Backs the 🔗 Licenses tab in index.html (owner-only — see _owner-auth.js).
// This is the direct replacement for the old master-clients.js, just gated
// by the owner session token instead of MASTER_ADMIN_PASSWORD.
//
// GET  -> list client links, newest first. Optional ?q=<text> filters by
//         label/subdomain (handy once you have a lot of these). This reads
//         the lightweight per-client SUMMARY kept in the index (see
//         listClientSummaries in _license.js) rather than fetching every
//         client's full record — the old version did one KV read per
//         client, which works fine at a few dozen clients but hits
//         Cloudflare's per-request subrequest cap long before 10,000. The
//         summary already carries everything this list needs.
// POST -> create a new client link directly (used by the 🔗 Licenses tab's
//         "Generate Demo Link" button, and internally by the Sales Counter
//         when a License item is checked out — see index.html). Body:
//         { type: "demo" | "permanent", label?: string, product?: "shop"|"hotel" }.
//         The label also becomes the client's subdomain (e.g. "George's
//         Hardware" -> georges-hardware.mydukapos.store), auto-deduplicated
//         if that subdomain is already taken.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireOwnerAuth, getOwnerAccount } from './_owner-auth.js';
import { proofMatches, isSealedProof } from './_device-auth.js';
import { staffRecord } from './_staff-auth.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';
import { listClientSummaries, createClient, evaluateLicense, listProducts, clientLink, getRootDomain, purgeExpiredTrash } from './_license.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet(context) {
  const ok = await requireOwnerAuth(context);
  if (!ok) return jsonResponse({ error: 'Unauthorized' }, 401);

  const { request, env } = context;
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  const trashOnly = url.searchParams.get('trash') === '1';

  // Sweep anything past its 30-day trash window before listing — cheap (one index read; per-client
  // KV work only for entries actually old enough), and keeps Trash self-cleaning with no cron needed.
  if (trashOnly) await purgeExpiredTrash(env);

  const summaries = await listClientSummaries(env, { q, trashOnly });
  // The owner's own account has a real, permanent client record behind it
  // (see _owner-auth.js — this is what lets the owner actually use Shop POS
  // themselves, not just the admin dashboard). It's infrastructure, not a
  // client in the business sense, so it never belongs in a list where Lock/
  // Delete/Extend sit one click away — deleting or locking it would break
  // the owner's own POS access, not a real client's.
  const ownerAccount = await getOwnerAccount(env);
  const filtered = ownerAccount
    ? summaries.filter((s) => s.id !== ownerAccount.ownerClientId)
    : summaries;

  const origin = url.origin;
  const enriched = filtered.map((summary) => {
    const evalResult = evaluateLicense(summary); // summary carries type/locked/expiresAt
    return {
      ...summary,
      link: clientLink(env, summary, origin),
      valid: evalResult.valid,
      liveReason: evalResult.reason,
      remainingMs: evalResult.remainingMs !== undefined ? evalResult.remainingMs : null,
    };
  });

  // The per-person quote/payment ledger (see GROUP_INCOME_KEY in
  // owner-lock.js) — fetched here too, alongside the client list, so the
  // grouped client view has it ready without a separate round trip when a
  // person's detail is opened.
  const groupIncomeRaw = await env.mydukapos_kv.get('owner-group-income:v1');
  const groupIncome = groupIncomeRaw ? JSON.parse(groupIncomeRaw) : {};

  return jsonResponse({
    clients: enriched,
    groupIncome,
    serverNow: Date.now(),
    products: listProducts(),
    rootDomain: getRootDomain(env),
  });
}

// A staff member who was given the 🔗 Generate Link tab may create links WITHOUT the owner's session: they prove who they are with
// their own PIN (SHA-256 typed now), checked against the staff record the owner account holds. Nothing else is opened to staff.
async function staffMayGenerate(context, body) {
  const st = body && body.staff;
  if (!st || !st.id) return null;
  const { env } = context;
  const proof = String(st.proof || '');
  if (proof.length < 32 || proof.length > 300 || isSealedProof(proof)) return { error: 'Enter your PIN.', status: 400 };
  const acct = await getOwnerAccount(env);
  if (!acct || !acct.ownerClientId) return { error: 'Unauthorized', status: 401 };
  const rl = await checkRateLimit(env, 'staffPin', acct.ownerClientId + ':' + String(st.id).slice(0, 80));
  if (!rl.ok) return { rl };
  let m;
  try { m = await staffRecord(env, acct.ownerClientId, String(st.id).slice(0, 80)); } catch (e) { return { error: 'Busy — try again.', status: 503 }; }
  if (!m || m.removed || !m.pinHash) return { error: 'This staff account is not on the server yet — wait for the next sync.', status: 403 };
  if (!(await proofMatches(proof, m.pinHash))) return { error: 'Incorrect PIN.', status: 403 };
  const roles = Array.isArray(m.roles) ? m.roles.map(String) : [];
  if (!(m.isManager || roles.includes('sales-tab'))) return { error: 'You were not given the Generate Link tab.', status: 403 };
  return { ok: true, name: m.name };
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }
  const ok = await requireOwnerAuth(context);
  let byStaff = null;
  if (!ok) {
    const r = await staffMayGenerate(context, body);
    if (!r) return jsonResponse({ error: 'Unauthorized' }, 401);
    if (r.rl) return rateLimitResponse('PIN attempts for this staff member', r.rl, {});
    if (!r.ok) return jsonResponse({ error: r.error }, r.status);
    byStaff = r.name;
  }
  if (byStaff && body.action) return jsonResponse({ error: 'Owner only.' }, 403);

  const type = body.type === 'permanent' ? 'permanent' : 'demo';
  const record = await createClient(context.env, type, body.label, body.product, {
    clientName: body.clientName,
    preferredName: body.preferredName,
    phone: body.phone,
    email: body.email,
    svcType: body.svcType,          // Services POS business type (optional)
  });
  const origin = new URL(context.request.url).origin;

  return jsonResponse({ client: record, link: clientLink(context.env, record, origin) });
}
