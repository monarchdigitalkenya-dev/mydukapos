// functions/api/till-health.js — Cloudflare Pages Function. zip 358: Settings > Payment Gateway > Till health.
//
// Answers "why is a payment to my Till not showing?" in one screen, and gives the two ways to get a missed payment in:
//   GET                                   -> { registration, events, held, legacy, cutoff, checks }
//   POST { action:'accept', code }        -> a HELD payment (arrived, but not provably for this shop) is listed in Till Payments. Owner's call, after
//                                            checking the M-PESA statement / SMS; written to the audit trail by the app.
//   POST { action:'dismiss', code }       -> removes a held payment from the list (nothing is listed)
//   POST { action:'pull', hours?, phone? } -> asks Safaricom (Pull Transactions API) for the Till's payments of the last `hours` (max 48, Safaricom's limit)
//                                            and lists every one not listed yet. Needs the "Pull Transactions" product on the live Daraja app.
// Same gate as Till Payments: valid shop link, paired-device rule, signed-in staff WITH `payments` for the POST actions.
import { requireValidLicense } from './_license.js';
import { deviceGuard } from './_device-auth.js';
import { staffGuard } from './_staff-auth.js';
import { corsHeadersFor } from './_cors.js';
import { loadGatewayConfig, hasDarajaConfig } from './_gateway-config.js';
import { getCallbackKey, legacyCutoffMs, callbackOrigin, ensureCallbackKey } from './_callback-key.js';
import { recordGatewayTxn } from './_ledger.js';
import { tillDb, ensureTillSchema, insertTill, cleanCode, parseTransTime, phoneHint, reconcileC2bWithStk, parseMoney } from './_till-store.js';
import { readRegistration, readEvents, listHeld, dropHeld, logTillEvent, OUTCOME_TEXT } from './_till-diag.js';

function json(body, status = 200, cors = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
}
export async function onRequestOptions(context) { return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) }); }

async function gate(context, perm) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const license = await requireValidLicense(request, env);
  if (!license.valid) return { res: json({ error: 'This link is not active.', reason: license.reason }, 403, cors) };
  const clientId = license.clientId;
  const deviceDenied = await deviceGuard(request, env, clientId, cors);
  if (deviceDenied) return { res: deviceDenied };
  const sg = await staffGuard(request, env, clientId, perm, cors);
  if (sg.denied) return { res: sg.denied };
  return { clientId, cors, who: (sg.claims && sg.claims.name) || '' };
}

const baseUrl = (cfg) => ((cfg.mpesaEnv || 'sandbox').toLowerCase() === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke');
async function token(cfg) {
  const res = await fetch(`${baseUrl(cfg)}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${btoa(`${cfg.mpesaConsumerKey}:${cfg.mpesaConsumerSecret}`)}` } });
  let d = {}; try { d = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || !d.access_token) throw new Error(`Could not sign in to Safaricom (HTTP ${res.status}). Check the Consumer Key / Secret and the Environment.`);
  return d.access_token;
}

// "YYYY-MM-DD HH:mm:ss" in East Africa Time (what the Pull API expects)
export function eatStamp(ms) {
  const d = new Date(ms + 3 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
// the Pull answer's time: "2026-11-07 10:12:33", "20261107101233" or an ISO string -> epoch ms (EAT unless a zone is given)
export function pullTime(v, fallback) {
  const s = String(v || '').trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2}):?(\d{2})$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 3, +m[5], +m[6]);
  const t = Date.parse(s); return Number.isFinite(t) ? t : fallback;
}
// every { transactionId, amount, ... } object anywhere in the answer (Safaricom nests it as Response: [[ ... ]])
export function pullRows(data) {
  const out = [];
  (function walk(v, depth) {
    if (depth > 6 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === 'object') {
      const id = v.transactionId || v.TransactionID || v.transactionID || v.TransID;
      if (id && (v.amount != null || v.Amount != null || v.TransAmount != null)) { out.push(v); return; }
      Object.values(v).forEach((x) => walk(x, depth + 1));
    }
  })(data, 0);
  return out;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const g = await gate(context, null);
  if (g.res) return g.res;
  const { clientId, cors } = g;
  const cfg = await loadGatewayConfig(env, clientId);
  const reg = await readRegistration(env, clientId);
  const events = (await readEvents(env, clientId)).map((e) => ({ ...e, text: OUTCOME_TEXT[e.outcome] || e.outcome }));
  const held = await listHeld(env, clientId);
  const key = await getCallbackKey(env, clientId, 'c2b');
  const cutoff = legacyCutoffMs(env);
  const host = new URL(callbackOrigin(request, env)).host;
  const lastOk = events.find((e) => e.outcome === 'accepted' || e.outcome === 'repeat');
  const checks = [];
  if (!hasDarajaConfig(cfg)) checks.push({ level: 'bad', text: 'Safaricom Daraja keys are not saved for this business.' });
  if ((cfg.mpesaEnv || 'sandbox').toLowerCase() !== 'production') checks.push({ level: 'warn', text: 'The Environment is SANDBOX: real customers paying your Till are never sent to a sandbox app.' });
  // zip 378: not an error. M-Pesa prompts (STK) work WITHOUT it; it only lists customers who pay the Till from their own M-Pesa menu.
  if (!reg) checks.push({ level: 'info', text: 'Optional: M-Pesa prompts (STK) work without this. Press "Register Till URLs with Safaricom" only if you also want payments that customers send to your Till from their own phone menu to appear here.' });
  else if (!reg.results || !reg.results.some((r) => r.ok)) checks.push({ level: 'bad', text: 'The last registration was not accepted by Safaricom: ' + ((reg.results || []).map((r) => r.shortCode + ': ' + r.message).join(' | ') || 'no answer') });
  else if (reg.form !== 'path') checks.push({ level: 'warn', text: 'Registered with the older address form. Register again after deleting the old URLs to use the newer one.' });
  if (held.length) checks.push({ level: 'warn', text: `${held.length} payment(s) arrived but are HELD - Safaricom is still using an old address for your number. Review them below, then delete the old URLs (Self Services > URL Management) and register again.` });
  if (key && key.grace && Date.now() < cutoff) checks.push({ level: 'warn', text: `Your Till may still be registered with an address that has no shop key. It is accepted until ${new Date(cutoff).toISOString().slice(0, 10)}; after that such payments are HELD. Delete the old URLs and register again before then.` });
  if (/\.pages\.dev$|\.workers\.dev$/i.test(host)) checks.push({ level: 'warn', text: `Payments are sent to ${host}. Use your own domain (set PAY_CALLBACK_ORIGIN) so Cloudflare security settings can be adjusted for it.` });
  if (reg && reg.results && reg.results.some((r) => r.ok) && !lastOk) checks.push({ level: 'warn', text: 'Registered, but no payment notice has arrived yet. Pay KES 10 to the Till from a phone. If nothing appears within a minute: in Cloudflare turn OFF Bot Fight Mode (Security > Bots) for this domain - it blocks Safaricom silently - and check Security > Events for blocked POSTs to /api/pcb/.' });
  return json({
    registration: reg, events: events.slice(0, 20), held,
    lastReceivedAt: lastOk ? lastOk.at : 0,
    environment: (cfg.mpesaEnv || 'sandbox').toLowerCase(), till: String(cfg.mpesaPartyB || ''), shortcode: String(cfg.mpesaShortcode || ''),
    host, keyState: key ? (key.grace ? 'grace' : 'keyed') : 'none', legacyCutoff: cutoff, pullPhone: await (async () => { const v = await env.mydukapos_kv.get(`till-pull-phone:${clientId}`); return v ? String(v).replace(/\d(?=\d{3})/g, '•') : ''; })(), pullReady: !!(await env.mydukapos_kv.get(`till-pull-phone:${clientId}`)),
    checks,
  }, 200, cors);
}

async function listPayment(env, clientId, p, how, by) {
  const db = tillDb(env);
  let inserted = false;
  if (db) {
    try { await ensureTillSchema(db); const r = await insertTill(db, clientId, { code: p.code, amount: p.amount, paidAt: p.paidAt, name: p.name, ref: p.ref, phoneHint: p.phoneHint, receivedAt: Date.now() }); inserted = r.inserted; }
    catch (e) { inserted = false; }
    if (inserted) await reconcileC2bWithStk(env, clientId, { code: p.code, amount: p.amount, name: p.name, msisdn: p.msisdn || '', paidAt: p.paidAt });
  }
  const kvKey = `till-payment:${clientId}:${p.code}`;
  try {
    if (!(await env.mydukapos_kv.get(kvKey))) {
      await env.mydukapos_kv.put(kvKey, JSON.stringify({ transId: p.code, transTime: '', amount: p.amount, customerName: p.name || '', accountRef: p.ref || '', receivedAt: Date.now(), trusted: true, via: how, by: by || undefined }), { expirationTtl: 45 * 24 * 3600 });
      if (!db) {
        const idxKey = `till-payment-index:${clientId}`; const idx = JSON.parse((await env.mydukapos_kv.get(idxKey)) || '[]');
        if (!idx.includes(p.code)) { idx.unshift(p.code); await env.mydukapos_kv.put(idxKey, JSON.stringify(idx.slice(0, 100))); }
        inserted = true;
      }
    }
  } catch (e) { /* the D1 row is the record */ }
  if (inserted) await recordGatewayTxn(env, clientId, { provider: 'till', txnId: p.code, code: p.code, amount: p.amount, phone: p.phoneHint || null, status: 'RECEIVED', trusted: true });
  return inserted;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body; try { body = await request.json(); } catch (e) { body = {}; }
  body = body || {};
  const g = await gate(context, 'payments');
  if (g.res) return g.res;
  const { clientId, cors, who } = g;
  const action = String(body.action || '');

  if (action === 'accept' || action === 'dismiss') {
    const code = cleanCode(body.code);
    if (!code) return json({ error: 'Missing payment code.' }, 400, cors);
    const hit = await dropHeld(env, clientId, code);
    if (!hit) return json({ error: 'That held payment is no longer in the list.' }, 404, cors);
    if (action === 'dismiss') { await logTillEvent(env, clientId, { code, amount: hit.amount, outcome: 'dismissed', by: who }); return json({ ok: true }, 200, cors); }
    const listed = await listPayment(env, clientId, hit, 'owner', who || String(body.by || '').slice(0, 60));
    await logTillEvent(env, clientId, { code, amount: hit.amount, name: hit.name, outcome: 'accepted_by_owner', by: who });
    return json({ ok: true, listed }, 200, cors);
  }

  if (action === 'pull') {
    const cfg = await loadGatewayConfig(env, clientId);
    if (!hasDarajaConfig(cfg)) return json({ error: 'Save your Safaricom Daraja keys first.' }, 400, cors);
    // one recovery every 2 minutes per shop (Safaricom rate-limits the API)
    const lockKey = `till-pull-lock:${clientId}`;
    if (await env.mydukapos_kv.get(lockKey)) return json({ error: 'A recovery ran less than 2 minutes ago - wait a moment and try again.' }, 429, cors);
    await env.mydukapos_kv.put(lockKey, '1', { expirationTtl: 120 });
    const hours = Math.min(48, Math.max(1, Number(body.hours) || 24));
    const codes = [...new Set([cfg.mpesaShortcode, cfg.mpesaPartyB].map((v) => String(v || '').trim()).filter(Boolean))];
    let tok;
    try { tok = await token(cfg); } catch (e) { return json({ error: e.message }, 502, cors); }
    const call = async (path, payload) => {
      const res = await fetch(`${baseUrl(cfg)}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      let d = {}; try { d = await res.json(); } catch (e) { /* not JSON */ }
      return { status: res.status, data: d };
    };
    const now = Date.now();
    const notes = [];
    let found = 0, added = 0, worked = '';
    for (const sc of codes) {
      // register for Pull once per number (Safaricom answers 1001 "already registered" afterwards; both are fine)
      const regFlag = `till-pull-reg:${clientId}:${sc}`;
      if (!(await env.mydukapos_kv.get(regFlag))) {
        const phone = String(body.phone || (await env.mydukapos_kv.get(`till-pull-phone:${clientId}`)) || '').replace(/\D/g, '').replace(/^0/, '254');
        if (!/^2547\d{8}$|^2541\d{8}$/.test(phone)) { notes.push(`${sc}: enter the business phone number Safaricom should link to the recovery service (2547XXXXXXXX), then try again.`); continue; }
        const cbKey = await ensureCallbackKey(env, clientId, 'c2b');
        const r = await call('/pulltransactions/v1/register', { ShortCode: sc, RequestType: 'Pull', NominatedNumber: phone, CallBackURL: `${callbackOrigin(request, env)}/api/pcb/${encodeURIComponent(clientId)}/${encodeURIComponent(cbKey.k)}/p` });
        const code = String(r.data.ResponseCode || r.data.responseCode || '');
        if (r.status < 300 && (code === '1000' || code === '1001' || code === '0' || /success|already/i.test(JSON.stringify(r.data)))) { await env.mydukapos_kv.put(regFlag, '1'); await env.mydukapos_kv.put(`till-pull-phone:${clientId}`, phone); }
        else { notes.push(`${sc}: ${r.data.errorMessage || r.data.ResponseMessage || r.data.ResponseDescription || 'HTTP ' + r.status}${r.status === 401 || r.status === 404 ? ' - the "Pull Transactions" product is not on your live Daraja app (add it at Go Live).' : ''}`); continue; }
      }
      let pages = 0, rows = [];
      for (let off = 0; off < 20; off++) {
        const r = await call('/pulltransactions/v1/query', { ShortCode: sc, StartDate: eatStamp(now - hours * 3600000), EndDate: eatStamp(now), OffSetValue: String(off) });
        if (r.status >= 300) { notes.push(`${sc}: ${r.data.errorMessage || r.data.ResponseMessage || 'HTTP ' + r.status}`); break; }
        const got = pullRows(r.data);
        if (!got.length) break;
        rows = rows.concat(got); pages++;
        if (got.length < 10) break;
      }
      if (pages) worked = worked || sc;
      for (const t of rows) {
        const amount = parseMoney(t.amount != null ? t.amount : (t.Amount != null ? t.Amount : t.TransAmount));
        const type = String(t.transactiontype || t.TransactionType || '').toLowerCase();
        if (!(amount > 0) || /reversal|withdraw|b2c|charge/.test(type)) continue;
        found++;
        const p = { code: cleanCode(t.transactionId || t.TransactionID || t.transactionID || t.TransID), amount, paidAt: pullTime(t.trxDate || t.TransTime || t.transactionDate, now), name: String(t.sender || t.SenderName || '').slice(0, 80), ref: String(t.billreference || t.BillRefNumber || '').slice(0, 40), phoneHint: phoneHint(t.msisdn || t.MSISDN), msisdn: t.msisdn || '' };
        if (!p.code) continue;
        if (await listPayment(env, clientId, p, 'pull', who)) { added++; await logTillEvent(env, clientId, { code: p.code, amount, outcome: 'pulled', sc }); }
      }
    }
    return json({ ok: !!worked || added > 0, hours, found, added, numbers: codes, notes,
      message: worked ? `Safaricom returned ${found} payment(s) for the last ${hours} h; ${added} were missing and are now in Till Payments.` : 'Safaricom did not return payments. ' + notes.join(' ') }, worked || added ? 200 : 502, cors);
  }
  return json({ error: 'Unknown action.' }, 400, cors);
}
