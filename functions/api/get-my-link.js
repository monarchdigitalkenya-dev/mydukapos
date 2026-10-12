// functions/api/get-my-link.js — Cloudflare Pages Function (zip 263)
//
// "Get my own link": a visitor on a sample shop types name, phone and email, pays, and ONLY THEN is their own permanent link (their own subdomain)
// created. Payment is confirmed one of two ways:
//   * STK push: when the owner's own payment gateway is set up (the owner account's Settings -> Payment Gateway), the prompt goes to the buyer's phone and
//     the normal callback (pay-cb-stk) marks it paid; this endpoint reads that result and creates the link.
//   * "I've made this payment": when no gateway is set up the buyer pays the owner's M-Pesa number and taps the button; the request waits in the Owner
//     Console (Generate Link -> Permanent) until the owner presses Confirm. Nothing is created before then.
//
// A buyer whose phone or email already belongs to a permanent shop of the SAME product is never blocked and never asked to prove anything: they are asked
// whether to add the new link as a BRANCH of that shop (optional; joins its branch group) or to get a separate link. The shop is never named to the buyer
// (it would tell anyone who types a phone number who owns what). The email is optional; a phone number that already exists is allowed.
//
// When the payment is in full the buyer gets a LICENCE: a one-page PDF with the licence number, their link and the money paid (action 'licence').
//
// Buyer (public, only from a shared sample shop):  { action: 'options' | 'start' | 'status' | 'claim' | 'licence' }
// Owner (owner session):                           { action: 'list' | 'confirm' | 'reject' | 'licence' }
//
// The status check reads the callback's stored result and, for Paywave Express and Daraja, also asks the gateway itself; other gateways wait for their callback or the owner's Confirm.
// shortcut: two simultaneous confirmations of one request could create two links (KV has no compare-and-set); the second one only duplicates a free subdomain.

import { requireOwnerAuth, getOwnerAccount } from './_owner-auth.js';
import { resolveClientId, getLicense, createClient, clientLink, randomToken, listClientSummaries, saveLicense, chooseSlug, getRootDomain, PRODUCTS } from './_license.js';
import { createBranchFor } from './branches.js';
import { priceFor } from './_prices.js';
import { buildLicencePdf } from './_licence-pdf.js';
import { loadGatewayConfig, resolveProvider } from './_gateway-config.js';
import { sendStk } from './mpesa-stkpush.js';
import { refreshFromDaraja, refreshFromPaywaveExpress } from './mpesa-status.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';
import { corsHeadersFor } from './_cors.js';

const CORS_OPTS = { methods: 'POST, OPTIONS', headers: 'Content-Type' };
const INDEX_KEY = 'buy-index:v1', INDEX_MAX = 400;
const rkey = (id) => `buy:${id}`;
const json = (b, st, cors) => new Response(JSON.stringify(b), { status: st || 200, headers: { 'Content-Type': 'application/json', ...(cors || {}) } });

export async function onRequestOptions(context) { return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, CORS_OPTS) }); }

function normalizePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1); else if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return p;
}
async function load(env, id) { const r = id ? await env.mydukapos_kv.get(rkey(String(id).slice(0, 40))) : null; return r ? JSON.parse(r) : null; }
const save = (env, rec) => env.mydukapos_kv.put(rkey(rec.id), JSON.stringify(rec));
async function indexAdd(env, id) {
  let ids = []; try { ids = JSON.parse((await env.mydukapos_kv.get(INDEX_KEY)) || '[]'); } catch (e) { ids = []; }
  await env.mydukapos_kv.put(INDEX_KEY, JSON.stringify([id, ...ids.filter((x) => x !== id)].slice(0, INDEX_MAX)));
}
// the price (and branch price) come from Owner Console -> Prices (_prices.js); the owner's M-Pesa number is the one on the public site (Public Website content)
async function siteTerms(env, product) {
  let c = {}; try { c = JSON.parse((await env.mydukapos_kv.get('website-content')) || '{}'); } catch (e) { c = {}; }
  return { ...(await priceFor(env, product)), paymentPhone: String(c.paymentPhone || '0113607529') };
}
async function ownerGateway(env) {
  const acct = await getOwnerAccount(env);
  if (!acct || !acct.ownerClientId) return null;
  const cfg = await loadGatewayConfig(env, acct.ownerClientId);
  if (cfg.secretsUnreadable) return null;
  const provider = resolveProvider(cfg);
  return provider ? { clientId: acct.ownerClientId, cfg, provider } : null;
}
// Permanent shops of this product that carry the buyer's phone (last 9 digits) or email, one per branch group, oldest first.
async function findExisting(env, product, phone, email) {
  const acct = await getOwnerAccount(env);
  const last9 = (p) => String(p || '').replace(/\D/g, '').slice(-9);
  const p9 = last9(phone), em = String(email || '').trim().toLowerCase();
  const seen = new Set();
  return (await listClientSummaries(env))
    .filter((e) => !e.deleted && !e.locked && e.type === 'permanent' && e.source !== 'shared-demo' && e.product === product && (!acct || e.id !== acct.ownerClientId)
      && ((p9 && last9(e.phone) === p9) || (em && String(e.email || '').trim().toLowerCase() === em)))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .filter((e) => { const k = e.branchGroupId || e.id; if (seen.has(k)) return false; seen.add(k); return true; });
}
async function fulfill(env, rec, origin, receipt) {
  if (rec.link) return rec;
  const contact = { phone: rec.phone, email: rec.email };
  let c;
  if (rec.kind === 'branch') {
    const parent = await getLicense(env, rec.parentId);
    if (!parent || parent.type !== 'permanent') throw new Error('The shop this branch belongs to is no longer available.');
    c = (await createBranchFor(env, parent, '', contact)).branch;
  } else {
    // the address they asked for (or one made from their name); if someone took it meanwhile it becomes name-1, name-2 ... exactly as they were told
    const pick = await chooseSlug(env, rec.slugWanted || rec.name);
    c = await createClient(env, 'permanent', rec.name, rec.product, { clientName: rec.name, ...contact, slug: pick.ok ? pick.slug : undefined });
  }
  // the owner's own bookkeeping for the link: what was agreed and paid (the Permanent clients list shows it). Income is still recorded with the 💰 toggle there.
  const done = await getLicense(env, c.id);
  Object.assign(done, { source: 'self-serve', agreedAmount: rec.amount, paidAmount: rec.amount, balanceOwed: 0 });
  await saveLicense(env, done);
  Object.assign(rec, { status: 'paid', paidAt: Date.now(), clientId: c.id, link: clientLink(env, c, origin), licenceNo: 'L' + new Date().toISOString().slice(2, 7).replace('-', '') + '-' + randomToken(5).toUpperCase(), receipt: receipt || '' });
  await save(env, rec);
  return rec;
}
const pub = (rec) => ({ id: rec.id, status: rec.status, link: rec.status === 'paid' ? rec.link : undefined, kind: rec.kind });
function licenceResponse(rec, cors) {
  const bytes = buildLicencePdf({
    licenceNo: rec.licenceNo, holder: rec.name, phone: rec.phone, email: rec.email, productLabel: (PRODUCTS[rec.product] || {}).label || rec.product,
    kindLabel: rec.kind === 'branch' ? 'Permanent licence, added as a branch of your existing shop' : 'Permanent licence', link: rec.link, amount: rec.amount, paidAt: rec.paidAt,
    method: rec.method === 'stk' ? 'M-Pesa prompt' : 'M-Pesa, confirmed by us', reference: rec.receipt,
  });
  return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="MyDukaPOS-licence-${rec.licenceNo}.pdf"`, 'Cache-Control': 'no-store', ...cors } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env, CORS_OPTS);
  const reply = (b, st) => json(b, st, cors);
  let body = {}; try { body = await request.json(); } catch (e) { return reply({ error: 'Invalid request.' }, 400); }
  const origin = new URL(request.url).origin;
  const action = String(body.action || '');

  // ---- owner ----
  if (action === 'list' || action === 'confirm' || action === 'reject' || (action === 'licence' && !body.token)) {     // the licence is the owner's when no buyer secret is sent
    if (!(await requireOwnerAuth(context))) return reply({ error: 'Owner sign-in required.' }, 401);
    if (action === 'list') {
      let ids = []; try { ids = JSON.parse((await env.mydukapos_kv.get(INDEX_KEY)) || '[]'); } catch (e) { ids = []; }
      const rows = (await Promise.all(ids.slice(0, 60).map((id) => load(env, id)))).filter(Boolean)
        .map(({ token, ...r }) => r);                       // the buyer's secret never leaves the server
      return reply({ requests: rows });
    }
    const rec = await load(env, body.id);
    if (!rec) return reply({ error: 'Request not found.' }, 404);
    if (action === 'reject') { if (rec.status === 'paid') return reply({ error: 'Already paid and created.' }, 400); rec.status = 'rejected'; await save(env, rec); return reply({ ok: true }); }
    if (action === 'licence') return rec.status === 'paid' ? licenceResponse(rec, cors) : reply({ error: 'No licence yet: this request is not paid.' }, 400);
    try { await fulfill(env, rec, origin); } catch (e) { return reply({ error: (e && e.message) || 'Could not create the link.' }, 409); }
    const { token, ...out } = rec;
    return reply({ ok: true, request: out });
  }

  // ---- buyer: only from a shared sample shop (the shop is found from the address, never from the body) ----
  const cid = await resolveClientId(request, env);
  const shop = cid ? await getLicense(env, cid) : null;
  if (action === 'options' || action === 'start' || action === 'slug') {
    if (!shop || !shop.sharedDemo) return reply({ error: 'This is only available from a sample shop.' }, 403);
  }
  if (action === 'options') {
    const t = await siteTerms(env, shop.product);
    return reply({ amount: t.amount, branchAmount: t.branchAmount, stk: !!(await ownerGateway(env)), paymentPhone: t.paymentPhone, product: shop.product, root: getRootDomain(env) });
  }
  if (action === 'slug') {
    const rl = await checkRateLimit(env, 'slugCheck', request.headers.get('CF-Connecting-IP') || 'unknown');
    if (!rl.ok) return rateLimitResponse('address checks', rl, cors);
    return reply(await chooseSlug(env, body.slug));
  }
  if (action === 'start') {
    const name = String(body.name || '').trim().slice(0, 80);
    const phone = normalizePhone(body.phone);
    const email = String(body.email || '').trim().slice(0, 120);
    if (name.length < 2) return reply({ error: 'Enter your name.' }, 400);
    if (!/^254(7|1)\d{8}$/.test(phone)) return reply({ error: 'Enter a valid phone number, like 0712345678.' }, 400);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply({ error: 'That email address does not look right.' }, 400);
    const rl = await checkRateLimit(env, 'buyLink', request.headers.get('CF-Connecting-IP') || 'unknown');
    if (!rl.ok) return rateLimitResponse('link requests', rl, cors);
    // an address, if they typed one, must be usable (a taken one is fine: it becomes name-1 when the link is made)
    const wantedSlug = String(body.slug || '').trim().slice(0, 60);
    if (wantedSlug) { const ck = await chooseSlug(env, wantedSlug); if (!ck.ok) return reply({ error: ck.error }, 400); }
    const terms = await siteTerms(env, shop.product);
    // a phone or email that already has a shop of this product is not a reason to refuse: ask whether this is a branch of it
    const existing = await findExisting(env, shop.product, phone, email);
    const choice = body.choice === 'branch' || body.choice === 'separate' ? body.choice : '';
    if (existing.length && !choice) return reply({ needChoice: true, amount: terms.amount, branchAmount: terms.branchAmount, product: shop.product });
    const asBranch = existing.length > 0 && choice === 'branch';
    const amount = asBranch ? terms.branchAmount : terms.amount;
    const gw = await ownerGateway(env);
    const rec = { id: randomToken(12), token: randomToken(24), status: 'pending', kind: asBranch ? 'branch' : 'new', parentId: asBranch ? existing[0].id : undefined, slugWanted: asBranch ? undefined : (wantedSlug || undefined), product: shop.product, name, phone, email, method: gw ? 'stk' : 'claim', amount, createdAt: Date.now() };
    if (gw) {
      const rp = await checkRateLimit(env, 'stkPhone', gw.clientId + ':' + phone, 1);        // one phone cannot be pestered with prompts
      if (!rp.ok) return rateLimitResponse('payment prompts to this phone number', rp, cors);
      try {
        const r = await sendStk(env, request, gw.clientId, gw.cfg, gw.provider, { phone, amount, accountRef: 'MyDukaPOS', description: 'POS link' });
        rec.checkoutId = r.id || r.transactionRequestId; rec.provider = gw.provider; rec.paymentUrl = r.paymentUrl;
      } catch (e) { return reply({ error: (e && e.message) || 'The payment prompt could not be sent.' }, 502); }
    }
    await save(env, rec); await indexAdd(env, rec.id);
    return reply({ id: rec.id, token: rec.token, method: rec.method, amount, kind: rec.kind, paymentUrl: rec.paymentUrl });
  }

  // ---- buyer: follow-up calls, proved by the request's own secret ----
  const rec = await load(env, body.id);
  if (!rec || !rec.token || rec.token !== String(body.token || '')) return reply({ error: 'Request not found.' }, 404);
  if (action === 'claim') {
    if (rec.method !== 'claim') return reply({ error: 'This request is paid by the payment prompt.' }, 400);
    if (rec.status === 'pending') { rec.status = 'claimed'; rec.claimedAt = Date.now(); await save(env, rec); }
    return reply(pub(rec));
  }
  if (action === 'licence') return rec.status === 'paid' ? licenceResponse(rec, cors) : reply({ error: 'The licence is issued once the payment is complete.' }, 400);
  if (action === 'status') {
    if (rec.status === 'pending' && rec.checkoutId) {
      const gw = await ownerGateway(env);
      const txk = gw ? `mpesa-tx:${gw.clientId}:${rec.checkoutId}` : '';
      let tx = null; try { tx = gw ? JSON.parse((await env.mydukapos_kv.get(txk)) || 'null') : null; } catch (e) { tx = null; }
      // Paywave Express (and Daraja) can also be ASKED for the result, so a webhook that was never pasted into the Paywave dashboard, or got lost, does not leave the
      // buyer waiting: after 15 s pending, the gateway is asked at most every 10 s. Other gateways rely on their callback (or on the owner's Confirm).
      if (tx && tx.status === 'pending' && Date.now() - (tx.createdAt || 0) > 15000 && Date.now() - (tx.checkedAt || 0) > 10000 && (gw.provider === 'paywave' || gw.provider === 'daraja')) {
        try {
          const asked = gw.provider === 'paywave' ? await refreshFromPaywaveExpress(tx, rec.checkoutId, gw.cfg) : await refreshFromDaraja(tx, rec.checkoutId, gw.cfg);
          // a link is made only for MONEY RECEIVED: an answer to our own question counts as paid only when it carries the M-Pesa receipt (a gateway can say "request accepted" while the customer has not paid)
          const up = asked && asked.status === 'success' && !asked.receiptNumber ? null : asked;
          tx = up || { ...tx, checkedAt: Date.now() };
          await env.mydukapos_kv.put(txk, JSON.stringify(tx));
        } catch (e) { /* asked again on the next check */ }
      }
      if (tx && tx.status === 'success' && Number(tx.amount) >= rec.amount) { try { await fulfill(env, rec, origin, tx.receiptNumber); } catch (e) { return reply({ ...pub(rec), status: 'claimed', message: 'Your payment is received. We are finishing your link and will confirm shortly.' }); } }
      else if (tx && tx.status === 'failed') { rec.status = 'failed'; rec.resultDesc = String(tx.resultDesc || '').slice(0, 160); await save(env, rec); }
    }
    return reply({ ...pub(rec), message: rec.resultDesc || undefined });
  }
  return reply({ error: 'Unknown action.' }, 400);
}
