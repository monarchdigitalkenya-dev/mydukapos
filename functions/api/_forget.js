// functions/api/_forget.js — shared helper, NOT a route (zip 263).
//
// When a link is deleted for good (Trash -> Empty trash / Delete forever, or after 30 days), the person's contact details must not stay behind:
// nobody who later signs up or buys again with that phone number or email may be told "this phone or email exists". This removes, for ONE purged link:
//   * its email recovery link (account-recovery.js),
//   * the website account (dashboard login) that belongs to it: the account whose shop it was, or one carrying its phone / email, but ONLY when no other
//     live link still uses that phone / email (a person with another shop keeps their login),
//   * any "Get my own link" request that created it (name, phone and email were kept there; see get-my-link.js).
// Each step is best effort and independent: a failure in one never stops the deletion or the others.

import { getAccount, deleteAccount, readIndex as readAccountIndex, intlPhone, normalizeEmail, realEmailOf, resolveLoginId } from './_account.js';
import { listClientSummaries } from './_license.js';

export async function forgetClientContacts(env, clientId, record) {
  try { const { removeClientLink } = await import('./account-recovery.js'); await removeClientLink(env, clientId); } catch (e) { /* recoverable by hand */ }
  try {
    const email = normalizeEmail(record && record.email), phone = intlPhone(record && record.phone);
    // other live links that still carry the same contact keep the person's login alive
    const live = (await listClientSummaries(env)).filter((e) => e.id !== clientId && !e.deleted);
    const stillUsed = (e, p) => live.some((l) => (e && normalizeEmail(l.email) === e) || (p && intlPhone(l.phone) === p));
    const keys = new Set();
    if (email) keys.add(email);
    if (phone) { const k = await resolveLoginId(env, phone); if (k) keys.add(k); }
    for (const a of await readAccountIndex(env)) if (a.demoClientId === clientId) keys.add(a.email);
    for (const key of keys) {
      const acct = await getAccount(env, key);
      if (!acct) continue;
      const ownsOther = acct.demoClientId && acct.demoClientId !== clientId && live.some((l) => l.id === acct.demoClientId);
      if (ownsOther || stillUsed(realEmailOf(acct), intlPhone(acct.phone))) continue;
      await deleteAccount(env, acct.email);
    }
  } catch (e) { /* the shop is gone either way */ }
  try {
    const idx = JSON.parse((await env.mydukapos_kv.get('buy-index:v1')) || '[]'), keep = [];
    for (const id of idx) {
      const r = JSON.parse((await env.mydukapos_kv.get('buy:' + id)) || 'null');
      if (r && r.clientId === clientId) await env.mydukapos_kv.delete('buy:' + id); else keep.push(id);
    }
    if (keep.length !== idx.length) await env.mydukapos_kv.put('buy-index:v1', JSON.stringify(keep));
  } catch (e) { /* the request record is harmless without the link */ }
}
