// functions/api/_whatsapp.js — the rules for reading WhatsApp messages (sent to the business number): signature check, message extraction, the Meta-ad-only filter and the small KV inbox.
// Kept apart from the endpoint so they can be tested without WhatsApp. See WHATSAPP_SETUP.md.
//
// Flow: Meta calls /api/whatsapp-webhook for every message sent to the number -> the message is checked (signature) -> ONLY people who started the chat
// from a Meta (Facebook / Instagram) Click-to-WhatsApp AD become leads: Meta marks such a message with a `referral` object (the ad, its headline, its id).
// Ordinary texts from anyone else are dropped and never stored. A person who came from an ad and then writes again (no `referral` on the follow-ups) stays a
// lead: their number is remembered (KV 'leads-whatsapp-ad-numbers'). Kept messages go to a small INBOX (KV 'leads-whatsapp-inbox'); the next time the Leads
// tab loaded its sheet, the old leads.js merged the inbox into it. That endpoint is gone: the CRM (functions/api/_crm/inbox.js, fed by the same webhook) is
// the lead store now, and the KV inbox is kept only so _crm/legacy.js can still migrate what was in it.

export const INBOX_KEY = 'leads-whatsapp-inbox';
export const AD_NUMBERS_KEY = 'leads-whatsapp-ad-numbers';
const MAX_INBOX = 500;

const enc = new TextEncoder();

export function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '').slice(-9);
}

// X-Hub-Signature-256: "sha256=<hex HMAC of the raw body, keyed with the app secret>"
export async function verifySignature(rawBody, header, appSecret) {
  if (!appSecret || !header || !String(header).startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  const hex = Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join('');
  const given = String(header).slice(7).toLowerCase();
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);      // constant-time compare
  return diff === 0;
}

// Pulls the customer messages out of Meta's payload: [{ id, from, name, text, type, at }]
export function extractInboundMessages(payload) {
  const out = [];
  const entries = payload && Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    for (const change of (entry && entry.changes) || []) {
      const value = change && change.value;
      if (!value || !Array.isArray(value.messages)) continue;
      const names = {};
      (value.contacts || []).forEach((c) => { if (c && c.wa_id) names[c.wa_id] = (c.profile && c.profile.name) || ''; });
      for (const m of value.messages) {
        if (!m || !m.from) continue;
        let text = '';
        if (m.type === 'text' && m.text) text = m.text.body || '';
        else if (m.type === 'button' && m.button) text = m.button.text || '';
        else if (m.type === 'interactive' && m.interactive) text = (m.interactive.button_reply && m.interactive.button_reply.title) || (m.interactive.list_reply && m.interactive.list_reply.title) || '';
        else if (m.image && m.image.caption) text = '📷 ' + m.image.caption;
        else text = `[${m.type || 'message'}]`;
        // zip 158: what the CRM inbox needs to show an attachment: the type (an audio with voice:true is a voice note), the caption, and the media id / mime
        // / file name Meta gives (the file itself is fetched later, only when WHATSAPP_TOKEN is set)
        const med = ['image', 'video', 'audio', 'document', 'sticker'].includes(m.type) && m[m.type] && typeof m[m.type] === 'object' ? m[m.type] : null;
        const media = med ? { type: m.type === 'audio' && med.voice === true ? 'voice' : m.type, mediaId: med.id ? String(med.id).slice(0, 200) : null, mediaMime: med.mime_type ? String(med.mime_type).slice(0, 100) : null, mediaName: med.filename ? String(med.filename).slice(0, 200) : null, caption: med.caption ? String(med.caption).slice(0, 1000) : '' } : null;
        out.push({
          id: m.id || '',
          from: String(m.from),
          name: names[m.from] || '',
          text: String(text).slice(0, 500),
          type: media ? media.type : (m.type || 'text'),
          ...(media ? { mediaId: media.mediaId, mediaMime: media.mediaMime, mediaName: media.mediaName, caption: media.caption } : {}),
          at: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
          ...adInfo(m.referral),
        });
      }
    }
  }
  return out;
}

// Meta's Click-to-WhatsApp marker: message.referral = { source_type: 'ad' | 'post', source_id, source_url, headline, body, ctwa_clid, ... }
function adInfo(ref) {
  if (!ref || typeof ref !== 'object') return {};
  const type = String(ref.source_type || '').toLowerCase();
  if (!(type === 'ad' || type === 'post' || ref.ctwa_clid)) return {};
  return { fromAd: true, adId: String(ref.source_id || '').slice(0, 60), adUrl: String(ref.source_url || '').slice(0, 300), adHeadline: String(ref.headline || '').slice(0, 200), adBody: String(ref.body || '').slice(0, 300), ctwaClid: String(ref.ctwa_clid || '').slice(0, 200), adSourceType: type };
}

// Keeps only what the Leads tab wants: messages that came from an ad, and follow-ups from a number that came from an ad before.
export async function keepAdMessages(env, messages) {
  const raw = await env.mydukapos_kv.get(AD_NUMBERS_KEY);
  let known;
  try { known = new Set(raw ? JSON.parse(raw) : []); } catch (e) { known = new Set(); }
  const size = known.size;
  const kept = [];
  for (const m of messages) {
    const key = normalizePhone(m.from);
    if (!key) continue;
    if (m.fromAd) { known.add(key); kept.push(m); }
    else if (known.has(key)) kept.push(m);
  }
  if (known.size !== size) await env.mydukapos_kv.put(AD_NUMBERS_KEY, JSON.stringify([...known].slice(-5000)));
  return kept;
}

export async function readInbox(env) {
  const raw = await env.mydukapos_kv.get(INBOX_KEY);
  try { const a = raw ? JSON.parse(raw) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

// Adds messages to the inbox (ignoring a message id already seen — Meta retries deliveries).
export async function addToInbox(env, messages) {
  if (!messages.length) return 0;
  const inbox = await readInbox(env);
  const seen = new Set(inbox.map((m) => m.id).filter(Boolean));
  let added = 0;
  for (const m of messages) {
    if (m.id && seen.has(m.id)) continue;
    inbox.push(m);
    if (m.id) seen.add(m.id);
    added++;
  }
  if (added) await env.mydukapos_kv.put(INBOX_KEY, JSON.stringify(inbox.slice(-MAX_INBOX)));
  return added;
}
