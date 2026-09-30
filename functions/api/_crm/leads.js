// functions/api/_crm/leads.js — leads: create / duplicate detection / list / detail / edit / claim / assign / status / classification / notes / contact /
// products / merge / bulk / export (NOT a route). Every state change is ONE db.batch (one transaction) that also writes the activity, the audit
// (previous + new value) and the notifications.
import { E, json, all, first, st, many, now, newId, text, email as normEmail, phoneNorm, phoneDisplay, auditSt, activitySt, touchLeadSt, notifySt, emitSt, idStr, moneyLoose, dayLoose, jstr, jparse, like, placeholders, arr, oneOf, optRange, dayStart, nairobiDay, DAY, toCsv, csvResponse, changes } from './core.js';
import { leadScope, canWriteLead, salesScope } from './scope.js';
import { notifyMany, managers, poolWatchers } from './notify.js';
import { attrFromInput, hasAttr, resolveEntities, eventSt, firstTouchCols } from './attribution.js';
import { usersWith } from './auth.js';
import { crmFeatures } from './schema.js';

const CONTACT_METHODS = ['call', 'whatsapp', 'sms', 'email', 'visit', 'other'];
const CONTACT_OUTCOMES = ['answered', 'no_answer', 'busy', 'voicemail', 'replied', 'reached', 'wrong_number', 'interested', 'not_interested', 'callback', 'other'];
const RESPONDED = new Set(['answered', 'replied', 'reached', 'interested', 'not_interested', 'callback']);
// lost-type statuses that carry their own lost reason when none is given
export const LOST_REASON_OF = { not_interested: 'not_interested', invalid_number: 'wrong_number' };
// statuses a first contact / a booked meeting may advance automatically (never a later stage, never won / lost)
export const PRE_CONTACT = ['new', 'unassigned', 'assigned', 'contacting'];
export const PRE_MEETING = ['new', 'unassigned', 'assigned', 'contacting', 'contacted', 'awaiting_response', 'followup_required', 'qualified', 'potential', 'interested'];
export const inList = (arr_) => arr_.map((x) => `'${x}'`).join(',');

export const leadOut = (r) => ({
  id: r.id, name: r.name, phone: r.phone, whatsapp: r.whatsapp, email: r.email, businessName: r.business_name, location: r.location, country: r.country, notes: r.notes,
  status: r.status_key, classification: r.class_key, source: r.source_key, lostReason: r.lost_reason_key,
  estimatedValue: r.estimated_value ?? null, actualValue: r.actual_value ?? null, expectedCloseDate: r.expected_close_date || null, nextAction: r.next_action || null,
  contactAttempts: r.contact_attempts || 0, lastContactedAt: r.last_contacted_at ?? null, lastContactedBy: r.last_contacted_by || null, lastContactedByName: r.last_contacted_by_name || null,
  ownerId: r.owner_id, ownerName: r.owner_name === undefined ? undefined : r.owner_name, createdBy: r.created_by, createdByName: r.created_by_name,
  createdAt: r.created_at, updatedAt: r.updated_at, assignedAt: r.assigned_at, claimedAt: r.claimed_at, firstContactAt: r.first_contact_at, firstResponseAt: r.first_response_at,
  convertedAt: r.converted_at, lostAt: r.lost_at, lastActivityAt: r.last_activity_at,
  firstTouch: { source: r.first_source_key, campaignId: r.first_campaign_id, adsetId: r.first_adset_id, adId: r.first_ad_id, campaignName: r.campaign_name || null, adsetName: r.adset_name || null, adName: r.ad_name || null, utmSource: r.first_utm_source, utmMedium: r.first_utm_medium, utmCampaign: r.first_utm_campaign, utmContent: r.first_utm_content, utmTerm: r.first_utm_term, referrer: r.first_referrer, landingUrl: r.first_landing_url, at: r.first_touch_at },
  customerId: r.customer_id, importId: r.import_id, mergedIntoId: r.merged_into_id,
  ...(r.product_ids !== undefined ? { productIds: r.product_ids ? String(r.product_ids).split(',') : [] } : {}),
  ...(r.next_followup_at !== undefined ? { nextFollowupAt: r.next_followup_at, nextFollowupType: r.next_followup_type || null, nextFollowupNotes: r.next_followup_notes || null } : {}),
  ...(r.product_names !== undefined ? { productNames: r.product_names ? String(r.product_names).split('\u001f') : [] } : {}),
  ...(r.revenue !== undefined ? { revenue: r.revenue == null ? 0 : Math.round(r.revenue * 100) / 100 } : {}),
});
// Everything a lead row needs beyond its own columns: owner, product ids, the NEXT open follow-up (time, method, notes) and the names of the first campaign / ad set / ad.
const NEXT_FU = (col) => `(SELECT f.${col} FROM crm_followups f WHERE f.lead_id = l.id AND f.status = 'open' ORDER BY f.due_at, f.id LIMIT 1)`;
const LEAD_SELECT = `SELECT l.*, u.name AS owner_name,
  (SELECT group_concat(product_id) FROM crm_lead_products lp WHERE lp.lead_id = l.id) AS product_ids,
  (SELECT MIN(f.due_at) FROM crm_followups f WHERE f.lead_id = l.id AND f.status = 'open') AS next_followup_at,
  ${NEXT_FU('type')} AS next_followup_type, ${NEXT_FU('notes')} AS next_followup_notes,
  (SELECT name FROM crm_campaigns WHERE id = l.first_campaign_id) AS campaign_name, (SELECT name FROM crm_adsets WHERE id = l.first_adset_id) AS adset_name, (SELECT name FROM crm_ads WHERE id = l.first_ad_id) AS ad_name
  FROM crm_leads l LEFT JOIN crm_users u ON u.id = l.owner_id`;
// the list adds the product NAMES and, when the viewer may see revenue, the sum of the lead's sales inside THEIR revenue scope (never a figure they could not open)
function listSelect(actor) {
  const sc = salesScope(actor, 's');
  const rev = sc ? `(SELECT SUM(s.total) FROM crm_sales s WHERE s.lead_id = l.id AND ${sc.sql}) AS revenue,` : '';
  return { sql: LEAD_SELECT.replace('SELECT l.*, u.name AS owner_name,', `SELECT l.*, u.name AS owner_name, ${rev}
  (SELECT group_concat(p.label, char(31)) FROM (SELECT p2.label FROM crm_lead_products lp2 JOIN crm_products p2 ON p2.id = lp2.product_id WHERE lp2.lead_id = l.id ORDER BY p2.position) p) AS product_names,`), args: sc ? sc.args : [], hasRevenue: !!sc };
}

// ---------- config keys ----------
async function activeKeys(db) {                       // zip 161: the four lookups in one round trip (fresh, never from the memory: this validates a write)
  const [a, b, c, d] = await many(db, ['crm_statuses', 'crm_classifications', 'crm_sources', 'crm_lost_reasons'].map((t) => st(db, `SELECT key FROM ${t} WHERE active = 1`)));
  const k = (rows) => new Set(rows.map((r) => r.key));
  return { statuses: k(a), classes: k(b), sources: k(c), lost: k(d) };
}
export const statusRow = (db, key) => first(db, `SELECT * FROM crm_statuses WHERE key = ?`, key);

// ---------- input validation ----------
// -> { fields, errors }
export function cleanContact(raw, { partial = false, requireName = true } = {}) {
  const fields = {}, errors = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(raw, k);
  if (!partial || has('name')) { const n = text(raw.name, 120); if (!n && requireName) errors.name = 'Name is required'; fields.name = n; }
  for (const [k, col] of [['phone', 'phone'], ['whatsapp', 'whatsapp']]) {
    if (partial && !has(k)) continue;
    const v = phoneNorm(raw[k]);
    if (v === false) errors[k] = 'This does not look like a valid phone number';
    fields[col] = v ? phoneDisplay(v) : null; fields[col + '_norm'] = v || null;
  }
  if (!partial || has('email')) { const v = normEmail(raw.email); if (v === false) errors.email = 'This does not look like a valid email address'; fields.email = v || null; }
  if (!partial || has('businessName') || has('business_name')) fields.business_name = text(raw.businessName ?? raw.business_name, 160);
  if (!partial || has('location')) fields.location = text(raw.location, 160);
  if (!partial || has('notes')) fields.notes = text(raw.notes, 4000);
  if (!partial || has('country')) fields.country = text(raw.country, 80);
  if (!partial || has('estimatedValue') || has('estimated_value')) {
    const v = moneyLoose(raw.estimatedValue ?? raw.estimated_value);
    if (v === false) errors.estimatedValue = 'Estimated value must be an amount of 0 or more';
    fields.estimated_value = v === false ? null : v;
  }
  if (!partial || has('expectedCloseDate') || has('expected_close_date')) {
    const v = dayLoose(raw.expectedCloseDate ?? raw.expected_close_date);
    if (v === false) errors.expectedCloseDate = 'Expected closing date must be a real date (YYYY-MM-DD)';
    fields.expected_close_date = v === false ? null : v;
  }
  if (!partial || has('nextAction') || has('next_action')) fields.next_action = text(raw.nextAction ?? raw.next_action, 200);
  return { fields, errors };
}
export function requireContactMethod(fields, errors) {
  if (!fields.phone && !fields.whatsapp && !fields.email && !errors.phone && !errors.whatsapp && !errors.email) errors.phone = 'A phone number, WhatsApp number or email is required';
}
export const throwIfErrors = (errors) => { if (Object.keys(errors).length) throw E.bad('Please fix the highlighted fields', 'validation_error', { fields: errors }); };

// ---------- duplicates ----------
export async function findDuplicates(db, f, excludeId) {
  const nums = [...new Set([f.phone_norm, f.whatsapp_norm].filter(Boolean))];
  const conds = [], args = [];
  if (nums.length) { conds.push(`l.phone_norm IN (${placeholders(nums.length)})`, `l.whatsapp_norm IN (${placeholders(nums.length)})`); args.push(...nums, ...nums); }
  if (f.email) { conds.push('l.email = ?'); args.push(f.email); }
  if (!conds.length) return [];
  const rows = await all(db, `${LEAD_SELECT} WHERE l.deleted_at IS NULL AND (${conds.join(' OR ')})${excludeId ? ' AND l.id != ?' : ''} ORDER BY l.created_at LIMIT 10`, ...args, ...(excludeId ? [excludeId] : []));
  return rows.map((r) => ({ row: r, matchedOn: [nums.includes(r.phone_norm) && 'phone', nums.includes(r.whatsapp_norm) && 'whatsapp', f.email && r.email === f.email && 'email'].filter(Boolean) }));
}
const dupOut = (actor, d) => (actor.has('leads.all') || !d.row.owner_id || d.row.owner_id === actor.id
  ? { ...leadOut(d.row), matchedOn: d.matchedOn }
  : { restricted: true, name: d.row.name, ownerName: d.row.owner_name, createdAt: d.row.created_at, matchedOn: d.matchedOn });

// ---------- ownership change (claim / assign / unassign): guarded so a lost race writes NOTHING ----------
// prev = the owner the caller SAW (null = pool). Every statement is conditional on the lead still having that owner, and the later ones on the
// ownership row of THIS change having been written — two claims at once: exactly one wins.
export function ownershipChange(db, { lead, newOwner, kind, actor, reason, t = now(), extra = [] }) {
  const markerId = newId();
  const prevId = lead.owner_id || null;
  const stillPrev = { sql: `EXISTS (SELECT 1 FROM crm_leads WHERE id = ? AND owner_id IS ? AND deleted_at IS NULL)`, args: [lead.id, prevId] };
  const won = { sql: `EXISTS (SELECT 1 FROM crm_lead_owners WHERE id = ?)`, args: [markerId] };
  const stmts = [
    st(db, `UPDATE crm_lead_owners SET ended_at = ? WHERE lead_id = ? AND ended_at IS NULL AND ${stillPrev.sql}`, t, lead.id, ...stillPrev.args),
    st(db, `INSERT INTO crm_lead_owners (id, lead_id, user_id, user_name, kind, from_user_id, by_user_id, by_name, reason, started_at, ended_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${stillPrev.sql}`,
      markerId, lead.id, newOwner ? newOwner.id : null, newOwner ? newOwner.name : null, kind, prevId, actor && actor.id || null, actor && actor.name || 'system', reason || null, t, newOwner ? null : t, ...stillPrev.args),
    st(db, `UPDATE crm_leads SET owner_id = ?, assigned_at = ?, claimed_at = ${kind === 'claim' ? '?' : 'claimed_at'}, updated_at = ?, last_activity_at = ? WHERE id = ? AND owner_id IS ? AND ${won.sql}`,
      newOwner ? newOwner.id : null, newOwner ? t : null, ...(kind === 'claim' ? [t] : []), t, t, lead.id, prevId, ...won.args),
  ];
  return { markerId, won, stmts, guard: won };
}
export const ownershipWon = async (db, markerId) => !!(await first(db, `SELECT 1 AS x FROM crm_lead_owners WHERE id = ?`, markerId));

export async function activeUser(db, id) {
  const u = idStr(id) ? await first(db, `SELECT * FROM crm_users WHERE id = ?`, id) : null;
  if (!u) throw E.notFound('That staff member does not exist', 'user_not_found');
  if (u.status !== 'active' || u.archived) throw E.bad('That staff member is not active', 'user_inactive');
  return u;
}

// ---------- create ----------
// The one way a lead is born (manual, public form, WhatsApp, Meta, import, legacy). `input.fields` are validated columns.
export async function createLeadCore(db, actor, input, o = {}) {
  const t = o.at || now(), id = o.id || newId();
  const f = input.fields, attr = input.attr || null;
  const sourceKey = input.sourceKey || 'manual';
  const ids = o.ids || await resolveEntities(db, attr, { create: !!o.createEntities });
  const first_ = firstTouchCols(sourceKey, attr, ids, t);
  const owner = input.owner || null;
  const row = {
    id, name: f.name || (f.phone || f.whatsapp || f.email || 'Unknown'), phone: f.phone || null, phone_norm: f.phone_norm || null, whatsapp: f.whatsapp || null, whatsapp_norm: f.whatsapp_norm || null,
    email: f.email || null, business_name: f.business_name || null, location: f.location || null, notes: f.notes || null,
    country: f.country || null, estimated_value: f.estimated_value ?? null, expected_close_date: f.expected_close_date || null, next_action: f.next_action || null,
    status_key: input.statusKey || 'new', class_key: input.classKey || null, source_key: sourceKey, owner_id: owner ? owner.id : null,
    created_by: actor && actor.id || null, created_by_name: actor && actor.name || (o.createdByName || 'system'),
    created_at: t, updated_at: t, assigned_at: owner ? t : null, last_activity_at: t, ...first_, import_id: o.importId || null,
    legacy_id: o.legacyId || null, legacy_json: o.legacyJson || null, ...(o.extraCols || {}),
  };
  const cols = Object.keys(row);
  // o.guardDuplicates: the row is inserted only when no live lead has the same phone / WhatsApp / e-mail AT THE MOMENT OF THE INSERT (same transaction), so two
  // simultaneous submissions cannot both pass an earlier "is there a duplicate?" read. The statements that follow reference the lead (foreign keys), so a refused
  // insert fails the whole batch, which rolls back; it is turned into a 409 below.
  const dg = o.guardDuplicates ? dupGuard(f) : null;
  const stmts = [dg
    ? st(db, `INSERT INTO crm_leads (${cols.join(',')}) SELECT ${placeholders(cols.length)} WHERE NOT ${dg.sql}`, ...cols.map((c) => row[c]), ...dg.args)
    : st(db, `INSERT INTO crm_leads (${cols.join(',')}) VALUES (${placeholders(cols.length)})`, ...cols.map((c) => row[c]))];
  if (owner) stmts.push(st(db, `INSERT INTO crm_lead_owners (id, lead_id, user_id, user_name, kind, by_user_id, by_name, started_at) VALUES (?,?,?,?,?,?,?,?)`, newId(), id, owner.id, owner.name, o.ownerKind || 'create', actor && actor.id || null, actor && actor.name || 'system', t));
  for (const pid of input.productIds || []) stmts.push(st(db, `INSERT OR IGNORE INTO crm_lead_products (lead_id, product_id, added_at, added_by) VALUES (?,?,?,?)`, id, pid, t, actor && actor.id || null));
  if (!o.skipEvent) stmts.push(eventSt(db, id, o.attrKind || sourceKey, sourceKey, attr, ids, { at: t, raw: o.rawEvent, externalId: o.eventExternalId }));
  stmts.push(...(o.extraStmts || []));
  stmts.push(activitySt(db, actor, id, 'create', o.activityText || `Lead created (${sourceKey})`, { source: sourceKey }, t));
  stmts.push(auditSt(db, actor, o.auditAction || 'lead_create', 'lead', id, null, {
    name: row.name, phone: row.phone, email: row.email, source: sourceKey, owner: owner && owner.id, status: row.status_key, class: row.class_key, estimatedValue: row.estimated_value, expectedCloseDate: row.expected_close_date,
    attribution: hasAttr(attr) || ids && (ids.campaignId || ids.adsetId || ids.adId) ? { campaignId: ids && ids.campaignId || null, adsetId: ids && ids.adsetId || null, adId: ids && ids.adId || null, utmSource: attr && attr.utm_source || null, utmMedium: attr && attr.utm_medium || null, utmCampaign: attr && attr.utm_campaign || null, utmContent: attr && attr.utm_content || null, landingUrl: attr && attr.landing_url || null } : null,
  }, t));
  stmts.push(emitSt(db, actor, 'lead.created', { entity: 'lead', entityId: id, leadId: id, data: { source: sourceKey, ownerId: owner ? owner.id : null, unassigned: !owner, importId: o.importId || null, campaignId: ids && ids.campaignId || null, adId: ids && ids.adId || null } }, t));
  if (!o.silent) {
    // new lead: managers always; in the unassigned pool everyone who may claim it (spec section 50: "Unassigned pool -> Notify staff")
    const audience = owner ? await managers(db, actor && actor.id) : await poolWatchers(db, actor && actor.id);
    stmts.push(...notifyMany(db, audience, actor && actor.id, 'new_lead', 'New lead: ' + row.name, `${sourceKey}${owner ? ' · assigned to ' + owner.name : ' · unassigned, ready to claim'}`, { leadId: id, entity: 'lead', entityId: id, at: t }));
    if (owner && (!actor || owner.id !== actor.id)) stmts.push(notifySt(db, owner.id, 'assigned', 'Lead assigned to you: ' + row.name, null, { leadId: id, entity: 'lead', entityId: id, at: t }));
  }
  try { await db.batch(stmts); }
  catch (e) {
    if (dg && /FOREIGN KEY/i.test(String(e && e.message))) {
      const dups = await findDuplicates(db, f);
      if (dups.length) throw E.conflict('A lead with the same phone, WhatsApp or email already exists', 'duplicate', { duplicates: dups.map((d) => ({ ...leadOut(d.row), matchedOn: d.matchedOn })) });
    }
    throw e;
  }
  return first(db, `${LEAD_SELECT} WHERE l.id = ?`, id);
}
// SQL condition "a live lead with the same phone / WhatsApp / e-mail exists" (null when there is nothing to compare)
function dupGuard(f) {
  const nums = [...new Set([f.phone_norm, f.whatsapp_norm].filter(Boolean))];
  const conds = [], args = [];
  if (nums.length) { conds.push(`x.phone_norm IN (${placeholders(nums.length)})`, `x.whatsapp_norm IN (${placeholders(nums.length)})`); args.push(...nums, ...nums); }
  if (f.email) { conds.push('x.email = ?'); args.push(f.email); }
  return conds.length ? { sql: `EXISTS (SELECT 1 FROM crm_leads x WHERE x.deleted_at IS NULL AND (${conds.join(' OR ')}))`, args } : null;
}

// A returning lead (same phone / e-mail) shows up again through a form / chat / ad: the touch is kept, the FIRST attribution is untouched.
export async function recordTouch(db, lead, { attr, kind, sourceKey, summary, message, at = now(), createEntities = false, actor = null, ids: given, externalId, skipEvent = false }) {
  const ids = given || await resolveEntities(db, attr, { create: createEntities });
  const stmts = skipEvent ? [] : [eventSt(db, lead.id, kind, sourceKey, attr, ids, { at, externalId })];
  stmts.push(activitySt(db, actor, lead.id, 'touch', summary || `Contacted us again (${kind})` + (message ? `: ${String(message).slice(0, 200)}` : ''), { kind, message: message ? String(message).slice(0, 1000) : null }, at));
  stmts.push(st(db, `UPDATE crm_leads SET updated_at = ?, last_activity_at = ? WHERE id = ?`, at, at, lead.id));
  stmts.push(auditSt(db, actor, 'lead_attribution', 'lead', lead.id, null, { touch: kind, source: sourceKey || null, campaignId: ids && ids.campaignId || null, adsetId: ids && ids.adsetId || null, adId: ids && ids.adId || null, utmCampaign: attr && attr.utm_campaign || null, utmContent: attr && attr.utm_content || null }, at));
  stmts.push(emitSt(db, actor, 'lead.returning', { entity: 'lead', entityId: lead.id, leadId: lead.id, data: { kind, sourceKey: sourceKey || null } }, at));
  const targets = lead.owner_id ? [lead.owner_id] : (await managers(db, null)).map((u) => u.id);
  stmts.push(...notifyMany(db, targets, null, 'new_lead', 'Returning lead: ' + lead.name, `${kind}${message ? ' · ' + String(message).slice(0, 120) : ''}`, { leadId: lead.id, entity: 'lead', entityId: lead.id, at }));
  await db.batch(stmts);
  return ids;
}

async function checkedConfig(db, f) {
  const keys = await activeKeys(db), errors = {};
  const out = {};
  if (f.source != null) { if (typeof f.source !== 'string' || !keys.sources.has(f.source)) errors.source = 'Unknown source'; else out.sourceKey = f.source; }
  if (f.classification != null && f.classification !== '') { if (typeof f.classification !== 'string' || !keys.classes.has(f.classification)) errors.classification = 'Unknown classification'; else out.classKey = f.classification; }
  if (f.status != null && f.status !== '') {
    const r = typeof f.status === 'string' ? await statusRow(db, f.status) : null;
    if (!r || !r.active) errors.status = 'Unknown status';
    else if (r.is_won || r.is_lost) errors.status = 'A new lead cannot start as won or lost';
    else out.statusKey = r.key;
  }
  return { out, errors, keys };
}
async function checkedProducts(db, ids) {
  const list = [...new Set(arr(ids, 50).map((x) => String(x)))];
  if (!list.length) return [];
  const rows = await all(db, `SELECT id FROM crm_products WHERE active = 1 AND id IN (${placeholders(list.length)})`, ...list);
  if (rows.length !== list.length) throw E.bad('One of the products does not exist or is inactive', 'invalid_product');
  return list;
}
// campaign / ad set / ad picked in the UI (internal ids) checked against the real rows -> { campaignId, adsetId, adId } | null
async function checkedEntities(db, b) {
  const cId = idStr(b.campaignId), sId = idStr(b.adsetId), aId = idStr(b.adId);
  for (const [k, v] of [['campaignId', b.campaignId], ['adsetId', b.adsetId], ['adId', b.adId]]) if (v != null && v !== '' && !idStr(v)) throw E.bad(`${k} is not valid`, 'invalid_' + k.replace(/Id$/, '').toLowerCase());
  if (!cId && !sId && !aId) return null;
  const ids = { campaignId: null, adsetId: null, adId: null };
  if (aId) { const r = await first(db, `SELECT id, adset_id, campaign_id FROM crm_ads WHERE id = ?`, aId); if (!r) throw E.bad('Unknown ad', 'invalid_ad'); ids.adId = r.id; ids.adsetId = r.adset_id; ids.campaignId = r.campaign_id; }
  if (sId) { const r = await first(db, `SELECT id, campaign_id FROM crm_adsets WHERE id = ?`, sId); if (!r) throw E.bad('Unknown ad set', 'invalid_adset'); if (ids.adsetId && ids.adsetId !== r.id) throw E.bad('That ad does not belong to that ad set', 'invalid_adset'); ids.adsetId = r.id; ids.campaignId = ids.campaignId || r.campaign_id; }
  if (cId) { const r = await first(db, `SELECT id FROM crm_campaigns WHERE id = ?`, cId); if (!r) throw E.bad('Unknown campaign', 'invalid_campaign'); if (ids.campaignId && ids.campaignId !== r.id) throw E.bad('That ad set does not belong to that campaign', 'invalid_campaign'); ids.campaignId = r.id; }
  return ids;
}

export async function createLeadRoute(ctx) {
  const { db, actor } = ctx; actor.require('leads.create');
  const b = await ctx.json();
  const { fields, errors } = cleanContact(b);
  requireContactMethod(fields, errors);
  const cfg = await checkedConfig(db, { source: b.source || 'manual', classification: b.classification, status: b.status });
  Object.assign(errors, cfg.errors);
  throwIfErrors(errors);
  const productIds = await checkedProducts(db, b.productIds);
  // owner: an explicit assignTo needs leads.assign; otherwise staff without company-wide view own what they add, managers leave it in the pool
  let owner = null;
  if (b.assignTo) { actor.require('leads.assign'); owner = await activeUser(db, b.assignTo); if (!actor.has('leads.all') && owner.id !== actor.id) throw E.forbidden('You can only assign to yourself', 'forbidden'); }
  else if (!actor.has('leads.all')) owner = actor.user;
  const dups = await findDuplicates(db, fields);
  const attr = attrFromInput(b);
  const ids = await checkedEntities(db, b);
  if (b.mergeInto) {
    const target = await getLeadFor(ctx, b.mergeInto, { write: true });
    const row = await mergeIntoLead(ctx, target, fields, { attr, ids, productIds, sourceKey: cfg.out.sourceKey || 'manual', note: 'Merged from a duplicate entry' });
    return json({ lead: leadOut(row), merged: true });
  }
  if (dups.length && !b.force) {
    const e = E.conflict('A lead with the same phone, WhatsApp or email already exists', 'duplicate', { duplicates: dups.map((d) => dupOut(actor, d)) });
    throw e;
  }
  const row = await createLeadCore(db, actor, { fields, attr, ids: null, sourceKey: cfg.out.sourceKey || 'manual', classKey: cfg.out.classKey || null, statusKey: cfg.out.statusKey || null, productIds, owner },
    { ids, ownerKind: b.assignTo ? 'assign' : 'create', guardDuplicates: !b.force });
  return json({ lead: leadOut(row) }, 201);
}

export async function checkDuplicatesRoute(ctx) {
  const { db, actor } = ctx; actor.require('leads.create', 'leads.edit', 'leads.import');
  const b = await ctx.json();
  const { fields, errors } = cleanContact(b, { partial: true, requireName: false });
  throwIfErrors(errors);
  const dups = await findDuplicates(db, fields, idStr(b.excludeId));
  return { duplicates: dups.map((d) => dupOut(actor, d)) };
}

// fills blanks of `target` from `fields`, records the touch, notes; used by create-with-mergeInto and by POST /leads/:id/merge
async function mergeIntoLead(ctx, target, fields, { attr, ids, productIds = [], sourceKey, note }) {
  const { db, actor } = ctx, t = now();
  const sets = [], vals = [], prev = {}, next = {};
  for (const c of ['phone', 'whatsapp', 'email', 'business_name', 'location']) {
    if (fields[c] && !target[c]) { sets.push(`${c} = ?`); vals.push(fields[c]); prev[c] = null; next[c] = fields[c]; if (c === 'phone' || c === 'whatsapp') { sets.push(`${c}_norm = ?`); vals.push(fields[c + '_norm']); } }
  }
  if (fields.notes) { const n = (target.notes ? target.notes + '\n' : '') + fields.notes; sets.push('notes = ?'); vals.push(n.slice(0, 4000)); prev.notes = target.notes; next.notes = n.slice(0, 4000); }
  const stmts = [];
  if (sets.length) stmts.push(st(db, `UPDATE crm_leads SET ${sets.join(', ')}, updated_at = ?, last_activity_at = ? WHERE id = ?`, ...vals, t, t, target.id));
  for (const pid of productIds) stmts.push(st(db, `INSERT OR IGNORE INTO crm_lead_products (lead_id, product_id, added_at, added_by) VALUES (?,?,?,?)`, target.id, pid, t, actor.id));
  if (hasAttr(attr) || ids) stmts.push(eventSt(db, target.id, sourceKey || 'manual', sourceKey, attr, ids, { at: t }));
  stmts.push(activitySt(db, actor, target.id, 'merge', note, { added: Object.keys(next) }, t));
  stmts.push(auditSt(db, actor, 'lead_merge_data', 'lead', target.id, prev, next, t));
  await db.batch(stmts);
  return first(db, `${LEAD_SELECT} WHERE l.id = ?`, target.id);
}

// ---------- read one / list ----------
// Object-level check: a lead outside the caller's scope is a 404 (nothing to learn), one they can see but not change is a 403 for writes.
export async function getLeadFor(ctx, id, { write = false } = {}) {
  const { db, actor } = ctx;
  const sc = leadScope(actor);
  const row = typeof id === 'string' && id.length <= 64 ? await first(db, `${LEAD_SELECT} WHERE l.id = ? AND ${sc.sql}`, id, ...sc.args) : null;
  if (!row) throw E.notFound('Lead not found', 'lead_not_found');
  if (write && !canWriteLead(actor, row)) throw E.forbidden(row.owner_id ? 'This lead belongs to someone else' : 'Claim this lead first', row.owner_id ? 'not_your_lead' : 'claim_first');
  return row;
}

function leadFilter(ctx, q) {
  const { actor } = ctx;
  const fts = crmFeatures(ctx.db).fts && String(ctx.env && ctx.env.CRM_FTS != null ? ctx.env.CRM_FTS : '') !== '0';       // the optional full-text table exists and is not switched off
  const sc = leadScope(actor);
  const where = [sc.sql], args = [...sc.args];
  const list = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
  const inList = (col, v) => { const l = list(v); if (l.length) { where.push(`${col} IN (${placeholders(l.length)})`); args.push(...l); } };
  const term = text(q.get('q'), 100);
  if (term) {
    const digits = term.replace(/\D/g, '').replace(/^0+/, '');
    const phoneToo = digits.length >= 3 && digits.length >= term.replace(/[\s+\-()]/g, '').replace(/^0+/, '').length - 1;
    if (fts && term.length >= 3) {
      // zip 161: the optional trigram FTS table (schema.js CRM_FTS_SCHEMA) answers the same question as the LIKE below: "does the text appear inside name / business / e-mail /
      // location, or do the digits appear inside a phone / WhatsApp number" — without reading every row. A term of 1-2 characters cannot use trigrams and uses LIKE.
      const qq = (x) => '"' + String(x).replace(/"/g, '""') + '"';
      where.push('l.rowid IN (SELECT rowid FROM crm_leads_fts WHERE crm_leads_fts MATCH ?)');
      args.push(qq(term) + (phoneToo ? ' OR phones : ' + qq(digits) : ''));
    } else {
      const c = ["l.name LIKE ? ESCAPE '\\'", "l.business_name LIKE ? ESCAPE '\\'", "l.email LIKE ? ESCAPE '\\'", "l.location LIKE ? ESCAPE '\\'"];
      const a = [like(term), like(term), like(term), like(term)];
      if (phoneToo) { c.push('l.phone_norm LIKE ?', 'l.whatsapp_norm LIKE ?'); a.push('%' + digits + '%', '%' + digits + '%'); }
      where.push('(' + c.join(' OR ') + ')'); args.push(...a);
    }
  }
  if (q.get('status')) inList('l.status_key', q.get('status'));
  if (q.get('class')) inList('l.class_key', q.get('class'));
  if (q.get('source')) inList('l.source_key', q.get('source'));
  const staff = q.get('staff');
  if (staff === 'none') where.push('l.owner_id IS NULL'); else if (staff === 'me') { where.push('l.owner_id = ?'); args.push(actor.id); } else if (staff) { where.push('l.owner_id = ?'); args.push(staff); }
  if (q.get('pool') === '1' || q.get('pool') === 'true') where.push('l.owner_id IS NULL');
  for (const [p, col] of [['campaign', 'first_campaign_id'], ['adset', 'first_adset_id'], ['ad', 'first_ad_id']]) if (q.get(p)) { where.push(`l.${col} = ?`); args.push(q.get(p)); }
  if (q.get('product')) { where.push('EXISTS (SELECT 1 FROM crm_lead_products lp WHERE lp.lead_id = l.id AND lp.product_id = ?)'); args.push(q.get('product')); }
  const r = optRange(q.get('from'), q.get('to'));
  if (r.from != null) { where.push('l.created_at >= ?'); args.push(r.from); }
  if (r.to != null) { where.push('l.created_at < ?'); args.push(r.to); }
  const follow = q.get('follow');
  if (follow) {
    const t = now(), todayEnd = dayStart(nairobiDay(t)) + DAY;
    const o = `EXISTS (SELECT 1 FROM crm_followups f WHERE f.lead_id = l.id AND f.status = 'open'`;
    if (follow === 'today') { where.push(`${o} AND f.due_at >= ? AND f.due_at < ?)`); args.push(t, todayEnd); }
    else if (follow === 'overdue') { where.push(`${o} AND f.due_at < ?)`); args.push(t); }
    else if (follow === 'upcoming') { where.push(`${o} AND f.due_at >= ?)`); args.push(todayEnd); }
    else if (follow === 'none') where.push(`NOT ${o})`);
    else throw E.bad('follow must be today, overdue, upcoming or none', 'invalid_follow');
  }
  const rev = q.get('revenue'), sortKey = q.get('sort') || 'created_at';
  const sc2 = salesScope(actor, 's');
  if ((rev || sortKey === 'revenue') && !sc2) throw E.forbidden('You cannot filter or sort by revenue', 'forbidden');
  // revenue is judged inside the viewer's own revenue scope: a sale they may not see does not exist for them
  if (rev === 'won') { where.push(`EXISTS (SELECT 1 FROM crm_sales s WHERE s.lead_id = l.id AND ${sc2.sql})`); args.push(...sc2.args); }
  else if (rev === 'none') { where.push(`NOT EXISTS (SELECT 1 FROM crm_sales s WHERE s.lead_id = l.id AND ${sc2.sql})`); args.push(...sc2.args); }
  else if (rev) throw E.bad('revenue must be won or none', 'invalid_revenue');
  // `outer` = the expression as the hydrating SELECT sees it (it can use that SELECT's aliases); `inner` = the same value computed straight from the lead row, which is what
  // the id-page query (phase 1) orders by, so that only the rows of ONE page pay for the ~9 sub-selects of a lead row. `key` = usable as a keyset cursor.
  const rowSort = (col) => ({ outer: col, inner: col });
  const SORTS = { created: rowSort('l.created_at'), created_at: rowSort('l.created_at'), updated: rowSort('l.updated_at'), updated_at: rowSort('l.updated_at'), name: rowSort('l.name COLLATE NOCASE'), phone: rowSort('l.phone_norm'), status: rowSort('l.status_key'),
    class: rowSort('l.class_key'), classification: rowSort('l.class_key'), source: rowSort('l.source_key'),
    campaign: { outer: 'campaign_name COLLATE NOCASE', inner: '(SELECT name FROM crm_campaigns WHERE id = l.first_campaign_id) COLLATE NOCASE' },
    ad: { outer: 'ad_name COLLATE NOCASE', inner: '(SELECT name FROM crm_ads WHERE id = l.first_ad_id) COLLATE NOCASE' },
    product: { outer: 'product_names COLLATE NOCASE', inner: '(SELECT group_concat(p.label, char(31)) FROM (SELECT p2.label FROM crm_lead_products lp2 JOIN crm_products p2 ON p2.id = lp2.product_id WHERE lp2.lead_id = l.id ORDER BY p2.position) p) COLLATE NOCASE' },
    staff: { outer: 'owner_name COLLATE NOCASE', inner: '(SELECT name FROM crm_users WHERE id = l.owner_id) COLLATE NOCASE' }, owner: { outer: 'owner_name COLLATE NOCASE', inner: '(SELECT name FROM crm_users WHERE id = l.owner_id) COLLATE NOCASE' },
    last_contact: rowSort('l.last_contacted_at'), last_activity: rowSort('l.last_activity_at'),
    next_followup: { outer: 'next_followup_at', inner: `(SELECT MIN(f.due_at) FROM crm_followups f WHERE f.lead_id = l.id AND f.status = 'open')` },
    deal_value: rowSort('l.estimated_value'), estimated_value: rowSort('l.estimated_value'),
    revenue: { outer: 'revenue', inner: sc2 ? `(SELECT SUM(s.total) FROM crm_sales s WHERE s.lead_id = l.id AND ${sc2.sql})` : 'NULL', args: sc2 ? sc2.args : [] } };
  const sortSpec = SORTS[sortKey];
  if (!sortSpec) throw E.bad('unknown sort', 'invalid_sort');
  const dir = String(q.get('dir') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // empty values always sort last, whatever the direction
  const plain = ['name', 'created', 'created_at', 'updated', 'updated_at', 'status'].includes(sortKey);
  const orderOf = (col) => (plain ? `${col} ${dir}, l.id` : `(${col.replace(' COLLATE NOCASE', '')} IS NULL), ${col} ${dir}, l.id`);
  const order = orderOf(sortSpec.outer);
  // keyset paging (zip 161): only for the two sorts whose key is a plain, never-empty number (created / updated); `after` = "<value>:<id>" from the previous page's nextCursor
  const keyCol = { created: 'l.created_at', created_at: 'l.created_at', updated: 'l.updated_at', updated_at: 'l.updated_at' }[sortKey] || null;
  let cursorSql = null, cursorArgs = [];
  const cur = q.get('after') ? /^(\d{1,15}):(.{1,64})$/.exec(q.get('after')) : null;
  if (q.get('after') && !cur) throw E.bad('after is not a valid cursor', 'invalid_cursor');
  if (cur && keyCol) { const op = dir === 'ASC' ? '>' : '<'; cursorSql = `(${keyCol} ${op} ? OR (${keyCol} = ? AND l.id > ?))`; cursorArgs = [Number(cur[1]), Number(cur[1]), cur[2]]; }
  return { where: where.join(' AND '), args, order, dir, inner: { order: orderOf(sortSpec.inner), args: sortSpec.args || [] }, keyCol, cursor: cursorSql ? { sql: cursorSql, args: cursorArgs } : null };
}

export async function listLeads(ctx) {
  const { db, actor, query } = ctx; actor.require('leads.view');
  const f = leadFilter(ctx, query);
  const pageSize = Math.min(200, Math.max(1, parseInt(query.get('pageSize'), 10) || 50));
  const page = Math.max(1, parseInt(query.get('page'), 10) || 1);
  const ls = listSelect(actor);
  // zip 161: TWO phases in ONE round trip. Phase 1 picks the ids of the page from the lead rows alone (filter, sort, LIMIT). Phase 2 fetches those rows with their ~9 sub-selects
  // (owner, products, next follow-up, campaign names, revenue ...), so the sub-selects run for the 25-50 rows of the page instead of for every row the sort had to look at.
  // The keyset cursor (`after`, sort created / updated only) replaces OFFSET; `count=0` skips the COUNT(*) (a client that already knows the total).
  const wantCount = query.get('count') !== '0' && !f.cursor;
  const where = f.cursor ? `${f.where} AND ${f.cursor.sql}` : f.where;
  const offset = f.cursor ? 0 : (page - 1) * pageSize;
  const idPage = `SELECT l.id FROM crm_leads l WHERE ${where} ORDER BY ${f.inner.order} LIMIT ? OFFSET ?`;
  const hydrate = ls.sql.replace('FROM crm_leads l LEFT JOIN', 'FROM page p CROSS JOIN crm_leads l ON l.id = p.id LEFT JOIN');
  const stmts = [st(db, `WITH page AS (${idPage}) ${hydrate} ORDER BY ${f.order}`, ...f.args, ...(f.cursor ? f.cursor.args : []), ...f.inner.args, pageSize + 1, offset, ...ls.args)];        // placeholders are numbered by position in the text: the page CTE comes first, the sub-selects of the hydrating SELECT after it
  if (wantCount) stmts.unshift(st(db, `SELECT COUNT(*) n FROM crm_leads l WHERE ${f.where}`, ...f.args));
  const res = await many(db, stmts);
  const rows = wantCount ? res[1] : res[0];
  const more = rows.length > pageSize; if (more) rows.length = pageSize;
  const last = rows[rows.length - 1];
  return { items: rows.map((r) => leadOut(ls.hasRevenue ? r : { ...r, actual_value: null })), total: wantCount ? res[0][0].n : null, page, pageSize, canSeeRevenue: ls.hasRevenue,
    hasMore: more, nextCursor: more && f.keyCol && last ? `${f.keyCol === 'l.created_at' ? last.created_at : last.updated_at}:${last.id}` : null };
}

export async function exportLeads(ctx) {
  const { db, actor, query } = ctx; actor.require('leads.export');
  const f = leadFilter(ctx, query);
  const ls = listSelect(actor);
  const rows = await all(db, `${ls.sql.replace('FROM crm_leads l', `, (SELECT label FROM crm_statuses WHERE key = l.status_key) AS status_label FROM crm_leads l`)} WHERE ${f.where} ORDER BY ${f.order} LIMIT 20000`, ...ls.args, ...f.args);
  const iso = (t) => (t ? new Date(t).toISOString() : '');
  const cols = ['id', 'name', 'phone', 'whatsapp', 'email', 'business_name', 'location', 'country', 'status', 'classification', 'source', 'owner', 'products', 'campaign', 'ad_set', 'ad', 'utm_source', 'utm_medium', 'utm_campaign',
    'estimated_value', ...(ls.hasRevenue ? ['actual_value', 'revenue'] : []), 'expected_close_date', 'next_action', 'contact_attempts', 'last_contacted_at', 'last_contacted_by', 'next_followup_at', 'created_at', 'first_contact_at', 'converted_at', 'notes'];
  const out = rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, whatsapp: r.whatsapp, email: r.email, business_name: r.business_name, location: r.location, country: r.country, status: r.status_label || r.status_key, classification: r.class_key, source: r.first_source_key || r.source_key, owner: r.owner_name,
    products: r.product_names ? String(r.product_names).split('\u001f').join('; ') : '', campaign: r.campaign_name, ad_set: r.adset_name, ad: r.ad_name, utm_source: r.first_utm_source, utm_medium: r.first_utm_medium, utm_campaign: r.first_utm_campaign,
    estimated_value: r.estimated_value, actual_value: r.actual_value, revenue: r.revenue, expected_close_date: r.expected_close_date, next_action: r.next_action, contact_attempts: r.contact_attempts, last_contacted_at: iso(r.last_contacted_at), last_contacted_by: r.last_contacted_by_name,
    next_followup_at: iso(r.next_followup_at), created_at: iso(r.created_at), first_contact_at: iso(r.first_contact_at), converted_at: iso(r.converted_at), notes: r.notes }));
  await db.batch([auditSt(db, actor, 'leads_export', 'lead', null, null, { rows: out.length, filters: Object.fromEntries(query) })]);
  return csvResponse(toCsv(cols, out), `leads-${nairobiDay()}.csv`);
}

export async function getLead(ctx) {
  const { db, actor } = ctx; actor.require('leads.view');
  // zip 161: the lead (with its scope check) and its 8 related lists in ONE round trip (a lookup, then eight queries; the eight ran in parallel but were eight trips)
  const id = ctx.params.id, sc = leadScope(actor), sales = salesScope(actor, 's');
  const [rows, products, timeline, followups, meetings, saleRows, owners, attrs, conv] = typeof id === 'string' && id.length <= 64 ? await many(db, [
    st(db, `${LEAD_SELECT} WHERE l.id = ? AND ${sc.sql}`, id, ...sc.args),
    st(db, `SELECT p.id, p.key, p.label FROM crm_lead_products lp JOIN crm_products p ON p.id = lp.product_id WHERE lp.lead_id = ? ORDER BY p.position`, id),
    st(db, `SELECT id, user_id, user_name, type, summary, data, created_at FROM crm_activities WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 500`, id),
    st(db, `SELECT f.*, u.name AS assigned_name FROM crm_followups f LEFT JOIN crm_users u ON u.id = f.assigned_user_id WHERE f.lead_id = ? ORDER BY f.due_at DESC LIMIT 100`, id),
    st(db, `SELECT m.*, u.name AS user_name FROM crm_meetings m LEFT JOIN crm_users u ON u.id = m.user_id WHERE m.lead_id = ? ORDER BY m.starts_at DESC LIMIT 100`, id),
    sales ? st(db, `SELECT s.* FROM crm_sales s WHERE s.lead_id = ? AND ${sales.sql} ORDER BY s.sold_at DESC`, id, ...sales.args) : st(db, `SELECT 1 x WHERE 0`),
    st(db, `SELECT * FROM crm_lead_owners WHERE lead_id = ? ORDER BY started_at, rowid`, id),
    st(db, `SELECT e.*, c.name AS campaign_name, a.name AS adset_name, d.name AS ad_name FROM crm_attribution_events e LEFT JOIN crm_campaigns c ON c.id = e.campaign_id LEFT JOIN crm_adsets a ON a.id = e.adset_id LEFT JOIN crm_ads d ON d.id = e.ad_id WHERE e.lead_id = ? ORDER BY e.at, e.rowid`, id),
    actor.has('inbox.view') ? st(db, `SELECT id, wa_id, contact_name, last_message_at, last_message_text, unread_count FROM crm_conversations WHERE lead_id = ? ORDER BY last_message_at DESC LIMIT 1`, id) : st(db, `SELECT 1 x WHERE 0`),
  ]) : [[]];
  const row = rows[0];
  if (!row) throw E.notFound('Lead not found', 'lead_not_found');
  const conv1 = conv && conv[0] || null;
  const { followupOut, meetingOut } = await import('./followups.js');
  const { saleOut } = await import('./sales.js');
  return {
    lead: leadOut(sales ? row : { ...row, actual_value: null }),
    products,
    timeline: timeline.map((a) => ({ id: a.id, userId: a.user_id, userName: a.user_name, type: a.type, summary: a.summary, data: jparse(a.data), at: a.created_at })),
    followups: followups.map(followupOut), meetings: meetings.map(meetingOut), sales: saleRows.map(saleOut),
    owners: owners.map((o) => ({ id: o.id, userId: o.user_id, userName: o.user_name, kind: o.kind, fromUserId: o.from_user_id, byUserId: o.by_user_id, byName: o.by_name, reason: o.reason, startedAt: o.started_at, endedAt: o.ended_at })),
    attributions: attrs.map((e) => ({ id: e.id, kind: e.kind, source: e.source_key, campaignId: e.campaign_id, campaignName: e.campaign_name, adsetId: e.adset_id, adsetName: e.adset_name, adId: e.ad_id, adName: e.ad_name, utmSource: e.utm_source, utmMedium: e.utm_medium, utmCampaign: e.utm_campaign, utmContent: e.utm_content, utmTerm: e.utm_term, referrer: e.referrer, landingUrl: e.landing_url, headline: e.headline, resolved: !!e.resolved, at: e.at })),
    conversation: conv1 ? { id: conv1.id, waId: conv1.wa_id, contactName: conv1.contact_name, lastMessageAt: conv1.last_message_at, lastMessageText: conv1.last_message_text, unread: conv1.unread_count } : null,
  };
}

// ---------- edit ----------
export async function patchLead(ctx) {
  const { db, actor } = ctx; actor.require('leads.edit');
  const lead = await getLeadFor(ctx, ctx.params.id, { write: true });
  const b = await ctx.json();
  const { fields, errors } = cleanContact(b, { partial: true });
  if ('source' in b) { const c = await checkedConfig(db, { source: b.source }); Object.assign(errors, c.errors); if (c.out.sourceKey) fields.source_key = c.out.sourceKey; }
  throwIfErrors(errors);
  const cols = Object.keys(fields).filter((c) => (fields[c] ?? null) !== (lead[c] ?? null));
  if (!cols.length) return { lead: leadOut(lead), unchanged: true };
  if (['phone_norm', 'whatsapp_norm', 'email'].some((c) => cols.includes(c)) && !b.force) {
    const dups = await findDuplicates(db, { phone_norm: fields.phone_norm ?? null, whatsapp_norm: fields.whatsapp_norm ?? null, email: fields.email ?? null }, lead.id);
    const fresh = dups.filter((d) => (cols.includes('phone_norm') && d.row.phone_norm === fields.phone_norm) || (cols.includes('whatsapp_norm') && d.row.whatsapp_norm === fields.whatsapp_norm) || (cols.includes('phone_norm') && fields.phone_norm && d.row.whatsapp_norm === fields.phone_norm) || (cols.includes('email') && fields.email && d.row.email === fields.email));
    if (fresh.length) throw E.conflict('Another lead already has that phone, WhatsApp or email', 'duplicate', { duplicates: fresh.map((d) => dupOut(actor, d)) });
  }
  const prev = {}, next = {}; cols.forEach((c) => { prev[c] = lead[c]; next[c] = fields[c]; });
  const t = now();
  await db.batch([
    st(db, `UPDATE crm_leads SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ?, last_activity_at = ? WHERE id = ?`, ...cols.map((c) => fields[c]), t, t, lead.id),
    activitySt(db, actor, lead.id, 'edit', 'Details edited: ' + cols.filter((c) => !c.endsWith('_norm')).join(', '), { prev, next }, t),
    auditSt(db, actor, 'lead_update', 'lead', lead.id, prev, next, t),
  ]);
  return { lead: leadOut(await first(db, `${LEAD_SELECT} WHERE l.id = ?`, lead.id)) };
}

export async function deleteLead(ctx) {
  const { db, actor } = ctx; actor.require('leads.delete');
  const lead = await getLeadFor(ctx, ctx.params.id, { write: true });
  const t = now();
  const sales = await first(db, `SELECT COUNT(*) n FROM crm_sales WHERE lead_id = ?`, lead.id);
  if (sales.n) throw E.conflict('This lead has recorded sales and cannot be removed', 'has_sales');
  await db.batch([
    st(db, `UPDATE crm_leads SET deleted_at = ?, updated_at = ? WHERE id = ?`, t, t, lead.id),
    activitySt(db, actor, lead.id, 'delete', 'Lead removed (kept in the audit trail)', null, t),
    auditSt(db, actor, 'lead_delete', 'lead', lead.id, { name: lead.name, phone: lead.phone, status: lead.status_key }, { deleted: true }, t),
  ]);
  return { ok: true };
}

// ---------- claim / assign ----------
export async function claimLead(ctx) {
  const { db, actor } = ctx; actor.require('leads.claim');
  let lead;
  try { lead = await getLeadFor(ctx, ctx.params.id); } catch (e) {
    // a lead that left the pool between the list and the click is "already claimed", not "not found" (no owner details for someone else's lead)
    if (e.code === 'lead_not_found' && typeof ctx.params.id === 'string' && ctx.params.id.length <= 64 && await first(db, `SELECT 1 x FROM crm_leads WHERE id = ? AND deleted_at IS NULL AND owner_id IS NOT NULL`, ctx.params.id)) throw E.conflict('Already claimed by someone else', 'already_claimed');
    throw e;
  }
  if (lead.owner_id) throw E.conflict(lead.owner_id === actor.id ? 'You already own this lead' : `Already claimed by ${lead.owner_name || 'someone else'}`, 'already_claimed', { ownerId: lead.owner_id, ownerName: lead.owner_name });
  const t = now();
  const ch = ownershipChange(db, { lead, newOwner: actor.user, kind: 'claim', actor, t });
  const stmts = [...ch.stmts,
    activitySt(db, actor, lead.id, 'claim', `Claimed by ${actor.name}`, null, t, ch.guard),
    auditSt(db, actor, 'lead_claim', 'lead', lead.id, { owner: null }, { owner: actor.id }, t, ch.guard),
    emitSt(db, actor, 'lead.claimed', { entity: 'lead', entityId: lead.id, leadId: lead.id, data: { ownerId: actor.id } }, t, ch.guard),
    ...notifyMany(db, await managers(db, actor.id), actor.id, 'claimed', `${actor.name} claimed ${lead.name}`, null, { leadId: lead.id, entity: 'lead', entityId: lead.id, at: t, guard: ch.guard })];
  await db.batch(stmts);
  if (!(await ownershipWon(db, ch.markerId))) {
    const cur = await first(db, `${LEAD_SELECT} WHERE l.id = ?`, lead.id);
    throw E.conflict(`Already claimed by ${cur && cur.owner_name || 'someone else'}`, 'already_claimed', { ownerId: cur && cur.owner_id, ownerName: cur && cur.owner_name });
  }
  return { lead: leadOut(await first(db, `${LEAD_SELECT} WHERE l.id = ?`, lead.id)) };
}

// shared by POST /leads/:id/assign, /leads/bulk and /staff/:id/reassign. `to` = active user row or null (back to the pool)
export async function assignLead(ctx, lead, to, { reason, kindOverride } = {}) {
  const { db, actor } = ctx;
  if ((lead.owner_id || null) === (to ? to.id : null)) return { lead, unchanged: true };
  const t = now();
  const kind = kindOverride || (!to ? 'unassign' : lead.owner_id ? 'reassign' : 'assign');
  const ch = ownershipChange(db, { lead, newOwner: to, kind, actor, reason, t });
  const stmts = [...ch.stmts,
    activitySt(db, actor, lead.id, kind, to ? `${kind === 'reassign' ? 'Reassigned' : 'Assigned'} to ${to.name}${lead.owner_name ? ` (was ${lead.owner_name})` : ''}` : `Returned to the unassigned pool (was ${lead.owner_name || 'unassigned'})`, { from: lead.owner_id, to: to ? to.id : null, reason: reason || null }, t, ch.guard),
    auditSt(db, actor, 'lead_' + kind, 'lead', lead.id, { owner: lead.owner_id }, { owner: to ? to.id : null, reason: reason || null }, t, ch.guard),
    emitSt(db, actor, 'lead.' + (kind === 'unassign' ? 'unassigned' : kind === 'reassign' ? 'reassigned' : 'assigned'), { entity: 'lead', entityId: lead.id, leadId: lead.id, data: { from: lead.owner_id, to: to ? to.id : null } }, t, ch.guard)];
  if (to && to.id !== actor.id) stmts.push(notifySt(db, to.id, kind === 'reassign' ? 'reassigned' : 'assigned', `Lead ${kind === 'reassign' ? 'reassigned' : 'assigned'} to you: ${lead.name}`, null, { leadId: lead.id, entity: 'lead', entityId: lead.id, at: t, guard: ch.guard }));
  if (lead.owner_id && lead.owner_id !== actor.id && (!to || lead.owner_id !== to.id)) stmts.push(notifySt(db, lead.owner_id, 'reassigned', `Lead moved away from you: ${lead.name}`, to ? `Now with ${to.name}` : 'Returned to the pool', { leadId: lead.id, entity: 'lead', entityId: lead.id, at: t, guard: ch.guard }));
  await db.batch(stmts);
  if (!(await ownershipWon(db, ch.markerId))) throw E.conflict('The lead changed hands while you were assigning it, please refresh', 'lead_changed');
  return { lead: await first(db, `${LEAD_SELECT} WHERE l.id = ?`, lead.id) };
}
export async function assignRoute(ctx) {
  const { db, actor } = ctx; actor.require('leads.assign');
  const lead = await getLeadFor(ctx, ctx.params.id, { write: true });
  const b = await ctx.json();
  if (!('userId' in b)) throw E.bad('userId is required (null returns the lead to the pool)', 'invalid_user');
  const to = b.userId ? await activeUser(db, b.userId) : null;
  if (to && !actor.has('leads.all') && to.id !== actor.id) throw E.forbidden('You can only assign to yourself', 'forbidden');
  const r = await assignLead(ctx, lead, to, { reason: text(b.reason, 200) });
  return { lead: leadOut(r.lead), ...(r.unchanged ? { unchanged: true } : {}) };
}

// ---------- status / classification / note / contact / products ----------
export async function setStatusCore(ctx, lead, status, lostReason) {
  const { db, actor } = ctx;
  const target = await statusRow(db, status);
  if (!target || !target.active) throw E.bad('Unknown status', 'invalid_status');
  if (target.is_won) throw E.bad('Record a sale with Convert to mark a lead as won', 'use_convert');
  const cur = await statusRow(db, lead.status_key);
  if (cur && cur.is_won && !actor.has('leads.all')) throw E.conflict('This lead is already won', 'lead_won');
  let reason = null;
  if (target.is_lost) {
    const lr = await first(db, `SELECT key FROM crm_lost_reasons WHERE key = ? AND active = 1`, (typeof lostReason === 'string' && lostReason) || LOST_REASON_OF[status] || '');
    if (!lr) throw E.bad('A lost reason is required', 'lost_reason_required');
    reason = lr.key;
  }
  if (lead.status_key === status && (lead.lost_reason_key || null) === reason) return { lead, unchanged: true };
  const t = now();
  await db.batch([
    st(db, `UPDATE crm_leads SET status_key = ?, lost_reason_key = ?, lost_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ?`, status, reason, target.is_lost ? t : null, t, t, lead.id),
    activitySt(db, actor, lead.id, 'status', `Status: ${cur ? cur.label : lead.status_key} → ${target.label}${reason ? ` (${reason})` : ''}`, { from: lead.status_key, to: status, lostReason: reason }, t),
    auditSt(db, actor, 'lead_status', 'lead', lead.id, { status: lead.status_key, lostReason: lead.lost_reason_key }, { status, lostReason: reason }, t),
    emitSt(db, actor, 'lead.status_changed', { entity: 'lead', entityId: lead.id, leadId: lead.id, data: { from: lead.status_key, to: status, lostReason: reason } }, t),
  ]);
  return { lead: await first(db, `${LEAD_SELECT} WHERE l.id = ?`, lead.id) };
}
export async function statusRoute(ctx) {
  ctx.actor.require('leads.edit');
  const lead = await getLeadFor(ctx, ctx.params.id, { write: true });
  const b = await ctx.json();
  const r = await setStatusCore(ctx, lead, String(b.status || ''), b.lostReason);
  return { lead: leadOut(r.lead), ...(r.unchanged ? { unchanged: true } : {}) };
}
export async function setClassCore(ctx, lead, value) {
  const { db, actor } = ctx;
  const key = value == null || value === '' ? null : String(value);
  if (key && !(await first(db, `SELECT 1 x FROM crm_classifications WHERE key = ? AND active = 1`, key))) throw E.bad('Unknown classification', 'invalid_classification');
  if ((lead.class_key || null) === key) return { lead, unchanged: true };
  const t = now();
  await db.batch([
    st(db, `UPDATE crm_leads SET class_key = ?, updated_at = ?, last_activity_at = ? WHERE id = ?`, key, t, t, lead.id),
    activitySt(db, actor, lead.id, 'classification', `Classification: ${lead.class_key || 'none'} → ${key || 'none'}`, { from: lead.class_key, to: key }, t),
    auditSt(db, actor, 'lead_classification', 'lead', lead.id, { classification: lead.class_key }, { classification: key }, t),
  ]);
  return { lead: await first(db, `${LEAD_SELECT} WHERE l.id = ?`, lead.id) };
}
export async function classificationRoute(ctx) {
  ctx.actor.require('leads.edit');
  const lead = await getLeadFor(ctx, ctx.params.id, { write: true });
  const b = await ctx.json();
  const r = await setClassCore(ctx, lead, b.value);
  return { lead: leadOut(r.lead), ...(r.unchanged ? { unchanged: true } : {}) };
}
export async function noteRoute(ctx) {
  const { db, actor } = ctx; actor.require('leads.edit');
  const lead = await getLeadFor(ctx, ctx.params.id, { write: true });
  const b = await ctx.json(); const txt = text(b.text, 2000);
  if (!txt) throw E.bad('The note is empty', 'invalid_text');
  const t = now(), aid = newId();
  await db.batch([
    st(db, `INSERT INTO crm_activities (id, lead_id, user_id, user_name, type, summary, data, created_at) VALUES (?,?,?,?,?,?,?,?)`, aid, lead.id, actor.id, actor.name, 'note', txt, null, t),
    touchLeadSt(db, lead.id, t),
    auditSt(db, actor, 'lead_note', 'lead', lead.id, null, { note: txt.slice(0, 200) }, t),
  ]);
  return json({ ok: true, id: aid }, 201);
}
export async function contactRoute(ctx) {
  const { db, actor } = ctx; actor.require('leads.edit');
  const lead = await getLeadFor(ctx, ctx.params.id, { write: true });
  const b = await ctx.json();
  const method = oneOf(String(b.method || ''), CONTACT_METHODS, 'method');
  const outcome = b.outcome == null || b.outcome === '' ? null : oneOf(String(b.outcome), CONTACT_OUTCOMES, 'outcome');
  const notes = text(b.notes, 1000), t = now();
  const responded = outcome && RESPONDED.has(outcome) ? 1 : 0;
  let nextAction;
  if (b.nextAction != null) { nextAction = text(b.nextAction, 200); }
  const stmts = [
    st(db, `INSERT INTO crm_contact_attempts (id, lead_id, user_id, user_name, method, outcome, notes, at) VALUES (?,?,?,?,?,?,?,?)`, newId(), lead.id, actor.id, actor.name, method, outcome, notes, t),
    st(db, `UPDATE crm_leads SET first_contact_at = COALESCE(first_contact_at, ?), first_response_at = CASE WHEN ? = 1 THEN COALESCE(first_response_at, ?) ELSE first_response_at END,
      contact_attempts = contact_attempts + 1, last_contacted_at = ?, last_contacted_by = ?, last_contacted_by_name = ?${nextAction !== undefined ? ', next_action = ?' : ''}, updated_at = ?, last_activity_at = ? WHERE id = ?`,
      t, responded, t, t, actor.id, actor.name, ...(nextAction !== undefined ? [nextAction] : []), t, t, lead.id),
    activitySt(db, actor, lead.id, 'contact', `Contact attempt: ${method}${outcome ? ' — ' + outcome : ''}${notes ? ': ' + notes.slice(0, 200) : ''}`, { method, outcome }, t),
    auditSt(db, actor, 'lead_contact', 'lead', lead.id, { contactAttempts: lead.contact_attempts || 0, lastContactedAt: lead.last_contacted_at ?? null, ...(nextAction !== undefined ? { nextAction: lead.next_action || null } : {}) }, { method, outcome, contactAttempts: (lead.contact_attempts || 0) + 1, lastContactedAt: t, ...(nextAction !== undefined ? { nextAction: nextAction || null } : {}) }, t),
    emitSt(db, actor, 'lead.contacted', { entity: 'lead', entityId: lead.id, leadId: lead.id, data: { method, outcome } }, t),
  ];
  if (PRE_CONTACT.includes(lead.status_key)) {
    const won = { sql: `EXISTS (SELECT 1 FROM crm_leads WHERE id = ? AND status_key = 'contacted' AND updated_at = ?)`, args: [lead.id, t] };
    stmts.push(st(db, `UPDATE crm_leads SET status_key = 'contacted' WHERE id = ? AND status_key IN (${inList(PRE_CONTACT)}) AND EXISTS (SELECT 1 FROM crm_statuses WHERE key = 'contacted' AND active = 1)`, lead.id));
    stmts.push(activitySt(db, actor, lead.id, 'status', `Status: ${lead.status_key} → Contacted (first contact)`, { from: lead.status_key, to: 'contacted', auto: true }, t, won));
    stmts.push(auditSt(db, actor, 'lead_status', 'lead', lead.id, { status: lead.status_key }, { status: 'contacted', auto: 'first_contact' }, t, won));
  }
  await db.batch(stmts);
  return json({ lead: leadOut(await first(db, `${LEAD_SELECT} WHERE l.id = ?`, lead.id)) }, 201);
}
export async function productsRoute(ctx) {
  const { db, actor } = ctx; actor.require('leads.edit');
  const lead = await getLeadFor(ctx, ctx.params.id, { write: true });
  const b = await ctx.json();
  const want = await checkedProducts(db, b.productIds);
  const cur = (await all(db, `SELECT product_id FROM crm_lead_products WHERE lead_id = ?`, lead.id)).map((r) => r.product_id);
  const add = want.filter((x) => !cur.includes(x)), del = cur.filter((x) => !want.includes(x));
  if (!add.length && !del.length) return { lead: leadOut(lead), unchanged: true };
  const t = now();
  await db.batch([
    ...add.map((p) => st(db, `INSERT OR IGNORE INTO crm_lead_products (lead_id, product_id, added_at, added_by) VALUES (?,?,?,?)`, lead.id, p, t, actor.id)),
    ...del.map((p) => st(db, `DELETE FROM crm_lead_products WHERE lead_id = ? AND product_id = ?`, lead.id, p)),
    activitySt(db, actor, lead.id, 'product', `Products of interest updated (${want.length})`, { added: add, removed: del }, t),
    auditSt(db, actor, 'lead_products', 'lead', lead.id, { productIds: cur }, { productIds: want }, t),
    touchLeadSt(db, lead.id, t),
  ]);
  return { lead: leadOut(await first(db, `${LEAD_SELECT} WHERE l.id = ?`, lead.id)) };
}

// ---------- merge lead :id INTO intoId (history moves, nothing is deleted) ----------
export async function mergeRoute(ctx) {
  const { db, actor } = ctx; actor.require('leads.edit');
  const b = await ctx.json();
  if (typeof b.intoId !== 'string' || !b.intoId || b.intoId === ctx.params.id) throw E.bad('intoId must be a different lead', 'invalid_merge');
  const src = await getLeadFor(ctx, ctx.params.id, { write: true });
  const dst = await getLeadFor(ctx, b.intoId, { write: true });
  const t = now();
  const sets = [], vals = [];
  for (const c of ['phone', 'whatsapp', 'email', 'business_name', 'location', 'class_key']) if (src[c] && !dst[c]) { sets.push(`${c} = ?`); vals.push(src[c]); if (c === 'phone' || c === 'whatsapp') { sets.push(`${c}_norm = ?`); vals.push(src[c + '_norm']); } }
  if (src.notes) { sets.push('notes = ?'); vals.push(((dst.notes ? dst.notes + '\n' : '') + src.notes).slice(0, 4000)); }
  const move = (tbl, col = 'lead_id') => st(db, `UPDATE ${tbl} SET ${col} = ? WHERE ${col} = ?`, dst.id, src.id);
  const stmts = [
    ...(sets.length ? [st(db, `UPDATE crm_leads SET ${sets.join(', ')} WHERE id = ?`, ...vals, dst.id)] : []),
    st(db, `INSERT OR IGNORE INTO crm_lead_products (lead_id, product_id, added_at, added_by) SELECT ?, product_id, added_at, added_by FROM crm_lead_products WHERE lead_id = ?`, dst.id, src.id),
    st(db, `DELETE FROM crm_lead_products WHERE lead_id = ?`, src.id),
    move('crm_activities'), move('crm_contact_attempts'), move('crm_followups'), move('crm_meetings'), move('crm_sales'), move('crm_attribution_events'), move('crm_customers'), move('crm_conversations'),
    st(db, `UPDATE crm_lead_owners SET ended_at = COALESCE(ended_at, ?) WHERE lead_id = ?`, t, src.id),
    st(db, `UPDATE crm_leads SET first_contact_at = CASE WHEN ? IS NOT NULL AND (first_contact_at IS NULL OR ? < first_contact_at) THEN ? ELSE first_contact_at END WHERE id = ?`, src.first_contact_at, src.first_contact_at, src.first_contact_at, dst.id),
    st(db, `UPDATE crm_leads SET contact_attempts = contact_attempts + ?, country = COALESCE(country, ?), estimated_value = COALESCE(estimated_value, ?), expected_close_date = COALESCE(expected_close_date, ?), next_action = COALESCE(next_action, ?),
      actual_value = (SELECT SUM(total) FROM crm_sales WHERE lead_id = ?) WHERE id = ?`, src.contact_attempts || 0, src.country, src.estimated_value, src.expected_close_date, src.next_action, dst.id, dst.id),
    ...(src.last_contacted_at && (!dst.last_contacted_at || src.last_contacted_at > dst.last_contacted_at)
      ? [st(db, `UPDATE crm_leads SET last_contacted_at = ?, last_contacted_by = ?, last_contacted_by_name = ? WHERE id = ?`, src.last_contacted_at, src.last_contacted_by, src.last_contacted_by_name, dst.id)] : []),
    st(db, `UPDATE crm_leads SET owner_id = NULL, deleted_at = ?, merged_into_id = ?, updated_at = ? WHERE id = ?`, t, dst.id, t, src.id),
    st(db, `UPDATE crm_leads SET updated_at = ?, last_activity_at = ? WHERE id = ?`, t, t, dst.id),
    activitySt(db, actor, dst.id, 'merge', `Merged ${src.name} (${src.phone || src.email || src.id}) into this lead`, { from: src.id }, t),
    auditSt(db, actor, 'lead_merge', 'lead', src.id, { id: src.id, name: src.name }, { mergedInto: dst.id }, t),
    emitSt(db, actor, 'lead.merged', { entity: 'lead', entityId: src.id, leadId: dst.id, data: { from: src.id, into: dst.id } }, t),
  ];
  await db.batch(stmts);
  return { lead: leadOut(await first(db, `${LEAD_SELECT} WHERE l.id = ?`, dst.id)) };
}

// ---------- bulk ----------
export async function bulkRoute(ctx) {
  const { db, actor } = ctx;
  const b = await ctx.json();
  if (Array.isArray(b.ids) && b.ids.length > 200) throw E.bad('At most 200 leads per bulk action', 'too_many');
  const ids = [...new Set(arr(b.ids, 200).map(String))];
  if (!ids.length) throw E.bad('ids is required', 'invalid_ids');
  const action = oneOf(String(b.action || ''), ['assign', 'status', 'classification'], 'action');
  actor.require(action === 'assign' ? 'leads.assign' : 'leads.edit');
  let to = null;
  if (action === 'assign') { to = b.value ? await activeUser(db, b.value) : null; if (to && !actor.has('leads.all') && to.id !== actor.id) throw E.forbidden('You can only assign to yourself', 'forbidden'); }
  const results = [];
  for (const id of ids) {
    try {
      const lead = await getLeadFor(ctx, id, { write: true });
      if (action === 'assign') await assignLead(ctx, lead, to);
      else if (action === 'status') await setStatusCore(ctx, lead, String(b.value || ''), b.lostReason);
      else await setClassCore(ctx, lead, b.value);
      results.push({ id, ok: true });
    } catch (e) { results.push({ id, ok: false, code: e.code || 'error', error: e.status ? e.message : 'failed' }); }
  }
  return { results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

// used by other modules
export { LEAD_SELECT, CONTACT_METHODS, checkedProducts, mergeIntoLead };
