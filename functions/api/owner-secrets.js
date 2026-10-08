// functions/api/owner-secrets.js — Cloudflare Pages Function (Owner Console only). (zip 247)
//
// The platform owner's tool for the three "payment safety" clean-ups, shop by shop in small batches (a batch is ~5 shops so one call stays well
// inside Cloudflare's per-request limits; the Owner Console loops until `done`):
//   POST { action: 'status',  offset, limit }   READ ONLY. For each shop: are its payment keys and SMS account stored sealed (encrypted), plain, or
//                                                unreadable — and, for each money rail, is the payment-callback URL signed, still on its grace key
//                                                (unsigned callbacks accepted until the cutoff), or without a key.
//   POST { action: 'migrate', offset, limit }   Seals every plain record with PAYMENT_SECRETS_KEY (when that secret is set) and gives every
//                                                keyless shop its callback keys (grace, see _callback-key.js). Never overwrites a record it cannot open.
// Never returns a key or a secret — only states and counts.
import { requireOwnerAuth } from './_owner-auth.js';
import { listClientSummaries } from './_license.js';
import { openRecord, boxConfigured } from './_secret-box.js';
import { loadGatewayConfig } from './_gateway-config.js';
import { readSmsConfigFull } from './_sms-store.js';
import { getCallbackKey, ensureShopCallbackKeysGrace, MONEY_RAILS, legacyCutoffMs } from './_callback-key.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function stateOf(env, kvKey, aad) {
  let raw = null;
  try { raw = await env.mydukapos_kv.get(kvKey); } catch (e) { return 'error'; }
  if (raw === null) return 'none';
  const r = await openRecord(env, aad, raw);
  if (!r.ok) return 'unreadable';
  if (r.empty) return 'none';
  return r.encrypted ? 'sealed' : 'plain';
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  let body = {};
  try { body = await request.json(); } catch (e) { /* defaults */ }
  const action = body.action === 'migrate' ? 'migrate' : 'status';
  const limit = Math.min(10, Math.max(1, Number(body.limit) || 5));
  const offset = Math.max(0, Number(body.offset) || 0);

  const all = (await listClientSummaries(env, {})).filter((e) => !e.deleted);
  const slice = all.slice(offset, offset + limit);
  const sealing = boxConfigured(env);
  const shops = [];
  const totals = { gatewayPlain: 0, gatewaySealed: 0, gatewayUnreadable: 0, smsPlain: 0, smsSealed: 0, smsUnreadable: 0, railsGrace: 0, railsNone: 0, railsSigned: 0, keysIssued: 0, sealedNow: 0 };

  for (const e of slice) {
    const id = e.id;
    const before = { gateway: await stateOf(env, 'gateway-config:v1:' + id, 'gateway|' + id), sms: await stateOf(env, 'sms-config:' + id, 'sms|' + id) };
    let issued = [];
    if (action === 'migrate') {
      try { if (sealing && before.gateway === 'plain') await loadGatewayConfig(env, id); } catch (er) { /* reported by the state below */ }
      try { if (sealing && before.sms === 'plain') await readSmsConfigFull(env, id); } catch (er) { /* idem */ }
      issued = await ensureShopCallbackKeysGrace(env, id);
      totals.keysIssued += issued.length;
    }
    const gateway = action === 'migrate' ? await stateOf(env, 'gateway-config:v1:' + id, 'gateway|' + id) : before.gateway;
    const sms = action === 'migrate' ? await stateOf(env, 'sms-config:' + id, 'sms|' + id) : before.sms;
    if (action === 'migrate') { if (before.gateway === 'plain' && gateway === 'sealed') totals.sealedNow++; if (before.sms === 'plain' && sms === 'sealed') totals.sealedNow++; }
    const rails = {};
    for (const rail of MONEY_RAILS) {
      const rec = await getCallbackKey(env, id, rail);
      rails[rail] = !rec ? 'none' : (rec.grace ? 'grace' : 'signed');
    }
    totals['gateway' + gateway[0].toUpperCase() + gateway.slice(1)] = (totals['gateway' + gateway[0].toUpperCase() + gateway.slice(1)] || 0) + 1;
    totals['sms' + sms[0].toUpperCase() + sms.slice(1)] = (totals['sms' + sms[0].toUpperCase() + sms.slice(1)] || 0) + 1;
    Object.values(rails).forEach((v) => { if (v === 'grace') totals.railsGrace++; else if (v === 'none') totals.railsNone++; else totals.railsSigned++; });
    const needsAttention = gateway === 'plain' || sms === 'plain' || gateway === 'unreadable' || sms === 'unreadable' || Object.values(rails).some((v) => v !== 'signed');
    if (needsAttention) shops.push({ id, slug: e.slug || '', label: e.label || '', gateway, sms, rails });
  }

  const next = offset + slice.length;
  return json({
    ok: true, action, sealing, cutoff: new Date(legacyCutoffMs(env)).toISOString(),
    total: all.length, processed: slice.length, next: next < all.length ? next : null, done: next >= all.length,
    totals, shops,
    note: sealing ? undefined : 'PAYMENT_SECRETS_KEY is not set on this project, so nothing can be sealed yet (set it, deploy, then run migrate).',
  });
}
