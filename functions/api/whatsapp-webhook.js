// functions/api/whatsapp-webhook.js — receives WhatsApp messages sent to the business number (WhatsApp Business Platform / Cloud API) and files each
// new customer as a lead on the Owner Console's Leads tab. Setup: WHATSAPP_SETUP.md.
//
// Only people who start the chat from a Meta Click-to-WhatsApp AD become leads (Meta marks those messages with a `referral`); other texts are ignored.
//
// GET  — Meta's one-time "verify this URL" handshake (hub.mode / hub.verify_token / hub.challenge).
// POST — a message notification. Checked with X-Hub-Signature-256 (HMAC of the raw body with the app secret) before anything is stored, so nobody else can
//        push fake leads. Always answers 200 quickly once the signature is good (Meta retries anything else).
//
// Secrets (Cloudflare Pages -> Settings -> Variables and secrets): WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET.
//
// CRM (zip 157): when the D1 database is bound, EVERY inbound message (ad or not) is also written to the CRM as a conversation message (deduplicated by
// the WhatsApp message id); ad-referral chats create / attach a CRM lead with attribution. The old KV inbox below keeps working during the transition.
import { verifySignature, extractInboundMessages, keepAdMessages, addToInbox } from './_whatsapp.js';
import { ledgerDb } from './_ledger.js';
import { ensureCrmSchema } from './_crm/schema.js';
import { ingestWhatsApp } from './_crm/inbox.js';
import { runAutomation } from './_crm/automation.js';

function text(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (!env.WHATSAPP_VERIFY_TOKEN) return text('WhatsApp is not set up on this server yet.', 503);
  if (mode === 'subscribe' && token && token === env.WHATSAPP_VERIFY_TOKEN && challenge) return text(challenge);
  return text('Forbidden', 403);
}

export async function onRequestPost({ request, env }) {
  if (!env.WHATSAPP_APP_SECRET) return text('WhatsApp is not set up on this server yet.', 503);
  const raw = await request.text();
  if (raw.length > 1000000) return text('Too large', 413);
  const ok = await verifySignature(raw, request.headers.get('x-hub-signature-256'), env.WHATSAPP_APP_SECRET);
  if (!ok) return text('Bad signature', 401);
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { return text('Bad JSON', 400); }
  const messages = extractInboundMessages(payload);
  const db = ledgerDb(env);
  if (db && messages.length) { try { await ensureCrmSchema(db); await ingestWhatsApp(env, db, messages); try { await runAutomation(db); } catch (e) { console.error('crm automation', e && e.message); } } catch (e) { console.error('crm whatsapp ingest', e && e.message); return text('Try again', 500); } }      // Meta retries a non-200; ingest is idempotent
  // only people who came from a Meta ad are kept; everyone else is dropped
  try { await addToInbox(env, await keepAdMessages(env, messages)); } catch (e) { return text('Try again', 500); }      // Meta retries a non-200
  return text('OK');
}
