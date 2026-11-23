// functions/api/pcb/[[path]].js — Cloudflare Pages Function (zip 358)
//
// Till / Paybill (C2B) callback addresses WITHOUT a query string:
//     /api/pcb/<shopId>/<key>/c   -> confirmation (the payment)
//     /api/pcb/<shopId>/<key>/v   -> validation  (always accepted)
//     /api/pcb/<shopId>/<key>/p   -> Pull Transactions callback (acknowledged)
// The older ?c=<shop>&k=<key> form (pay-cb-till-confirm) keeps working for shops registered with it. Safaricom documents nothing about query
// strings in Register URL addresses, and "query" is one of the words its production filter refuses, so the shop and its key now travel in the path.
// This file only rewrites the address into the old form and hands the request to the same handlers - one code path for every payment.
import * as confirm from '../mpesa-c2b-confirmation.js';
import * as validate from '../mpesa-c2b-validation.js';

function ack() {
  return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export function pcbRewrite(request, params) {
  const parts = (Array.isArray(params && params.path) ? params.path : String((params && params.path) || '').split('/')).filter(Boolean);
  if (parts.length < 3) return null;
  const [shop, key, kind] = parts;
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(shop) || !/^[A-Za-z0-9]{1,80}$/.test(key) || !/^[cvp]$/.test(kind)) return null;
  const u = new URL(request.url);
  const target = new URL(`${u.origin}/api/pay-cb-till-${kind === 'c' ? 'confirm' : 'validate'}`);
  target.searchParams.set('c', shop); target.searchParams.set('k', key); target.searchParams.set('via', 'path');
  return { kind, request: new Request(target.toString(), request) };
}

export async function onRequestPost(context) {
  const r = pcbRewrite(context.request, context.params);
  if (!r) {
    // a malformed address still gets a 200 so Safaricom does not keep retrying; it is logged for the shop's Till health screen when possible
    return ack();
  }
  if (r.kind === 'p') return ack();   // Pull Transactions registration callback: nothing to store (the query answer carries the payments)
  const ctx = { ...context, request: r.request };
  return r.kind === 'c' ? confirm.onRequestPost(ctx) : validate.onRequestPost(ctx);
}

export async function onRequest() {
  return ack();
}
