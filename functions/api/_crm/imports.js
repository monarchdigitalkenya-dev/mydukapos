// functions/api/_crm/imports.js — staged CSV/spreadsheet import (NOT a route). The browser parses the file and stages rows (≤500 per call); the server
// validates, previews (counts, duplicates, invalid rows), then commits in ≤200-row batches per call. Duplicate policy skip|update|create (default skip);
// assignment none|one|csv|roundrobin|equal. Every row keeps its result; failed rows come back as an error CSV.
import { E, json, all, first, run, st, now, newId, text, phoneNorm, phoneDisplay, email as normEmail, oneOf, arr, jparse, jstr, auditSt, activitySt, notifySt, emitSt, dayLoose, dayStart, toCsv, csvResponse, changes, nairobiDay, placeholders } from './core.js';
import { createLeadCore, cleanContact, activeUser } from './leads.js';
import { attrFromInput } from './attribution.js';
import { readSettings } from './config.js';
import { notifyMany, managers } from './notify.js';

export const MAX_ROWS = 20000, MAX_STAGE = 500, BATCH = 200;
const FIELDS = ['name', 'phone', 'whatsapp', 'email', 'businessName', 'location', 'country', 'source', 'campaign', 'adset', 'ad', 'classification', 'status', 'product', 'assignedTo', 'estimatedValue', 'expectedCloseDate', 'createdDate', 'notes', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const ALIASES = {
  name: ['name', 'fullname', 'customername', 'contactname', 'leadname', 'contact'], phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'tel', 'telephone', 'cell', 'msisdn'],
  whatsapp: ['whatsapp', 'whatsappnumber', 'wa'], email: ['email', 'emailaddress', 'mail'], businessName: ['businessname', 'business', 'company', 'companyname', 'shop', 'shopname', 'organisation', 'organization'],
  location: ['location', 'town', 'city', 'area', 'address', 'county'], country: ['country'], source: ['source', 'leadsource', 'channel'], classification: ['classification', 'class', 'temperature', 'priority', 'rating'],
  status: ['status', 'stage'], product: ['product', 'products', 'interest', 'interestedin', 'productofinterest'], assignedTo: ['assignedto', 'assignedstaff', 'assignee', 'owner', 'staff', 'salesperson', 'agent'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks', 'message'], utm_source: ['utmsource'], utm_medium: ['utmmedium'], campaign: ['campaign', 'campaignname'], adset: ['adset', 'adsetname', 'adgroup', 'adgroupname'], ad: ['ad', 'adname', 'creative'],
  estimatedValue: ['estimatedvalue', 'dealvalue', 'value', 'amount', 'estimatedamount'], expectedCloseDate: ['expectedclosedate', 'expectedclose', 'closedate', 'expectedclosing'], createdDate: ['createddate', 'datecreated', 'created', 'createdat', 'date', 'leaddate'],
  utm_campaign: ['utmcampaign'], utm_content: ['utmcontent'], utm_term: ['utmterm'],
};
// the spec's template (section 20): these headers are what the mapping step recognises without any manual mapping
export const TEMPLATE_COLUMNS = ['Full Name', 'Phone', 'WhatsApp', 'Email', 'Company', 'Location', 'Source', 'Campaign', 'Ad Set', 'Ad', 'Product', 'Status', 'Classification', 'Assigned Staff', 'Estimated Value', 'Notes', 'Created Date'];
const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function cleanMapping(m) {
  const out = {};
  if (m && typeof m === 'object' && !Array.isArray(m)) for (const [k, v] of Object.entries(m)) { if (FIELDS.includes(k) && typeof v === 'string' && v.trim()) out[k] = v.slice(0, 200); }
  return out;
}
function pick(raw, mapping, field, flatKeys) {
  if (mapping[field] && Object.prototype.hasOwnProperty.call(raw, mapping[field])) return raw[mapping[field]];
  if (mapping[field]) return undefined;                                             // mapped to a column this row does not have
  for (const a of ALIASES[field]) if (flatKeys.has(a)) return raw[flatKeys.get(a)];
  return undefined;
}
const cell = (v) => (v == null ? null : typeof v === 'object' ? null : String(v).slice(0, 1000));

// Config lookups used to read a source / classification / status / product typed as a key OR a label
async function lookups(db) {
  const idx = async (t, extra = '') => { const m = new Map(); for (const r of await all(db, `SELECT key, label${extra} FROM ${t} WHERE active = 1`)) { m.set(flat(r.key), r); m.set(flat(r.label), r); } return m; };
  const products = new Map(); for (const r of await all(db, `SELECT id, key, label FROM crm_products WHERE active = 1`)) { products.set(flat(r.key), r); products.set(flat(r.label), r); }
  const users = new Map(); for (const u of await all(db, `SELECT id, name, email FROM crm_users WHERE status = 'active' AND archived = 0`)) { if (u.email) users.set(u.email.toLowerCase(), u); users.set('n:' + flat(u.name), u); }
  const named = async (t) => { const m = new Map(); for (const r of await all(db, `SELECT * FROM ${t}`)) { const k = flat(r.name); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  return { campaigns: await named('crm_campaigns'), adsets: await named('crm_adsets'), ads: await named('crm_ads'), sources: await idx('crm_sources'), classes: await idx('crm_classifications'), statuses: await idx('crm_statuses', ', is_won, is_lost'), products, users };
}

// -> { fields, sourceKey, classKey, statusKey, productIds, attr, assignedTo, warnings[], error }
export function readRow(raw, mapping, lk, defaultSource) {
  const flatKeys = new Map(Object.keys(raw).map((k) => [flat(k), k]));
  const g = (f) => cell(pick(raw, mapping, f, flatKeys));
  const { fields, errors } = cleanContact({ name: g('name'), phone: g('phone'), whatsapp: g('whatsapp'), email: g('email'), businessName: g('businessName'), location: g('location'), notes: g('notes'), country: g('country'), estimatedValue: g('estimatedValue'), expectedCloseDate: g('expectedCloseDate') });
  if (!fields.phone && !fields.whatsapp && !fields.email && !errors.phone && !errors.whatsapp && !errors.email) errors.contact = 'A phone number, WhatsApp number or email is required';
  const warnings = [];
  let createdAt = null;
  const cd = g('createdDate');
  if (cd) { const d = dayLoose(cd); if (d === false) warnings.push(`created date "${cd}" is not a date (import date used)`); else if (d && dayStart(d) > now()) warnings.push(`created date "${cd}" is in the future (import date used)`); else if (d) createdAt = dayStart(d); }
  let sourceKey = defaultSource, classKey = null, statusKey = null;
  const s = g('source'); if (s) { const m = lk.sources.get(flat(s)); if (m) sourceKey = m.key; else warnings.push(`unknown source "${s}" (used ${defaultSource})`); }
  const c = g('classification'); if (c) { const m = lk.classes.get(flat(c)); if (m) classKey = m.key; else warnings.push(`unknown classification "${c}" ignored`); }
  const stt = g('status'); if (stt) { const m = lk.statuses.get(flat(stt)); if (m && !m.is_won && !m.is_lost) statusKey = m.key; else warnings.push(`status "${stt}" ignored (only open statuses can be imported)`); }
  const productIds = [];
  const p = g('product'); if (p) for (const part of p.split(/[;,|]/).map((x) => x.trim()).filter(Boolean)) { const m = lk.products.get(flat(part)); if (m) productIds.push(m.id); else warnings.push(`unknown product "${part}" ignored`); }
  // campaign / ad set / ad are matched to EXISTING ones by name; a name that matches nothing is kept as the utm text (never invented as a new campaign)
  const ids = { campaignId: null, adsetId: null, adId: null };
  const cN = g('campaign'), sN = g('adset'), aN = g('ad');
  if (cN) { const l = lk.campaigns.get(flat(cN)) || []; if (l.length) ids.campaignId = l[0].id; }
  if (sN) { let l = lk.adsets.get(flat(sN)) || []; if (ids.campaignId) l = l.filter((x) => x.campaign_id === ids.campaignId); if (l.length === 1 || (l.length > 1 && ids.campaignId)) { ids.adsetId = l[0].id; ids.campaignId = ids.campaignId || l[0].campaign_id; } else if (l.length > 1) warnings.push(`ad set "${sN}" matches several campaigns (not linked)`); }
  if (aN) { let l = lk.ads.get(flat(aN)) || []; if (ids.adsetId) l = l.filter((x) => x.adset_id === ids.adsetId); else if (ids.campaignId) l = l.filter((x) => x.campaign_id === ids.campaignId); if (l.length === 1) { ids.adId = l[0].id; ids.adsetId = ids.adsetId || l[0].adset_id; ids.campaignId = ids.campaignId || l[0].campaign_id; } else if (l.length > 1) warnings.push(`ad "${aN}" is ambiguous (not linked)`); }
  for (const [nm, val, key] of [['campaign', cN, 'campaignId'], ['ad set', sN, 'adsetId'], ['ad', aN, 'adId']]) if (val && !ids[key]) warnings.push(`${nm} "${val}" is not a known ${nm} (kept as text only)`);
  const attr = attrFromInput({ utm_source: g('utm_source'), utm_medium: g('utm_medium'), utm_campaign: g('utm_campaign') || (cN && !ids.campaignId ? cN : null), utm_content: g('utm_content') || (aN && !ids.adId ? aN : null), utm_term: g('utm_term') });
  const error = Object.keys(errors).length ? Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('; ') : null;
  return { fields, errors, sourceKey, classKey, statusKey, productIds: [...new Set(productIds)], attr, ids: ids.campaignId || ids.adsetId || ids.adId ? ids : null, createdAt, assignedTo: g('assignedTo'), warnings, error };
}

// ---------- duplicate index (chunks of 30 keys per list: D1 allows 100 bound values per statement) ----------
async function dupIndex(db, parsed) {
  const idx = { phone: new Map(), email: new Map() };            // phone covers phone_norm AND whatsapp_norm
  const nums = new Set(), mails = new Set();
  for (const p of parsed) { if (p.error) continue; [p.fields.phone_norm, p.fields.whatsapp_norm].forEach((n) => n && nums.add(n)); if (p.fields.email) mails.add(p.fields.email); }
  const N = [...nums], M = [...mails];
  const chunk = (a, i) => a.slice(i, i + 30);
  const run1 = async (ns, ms) => {
    const w = [], a = [];
    if (ns.length) { w.push(`phone_norm IN (${placeholders(ns.length)})`, `whatsapp_norm IN (${placeholders(ns.length)})`); a.push(...ns, ...ns); }
    if (ms.length) { w.push(`email IN (${placeholders(ms.length)})`); a.push(...ms); }
    if (!w.length) return;
    for (const r of await all(db, `SELECT id, phone_norm, whatsapp_norm, email FROM crm_leads WHERE deleted_at IS NULL AND (${w.join(' OR ')}) ORDER BY created_at`, ...a)) indexLead(idx, r);
  };
  for (let i = 0; i < N.length; i += 30) await run1(chunk(N, i), []);
  for (let i = 0; i < M.length; i += 30) await run1([], chunk(M, i));
  return idx;
}
const indexLead = (idx, r) => { for (const n of [r.phone_norm, r.whatsapp_norm]) if (n && !idx.phone.has(n)) idx.phone.set(n, r.id); if (r.email && !idx.email.has(r.email)) idx.email.set(r.email, r.id); };
const dupOf = (idx, f) => idx.phone.get(f.phone_norm) || idx.phone.get(f.whatsapp_norm) || (f.email ? idx.email.get(f.email) : null) || null;

// ---------- staging ----------
async function importFor(ctx, id, { own = true } = {}) {
  const { db, actor } = ctx;
  const imp = typeof id === 'string' ? await first(db, `SELECT * FROM crm_imports WHERE id = ?`, id) : null;
  if (!imp || (own && !actor.has('leads.all') && imp.created_by !== actor.id)) throw E.notFound('Import not found', 'import_not_found');
  return imp;
}
const impOut = (i) => ({ id: i.id, fileName: i.file_name, source: i.source, status: i.status, total: i.total, processed: i.processed, created: i.created_count, updated: i.updated_count, skipped: i.skipped_count, failed: i.failed_count, warnings: i.warning_count, options: jparse(i.options, {}), mapping: jparse(i.mapping, {}), createdBy: i.created_by, createdByName: i.created_by_name, uploadedBy: i.created_by_name, createdAt: i.created_at, updatedAt: i.finished_at || i.created_at, finishedAt: i.finished_at,
  assignment: (() => { const a = (jparse(i.options, {}) || {}).assign || {}; return { mode: a.mode || 'none', userIds: a.userIds || [] }; })() });

export async function createImport(ctx) {
  const { db, actor } = ctx; actor.require('leads.import');
  const b = await ctx.json();
  const settings = await readSettings(db);
  const o = b.options && typeof b.options === 'object' ? b.options : {};
  const duplicates = o.duplicates == null ? settings.defaultDuplicatePolicy : oneOf(String(o.duplicates), ['skip', 'update', 'create'], 'duplicates');
  const a = o.assign && typeof o.assign === 'object' ? o.assign : {};
  const mode = a.mode == null ? 'none' : oneOf(String(a.mode), ['none', 'one', 'csv', 'roundrobin', 'equal'], 'assign');
  const userIds = [...new Set(arr(a.userIds, 100).map(String))];
  if (mode !== 'none' && !(mode === 'one' && userIds.length === 1 && userIds[0] === actor.id)) actor.require('leads.assign');
  if (['one'].includes(mode) && userIds.length !== 1) throw E.bad('Choose exactly one person to assign to', 'invalid_assign');
  if (['roundrobin', 'equal'].includes(mode) && userIds.length < 1) throw E.bad('Choose the people to share the leads between', 'invalid_assign');
  for (const id of userIds) await activeUser(db, id);
  const source = b.source ? String(b.source) : 'import';
  if (!(await first(db, `SELECT 1 x FROM crm_sources WHERE key = ? AND active = 1`, source))) throw E.bad('Unknown source', 'invalid_source');
  const t = now(), id = newId();
  const options = { duplicates, assign: { mode, userIds: mode === 'none' || mode === 'csv' ? userIds : userIds } };
  await db.batch([
    st(db, `INSERT INTO crm_imports (id, file_name, source, mapping, options, status, created_by, created_by_name, created_at) VALUES (?,?,?,?,?,'staged',?,?,?)`, id, text(b.fileName, 200), source, jstr(cleanMapping(b.mapping)), jstr(options), actor.id, actor.name, t),
    auditSt(db, actor, 'import_create', 'import', id, null, { fileName: text(b.fileName, 200), options }, t),
  ]);
  return json({ id }, 201);
}
export async function stageRows(ctx) {
  const { db, actor } = ctx; actor.require('leads.import');
  const imp = await importFor(ctx, ctx.params.id);
  if (imp.status !== 'staged') throw E.conflict('This import has already started', 'import_started');
  const b = await ctx.json();
  const rows = arr(b.rows, MAX_STAGE + 1);
  if (!rows.length) throw E.bad('rows is required', 'invalid_rows');
  if (rows.length > MAX_STAGE) throw E.bad(`At most ${MAX_STAGE} rows per call`, 'too_many_rows');
  if (imp.total + rows.length > MAX_ROWS) throw E.bad(`An import can have at most ${MAX_ROWS} rows`, 'too_many_rows');
  const stmts = [];
  rows.forEach((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw E.bad('each row must be an object', 'invalid_rows');
    const keys = Object.keys(r).slice(0, 60), clean = {};
    for (const k of keys) clean[k.slice(0, 100)] = cell(r[k]);
    // row_no is taken INSIDE the statement (in the transaction), and only while the import is still staged: two stagers at once cannot collide or slip rows in after the commit started
    stmts.push(st(db, `INSERT INTO crm_import_rows (import_id, row_no, data) SELECT ?, COALESCE((SELECT MAX(row_no) FROM crm_import_rows WHERE import_id = ?), 0) + 1, ? WHERE EXISTS (SELECT 1 FROM crm_imports WHERE id = ? AND status = 'staged')`, imp.id, imp.id, JSON.stringify(clean), imp.id));
  });
  stmts.push(st(db, `UPDATE crm_imports SET total = (SELECT COUNT(*) FROM crm_import_rows WHERE import_id = ?) WHERE id = ? AND status = 'staged'`, imp.id, imp.id));
  await db.batch(stmts);
  const after = await first(db, `SELECT total, status FROM crm_imports WHERE id = ?`, imp.id);
  if (after.status !== 'staged') throw E.conflict('This import has already started', 'import_started');
  return { staged: rows.length, total: after.total };
}

// ---------- analysis (preview + error CSV) ----------
async function analyse(ctx, imp, { statuses = ['pending'], limit = MAX_ROWS } = {}) {
  const { db } = ctx;
  const opts = jparse(imp.options, {}), mapping = jparse(imp.mapping, {});
  const lk = await lookups(db);
  const rows = await all(db, `SELECT * FROM crm_import_rows WHERE import_id = ? AND status IN (${placeholders(statuses.length)}) ORDER BY row_no LIMIT ?`, imp.id, ...statuses, limit);
  const parsed = rows.map((r) => ({ row: r, raw: jparse(r.data, {}), ...readRow(jparse(r.data, {}), mapping, lk, imp.source || 'import') }));
  const idx = await dupIndex(db, parsed);
  const inFile = { phone: new Map(), email: new Map() };
  for (const p of parsed) {
    p.kind = 'valid';
    if (p.error) { p.kind = 'invalid'; continue; }
    const ex = dupOf(idx, p.fields);
    const seen = dupOf(inFile, p.fields);
    if (ex) { p.kind = 'duplicate_existing'; p.duplicateOf = ex; }
    else if (seen != null) { p.kind = 'duplicate_in_file'; p.duplicateOf = seen; }
    for (const n of [p.fields.phone_norm, p.fields.whatsapp_norm]) if (n && !inFile.phone.has(n)) inFile.phone.set(n, p.row.row_no);
    if (p.fields.email && !inFile.email.has(p.fields.email)) inFile.email.set(p.fields.email, p.row.row_no);
  }
  return { parsed, opts, lk };
}
export async function previewImport(ctx) {
  const { db, actor } = ctx; actor.require('leads.import');
  const imp = await importFor(ctx, ctx.params.id);
  const { parsed, opts, lk } = await analyse(ctx, imp, { statuses: ['pending', 'processing'] });
  const pol = opts.duplicates || 'skip';
  const c = { total: parsed.length, valid: 0, invalid: 0, duplicateExisting: 0, duplicateInFile: 0 };
  const bad = { missingName: 0, missingContact: 0, invalidPhone: 0, invalidEmail: 0 };
  for (const p of parsed) if (p.error) { if (p.errors.name) bad.missingName++; if (p.errors.contact) bad.missingContact++; if (p.errors.phone || p.errors.whatsapp) bad.invalidPhone++; if (p.errors.email) bad.invalidEmail++; }
  let warnings = 0;
  for (const p of parsed) { if (p.kind === 'valid') c.valid++; else if (p.kind === 'invalid') c.invalid++; else if (p.kind === 'duplicate_existing') c.duplicateExisting++; else c.duplicateInFile++; if (p.warnings.length) warnings++; }
  const dups = c.duplicateExisting + c.duplicateInFile;
  const willCreate = c.valid + (pol === 'create' ? dups : 0);
  const assignMode = (opts.assign || {}).mode || 'none';
  const users = [...new Map([...lk.users.values()].map((u) => [u.id, u])).values()];
  const csvUnmatched = assignMode === 'csv' ? parsed.filter((p) => p.kind !== 'invalid' && p.assignedTo && !lk.users.get(String(p.assignedTo).toLowerCase()) && !lk.users.get('n:' + flat(p.assignedTo))).length : null;
  return {
    id: imp.id, status: imp.status, options: opts, fileName: imp.file_name,
    counts: { ...c, ...bad, duplicates: dups, willCreate, willUpdate: pol === 'update' ? dups : 0, willSkip: pol === 'skip' ? dups : 0, warnings },
    assignment: { mode: assignMode, userIds: (opts.assign || {}).userIds || [], unmatchedAssignees: csvUnmatched, activeStaff: users.length },
    issues: parsed.filter((p) => p.kind !== 'valid' || p.warnings.length).slice(0, 50).map((p) => ({ rowNo: p.row.row_no, kind: p.kind, message: p.error || (p.kind === 'valid' ? p.warnings.join('; ') : p.kind === 'duplicate_existing' ? 'Already in the CRM' : `Same as row ${p.duplicateOf} in this file`), duplicateOf: p.kind === 'duplicate_existing' ? p.duplicateOf : undefined })),
    sample: parsed.slice(0, 10).map((p) => ({ rowNo: p.row.row_no, name: p.fields.name, phone: p.fields.phone, whatsapp: p.fields.whatsapp, email: p.fields.email, kind: p.kind })),
  };
}

// ---------- commit ----------
export async function commitImport(ctx) {
  const { db, actor } = ctx; actor.require('leads.import');
  let imp = await importFor(ctx, ctx.params.id);
  if (imp.status === 'done') return { done: true, processed: imp.processed, total: imp.total, ...counters(imp) };
  if (!imp.total) throw E.bad('There are no rows to import', 'no_rows');
  const t0 = now();
  if (await first(db, `SELECT 1 x FROM crm_import_rows WHERE import_id = ? AND status = 'processing' AND claimed_at > ? LIMIT 1`, imp.id, t0 - 60000)) throw E.conflict('This import is already being processed, wait a moment', 'commit_in_progress');
  const token = newId();
  const claim = await st(db, `UPDATE crm_import_rows SET status = 'processing', claim = ?, claimed_at = ? WHERE id IN (SELECT id FROM crm_import_rows WHERE import_id = ? AND (status = 'pending' OR status = 'processing') ORDER BY row_no LIMIT ?)`, token, t0, imp.id, BATCH).run();
  if (imp.status === 'staged') await run(db, `UPDATE crm_imports SET status = 'committing' WHERE id = ? AND status = 'staged'`, imp.id);
  const opts = jparse(imp.options, {}), mapping = jparse(imp.mapping, {}), pol = opts.duplicates || 'skip';
  const assign = opts.assign || { mode: 'none', userIds: [] };
  const lk = await lookups(db);
  const rows = await all(db, `SELECT * FROM crm_import_rows WHERE import_id = ? AND claim = ? AND status = 'processing' ORDER BY row_no`, imp.id, token);
  const parsed = rows.map((r) => ({ row: r, ...readRow(jparse(r.data, {}), mapping, lk, imp.source || 'import') }));
  const idx = await dupIndex(db, parsed);
  // assignment pool
  const pool = [];
  for (const id of assign.userIds || []) { const u = await first(db, `SELECT * FROM crm_users WHERE id = ? AND status = 'active' AND archived = 0`, id); if (u) pool.push(u); }
  const given = new Map((await all(db, `SELECT assigned_to k, COUNT(*) n FROM crm_import_rows WHERE import_id = ? AND assigned_to IS NOT NULL GROUP BY assigned_to`, imp.id)).map((x) => [x.k, x.n]));
  const load = new Map();
  if (assign.mode === 'equal') for (const u of pool) load.set(u.id, ((await first(db, `SELECT COUNT(*) n FROM crm_leads l WHERE l.owner_id = ? AND l.deleted_at IS NULL AND l.status_key NOT IN (SELECT key FROM crm_statuses WHERE is_won = 1 OR is_lost = 1)`, u.id)).n));
  let rrCount = [...given.values()].reduce((a, b) => a + b, 0);
  const nextOwner = (p) => {
    if (assign.mode === 'one') return pool[0] || null;
    if (assign.mode === 'csv') { const a = p.assignedTo; return a ? (lk.users.get(String(a).toLowerCase()) ? pool0(lk.users.get(String(a).toLowerCase())) : lk.users.get('n:' + flat(a)) ? pool0(lk.users.get('n:' + flat(a))) : null) : null; }
    if (assign.mode === 'roundrobin') { if (!pool.length) return null; return pool[rrCount++ % pool.length]; }
    if (assign.mode === 'equal') { if (!pool.length) return null; let best = pool[0]; for (const u of pool) if (load.get(u.id) < load.get(best.id)) best = u; load.set(best.id, load.get(best.id) + 1); return best; }
    return null;
  };
  const pool0 = (u) => u;
  const results = [], perUser = new Map();
  for (const p of parsed) {
    const res = { id: p.row.id, status: 'error', error: null, warning: p.warnings.join('; ') || null, lead: null, dup: null, assigned: null };
    try {
      if (p.error) { res.status = 'error'; res.error = p.error; }
      else {
        const dupId = dupOf(idx, p.fields);
        if (dupId && pol === 'skip') { res.status = 'skipped'; res.dup = dupId; }
        else if (dupId && pol === 'update') {
          if (await updateExisting(db, actor, dupId, p, imp)) { res.status = 'updated'; res.lead = dupId; res.dup = dupId; }
          else { res.status = 'skipped'; res.dup = dupId; res.warning = [res.warning, 'the matching lead belongs to someone else, not updated'].filter(Boolean).join('; '); }
        }
        else {
          let owner = nextOwner(p);
          if (assign.mode === 'csv' && p.assignedTo && !owner) res.warning = [res.warning, `assignee "${p.assignedTo}" not found, left unassigned`].filter(Boolean).join('; ');
          const lead = await createLeadCore(db, actor, { fields: p.fields, attr: p.attr, sourceKey: p.sourceKey, classKey: p.classKey, statusKey: p.statusKey, productIds: p.productIds, owner }, { ids: p.ids || undefined, at: p.createdAt || undefined, importId: imp.id, ownerKind: 'import', silent: true, auditAction: 'lead_import', activityText: `Imported from ${imp.file_name || 'a file'}` });
          indexLead(idx, lead);
          res.status = 'created'; res.lead = lead.id; if (dupId) { res.dup = dupId; res.warning = [res.warning, 'duplicate created as a separate lead'].filter(Boolean).join('; '); }
          if (owner) { res.assigned = owner.id; perUser.set(owner.id, (perUser.get(owner.id) || 0) + 1); }
        }
      }
    } catch (e) { res.status = 'error'; res.error = 'Could not save this row: ' + String(e && e.message || e).slice(0, 150); }
    results.push(res);
  }
  const stmts = results.map((r) => st(db, `UPDATE crm_import_rows SET status = ?, error = ?, warning = ?, lead_id = ?, duplicate_of = ?, assigned_to = ?, claim = NULL WHERE id = ?`, r.status, r.error, r.warning, r.lead, r.dup, r.assigned, r.id));
  stmts.push(st(db, `UPDATE crm_imports SET processed = (SELECT COUNT(*) FROM crm_import_rows WHERE import_id = ? AND status NOT IN ('pending','processing')),
      created_count = (SELECT COUNT(*) FROM crm_import_rows WHERE import_id = ? AND status = 'created'), updated_count = (SELECT COUNT(*) FROM crm_import_rows WHERE import_id = ? AND status = 'updated'),
      skipped_count = (SELECT COUNT(*) FROM crm_import_rows WHERE import_id = ? AND status = 'skipped'), failed_count = (SELECT COUNT(*) FROM crm_import_rows WHERE import_id = ? AND status = 'error'),
      warning_count = (SELECT COUNT(*) FROM crm_import_rows WHERE import_id = ? AND warning IS NOT NULL) WHERE id = ?`, imp.id, imp.id, imp.id, imp.id, imp.id, imp.id, imp.id));
  const t = now();
  for (const [uid, n] of perUser) if (uid !== actor.id) stmts.push(notifySt(db, uid, 'assigned', `${n} lead${n === 1 ? '' : 's'} assigned to you from an import`, imp.file_name, { entity: 'import', entityId: imp.id, dedupe: `import:${imp.id}:${uid}:${token}`, at: t }));
  await db.batch(stmts);
  const pending = (await first(db, `SELECT COUNT(*) n FROM crm_import_rows WHERE import_id = ? AND status IN ('pending','processing')`, imp.id)).n;
  imp = await first(db, `SELECT * FROM crm_imports WHERE id = ?`, imp.id);
  if (!pending) {
    const fin = await st(db, `UPDATE crm_imports SET status = 'done', finished_at = ? WHERE id = ? AND status != 'done'`, now(), imp.id).run();
    if (changes(fin) === 1) {
      imp = await first(db, `SELECT * FROM crm_imports WHERE id = ?`, imp.id);
      await db.batch([
        auditSt(db, actor, 'import_finish', 'import', imp.id, null, counters(imp)),
        emitSt(db, actor, 'import.finished', { entity: 'import', entityId: imp.id, data: counters(imp) }),
        ...notifyMany(db, [...await managers(db, null), actor], null, 'new_lead', `Import finished: ${imp.created_count} new lead${imp.created_count === 1 ? '' : 's'}`, `${imp.file_name || 'import'} · ${imp.updated_count} updated · ${imp.skipped_count} skipped · ${imp.failed_count} failed`, { entity: 'import', entityId: imp.id, dedupe: 'import-done:' + imp.id }),
      ]);
    }
  }
  return { done: !pending, processed: imp.processed, total: imp.total, batch: results.length, ...counters(imp) };
}
const counters = (i) => ({ created: i.created_count, updated: i.updated_count, skipped: i.skipped_count, failed: i.failed_count, warnings: i.warning_count });

async function updateExisting(db, actor, leadId, p, imp) {
  const lead = await first(db, `SELECT * FROM crm_leads WHERE id = ? AND deleted_at IS NULL`, leadId);
  if (!lead) throw new Error('the matching lead no longer exists');
  // an import may only change leads the importer could change by hand: theirs, the unassigned pool, or anything for a manager
  if (!actor.has('leads.all') && lead.owner_id && lead.owner_id !== actor.id) return false;
  const f = p.fields, set = {}, prev = {}, t = now();
  for (const c of ['phone', 'whatsapp', 'email', 'business_name', 'location']) if (f[c] && f[c] !== lead[c]) { set[c] = f[c]; prev[c] = lead[c]; if (c === 'phone' || c === 'whatsapp') set[c + '_norm'] = f[c + '_norm']; }
  if (f.name && f.name !== lead.name) { set.name = f.name; prev.name = lead.name; }
  if (p.classKey && p.classKey !== lead.class_key) { set.class_key = p.classKey; prev.class_key = lead.class_key; }
  for (const [c, v] of [['country', f.country], ['estimated_value', f.estimated_value], ['expected_close_date', f.expected_close_date]]) if (v != null && v !== '' && (lead[c] == null || lead[c] === '') ) { set[c] = v; prev[c] = lead[c] ?? null; }
  if (f.notes && !(lead.notes || '').includes(f.notes)) { set.notes = ((lead.notes ? lead.notes + '\n' : '') + f.notes).slice(0, 4000); prev.notes = lead.notes; }
  const cols = Object.keys(set);
  const stmts = [];
  if (cols.length) stmts.push(st(db, `UPDATE crm_leads SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ?, last_activity_at = ? WHERE id = ?`, ...cols.map((c) => set[c]), t, t, leadId));
  for (const pid of p.productIds) stmts.push(st(db, `INSERT OR IGNORE INTO crm_lead_products (lead_id, product_id, added_at, added_by) VALUES (?,?,?,?)`, leadId, pid, t, actor.id));
  stmts.push(activitySt(db, actor, leadId, 'import', `Updated from import ${imp.file_name || ''}${cols.length ? ': ' + cols.filter((c) => !c.endsWith('_norm')).join(', ') : ' (nothing new)'}`, { importId: imp.id }, t));
  stmts.push(auditSt(db, actor, 'lead_import_update', 'lead', leadId, prev, set, t));
  await db.batch(stmts);
  return true;
}

// ---------- results ----------
export async function getImport(ctx) {
  const { db, actor, query } = ctx; actor.require('leads.import');
  const imp = await importFor(ctx, ctx.params.id);
  const out = { import: impOut(imp) };
  out.assignments = (await all(db, `SELECT r.assigned_to id, u.name, COUNT(*) n FROM crm_import_rows r LEFT JOIN crm_users u ON u.id = r.assigned_to WHERE r.import_id = ? AND r.assigned_to IS NOT NULL GROUP BY r.assigned_to ORDER BY n DESC`, imp.id)).map((x) => ({ userId: x.id, name: x.name, leads: x.n }));
  if (query.get('rows')) {
    const s = query.get('rows'); const status = ['created', 'updated', 'skipped', 'error', 'pending'].includes(s) ? s : null;
    const pageSize = Math.min(100, Math.max(1, parseInt(query.get('pageSize'), 10) || 50)), page = Math.max(1, parseInt(query.get('page'), 10) || 1);
    const rows = await all(db, `SELECT row_no, status, error, warning, lead_id, duplicate_of, assigned_to, data FROM crm_import_rows WHERE import_id = ?${status ? ' AND status = ?' : ''} ORDER BY row_no LIMIT ? OFFSET ?`, imp.id, ...(status ? [status] : []), pageSize, (page - 1) * pageSize);
    out.rows = rows.map((r) => ({ rowNo: r.row_no, status: r.status, error: r.error, warning: r.warning, leadId: r.lead_id, duplicateOf: r.duplicate_of, assignedTo: r.assigned_to, data: jparse(r.data, {}) }));
  }
  return out;
}
export async function listImports(ctx) {
  const { db, actor } = ctx; actor.require('leads.import');
  const rows = await all(db, `SELECT * FROM crm_imports ${actor.has('leads.all') ? '' : 'WHERE created_by = ?'} ORDER BY created_at DESC LIMIT 200`, ...(actor.has('leads.all') ? [] : [actor.id]));
  return { items: rows.map(impOut) };
}
export async function errorsCsv(ctx) {
  const { db, actor } = ctx; actor.require('leads.import');
  const imp = await importFor(ctx, ctx.params.id);
  const bad = await all(db, `SELECT row_no, error, data FROM crm_import_rows WHERE import_id = ? AND status = 'error' ORDER BY row_no LIMIT 20000`, imp.id);
  const list = bad.map((r) => ({ row: r.row_no, error: r.error, data: jparse(r.data, {}) }));
  if (imp.status !== 'done') {                                 // not committed yet: rows that would fail
    const { parsed } = await analyse(ctx, imp);
    for (const p of parsed) if (p.error) list.push({ row: p.row.row_no, error: p.error, data: p.raw });
    list.sort((a, b) => a.row - b.row);
  }
  const keys = []; for (const r of list) for (const k of Object.keys(r.data)) if (!keys.includes(k)) keys.push(k);
  const cols = ['row', 'error', ...keys];
  return csvResponse(toCsv(cols, list.map((r) => ({ row: r.row, error: r.error, ...r.data }))), `import-errors-${nairobiDay()}.csv`);
}
export async function templateCsv(ctx) {
  ctx.actor.require('leads.import');
  return csvResponse(toCsv(TEMPLATE_COLUMNS, []), 'leads-import-template.csv');
}
