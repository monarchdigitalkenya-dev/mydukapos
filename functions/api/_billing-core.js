// functions/api/_billing-core.js — shared helper, NOT a route (zip 267). Licensing / subscription / offers / referrals: the PURE part.
//
// No imports on purpose: _license.js (the licence check) uses it, and _billing.js (storage, quotes, flows) uses _license.js, so the rules every
// caller shares live here, free of cycles. Everything in this file is a function of its arguments (plus one cached settings read).
//
// THE ONE PRICING SOURCE is the KV record `billing-settings:v1` (Owner Console -> Billing). Nothing else holds a price: the public site, the sample shop
// purchase, "Get my own link", renewals, add-ons and receipts all ask for a quote built from it. Until the owner saves it, the defaults below apply, which
// are exactly what the system charged before (KES 3,000 once) - plus the plan the owner agreed (KES 400 per 31 days), which only starts when a launch date is set.
//
// MONEY is whole KES. TIME is epoch milliseconds (UTC) in storage; the owner and the shop SEE Africa/Nairobi (UTC+3, no daylight saving).

export const SETTINGS_KEY = 'billing-settings:v1';
export const DAY_MS = 86400000;
export const TZ = 'Africa/Nairobi';

export const DEFAULT_SETTINGS = Object.freeze({
  v: 1,
  launchAt: 0,                 // 0 = billing OFF: nobody is subscribed and nothing is ever blocked. A time = links CONFIRMED on or after it start a subscription.
  enforce: true,               // kill switch: false = subscriptions are tracked and shown but nothing is ever blocked (the rollback)
  prices: { link: 3000, subscription: 400, extraBranch: 1000, branchBundle: 3000, staffBlock: 500 },
  linkPrices: {},              // optional per-product one-time price (Owner Console -> Billing -> Pricing); a product with none uses prices.link
  bundleBranches: 3,           // how many branches the bundle adds
  staffBlockSize: 5,           // how many staff slots one block adds
  includedBranches: 3,         // branches (the main shop counts as one) a subscription includes
  includedStaffPerBranch: 5,
  periodDays: 31,
  graceDays: 3,
  referral: { enabled: false, rewardType: 'percent', rewardValue: 20, appliesTo: ['renewal', 'addon'], maxRewardsPerReferrer: 12, expiryDays: 365, eligible: 'all' },
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (v === '' || v == null ? NaN : Number(v));

// ---------------------------------------------------------------- settings: normalise (never throws) and validate (owner save)
export function normaliseSettings(raw) {
  const d = DEFAULT_SETTINGS, s = isObj(raw) ? raw : {};
  const pick = (v, def, min, max) => { const n = Math.round(num(v)); return Number.isFinite(n) && n >= min && n <= max ? n : def; };
  const prices = isObj(s.prices) ? s.prices : {};
  const ref = isObj(s.referral) ? s.referral : {};
  const linkPrices = {};
  if (isObj(s.linkPrices)) for (const [k, v] of Object.entries(s.linkPrices)) { const n = Math.round(num(v)); if (/^[a-z0-9_-]{1,24}$/.test(k) && Number.isFinite(n) && n >= 1 && n <= 1000000) linkPrices[k] = n; }
  const appliesTo = Array.isArray(ref.appliesTo) ? ref.appliesTo.filter((x) => x === 'renewal' || x === 'addon') : d.referral.appliesTo;
  return {
    v: 1,
    updatedAt: Math.max(0, Math.round(num(s.updatedAt)) || 0), updatedBy: String(s.updatedBy || '').slice(0, 60),
    launchAt: (() => { const n = Math.round(num(s.launchAt)); return Number.isFinite(n) && n >= 1577836800000 && n <= 4102444800000 ? n : 0; })(),
    enforce: s.enforce === false ? false : true,
    prices: {
      link: pick(prices.link, d.prices.link, 1, 1000000), subscription: pick(prices.subscription, d.prices.subscription, 0, 1000000),
      extraBranch: pick(prices.extraBranch, d.prices.extraBranch, 0, 1000000), branchBundle: pick(prices.branchBundle, d.prices.branchBundle, 0, 1000000),
      staffBlock: pick(prices.staffBlock, d.prices.staffBlock, 0, 1000000),
    },
    linkPrices,
    bundleBranches: pick(s.bundleBranches, d.bundleBranches, 2, 50), staffBlockSize: pick(s.staffBlockSize, d.staffBlockSize, 1, 500),
    includedBranches: pick(s.includedBranches, d.includedBranches, 1, 100), includedStaffPerBranch: pick(s.includedStaffPerBranch, d.includedStaffPerBranch, 0, 500),
    periodDays: pick(s.periodDays, d.periodDays, 1, 366), graceDays: pick(s.graceDays, d.graceDays, 0, 60),
    referral: {
      enabled: ref.enabled === true,
      rewardType: ref.rewardType === 'fixed' ? 'fixed' : 'percent',
      rewardValue: pick(ref.rewardValue, d.referral.rewardValue, 1, ref.rewardType === 'fixed' ? 1000000 : 100),
      appliesTo: appliesTo.length ? appliesTo : d.referral.appliesTo,
      maxRewardsPerReferrer: pick(ref.maxRewardsPerReferrer, d.referral.maxRewardsPerReferrer, 1, 1000),
      expiryDays: pick(ref.expiryDays, d.referral.expiryDays, 0, 3650),
      eligible: ref.eligible === 'new' ? 'new' : 'all',
    },
  };
}

// Owner save: the SAME rules, but a bad number is an error naming the field, not a silent default. -> { ok, settings } | { ok:false, errors:[...] }
export function validateSettings(input) {
  const errors = [], s = isObj(input) ? input : {};
  const int = (label, v, min, max) => { if (v === undefined) return; const n = num(v); if (!Number.isFinite(n) || Math.round(n) !== n || n < min || n > max) errors.push(`${label} must be a whole number from ${min} to ${max}.`); };
  const p = isObj(s.prices) ? s.prices : {};
  int('One-time link price', p.link, 1, 1000000); int('Subscription price', p.subscription, 0, 1000000); int('Extra branch price', p.extraBranch, 0, 1000000);
  int('Branch bundle price', p.branchBundle, 0, 1000000); int('Staff block price', p.staffBlock, 0, 1000000);
  int('Branches in a bundle', s.bundleBranches, 2, 50); int('Staff slots in a block', s.staffBlockSize, 1, 500);
  int('Included branches', s.includedBranches, 1, 100); int('Included staff per branch', s.includedStaffPerBranch, 0, 500);
  int('Billing period (days)', s.periodDays, 1, 366); int('Grace period (days)', s.graceDays, 0, 60);
  if (isObj(s.linkPrices)) for (const [k, v] of Object.entries(s.linkPrices)) if (v !== '' && v != null) int(`Link price for ${k}`, v, 1, 1000000);
  if (s.launchAt !== undefined && Number(s.launchAt) !== 0 && s.launchAt !== '' && s.launchAt !== null) {
    const n = Number(s.launchAt); if (!Number.isFinite(n) || n < 1577836800000 || n > 4102444800000) errors.push('The billing launch date is not a valid date.');
  }
  const r = isObj(s.referral) ? s.referral : {};
  if (r.rewardType !== undefined && r.rewardType !== 'percent' && r.rewardType !== 'fixed') errors.push('Referral reward type must be percent or fixed.');
  int('Referral reward value', r.rewardValue, 1, r.rewardType === 'fixed' ? 1000000 : 100);
  int('Rewards per referrer', r.maxRewardsPerReferrer, 1, 1000); int('Reward expiry (days)', r.expiryDays, 0, 3650);
  if (errors.length) return { ok: false, errors };
  return { ok: true, settings: normaliseSettings(s) };
}

// Fill missing parts of a partial update from the current settings (the owner screen may send only what it edited).
export function mergeSettings(current, patch) {
  const c = normaliseSettings(current), p = isObj(patch) ? patch : {};
  return { ...c, ...p, prices: { ...c.prices, ...(isObj(p.prices) ? p.prices : {}) }, linkPrices: p.linkPrices !== undefined ? p.linkPrices : c.linkPrices, referral: { ...c.referral, ...(isObj(p.referral) ? p.referral : {}) } };
}

// What a change means, in plain words, for the owner to read before/after saving.
export function describeEffect(before, after) {
  const out = [], b = normaliseSettings(before), a = normaliseSettings(after);
  const money = (n) => 'KES ' + Number(n).toLocaleString('en-KE');
  const names = { link: 'New link / setup (one-time)', subscription: 'Subscription (per cycle)', extraBranch: 'Extra branch (one-time)', branchBundle: 'Branch bundle (one-time)', staffBlock: 'Staff block (one-time)' };
  for (const k of Object.keys(names)) if (a.prices[k] !== b.prices[k]) out.push(`${names[k]}: ${money(b.prices[k])} -> ${money(a.prices[k])}. Applies to purchases from now on; what customers already agreed does not change.`);
  if (JSON.stringify(a.linkPrices) !== JSON.stringify(b.linkPrices)) out.push('Per-product link prices changed. Applies to new purchases only.');
  if (a.launchAt !== b.launchAt) out.push(a.launchAt ? `Billing launch: links CONFIRMED on or after ${eatDateTime(a.launchAt)} (Nairobi) start a ${a.periodDays}-day subscription. Every existing link stays exempt.` : 'Billing switched OFF: no new subscriptions start and nothing is blocked. Existing records are kept.');
  if (a.enforce !== b.enforce) out.push(a.enforce ? 'Enforcement ON: a shop whose paid period and grace have ended is suspended (its data is kept).' : 'Enforcement OFF: nobody is ever blocked; subscriptions are only tracked and shown.');
  for (const k of ['periodDays', 'graceDays', 'includedBranches', 'includedStaffPerBranch', 'bundleBranches', 'staffBlockSize']) if (a[k] !== b[k]) out.push(`${k}: ${b[k]} -> ${a[k]}. Applies to shops that buy from now on (an existing shop keeps its agreed terms until you edit it).`);
  if (JSON.stringify(a.referral) !== JSON.stringify(b.referral)) out.push('Referral rewards changed. Rewards already earned keep their value.');
  return out;
}

// ---------------------------------------------------------------- Nairobi time (display only; stored times stay epoch ms)
export function eatDateTime(ms) {
  if (!ms) return '';
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)); } catch (e) { return new Date(ms).toISOString(); }
}
export function eatDate(ms) {
  if (!ms) return '';
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms)); } catch (e) { return new Date(ms).toISOString().slice(0, 10); }
}

// ---------------------------------------------------------------- subscription state (pure; the record carries its own agreed terms)
// record.billing is absent for every shop that existed before billing: absent = GRANDFATHERED = never blocked. Missing fields never mean "expired".
export function subscriptionState(record, now = Date.now()) {
  const b = record && record.billing;
  if (!b || typeof b !== 'object' || b.cohort !== 'new') return { state: b && b.cohort === 'exempt' ? 'exempt' : 'grandfathered', blocking: false, billable: false };
  if (b.exempt === true) return { state: 'exempt', blocking: false, billable: false };
  const paid = Number(b.paidThrough) || 0;
  const graceMs = Math.max(0, Number.isFinite(Number(b.graceDays)) ? Number(b.graceDays) : DEFAULT_SETTINGS.graceDays) * DAY_MS;
  const base = { billable: true, paidThrough: paid, nextRenewalAt: paid, graceEndsAt: paid ? paid + graceMs : 0, price: Number(b.price) || 0, periodDays: Number(b.periodDays) || DEFAULT_SETTINGS.periodDays, claimPending: !!(b.claim && b.claim.at) };
  if (b.comped === true) return { ...base, state: 'comped', blocking: false };
  if (b.suspended === true) return { ...base, state: 'suspended', blocking: true, why: 'owner' };
  if (!(paid > 0)) return { ...base, state: 'awaiting', blocking: false };               // new cohort but no paid date recorded: never block on missing data
  if (now <= paid) return { ...base, state: 'active', blocking: false, daysLeft: Math.max(0, Math.ceil((paid - now) / DAY_MS)) };
  if (now <= paid + graceMs) return { ...base, state: 'grace', blocking: false, daysLeft: Math.max(0, Math.ceil((paid + graceMs - now) / DAY_MS)) };
  return { ...base, state: 'suspended', blocking: true, why: 'expired' };
}

// The new paid-through date after paying `cycles` periods. Early or in-grace renewal continues from the existing paid-through date (never shortens it);
// a shop already suspended starts again from now (it cannot buy time that has already passed).
export function nextPaidThrough({ paidThrough = 0, now = Date.now(), periodDays = DEFAULT_SETTINGS.periodDays, graceDays = DEFAULT_SETTINGS.graceDays, cycles = 1 }) {
  const paid = Number(paidThrough) || 0, graceMs = Math.max(0, graceDays) * DAY_MS;
  const base = paid && paid >= now - graceMs ? paid : now;
  return base + Math.max(1, cycles) * periodDays * DAY_MS;
}

// Branch and staff allowance of a subscribed shop: what its plan includes plus what it bought, against what it uses.
export function allowances(billing, settings) {
  const s = normaliseSettings(settings), b = billing && typeof billing === 'object' ? billing : {};
  const a = isObj(b.addons) ? b.addons : {};
  const inc = Number(b.includedBranches) || s.includedBranches, per = Number.isFinite(Number(b.includedStaffPerBranch)) ? Number(b.includedStaffPerBranch) : s.includedStaffPerBranch;
  const branches = inc + (Number(a.branches) || 0);
  const blockSize = Number(a.staffBlockSize) || s.staffBlockSize;
  return { branches, staff: branches * per + (Number(a.staffBlocks) || 0) * blockSize, includedBranches: inc, includedStaffPerBranch: per, extraBranches: Number(a.branches) || 0, staffBlocks: Number(a.staffBlocks) || 0 };
}

// ---------------------------------------------------------------- offers: pure discount maths (the SERVER is the only caller; a browser never sends an amount)
export function offerStatus(o, now = Date.now()) {
  if (!o || o.state === 'paused') return 'paused';
  if (o.startsAt && now < o.startsAt) return 'scheduled';
  if (o.endsAt && now >= o.endsAt) return 'expired';
  if (o.limitTotal > 0 && (o.used || 0) >= o.limitTotal) return 'used up';
  return 'active';
}
export function discountOf(amount, o) {
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  if (!o || !(Number(o.value) > 0) || amt === 0) return 0;
  let d = o.type === 'fixed' ? Math.round(Number(o.value)) : Math.floor((amt * Number(o.value)) / 100);
  if (o.maxDiscount > 0) d = Math.min(d, Math.round(o.maxDiscount));
  return Math.max(0, Math.min(d, amt));                                   // never below zero payable
}
// Which of the given offers apply here, and the best allowed combination. ctx = { applies: 'link'|'renewal'|'addon', beneficiary: 'buyer'|'referrer', code, cohort, amount, now, stack }
// A coded offer needs its code; an uncoded offer applies on its own. One offer per checkout unless the owner turned stacking on (every offer allows it separately).
export function pickOffers(offers, ctx) {
  const now = ctx.now || Date.now();
  const ok = (offers || []).filter((o) => offerStatus(o, now) === 'active'
    && Array.isArray(o.appliesTo) && o.appliesTo.includes(ctx.applies)
    && (o.beneficiary === 'both' || o.beneficiary === (ctx.beneficiary || 'buyer'))
    && (!o.cohort || o.cohort === 'all' || (ctx.cohorts || [ctx.cohort]).includes(o.cohort))      // cohort: 'all' | 'referred' (the buyer arrived through a referral)
    && (!o.code || (ctx.code && String(o.code).toUpperCase() === String(ctx.code).trim().toUpperCase())));
  if (!ok.length) return { picked: [], amounts: [], discount: 0 };
  let remaining = Math.max(0, Math.round(Number(ctx.amount) || 0)), total = 0;
  const ranked = ok.map((o) => ({ o, d: discountOf(ctx.amount, o) })).sort((a, b) => b.d - a.d);
  const picked = [], amounts = [];
  for (const { o } of ranked) {
    if (picked.length && !(o.stackable && picked.every((p) => p.stackable))) continue;
    const d = Math.min(remaining, discountOf(o.stackable ? remaining : ctx.amount, o));
    if (d <= 0) continue;
    picked.push(o); amounts.push(d); total += d; remaining -= d;
    if (!o.stackable) break;
  }
  return { picked, amounts, discount: total };
}

// ---------------------------------------------------------------- settings read, cached 30 s per isolate (the licence check asks on a hot path: no write, one KV read per 30 s)
const cache = new WeakMap();
export async function readSettings(env, { fresh = false } = {}) {
  const kv = env && env.mydukapos_kv;
  if (!kv) return normaliseSettings(null);
  const hit = cache.get(kv), now = Date.now();
  if (!fresh && hit && now - hit.at < 30000) return hit.s;
  let s;
  try { s = normaliseSettings(JSON.parse((await kv.get(SETTINGS_KEY)) || 'null')); } catch (e) { s = hit ? hit.s : normaliseSettings(null); }
  cache.set(kv, { at: now, s });
  return s;
}
export function forgetSettings(env) { const kv = env && env.mydukapos_kv; if (kv) cache.delete(kv); }
// Is subscription enforcement on right now (launch date set and in the past, kill switch not off)?
export const enforcementOn = (s, now = Date.now()) => !!(s && s.launchAt > 0 && s.launchAt <= now && s.enforce !== false);
