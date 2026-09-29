// functions/api/ledger.js — Cloudflare Pages Function (zip 153). READ side of the D1 ledger: what Reports, Daily Sales checks and the
// cashier's bill search read. Everything answered here is computed by SQL from the ledger tables — there are no stored totals.
//   POST /api/ledger?c=<link>
//     { action:'daily', from:'YYYY-MM-DD', to:'YYYY-MM-DD' }  -> { sales:[{day,sales,total,cost,on_account}], payments:[{day,method,amount,n}] }
//     { action:'reconcile' }                                   -> { checks:{...}, unaccounted:[...], healthy:boolean }
//     { action:'bill', q:'B-…' }                                -> { bills:[{bill_id,location,total,paid,outstanding,status}] }
//     { action:'sales', from, to, limit? }                      -> { sales:[...] }
//     { action:'status' }                                       -> { d1:boolean, schema:number }
import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { deviceGuard } from './_device-auth.js';
import { staffGuard } from './_staff-auth.js';
import { ledgerDb, ensureLedgerSchema, dailyTotals, reconcile, unaccountedGateway, findBill } from './_ledger.js';
import { LEDGER_SCHEMA_VERSION } from './_ledger-schema.js';

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This link is not active.' }, 403);
  const clientId = license.clientId;
  const denied = await deviceGuard(request, env, clientId, cors);
  if (denied) return denied;
  let body;
  try { body = await request.json(); } catch (e) { return reply({ error: 'Invalid request.' }, 400); }
  const action = String(body && body.action || '');
  const perm = action === 'bill' ? 'payments' : 'reports';
  const sg = await staffGuard(request, env, clientId, perm, cors);
  if (sg.denied) return sg.denied;
  const db = ledgerDb(env);
  if (action === 'status') return reply({ d1: !!db, schema: db ? LEDGER_SCHEMA_VERSION : 0 });
  if (!db) return reply({ error: 'The transaction database (D1) is not connected to this deployment yet.', code: 'no_d1' }, 503);
  try {
    await ensureLedgerSchema(db);
    if (action === 'daily' || action === 'sales') {
      const from = DAY.test(String(body.from)) ? body.from : null, to = DAY.test(String(body.to)) ? body.to : from;
      if (!from) return reply({ error: 'Give from / to dates (YYYY-MM-DD).' }, 400);
      if (action === 'daily') return reply(await dailyTotals(db, clientId, from, to));
      const lim = Math.min(500, Math.max(1, Number(body.limit) || 200));
      const rows = (await db.prepare(`SELECT sale_id, ref_number, ts, business_date, location, tab_id, bill_id, total, method, cash_amount, mpesa_amount, card_amount, credit_amount, mpesa_code, staff, status
        FROM ledger_sales WHERE client_id = ? AND business_date BETWEEN ? AND ? ORDER BY ts DESC LIMIT ?`).bind(clientId, from, to, lim).all()).results || [];
      return reply({ sales: rows });
    }
    if (action === 'reconcile') {
      const checks = await reconcile(db, clientId);
      const unaccounted = await unaccountedGateway(db, clientId);
      return reply({ checks, unaccounted, healthy: Object.values(checks).every((a) => !a.length) });
    }
    if (action === 'bill') return reply({ bills: await findBill(db, clientId, body.q) });
    return reply({ error: 'Unknown action.' }, 400);
  } catch (e) {
    return reply({ error: 'The transaction database did not answer.', code: 'busy', detail: String((e && e.message) || e).slice(0, 160) }, 503);
  }
}
