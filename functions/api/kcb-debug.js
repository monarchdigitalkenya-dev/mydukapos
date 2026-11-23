// functions/api/kcb-debug.js — Cloudflare Pages Function (zip 388)
//
// Reads back, for ONE shop, the last KCB Buni exchange kept by the server:
//   * stkPush: the exact STK push request sent to KCB in SANDBOX (address, headers with the login token hidden, JSON body) and KCB's answer
//     (mpesa-stkpush.js keeps it 7 days; production only when the env var KCB_DEBUG_ALL=1);
//   * ipn: the last Instant Payment Notification KCB posted to /api/kcb-ipn and the exact reply it got (kcb-ipn.js, 7 days).
// Open in a browser:  /api/kcb-debug?c=<shop id>&k=<the shop's KCB key>   - the key is the k= at the end of the IPN Callback URL shown in
// Settings -> Payment Gateway. Without the right key nothing is shown (the records hold customer phone numbers).

import { getCallbackKey } from './_callback-key.js';

function eq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const reply = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const c = (u.searchParams.get('c') || '').trim(), k = u.searchParams.get('k') || '';
  if (!c || c.length > 40) return reply({ error: 'Add ?c=<shop id>&k=<KCB key> (the IPN Callback URL in Settings shows both).' }, 400);
  if (!env.mydukapos_kv) return reply({ error: 'Storage is not available.' }, 503);
  const rec = await getCallbackKey(env, c, 'kcb');
  if (!rec || !rec.k) return reply({ error: 'This shop has no KCB key yet: save the KCB settings in Settings -> Payment Gateway once, then use the IPN Callback URL shown there.' }, 403);
  if (!eq(k, rec.k)) return reply({ error: 'Wrong or missing key: use the k= from the IPN Callback URL in Settings -> Payment Gateway.' }, 403);
  const [stk, ipn] = await Promise.all([env.mydukapos_kv.get('kcb-debug:' + c), env.mydukapos_kv.get('kcb-debug-ipn:' + c)]);
  const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } };
  return reply({
    shop: c,
    stkPush: parse(stk) || 'No sandbox STK push kept yet: send a prompt from the till with KCB set to Sandbox, then open this page again.',
    ipn: parse(ipn) || 'No IPN received yet in the last 7 days.',
  });
}

export async function onRequest() { return reply({ error: 'Use GET.' }, 405); }
