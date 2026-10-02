// functions/api/mpesa-verify.js — Cloudflare Pages Function. zip 140.
//
// A typed M-Pesa code is NOT proof of payment. Every sale recorded with a typed code is checked here against Safaricom's own
// records that reached THIS shop:
//   * STK prompts completed through the shop's own gateway (mpesa-callback.js indexes them by receipt number), and
//   * payments made straight to the shop's till / paybill (C2B confirmations: mpesa-c2b-confirmation.js, kcb-ipn.js).
// A code is claimed by the sale that verified it, so one M-Pesa payment can never pay for two sales.
//
//   POST /api/mpesa-verify?c=<link>   { code, amount, saleId }
//   -> { status: 'verified', amount, source, name? }      the payment exists, covers the amount, and now belongs to this sale
//   -> { status: 'amount_mismatch', paid }                the payment exists but is for less
//   -> { status: 'duplicate', usedBy }                    already used for another sale
//   -> { status: 'not_found' }                            no record (yet): the till may not send confirmations, or it is still coming
// Same licence and paired-device rules as every staff action.
import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { deviceGuard } from './_device-auth.js';
import { staffGuard } from './_staff-auth.js';

// zip 185: additive table (also in migrations/0006_mpesa_claims.sql); created lazily so a deploy never depends on the migration.
const MPESA_CLAIMS_DDL = `CREATE TABLE IF NOT EXISTS mpesa_code_claims (client_id TEXT NOT NULL, code TEXT NOT NULL, sale_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (client_id, code)) WITHOUT ROWID`;

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This link is not active.' }, 403);
  const denied = await deviceGuard(request, env, license.clientId, cors);
  if (denied) return denied;
  const sg = await staffGuard(request, env, license.clientId, null, cors);     // zip 141: a signed-in staff member, when required
  if (sg.denied) return sg.denied;
  let body;
  try { body = await request.json(); } catch (e) { return reply({ error: 'Invalid JSON body' }, 400); }
  const code = String((body && body.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const saleId = String((body && body.saleId) || '').slice(0, 80);
  const amount = Number(body && body.amount) || 0;
  if (!/^[A-Z0-9]{8,14}$/.test(code) || !saleId) return reply({ error: 'Give the M-Pesa code and the sale.' }, 400);
  const c = license.clientId, kv = env.mydukapos_kv;
  let rec = null, source = '';
  const stk = await kv.get(`mpesa-receipt:${c}:${code}`);
  if (stk) { rec = JSON.parse(stk); source = 'stk'; }
  else { const till = await kv.get(`till-payment:${c}:${code}`); if (till) { rec = JSON.parse(till); source = 'till'; } }
  if (!rec || rec.trusted === false) return reply({ status: 'not_found' });   // zip 143: an unsigned confirmation is never proof
  const paid = Number(rec.amount) || 0;
  if (paid + 0.5 < amount) return reply({ status: 'amount_mismatch', paid, source });
  const usedKey = `mpesa-used:${c}:${code}`;
  // zip 185: claim the code ATOMICALLY in D1 (PRIMARY KEY (client_id, code) + INSERT OR IGNORE, then read back the owner), so two tills
  // verifying the same code at the same instant cannot both win (the old KV get-then-put had no compare-and-set). Falls back to the KV
  // logic below when D1 is unavailable. The same sale re-verifying its own code still succeeds (owner === saleId).
  let owner = null;
  const db = env && (env.LEDGER_DB || env.DB);
  if (db) {
    try {
      await db.prepare(MPESA_CLAIMS_DDL).run();
      await db.prepare('INSERT OR IGNORE INTO mpesa_code_claims (client_id, code, sale_id, at) VALUES (?, ?, ?, ?)').bind(c, code, saleId, Date.now()).run();
      const row = await db.prepare('SELECT sale_id FROM mpesa_code_claims WHERE client_id = ? AND code = ?').bind(c, code).first();
      if (row && row.sale_id) owner = String(row.sale_id);
    } catch (e) { owner = null; }
  }
  const used = await kv.get(usedKey);
  if (owner) {
    // D1 is the arbiter. A code already claimed in KV by another sale before this fix (no D1 row then) must still be honoured.
    if (owner === saleId && used && used !== saleId) return reply({ status: 'duplicate', usedBy: used, paid, source });
    if (owner !== saleId) return reply({ status: 'duplicate', usedBy: owner, paid, source });
    if (!used) await kv.put(usedKey, saleId, { expirationTtl: 400 * 24 * 3600 });
  } else {
    if (used && used !== saleId) return reply({ status: 'duplicate', usedBy: used, paid, source });
    if (!used) await kv.put(usedKey, saleId, { expirationTtl: 400 * 24 * 3600 });
  }
  return reply({ status: 'verified', amount: paid, source, name: rec.customerName || '' });
}
