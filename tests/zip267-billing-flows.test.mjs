import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKV, seedShop } from './kv-fake.mjs';
import * as oa from '../functions/api/_owner-auth.js';
import { saveGatewayConfig } from '../functions/api/_gateway-config.js';
import { SHARED_DEMOS, ensureSharedDemo } from '../functions/api/_shared-demos.js';
import { createClient, getLicense, requireValidLicense, evaluateLicense } from '../functions/api/_license.js';
import { onRequestPost as gml } from '../functions/api/get-my-link.js';
import { onRequestPost as renew } from '../functions/api/billing-renew.js';
import { onRequestPost as ownerBilling } from '../functions/api/owner-billing.js';
import { onRequestPost as ownerConfirm } from '../functions/api/owner-confirm.js';
import { onRequestPost as terms } from '../functions/api/billing-terms.js';
import { onRequestGet as termsGet } from '../functions/api/billing-terms.js';
import { saveSettings, getSettings, saveOffer, refCodeFor, reversePayment, claimRef } from '../functions/api/_billing.js';
import { DAY_MS } from '../functions/api/_billing-core.js';
import { createHash } from 'node:crypto';
const PW = createHash('sha256').update('maryadmin').digest('hex');
const setPw = (w, id) => w.kv.data.set('pos-data:state:' + id, { value: JSON.stringify({ pwHash: PW }) });

// zip 267 - subscriptions, offers, referrals: the money, date and idempotency rules, end to end over the real handlers.
async function world({ stk = false } = {}) {
  const kv = makeKV(); const env = { mydukapos_kv: kv };
  const acct = await oa.createOwnerAccount(env, 'o@example.com', 'Sup3r-secret-pw');
  const sess = await oa.createOwnerSession(env, acct);
  if (stk) await saveGatewayConfig(env, acct.ownerClientId, { mpesaConsumerKey: 'k', mpesaConsumerSecret: 's', mpesaShortcode: '174379', mpesaPasskey: 'p', mpesaEnv: 'production' });
  await ensureSharedDemo(env, SHARED_DEMOS.find((d) => d.key === 'retail'));
  const req = (url, body, owner) => new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? { Authorization: 'Bearer ' + sess } : {}) }, body: JSON.stringify(body) });
  const buy = (body, owner = false) => gml({ env, request: req('https://x.pages.dev/api/get-my-link?c=demo_retail', body, owner) }).then(async (r) => ({ r, j: await r.json() }));
  const ob = (body) => ownerBilling({ env, request: req('https://x.pages.dev/api/owner-billing', body, true) }).then(async (r) => ({ r, j: await r.json() }));
  const my = (id, body) => renew({ env, request: req('https://x.pages.dev/api/billing-renew?c=' + id, body) }).then(async (r) => ({ r, j: await r.json() }));
  const launch = (extra = {}) => saveSettings(env, { launchAt: Date.now() - 1000, ...extra });
  return { kv, env, acct, sess, buy, ob, my, launch };
}
const buyer = { action: 'start', name: 'Mary Wanjiku', phone: '0712345678', email: '' };
const shopOf = async (w, name = 'Mary Wanjiku') => { const l = JSON.parse(w.kv.data.get('license-index:v1').value).find((c) => c.label === name); return l ? getLicense(w.env, l.id) : null; };
async function bought(w, over = {}) {                       // a purchase paid by "I've made this payment" and confirmed by the owner
  const s = await w.buy({ ...buyer, ...over }); await w.buy({ action: 'claim', id: s.j.id, token: s.j.token });
  const c = await w.buy({ action: 'confirm', id: s.j.id }, true);
  return { s, c, rec: await shopOf(w, over.name || 'Mary Wanjiku') };
}

test('before the launch date nothing is subscribed: the new link is exempt and never blocked', async () => {
  const w = await world();
  const { rec } = await bought(w);
  assert.equal(rec.billing.cohort, 'grandfathered'); assert.equal(rec.billing.paidThrough, undefined);
  assert.equal(evaluateLicense(rec, { subscriptions: true }).valid, true);
  assert.equal(rec.agreedAmount, 3000);
});

test('after the launch date a confirmed purchase starts a 31-day subscription with a price snapshot; confirming twice changes nothing', async () => {
  const w = await world(); await w.launch();
  const before = Date.now();
  const { rec, s } = await bought(w);
  assert.equal(rec.billing.cohort, 'new'); assert.equal(rec.billing.price, 400); assert.equal(rec.billing.graceDays, 3);
  assert.ok(rec.billing.paidThrough >= before + 31 * DAY_MS && rec.billing.paidThrough <= Date.now() + 31 * DAY_MS);
  assert.equal(rec.billing.history.length, 1); assert.equal(rec.billing.history[0].amount, 3000); assert.equal(rec.billing.history[0].quoted.subtotal, 3000);
  await w.buy({ action: 'confirm', id: s.j.id }, true); await w.buy({ action: 'confirm', id: s.j.id }, true);
  const again = await shopOf(w); assert.equal(again.billing.history.length, 1, 'one payment, one history line'); assert.equal(again.billing.paidThrough, rec.billing.paidThrough);
  // a later price change never rewrites what this shop agreed
  await saveSettings(w.env, { prices: { subscription: 900, link: 5000 } });
  assert.equal((await shopOf(w)).billing.price, 400);
});

test('suspension: online until grace ends, then blocked; a shop with no billing record is never blocked; kill switch and launch date switch it all off', async () => {
  const w = await world(); await w.launch();
  const { rec } = await bought(w);
  const req = new Request('https://x.pages.dev/api/x?c=' + rec.id);
  assert.equal((await requireValidLicense(req, w.env)).valid, true);
  const set = async (paidThrough) => { const r = await getLicense(w.env, rec.id); r.billing.paidThrough = paidThrough; await (await import('../functions/api/_license.js')).saveLicense(w.env, r); (await import('../functions/api/_license.js')).clearLicenseCache(w.env); };
  await set(Date.now() - 1 * DAY_MS); assert.equal((await requireValidLicense(req, w.env)).valid, true, 'inside grace');
  await set(Date.now() - 3 * DAY_MS - 60000);
  const r = await requireValidLicense(req, w.env); assert.equal(r.valid, false); assert.equal(r.reason, 'subscription_suspended');
  assert.ok((await getLicense(w.env, rec.id)), 'the shop and its data are still there');
  await saveSettings(w.env, { enforce: false }); assert.equal((await requireValidLicense(req, w.env)).valid, true, 'kill switch');
  await saveSettings(w.env, { enforce: true, launchAt: 0 }); assert.equal((await requireValidLicense(req, w.env)).valid, true, 'launch date cleared');
  const old = await createClient(w.env, 'permanent', 'Old Shop', 'shop', {});
  assert.equal((await requireValidLicense(new Request('https://x.pages.dev/api/x?c=' + old.id), w.env)).valid, true, 'no billing record = exempt');
});

test('an offer is worked out on the server: 20% off, the STK prompt is for the discounted amount, and a smaller payment does not release the link', async () => {
  const w = await world({ stk: true }); await w.launch();
  await saveOffer(w.env, { name: 'Launch 20%', code: 'LAUNCH20', type: 'percent', value: 20, appliesTo: ['link'], beneficiary: 'buyer' });
  const real = globalThis.fetch; const bodies = [];
  globalThis.fetch = async (url, init) => { if (String(url).includes('oauth')) return new Response(JSON.stringify({ access_token: 't' })); bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_9', MerchantRequestID: 'm', CustomerMessage: 'ok' })); };
  try {
    assert.equal((await w.buy({ action: 'quote', offer: 'LAUNCH20' })).j.quote.total, 2400);
    assert.equal((await w.buy({ action: 'quote' })).j.quote.total, 3000, 'no code, no discount');
    assert.equal((await w.buy({ action: 'quote', offer: 'launch20', amount: 1 })).j.quote.total, 2400, 'a browser-sent amount is ignored');
    const s = await w.buy({ ...buyer, offer: 'LAUNCH20' }); assert.equal(s.j.amount, 2400);
    assert.equal(bodies[0].Amount, 2400);
    const key = `mpesa-tx:${w.acct.ownerClientId}:ws_CO_9`, tx = JSON.parse(w.kv.data.get(key).value);
    w.kv.data.set(key, { value: JSON.stringify({ ...tx, status: 'success', amount: 2000, receiptNumber: 'ABC' }) });
    assert.equal((await w.buy({ action: 'status', id: s.j.id, token: s.j.token })).j.status, 'pending', 'paid less than quoted');
    w.kv.data.set(key, { value: JSON.stringify({ ...tx, status: 'success', amount: 2400, receiptNumber: 'ABC' }) });
    assert.equal((await w.buy({ action: 'status', id: s.j.id, token: s.j.token })).j.status, 'paid');
    const rec = await shopOf(w); assert.equal(rec.billing.history[0].quoted.discount.total, 600); assert.equal(rec.agreedAmount, 2400);
    const offers = (await w.ob({ action: 'offers' })).j.offers; assert.equal(offers[0].used, 1);
  } finally { globalThis.fetch = real; }
});

test('a link is the same price whether it is a new shop or a branch (KES 3,000), and the branch joins a subscribed shop\'s plan', async () => {
  const w = await world(); await w.launch();
  const mine = await createClient(w.env, 'permanent', 'Maryshardware', 'shop', { clientName: 'Mary', phone: '0712345678' });
  const { newBilling } = {}; void newBilling;
  setPw(w, mine.id);
  const r = await w.buy({ ...buyer, name: 'Mary Branch' }); assert.equal(r.j.needChoice, true); assert.equal(r.j.amount, 3000); assert.equal(r.j.branchAmount, 3000);
  const s = await w.buy({ ...buyer, name: 'Mary Branch', choice: 'branch', branchProof: PW }); assert.equal(s.j.amount, 3000);
  await w.buy({ action: 'claim', id: s.j.id, token: s.j.token }); await w.buy({ action: 'confirm', id: s.j.id }, true);
  const branchSum = JSON.parse(w.kv.data.get('license-index:v1').value).find((c) => c.branchGroupId && !c.isMainBranch); const branch = await getLicense(w.env, branchSum.id);
  assert.equal(branch.billing.cohort, 'grandfathered', 'a branch of a shop that predates billing stays exempt with it');
  assert.equal((await getLicense(w.env, mine.id)).billing, undefined, 'the existing shop is untouched');
});

test('renewal: early renewal extends from the paid-through date; the owner confirms an "I\'ve paid"; paying twice for one request counts once', async () => {
  const w = await world(); await w.launch();
  const { rec } = await bought(w);
  const first = rec.billing.paidThrough;
  const st = await w.my(rec.id, { action: 'status' }); assert.equal(st.j.plan.state, 'active'); assert.equal(st.j.renewal.total, 400); assert.equal(st.j.plan.cohort, 'new');
  const q = await w.my(rec.id, { action: 'quote', kind: 'renewal', cycles: 2 }); assert.equal(q.j.quote.total, 800);
  const s = await w.my(rec.id, { action: 'start', kind: 'renewal', cycles: 1, phone: '0712345678' }); assert.equal(s.j.method, 'claim'); assert.equal(s.j.amount, 400);
  assert.equal((await w.my(rec.id, { action: 'claim', id: s.j.id, token: 'bad' })).r.status, 404);
  await w.my(rec.id, { action: 'claim', id: s.j.id, token: s.j.token });
  assert.equal((await getLicense(w.env, rec.id)).billing.paidThrough, first, 'nothing changes until the owner confirms');
  assert.equal((await w.ob({ action: 'pays' })).j.pays[0].status, 'claimed');
  const c1 = await w.ob({ action: 'confirm-pay', id: s.j.id }); assert.equal(c1.r.status, 200);
  await w.ob({ action: 'confirm-pay', id: s.j.id });
  const after = await getLicense(w.env, rec.id); assert.equal(after.billing.paidThrough, first + 31 * DAY_MS, 'added to the existing date, once');
  assert.equal(after.billing.history.filter((h) => h.kind === 'renewal').length, 1);
});

test('referral: nothing is earned by a click or a pending payment; the reward appears once, only after the referred purchase is paid; a self-referral earns nothing', async () => {
  const w = await world(); await w.launch({ referral: { enabled: true, rewardType: 'percent', rewardValue: 50, appliesTo: ['renewal'] } });
  const { rec: ref } = await bought(w, { name: 'Referrer Shop', phone: '0711111111' });
  const code = await refCodeFor(w.env, await getLicense(w.env, ref.id));
  const s = await w.buy({ ...buyer, name: 'Friend Shop', phone: '0722222222', ref: code });
  assert.equal((await getLicense(w.env, ref.id)).billing.rewards.length, 0, 'a pending purchase earns nothing');
  await w.buy({ action: 'claim', id: s.j.id, token: s.j.token });
  assert.equal((await getLicense(w.env, ref.id)).billing.rewards.length, 0, 'a claim earns nothing');
  await w.buy({ action: 'confirm', id: s.j.id }, true); await w.buy({ action: 'confirm', id: s.j.id }, true);
  const after = await getLicense(w.env, ref.id);
  assert.equal(after.billing.rewards.length, 1, 'one reward, however many times it is confirmed'); assert.equal(after.billing.rewards[0].status, 'available');
  // the reward is a discount on the referrer's next renewal, and is spent exactly once
  const q = await w.my(ref.id, { action: 'quote', kind: 'renewal' }); assert.equal(q.j.quote.total, 200); assert.equal(q.j.quote.discount.reward.amount, 200);
  const p = await w.my(ref.id, { action: 'start', kind: 'renewal', phone: '0711111111' }); assert.equal(p.j.amount, 200);
  assert.equal((await w.my(ref.id, { action: 'quote', kind: 'renewal' })).j.quote.total, 400, 'reserved for the payment in progress: not spendable twice');
  await w.my(ref.id, { action: 'claim', id: p.j.id, token: p.j.token }); await w.ob({ action: 'confirm-pay', id: p.j.id });
  const used = await getLicense(w.env, ref.id); assert.equal(used.billing.rewards[0].status, 'used');
  assert.equal((await w.my(ref.id, { action: 'quote', kind: 'renewal' })).j.quote.total, 400);
  // self-referral: the same phone as the referrer
  const me = await w.buy({ ...buyer, name: 'Self Dealer', phone: '0711111111', ref: code });
  await w.buy({ action: 'claim', id: me.j.id, token: me.j.token }); await w.buy({ action: 'confirm', id: me.j.id }, true);
  assert.equal((await getLicense(w.env, ref.id)).billing.rewards.length, 1, 'no reward for a self-referral');
});

test('a reversed purchase voids its unused reward; a used one is flagged, not taken back', async () => {
  const w = await world(); await w.launch({ referral: { enabled: true, rewardValue: 20, appliesTo: ['renewal'] } });
  const { rec: ref } = await bought(w, { name: 'Referrer Shop', phone: '0711111111' });
  const code = await refCodeFor(w.env, await getLicense(w.env, ref.id));
  const s = await w.buy({ ...buyer, name: 'Friend Shop', phone: '0722222222', ref: code }); await w.buy({ action: 'claim', id: s.j.id, token: s.j.token }); await w.buy({ action: 'confirm', id: s.j.id }, true);
  const friend = await shopOf(w, 'Friend Shop');
  assert.equal((await w.ob({ action: 'reverse', ref: `purchase:${s.j.id}` })).r.status, 409, 'asks to confirm first');
  const r = await w.ob({ action: 'reverse', ref: `purchase:${s.j.id}`, confirm: true, note: 'refunded' }); assert.equal(r.j.voided, 1);
  assert.equal((await getLicense(w.env, ref.id)).billing.rewards[0].status, 'void');
  assert.equal((await w.ob({ action: 'reverse', ref: `purchase:${s.j.id}`, confirm: true })).j.dup, true, 'reversing twice changes nothing');
  assert.ok(await getLicense(w.env, friend.id), 'the shop itself is never deleted by a reversal');
  assert.equal((await w.my(ref.id, { action: 'quote', kind: 'renewal' })).j.quote.total, 400, 'a void reward is not redeemable');
});

test('offers: percent and fixed, capped, never negative; one per checkout unless stacking; windows and limits; paused', async () => {
  const w = await world(); await w.launch();
  const mk = (o) => saveOffer(w.env, { name: 'x', appliesTo: ['link'], beneficiary: 'buyer', type: 'percent', value: 10, ...o });
  assert.equal((await mk({ value: 150 })).ok, false); assert.equal((await mk({ appliesTo: [] })).ok, false); assert.equal((await mk({ type: 'fixed', value: 0 })).ok, false);
  await mk({ name: 'big', code: 'BIG', type: 'fixed', value: 5000 });
  assert.equal((await w.buy({ action: 'quote', offer: 'BIG' })).j.quote.total, 0, 'never below zero');
  const z = await w.buy({ ...buyer, offer: 'BIG' }); assert.equal(z.j.method, 'claim', 'a free checkout is still confirmed by the owner');
  await mk({ name: 'ended', code: 'OLD', endsAt: Date.now() - 1000 }); assert.equal((await w.buy({ action: 'quote', offer: 'OLD' })).j.quote.total, 3000);
  await mk({ name: 'limited', code: 'ONE', limitTotal: 1 });
  const s = await w.buy({ ...buyer, name: 'First One', offer: 'ONE' }); await w.buy({ action: 'claim', id: s.j.id, token: s.j.token }); await w.buy({ action: 'confirm', id: s.j.id }, true);
  assert.equal((await w.buy({ action: 'quote', offer: 'ONE' })).j.quote.total, 3000, 'used up');
  const id = (await w.ob({ action: 'offers' })).j.offers.find((o) => o.code === 'BIG').id;
  await w.ob({ action: 'offer-state', id, state: 'paused' }); assert.equal((await w.buy({ action: 'quote', offer: 'BIG' })).j.quote.total, 3000);
  assert.equal((await w.ob({ action: 'offer-save', offer: { name: 'dup', code: 'ONE', type: 'percent', value: 5, appliesTo: ['link'] } })).r.status, 400, 'codes are unique');
});

test('owner: settings validate and say what changes; per-shop edits that suspend or cut access ask first; existing shops are marked exempt without changing access', async () => {
  const w = await world();
  const bad = await w.ob({ action: 'settings-save', patch: { prices: { link: -1 } } }); assert.equal(bad.r.status, 400); assert.ok(bad.j.errors.length);
  const ok = await w.ob({ action: 'settings-save', patch: { prices: { subscription: 450 }, launchAt: Date.now() - 1000 } });
  assert.equal(ok.r.status, 200); assert.ok(ok.j.effect.some((e) => /400.*450/.test(e))); assert.match(ok.j.takesEffect, /30 seconds/);
  const { rec } = await bought(w);
  assert.equal(rec.billing.price, 450);
  const e1 = await w.ob({ action: 'shop-edit', id: rec.id, patch: { suspended: true } }); assert.equal(e1.r.status, 409); assert.ok(e1.j.summary[0]);
  assert.ok(!(await getLicense(w.env, rec.id)).billing.suspended);
  const e2 = await w.ob({ action: 'shop-edit', id: rec.id, patch: { suspended: true }, confirm: true }); assert.equal(e2.r.status, 200);
  const req = new Request('https://x.pages.dev/api/x?c=' + rec.id); assert.equal((await requireValidLicense(req, w.env)).reason, 'subscription_suspended');
  assert.equal((await my_pay(w, rec.id)).r.status, 403, 'a shop the owner put on hold cannot pay itself back in');
  await w.ob({ action: 'shop-edit', id: rec.id, patch: { suspended: false }, confirm: true });
  assert.equal((await requireValidLicense(req, w.env)).valid, true);
  const aud = (await w.ob({ action: 'audit', clientId: rec.id })).j.rows; assert.ok(aud.length >= 2); assert.equal(aud[0].actor, 'owner');
  // an existing shop is exempt, is marked on request, and its access never changes
  const old = await createClient(w.env, 'permanent', 'Old Shop', 'shop', {});
  const pv = (await w.ob({ action: 'cohort' })).j; assert.ok(pv.existing.permanentShops >= 1); assert.match(pv.inCohort.rule, /on or after/);
  const gf = (await w.ob({ action: 'grandfather' })).j; assert.ok(gf.marked >= 1);
  const marked = await getLicense(w.env, old.id); assert.equal(marked.billing.cohort, 'grandfathered'); assert.equal(marked.type, 'permanent');
  assert.equal((await w.ob({ action: 'shop-edit', id: old.id, patch: { suspended: true }, confirm: true })).r.status, 400, 'billing cannot convert or suspend an exempt shop');
  assert.equal((await requireValidLicense(new Request('https://x.pages.dev/api/x?c=' + old.id), w.env)).valid, true);
});
const my_pay = (w, id) => w.my(id, { action: 'start', kind: 'renewal', phone: '0712345678' });

test('public terms: the one source feeds the site; the subscription is only mentioned once billing is live', async () => {
  const w = await world();
  const get = async () => (await (await termsGet({ env: w.env, request: new Request('https://x.pages.dev/api/billing-terms') })).json()).terms;
  let t = await get(); assert.equal(t.link, 3000); assert.equal(t.subscription, null); assert.equal(t.addons.extraBranch.amount, 1000); assert.equal(t.addons.branchBundle.qty, 3); assert.equal(t.addons.staffBlock.qty, 5);
  await w.launch({ prices: { link: 3500, subscription: 450 } });
  t = await get(); assert.equal(t.link, 3500); assert.equal(t.subscription.amount, 450); assert.equal(t.subscription.periodDays, 31); assert.equal(t.subscription.includedBranches, 3);
  const wc = await (await (await import('../functions/api/website-content.js')).onRequestPost({ env: w.env, request: new Request('https://x.pages.dev/api/website-content', { method: 'POST', body: JSON.stringify({ action: 'get' }) }) })).json();
  assert.equal(wc.content.price, 3500, 'the public site reads the same number'); assert.equal(wc.content.monthlyFee, 450); assert.equal(wc.content.includedDays, 31);
  const q = await (await terms({ env: w.env, request: new Request('https://x.pages.dev/api/billing-terms', { method: 'POST', body: JSON.stringify({ action: 'quote', product: 'hotel' }) }) })).json();
  assert.equal(q.quote.total, 3500); assert.match(q.quote.recurringNote.text, /first 31 days/);
});

test('per-product link price is an override inside the same source', async () => {
  const w = await world();
  await saveSettings(w.env, { linkPrices: { shop: 2800, hotel: 4000 } });
  assert.equal((await w.buy({ action: 'quote' })).j.quote.total, 2800, 'the retail sample shop is a shop');
  const s = await getSettings(w.env, { fresh: true }); assert.equal(s.linkPrices.hotel, 4000); assert.equal(s.prices.link, 3000);
});

test('a subscribed shop buys add-ons: they extend its allowance once and are priced from the source', async () => {
  const w = await world(); await w.launch();
  const { rec } = await bought(w);
  const q = await w.my(rec.id, { action: 'quote', kind: 'branchBundle' }); assert.equal(q.j.quote.total, 3000);
  const s = await w.my(rec.id, { action: 'start', kind: 'extraBranch', qty: 2, phone: '0712345678' }); assert.equal(s.j.amount, 2000);
  await w.my(rec.id, { action: 'claim', id: s.j.id, token: s.j.token }); await w.ob({ action: 'confirm-pay', id: s.j.id }); await w.ob({ action: 'confirm-pay', id: s.j.id });
  const sv = await w.ob({ action: 'shop', id: rec.id }); assert.equal(sv.j.billing.allowance.branches, 5); assert.equal(sv.j.billing.allowance.extraBranches, 2);
  const b = await w.my(rec.id, { action: 'start', kind: 'staffBlock', phone: '0712345678' }); assert.equal(b.j.amount, 500);
  await w.my(rec.id, { action: 'claim', id: b.j.id, token: b.j.token }); await w.ob({ action: 'confirm-pay', id: b.j.id });
  assert.equal((await w.ob({ action: 'shop', id: rec.id })).j.billing.allowance.staff, 5 * 5 + 5);
});

test('a branch bought as a link by a SUBSCRIBED shop follows its plan, counts as one more licensed branch, and renewals reach it', async () => {
  const w = await world(); await w.launch();
  const { rec: main } = await bought(w, { name: 'Maryshardware' }); setPw(w, main.id);
  const s = await w.buy({ ...buyer, name: 'Mary Branch', choice: 'branch', branchProof: PW }); assert.equal(s.j.amount, 3000);
  await w.buy({ action: 'claim', id: s.j.id, token: s.j.token }); await w.buy({ action: 'confirm', id: s.j.id }, true);
  const sum = JSON.parse(w.kv.data.get('license-index:v1').value).find((c) => c.branchGroupId && !c.isMainBranch);
  const branch = await getLicense(w.env, sum.id), m1 = await getLicense(w.env, main.id);
  assert.equal(branch.billing.cohort, 'new'); assert.equal(branch.billing.followsMain, main.id); assert.equal(branch.billing.paidThrough, m1.billing.paidThrough);
  assert.equal(m1.billing.addons.branches, 1, 'one more licensed branch');
  // renewing the main shop extends the branch too: one subscription per shop
  const p = await w.my(main.id, { action: 'start', kind: 'renewal', phone: '0712345678' }); await w.my(main.id, { action: 'claim', id: p.j.id, token: p.j.token }); await w.ob({ action: 'confirm-pay', id: p.j.id });
  const m2 = await getLicense(w.env, main.id), b2 = await getLicense(w.env, branch.id);
  assert.equal(m2.billing.paidThrough, m1.billing.paidThrough + 31 * DAY_MS); assert.equal(b2.billing.paidThrough, m2.billing.paidThrough);
  // and the branch's own address can pay for the group
  const st = await w.my(branch.id, { action: 'status' }); assert.equal(st.j.plan.cohort, 'new'); assert.equal(st.j.renewal.total, 400);
});

// ---- receipts, referral through the sample redirect, and the Website tab no longer owning the price ----
import { onRequestGet as demosGet } from '../functions/api/shared-demos.js';
import { onRequestPost as websiteContent } from '../functions/api/website-content.js';
const pdfText = async (r) => Buffer.from(await r.arrayBuffer()).toString('latin1').replace(/\\([()\\])/g, '$1');      // the page text with PDF string escapes removed

test('the licence receipt shows the quote, the discount and the first period in Nairobi time; a renewal receipt shows the new paid-through date', async () => {
  const w = await world(); await w.launch();
  await saveOffer(w.env, { name: 'Launch 20%', code: 'LAUNCH20', type: 'percent', value: 20, appliesTo: ['link'], beneficiary: 'buyer' });
  const s = await w.buy({ ...buyer, offer: 'LAUNCH20' }); await w.buy({ action: 'claim', id: s.j.id, token: s.j.token }); await w.buy({ action: 'confirm', id: s.j.id }, true);
  const r = await gml({ env: w.env, request: new Request('https://x.pages.dev/api/get-my-link?c=demo_retail', { method: 'POST', body: JSON.stringify({ action: 'licence', id: s.j.id, token: s.j.token }) }) });
  assert.equal(r.status, 200); const t = await pdfText(r);
  assert.match(t, /Discount \(Launch 20%\)/); assert.match(t, /KES 2,400/); assert.match(t, /KES 600/); assert.match(t, /Your first 31 days run to \d+ \w+ 20\d\d \(Nairobi\)/); assert.match(t, /KES 400 every 31 days/);
  const rec = await shopOf(w);
  const p = await w.my(rec.id, { action: 'start', kind: 'renewal', phone: '0712345678' }); await w.my(rec.id, { action: 'claim', id: p.j.id, token: p.j.token });
  assert.equal((await renew({ env: w.env, request: new Request('https://x.pages.dev/api/billing-renew?c=' + rec.id, { method: 'POST', body: JSON.stringify({ action: 'receipt', id: p.j.id, token: p.j.token }) }) })).status, 400, 'no receipt before it is paid');
  await w.ob({ action: 'confirm-pay', id: p.j.id });
  const rr = await renew({ env: w.env, request: new Request('https://x.pages.dev/api/billing-renew?c=' + rec.id, { method: 'POST', body: JSON.stringify({ action: 'receipt', id: p.j.id, token: p.j.token }) }) });
  assert.equal(rr.status, 200); const t2 = await pdfText(rr); assert.match(t2, /Payment receipt/); assert.match(t2, /Your plan now runs to \d+ \w+ 20\d\d \(Nairobi\)/); assert.match(t2, /KES 400/);
});

test('a referral code rides through the sample redirect (shape-checked); a bad one is dropped', async () => {
  const w = await world();
  const open = (q) => demosGet({ env: w.env, request: new Request('https://x.pages.dev/api/shared-demos?open=retail' + q) });
  assert.match((await open('&ref=mdabc234')).headers.get('Location'), /[?&]ref=MDABC234/);
  assert.doesNotMatch((await open('&ref=<script>')).headers.get('Location'), /ref=/);
});

test('the Website tab can no longer set the price or plan: whatever it sends is ignored, the site reads Billing', async () => {
  const w = await world(); await w.launch({ prices: { link: 3300 } });
  const post = (b, owner) => websiteContent({ env: w.env, request: new Request('https://x.pages.dev/api/website-content', { method: 'POST', headers: owner ? { Authorization: 'Bearer ' + w.sess } : {}, body: JSON.stringify(b) }) });
  const res = await post({ action: 'set', content: { price: 99999, includedDays: 1, monthlyFee: 7, paymentPhone: '0700000000', demoDurationHours: 72, visibleProducts: ['shop'], alternatePaymentMethods: [], testimonials: [] } }, true);
  assert.equal(res.status, 200);
  const j = await (await post({ action: 'get' })).json();
  assert.equal(j.content.price, 3300); assert.equal(j.content.monthlyFee, 400); assert.equal(j.content.includedDays, 31); assert.equal(j.content.paymentPhone, '0700000000');
});

// ---- regression tests for the independent review's findings ----
import { createBranchFor } from '../functions/api/branches.js';
import { applyRenewal, resolveReferral, listEvents, syncGroupBilling } from '../functions/api/_billing.js';
import { saveLicense } from '../functions/api/_license.js';
const oc = (w, body) => ownerConfirm({ env: w.env, request: new Request('https://x.pages.dev/api/owner-confirm', { method: 'POST', headers: { Authorization: 'Bearer ' + w.sess }, body: JSON.stringify(body) }) }).then(async (r) => ({ r, j: await r.json() }));
const flags = async (w) => (await listEvents(w.env, { limit: 100 })).rows.filter((e) => e.kind === 'flag');

test('review 1: a branch added with Add Branch follows the main shop plan at once (never runs free beside a paused main)', async () => {
  const w = await world(); await w.launch();
  const { rec: main } = await bought(w);
  const made = await createBranchFor(w.env, await getLicense(w.env, main.id), 'North', {});
  const b = await getLicense(w.env, made.branch.id), m = await getLicense(w.env, main.id);
  assert.equal(b.billing.cohort, 'new'); assert.equal(b.billing.followsMain, main.id); assert.equal(b.billing.paidThrough, m.billing.paidThrough);
  m.billing.paidThrough = Date.now() - 5 * DAY_MS; await saveLicense(w.env, m); await syncGroupBilling(w.env, m);       // the main shop lapses past grace
  assert.equal((await requireValidLicense(new Request('https://x.pages.dev/api/x?c=' + b.id), w.env)).reason, 'subscription_suspended', 'the branch is paused with it');
});

test('review 2: renewing the main keeps each branch’s own history, rewards and code; editing a branch edits the MAIN shop, never the other way round', async () => {
  const w = await world(); await w.launch({ referral: { enabled: true, rewardValue: 20, appliesTo: ['renewal'] } });
  const { rec: main } = await bought(w);
  const made = await createBranchFor(w.env, await getLicense(w.env, main.id), 'North', {});
  const br = await getLicense(w.env, made.branch.id); const code = await refCodeFor(w.env, br);
  br.billing.rewards = [{ id: 'RWX', status: 'available', type: 'percent', value: 20, appliesTo: ['renewal'], createdAt: Date.now() }]; br.billing.history = [{ ref: 'own', kind: 'x', amount: 1, at: Date.now() }]; await saveLicense(w.env, br);
  const p = await w.my(main.id, { action: 'start', kind: 'renewal', phone: '0712345678' }); await w.my(main.id, { action: 'claim', id: p.j.id, token: p.j.token }); await w.ob({ action: 'confirm-pay', id: p.j.id });
  const b2 = await getLicense(w.env, br.id); assert.equal(b2.billing.refCode, code); assert.equal(b2.billing.rewards[0].id, 'RWX'); assert.equal(b2.billing.history[0].ref, 'own');
  const m1 = await getLicense(w.env, main.id); assert.equal(b2.billing.paidThrough, m1.billing.paidThrough);
  const histBefore = m1.billing.history.length;
  const e = await w.ob({ action: 'shop-edit', id: br.id, patch: { price: 555 }, confirm: true }); assert.equal(e.r.status, 200);
  const m2 = await getLicense(w.env, main.id), b3 = await getLicense(w.env, br.id);
  assert.equal(m2.billing.price, 555, 'the edit landed on the main shop'); assert.equal(m2.billing.history.length, histBefore, 'the main keeps its payment history'); assert.equal(b3.billing.price, 555); assert.equal(b3.billing.rewards[0].id, 'RWX');
});

test('review 3: a referral reward cannot be spent by two payments, even after its hold ran out', async () => {
  const w = await world(); await w.launch({ referral: { enabled: true, rewardType: 'percent', rewardValue: 50, appliesTo: ['renewal'] } });
  const { rec: ref } = await bought(w, { name: 'Referrer Shop', phone: '0711111111' });
  const code = await refCodeFor(w.env, await getLicense(w.env, ref.id));
  const f = await w.buy({ ...buyer, name: 'Friend Shop', phone: '0722222222', ref: code }); await w.buy({ action: 'claim', id: f.j.id, token: f.j.token }); await w.buy({ action: 'confirm', id: f.j.id }, true);
  const A = await w.my(ref.id, { action: 'start', kind: 'renewal', phone: '0711111111' }); assert.equal(A.j.amount, 200);
  await w.my(ref.id, { action: 'claim', id: A.j.id, token: A.j.token });
  const lic = await getLicense(w.env, ref.id); lic.billing.rewards[0].reservedUntil = Date.now() - 1000; await saveLicense(w.env, lic);      // A’s hold ran out while its payment was still unpaid
  const B = await w.my(ref.id, { action: 'start', kind: 'renewal', phone: '0711111111' }); assert.equal(B.j.amount, 200, 'free again, so B may take it');
  await w.my(ref.id, { action: 'claim', id: B.j.id, token: B.j.token });
  await w.ob({ action: 'confirm-pay', id: A.j.id }); await w.ob({ action: 'confirm-pay', id: B.j.id });
  const after = await getLicense(w.env, ref.id), rw = after.billing.rewards[0];
  assert.equal(rw.status, 'used'); assert.equal(rw.usedRef, `renewal:${B.j.id}`, 'spent once, by the payment that held it');
  assert.ok((await flags(w)).some((e) => /already used, voided or held for another payment/.test(e.note)), 'the owner is told the other discount was not backed by a reward');
});

test('review 4: a retry after a half-finished renewal does not add the time twice', async () => {
  const w = await world(); await w.launch();
  const { rec } = await bought(w); const first = rec.billing.paidThrough;
  const live = await getLicense(w.env, rec.id), q = await (await import('../functions/api/_billing.js')).buildQuote(w.env, { kind: 'renewal', record: live });
  const r1 = await applyRenewal(w.env, live, { ref: 'renewal:retry1', quote: q, method: 'test' }); assert.equal(r1.paidThrough, first + 31 * DAY_MS);
  w.kv.data.delete('bill-ref:renewal:retry1');                                                                                 // what a failed attempt’s cleanup leaves behind
  const r2 = await applyRenewal(w.env, await getLicense(w.env, rec.id), { ref: 'renewal:retry1', quote: q, method: 'test' });
  assert.equal((await getLicense(w.env, rec.id)).billing.paidThrough, first + 31 * DAY_MS, 'still one cycle'); assert.equal(r2.ok, true);
});

test('review 5: two requests finishing one purchase at once leave exactly one live shop', async () => {
  const w = await world(); await w.launch();
  const s = await w.buy(buyer); await w.buy({ action: 'claim', id: s.j.id, token: s.j.token });
  const put = w.kv.put; w.kv.put = async (k, v, o) => { await new Promise((r) => setTimeout(r, 3)); return put(k, v, o); };      // storage that takes a moment, as the real one does: the requests genuinely overlap
  await Promise.all([w.buy({ action: 'confirm', id: s.j.id }, true), w.buy({ action: 'confirm', id: s.j.id }, true), w.buy({ action: 'status', id: s.j.id, token: s.j.token })]);
  w.kv.put = put;
  // counted from the licence records themselves (the shared index can lose one of two simultaneous writes)
  const live = [...w.kv.data.keys()].filter((k) => k.startsWith('license:')).map((k) => JSON.parse(w.kv.data.get(k).value)).filter((r) => r.label && r.label.startsWith('Mary Wanjiku') && !r.deleted);
  assert.equal(live.length, 1, 'never two live shops for one payment');
  assert.equal(live[0].billing.history.length, 1);
});

test('review 6: re-confirming a shop that was already permanent never subscribes it; a real upgrade starts billing before it becomes permanent', async () => {
  const w = await world(); await w.launch();
  const old = await createClient(w.env, 'permanent', 'Old Shop', 'shop', {});
  assert.equal((await oc(w, { c: old.id })).r.status, 200);
  assert.equal((await getLicense(w.env, old.id)).billing, undefined, 'an existing permanent shop stays exempt');
  const demo = await createClient(w.env, 'demo', 'Trial Shop', 'shop', {});
  assert.equal((await oc(w, { c: demo.id })).r.status, 200);
  const up = await getLicense(w.env, demo.id); assert.equal(up.type, 'permanent'); assert.equal(up.billing.cohort, 'new'); assert.ok(up.billing.paidThrough > Date.now());
  await oc(w, { c: demo.id });
  assert.equal((await getLicense(w.env, demo.id)).billing.history.length, 1, 'confirming again does not count a second payment');
});

test('review 7: a double-clicked manual confirmation counts once (renewal and branch add-on)', async () => {
  const w = await world(); await w.launch();
  const { rec } = await bought(w); const first = rec.billing.paidThrough;
  const put = w.kv.put; w.kv.put = async (k, v, o) => { await new Promise((r) => setTimeout(r, 3)); return put(k, v, o); };      // slow storage: the two presses genuinely overlap
  await Promise.all([w.ob({ action: 'manual-renewal', id: rec.id, cycles: 1 }), w.ob({ action: 'manual-renewal', id: rec.id, cycles: 1 })]);
  assert.equal((await getLicense(w.env, rec.id)).billing.paidThrough, first + 31 * DAY_MS, 'one cycle, not two');
  await Promise.all([oc(w, { c: rec.id, action: 'confirm-addon' }), oc(w, { c: rec.id, action: 'confirm-addon' })]);
  w.kv.put = put;
  const after = await getLicense(w.env, rec.id); assert.equal(after.billing.addons.branches, 1); assert.equal(after.branchAllowance, (rec.branchAllowance || 0) + 1);
});

test('review 8: offer use is counted once per payment in its own key; an offer over its limit at confirmation is flagged, not silently exceeded', async () => {
  const w = await world(); await w.launch();
  await saveOffer(w.env, { name: 'Only one', code: 'ONE', type: 'percent', value: 10, appliesTo: ['link'], beneficiary: 'buyer', limitTotal: 1 });
  const a = await w.buy({ ...buyer, name: 'Shop A', phone: '0711000001', offer: 'ONE' }), b = await w.buy({ ...buyer, name: 'Shop B', phone: '0711000002', offer: 'ONE' });
  assert.equal(a.j.amount, 2700); assert.equal(b.j.amount, 2700, 'both were quoted before either was confirmed');
  for (const x of [a, b]) { await w.buy({ action: 'claim', id: x.j.id, token: x.j.token }); await w.buy({ action: 'confirm', id: x.j.id }, true); await w.buy({ action: 'confirm', id: x.j.id }, true); }
  assert.equal(w.kv.data.get(`billing-offer-used:${(await w.ob({ action: 'offers' })).j.offers[0].id}`).value, '2', 'each payment counted once');
  assert.ok((await flags(w)).some((e) => /over its limit/.test(e.note)));
  await w.ob({ action: 'offer-save', offer: { ...(await w.ob({ action: 'offers' })).j.offers[0], name: 'Renamed' } });
  assert.equal((await w.ob({ action: 'offers' })).j.offers[0].used, 2, 'editing an offer cannot reset its count');
});

test('review 9: a payment that arrives for a shop the owner put on hold is recorded and flagged; the shop stays on hold', async () => {
  const w = await world(); await w.launch();
  const { rec } = await bought(w);
  const p = await w.my(rec.id, { action: 'start', kind: 'renewal', phone: '0712345678' }); await w.my(rec.id, { action: 'claim', id: p.j.id, token: p.j.token });
  await w.ob({ action: 'shop-edit', id: rec.id, patch: { suspended: true }, confirm: true });
  const c = await w.ob({ action: 'confirm-pay', id: p.j.id }); assert.equal(c.r.status, 200);
  assert.ok((await flags(w)).some((e) => /received while this shop is on hold/.test(e.note)));
  const after = await getLicense(w.env, rec.id); assert.equal(after.billing.suspended, true); assert.equal(after.billing.history.filter((h) => h.kind === 'renewal').length, 1);
});

test('review 10: the self-referral note is written at most once a day per referrer; public price checks are rate limited', async () => {
  const w = await world(); await w.launch({ referral: { enabled: true, rewardValue: 20, appliesTo: ['renewal'] } });
  const { rec: ref } = await bought(w, { name: 'Referrer Shop', phone: '0711111111' });
  const code = await refCodeFor(w.env, await getLicense(w.env, ref.id));
  for (let i = 0; i < 5; i++) await resolveReferral(w.env, code, { phone: '0711111111', email: 'v' + i + '@x.com' });
  assert.equal((await flags(w)).filter((e) => /Self-referral/.test(e.note)).length, 1);
});

test('review 11: a phone or email is not proof: no Admin password, no branch', async () => {
  const w = await world(); await w.launch();
  const mine = await createClient(w.env, 'permanent', 'Maryshardware', 'shop', { phone: '0712345678' }); setPw(w, mine.id);
  assert.equal((await w.buy({ ...buyer, choice: 'branch' })).r.status, 403);
  assert.equal((await w.buy({ ...buyer, choice: 'branch', branchProof: '1'.repeat(64) })).r.status, 403);
  assert.ok(!(await getLicense(w.env, mine.id)).branchGroupId, 'the existing shop was never touched');
  assert.equal((await w.buy({ ...buyer, choice: 'separate' })).r.status, 200, 'a separate link is always available');
});
