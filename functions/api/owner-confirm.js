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
import { applyPermanentUpgrade } from './_upgrade.js';
import { buildQuote, applyAddon, claimRef } from './_billing.js';

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
    const onceRef = `addon-confirm:${record.id}:${Math.floor(Date.now() / 15000)}`;
    const once = await claimRef(context.env, onceRef, { kind: 'addon-confirm', clientId: record.id, amount: 0 });
    if (!once.first) return jsonResponse({ client: record });
    try {
      record.branchAllowance = (record.branchAllowance || 0) + 1;
      record.branchAddonClaimed = false;
      await saveLicense(context.env, record);
      // a subscribed shop's branch allowance is the billing add-on (price from Owner Console -> Billing); a shop that predates billing is unchanged
      const mainRec = record.branchGroupId && !record.isMainBranch ? await getGroupMainRecord(context.env, record) : record;
      if (mainRec && mainRec.billing && mainRec.billing.cohort === 'new') {
        const quote = await buildQuote(context.env, { kind: 'extraBranch', record: mainRec });
        await applyAddon(context.env, mainRec, { ref: `addon:claim:${mainRec.id}:${Math.floor(Date.now() / 15000)}`, quote, method: 'owner-confirmed' });
      }
    } catch (e) {
      // zip 269: a storage hiccup must not leave the "already confirmed" marker behind - the owner's retry would be told "done" with nothing applied
      try { await context.env.mydukapos_kv.delete('bill-ref:' + onceRef); if (once.evtKey) await context.env.mydukapos_kv.delete(once.evtKey); } catch (e2) { /* the retry then waits out the 15 seconds */ }
      throw e;
    }
    return jsonResponse({ client: record });
  }

  // Default action: confirm the base permanent upgrade (zip 286: the work itself lives in _upgrade.js, shared with the shop's own M-Pesa prompt).
  // zip 304: "Make permanent" for a free / test / internal link says so (complimentary: no KES 3,000 sale is recorded); "Confirm payment" is a paid sale.
  await applyPermanentUpgrade(context.env, record, { method: body.complimentary === true ? 'complimentary' : 'owner-confirmed', receipt: String(body.receipt || '').slice(0, 40), waitUntil: context.waitUntil ? context.waitUntil.bind(context) : null });

  return jsonResponse({ client: record });
}
