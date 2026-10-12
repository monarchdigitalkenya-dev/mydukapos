// functions/api/license-status.js — Cloudflare Pages Function
//
// The shop app (index.html) calls this on load, and every ~30s after that, to
// find out whether its link is still valid — and, for a demo link, how much
// time is left. The link may be this shop's own subdomain
// (georgehardware.mydukapos.store) or a legacy ?c=<token> query param — see
// resolveClientId() in _license.js for how that's decided.
//
// This is also the one place the front-end learns its OWN client id and slug
// when it arrived via a bare subdomain (which carries no ?c= token at all) —
// the response includes both so index.html can build staff/invite links
// without needing to know its identity ahead of time.
//
// All timing here comes from Date.now() on this server, never from the
// requesting browser, which is what makes the demo countdown immune to a
// customer changing their computer's clock.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { evaluateLicense, resolveLicense, getLicense as getLicenseNoCache, wasPermanentlyDeleted, hostnameFromRequest, subdomainLabel, getRootDomain } from './_license.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  let clientId, record, result, diag = null;
  try {
    ({ clientId, record } = await resolveLicense(request, env));          // zip 159: one cached lookup, not three KV reads every 30 s per device
    result = evaluateLicense(record);
    // zip 245: "not found" is not "deleted". Say 'deleted' only with proof (a tombstone left when a link was permanently removed);
    // a request that names no shop at all is 'no_link'; anything else stays 'not_found' (the app then says it could not confirm the link,
    // never that it was removed).
    if (!record) {
      let label = '';
      try { label = subdomainLabel(hostnameFromRequest(request, env), getRootDomain(env)); } catch (e2) { /* none */ }
      // a plain-words reason for support (never says "deleted"): which part of the lookup missed
      try {
        const cq = new URL(request.url).searchParams.get('c') || '';
        const cRec = cq ? await getLicenseNoCache(env, cq) : null;
        diag = { host: hostnameFromRequest(request, env), label, hasToken: !!cq, tokenKnown: !!cRec, tokenSlug: cRec ? cRec.slug || '' : '', tokenDeleted: !!(cRec && cRec.deleted) };
      } catch (e3) { diag = { error: String(e3 && e3.message || e3).slice(0, 80) }; }
      if (await wasPermanentlyDeleted(env, new URL(request.url).searchParams.get('c') || clientId || '', label)) result = { ...result, reason: 'deleted' };
      else if (!clientId && !label) result = { ...result, reason: 'no_link' };
    }
  } catch (e) {
    // zip 143: storage briefly failing is "try again", never an answer about the licence (no `valid` field on purpose)
    return new Response(JSON.stringify({ error: 'The licence could not be checked right now — try again in a moment.', code: 'busy' }), {
      status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5', 'Cache-Control': 'no-store', ...CORS_HEADERS },
    });
  }

  return jsonResponse({
    serverNow: Date.now(),
    valid: result.valid,
    reason: result.reason,
    diag,
    clientId: record ? record.id : '',
    slug: record ? record.slug || '' : '',
    type: record ? (record.sharedDemo ? 'permanent' : record.type) : null,   // zip 262: a shared demo has no trial clock, caps or upgrade nudges - the app shows its own Demo banner from `sharedDemo`
    sharedDemo: !!(record && record.sharedDemo),
    expiresAt: record ? record.expiresAt : null,
    remainingMs: result.remainingMs !== undefined ? result.remainingMs : null,
    paymentClaimed: record ? !!record.paymentClaimed : false,
    label: record ? record.label : '',
    svcType: record ? record.svcType || '' : '',                    // Services POS: the business type chosen at sign-up / link generation ('' = none)
    product: record ? record.product || 'shop' : '',                // which app this link is for (the native apps check it — zip 148)
    branchGroupId: record ? record.branchGroupId || null : null,
    isMainBranch: record ? !!record.isMainBranch : false,
    // A payment reminder from the owner that the admin has not dismissed yet (see owner-notice.js).
    notice: record && record.notice && !record.notice.ackAt ? { id: record.notice.id, message: record.notice.message, at: record.notice.at, balance: record.notice.balance || 0 } : null,
  });
}
