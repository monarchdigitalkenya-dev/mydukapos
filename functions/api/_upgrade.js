// functions/api/_upgrade.js — shared helper, NOT a route (zip 286). The ONE place that turns a trial / demo link into a PERMANENT shop.
// Used by the owner's "Confirm payment" (owner-confirm.js) and by the shop's own M-Pesa prompt (license-upgrade.js), so both do exactly the same thing.
//
// Safe to call again (a retry, a second poll): the billing write is marked per shop, so it happens once, and setting the shop permanent twice changes nothing.

import { saveLicense } from './_license.js';
import { migrateShopToDatabase } from './_migrate.js';
import { buildQuote, completePurchase } from './_billing.js';

export async function applyPermanentUpgrade(env, record, { method = 'owner-confirmed', receipt = '', quote = null, waitUntil = null } = {}) {
  // Base tier covers 1 primary shop instance + 1 branch, so branchAllowance starts at 1 — never overwritten if this record was somehow already
  // permanent with a higher allowance (re-running must not claw back add-ons already granted).
  const wasPermanent = record.type === 'permanent';           // only a REAL upgrade starts billing; re-confirming a shop that was already permanent never subscribes it
  if (!wasPermanent) {
    // billing first (the licence still reads "demo" until the next save): if this fails nothing has changed and the retry starts clean; if the save below fails the retry
    // finds the billing already written (the payment marker makes it a no-op) and finishes the upgrade. A shop can never end up permanent AND free by accident.
    const q = quote || await buildQuote(env, { kind: 'link', product: record.product });
    await completePurchase(env, record, { purchase: { id: 'upgrade:' + record.id }, quote: q, method, receipt, amount: q.total });
  }
  record.type = 'permanent';
  record.expiresAt = null;
  record.locked = false;
  record.confirmedAt = Date.now();
  record.branchAllowance = record.branchAllowance || 1;
  await saveLicense(env, record);

  // Becoming permanent = moving into its own database, with all the data the demo already has (verified; the old record is kept as a rollback copy).
  // Done after the reply so nobody is kept waiting; if it fails the shop simply stays a single record and the owner can use "Move to database" in the Storage tab.
  if (env.SHOP_STORE) {
    const move = migrateShopToDatabase(env, record.id).catch(() => {});
    if (typeof waitUntil === 'function') waitUntil(move); else await move;
  }
  return record;
}
