// functions/api/_billing.js — shared helper, NOT a route (zip 267). Licensing / subscriptions / offers / referrals: STORAGE and FLOWS.
// The pure rules (settings, states, dates, discount maths) are in _billing-core.js; this file reads and writes KV and shop records.
//
// WHERE THINGS LIVE (all KV, like every other licence fact; no new tables, so no migration is needed):
//   billing-settings:v1        the ONE pricing source (+ launch date, grace, allowances, referral rules)
//   billing-offers:v1          the offers / discount codes
//   license:<id>.billing       one shop's subscription: agreed price, paid-through date, add-ons, payment history (cap 60), rewards (cap 50), referral code.
//                              ABSENT for every shop that existed before billing = grandfathered = never blocked.
//   bill-ref:<ref>             idempotency marker for one payment event (a retry finds it and changes nothing)
//   bill-evt:<reverse-time>:.. the owner's ledger (purchases, renewals, add-ons, rewards, reversals, flags), newest first
//   bill-aud:<reverse-time>:.. the audit trail (who changed what, when), plus bill-aud-c:<client>:.. per shop
//   bill-refcode:<CODE>        referral code -> shop id
//
// shortcut: KV has no compare-and-set, so two simultaneous callbacks for ONE payment could both pass the idempotency check; the check is made as late as possible
// and the second writer repeats the same values. Upgrade to a D1 unique key if payments ever arrive concurrently in practice.

import {
  SETTINGS_KEY, DAY_MS, readSettings, forgetSettings, validateSettings, mergeSettings, describeEffect, normaliseSettings,
  subscriptionState, nextPaidThrough, allowances, pickOffers, offerStatus, discountOf, eatDateTime, enforcementOn,
} from './_billing-core.js';
import { PRODUCTS, getLicense, saveLicense, listClientSummaries, getBranchGroupMembers, randomToken } from './_license.js';

export { readSettings as getSettings } from './_billing-core.js';

const OFFERS_KEY = 'billing-offers:v1';
const rev = (ts) => String(9999999999999 - ts).padStart(13, '0');
const last9 = (p) => String(p || '').replace(/\D/g, '').slice(-9);
const lower = (e) => String(e || '').trim().toLowerCase();
const clampText = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
export const isLive = (s, now = Date.now()) => s.launchAt > 0 && now >= s.launchAt;
export const productLabel = (id) => (PRODUCTS[id] && PRODUCTS[id].label) || id || 'POS';

// ================================================================ audit + ledger (append-only lists, newest first)
export async function audit(env, e) {
  const at = Date.now(), entry = { at, actor: clampText(e.actor || 'owner', 60), action: clampText(e.action, 40), clientId: e.clientId || '', note: clampText(e.note, 600), before: e.before === undefined ? undefined : e.before, after: e.after === undefined ? undefined : e.after };
  const id = rev(at) + ':' + randomToken(4);
  await env.mydukapos_kv.put(`bill-aud:${id}`, JSON.stringify(entry), { expirationTtl: 3 * 365 * 86400 });
  if (e.clientId) await env.mydukapos_kv.put(`bill-aud-c:${e.clientId}:${id}`, JSON.stringify(entry), { expirationTtl: 3 * 365 * 86400 });
}
export async function listAudit(env, { clientId = '', cursor, limit = 60 } = {}) {
  const prefix = clientId ? `bill-aud-c:${clientId}:` : 'bill-aud:';
  const page = await env.mydukapos_kv.list({ prefix, cursor: cursor || undefined, limit: Math.min(100, limit) });
  const rows = (await Promise.all(page.keys.map(async (k) => { try { return JSON.parse(await env.mydukapos_kv.get(k.name)); } catch (e) { return null; } }))).filter(Boolean);
  return { rows, cursor: page.list_complete ? '' : page.cursor };
}
// One payment event, ONCE. -> { first: true } the first time this ref is seen, { first: false, prior } after.
export async function claimRef(env, ref, evt = {}) {
  const key = `bill-ref:${ref}`, seen = await env.mydukapos_kv.get(key);
  if (seen) { let prior = null; try { prior = JSON.parse(seen); } catch (e) { /* marker only */ } return { first: false, prior }; }
  const at = Date.now(), body = { ref, at, ...evt }, evtKey = `bill-evt:${rev(at)}:${ref}`.slice(0, 500);
  await env.mydukapos_kv.put(key, JSON.stringify(body));
  await env.mydukapos_kv.put(evtKey, JSON.stringify(body));
  return { first: true, evtKey };
}
// If the work after a claim fails (a storage error), the claim is withdrawn so the retry can finish the payment instead of finding it "already done".
async function unclaim(env, ref, c) { try { await env.mydukapos_kv.delete(`bill-ref:${ref}`); if (c && c.evtKey) await env.mydukapos_kv.delete(c.evtKey); } catch (e) { /* the retry then reports a duplicate; the owner can fix by hand */ } }
export async function listEvents(env, { cursor, limit = 60 } = {}) {
  const page = await env.mydukapos_kv.list({ prefix: 'bill-evt:', cursor: cursor || undefined, limit: Math.min(100, limit) });
  const rows = (await Promise.all(page.keys.map(async (k) => { try { return JSON.parse(await env.mydukapos_kv.get(k.name)); } catch (e) { return null; } }))).filter(Boolean);
  return { rows, cursor: page.list_complete ? '' : page.cursor };
}
const pushCapped = (arr, item, cap) => { const out = [item, ...(Array.isArray(arr) ? arr : [])]; return out.slice(0, cap); };

// ================================================================ settings (the one pricing source)
export async function saveSettings(env, patch, actor = 'owner') {
  const before = await readSettings(env, { fresh: true });
  const merged = mergeSettings(before, patch);
  const v = validateSettings(merged);
  if (!v.ok) return v;
  const settings = { ...v.settings, updatedAt: Date.now(), updatedBy: clampText(actor, 60) };
  for (const k of Object.keys(settings.linkPrices)) if (!PRODUCTS[k]) delete settings.linkPrices[k];
  const effect = describeEffect(before, settings);
  await env.mydukapos_kv.put(SETTINGS_KEY, JSON.stringify(settings));
  forgetSettings(env);
  if (effect.length) await audit(env, { actor, action: 'settings', note: effect.join(' | '), before: { prices: before.prices, launchAt: before.launchAt, enforce: before.enforce }, after: { prices: settings.prices, launchAt: settings.launchAt, enforce: settings.enforce } });
  return { ok: true, settings, effect, takesEffect: 'Every screen and checkout uses the new values within 30 seconds.' };
}
export const linkPriceFor = (s, product) => (s.linkPrices && s.linkPrices[product]) || s.prices.link;

// What any public screen may show. The subscription is only mentioned once billing is live (a buyer before the launch date is never charged one).
export function publicTerms(s, now = Date.now()) {
  const live = isLive(s, now);
  return {
    currency: 'KES', link: s.prices.link, linkPrices: s.linkPrices, launched: live, launchAt: s.launchAt, launchLabel: s.launchAt ? eatDateTime(s.launchAt) : '', referralEnabled: s.referral.enabled,
    subscription: live ? { amount: s.prices.subscription, periodDays: s.periodDays, graceDays: s.graceDays, includedBranches: s.includedBranches, includedStaffPerBranch: s.includedStaffPerBranch, firstPeriodIncluded: true } : null,
    addons: { extraBranch: { amount: s.prices.extraBranch, qty: 1 }, branchBundle: { amount: s.prices.branchBundle, qty: s.bundleBranches }, staffBlock: { amount: s.prices.staffBlock, qty: s.staffBlockSize } },
  };
}

// ================================================================ offers
export async function listOffers(env) {
  let a = []; try { a = JSON.parse((await env.mydukapos_kv.get(OFFERS_KEY)) || '[]'); if (!Array.isArray(a)) a = []; } catch (e) { a = []; }
  // how many times each offer was used lives in its own key, so a confirmation and an owner's edit of the offer list can never overwrite each other's numbers
  return Promise.all(a.map(async (o) => { let n = 0; try { n = Number(await env.mydukapos_kv.get(`billing-offer-used:${o.id}`)) || 0; } catch (e) { n = 0; } return { ...o, used: Math.max(n, 0) }; }));
}
async function writeOffers(env, offers) { await env.mydukapos_kv.put(OFFERS_KEY, JSON.stringify(offers.slice(0, 200).map(({ used, ...o }) => o))); }
export function cleanOffer(input, prior) {
  const errors = [], o = input && typeof input === 'object' ? input : {};
  const name = clampText(o.name, 60); if (name.length < 2) errors.push('Give the offer a name.');
  const type = o.type === 'fixed' ? 'fixed' : 'percent';
  const value = Math.round(Number(o.value)); if (!Number.isFinite(value) || value < 1 || value > (type === 'percent' ? 100 : 1000000)) errors.push(type === 'percent' ? 'A percentage discount must be 1 to 100.' : 'A fixed discount must be a whole number of KES, 1 or more.');
  const appliesTo = (Array.isArray(o.appliesTo) ? o.appliesTo : []).filter((x) => x === 'link' || x === 'renewal' || x === 'addon'); if (!appliesTo.length) errors.push('Choose what the offer applies to.');
  const beneficiary = ['buyer', 'referrer', 'both'].includes(o.beneficiary) ? o.beneficiary : 'buyer';
  const code = String(o.code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
  const startsAt = Math.max(0, Math.round(Number(o.startsAt)) || 0), endsAt = Math.max(0, Math.round(Number(o.endsAt)) || 0);
  if (startsAt && endsAt && endsAt <= startsAt) errors.push('The end must be after the start.');
  const num0 = (v, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= max ? n : 0; };
  if (errors.length) return { ok: false, errors };
  return { ok: true, offer: { id: (prior && prior.id) || 'OF' + randomToken(6).toUpperCase(), name, code, type, value, appliesTo, beneficiary, startsAt, endsAt, limitTotal: num0(o.limitTotal, 1000000), maxDiscount: num0(o.maxDiscount, 1000000),
    cohort: o.cohort === 'referred' ? 'referred' : 'all', stackable: o.stackable === true, state: o.state === 'paused' ? 'paused' : 'active', used: (prior && prior.used) || 0, createdAt: (prior && prior.createdAt) || Date.now(), updatedAt: Date.now() } };
}
export async function saveOffer(env, input, actor = 'owner') {
  const offers = await listOffers(env), prior = input && input.id ? offers.find((x) => x.id === input.id) : null;
  const c = cleanOffer(input, prior); if (!c.ok) return c;
  if (c.offer.code && offers.some((x) => x.id !== c.offer.id && x.code === c.offer.code)) return { ok: false, errors: ['Another offer already uses that code.'] };
  const next = prior ? offers.map((x) => (x.id === prior.id ? c.offer : x)) : [c.offer, ...offers];
  await writeOffers(env, next);
  await audit(env, { actor, action: prior ? 'offer-edit' : 'offer-create', note: `${c.offer.name} (${c.offer.type === 'percent' ? c.offer.value + '%' : 'KES ' + c.offer.value})`, before: prior || undefined, after: c.offer });
  return { ok: true, offer: c.offer };
}
export async function setOfferState(env, id, state, actor = 'owner') {
  const offers = await listOffers(env), o = offers.find((x) => x.id === id); if (!o) return { ok: false, errors: ['Offer not found.'] };
  o.state = state === 'paused' ? 'paused' : 'active'; o.updatedAt = Date.now(); await writeOffers(env, offers);
  await audit(env, { actor, action: 'offer-' + o.state, note: o.name }); return { ok: true, offer: o };
}
export async function deleteOffer(env, id, actor = 'owner') {
  const offers = await listOffers(env), o = offers.find((x) => x.id === id); if (!o) return { ok: false, errors: ['Offer not found.'] };
  await writeOffers(env, offers.filter((x) => x.id !== id)); await audit(env, { actor, action: 'offer-delete', note: o.name, before: o }); return { ok: true };
}
// once per (payment, offer): a retry never counts twice. An offer already at its limit when the payment is confirmed is still honoured (the customer paid the quoted price)
// and the owner is told in the ledger, so the limit is never silently exceeded.
async function bumpOfferUse(env, ids, payRef) {
  if (!ids.length) return;
  const offers = await listOffers(env);
  for (const id of ids) {
    const o = offers.find((x) => x.id === id); if (!o) continue;
    const c = await claimRef(env, `offeruse:${payRef}:${id}`, { kind: 'offer-use', clientId: '', amount: 0, data: { offerId: id } });
    if (!c.first) continue;
    if (o.limitTotal > 0 && (o.used || 0) >= o.limitTotal) await claimRef(env, `flag:offerlimit:${payRef}:${id}`, { kind: 'flag', clientId: '', amount: 0, note: `Offer "${o.name}" was over its limit when this payment was confirmed (it was quoted earlier).` });
    await env.mydukapos_kv.put(`billing-offer-used:${id}`, String((o.used || 0) + 1));
  }
}

// ================================================================ quote (the ONLY place an amount is worked out; a browser never sends one)
const ADDON_KINDS = ['extraBranch', 'branchBundle', 'staffBlock'];
function usableReward(r, applies, now) {
  if (!r || !Array.isArray(r.appliesTo) || !r.appliesTo.includes(applies)) return false;
  if (r.expiresAt && now >= r.expiresAt) return false;
  return r.status === 'available' || (r.status === 'reserved' && (r.reservedUntil || 0) < now);
}
// kind: 'link' (new link or a branch bought as a link) | 'renewal' | 'extraBranch' | 'branchBundle' | 'staffBlock'.
// o: { kind, product, qty, cycles, offerCode, referral (a validated attribution, or null), record (the paying shop's main record, for renewal / add-ons), now, settings }
export async function buildQuote(env, o = {}) {
  const s = o.settings || await readSettings(env), now = o.now || Date.now();
  const kind = o.kind === 'renewal' || ADDON_KINDS.includes(o.kind) ? o.kind : 'link';
  const product = PRODUCTS[o.product] ? o.product : 'shop';
  const b = o.record && o.record.billing || null;
  let unit = 0, qty = 1, label = '', applies = 'link', recurring = false;
  if (kind === 'link') { unit = linkPriceFor(s, product); label = `${productLabel(product)}: permanent link and setup`; }
  else if (kind === 'renewal') {
    applies = 'renewal'; recurring = true; qty = Math.min(12, Math.max(1, Math.round(Number(o.cycles)) || 1));
    unit = b && Number.isFinite(Number(b.price)) ? Number(b.price) : s.prices.subscription;
    label = `Subscription renewal: ${qty} x ${(b && b.periodDays) || s.periodDays} days`;
  } else {
    applies = 'addon'; qty = Math.min(20, Math.max(1, Math.round(Number(o.qty)) || 1)); unit = s.prices[kind];
    label = kind === 'extraBranch' ? 'Extra branch (one-time)' : kind === 'branchBundle' ? `Bundle of ${s.bundleBranches} branches (one-time)` : `Block of ${s.staffBlockSize} staff slots, shared across branches (one-time)`;
  }
  const subtotal = Math.max(0, Math.round(unit * qty));
  const offers = await listOffers(env);
  const referred = !!(o.referral && o.referral.referrerId && !o.referral.blocked);
  const pick = pickOffers(offers, { applies, beneficiary: 'buyer', code: o.offerCode, cohorts: referred ? ['all', 'referred'] : ['all'], amount: subtotal, now });
  // a referral reward the shop already earned (renewals and add-ons only), used like an offer: one per checkout unless the offers in play stack
  let reward = null, rewardOff = 0;
  if (b && Array.isArray(b.rewards) && (kind === 'renewal' || ADDON_KINDS.includes(kind))) {
    const r = b.rewards.find((x) => usableReward(x, applies, now));
    if (r) { reward = r; rewardOff = discountOf(subtotal, r); }
  }
  let discount = pick.discount, usedReward = null, offerList = pick.picked.map((p, i) => ({ id: p.id, name: p.name, amount: pick.amounts[i] }));
  const stacking = pick.picked.length > 0 && pick.picked.every((p) => p.stackable);
  if (reward && rewardOff > 0) {
    if (!pick.picked.length || stacking) { discount = Math.min(subtotal, discount + rewardOff); usedReward = { id: reward.id, amount: Math.min(rewardOff, subtotal - pick.discount) }; }
    else if (rewardOff > pick.discount) { discount = rewardOff; offerList = []; usedReward = { id: reward.id, amount: rewardOff }; }
  }
  discount = Math.min(discount, subtotal);
  const total = Math.max(0, subtotal - discount);
  const quote = {
    kind, currency: 'KES', product, qty, lines: [{ key: kind, label, unit, qty, amount: subtotal, recurring }], subtotal,
    discount: { total: discount, offers: offerList, reward: usedReward }, total,
    recurringNote: kind === 'link' && isLive(s, now) ? { amount: s.prices.subscription, periodDays: s.periodDays, text: `Includes your first ${s.periodDays} days. Then KES ${s.prices.subscription.toLocaleString('en-KE')} every ${s.periodDays} days to keep the shop online.` } : null,
    referred, at: now,
  };
  quote.snapshot = { at: now, settingsAt: s.updatedAt, kind, product, qty, unit, subtotal, discount: quote.discount, total, periodDays: s.periodDays, graceDays: s.graceDays, subscription: s.prices.subscription,
    bundleBranches: s.bundleBranches, staffBlockSize: s.staffBlockSize, offerCode: o.offerCode ? String(o.offerCode).toUpperCase().slice(0, 24) : '' };
  return quote;
}
// the small safe copy that is stored with a pending purchase and shown on screen
export const publicQuote = (q) => ({ kind: q.kind, currency: q.currency, lines: q.lines, subtotal: q.subtotal, discount: q.discount, total: q.total, recurringNote: q.recurringNote, referred: q.referred });

// ================================================================ a shop's subscription record
const freshAddons = (s) => ({ branches: 0, staffBlocks: 0, staffBlockSize: s.staffBlockSize });
function newBilling(s, now, cohort) {
  if (cohort !== 'new') return { v: 1, cohort: 'grandfathered', since: now, history: [] };
  return { v: 1, cohort: 'new', since: now, price: s.prices.subscription, periodDays: s.periodDays, graceDays: s.graceDays, includedBranches: s.includedBranches, includedStaffPerBranch: s.includedStaffPerBranch,
    paidThrough: now + s.periodDays * DAY_MS, addons: freshAddons(s), history: [], rewards: [] };
}
const ensureBilling = (record) => { if (!record.billing || typeof record.billing !== 'object') record.billing = { v: 1, cohort: 'grandfathered', since: record.confirmedAt || record.createdAt || Date.now(), history: [] }; return record.billing; };

// Every branch of a subscribed shop follows the main shop's paid period (one subscription per shop): copy it onto the others, never touching their data.
export async function syncGroupBilling(env, main) {
  // only the group's real main shop is copied from (never a branch onto the main), and a branch keeps its OWN history, rewards, referrals and referral code
  if (!main || !main.branchGroupId || !main.isMainBranch || !main.billing || main.billing.cohort !== 'new') return 0;
  const members = await getBranchGroupMembers(env, main.branchGroupId); let n = 0;
  for (const id of members) {
    if (id === main.id) continue;
    const m = await getLicense(env, id); if (!m || m.deleted) continue;
    const { history, rewards, refCode, referrals, ...core } = main.billing;
    const own = m.billing && typeof m.billing === 'object' ? m.billing : {};
    m.billing = { ...core, followsMain: main.id, history: own.history || [], rewards: own.rewards || [], ...(own.refCode ? { refCode: own.refCode } : {}), ...(own.referrals ? { referrals: own.referrals } : {}) };
    await saveLicense(env, m); n++;
  }
  return n;
}

// ---------------------------------------------------------------- a NEW permanent link was paid for and created ("Get my own link", or the owner confirming a payment)
// ctx: { purchase (the buy record), quote, method, receipt, now, parent (the main record when this link is a branch) }
export async function completePurchase(env, record, ctx = {}) {
  const now = ctx.now || Date.now(), s = ctx.settings || await readSettings(env);
  const pid = ctx.purchase ? ctx.purchase.id : record.id, ref = `purchase:${pid}`;
  const c = await claimRef(env, ref, { kind: 'purchase', clientId: record.id, amount: ctx.quote ? ctx.quote.total : ctx.amount || 0, method: ctx.method || '', receipt: ctx.receipt || '', data: { purchaseId: pid, referrerId: ctx.purchase && ctx.purchase.referral && ctx.purchase.referral.referrerId || '', offers: ctx.quote ? ctx.quote.discount.offers.map((x) => x.id) : [] } });
  if (!c.first) return { dup: true };
  try {
  const live = isLive(s, now);
  // the main shop is read again HERE: creating the branch may have just added it to a branch group, and saving an older copy would erase that
  const parent = ctx.parent ? await getLicense(env, ctx.parent.id) : null;
  let billing;
  let parentDirty = false;
  if (parent && parent.billing && parent.billing.cohort === 'new') {                      // a branch of a subscribed shop: it follows the main shop's plan, and counts as one more licensed branch
    const { history, rewards, refCode, referrals, ...core } = parent.billing;
    billing = { ...core, followsMain: parent.id, history: [], rewards: [] };
    const pa = { ...(parent.billing.addons || freshAddons(s)) }; pa.purchases = Array.isArray(pa.purchases) ? pa.purchases : [];
    if (!pa.purchases.includes(pid)) { pa.branches = (pa.branches || 0) + 1; pa.purchases = [pid, ...pa.purchases].slice(0, 100); parent.billing.addons = pa; parentDirty = true; }   // once per purchase, even on a retry
  } else if (parent) billing = newBilling(s, now, 'grandfathered');                       // a branch of a shop that predates billing stays exempt with it
  else billing = newBilling(s, now, live ? 'new' : 'grandfathered');
  billing.history = pushCapped([], { ref, at: now, kind: parent ? 'branch-purchase' : 'purchase', amount: ctx.quote ? ctx.quote.total : ctx.amount || 0, quoted: ctx.quote ? ctx.quote.snapshot : undefined, method: ctx.method || '', receipt: ctx.receipt || '' }, 60);
  record.billing = billing;
  await saveLicense(env, record);                                                          // the new shop's record first, then the main shop's allowance
  if (parentDirty) await saveLicense(env, parent);
  if (ctx.quote) await bumpOfferUse(env, ctx.quote.discount.offers.map((x) => x.id), ref);
  if (ctx.purchase && ctx.purchase.referral) await issueReward(env, { purchase: ctx.purchase, buyer: record, settings: s, now });
  return { ok: true, billing };
  } catch (e) { await unclaim(env, ref, c); throw e; }
}

// A referral reward used by a payment: spent only if it is still free (or held for THIS payment). A reward that was spent, voided or released to another payment while this
// one was waiting is NOT spent again; the owner is told in the ledger (the customer paid the discounted price they were quoted).
async function settleReward(env, b, rw, { ref, payId, clientId, now }) {
  const r = (b.rewards || []).find((x) => x.id === rw.id);
  const heldForThis = r && r.status === 'reserved' && (!payId || r.reservedFor === payId);
  if (r && (r.status === 'available' || heldForThis)) { r.status = 'used'; r.usedAt = now; r.usedRef = ref; r.amountOff = rw.amount; delete r.reservedFor; delete r.reservedUntil; return; }
  await claimRef(env, `flag:reward:${ref}`, { kind: 'flag', clientId, amount: 0, note: `Referral reward ${rw.id} was already used, voided or held for another payment when this one was confirmed. The customer paid the discounted price they were quoted.` });
}
const flagIfHeld = (env, b, ref, clientId) => (b.suspended ? claimRef(env, `flag:suspended-paid:${ref}`, { kind: 'flag', clientId, amount: 0, note: 'Payment received while this shop is on hold. Its paid period was extended but it stays on hold until you reactivate it.' }) : null);

// ---------------------------------------------------------------- a renewal was paid
export async function applyRenewal(env, record, ctx = {}) {
  const now = ctx.now || Date.now(), b = record && record.billing;
  if (!b || b.cohort !== 'new') return { ok: false, error: 'This shop has no subscription to renew.' };
  const ref = ctx.ref || `renewal:${randomToken(8)}`;
  const q = ctx.quote, cycles = (q && q.qty) || ctx.cycles || 1;
  const c = await claimRef(env, ref, { kind: 'renewal', clientId: record.id, amount: q ? q.total : ctx.amount || 0, method: ctx.method || '', receipt: ctx.receipt || '', data: { cycles, offers: q ? q.discount.offers.map((x) => x.id) : [] } });
  if (!c.first) return { dup: true };
  try {
    // a retry after a partly finished attempt must not add the time again: the history line is written together with the new date
    if (!(b.history || []).some((h) => h.ref === ref)) {
      const before = b.paidThrough || 0;
      b.paidThrough = nextPaidThrough({ paidThrough: before, now, periodDays: b.periodDays, graceDays: b.graceDays, cycles });
      delete b.claim;
      if (q && q.discount.reward) await settleReward(env, b, q.discount.reward, { ref, payId: ctx.payId, clientId: record.id, now });
      b.history = pushCapped(b.history, { ref, at: now, kind: 'renewal', amount: q ? q.total : ctx.amount || 0, cycles, quoted: q ? q.snapshot : undefined, method: ctx.method || '', receipt: ctx.receipt || '', paidThroughBefore: before, paidThroughAfter: b.paidThrough }, 60);
      await saveLicense(env, record);
    }
    await syncGroupBilling(env, record);
    if (q) await bumpOfferUse(env, q.discount.offers.map((x) => x.id), ref);
    await flagIfHeld(env, b, ref, record.id);
    return { ok: true, paidThrough: b.paidThrough, ref, heldSuspended: !!b.suspended };
  } catch (e) { await unclaim(env, ref, c); throw e; }
}

// ---------------------------------------------------------------- an add-on (extra branch / bundle / staff block) was paid
export async function applyAddon(env, record, ctx = {}) {
  const now = ctx.now || Date.now(), b = record && record.billing;
  if (!b || b.cohort !== 'new') return { ok: false, error: 'Add-ons are for subscribed shops.' };
  const ref = ctx.ref || `addon:${randomToken(8)}`, q = ctx.quote, kind = q ? q.kind : ctx.kind, qty = q ? q.qty : ctx.qty || 1;
  const c = await claimRef(env, ref, { kind: 'addon', clientId: record.id, amount: q ? q.total : ctx.amount || 0, method: ctx.method || '', receipt: ctx.receipt || '', data: { addon: kind, qty } });
  if (!c.first) return { dup: true };
  try {
    if (!(b.history || []).some((h) => h.ref === ref)) {
      b.addons = { ...(b.addons || {}) };
      if (kind === 'extraBranch') b.addons.branches = (b.addons.branches || 0) + qty;
      else if (kind === 'branchBundle') b.addons.branches = (b.addons.branches || 0) + qty * ((q && q.snapshot.bundleBranches) || 3);
      else if (kind === 'staffBlock') { b.addons.staffBlocks = (b.addons.staffBlocks || 0) + qty; b.addons.staffBlockSize = (q && q.snapshot.staffBlockSize) || b.addons.staffBlockSize || 5; }
      if (q && q.discount.reward) await settleReward(env, b, q.discount.reward, { ref, payId: ctx.payId, clientId: record.id, now });
      b.history = pushCapped(b.history, { ref, at: now, kind: 'addon', addon: kind, qty, amount: q ? q.total : ctx.amount || 0, quoted: q ? q.snapshot : undefined, method: ctx.method || '', receipt: ctx.receipt || '' }, 60);
      await saveLicense(env, record);
    }
    await syncGroupBilling(env, record);
    if (q) await bumpOfferUse(env, q.discount.offers.map((x) => x.id), ref);
    await flagIfHeld(env, b, ref, record.id);
    return { ok: true, addons: b.addons, ref, heldSuspended: !!b.suspended };
  } catch (e) { await unclaim(env, ref, c); throw e; }
}

// ================================================================ referrals
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() { let s = 'MD'; const a = new Uint8Array(6); crypto.getRandomValues(a); for (const x of a) s += CODE_CHARS[x % CODE_CHARS.length]; return s; }
// A shop's own referral code, created the first time it is asked for (any permanent shop may have one; the owner's settings decide whether it earns anything).
export async function refCodeFor(env, record) {
  const b = ensureBilling(record);
  if (b.refCode) return b.refCode;
  for (let i = 0; i < 6; i++) {
    const code = makeCode();
    if (await env.mydukapos_kv.get(`bill-refcode:${code}`)) continue;
    await env.mydukapos_kv.put(`bill-refcode:${code}`, record.id); b.refCode = code; await saveLicense(env, record); return code;
  }
  throw new Error('Could not make a referral code. Try again.');
}
// Is this code usable for this buyer? A self-referral is never accepted (and is logged for the owner); nothing about another shop is returned.
export async function resolveReferral(env, code, buyer = {}, settings) {
  const s = settings || await readSettings(env);
  if (!s.referral.enabled) return { ok: false, reason: 'off' };
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(c)) return { ok: false, reason: 'invalid' };
  const id = await env.mydukapos_kv.get(`bill-refcode:${c}`); if (!id) return { ok: false, reason: 'invalid' };
  const ref = await getLicense(env, id);
  if (!ref || ref.deleted || ref.locked || ref.type !== 'permanent') return { ok: false, reason: 'invalid' };
  if (s.referral.eligible === 'new' && !(ref.billing && ref.billing.cohort === 'new')) return { ok: false, reason: 'invalid' };
  const sameP = buyer.phone && last9(buyer.phone) && last9(buyer.phone) === last9(ref.phone), sameE = buyer.email && lower(buyer.email) && lower(buyer.email) === lower(ref.email);
  if (sameP || sameE) { await claimRef(env, `flag:self:${id}:${Math.floor(Date.now() / DAY_MS)}`, { kind: 'flag', clientId: id, amount: 0, note: 'Self-referral blocked (same phone or email as the referrer).' }); return { ok: false, reason: 'self' }; }
  return { ok: true, referrerId: id, code: c };
}
// Pick the reward for one confirmed referred purchase: the owner's baseline rule and any offer meant for the referrer; the best one (the reward is not stacked).
function rewardSpec(s, offers, now) {
  const cands = [];
  if (s.referral.enabled) cands.push({ type: s.referral.rewardType, value: s.referral.rewardValue, maxDiscount: 0, appliesTo: s.referral.appliesTo, expiryDays: s.referral.expiryDays, offerId: '' });
  for (const o of offers) {
    if (offerStatus(o, now) !== 'active' || (o.beneficiary !== 'referrer' && o.beneficiary !== 'both')) continue;
    const ap = (o.appliesTo || []).filter((x) => x === 'renewal' || x === 'addon'); if (!ap.length) continue;
    cands.push({ type: o.type, value: o.value, maxDiscount: o.maxDiscount || 0, appliesTo: ap, expiryDays: s.referral.expiryDays, offerId: o.id });
  }
  if (!cands.length) return null;
  return cands.sort((a, b) => discountOf(s.prices.subscription, b) - discountOf(s.prices.subscription, a))[0];
}
// Called ONLY from completePurchase, i.e. after the referred customer's payment is confirmed. Idempotent per purchase; a click, sign-up or pending payment never gets here.
export async function issueReward(env, { purchase, buyer, settings, now = Date.now() }) {
  const s = settings || await readSettings(env);
  const att = purchase && purchase.referral; if (!att || att.blocked || !att.referrerId || !s.referral.enabled) return null;
  const c = await claimRef(env, `reward:${purchase.id}`, { kind: 'reward', clientId: att.referrerId, amount: 0, data: { purchaseId: purchase.id, referredClientId: buyer.id } });
  if (!c.first) return null;
  try { return await issueRewardNow(env, { purchase, buyer, s, att, now }); } catch (e) { await unclaim(env, `reward:${purchase.id}`, c); throw e; }
}
async function issueRewardNow(env, { purchase, buyer, s, att, now }) {
  const refr = await getLicense(env, att.referrerId);
  if (!refr || refr.deleted || refr.type !== 'permanent') return null;
  const spec = rewardSpec(s, await listOffers(env), now); if (!spec) return null;
  const b = ensureBilling(refr);
  // held for the owner when it looks like the same business (the buyer's phone or email matches a shop in the referrer's own branch group), or too many in a day
  let hold = '';
  const group = refr.branchGroupId ? await getBranchGroupMembers(env, refr.branchGroupId) : [];
  for (const gid of group) { const g = gid === refr.id ? refr : await getLicense(env, gid); if (g && ((buyer.phone && last9(buyer.phone) === last9(g.phone)) || (buyer.email && lower(buyer.email) === lower(g.email)))) hold = 'Buyer matches the referrer\'s own business.'; }
  if (!hold && (b.rewards || []).filter((r) => now - (r.createdAt || 0) < DAY_MS).length >= 3) hold = 'More than 3 rewards in a day.';
  const live = (b.rewards || []).filter((r) => r.status !== 'void').length;
  if (live >= s.referral.maxRewardsPerReferrer) { await claimRef(env, `flag:limit:${purchase.id}`, { kind: 'flag', clientId: refr.id, amount: 0, note: 'Referral reward limit reached; no reward issued.' }); return null; }
  const reward = { id: 'RW' + randomToken(6).toUpperCase(), purchaseRef: purchase.id, type: spec.type, value: spec.value, maxDiscount: spec.maxDiscount, appliesTo: spec.appliesTo, offerId: spec.offerId, createdAt: now,
    expiresAt: spec.expiryDays ? now + spec.expiryDays * DAY_MS : 0, status: hold ? 'review' : 'available', note: hold };
  b.rewards = pushCapped(b.rewards, reward, 50);
  b.referrals = pushCapped(b.referrals, { at: now, purchaseRef: purchase.id, rewardId: reward.id, status: hold ? 'review' : 'earned' }, 50);
  await saveLicense(env, refr);
  if (hold) await claimRef(env, `flag:review:${purchase.id}`, { kind: 'flag', clientId: refr.id, amount: 0, note: hold, data: { rewardId: reward.id } });
  return reward;
}
// The shop's own view of its referrals: code, link, rewards. Nothing about the people referred.
export async function referralView(env, record, origin = '') {
  const s = await readSettings(env), b = record.billing || {};
  const code = s.referral.enabled ? await refCodeFor(env, record) : (b.refCode || '');
  const now = Date.now();
  return { enabled: s.referral.enabled, code, link: code && origin ? `${origin}/?ref=${code}` : '',
    rule: s.referral.enabled ? { type: s.referral.rewardType, value: s.referral.rewardValue, appliesTo: s.referral.appliesTo } : null,
    rewards: (record.billing && record.billing.rewards || []).map((r) => ({ id: r.id, status: r.status === 'available' && r.expiresAt && now >= r.expiresAt ? 'expired' : r.status, type: r.type, value: r.value, appliesTo: r.appliesTo, createdAt: r.createdAt, expiresAt: r.expiresAt })),
    referrals: (record.billing && record.billing.referrals || []).map((x) => ({ at: x.at, status: x.status })) };
}
// Owner: approve or void a held reward (or void any unused one).
export async function reviewReward(env, clientId, rewardId, decision, actor = 'owner') {
  const rec = await getLicense(env, clientId); const b = rec && rec.billing; const r = b && (b.rewards || []).find((x) => x.id === rewardId);
  if (!r) return { ok: false, error: 'Reward not found.' };
  if (r.status === 'used') return { ok: false, error: 'This reward was already used.' };
  const before = r.status; r.status = decision === 'approve' ? 'available' : 'void'; r.reviewedBy = clampText(actor, 60); r.reviewedAt = Date.now();
  const ref = (b.referrals || []).find((x) => x.rewardId === rewardId); if (ref) ref.status = r.status === 'available' ? 'earned' : 'void';
  await saveLicense(env, rec); await audit(env, { actor, action: 'reward-' + decision, clientId, note: rewardId, before, after: r.status });
  return { ok: true, reward: r };
}

// ================================================================ refund / reversal (owner)
export async function reversePayment(env, ref, actor = 'owner', { note = '' } = {}) {
  const raw = await env.mydukapos_kv.get(`bill-ref:${ref}`); if (!raw) return { ok: false, error: 'No such payment.' };
  const evt = JSON.parse(raw);
  if (evt.reversed) return { ok: true, dup: true };
  evt.reversed = { at: Date.now(), by: clampText(actor, 60), note: clampText(note, 200) };
  await env.mydukapos_kv.put(`bill-ref:${ref}`, JSON.stringify(evt));
  const out = { voided: 0, usedAlready: 0 };
  // a reward earned by this purchase: voided while unused; one already spent cannot be taken back (the owner sees it flagged)
  const purchaseId = evt.data && evt.data.purchaseId;
  if (purchaseId) {
    const rr = await env.mydukapos_kv.get(`bill-ref:reward:${purchaseId}`);
    if (rr) {
      const rid = JSON.parse(rr).clientId, refr = await getLicense(env, rid);
      for (const r of (refr && refr.billing && refr.billing.rewards) || []) if (r.purchaseRef === purchaseId) {
        if (r.status === 'used') { r.reversedAfterUse = true; out.usedAlready++; } else if (r.status !== 'void') { r.status = 'void'; r.note = 'Purchase reversed'; out.voided++; }
      }
      if (refr) { for (const x of refr.billing.referrals || []) if (x.purchaseRef === purchaseId) x.status = 'void'; await saveLicense(env, refr); }
    }
  }
  await claimRef(env, `reversal:${ref}`, { kind: 'reversal', clientId: evt.clientId, amount: -(evt.amount || 0), note: clampText(note, 200), actor: clampText(actor, 60), data: { of: ref, ...out } });
  await audit(env, { actor, action: 'reverse-payment', clientId: evt.clientId, note: `${ref} ${note}`.trim() });
  return { ok: true, ...out };
}

// ================================================================ the shop's billing, as a plain object (shop screen and owner panel)
export async function shopView(env, record, settings) {
  const s = settings || await readSettings(env), st = subscriptionState(record, Date.now()), b = record.billing || {};
  const members = record.branchGroupId ? (await getBranchGroupMembers(env, record.branchGroupId)).length : 1;
  const main = b.followsMain ? await getLicense(env, b.followsMain) : record;
  const a = main && main.billing && main.billing.cohort === 'new' ? allowances(main.billing, s) : null;
  return {
    state: st.state, blocking: st.blocking, claimPending: !!st.claimPending, cohort: b.cohort || 'grandfathered', price: b.price || 0, periodDays: b.periodDays || s.periodDays, graceDays: b.graceDays,
    paidThrough: st.paidThrough || 0, paidThroughLabel: eatDateTime(st.paidThrough), nextRenewalLabel: eatDateTime(st.nextRenewalAt), graceEndsAt: st.graceEndsAt || 0, graceEndsLabel: eatDateTime(st.graceEndsAt), daysLeft: st.daysLeft,
    comped: !!b.comped, exempt: b.exempt === true, suspended: b.suspended === true, why: st.why || '',
    allowance: a ? { branches: a.branches, staff: a.staff, extraBranches: a.extraBranches, staffBlocks: a.staffBlocks } : null, usage: { branches: members },
    history: (b.history || []).slice(0, 30).map((h) => ({ ref: h.ref, at: h.at, label: eatDateTime(h.at), kind: h.kind, amount: h.amount, method: h.method, receipt: h.receipt, discount: h.quoted && h.quoted.discount ? h.quoted.discount.total : 0, cycles: h.cycles, paidThroughAfter: h.paidThroughAfter ? eatDateTime(h.paidThroughAfter) : '' })),
  };
}

// ================================================================ owner: launch preview, grandfathering, per-shop edits
const isShop = (e) => e && e.type === 'permanent' && !e.deleted && e.source !== 'shared-demo';
// Before enabling: who is exempt, who WOULD be in the new cohort (nobody yet: a link joins only when its payment is confirmed on/after the launch date).
export async function cohortPreview(env) {
  const s = await readSettings(env), all = (await listClientSummaries(env)).filter(isShop);
  const marked = all.filter((e) => e.billing && e.billing.cohort);
  const subscribed = all.filter((e) => e.billing && e.billing.cohort === 'new');
  const pendingClaims = (await listClientSummaries(env)).filter((e) => !e.deleted && e.type !== 'permanent' && e.paymentClaimed);
  return {
    launchAt: s.launchAt, launchLabel: s.launchAt ? eatDateTime(s.launchAt) : '', live: isLive(s), enforcing: enforcementOn(s),
    existing: { permanentShops: all.length, markedGrandfathered: marked.length - subscribed.length, unmarked: all.length - marked.length, note: 'Every shop above keeps its link, data and access for good. A shop with no billing record is treated as exempt, so marking is for the owner\'s records only.' },
    inCohort: { subscribed: subscribed.length, pendingPaymentClaims: pendingClaims.length, rule: s.launchAt ? `A link whose payment is confirmed on or after ${eatDateTime(s.launchAt)} (Nairobi) starts a ${s.periodDays}-day subscription.` : 'Billing is off. Set a launch date to start.' },
    sample: all.slice(0, 25).map((e) => ({ id: e.id, label: e.label || e.slug, slug: e.slug, confirmedAt: e.confirmedAt || e.createdAt, state: e.billing && e.billing.cohort === 'new' ? 'subscribed' : 'exempt' })),
  };
}
// Mark every permanent shop that has no billing record as grandfathered (additive: never overwrites, never touches data). Batched; call again until remaining is 0.
export async function grandfatherExisting(env, actor = 'owner', batch = 120) {
  const list = (await listClientSummaries(env)).filter((e) => isShop(e) && !(e.billing && e.billing.cohort));
  let marked = 0;
  for (const e of list.slice(0, batch)) {
    const rec = await getLicense(env, e.id); if (!rec || rec.billing) continue;
    rec.billing = { v: 1, cohort: 'grandfathered', since: rec.confirmedAt || rec.createdAt || Date.now(), history: [], markedAt: Date.now() };
    await saveLicense(env, rec); marked++;
  }
  if (marked) await audit(env, { actor, action: 'grandfather-existing', note: `${marked} shops marked exempt` });
  return { marked, remaining: Math.max(0, list.length - marked) };
}
// Per-shop edit. Anything that suspends or materially changes a customer's access needs confirm:true. A shop that predates billing is never converted by this.
export async function editShopBilling(env, id, patch, actor = 'owner') {
  let rec = await getLicense(env, id); if (!rec || rec.deleted) return { ok: false, error: 'Shop not found.' };
  if (rec.billing && rec.billing.followsMain) { const m = await getLicense(env, rec.billing.followsMain); if (m && !m.deleted) rec = m; }    // a branch has no plan of its own: editing it edits the main shop's
  id = rec.id;
  const b = rec.billing;
  if (!b || b.cohort !== 'new') return { ok: false, error: 'This shop predates billing and is exempt. Its access is changed with the usual Lock / Unlock, not here.' };
  const p = patch || {}, now = Date.now(), before = JSON.parse(JSON.stringify({ price: b.price, paidThrough: b.paidThrough, graceDays: b.graceDays, periodDays: b.periodDays, includedBranches: b.includedBranches, includedStaffPerBranch: b.includedStaffPerBranch, addons: b.addons, comped: b.comped, exempt: b.exempt, suspended: b.suspended }));
  const next = { ...before }, errors = [], material = [];
  const int = (k, label, min, max) => { if (p[k] === undefined) return; const n = Math.round(Number(p[k])); if (!Number.isFinite(n) || n < min || n > max) errors.push(`${label} must be a whole number from ${min} to ${max}.`); else next[k] = n; };
  int('price', 'Price', 0, 1000000); int('graceDays', 'Grace days', 0, 60); int('periodDays', 'Period days', 1, 366); int('includedBranches', 'Branches', 1, 100); int('includedStaffPerBranch', 'Staff per branch', 0, 500);
  if (p.paidThrough !== undefined) { const n = Math.round(Number(p.paidThrough)); if (!Number.isFinite(n) || n < 1577836800000 || n > 4102444800000) errors.push('The paid-through date is not valid.'); else next.paidThrough = n; }
  if (p.addons && typeof p.addons === 'object') { next.addons = { ...(before.addons || {}) }; for (const k of ['branches', 'staffBlocks']) if (p.addons[k] !== undefined) { const n = Math.round(Number(p.addons[k])); if (!Number.isFinite(n) || n < 0 || n > 1000) errors.push(`Add-on ${k} must be 0 to 1000.`); else next.addons[k] = n; } }
  for (const k of ['comped', 'exempt', 'suspended']) if (p[k] !== undefined) next[k] = p[k] === true;
  if (errors.length) return { ok: false, errors };
  if (next.suspended && !before.suspended) material.push('Suspend this shop: it is blocked online until you reactivate it or it pays. Its data is kept.');
  if (next.paidThrough < before.paidThrough) material.push(`Move the paid-through date earlier: ${eatDateTime(before.paidThrough)} to ${eatDateTime(next.paidThrough)}.`);
  if (next.exempt && !before.exempt) material.push('Exempt this shop from the subscription.');
  if (!next.exempt && before.exempt) material.push('Make this shop pay the subscription again.');
  if (next.comped && !before.comped) material.push('Give complimentary access (never blocked, nothing to pay).');
  if (!next.comped && before.comped) material.push('End complimentary access.');
  if ((next.includedBranches || 0) < (before.includedBranches || 0) || (next.addons && (next.addons.branches || 0) < ((before.addons || {}).branches || 0))) material.push('Lower the branch allowance.');
  if ((next.includedStaffPerBranch || 0) < (before.includedStaffPerBranch || 0)) material.push('Lower the staff allowance.');
  if (material.length && p.confirm !== true) return { ok: false, needConfirm: true, summary: material };
  Object.assign(b, { price: next.price, paidThrough: next.paidThrough, graceDays: next.graceDays, periodDays: next.periodDays, includedBranches: next.includedBranches, includedStaffPerBranch: next.includedStaffPerBranch, addons: next.addons, comped: !!next.comped, exempt: !!next.exempt, suspended: !!next.suspended });
  if (before.suspended && !next.suspended) b.reactivatedAt = now;
  await saveLicense(env, rec); await syncGroupBilling(env, rec);
  const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
  if (changed.length) await audit(env, { actor, action: 'shop-billing', clientId: id, note: changed.join(', ') + (p.note ? ' - ' + clampText(p.note, 200) : ''), before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, next[k]])) });
  return { ok: true, view: await shopView(env, rec) };
}
// Owner confirms a payment by hand (a renewal the shop said it made, or one the owner received another way).
export async function confirmManualRenewal(env, id, { cycles = 1, amount, receipt = '', note = '', key = '' } = {}, actor = 'owner') {
  const rec = await getLicense(env, id); if (!rec || !rec.billing || rec.billing.cohort !== 'new') return { ok: false, error: 'This shop has no subscription.' };
  const quote = await buildQuote(env, { kind: 'renewal', record: rec, cycles });
  // the same payment however many times it is pressed: tied to the shop's pending claim, or to a key the screen sends, or to a 15-second window (a double-click)
  const claimRefId = rec.billing.claim && rec.billing.claim.id ? `renewal:${rec.billing.claim.id}` : `renewal:manual:${id}:${String(key || Math.floor(Date.now() / 15000)).slice(0, 40)}`;
  const r = await applyRenewal(env, rec, { ref: claimRefId, quote, method: 'owner-confirmed', receipt: clampText(receipt, 40), amount: amount != null ? Number(amount) : quote.total });
  if (r.ok) await audit(env, { actor, action: 'confirm-renewal', clientId: id, note: `${cycles} cycle(s) ${note}`.trim(), after: { paidThrough: r.paidThrough } });
  return r;
}
