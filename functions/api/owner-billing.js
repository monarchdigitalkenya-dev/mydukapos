// functions/api/owner-billing.js — Cloudflare Pages Function (zip 267). OWNER ONLY. Everything the Owner Console's Billing area does.
//   get                                  -> settings (the one pricing source), what a save will change, products, offers, launch/cohort summary
//   settings-save { patch }              -> validates, saves, audits; returns what changed and when it takes effect
//   cohort | grandfather                 -> who is exempt / would be in the new cohort; mark every existing shop exempt (additive, batched)
//   offers | offer-save | offer-state | offer-delete
//   shops { q } | shop { id } | shop-edit { id, patch, confirm }   -> per-shop licence panel (suspend / reactivate / comp / exempt / limits / paid-through)
//   pays | confirm-pay { id } | reject-pay { id }                    -> renewals and add-ons a shop says it paid ("I've made this payment")
//   ledger { cursor } | audit { clientId, cursor } | reverse { ref, note, confirm } | reward-review { clientId, rewardId, decision }
// Changes that suspend or materially change a customer's access need confirm:true (the screen asks first). Nothing here ever deletes shop data.
import { requireOwnerAuth } from './_owner-auth.js';
import { readState, shopMode } from './_state-store.js';
import { PRODUCTS, listClientSummaries, getLicense, saveLicense, getGroupMainRecord } from './_license.js';
import { subscriptionState, eatDateTime, enforcementOn } from './_billing-core.js';
import {
  getSettings, saveSettings, publicTerms, listOffers, saveOffer, setOfferState, deleteOffer, cohortPreview, grandfatherExisting, editShopBilling, shopView, listEvents, listAudit, reversePayment, reviewReward,
  refCodeFor, confirmManualRenewal, isLive,
} from './_billing.js';
import { listPays, loadPay, savePay, fulfillPay } from './billing-renew.js';

const json = (b, st) => new Response(JSON.stringify(b), { status: st || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const products = () => Object.keys(PRODUCTS).map((id) => ({ id, label: PRODUCTS[id].label }));

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  let b = {}; try { b = await request.json(); } catch (e) { return json({ error: 'Invalid request.' }, 400); }
  const actor = 'owner';
  switch (String(b.action || '')) {
    case 'get': {
      const s = await getSettings(env, { fresh: true });
      return json({ settings: s, terms: publicTerms(s), products: products(), offers: await listOffers(env), live: isLive(s), enforcing: enforcementOn(s), nowLabel: eatDateTime(Date.now()) });
    }
    case 'settings-save': {
      const r = await saveSettings(env, b.patch || {}, actor);
      return r.ok ? json({ ok: true, settings: r.settings, effect: r.effect, takesEffect: r.takesEffect, terms: publicTerms(r.settings) }) : json({ ok: false, errors: r.errors }, 400);
    }
    case 'cohort': return json(await cohortPreview(env));
    case 'grandfather': return json(await grandfatherExisting(env, actor));
    case 'offers': return json({ offers: await listOffers(env) });
    case 'offer-save': { const r = await saveOffer(env, b.offer || {}, actor); return r.ok ? json({ ok: true, offer: r.offer, offers: await listOffers(env) }) : json({ ok: false, errors: r.errors }, 400); }
    case 'offer-state': { const r = await setOfferState(env, String(b.id || ''), b.state, actor); return r.ok ? json({ ok: true, offers: await listOffers(env) }) : json({ ok: false, errors: r.errors }, 404); }
    case 'offer-delete': { const r = await deleteOffer(env, String(b.id || ''), actor); return r.ok ? json({ ok: true, offers: await listOffers(env) }) : json({ ok: false, errors: r.errors }, 404); }
    case 'shops': {
      const q = String(b.q || '').trim().toLowerCase(), now = Date.now();
      const rows = (await listClientSummaries(env)).filter((e) => e.type === 'permanent' && !e.deleted && e.source !== 'shared-demo'
        && (!q || (e.label || '').toLowerCase().includes(q) || (e.slug || '').toLowerCase().includes(q) || (e.phone || '').includes(q) || (e.clientName || '').toLowerCase().includes(q)))
        .slice(0, 300).map((e) => { const st = subscriptionState({ billing: e.billing }, now); return { id: e.id, label: e.label || e.slug, slug: e.slug, clientName: e.clientName, phone: e.phone, locked: e.locked, state: st.state, cohort: e.billing ? e.billing.cohort : 'grandfathered', paidThroughLabel: st.paidThrough ? eatDateTime(st.paidThrough) : '', price: st.price || 0, claim: !!(e.billing && e.billing.claim) }; });
      return json({ shops: rows });
    }
    case 'shop': {
      const rec = await getLicense(env, String(b.id || '')); if (!rec) return json({ error: 'Shop not found.' }, 404);
      const main = await getGroupMainRecord(env, rec);
      // staff in use across the shop's branches: readable for a shop in the default (single-record) storage mode; null for a shop moved to its own database
      let staffUsed = null;
      try {
        const ids = rec.branchGroupId ? await (await import('./_license.js')).getBranchGroupMembers(env, rec.branchGroupId) : [rec.id]; let n = 0, ok = true;
        for (const id of ids) { if ((await shopMode(env, id)) === 'do') { ok = false; break; } const st = (await readState(env, 'pos-data:state:' + id, {})) || {}; n += (Array.isArray(st.staff) ? st.staff : []).filter((x) => x && !x.removed).length; }
        staffUsed = ok ? n : null;
      } catch (e) { staffUsed = null; }
      const view = await shopView(env, rec); view.usage.staff = staffUsed;
      return json({ shop: { id: rec.id, label: rec.label || rec.slug, slug: rec.slug, phone: rec.phone, email: rec.email, locked: !!rec.locked, product: rec.product, branchGroupId: rec.branchGroupId || null, isMainBranch: !!rec.isMainBranch, mainId: main ? main.id : rec.id },
        billing: view, audit: (await listAudit(env, { clientId: rec.id, limit: 30 })).rows, refCode: (rec.billing && rec.billing.refCode) || '', rewards: (rec.billing && rec.billing.rewards) || [] });
    }
    case 'shop-edit': {
      const r = await editShopBilling(env, String(b.id || ''), { ...(b.patch || {}), confirm: b.confirm === true, note: b.note }, actor);
      return json(r, r.ok ? 200 : r.needConfirm ? 409 : 400);
    }
    case 'refcode': { const rec = await getLicense(env, String(b.id || '')); if (!rec) return json({ error: 'Shop not found.' }, 404); return json({ code: await refCodeFor(env, rec) }); }
    case 'pays': return json({ pays: await listPays(env) });
    case 'confirm-pay': {
      const p = await loadPay(env, b.id); if (!p) return json({ error: 'Payment not found.' }, 404);
      if (p.status === 'paid') return json({ ok: true, pay: { id: p.id, status: p.status } });
      try { await fulfillPay(env, p, { receipt: String(b.receipt || '').slice(0, 40), method: 'owner-confirmed' }); } catch (e) { return json({ error: (e && e.message) || 'Could not apply the payment.' }, 409); }
      return json({ ok: true, pay: { id: p.id, status: p.status, paidThrough: p.paidThrough } });
    }
    case 'reject-pay': {
      const p = await loadPay(env, b.id); if (!p) return json({ error: 'Payment not found.' }, 404);
      if (p.status === 'paid') return json({ error: 'Already paid and applied.' }, 400);
      p.status = 'rejected'; await savePay(env, p);
      const rec = await getLicense(env, p.clientId); if (rec && rec.billing && rec.billing.claim && rec.billing.claim.id === p.id) { delete rec.billing.claim; await saveLicense(env, rec); }
      return json({ ok: true });
    }
    case 'manual-renewal': {
      const r = await confirmManualRenewal(env, String(b.id || ''), { cycles: Math.min(12, Math.max(1, Math.round(Number(b.cycles)) || 1)), receipt: b.receipt, note: b.note, amount: b.amount }, actor);
      return json(r, r.ok ? 200 : 400);
    }
    case 'ledger': return json(await listEvents(env, { cursor: b.cursor }));
    case 'audit': return json(await listAudit(env, { clientId: String(b.clientId || ''), cursor: b.cursor }));
    case 'reverse': {
      if (b.confirm !== true) return json({ needConfirm: true, summary: ['Mark this payment as refunded / reversed. A referral reward it earned is voided if unused. Shop data and access are not changed.'] }, 409);
      const r = await reversePayment(env, String(b.ref || ''), actor, { note: b.note });
      return json(r, r.ok ? 200 : 404);
    }
    case 'reward-review': {
      const r = await reviewReward(env, String(b.clientId || ''), String(b.rewardId || ''), b.decision === 'approve' ? 'approve' : 'void', actor);
      return json(r, r.ok ? 200 : 400);
    }
    default: return json({ error: 'Unknown action.' }, 400);
  }
}
