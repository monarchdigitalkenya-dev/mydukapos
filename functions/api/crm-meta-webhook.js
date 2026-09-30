// functions/api/crm-meta-webhook.js — Meta Lead Ads webhook for the CRM (zip 157).
// GET  — Meta's one-time verify handshake (hub.verify_token = META_VERIFY_TOKEN, falling back to WHATSAPP_VERIFY_TOKEN).
// POST — a `leadgen` notification, checked with X-Hub-Signature-256 (META_APP_SECRET, falling back to WHATSAPP_APP_SECRET) BEFORE anything is stored.
//        The lead's details are fetched from the Graph API only when META_PAGE_TOKEN is set; otherwise the event is stored as an UNRESOLVED attribution
//        event (visible to the owner, retryable with POST /api/crm/integrations/meta/resolve). Meta retries are harmless (deduplicated by leadgen id).
import { ledgerDb } from './_ledger.js';
import { verifySignature } from './_whatsapp.js';
import { ensureCrmSchema } from './_crm/schema.js';
import { processLeadgen } from './_crm/meta.js';

const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', 'Cache-Control': 'no-store' } });

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = env.META_VERIFY_TOKEN || env.WHATSAPP_VERIFY_TOKEN;
  if (!token) return reply('Meta is not set up on this server yet.', 503);
  const challenge = url.searchParams.get('hub.challenge');
  if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === token && challenge) return reply(challenge);
  return reply('Forbidden', 403);
}

export async function onRequestPost({ request, env }) {
  const secret = env.META_APP_SECRET || env.WHATSAPP_APP_SECRET;
  if (!secret) return reply('Meta is not set up on this server yet.', 503);
  const raw = await request.text();
  if (raw.length > 1000000) return reply('Too large', 413);
  if (!(await verifySignature(raw, request.headers.get('x-hub-signature-256'), secret))) return reply('Bad signature', 401);
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { return reply('Bad JSON', 400); }
  const db = ledgerDb(env);
  if (!db) return reply({ error: 'The CRM database is not connected', code: 'crm_database_missing' }, 503);
  const results = { created: 0, touched: 0, unresolved: 0, duplicate: 0, ignored: 0 };
  try {
    await ensureCrmSchema(db);
    for (const entry of Array.isArray(payload.entry) ? payload.entry : []) for (const ch of (entry && entry.changes) || []) {
      if (!ch || ch.field !== 'leadgen' || !ch.value) { results.ignored++; continue; }
      results[await processLeadgen(env, db, ch.value)]++;
    }
  } catch (e) { console.error('crm-meta-webhook', e && e.stack || e); return reply('Try again', 500); }      // Meta retries; everything above is idempotent
  return reply({ ok: true, results });
}
