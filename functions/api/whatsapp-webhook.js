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
import { verifySignature, extractInboundMessages, keepAdMessages, addToInbox } from './_whatsapp.js';

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
  // only people who came from a Meta ad are kept; everyone else is dropped
  try { await addToInbox(env, await keepAdMessages(env, messages)); } catch (e) { return text('Try again', 500); }      // Meta retries a non-200
  return text('OK');
}
