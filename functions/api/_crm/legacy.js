// functions/api/_crm/legacy.js — one-way, idempotent migration of the old Owner Console Leads tab (KV) into the CRM (NOT a route).
// KV is only READ: nothing in KV is ever deleted or changed. Idempotent by legacy_id (re-running skips what is already there and never overwrites CRM edits).
// The old day-sheets CARRY uncontacted leads forward under a NEW id every day, so one person appears on many sheets: they are folded into ONE CRM lead
// (identity = the last 9 digits of the phone, as the old tab compared them; no phone = its own id). See CRM_MIGRATION.md for the full mapping.
import { E, json, all, first, st, now, newId, text, phoneNorm, phoneDisplay, jstr, jparse, auditSt, nairobiDay, round2, DAY } from './core.js';
import { createLeadCore } from './leads.js';
import { ensureOwnerUser } from './auth.js';
import { attrFromInput, resolveEntities } from './attribution.js';
import { INBOX_KEY } from '../_whatsapp.js';
import { INDEX_KEY, ACCOUNT_PREFIX } from '../_account.js';
import { cleanContact } from './leads.js';
import { demoLegacyId, demoNotes } from './demo-lead.js';

const SHEET = 'leads-sheet:', MEETINGS = 'leads-meetings', STAFF = 'leads-staff-list';
const flatPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-9) : ''; };
const ts = (v, dflt) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : dflt; };
const dayNoon = (day) => Date.parse(day + 'T12:00:00+03:00');
const jsonKv = async (env, k, d) => { const raw = await env.mydukapos_kv.get(k); if (!raw) return d; try { return JSON.parse(raw); } catch (e) { return d; } };
async function listKeys(env, prefix) {
  const out = []; let cursor;
  for (let i = 0; i < 1000; i++) { const r = await env.mydukapos_kv.list({ prefix, cursor }); out.push(...r.keys.map((k) => k.name)); if (r.list_complete || !r.cursor) break; cursor = r.cursor; }
  return out;
}
const isAdmin = (n) => /^admin$/i.test(String(n || '').trim());
const nameKey = (n) => String(n || '').trim().toLowerCase();

// ---------- read KV (read-only) ----------
export async function readLegacy(env) {
  if (!env.mydukapos_kv) throw E.conflict('KV is not bound, so there is no old Leads data to read', 'kv_missing');
  const sheets = [];
  for (const k of (await listKeys(env, SHEET)).sort()) { const arr = await jsonKv(env, k, []); sheets.push({ date: k.slice(SHEET.length), leads: Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : [] }); }
  const meetings = await jsonKv(env, MEETINGS, []), staff = await jsonKv(env, STAFF, []), inbox = await jsonKv(env, INBOX_KEY, []);
  // the old "Website leads / Web signups" list: KV demo-account-index:v1 (+ each account's own record for the extras). READ ONLY.
  const idx = await jsonKv(env, INDEX_KEY, []);
  const demo = [];
  for (const e of Array.isArray(idx) ? idx : []) {
    if (!e || typeof e !== 'object') continue;
    const email = String(e.email || '').trim().toLowerCase();
    const acc = email ? await jsonKv(env, ACCOUNT_PREFIX + email, null) : null;
    demo.push({ ...e, email, _account: acc && typeof acc === 'object' ? acc : null });
  }
  return { demo, sheets, meetings: Array.isArray(meetings) ? meetings.filter((x) => x && typeof x === 'object') : [], staff: (Array.isArray(staff) ? staff : []).map((s) => String(s || '').trim()).filter(Boolean), inbox: Array.isArray(inbox) ? inbox.filter((x) => x && typeof x === 'object') : [] };
}

// ---------- plan ----------
export function planLegacy(data) {
  const groups = new Map();
  let records = 0;
  for (const sh of data.sheets) for (const l of sh.leads) {
    records++;
    const pk = flatPhone(l.phone);
    const key = pk ? 'p:' + pk : 'i:' + String(l.id || newIdFor(sh.date, records));
    let g = groups.get(key); if (!g) groups.set(key, g = { key, legacyId: 'lead:' + key, recs: [], ids: new Set() });
    g.recs.push({ ...l, _date: sh.date, _t: ts(l.updatedAt, dayNoon(sh.date)) });
    if (l.id) g.ids.add(String(l.id));
  }
  const leads = [];
  for (const g of groups.values()) {
    g.recs.sort((a, b) => (a._date < b._date ? -1 : a._date > b._date ? 1 : a._t - b._t));
    const base = g.recs[0], latest = g.recs[g.recs.length - 1];
    const closed = [...g.recs].reverse().find((r) => r.closed);
    const contacted = g.recs.find((r) => r.contacted);
    const fromInbox = g.recs.some((r) => r.source === 'Meta ad' || (r.waMessageIds && r.waMessageIds.length) || r.adId);
    const products = [...new Set(g.recs.map((r) => String(r.product || '').toLowerCase()).filter(Boolean))];
    const status = closed ? 'won' : latest.dead ? 'lost' : latest.scheduled ? 'meeting' : contacted ? 'contacted' : 'new';
    const phones = [...g.recs].reverse().map((r) => phoneNorm(r.phone)).filter(Boolean);
    leads.push({
      legacyId: g.legacyId, key: g.key, ids: [...g.ids], recordCount: g.recs.length, name: text(latest.name || base.name, 120), rawPhone: latest.phone || base.phone || null, phoneNorm: phones[0] || null,
      products, status, fromInbox, createdAt: ts(base.createdAt, dayNoon(base._date)), updatedAt: latest._t,
      contactedBy: (contacted && contacted.contactedBy) || latest.contactedBy || null, contactedAt: contacted ? ts(contacted.updatedAt, contacted._t) : null,
      assignedTo: latest.assignedTo || null, notes: text(latest.notes || base.notes, 4000), adId: text([...g.recs].reverse().map((r) => r.adId).find(Boolean), 80), adHeadline: text([...g.recs].reverse().map((r) => r.adHeadline).find(Boolean), 200),
      closed: closed ? { at: closed._t, clientId: closed.clientId || null, clientLink: closed.clientLink || null, agreed: Number(closed.agreedAmount) || 0, paid: Number(closed.paidAmount) || 0, product: String(closed.product || 'shop').toLowerCase(), by: closed.contactedBy || closed.assignedTo || null } : null,
      deadAt: latest.dead ? latest._t : null, meetingDate: latest.scheduled ? latest.meetingDate || null : null,
      lastMessage: latest.lastMessage || null, lastMessageAt: latest.lastMessageAt || null, waMessageIds: [...new Set(g.recs.flatMap((r) => r.waMessageIds || []))],
      raw: g.recs.map(({ _t, ...r }) => r),
    });
  }
  const byId = new Map(); const byPhone = new Map();
  for (const l of leads) { for (const id of l.ids) byId.set(id, l); if (l.key.startsWith('p:')) byPhone.set(l.key.slice(2), l); }
  const names = new Map();
  for (const n of [...data.staff, ...leads.flatMap((l) => [l.contactedBy, l.assignedTo, l.closed && l.closed.by]), ...data.meetings.map(() => null)]) { const s = String(n || '').trim(); if (s && !isAdmin(s) && !names.has(nameKey(s))) names.set(nameKey(s), s); }
  return { leads, demo: planDemo(data.demo || []), byId, byPhone, staffNames: [...names.values()], recordCount: records, sheetCount: data.sheets.length };
}
// Website signups: EVERY index entry becomes a lead. "Real" = demoStatus !== 'none' (the old tab's definition of a Website lead: it got a demo link);
// the rest (registered, never generated a demo) are imported as status New with a note, and counted separately.
function planDemo(list) {
  const out = [], seen = new Set();
  let skipped = 0;
  for (const e of list) {
    const legacyId = demoLegacyId(e.email, e.phone);
    if (!legacyId || seen.has(legacyId)) { skipped++; continue; }
    seen.add(legacyId);
    const real = String(e.demoStatus || 'none') !== 'none';
    const { _account, ...summary } = e;
    const { passwordHash, salt, ...acct } = _account || {};                      // never copy password material anywhere
    const createdAt = ts(e.createdAt, ts(acct.createdAt, null));
    out.push({ legacyId, email: e.email, name: text(e.fullName, 120), phone: e.phone, product: String(e.product || acct.product || '').toLowerCase(), branchName: text(e.branchName || acct.branchName, 160), demoStatus: String(e.demoStatus || 'none'), real,
      createdAt: createdAt == null ? null : createdAt, generatedAt: ts(e.generatedAt, null), expiresAt: ts(e.expiresAt, null), raw: { index: summary, account: _account ? acct : null } });
  }
  out.skippedEntries = skipped;
  return out;
}
const newIdFor = (d, i) => `${d}#${i}`;
const usersByName = async (db) => new Map((await all(db, `SELECT id, name FROM crm_users`)).map((u) => [nameKey(u.name), u]));

// ---------- migrate ----------
export async function migrateRoute(ctx) {
  const { db, env, actor } = ctx;
  const b = await ctx.json();
  const dry = b.dryRun === true;
  const data = await readLegacy(env);
  const plan = planLegacy(data);
  const counts = { sheets: plan.sheetCount, leadRecords: plan.recordCount, leads: { found: plan.leads.length, created: 0, skipped: 0, failed: 0 }, staff: { found: plan.staffNames.length, created: 0, skipped: 0 }, meetings: { found: data.meetings.length, created: 0, skipped: 0, failed: 0 }, sales: { created: 0 }, customers: { created: 0 }, conversations: { created: 0 }, messages: { created: 0, skipped: 0 }, inboxLeads: { created: 0 },
    websiteLeads: { found: plan.demo.length, real: plan.demo.filter((d) => d.real).length, registeredOnly: plan.demo.filter((d) => !d.real).length, created: 0, createdReal: 0, createdRegisteredOnly: 0, skipped: 0, failed: 0 } };
  const warnings = [], errors = [];
  const existing = new Set((await all(db, `SELECT legacy_id FROM crm_leads WHERE legacy_id IS NOT NULL`)).map((r) => r.legacy_id));
  if (dry) {
    const haveUsers = await usersByName(db);
    counts.staff.created = plan.staffNames.filter((n) => !haveUsers.has(nameKey(n))).length; counts.staff.skipped = plan.staffNames.length - counts.staff.created;
    for (const l of plan.leads) { if (existing.has(l.legacyId)) counts.leads.skipped++; else { counts.leads.created++; if (l.closed && l.closed.agreed > 0) counts.sales.created++; if (l.closed && l.closed.clientId) counts.customers.created++; } if (!l.phoneNorm) warnings.push(`lead "${l.name}" has no valid phone (${l.rawPhone || 'blank'}); it will be migrated without one`); }
    for (const d of plan.demo) { if (existing.has(d.legacyId)) counts.websiteLeads.skipped++; else { counts.websiteLeads.created++; counts.websiteLeads[d.real ? 'createdReal' : 'createdRegisteredOnly']++; } }
    if (plan.demo.skippedEntries) warnings.push(`${plan.demo.skippedEntries} website signup entr${plan.demo.skippedEntries === 1 ? 'y has' : 'ies have'} no email or phone (or is a duplicate) and will be skipped`);
    const haveM = new Set((await all(db, `SELECT legacy_id FROM crm_meetings WHERE legacy_id IS NOT NULL`)).map((r) => r.legacy_id));
    for (const m of data.meetings) (haveM.has('meeting:' + m.id) ? counts.meetings.skipped++ : counts.meetings.created++);
    counts.messages.created = data.inbox.length;
    return { dryRun: true, counts, warnings: warnings.slice(0, 100), plannedStaffNames: plan.staffNames };
  }
  const t0 = now();
  const owner = await ensureOwnerUser(env, db);
  const sys = { id: null, name: 'Legacy migration' };
  // 1. staff names -> archived, login-disabled users (so history keeps the name)
  let users = await usersByName(db);
  for (const n of plan.staffNames) {
    if (users.has(nameKey(n))) { counts.staff.skipped++; continue; }
    const id = newId();
    await st(db, `INSERT OR IGNORE INTO crm_users (id, name, role, status, archived, login_disabled, created_at, updated_at, legacy_id) VALUES (?,?,'sales','inactive',1,1,?,?,?)`, id, n.slice(0, 80), t0, t0, 'staff:' + nameKey(n)).run();
    counts.staff.created++;
  }
  users = await usersByName(db);
  const userFor = (n) => (!n ? null : isAdmin(n) ? owner : users.get(nameKey(n)) || null);
  const product = new Map((await all(db, `SELECT id, key, label FROM crm_products`)).map((p) => [p.key, p]));
  // 2. leads
  for (const l of plan.leads) {
    if (existing.has(l.legacyId)) { counts.leads.skipped++; continue; }
    try {
      const c = l.closed, contactUser = userFor(l.contactedBy), assignUser = userFor(l.assignedTo), closer = userFor(c && c.by);
      const id = newId();
      const noteBits = [l.notes, !l.phoneNorm && l.rawPhone ? `Legacy phone (not a valid number): ${l.rawPhone}` : null].filter(Boolean).join('\n');
      const attr = l.adId ? { ...attrFromInput({}), ext_ad_id: l.adId, headline: l.adHeadline } : null;
      const prodRows = l.products.map((k) => product.get(k)).filter(Boolean);
      const extra = [];
      if (l.contactedAt || (l.contactedBy && l.status !== 'new')) extra.push(st(db, `INSERT INTO crm_contact_attempts (id, lead_id, user_id, user_name, method, outcome, notes, at) VALUES (?,?,?,?,'other',NULL,?,?)`, newId(), id, contactUser ? contactUser.id : null, l.contactedBy || 'Unknown (legacy)', 'Migrated from the old Leads tab (exact time and method were not recorded)', l.contactedAt || l.updatedAt));
      let customerId = null;
      if (c && c.clientId) {
        customerId = newId();
        extra.push(st(db, `INSERT INTO crm_customers (id, lead_id, license_client_id, license_type, product_key, name, phone, link, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, customerId, id, c.clientId, null, c.product, l.name, l.rawPhone, c.clientLink, null, c.at));
        extra.push(st(db, `UPDATE crm_leads SET customer_id = ? WHERE id = ?`, customerId, id));
      }
      if (c && c.agreed > 0) {
        const pr = product.get(c.product) || product.get('shop');
        const paid = Math.min(c.paid, c.agreed);
        extra.push(st(db, `INSERT INTO crm_sales (id, lead_id, customer_id, product_id, product_label, quantity, unit_price, discount, total, payment_status, amount_paid, closed_by, closed_by_name, source_key, campaign_id, adset_id, ad_id, sold_at, notes, created_at, updated_at)
          VALUES (?,?,?,?,?,1,?,0,?,?,?,?,?,?,NULL,NULL,(SELECT first_ad_id FROM crm_leads WHERE id = ?),?,?,?,?)`, newId(), id, customerId, pr.id, pr.label, c.agreed, c.agreed, paid >= c.agreed ? 'paid' : paid > 0 ? 'partial' : 'unpaid', paid, closer ? closer.id : null, c.by || '(legacy)', l.fromInbox ? 'whatsapp' : 'legacy', id, c.at, 'Migrated from the old Leads tab (agreed / paid amounts)', c.at, c.at));
        counts.sales.created++;
      }
      if (customerId) counts.customers.created++;
      await createLeadCore(db, sys, {
        fields: { name: l.name || l.rawPhone || 'Unknown', phone: l.phoneNorm ? phoneDisplay(l.phoneNorm) : null, phone_norm: l.phoneNorm, whatsapp: l.fromInbox && l.phoneNorm ? phoneDisplay(l.phoneNorm) : null, whatsapp_norm: l.fromInbox ? l.phoneNorm : null, notes: noteBits || null },
        attr, sourceKey: l.fromInbox ? 'whatsapp' : 'legacy', statusKey: l.status, productIds: prodRows.map((p) => p.id), owner: assignUser,
      }, {
        id, at: l.createdAt, legacyId: l.legacyId, legacyJson: jstr({ records: l.raw, ids: l.ids, migratedAt: t0 }), createdByName: 'Old Leads tab', ownerKind: 'legacy', silent: true, createEntities: true, attrKind: 'legacy',
        activityText: `Migrated from the old Leads tab (${l.recordCount} daily record${l.recordCount === 1 ? '' : 's'})`, auditAction: 'lead_migrate', extraStmts: extra,
        extraCols: { updated_at: l.updatedAt, last_activity_at: l.updatedAt, first_contact_at: l.contactedAt || (l.contactedBy && l.status !== 'new' ? l.updatedAt : null), converted_at: c ? c.at : null, lost_at: l.deadAt, lost_reason_key: l.deadAt ? 'other' : null, assigned_at: assignUser ? l.updatedAt : null },
      });
      counts.leads.created++;
    } catch (e) {
      if (String(e && e.message).includes('UNIQUE') && String(e.message).includes('legacy_id')) counts.leads.skipped++;
      else { counts.leads.failed++; errors.push(`lead ${l.legacyId}: ${String(e && e.message || e).slice(0, 160)}`); }
    }
  }
  // 2b. website signups (KV demo-account-index:v1): one CRM lead per account, source 'website', original timestamps
  if (plan.demo.skippedEntries) warnings.push(`${plan.demo.skippedEntries} website signup entr${plan.demo.skippedEntries === 1 ? 'y has' : 'ies have'} no email or phone (or is a duplicate) and was skipped`);
  for (const d of plan.demo) {
    if (existing.has(d.legacyId)) { counts.websiteLeads.skipped++; continue; }
    try {
      const { fields, errors } = cleanContact({ name: d.name, phone: d.phone, email: d.email, businessName: d.branchName });
      const bad = [errors.phone && d.phone ? `Legacy phone (not a valid number): ${d.phone}` : null, errors.email && d.email ? `Legacy email (not valid): ${d.email}` : null].filter(Boolean);
      if (!fields.name) fields.name = fields.phone || fields.email || 'Website signup';
      fields.notes = [demoNotes({ product: d.product, branchName: d.branchName, demoStatus: d.demoStatus, generatedAt: d.generatedAt, expiresAt: d.expiresAt, registeredOnly: !d.real }), ...bad].join('\n');
      const pr = d.product ? product.get(d.product) : null;
      const created = d.createdAt || t0, updated = d.generatedAt || created;
      await createLeadCore(db, sys, { fields, sourceKey: 'website', statusKey: 'new', productIds: pr ? [pr.id] : [] }, {
        at: created, legacyId: d.legacyId, legacyJson: jstr({ ...d.raw, real: d.real, migratedAt: t0 }), createdByName: 'Old Web signups list', silent: true, attrKind: 'legacy',
        activityText: d.real ? 'Migrated from the old Web signups list (demo ' + d.demoStatus + ')' : 'Migrated from the old Web signups list (registered, no demo yet)', auditAction: 'lead_migrate',
        extraCols: { updated_at: updated, last_activity_at: updated },
      });
      counts.websiteLeads.created++; counts.websiteLeads[d.real ? 'createdReal' : 'createdRegisteredOnly']++;
    } catch (e) {
      if (String(e && e.message).includes('UNIQUE') && String(e.message).includes('legacy_id')) counts.websiteLeads.skipped++;
      else { counts.websiteLeads.failed++; errors.push(`website signup ${d.legacyId}: ${String(e && e.message || e).slice(0, 160)}`); }
    }
  }
  // 3. meetings
  const leadByLegacy = async (legacyId) => first(db, `SELECT id, owner_id FROM crm_leads WHERE legacy_id = ?`, legacyId);
  for (const m of data.meetings) {
    const lid = 'meeting:' + m.id;
    try {
      if (await first(db, `SELECT 1 x FROM crm_meetings WHERE legacy_id = ?`, lid)) { counts.meetings.skipped++; continue; }
      const pk = flatPhone(m.phone);
      const g = (m.leadId && plan.byId.get(String(m.leadId))) || (pk && plan.byPhone.get(pk)) || null;
      let lead = g ? await leadByLegacy(g.legacyId) : null;
      if (!lead) {                                                 // a meeting whose lead is gone: keep it on a legacy lead of its own
        const key = pk ? 'p:' + pk : 'i:m' + m.id, legacyId = 'lead:' + key;
        lead = await leadByLegacy(legacyId);
        if (!lead) {
          const pn = phoneNorm(m.phone) || null, nid = newId();
          await createLeadCore(db, sys, { fields: { name: text(m.leadName, 120) || m.phone || 'Unknown', phone: pn ? phoneDisplay(pn) : null, phone_norm: pn, whatsapp: null, whatsapp_norm: null, notes: !pn && m.phone ? `Legacy phone (not a valid number): ${m.phone}` : null }, sourceKey: 'legacy', statusKey: 'meeting', productIds: [product.get(String(m.product || '').toLowerCase())].filter(Boolean).map((p) => p.id) },
            { id: nid, at: ts(m.createdAt, now()), legacyId, legacyJson: jstr({ meeting: m }), createdByName: 'Old Leads tab', silent: true, activityText: 'Created from a meeting in the old Leads tab', auditAction: 'lead_migrate' });
          lead = { id: nid, owner_id: null };
          counts.leads.created++;
        }
      }
      let starts = Date.parse(m.meetingDate); let note = m.notes || '';
      if (!Number.isFinite(starts)) starts = null;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(String(m.meetingDate).trim())) { starts = Date.parse(m.meetingDate + 'T09:00:00+03:00'); note = (note ? note + '\n' : '') + 'Time of day was not recorded; 09:00 is a placeholder.'; }
      if (starts == null) { counts.meetings.failed++; errors.push(`meeting ${m.id}: unreadable date "${m.meetingDate}"`); continue; }
      const created = ts(m.createdAt, starts);
      await db.batch([
        st(db, `INSERT INTO crm_meetings (id, lead_id, user_id, starts_at, duration_min, type, notes, status, first_starts_at, created_at, updated_at, legacy_id) VALUES (?,?,?,?,30,'other',?,?,?,?,?,?)`, newId(), lead.id, lead.owner_id, starts, note || null, m.done ? 'completed' : 'scheduled', starts, created, ts(m.updatedAt, created), lid),
        auditSt(db, sys, 'meeting_migrate', 'meeting', lid, null, { leadId: lead.id, startsAt: starts, done: !!m.done }),
      ]);
      counts.meetings.created++;
    } catch (e) { if (String(e && e.message).includes('UNIQUE')) counts.meetings.skipped++; else { counts.meetings.failed++; errors.push(`meeting ${m.id}: ${String(e && e.message || e).slice(0, 160)}`); } }
  }
  // 4. WhatsApp: the last message of every WhatsApp lead (older bodies only survive inside the lead's notes) + the not-yet-merged inbox
  const chat = { conversations: new Map() };
  const conv = async (waId, name, leadId, legacyId) => {
    await st(db, `INSERT OR IGNORE INTO crm_conversations (id, channel, wa_id, contact_name, lead_id, created_at, legacy_id) VALUES (?, 'whatsapp', ?, ?, ?, ?, ?)`, newId(), waId, text(name, 120), leadId || null, t0, legacyId).run();
    const c = await first(db, `SELECT * FROM crm_conversations WHERE channel = 'whatsapp' AND wa_id = ?`, waId);
    if (c && !c.lead_id && leadId) await st(db, `UPDATE crm_conversations SET lead_id = ? WHERE id = ?`, leadId, c.id).run();
    if (!chat.conversations.has(waId)) { chat.conversations.set(waId, c.id); if (c.legacy_id === legacyId) counts.conversations.created++; }
    return c;
  };
  const addMsg = async (c, m) => {
    const at = ts(m.at, now());
    const dup = m.id && await first(db, `SELECT 1 x FROM crm_messages WHERE ext_id = ?`, m.id);
    if (dup) { counts.messages.skipped++; return; }
    try {
      await db.batch([
        st(db, `INSERT INTO crm_messages (id, conversation_id, direction, ext_id, type, text, status, at) VALUES (?,?,'in',?,?,?,'received',?)`, newId(), c.id, m.id || null, text(m.type, 20) || 'text', text(m.text, 4000) || '', at),
        st(db, `UPDATE crm_conversations SET last_message_at = MAX(COALESCE(last_message_at, 0), ?), last_message_text = CASE WHEN ? >= COALESCE(last_message_at, 0) THEN ? ELSE last_message_text END, last_direction = CASE WHEN ? >= COALESCE(last_message_at, 0) THEN 'in' ELSE last_direction END WHERE id = ?`, at, at, String(m.text || '').slice(0, 200), at, c.id),
      ]);
      counts.messages.created++;
    } catch (e) { if (String(e && e.message).includes('UNIQUE')) counts.messages.skipped++; else throw e; }
  };
  try {
    for (const l of plan.leads) {
      if (!l.fromInbox || !l.phoneNorm || !l.lastMessage) continue;
      const row = await leadByLegacy(l.legacyId);
      if (!row) continue;
      const c = await conv(l.phoneNorm, l.name, row.id, 'wa:' + l.phoneNorm);
      await addMsg(c, { id: l.waMessageIds[l.waMessageIds.length - 1] || null, text: l.lastMessage, at: l.lastMessageAt || l.updatedAt });
    }
    for (const m of data.inbox) {
      const wa = String(m.from || '').replace(/\D/g, ''); const pn = phoneNorm('+' + wa);
      if (!wa) continue;
      let row = pn ? await first(db, `SELECT id, owner_id FROM crm_leads WHERE deleted_at IS NULL AND (phone_norm = ? OR whatsapp_norm = ?) ORDER BY created_at LIMIT 1`, pn, pn) : null;
      if (!row && m.fromAd) {
        const nid = newId();
        await createLeadCore(db, sys, { fields: { name: text(m.name, 120) || '+' + wa, phone: pn ? phoneDisplay(pn) : null, phone_norm: pn, whatsapp: pn ? phoneDisplay(pn) : null, whatsapp_norm: pn, notes: m.adHeadline ? `From the ad "${m.adHeadline}"` : null }, attr: m.adId ? { ...attrFromInput({}), ext_ad_id: text(m.adId, 80), headline: text(m.adHeadline, 200) } : null, sourceKey: 'whatsapp' },
          { id: nid, at: ts(m.at, now()), legacyId: 'inboxlead:' + (flatPhone(wa) || wa), createdByName: 'Old Leads tab', silent: true, createEntities: true, attrKind: 'legacy', activityText: 'Created from the old WhatsApp inbox (not yet on a sheet)', auditAction: 'lead_migrate' }).catch((e) => { if (!String(e && e.message).includes('UNIQUE')) throw e; });
        row = await first(db, `SELECT id, owner_id FROM crm_leads WHERE legacy_id = ?`, 'inboxlead:' + (flatPhone(wa) || wa)); if (row) counts.inboxLeads.created++;
      }
      const c = await conv(wa, m.name, row && row.id, 'wa:' + wa);
      await addMsg(c, m);
    }
  } catch (e) { errors.push('whatsapp: ' + String(e && e.message || e).slice(0, 160)); }
  await db.batch([auditSt(db, actor, 'legacy_migrate', 'migration', 'legacy', null, { counts, errors: errors.length })]);
  return { dryRun: false, counts, warnings: warnings.slice(0, 100), errors: errors.slice(0, 100), note: 'Nothing was deleted or changed in the old Leads data (KV).' };
}

// ---------- verify ----------
export async function verifyRoute(ctx) {
  const { db, env } = ctx;
  const data = await readLegacy(env);
  const plan = planLegacy(data);
  const n = async (sql, ...a) => (await first(db, sql, ...a)).n;
  const kv = {
    sheets: plan.sheetCount, leadRecords: plan.recordCount, leads: plan.leads.length,
    won: plan.leads.filter((l) => l.status === 'won').length, lost: plan.leads.filter((l) => l.status === 'lost').length,
    contacted: plan.leads.filter((l) => l.contactedBy || l.status === 'contacted' || l.status === 'won' || l.contactedAt).length,
    meetings: data.meetings.length, staffNames: plan.staffNames.length, inboxMessages: data.inbox.length,
    websiteLeads: plan.demo.length, websiteReal: plan.demo.filter((d) => d.real).length, websiteRegisteredOnly: plan.demo.filter((d) => !d.real).length,
    agreedTotal: round2(plan.leads.reduce((a, l) => a + (l.closed ? l.closed.agreed : 0), 0)), paidTotal: round2(plan.leads.reduce((a, l) => a + (l.closed ? Math.min(l.closed.paid, l.closed.agreed) : 0), 0)),
  };
  const crm = {
    leads: await n(`SELECT COUNT(*) n FROM crm_leads WHERE legacy_id LIKE 'lead:%'`),
    won: await n(`SELECT COUNT(*) n FROM crm_leads WHERE legacy_id LIKE 'lead:%' AND converted_at IS NOT NULL`),
    lost: await n(`SELECT COUNT(*) n FROM crm_leads WHERE legacy_id LIKE 'lead:%' AND lost_at IS NOT NULL`),
    meetings: await n(`SELECT COUNT(*) n FROM crm_meetings WHERE legacy_id IS NOT NULL`),
    staffNames: await n(`SELECT COUNT(*) n FROM crm_users WHERE legacy_id LIKE 'staff:%'`),
    websiteLeads: await n(`SELECT COUNT(*) n FROM crm_leads WHERE legacy_id LIKE 'demo:%'`),
    websiteRegisteredOnly: await n(`SELECT COUNT(*) n FROM crm_leads WHERE legacy_id LIKE 'demo:%' AND notes LIKE '%registered, no demo yet%'`),
    agreedTotal: round2((await first(db, `SELECT COALESCE(SUM(s.total),0) n FROM crm_sales s JOIN crm_leads l ON l.id = s.lead_id WHERE l.legacy_id LIKE 'lead:%'`)).n),
    paidTotal: round2((await first(db, `SELECT COALESCE(SUM(s.amount_paid),0) n FROM crm_sales s JOIN crm_leads l ON l.id = s.lead_id WHERE l.legacy_id LIKE 'lead:%'`)).n),
  };
  const have = new Set((await all(db, `SELECT legacy_id FROM crm_leads WHERE legacy_id LIKE 'lead:%'`)).map((r) => r.legacy_id));
  const haveD = new Set((await all(db, `SELECT legacy_id FROM crm_leads WHERE legacy_id LIKE 'demo:%'`)).map((r) => r.legacy_id));
  const missingWebsite = plan.demo.filter((d) => !haveD.has(d.legacyId)).map((d) => ({ legacyId: d.legacyId, name: d.name }));
  const missing = plan.leads.filter((l) => !have.has(l.legacyId)).map((l) => ({ legacyId: l.legacyId, name: l.name }));
  const haveM = new Set((await all(db, `SELECT legacy_id FROM crm_meetings WHERE legacy_id IS NOT NULL`)).map((r) => r.legacy_id));
  const missingMeetings = data.meetings.filter((m) => !haveM.has('meeting:' + m.id)).map((m) => m.id);
  const match = { leads: missing.length === 0 && crm.leads >= kv.leads, won: crm.won >= kv.won, lost: crm.lost >= kv.lost, meetings: missingMeetings.length === 0, staffNames: crm.staffNames >= kv.staffNames, websiteLeads: missingWebsite.length === 0 && crm.websiteLeads >= kv.websiteLeads, agreedTotal: crm.agreedTotal === kv.agreedTotal, paidTotal: crm.paidTotal === kv.paidTotal };
  return { ok: Object.values(match).every(Boolean), match, kv, crm, missingLeads: missing.slice(0, 50), missingWebsiteLeads: missingWebsite.slice(0, 50), missingMeetings: missingMeetings.slice(0, 50), note: 'KV is only read; crm counts may be higher than kv when new leads were added to the CRM after migration.' };
}
