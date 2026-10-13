// functions/api/billing-terms.js — Cloudflare Pages Function (zip 267). PUBLIC. What every public screen asks for its prices, so there is ONE answer.
//   GET                                        -> { terms }   the one-time link price, add-on prices and (once billing is live) the subscription
//   POST { action:'quote', product, offer, ref } -> { quote }  a new-link quote with any offer / referral applied, worked out HERE (a browser never sends an amount)
// Same numbers the checkout charges and the receipt shows: all from _billing.js (settings in Owner Console -> Billing).
import { getSettings, buildQuote, publicQuote, publicTerms, resolveReferral } from './_billing.js';
import { corsHeadersFor } from './_cors.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';

const CORS_OPTS = { methods: 'GET, POST, OPTIONS', headers: 'Content-Type' };
const json = (b, st, cors) => new Response(JSON.stringify(b), { status: st || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=15', ...(cors || {}) } });

export async function onRequestOptions(context) { return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, CORS_OPTS) }); }

export async function onRequestGet(context) {
  const cors = corsHeadersFor(context.request, context.env, CORS_OPTS);
  return json({ terms: publicTerms(await getSettings(context.env)) }, 200, cors);
}

export async function onRequestPost(context) {
  const { request, env } = context, cors = corsHeadersFor(request, env, CORS_OPTS);
  let body = {}; try { body = await request.json(); } catch (e) { return json({ error: 'Invalid request.' }, 400, cors); }
  if (body.action !== 'quote') return json({ error: 'Unknown action.' }, 400, cors);
  const rl = await checkRateLimit(env, 'slugCheck', 'quote:' + (request.headers.get('CF-Connecting-IP') || 'unknown'));
  if (!rl.ok) return rateLimitResponse('price checks', rl, cors);
  const settings = await getSettings(env);
  let referral = null;
  if (body.ref) { const r = await resolveReferral(env, body.ref, {}, settings); if (r.ok) referral = { code: r.code, referrerId: r.referrerId }; }
  const q = await buildQuote(env, { kind: 'link', product: String(body.product || 'shop'), offerCode: body.offer, referral, settings });
  return json({ quote: publicQuote(q), terms: publicTerms(settings), referralApplied: !!referral, offerApplied: q.discount.offers.length > 0 }, 200, cors);
}
