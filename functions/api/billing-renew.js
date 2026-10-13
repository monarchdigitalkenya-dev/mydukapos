// functions/api/billing-renew.js — Cloudflare Pages Function (zip 267). A shop's own "My plan": see the subscription, renew it early or late, buy add-ons, share a referral code.
//
// Reached from the shop's own address, and ALWAYS reachable, even when the shop is suspended (a suspended shop must be able to pay: this endpoint does NOT use
// requireValidLicense). It only ever sends a payment prompt to a phone and reads the result; it changes a shop only when a payment is CONFIRMED.
//
//   { action:'status' }                                         -> the shop's plan, prices (from the one pricing source), payment method available, referral card
//   { action:'quote',  kind:'renewal'|'extraBranch'|'branchBundle'|'staffBlock', cycles, qty, offer }   -> the breakdown, discounts worked out here
//   { action:'start',  kind, cycles, qty, offer, phone }         -> sends the M-Pesa prompt (when the owner's gateway is set up) or waits for "I've paid"
//   { action:'poll',   id, token }                               -> reads the prompt's result and, ONCE it is confirmed paid, extends the plan / adds the add-on
//   { action:'claim',  id, token }                               -> "I've made this payment" (no gateway): the owner confirms it in the Owner Console
//   { action:'referral' }                                        -> this shop's referral code, link, rewards
//
// Paid time is added to the existing paid-through date, so renewing early never shortens what the shop already paid for. A shop the owner suspended by hand cannot pay itself back in.

import { resolveLicense, getLicense, getGroupMainRecord, saveLicense, randomToken, getRootDomain } from './_license.js';
import { getSettings, buildQuote, publicQuote, publicTerms, shopView, applyRenewal, applyAddon, referralView, isLive, productLabel } from './_billing.js';
import { eatDateTime, eatDate } from './_billing-core.js';
import { normalizePhone, validPhone, ownerGateway, sendOwnerStk, readOwnerTx } from './_pay-owner.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';
import { buildLicencePdf } from './_licence-pdf.js';
import { corsHeadersFor } from './_cors.js';

const CORS_OPTS = { methods: 'POST, OPTIONS', headers: 'Content-Type' };
const json = (b, st, cors) => new Response(JSON.stringify(b), { status: st || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(cors || {}) } });
const KINDS = ['renewal', 'extraBranch', 'branchBundle', 'staffBlock'];
const PAY_INDEX = 'bill-pay-index:v1';
async function paymentPhone(env) { let c = {}; try { c = JSON.parse((await env.mydukapos_kv.get('website-content')) || '{}'); } catch (e) { c = {}; } return String(c.paymentPhone || '0113607529'); }
const pkey = (id) => `bill-pay:${String(id).slice(0, 40)}`;
export const loadPay = async (env, id) => { const r = id ? await env.mydukapos_kv.get(pkey(id)) : null; return r ? JSON.parse(r) : null; };
export const savePay = (env, p) => env.mydukapos_kv.put(pkey(p.id), JSON.stringify(p), { expirationTtl: 400 * 86400 });
async function indexPay(env, id) {
  let ids = []; try { ids = JSON.parse((await env.mydukapos_kv.get(PAY_INDEX)) || '[]'); } catch (e) { ids = []; }
  await env.mydukapos_kv.put(PAY_INDEX, JSON.stringify([id, ...ids.filter((x) => x !== id)].slice(0, 300)));
}
export async function listPays(env, limit = 60) {
  let ids = []; try { ids = JSON.parse((await env.mydukapos_kv.get(PAY_INDEX)) || '[]'); } catch (e) { ids = []; }
  return (await Promise.all(ids.slice(0, limit).map((id) => loadPay(env, id)))).filter(Boolean).map(({ token, ...p }) => p);
}

export async function onRequestOptions(context) { return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, CORS_OPTS) }); }

// Confirmed paid (by the gateway or by the owner): apply it ONCE. Safe to call again (a retry or a second poll changes nothing).
export async function fulfillPay(env, pay, { receipt = '', method = 'stk' } = {}) {
  if (pay.status === 'paid') return pay;
  const rec = await getGroupMainRecord(env, await getLicense(env, pay.clientId));
  if (!rec || !rec.billing) throw new Error('The shop for this payment is no longer available.');
  const r = pay.kind === 'renewal' ? await applyRenewal(env, rec, { ref: `renewal:${pay.id}`, payId: pay.id, quote: pay.quote, method, receipt })
    : await applyAddon(env, rec, { ref: `addon:${pay.id}`, payId: pay.id, quote: pay.quote, method, receipt });
  if (r.ok === false) throw new Error(r.error || 'Could not apply the payment.');
  Object.assign(pay, { status: 'paid', paidAt: Date.now(), receipt: receipt || '', method, paidThrough: r.paidThrough || rec.billing.paidThrough || 0, heldSuspended: !!r.heldSuspended });
  await savePay(env, pay);
  return pay;
}
async function releaseReward(env, pay) {
  const q = pay.quote; if (!q || !q.discount || !q.discount.reward) return;
  const rec = await getLicense(env, pay.clientId);
  const r = rec && rec.billing && (rec.billing.rewards || []).find((x) => x.id === q.discount.reward.id);
  if (r && r.status === 'reserved' && r.reservedFor === pay.id) { r.status = 'available'; delete r.reservedFor; delete r.reservedUntil; await saveLicense(env, rec); }
}
const pubPay = (p) => ({ id: p.id, status: p.status, kind: p.kind, amount: p.amount, method: p.method, paidThroughLabel: p.paidThrough ? eatDateTime(p.paidThrough) : '', message: p.resultDesc || undefined });

export async function onRequestPost(context) {
  const { request, env } = context, cors = corsHeadersFor(request, env, CORS_OPTS), reply = (b, st) => json(b, st, cors);
  let body = {}; try { body = await request.json(); } catch (e) { return reply({ error: 'Invalid request.' }, 400); }
  const action = String(body.action || '');
  const { clientId, record: own } = await resolveLicense(request, env);
  if (!own || own.deleted || own.type !== 'permanent' || own.sharedDemo) return reply({ error: 'My plan is for permanent shops.' }, 404);
  const main = await getGroupMainRecord(env, own);
  const settings = await getSettings(env);
  const siteOrigin = `https://${getRootDomain(env)}`;                                     // the public site, where a referral link lands

  if (action === 'status') {
    const view = await shopView(env, own, settings), gw = await ownerGateway(env);
    const subscribed = view.cohort === 'new';
    const q = subscribed ? await buildQuote(env, { kind: 'renewal', record: main, settings }) : null;
    return reply({
      shop: { label: own.label || own.slug || '', product: productLabel(own.product) }, plan: view, terms: publicTerms(settings), live: isLive(settings),
      renewal: q ? publicQuote(q) : null, canPay: subscribed && !view.exempt && !view.comped && !view.suspended,
      holdMessage: view.suspended ? 'This shop is on hold. Please contact support to restore access. Nothing has been deleted.' : '',
      stk: !!gw, paymentPhone: await paymentPhone(env), referral: await referralView(env, own, siteOrigin),
    });
  }
  if (action === 'referral') return reply(await referralView(env, own, siteOrigin));

  // everything below is about paying: only a subscribed shop, and not one the owner put on hold
  if (!main || !main.billing || main.billing.cohort !== 'new') return reply({ error: 'This shop has no subscription, so there is nothing to pay.' }, 400);
  if (main.billing.exempt || main.billing.comped) return reply({ error: 'This shop does not need to pay.' }, 400);
  if (main.billing.suspended) return reply({ error: 'This shop is on hold. Please contact support to restore access. Nothing has been deleted.' }, 403);

  if (action === 'quote' || action === 'start') {
    const kind = KINDS.includes(body.kind) ? body.kind : 'renewal';
    const q = await buildQuote(env, { kind, record: main, cycles: body.cycles, qty: body.qty, offerCode: body.offer, settings });
    if (action === 'quote') return reply({ quote: publicQuote(q) });
    const phone = normalizePhone(body.phone);
    if (!validPhone(phone)) return reply({ error: 'Enter a valid phone number, like 0712345678.' }, 400);
    const rl = await checkRateLimit(env, 'buyLink', request.headers.get('CF-Connecting-IP') || 'unknown');
    if (!rl.ok) return rateLimitResponse('payment requests', rl, cors);
    const gw = q.total > 0 ? await ownerGateway(env) : null;                                    // nothing to pay (a full discount) is still confirmed by the owner
    const pay = { id: randomToken(12), token: randomToken(24), status: 'pending', kind, clientId: main.id, qty: q.qty, amount: q.total, quote: q, phone, method: gw ? 'stk' : 'claim', createdAt: Date.now() };
    if (gw) {
      const rp = await checkRateLimit(env, 'stkPhone', gw.clientId + ':' + phone, 1);
      if (!rp.ok) return rateLimitResponse('payment prompts to this phone number', rp, cors);
    }
    if (q.discount.reward) {                                                                    // the earned reward is held for this payment for 2 hours; a payment confirmed later can only spend it if it is still held for it
      const r = (main.billing.rewards || []).find((x) => x.id === q.discount.reward.id);
      if (r) { r.status = 'reserved'; r.reservedFor = pay.id; r.reservedUntil = Date.now() + 2 * 3600000; await saveLicense(env, main); }
    }
    if (gw) {
      try { const r = await sendOwnerStk(env, request, gw, { phone, amount: q.total, accountRef: 'MyDukaPOS', description: kind === 'renewal' ? 'POS renewal' : 'POS add-on' }); pay.checkoutId = r.checkoutId; pay.provider = r.provider; pay.paymentUrl = r.paymentUrl; }
      catch (e) { await releaseReward(env, pay); return reply({ error: (e && e.message) || 'The payment prompt could not be sent.' }, 502); }
    }
    await savePay(env, pay); await indexPay(env, pay.id);
    return reply({ id: pay.id, token: pay.token, method: pay.method, amount: pay.amount, quote: publicQuote(q), paymentUrl: pay.paymentUrl });
  }

  const pay = await loadPay(env, body.id);
  if (!pay || !pay.token || pay.token !== String(body.token || '') || pay.clientId !== main.id) return reply({ error: 'Payment not found.' }, 404);
  if (action === 'claim') {
    if (pay.method !== 'claim') return reply({ error: 'This payment is made by the payment prompt.' }, 400);
    if (pay.status === 'pending') {
      pay.status = 'claimed'; pay.claimedAt = Date.now(); await savePay(env, pay);
      main.billing.claim = { at: pay.claimedAt, id: pay.id }; await saveLicense(env, main);       // shows as "awaiting payment confirmation" to the owner; access is unchanged until the owner confirms
    }
    return reply(pubPay(pay));
  }
  if (action === 'receipt') {
    if (pay.status !== 'paid') return reply({ error: 'The receipt is issued once the payment is complete.' }, 400);
    const q = pay.quote, label = { renewal: 'Subscription renewal', extraBranch: 'Extra branch', branchBundle: 'Branch bundle', staffBlock: 'Staff places' }[pay.kind] || pay.kind;
    const lines = q.lines.map((l) => ({ label: l.label, amount: l.amount })).concat(q.discount && q.discount.total ? [{ label: 'Discount' + (q.discount.offers.length ? ' (' + q.discount.offers.map((o) => o.name).join(', ') + ')' : q.discount.reward ? ' (referral reward)' : ''), amount: -q.discount.total }] : []);
    const bytes = buildLicencePdf({ licenceNo: 'R' + pay.id.slice(0, 8).toUpperCase(), heading: 'Payment receipt', subheading: label, holder: main.clientName || main.label || '', phone: main.phone, email: main.email, productLabel: productLabel(main.product), kindLabel: label, link: '', amount: pay.amount, paidAt: pay.paidAt, method: pay.method === 'stk' ? 'M-Pesa prompt' : 'M-Pesa, confirmed by us', reference: pay.receipt, lines,
      renewalNote: pay.kind === 'renewal' && pay.paidThrough ? `Your plan now runs to ${eatDate(pay.paidThrough)} (Nairobi).` : '' });
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="MyDukaPOS-receipt-${pay.id.slice(0, 8)}.pdf"`, 'Cache-Control': 'no-store', ...cors } });
  }
  if (action === 'poll') {
    if (pay.status === 'pending' && pay.checkoutId) {
      const gw = await ownerGateway(env), tx = await readOwnerTx(env, gw, pay.checkoutId);
      if (tx && tx.status === 'success' && Number(tx.amount) >= pay.amount) {
        try { await fulfillPay(env, pay, { receipt: tx.receiptNumber || '', method: 'stk' }); } catch (e) { return reply({ ...pubPay(pay), status: 'claimed', message: 'Your payment is received. We are finishing your renewal and will confirm shortly.' }); }
      } else if (tx && tx.status === 'failed') { pay.status = 'failed'; pay.resultDesc = String(tx.resultDesc || '').slice(0, 160); await savePay(env, pay); await releaseReward(env, pay); }
    }
    return reply(pubPay(pay));
  }
  return reply({ error: 'Unknown action.' }, 400);
}
