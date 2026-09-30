// functions/api/_crm/inbox.js — WhatsApp conversations: inbound ingest (called by whatsapp-webhook.js), inbox API, outbound via the Cloud API (NOT a route).
import { E, HttpError, json, all, first, st, many, changes, now, newId, text, phoneNorm, phoneDisplay, auditSt, activitySt, notifySt, emitSt, like, jstr } from './core.js';
import { leadScope, canWriteLead } from './scope.js';
import { notifyMany, managers } from './notify.js';
import { createLeadCore, recordTouch, findDuplicates, LEAD_SELECT, PRE_CONTACT, inList } from './leads.js';
import { attrFromInput } from './attribution.js';

export const whatsappConfigured = (env) => !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
const graph = (env) => `https://graph.facebook.com/${env.META_GRAPH_VERSION || 'v19.0'}`;

const convOut = (c) => ({ id: c.id, channel: c.channel, waId: c.wa_id, phone: '+' + c.wa_id, contactName: c.contact_name, leadId: c.lead_id, leadName: c.lead_name, leadStatus: c.lead_status, ownerId: c.lead_owner_id, ownerName: c.lead_owner_name, lastMessageAt: c.last_message_at, lastMessageText: c.last_message_text, lastDirection: c.last_direction, unread: c.unread_count, createdAt: c.created_at });
// zip 158: the typed label of an attachment ("📷 Image", "🎤 Voice note", "📄 <file name>"); the inbox shows it with the caption under it
export const MEDIA_TYPES = ['image', 'video', 'voice', 'audio', 'document', 'sticker'];
export function mediaLabel(type, name) {
  switch (type) {
    case 'image': return '📷 Image';
    case 'video': return '🎥 Video';
    case 'voice': return '🎤 Voice note';
    case 'audio': return '🎧 Audio';
    case 'document': return '📄 ' + (name || 'Document');
    case 'sticker': return '🙂 Sticker';
    default: return null;
  }
}
const msgOut = (m) => ({ id: m.id, direction: m.direction, type: m.type, text: m.text, ...(MEDIA_TYPES.includes(m.type) ? { media: { label: mediaLabel(m.type, m.media_name), mime: m.media_mime || null, name: m.media_name || null, available: !!m.media_id }, caption: m.text || '' } : {}), senderId: m.sender_user_id, senderName: m.sender_name, status: m.status, at: m.at });
const C_SELECT = `SELECT c.*, l.name AS lead_name, l.status_key AS lead_status, l.owner_id AS lead_owner_id, ou.name AS lead_owner_name FROM crm_conversations c LEFT JOIN crm_leads l ON l.id = c.lead_id AND l.deleted_at IS NULL LEFT JOIN crm_users ou ON ou.id = l.owner_id`;

// who may open a conversation: leads.all = all; others = those linked to their own / unassigned leads
function convScope(actor) {
  if (actor.has('leads.all')) return { sql: '1=1', args: [] };
  return { sql: 'c.lead_id IS NOT NULL AND l.id IS NOT NULL AND (l.owner_id = ? OR l.owner_id IS NULL)', args: [actor.id] };
}
async function convFor(ctx, id, { write = false } = {}) {
  const sc = convScope(ctx.actor);
  const c = typeof id === 'string' ? await first(ctx.db, `${C_SELECT} WHERE c.id = ? AND ${sc.sql}`, id, ...sc.args) : null;
  if (!c) throw E.notFound('Conversation not found', 'conversation_not_found');
  if (write && !ctx.actor.has('leads.all') && c.lead_owner_id !== ctx.actor.id) throw E.forbidden(c.lead_owner_id ? 'This chat belongs to someone else' : 'Claim the lead first', 'not_your_lead');
  return c;
}

// the number of chats with something unread that THIS user may open (the Inbox badge). One COUNT, served by the partial index ix_crm_conv_unread.
export function unreadConversationsSt(db, actor) {
  const sc = convScope(actor);
  return st(db, `SELECT COUNT(*) n FROM crm_conversations c LEFT JOIN crm_leads l ON l.id = c.lead_id AND l.deleted_at IS NULL WHERE c.unread_count > 0 AND ${sc.sql}`, ...sc.args);
}
export async function listConversations(ctx) {
  const { db, actor, query } = ctx; actor.require('inbox.view');
  const sc = convScope(actor), where = [sc.sql], args = [...sc.args];
  if (query.get('unread') === '1') where.push('c.unread_count > 0');
  if (query.get('mine') === '1') { where.push('l.owner_id = ?'); args.push(actor.id); }
  const q = text(query.get('q'), 80);
  if (q) {
    const digits = q.replace(/\D/g, '');
    where.push(`(c.contact_name LIKE ? ESCAPE '\\' OR c.last_message_text LIKE ? ESCAPE '\\' OR l.name LIKE ? ESCAPE '\\'${digits.length >= 3 ? ' OR c.wa_id LIKE ?' : ''})`);
    args.push(like(q), like(q), like(q), ...(digits.length >= 3 ? ['%' + digits + '%'] : []));
  }
  // zip 161: keyset paging. `limit` (default and maximum 200, as before) and `before` (the nextCursor of the previous page: "<last_message_at>:<id>"); newest chat first.
  const limit = Math.min(200, Math.max(1, parseInt(query.get('limit'), 10) || 200));
  const cur = /^(\d{1,15}):(.{1,64})$/.exec(query.get('before') || '');
  if (cur) { where.push('(c.last_message_at < ? OR (c.last_message_at = ? AND c.id > ?) OR c.last_message_at IS NULL)'); args.push(Number(cur[1]), Number(cur[1]), cur[2]); }
  const rows = await all(db, `${C_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC, c.id LIMIT ?`, ...args, limit + 1);
  const more = rows.length > limit; if (more) rows.length = limit;
  const last = rows[rows.length - 1];
  return { items: rows.map(convOut), apiConfigured: whatsappConfigured(ctx.env), nextCursor: more && last ? `${last.last_message_at ?? 0}:${last.id}` : null };
}
export async function conversationMessages(ctx) {
  const { db, actor, query } = ctx; actor.require('inbox.view');
  const id = ctx.params.id, sc = convScope(actor);
  // zip 161: the conversation (with the access check) and its messages in ONE round trip. `limit` (default 500, as before) and `before` (a message time: only older ones)
  // page through long threads; `hasMore` says whether older messages exist.
  const limit = Math.min(500, Math.max(1, parseInt(query.get('limit'), 10) || 500));
  const before = Number(query.get('before')) > 0 ? Number(query.get('before')) : null;
  const [cs, ms] = typeof id === 'string' ? await many(db, [
    st(db, `${C_SELECT} WHERE c.id = ? AND ${sc.sql}`, id, ...sc.args),
    st(db, `SELECT * FROM crm_messages WHERE conversation_id = ? ${before ? 'AND at < ?' : ''} ORDER BY at DESC, rowid DESC LIMIT ?`, id, ...(before ? [before] : []), limit + 1),
  ]) : [[], []];
  if (!cs[0]) throw E.notFound('Conversation not found', 'conversation_not_found');
  const hasMore = ms.length > limit; if (hasMore) ms.length = limit;
  return { conversation: convOut(cs[0]), items: ms.reverse().map(msgOut), hasMore };
}
export async function inboxStatus(ctx) { return { apiConfigured: whatsappConfigured(ctx.env) }; }
export async function markRead(ctx) {
  ctx.actor.require('inbox.view');
  // zip 161: the access check and the update are ONE statement (it was a lookup, then an update)
  const sc = convScope(ctx.actor);
  const r = await st(ctx.db, `UPDATE crm_conversations SET unread_count = 0 WHERE id = ? AND EXISTS (SELECT 1 FROM crm_conversations c LEFT JOIN crm_leads l ON l.id = c.lead_id AND l.deleted_at IS NULL WHERE c.id = ? AND ${sc.sql})`, ctx.params.id, ctx.params.id, ...sc.args).run();
  if (changes(r) !== 1) throw E.notFound('Conversation not found', 'conversation_not_found');
  return { ok: true };
}
export async function addNote(ctx) {
  const { db, actor } = ctx; actor.require('inbox.reply');
  const c = await convFor(ctx, ctx.params.id, { write: true });
  const b = await ctx.json(); const txt = text(b.text, 2000);
  if (!txt) throw E.bad('The note is empty', 'invalid_text');
  const t = now(), id = newId();
  const stmts = [st(db, `INSERT INTO crm_messages (id, conversation_id, direction, type, text, sender_user_id, sender_name, status, at) VALUES (?,?,'note','note',?,?,?,'internal',?)`, id, c.id, txt, actor.id, actor.name, t)];
  if (c.lead_id) stmts.push(activitySt(db, actor, c.lead_id, 'note', 'Chat note: ' + txt, { conversationId: c.id }, t));
  stmts.push(auditSt(db, actor, 'chat_note', 'conversation', c.id, null, { note: txt.slice(0, 200) }, t));
  await db.batch(stmts);
  return json({ ok: true, id }, 201);
}
export async function linkConversation(ctx) {
  const { db, actor } = ctx; actor.require('inbox.reply'); actor.require('leads.edit');
  const c = await convFor(ctx, ctx.params.id, { write: true });
  const b = await ctx.json();
  const sc = leadScope(actor);
  const lead = typeof b.leadId === 'string' ? await first(db, `${LEAD_SELECT} WHERE l.id = ? AND ${sc.sql}`, b.leadId, ...sc.args) : null;
  if (!lead) throw E.notFound('Lead not found', 'lead_not_found');
  if (!canWriteLead(actor, lead)) throw E.forbidden('This lead belongs to someone else', 'not_your_lead');
  if (c.lead_id && c.lead_id !== lead.id && !actor.has('leads.all')) throw E.forbidden('This chat is already linked to a lead', 'already_linked');
  const t = now();
  const wa = phoneNorm('+' + c.wa_id);
  await db.batch([
    st(db, `UPDATE crm_conversations SET lead_id = ? WHERE id = ?`, lead.id, c.id),
    ...(wa && !lead.whatsapp ? [st(db, `UPDATE crm_leads SET whatsapp = ?, whatsapp_norm = ? WHERE id = ?`, phoneDisplay(wa), wa, lead.id)] : []),
    activitySt(db, actor, lead.id, 'whatsapp', `WhatsApp chat linked (+${c.wa_id})`, { conversationId: c.id }, t),
    auditSt(db, actor, 'chat_link', 'conversation', c.id, { leadId: c.lead_id }, { leadId: lead.id }, t),
  ]);
  return { conversation: convOut(await first(db, `${C_SELECT} WHERE c.id = ?`, c.id)) };
}

// ---------- outbound ----------
export async function sendMessage(ctx) {
  const { db, actor, env } = ctx; actor.require('inbox.reply');
  const c = await convFor(ctx, ctx.params.id, { write: true });
  const b = await ctx.json(); const txt = text(b.text, 4000);
  if (!txt) throw E.bad('The message is empty', 'invalid_text');
  if (!whatsappConfigured(env)) throw E.conflict('WhatsApp sending is not connected: the WhatsApp Cloud API token is not set up on this server. Use the chat link to reply from your phone.', 'whatsapp_not_configured');
  let r, data = null;
  try {
    r = await fetch(`${graph(env)}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: c.wa_id, type: 'text', text: { preview_url: false, body: txt } }) });
    data = await r.json().catch(() => null);
  } catch (e) { throw new HttpError(502, 'whatsapp_send_failed', 'Could not reach WhatsApp. Try again.'); }
  if (!r.ok) throw new HttpError(502, 'whatsapp_send_failed', 'WhatsApp refused the message: ' + String(data && data.error && data.error.message || r.status).slice(0, 200), { whatsappCode: data && data.error && data.error.code });
  const extId = data && data.messages && data.messages[0] && data.messages[0].id || null;
  const t = now(), id = newId();
  const stmts = [
    st(db, `INSERT INTO crm_messages (id, conversation_id, direction, ext_id, type, text, sender_user_id, sender_name, status, at) VALUES (?,?,'out',?,'text',?,?,?,'sent',?)`, id, c.id, extId, txt, actor.id, actor.name, t),
    st(db, `UPDATE crm_conversations SET last_message_at = ?, last_message_text = ?, last_direction = 'out', unread_count = 0 WHERE id = ?`, t, txt.slice(0, 200), c.id),
  ];
  if (c.lead_id) {
    const lead = await first(db, `SELECT status_key, contact_attempts FROM crm_leads WHERE id = ? AND deleted_at IS NULL`, c.lead_id);
    if (lead) {
      stmts.push(st(db, `INSERT INTO crm_contact_attempts (id, lead_id, user_id, user_name, method, outcome, notes, at) VALUES (?,?,?,?,'whatsapp',NULL,?,?)`, newId(), c.lead_id, actor.id, actor.name, txt.slice(0, 200), t));
      stmts.push(st(db, `UPDATE crm_leads SET first_contact_at = COALESCE(first_contact_at, ?), contact_attempts = contact_attempts + 1, last_contacted_at = ?, last_contacted_by = ?, last_contacted_by_name = ?, updated_at = ?, last_activity_at = ? WHERE id = ?`, t, t, actor.id, actor.name, t, t, c.lead_id));
      if (PRE_CONTACT.includes(lead.status_key)) {
        const won = { sql: `EXISTS (SELECT 1 FROM crm_leads WHERE id = ? AND status_key = 'contacted' AND updated_at = ?)`, args: [c.lead_id, t] };
        stmts.push(st(db, `UPDATE crm_leads SET status_key = 'contacted' WHERE id = ? AND status_key IN (${inList(PRE_CONTACT)}) AND EXISTS (SELECT 1 FROM crm_statuses WHERE key = 'contacted' AND active = 1)`, c.lead_id));
        stmts.push(auditSt(db, actor, 'lead_status', 'lead', c.lead_id, { status: lead.status_key }, { status: 'contacted', auto: 'whatsapp_sent' }, t, won));
      }
      stmts.push(activitySt(db, actor, c.lead_id, 'whatsapp', 'WhatsApp sent: ' + txt.slice(0, 200), { conversationId: c.id }, t));
      stmts.push(emitSt(db, actor, 'lead.contacted', { entity: 'lead', entityId: c.lead_id, leadId: c.lead_id, data: { method: 'whatsapp' } }, t));
    }
  }
  stmts.push(emitSt(db, actor, 'message.sent', { entity: 'conversation', entityId: c.id, leadId: c.lead_id || null, data: { messageId: id } }, t));
  stmts.push(auditSt(db, actor, 'chat_send', 'conversation', c.id, null, { messageId: id, extId }, t));
  await db.batch(stmts);
  return json({ message: msgOut(await first(db, `SELECT * FROM crm_messages WHERE id = ?`, id)) }, 201);
}

// ---------- inbound (whatsapp-webhook.js) ----------
// messages: [{ id, from, name, text, type, at (ISO), fromAd, adId, adUrl, adHeadline, adBody, ctwaClid }]
// Ad-referral chats create (or attach to) a lead with attribution; other chats stay conversations, linked to a lead only when the number matches one.
export async function ingestWhatsApp(env, db, messages) {
  const res = { messages: 0, duplicates: 0, leadsCreated: 0, conversations: 0 };
  for (const m of messages) {
    const waId = String(m.from || '').replace(/\D/g, '');
    if (!waId) continue;
    if (m.id && await first(db, `SELECT 1 x FROM crm_messages WHERE ext_id = ?`, m.id)) { res.duplicates++; continue; }
    const norm = phoneNorm('+' + waId) || null;
    const at = Number.isFinite(Date.parse(m.at)) ? Date.parse(m.at) : now();
    const t = now();
    await st(db, `INSERT OR IGNORE INTO crm_conversations (id, channel, wa_id, contact_name, created_at) VALUES (?, 'whatsapp', ?, ?, ?)`, newId(), waId, text(m.name, 120), t).run();
    let conv = await first(db, `SELECT * FROM crm_conversations WHERE channel = 'whatsapp' AND wa_id = ?`, waId);
    let lead = conv.lead_id ? await first(db, `${LEAD_SELECT} WHERE l.id = ? AND l.deleted_at IS NULL`, conv.lead_id) : null;
    if (!lead && norm) { const d = await findDuplicates(db, { phone_norm: norm, whatsapp_norm: norm }); if (d.length) lead = d[0].row; }
    const attr = m.fromAd ? { ...attrFromInput({}), ext_ad_id: text(m.adId, 80), headline: text(m.adHeadline, 200), landing_url: text(m.adUrl, 300), click_id: text(m.ctwaClid, 200) } : null;
    if (m.fromAd) {
      const evExt = m.id ? 'wamid:' + m.id : null;
      if (!lead) {
        lead = await createLeadCore(db, null, { fields: { name: text(m.name, 120) || '+' + waId, phone: norm ? phoneDisplay(norm) : null, phone_norm: norm, whatsapp: norm ? phoneDisplay(norm) : null, whatsapp_norm: norm, email: null, business_name: null, location: null, notes: [m.adHeadline && `From the ad "${m.adHeadline}"`, m.text].filter(Boolean).join('\n') || null }, attr, sourceKey: 'meta_ads' },
          { createEntities: true, attrKind: 'whatsapp_ad', activityText: `Lead from a Click-to-WhatsApp ad${m.adHeadline ? `: "${m.adHeadline}"` : ''}`, auditAction: 'lead_create_whatsapp_ad', createdByName: 'WhatsApp' });
        res.leadsCreated++;
      } else {
        await recordTouch(db, lead, { attr, kind: 'whatsapp_ad', sourceKey: 'meta_ads', at, createEntities: true, summary: `Wrote again from a WhatsApp ad${m.adHeadline ? `: "${m.adHeadline}"` : ''}`, message: m.text, externalId: evExt });
      }
    }
    const isMedia = MEDIA_TYPES.includes(m.type);
    const shown = isMedia ? (mediaLabel(m.type, m.mediaName) + (m.caption ? ': ' + m.caption : '')) : String(m.text || '');      // what the list / notification / lead activity show
    const stmts = [st(db, `INSERT INTO crm_messages (id, conversation_id, direction, ext_id, type, text, media_id, media_mime, media_name, status, at) VALUES (?,?,'in',?,?,?,?,?,?,'received',?)`, newId(), conv.id, m.id || null, text(m.type, 20) || 'text', isMedia ? (text(m.caption, 4000) || '') : (text(m.text, 4000) || ''), isMedia ? text(m.mediaId, 200) : null, isMedia ? text(m.mediaMime, 100) : null, isMedia ? text(m.mediaName, 200) : null, at)];
    const linkNow = !conv.lead_id && lead;
    stmts.push(st(db, `UPDATE crm_conversations SET last_message_at = MAX(COALESCE(last_message_at, 0), ?), last_message_text = CASE WHEN ? >= COALESCE(last_message_at, 0) THEN ? ELSE last_message_text END, last_direction = CASE WHEN ? >= COALESCE(last_message_at, 0) THEN 'in' ELSE last_direction END, unread_count = unread_count + 1, contact_name = COALESCE(contact_name, ?), lead_id = COALESCE(lead_id, ?) WHERE id = ?`,
      at, at, shown.slice(0, 200), at, text(m.name, 120), lead ? lead.id : null, conv.id));
    stmts.push(emitSt(db, null, 'message.received', { entity: 'conversation', entityId: conv.id, leadId: lead ? lead.id : null, data: { fromAd: !!m.fromAd } }, at));
    if (lead) {
      stmts.push(st(db, `UPDATE crm_leads SET last_activity_at = MAX(COALESCE(last_activity_at, 0), ?), updated_at = MAX(updated_at, ?), first_response_at = CASE WHEN first_contact_at IS NOT NULL AND first_response_at IS NULL AND ? >= first_contact_at THEN ? ELSE first_response_at END WHERE id = ?`, at, at, at, at, lead.id));
      stmts.push(activitySt(db, null, lead.id, 'whatsapp', 'WhatsApp received: ' + shown.slice(0, 200), { conversationId: conv.id, messageId: m.id || null }, at));
      if (linkNow && !m.fromAd) stmts.push(activitySt(db, null, lead.id, 'whatsapp', `WhatsApp chat linked automatically (+${waId})`, { conversationId: conv.id }, at));
    }
    if (conv.unread_count === 0) {                                            // one notification per burst of unread messages
      const targets = lead && lead.owner_id ? [lead.owner_id] : (await managers(db, null)).map((u) => u.id);
      stmts.push(...notifyMany(db, targets, null, 'whatsapp_message', `WhatsApp: ${lead ? lead.name : (m.name || '+' + waId)}`, shown.slice(0, 200), { leadId: lead ? lead.id : null, entity: 'conversation', entityId: conv.id, dedupe: 'wa:' + (m.id || newId()), at: t }));
    }
    try { await db.batch(stmts); res.messages++; }
    catch (e) { if (m.id && String(e && e.message).includes('UNIQUE')) res.duplicates++; else throw e; }
  }
  return res;
}


// ---------- attachments: GET /inbox/media/:messageId ----------
// zip 158. Only when WHATSAPP_TOKEN is set: the media id is resolved through the Graph API (with the token, which never leaves the server) and the file
// is streamed back, capped at MEDIA_MAX_BYTES. Same rights as reading the chat (inbox.view + the chat's scope). The file is served with its own type only
// for kinds a browser shows safely; anything else is a download, never rendered in our origin.
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;
const SAFE_INLINE = /^(image\/(png|jpe?g|gif|webp)|audio\/[a-z0-9.+-]+|video\/(mp4|3gpp|webm)|application\/pdf)$/i;
export async function inboxMedia(ctx) {
  const { db, actor, env } = ctx; actor.require('inbox.view');
  const m = typeof ctx.params.id === 'string' ? await first(db, `SELECT * FROM crm_messages WHERE id = ?`, ctx.params.id) : null;
  if (!m || !m.media_id) throw E.notFound('That message has no attachment', 'media_not_found');
  await convFor(ctx, m.conversation_id);                                                     // 404 unless this person may open the chat
  if (!env.WHATSAPP_TOKEN) throw E.conflict('The attachment cannot be downloaded: the WhatsApp Cloud API token is not set up on this server.', 'whatsapp_not_configured');
  const auth = { Authorization: 'Bearer ' + env.WHATSAPP_TOKEN };
  let info;
  try {
    const r = await fetch(`${graph(env)}/${encodeURIComponent(m.media_id)}`, { headers: auth });
    info = await r.json().catch(() => null);
    if (!r.ok || !info || !info.url) throw new HttpError(502, 'whatsapp_media_failed', 'WhatsApp did not give the file: ' + String(info && info.error && info.error.message || r.status).slice(0, 200));
  } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(502, 'whatsapp_media_failed', 'Could not reach WhatsApp. Try again.'); }
  if (Number(info.file_size) > MEDIA_MAX_BYTES) throw new HttpError(413, 'media_too_large', 'The file is larger than the ' + Math.round(MEDIA_MAX_BYTES / 1048576) + ' MB limit.');
  let f;
  try { f = await fetch(String(info.url), { headers: auth }); } catch (e) { throw new HttpError(502, 'whatsapp_media_failed', 'Could not reach WhatsApp. Try again.'); }
  if (!f.ok || !f.body) throw new HttpError(502, 'whatsapp_media_failed', 'WhatsApp did not give the file (' + f.status + ').');
  const len = Number(f.headers.get('content-length'));
  if (Number.isFinite(len) && len > MEDIA_MAX_BYTES) throw new HttpError(413, 'media_too_large', 'The file is larger than the ' + Math.round(MEDIA_MAX_BYTES / 1048576) + ' MB limit.');
  // the size is enforced while streaming too (a missing or wrong Content-Length must not let a huge file through)
  let seen = 0;
  const cap = new TransformStream({ transform(chunk, ctl) { seen += chunk.byteLength; if (seen > MEDIA_MAX_BYTES) ctl.error(new Error('media too large')); else ctl.enqueue(chunk); } });
  const mime = String(m.media_mime || info.mime_type || f.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const safe = SAFE_INLINE.test(mime);
  const fname = String(m.media_name || (m.type === 'voice' ? 'voice-note' : m.type) || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  return new Response(f.body.pipeThrough(cap), { status: 200, headers: {
    'Content-Type': safe ? mime : 'application/octet-stream', 'Content-Disposition': `${safe ? 'inline' : 'attachment'}; filename="${fname}"`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}
