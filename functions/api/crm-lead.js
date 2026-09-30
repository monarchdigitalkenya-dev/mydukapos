// functions/api/crm-lead.js — PUBLIC website lead capture for the CRM: POST /api/crm-lead (zip 157).
// A marketing-site form posts here; nothing internal is ever returned ({ok:true}). Protections: JSON / form body ≤ 8 KB, honeypot field, per-IP and global
// hourly KV counters, an Origin allow-list (this deployment's own domains + CRM_PUBLIC_ORIGINS), field validation, phone normalisation, duplicate
// detection (a returning person adds a touch to their lead; the first attribution is kept).
// Env: CRM_PUBLIC_ORIGINS (comma list of extra allowed sites), CRM_LEAD_IP_LIMIT (default 8/hour), CRM_LEAD_GLOBAL_LIMIT (default 300/hour).
import { ledgerDb } from './_ledger.js';
import { originAllowed } from './_cors.js';
import { ensureCrmSchema } from './_crm/schema.js';
import { cleanContact, requireContactMethod, createLeadCore, recordTouch, findDuplicates } from './_crm/leads.js';
import { attrFromInput } from './_crm/attribution.js';
import { text, clientIp, sha256Hex, all } from './_crm/core.js';

const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const reply = (body, status, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...H, ...extra } });
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

function corsFor(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return { ok: true, headers: {} };
  const extra = String(env.CRM_PUBLIC_ORIGINS || '').split(',').map((s) => s.trim().toLowerCase().replace(/\/+$/, '')).filter(Boolean);
  const allowed = originAllowed(request, env) || (extra.includes(origin.toLowerCase().replace(/\/+$/, '')) ? origin : null);
  if (!allowed) return { ok: false, headers: {} };
  return { ok: true, headers: { 'Access-Control-Allow-Origin': allowed, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', 'Vary': 'Origin', 'X-CRM-Cors': 'managed' } };
}

export async function onRequestOptions({ request, env }) {
  const c = corsFor(request, env);
  return new Response(null, { status: c.ok ? 204 : 403, headers: c.headers });
}

// hourly counters in KV (a throttle, not an exact meter). -> seconds to wait, or 0
async function throttle(env, request) {
  if (!env.mydukapos_kv) return 0;
  const bucket = Math.floor(Date.now() / 3600000);
  const ip = await sha256Hex(clientIp(request));
  const keys = [[`crm-lead:ip:${ip}:${bucket}`, num(env.CRM_LEAD_IP_LIMIT, 8)], [`crm-lead:all:${bucket}`, num(env.CRM_LEAD_GLOBAL_LIMIT, 300)]];
  try {
    const used = await Promise.all(keys.map(async ([k]) => Number(await env.mydukapos_kv.get(k)) || 0));
    if (keys.some(([, lim], i) => used[i] >= lim)) return Math.max(1, Math.ceil(((bucket + 1) * 3600000 - Date.now()) / 1000));
    await Promise.all(keys.map(([k], i) => env.mydukapos_kv.put(k, String(used[i] + 1), { expirationTtl: 7200 })));
  } catch (e) { /* never lose a lead because the limiter failed */ }
  return 0;
}

export async function onRequestPost({ request, env }) {
  const cors = corsFor(request, env);
  const out = (b, s, x) => reply(b, s, { ...cors.headers, ...(x || {}) });
  if (!cors.ok) return reply({ error: 'This site may not send leads here', code: 'origin_not_allowed' }, 403);
  const db = ledgerDb(env);
  if (!db) return out({ error: 'The CRM database is not connected', code: 'crm_database_missing' }, 503);
  let raw;
  try { raw = await request.text(); } catch (e) { return out({ error: 'Bad request', code: 'bad_request' }, 400); }
  if (raw.length > 8000) return out({ error: 'Request too large', code: 'too_large' }, 413);
  let b;
  try {
    const ct = (request.headers.get('content-type') || '').toLowerCase();
    b = ct.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw || '{}');
  } catch (e) { return out({ error: 'Send JSON or a form', code: 'invalid_json' }, 400); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return out({ error: 'Send JSON or a form', code: 'invalid_json' }, 400);
  const wait = await throttle(env, request);
  if (wait) return out({ error: 'Too many requests, please try again later', code: 'rate_limited', retryAfter: wait }, 429, { 'Retry-After': String(wait) });
  // honeypot: a real visitor never sees these fields; a bot fills them. Answer like a success and store nothing.
  if (['hp', '_hp', 'website_url', 'fax', 'url'].some((k) => b[k] != null && String(b[k]).trim() !== '')) return out({ ok: true }, 200);
  const { fields, errors } = cleanContact({ name: b.name, phone: b.phone, whatsapp: b.whatsapp, email: b.email, businessName: b.businessName ?? b.business ?? b.company, location: b.location ?? b.town, notes: undefined });
  if (fields.name && fields.name.length < 2) errors.name = 'Please enter your name';
  requireContactMethod(fields, errors);
  const message = text(b.message ?? b.notes, 1000);
  if (Object.keys(errors).length) return out({ error: 'Please check the form', code: 'validation_error', fields: errors }, 400);
  try {
    await ensureCrmSchema(db);
    if (message) fields.notes = message;
    const attr = attrFromInput({ ...b, referrer: b.referrer || request.headers.get('Referer') });
    let productIds = [];
    const pk = text(b.product ?? b.productKey, 40);
    if (pk) { const p = (await all(db, `SELECT id FROM crm_products WHERE active = 1 AND (key = ? OR id = ?)`, pk, pk))[0]; if (p) productIds = [p.id]; }
    const dups = await findDuplicates(db, fields);
    if (dups.length) await recordTouch(db, dups[0].row, { attr, kind: 'form', sourceKey: 'website', message, summary: 'Filled in the website form again' + (message ? ': ' + message.slice(0, 200) : '') });
    else await createLeadCore(db, null, { fields, attr, sourceKey: 'website', productIds }, { attrKind: 'form', activityText: 'Lead from the website form' + (message ? ': ' + message.slice(0, 200) : ''), auditAction: 'lead_create_website', createdByName: 'Website form' });
  } catch (e) { console.error('crm-lead', e && e.stack || e); return out({ error: 'Could not save your details right now, please try again', code: 'server_error' }, 500); }
  return out({ ok: true }, 200);
}
