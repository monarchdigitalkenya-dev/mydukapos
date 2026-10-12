// functions/api/branches.js — Cloudflare Pages Function
//
// Branches: a shop can spin off a fully independent sibling POS — its own
// subdomain, license, staff, sales, and stock — that's tracked as part of
// the same "branch group" as the shop that created it. There's no fixed
// hierarchy in storage: a branch group is just a flat list of client ids
// (see getBranchGroupMembers/addToBranchGroup in _license.js), and "which
// one is the main branch" is a single boolean flag (isMainBranch) on
// whichever client record currently holds it — reassignable at any time via
// the 'setMain' action below.
//
// Trust model: same as every other endpoint in this app — the caller's own
// client id (`c`) is treated as sufficient proof of identity, matching how
// pos-sync.js and the rest of this single-owner-scale tool already work.
// There's no separate password check here beyond having a currently-valid
// license, same as using the app at all.
//
// Actions (all POST, JSON body):
//   { action: 'create', c }
//     Creates a new branch — its own independent stock, staff, and sales —
//     under the caller's group (creating the group, with the caller as its
//     first/main member, if it doesn't have one yet). No name is supplied
//     by the caller — the slug is auto-generated as mainslug1, mainslug2,
//     etc. (see pickNextBranchSlug in _license.js). The branch's actual
//     business name comes later, from whatever the person running it enters
//     during the app's own setup (registerBusiness()), synced back like any
//     other POS data — Owner Console's Clients tab prefers that synced name
//     over the raw slug wherever one exists.
//   { action: 'setMain', c, targetClientId }
//     Moves the isMainBranch flag to targetClientId, which must already be
//     in the caller's branch group.
//   { action: 'summary', c }
//     Returns every member of the caller's branch group (or just the caller
//     alone, isBranchGroup:false, if it isn't in one) with enough summary
//     data for a "Branches" panel: label, isMainBranch, staff list, and a
//     handful of computed stats pulled from each member's synced state.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense, getLicense, saveLicense, createClient, getBranchGroupMembers, addToBranchGroup, removeFromBranchGroup, randomToken, pickNextBranchSlug, getGroupMainRecord, deleteClient } from './_license.js';
import { seedInitialState } from './pos-sync.js';
import { readState } from './_state-store.js';
import { linkNewClientToSameAccount, removeClientLink } from './account-recovery.js';
import { deviceGuard } from './_device-auth.js';
import { corsHeadersFor } from './_cors.js';
import { managerGuard, secLimit, secNum } from './_sec-guard.js';
import { ensureShopCallbackKeys } from './_callback-key.js';

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

function stateKey(clientId) {
  return `pos-data:state:${clientId}`;
}

async function getSyncedState(env, clientId) {
  return await readState(env, stateKey(clientId), null);
}

// Re-derives the same handful of numbers the in-app Dashboard shows, from
// the raw synced state — kept deliberately simple (not the full breakdown
// the Dashboard itself computes) since this is a summary panel, not the
// branch's own detailed view. Missing/malformed data just yields zeros
// rather than failing the whole summary for every other branch.
function computeBranchStats(state) {
  const empty = { todayRevenue: 0, monthRevenue: 0, stockValue: 0, lowStockCount: 0, itemCount: 0, staffCount: 0 };
  if (!state || typeof state !== 'object') return empty;

  const salesLog = Array.isArray(state.salesLog) ? state.salesLog : [];
  const inventory = Array.isArray(state.inventory) ? state.inventory : [];
  const staff = Array.isArray(state.staff) ? state.staff : [];
  const lowStockThreshold = typeof state.lowStockThreshold === 'number' ? state.lowStockThreshold : 3;

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  let todayRevenue = 0, monthRevenue = 0;
  salesLog.forEach((s) => {
    if (s.voided || s.paid === false || !s.timestamp) return;
    const lineTotal = Array.isArray(s.items) ? s.items.reduce((sum, it) => sum + (it.price || 0) * (it.qty || 0), 0) : 0;
    const t = new Date(s.timestamp).getTime();
    if (s.timestamp.slice(0, 10) === today) todayRevenue += lineTotal;
    if (t >= monthStart) monthRevenue += lineTotal;
  });

  const stockedItems = inventory.filter((p) => (p.type || 'item') !== 'service');
  let stockValue = 0;
  stockedItems.forEach((p) => {
    stockValue += (p.qty || 0) * (p.wholesalePrice || 0);
    if (p.dualUnit) stockValue += (p.pieceQty || 0) * (p.pieceWholesalePrice || 0);
  });
  const lowStockCount = stockedItems.filter((p) => (p.qty || 0) <= lowStockThreshold).length;

  return {
    todayRevenue,
    monthRevenue,
    stockValue,
    lowStockCount,
    itemCount: stockedItems.length,
    staffCount: staff.length,
  };
}

// zip 263: the creation of a branch, shared by the "Add Branch" button (below) and by "Get my own link" (get-my-link.js, when a buyer who already has a shop
// buys another one). `record` is a permanent client already in (or about to found) a branch group; `contact` = { phone, email } of the person the branch is for.
export async function createBranchFor(env, record, branchName, contact) {
  if (!record.branchGroupId) {
    record.branchGroupId = randomToken(12);
    record.isMainBranch = true;
    await saveLicense(env, record);
    await addToBranchGroup(env, record.branchGroupId, record.id);
  }
  const mainRecordForLimit = await getGroupMainRecord(env, record);
  // Numbering is always based on the group's actual main branch's slug
  // (mainslug1, mainslug2...), not necessarily the caller's own — any
  // branch can click "Add Branch," but the numbering stays anchored to
  // whichever member currently holds isMainBranch, so it reads sensibly
  // regardless of who added it or whether the main branch was reassigned
  // since.
  const mainSlug = mainRecordForLimit.slug || record.slug;

  const nextSlug = await pickNextBranchSlug(env, mainSlug);

  // Branch naming (spec: let the caller name the branch at creation time
  // instead of waiting for whoever opens it to type a business name).
  // branchName is optional free text from the creation form; when blank
  // we fall back to the old behaviour of just using the raw slug, so
  // nothing breaks for a caller that doesn't send it.
  const branchLabel = branchName || nextSlug;

  // The branch's own synced state (businessName, ownerName, password
  // hashes, staff) needs seeding BEFORE anyone opens its link, so that
  // link can skip Sign Up entirely and drop straight into "who's
  // logging in?" with just the admin — see seedInitialState below. Pull
  // it from the CALLER's own synced state, since the caller (whoever
  // clicked "Generate Branch Link") is the admin the new branch should
  // open as.
  const callerState = await getSyncedState(env, record.id);
  // "Admin" in the new branch's login picker shows this name — just the
  // first word of the caller's own registered owner name, so a branch
  // opened by "Samuel Mugwe" shows "Samuel (Admin)", not the whole
  // business's owner name in full every time.
  const callerOwnerName = String((callerState && callerState.ownerName) || '').trim();
  const adminFirstName = callerOwnerName ? callerOwnerName.split(/\s+/)[0] : '';

  const branch = await createClient(env, 'permanent', branchLabel, record.product, {
    ...(contact || {}),
    branchGroupId: record.branchGroupId,
    isMainBranch: false,
    // Inherits the calling shop's own clientName (the owner's private
    // record of who this actually is — see createClient() above) so a
    // new branch groups together with its siblings in the owner's
    // Permanent Clients list automatically, exactly like they already do
    // if the owner sets it manually afterward. Previously this was left
    // blank, so every new branch stood alone until the owner noticed and
    // renamed it to match — an easy thing to forget, and the reason two
    // branches of the same real person could show as two separate
    // entries. A caller with no clientName of their own (never set)
    // leaves the new branch exactly as before — nothing to inherit.
    clientName: record.clientName || '',
  });
  await addToBranchGroup(env, record.branchGroupId, branch.id);
  await ensureShopCallbackKeys(env, branch.id);          // zip 185: the new branch starts with signed payment-callback URLs

  // Seed the branch's own pos-sync record so its link opens straight to
  // the login picker (never Sign Up) with the admin as the ONLY option —
  // staff is deliberately seeded empty; staff never carry over to a new
  // branch automatically (see the 'migrateStaff' action below for the
  // deliberate, one-at-a-time way to move someone across branches).
  await seedInitialState(env, branch.id, {
    businessName: branchName || branch.label || nextSlug,
    ownerName: adminFirstName,
    pwHash: (callerState && callerState.pwHash) || '',
    adminPwHash: (callerState && callerState.adminPwHash) || '',
    staff: [],
  });

  // If the caller has email recovery linked, the new branch shares that
  // same email+password immediately — same unified-password model as
  // any other branch link (see account-recovery.js's multi-branch
  // note). A no-op if the caller never linked an email.
  await linkNewClientToSameAccount(env, record.id, branch.id);


  return { branch, branchLabel };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const clientId = license.clientId;
  // PAIRED DEVICES ONLY when the shop has switched that on (see _device-auth.js); otherwise no change
  const deviceDenied = await deviceGuard(request, env, clientId, corsHeadersFor(request, env));
  if (deviceDenied) return deviceDenied;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const record = await getLicense(env, clientId);
  if (!record) return jsonResponse({ error: 'Client not found.' }, 404);

  // zip 185: creating a branch mints a permanent licence and deleting one erases a shop's data — when the shop requires staff sessions, only
  // the Admin / a manager may do either (no change for shops that have not switched that on).
  if (body.action === 'create' || body.action === 'delete') {
    const mgrDenied = await managerGuard(request, env, clientId, CORS_HEADERS);
    if (mgrDenied) return mgrDenied;
  }

  if (body.action === 'create') {
    // A demo account creating a branch used to hand that branch a full
    // permanent license, regardless of the demo status of the account
    // creating it — a real gap, since it meant a demo could effectively
    // mint itself a free permanent shop. Branches are a paid-tier feature;
    // a demo simply can't create one at all.
    if (record.type === 'demo') {
      return jsonResponse({ error: 'Branches are disabled on the demo version. Upgrade to a permanent license to add branches.' }, 403);
    }

    // First branch ever created under this client — found a new group with
    // the caller as its main branch. Every subsequent branch just joins the
    // group that already exists.
    if (!record.branchGroupId) {
      record.branchGroupId = randomToken(12);
      record.isMainBranch = true;
      await saveLicense(env, record);
      await addToBranchGroup(env, record.branchGroupId, record.id);
    }

    // zip 185: a cap per group per day (default 20, BRANCH_CREATE_DAILY_LIMIT) so a leaked link cannot mint unlimited permanent licences.
    const capped = await secLimit(env, 'branch-create', record.branchGroupId, secNum(env.BRANCH_CREATE_DAILY_LIMIT, 20), 86400, 'branches created', CORS_HEADERS);
    if (capped) return capped;

    // Branch limit removed: any client holding a permanent link (the only
    // way to reach this point — demos are blocked above) can create as
    // many branches as they want. branchAllowance/branchAddonClaimed are
    // left in place on the license record and still returned by the
    // 'summary' action below for any UI that reads them, but they no
    // longer gate creation here — there used to be a tiered-billing check
    // (base tier included 1 branch, KES 1,500 per additional one) that
    // returned a 402 'branch_limit' error once the group's member count
    // reached the main record's branchAllowance; that cap no longer applies.
    const made = await createBranchFor(env, record, String(body.branchName || '').trim().slice(0, 80));
    const branch = made.branch, branchLabel = made.branchLabel;

    return jsonResponse({ branch, branchName: branchLabel });
  }

  if (body.action === 'setMain') {
    const targetClientId = String(body.targetClientId || '');
    if (!record.branchGroupId) return jsonResponse({ error: 'This shop has no branches.' }, 400);

    const members = await getBranchGroupMembers(env, record.branchGroupId);
    if (!members.includes(targetClientId)) {
      return jsonResponse({ error: 'That branch is not part of this group.' }, 400);
    }

    for (const memberId of members) {
      const memberRecord = await getLicense(env, memberId);
      if (!memberRecord) continue;
      const shouldBeMain = memberId === targetClientId;
      if (memberRecord.isMainBranch !== shouldBeMain) {
        memberRecord.isMainBranch = shouldBeMain;
        await saveLicense(env, memberRecord);
      }
    }

    return jsonResponse({ ok: true });
  }

  if (body.action === 'summary') {
    if (!record.branchGroupId) {
      return jsonResponse({ isBranchGroup: false, branchAllowance: record.branchAllowance || 0 });
    }

    const mainRecordForSummary = await getGroupMainRecord(env, record);
    const members = await getBranchGroupMembers(env, record.branchGroupId);
    const branches = [];
    for (const memberId of members) {
      const memberRecord = await getLicense(env, memberId);
      if (!memberRecord) continue;
      const state = await getSyncedState(env, memberId);
      const stats = computeBranchStats(state);
      branches.push({
        id: memberRecord.id,
        label: memberRecord.label,
        slug: memberRecord.slug,
        isMainBranch: !!memberRecord.isMainBranch,
        isSelf: memberId === clientId,
        staff: Array.isArray(state && state.staff)
          ? state.staff.map((s) => ({ name: s.name, roles: s.roles || [] }))
          : [],
        ...stats,
      });
    }

    return jsonResponse({
      isBranchGroup: true,
      branches,
      branchAllowance: mainRecordForSummary.branchAllowance || 0,
      branchesUsed: Math.max(0, members.length - 1),
      branchAddonClaimed: !!mainRecordForSummary.branchAddonClaimed,
      addonPriceKes: 1500,
    });
  }

  if (body.action === 'detail') {
    // Read-only pull of ANOTHER branch's actual records (sales, expenses,
    // bills, stock movements, inventory...) — not just the summary
    // numbers 'summary' above returns. Used by the branch-switcher
    // dropdown on Daily Sales / Profits & Expenses / Stock Report / Bills
    // / Inventory so those tabs can show a specific branch's (or, with a
    // few calls combined client-side, ALL branches') real data rather
    // than just headline totals. Password hashes are stripped before
    // returning — nothing calling this needs them, and there's no reason
    // to put them on the wire for a "just looking" request.
    const targetClientId = String(body.targetClientId || '');
    if (!record.branchGroupId) return jsonResponse({ error: 'This shop has no branches.' }, 400);

    const members = await getBranchGroupMembers(env, record.branchGroupId);
    if (!members.includes(targetClientId)) {
      return jsonResponse({ error: 'That branch is not part of this group.' }, 400);
    }

    const state = await getSyncedState(env, targetClientId);
    const safeState = state ? { ...state } : {};
    delete safeState.pwHash;
    delete safeState.adminPwHash;
    return jsonResponse({ state: safeState });
  }

  if (body.action === 'delete') {
    // Permanently removes ONE branch from the caller's group — the license
    // link, its subdomain slug, its Licenses-tab index entry, its linked
    // account-recovery email (if any), and — unlike the generic
    // deleteClient() used for a plain license delete elsewhere — its
    // actual synced business data (sales, stock, expenses...) and backups
    // too, since a deleted branch has no other way to ever be reached
    // again and there's no reason to keep its data taking up storage.
    // Admin-only by the same trust model as every other action here (a
    // valid license for ANY member of the group is enough to call this) —
    // the UI only ever exposes this button on the admin-only Branches
    // panel, never to a staff member.
    const targetClientId = String(body.targetClientId || '');
    if (!record.branchGroupId) return jsonResponse({ error: 'This shop has no branches.' }, 400);
    if (!targetClientId) return jsonResponse({ error: 'No branch specified.' }, 400);
    const delCapped = await secLimit(env, 'branch-delete', record.branchGroupId, secNum(env.BRANCH_DELETE_HOURLY_LIMIT, 30), 3600, 'branch deletions', CORS_HEADERS);   // zip 185
    if (delCapped) return delCapped;

    const members = await getBranchGroupMembers(env, record.branchGroupId);
    if (!members.includes(targetClientId)) {
      return jsonResponse({ error: 'That branch is not part of this group.' }, 400);
    }

    const targetRecord = await getLicense(env, targetClientId);
    if (!targetRecord) return jsonResponse({ error: 'That branch no longer exists.' }, 404);

    // Can't delete the branch you're currently signed into — you'd lose
    // the link you're using mid-request. Reassign Main first (setMain)
    // if the target is the main branch; deleting the main branch out
    // from under the group would leave no member flagged main at all.
    if (targetClientId === clientId) {
      return jsonResponse({ error: "You can't delete the branch you're currently using. Open a different branch first." }, 400);
    }
    if (targetRecord.isMainBranch) {
      return jsonResponse({ error: 'Make a different branch "Main" before deleting this one.' }, 400);
    }

    await removeFromBranchGroup(env, record.branchGroupId, targetClientId);
    await deleteClient(env, targetClientId);
    await removeClientLink(env, targetClientId);
    await env.mydukapos_kv.delete(stateKey(targetClientId));
    // Backups are stored per-client under pos-data:backup:<id>:<n> — listed
    // rather than guessed, since the count varies per shop.
    try {
      const backupPrefix = `pos-data:backup:${targetClientId}:`;
      const listed = await env.mydukapos_kv.list({ prefix: backupPrefix });
      for (const k of listed.keys) {
        await env.mydukapos_kv.delete(k.name);
      }
    } catch (e) {
      // Backup cleanup is best-effort — the branch is already gone from
      // the group and its license either way, which is what matters.
    }

    return jsonResponse({ ok: true, deletedLabel: targetRecord.label });
  }

  if (body.action === 'migrateStaff') {
    // Moves ONE staff member's record from the caller's own branch to
    // another branch in the same group — the Staff tab's "Move to
    // Branch" control. Staff never move automatically (a new branch is
    // always seeded with an empty staff list — see 'create' above); this
    // is the deliberate, one-at-a-time way to relocate someone instead.
    // The member keeps their PIN, roles, and shift history — it's the
    // same record, just filed under a different branch's state from now
    // on, so they simply stop being able to check in at the old branch
    // and start being able to at the new one.
    const targetClientId = String(body.targetClientId || '');
    const staffId = String(body.staffId || '');
    if (!record.branchGroupId) return jsonResponse({ error: 'This shop has no branches.' }, 400);
    if (!staffId) return jsonResponse({ error: 'No staff member specified.' }, 400);

    const members = await getBranchGroupMembers(env, record.branchGroupId);
    if (!members.includes(targetClientId)) {
      return jsonResponse({ error: 'That branch is not part of this group.' }, 400);
    }
    if (targetClientId === clientId) {
      return jsonResponse({ error: 'Pick a different branch to move this staff member to.' }, 400);
    }

    const sourceState = await getSyncedState(env, clientId);
    const sourceStaff = Array.isArray(sourceState && sourceState.staff) ? sourceState.staff : [];
    const member = sourceStaff.find((s) => s.id === staffId);
    if (!member) return jsonResponse({ error: 'Could not find that staff member here.' }, 404);

    const targetState = await getSyncedState(env, targetClientId);
    const targetStaff = Array.isArray(targetState && targetState.staff) ? targetState.staff : [];
    if (targetStaff.some((s) => s.id === member.id)) {
      return jsonResponse({ error: 'That staff member is already at the destination branch.' }, 400);
    }

    const newSourceStaff = sourceStaff.filter((s) => s.id !== staffId);
    const newTargetStaff = [...targetStaff, member];

    await seedInitialState(env, clientId, { staff: newSourceStaff });
    await seedInitialState(env, targetClientId, { staff: newTargetStaff });

    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}
