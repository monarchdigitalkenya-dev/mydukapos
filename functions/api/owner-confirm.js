// functions/api/owner-confirm.js — Cloudflare Pages Function
//
// Backs the "Confirm Payment" button in the 🔗 Licenses tab, shown next to
// any demo link whose shop clicked "I have made this payment" on their own
// lock screen (see license-claim-payment.js) — used for the legacy
// self-serve upgrade path. Most permanent links are now generated directly
// by ringing up a License item at the Sales Counter (see index.html), which
// needs no confirmation step since the owner is the one taking the payment.
// This manual path stays available for a shop that paid on their own
// without you physically ringing it up. Direct replacement for
// master-confirm.js, gated by owner session instead of MASTER_ADMIN_PASSWORD.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireOwnerAuth } from './_owner-auth.js';
import { getLicense, saveLicense, getGroupMainRecord } from './_license.js';
import { migrateShopToDatabase } from './_migrate.js';
import { buildQuote, completePurchase, applyAddon, claimRef } from './_billing.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

  const record = await getLicense(context.env, body.c);
  if (!record) return jsonResponse({ error: 'Client not found.' }, 404);

  // Marks a claimed base-tier payment as FALSE — the client clicked "I have
  // made this payment" but nothing actually arrived (checked the M-Pesa/
  // till statement and it's not there). Just clears the claim flag so the
  // client goes back to seeing the normal "pay to upgrade" screen instead
  // of "awaiting confirmation" — does NOT lock or otherwise penalize the
  // link, since a false claim might just be a genuine mistake (wrong
  // number, paid but under a different name) rather than bad faith.
  if (body.action === 'reject-payment') {
    record.paymentClaimed = false;
    record.paymentClaimedAt = null;
    await saveLicense(context.env, record);
    return jsonResponse({ client: record });
  }

  // Same idea for a branch add-on claim — clears branchAddonClaimed on the
  // group's main record without granting the extra branch slot.
  if (body.action === 'reject-addon') {
    const mainRecord = record.branchGroupId && !record.isMainBranch
      ? await getGroupMainRecord(context.env, record)
      : record;
    mainRecord.branchAddonClaimed = false;
    mainRecord.branchAddonClaimedAt = null;
    await saveLicense(context.env, mainRecord);
    return jsonResponse({ client: mainRecord });
  }

  // Branch add-on confirmation: doesn't touch type/expiry at all, just
  // grants one more branch slot on top of whatever the base tier already
  // included. Kept as a distinct action (instead of inferring it from
  // record.type === 'permanent') so an admin can't accidentally re-confirm
  // an already-permanent record as a fresh base-tier upgrade and reset its
  // confirmedAt for no reason.
  if (body.action === 'confirm-addon') {
    if (record.type !== 'permanent') {
      return jsonResponse({ error: 'Confirm the base KES 3,000 upgrade before confirming a branch add-on.' }, 400);
    }
    // zip 267: pressed twice (a double-click or a retry after a timeout) it is the same confirmation: one extra branch, once. The claim marker is per shop and per 15 seconds.
    const once = await claimRef(context.env, `addon-confirm:${record.id}:${Math.floor(Date.now() / 15000)}`, { kind: 'addon-confirm', clientId: record.id, amount: 0 });
    if (!once.first) return jsonResponse({ client: record });
    record.branchAllowance = (record.branchAllowance || 0) + 1;
    record.branchAddonClaimed = false;
    await saveLicense(context.env, record);
    // a subscribed shop's branch allowance is the billing add-on (price from Owner Console -> Billing); a shop that predates billing is unchanged
    const mainRec = record.branchGroupId && !record.isMainBranch ? await getGroupMainRecord(context.env, record) : record;
    if (mainRec && mainRec.billing && mainRec.billing.cohort === 'new') {
      const quote = await buildQuote(context.env, { kind: 'extraBranch', record: mainRec });
      await applyAddon(context.env, mainRec, { ref: `addon:claim:${mainRec.id}:${Math.floor(Date.now() / 15000)}`, quote, method: 'owner-confirmed' });
    }
    return jsonResponse({ client: record });
  }

  // Default action: confirm the base KES 3,000 permanent upgrade. Base tier
  // covers 1 primary shop instance + 1 branch, so branchAllowance starts at
  // 1 here — never overwritten if this record was somehow already
  // permanent with a higher allowance (e.g. re-running confirm by mistake
  // shouldn't claw back add-ons already granted).
  const wasPermanent = record.type === 'permanent';                     // zip 267: only a REAL upgrade starts billing; re-confirming a shop that was already permanent never subscribes it
  if (!wasPermanent) {
    // billing first (the licence still reads "demo" until the next save): if this fails nothing has changed and the retry starts clean; if the save below fails the retry finds the
    // billing already written (the payment marker makes it a no-op) and finishes the upgrade. A shop can therefore never end up permanent AND free by accident.
    const quote = await buildQuote(context.env, { kind: 'link', product: record.product });
    await completePurchase(context.env, record, { purchase: { id: 'upgrade:' + record.id }, quote, method: 'owner-confirmed', amount: quote.total });
  }
  record.type = 'permanent';
  record.expiresAt = null;
  record.locked = false;
  record.confirmedAt = Date.now();
  record.branchAllowance = record.branchAllowance || 1;
  await saveLicense(context.env, record);

  // Becoming permanent = moving into its own database, with all the data the demo already has (verified; the old record is kept as a
  // rollback copy). Done after the reply so the owner is not kept waiting; if it fails the shop simply stays a single record and the
  // owner can use "Move to database" in the Storage tab.
  if (context.env.SHOP_STORE) {
    const move = migrateShopToDatabase(context.env, record.id).catch(() => {});
    if (typeof context.waitUntil === 'function') context.waitUntil(move); else await move;
  }

  return jsonResponse({ client: record });
}
