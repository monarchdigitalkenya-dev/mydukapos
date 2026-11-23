// functions/api/license-upgrade.js — Cloudflare Pages Function (zip 286)
//
// "Upgrade to permanent" by M-Pesa prompt (STK push). Used by the lock / upgrade screen of a trial or demo link when the owner's own payment gateway is set up
// (the owner account's Settings -> Payment Gateway). With no gateway the screen is unchanged: the shop pays by hand and taps "I've made this payment" (license-claim-payment.js).
//
//   { action:'status' }                      -> { stk:false }  or  { stk:true, amount }
//   { action:'start', phone }                -> sends the prompt to that phone  -> { id, token, amount }
//   { action:'poll',  id, token }            -> { status: pending | paid | failed | claimed, message? }   (paid = the shop is PERMANENT now)
//
// A payment counts only when the gateway's callback (or the gateway's own answer) says it was received AND the amount is at least the quoted price. The price is the
// ONE pricing source (_billing.js buildQuote, Owner Console -> Billing); the page never sends an amount. Like the claim route this answers an expired / locked link on
// purpose (that is when the shop upgrades), so it cannot require a valid licence; it is limited per caller and per phone instead.

import { getLicense, resolveClientId, randomToken } from './_license.js';
import { buildQuote } from './_billing.js';
import { normalizePhone, validPhone, ownerGateway, sendOwnerStk, readOwnerTx } from './_pay-owner.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';
import { corsHeadersFor } from './_cors.js';
import { applyPermanentUpgrade } from './_upgrade.js';

const CORS_OPTS = { methods: 'POST, OPTIONS', headers: 'Content-Type' };
const json = (b, st, cors) => new Response(JSON.stringify(b), { status: st || 200, headers: { 'Content-Type': 'application/json', ...(cors || {}) } });
const pkey = (id) => `upg-pay:${String(id || '').slice(0, 40)}`;
async function loadPay(env, id) { const r = id ? await env.mydukapos_kv.get(pkey(id)) : null; try { return r ? JSON.parse(r) : null; } catch (e) { return null; } }
const savePay = (env, p) => env.mydukapos_kv.put(pkey(p.id), JSON.stringify(p), { expirationTtl: 3 * 86400 });
const pub = (p) => ({ id: p.id, status: p.status, amount: p.amount, message: p.message || undefined });

export async function onRequestOptions(context) { return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, CORS_OPTS) }); }

export async function onRequestPost(context) {
  const { request, env } = context, cors = corsHeadersFor(request, env, CORS_OPTS), reply = (b, st) => json(b, st, cors);
  let body = {}; try { body = await request.json(); } catch (e) { return reply({ error: 'Invalid request.' }, 400); }
  const action = String(body.action || '');
  const clientId = await resolveClientId(request, env);
  const record = clientId ? await getLicense(env, clientId) : null;
  if (!record || record.deleted) return reply({ error: 'Invalid or expired link.' }, 404);
  if (record.sharedDemo) return reply({ error: 'This demo cannot be upgraded.' }, 400);
  const ip = (request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown').slice(0, 60);

  if (action === 'status') {
    if (record.type === 'permanent') return reply({ stk: false, permanent: true });
    const gw = await ownerGateway(env);
    if (!gw) return reply({ stk: false });
    const q = await buildQuote(env, { kind: 'link', product: record.product });
    return reply(q.total > 0 ? { stk: true, amount: q.total } : { stk: false });          // nothing to pay (a full discount) is still confirmed by the owner
  }

  if (action === 'start') {
    if (record.type === 'permanent') return reply({ error: 'This shop is already permanent.' }, 400);
    const phone = normalizePhone(body.phone);
    if (!validPhone(phone)) return reply({ error: 'Enter a valid phone number, like 0712345678.' }, 400);
    const rl = await checkRateLimit(env, 'buyLink', ip + ':up');
    if (!rl.ok) return rateLimitResponse('payment requests', rl, cors);
    const gw = await ownerGateway(env);
    if (!gw) return reply({ error: 'Pay by M-Pesa to the number shown, then tap "I\u2019ve made this payment".', code: 'no_gateway' }, 409);
    const q = await buildQuote(env, { kind: 'link', product: record.product });
    if (!(q.total > 0)) return reply({ error: 'Please use "I\u2019ve made this payment"; we will confirm it.' }, 400);
    const rp = await checkRateLimit(env, 'stkPhone', gw.clientId + ':' + phone, 1);        // one phone cannot be pestered with prompts
    if (!rp.ok) return rateLimitResponse('payment prompts to this phone number', rp, cors);
    const pay = { id: randomToken(12), token: randomToken(24), status: 'pending', clientId: record.id, amount: q.total, quote: q, phone, createdAt: Date.now() };
    try {
      const r = await sendOwnerStk(env, request, gw, { phone, amount: q.total, accountRef: 'MyDukaPOS', description: 'POS upgrade' });
      pay.checkoutId = r.checkoutId; pay.provider = r.provider;
    } catch (e) { return reply({ error: (e && e.message) || 'The payment prompt could not be sent.' }, 502); }
    await savePay(env, pay);
    return reply({ id: pay.id, token: pay.token, amount: pay.amount });
  }

  if (action === 'poll') {
    const pay = await loadPay(env, body.id);
    if (!pay || !pay.token || pay.token !== String(body.token || '') || pay.clientId !== record.id) return reply({ error: 'Payment not found.' }, 404);
    if (pay.status === 'pending' && record.type === 'permanent') { pay.status = 'paid'; await savePay(env, pay); }       // already upgraded (another tab, or the owner confirmed it)
    if (pay.status === 'pending' && pay.checkoutId) {
      const gw = await ownerGateway(env), tx = await readOwnerTx(env, gw, pay.checkoutId);
      if (tx && tx.status === 'success') {
        if (Number(tx.amount) >= pay.amount) {
          try {
            await applyPermanentUpgrade(env, record, { method: 'stk', receipt: tx.receiptNumber || '', quote: pay.quote, waitUntil: context.waitUntil ? context.waitUntil.bind(context) : null });
            Object.assign(pay, { status: 'paid', paidAt: Date.now(), receipt: tx.receiptNumber || '' }); await savePay(env, pay);
          } catch (e) { return reply({ ...pub(pay), status: 'claimed', message: 'Your payment is received. We are finishing your upgrade and will confirm shortly.' }); }   // the next poll tries again
        } else {
          Object.assign(pay, { status: 'claimed', message: 'We received a payment, but it is less than the price. Please contact support; nothing is lost.' }); await savePay(env, pay);
        }
      } else if (tx && tx.status === 'failed') {
        Object.assign(pay, { status: 'failed', message: String(tx.resultDesc || 'The payment did not go through.').slice(0, 160) }); await savePay(env, pay);
      }
    }
    return reply(pub(pay));
  }
  return reply({ error: 'Unknown action.' }, 400);
}
