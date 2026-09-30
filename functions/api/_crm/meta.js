// functions/api/_crm/meta.js — Meta Lead Ads (NOT a route). The webhook only carries a lead id; the lead's fields come from the Graph API, which needs
// META_PAGE_TOKEN. Without the token the event is stored as an UNRESOLVED attribution event (kept, visible, retryable) — nothing is invented.
import { E, all, first, st, now, text, phoneNorm, phoneDisplay, jparse, jstr, auditSt } from './core.js';
import { cleanContact, createLeadCore, recordTouch, findDuplicates } from './leads.js';
import { attrFromInput, eventSt } from './attribution.js';
import { notifyMany, managers } from './notify.js';

const graphBase = (env) => `https://graph.facebook.com/${env.META_GRAPH_VERSION || 'v19.0'}`;
const FIELDS = 'created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,field_data,platform,is_organic';

async function fetchLead(env, leadgenId) {
  const r = await fetch(`${graphBase(env)}/${encodeURIComponent(leadgenId)}?fields=${FIELDS}`, { headers: { Authorization: 'Bearer ' + env.META_PAGE_TOKEN } });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || data.error) throw new Error('Graph API: ' + String(data && data.error && data.error.message || r.status).slice(0, 200));
  return data;
}
const fd = (data) => { const m = {}; for (const f of data.field_data || []) if (f && f.name) m[String(f.name).toLowerCase()] = Array.isArray(f.values) ? f.values.join(' ').trim() : String(f.values || ''); return m; };

// value = a `leadgen` change from the webhook: { leadgen_id, ad_id, form_id, page_id, created_time }. -> 'created' | 'touched' | 'unresolved' | 'duplicate'
export async function processLeadgen(env, db, value, { retry = false } = {}) {
  const id = String(value && value.leadgen_id || '');
  if (!id) return 'ignored';
  const ext = 'leadgen:' + id;
  const seen = await first(db, `SELECT id, resolved FROM crm_attribution_events WHERE external_id = ?`, ext);
  if (seen && (seen.resolved || !retry)) return 'duplicate';
  const t = now();
  const park = async (reason) => {
    const raw = { ...value, error: reason };
    if (seen) await st(db, `UPDATE crm_attribution_events SET raw = ? WHERE id = ?`, jstr(raw), seen.id).run();
    else {
      const attr = { ...attrFromInput({}), ext_ad_id: text(value.ad_id, 80) };
      await db.batch([eventSt(db, null, 'meta_lead', 'meta_ads', attr, null, { externalId: ext, resolved: false, raw, at: t }),
        ...notifyMany(db, await managers(db, null), null, 'new_lead', 'Meta lead waiting to be resolved', reason, { entity: 'attribution', entityId: id, dedupe: 'meta-unresolved:' + id, at: t })]);
    }
    return 'unresolved';
  };
  if (!env.META_PAGE_TOKEN) return park('META_PAGE_TOKEN is not set, so the lead details could not be fetched from Meta.');
  let data;
  try { data = await fetchLead(env, id); } catch (e) { return park(String(e.message || e)); }
  const f = fd(data);
  const name = f.full_name || [f.first_name, f.last_name].filter(Boolean).join(' ') || f.name || '';
  const { fields, errors } = cleanContact({ name, phone: f.phone_number || f.phone || f.phone_number_1, email: f.email, businessName: f.company_name || f.business_name, location: f.city || f.location || f.state, whatsapp: f.whatsapp_number || f.whatsapp }, { requireName: false });
  if (Object.keys(errors).length || (!fields.phone && !fields.whatsapp && !fields.email)) return park('The Meta form has no usable phone number or email: ' + (Object.values(errors).join('; ') || 'no contact fields'));
  const attr = { ...attrFromInput({}), ext_campaign_id: text(data.campaign_id, 80), ext_adset_id: text(data.adset_id, 80), ext_ad_id: text(data.ad_id || value.ad_id, 80), campaign_name: text(data.campaign_name, 120), adset_name: text(data.adset_name, 120), ad_name: text(data.ad_name, 120) };
  const at = Number.isFinite(Date.parse(data.created_time)) ? Date.parse(data.created_time) : t;
  const dups = await findDuplicates(db, fields);
  let result;
  if (dups.length) { await recordTouch(db, dups[0].row, { attr, kind: 'meta_lead', sourceKey: 'meta_ads', at, createEntities: true, summary: 'Filled in a Meta lead form again', externalId: seen ? null : ext, skipEvent: !!seen }); result = 'touched'; }
  else { await createLeadCore(db, null, { fields, attr, sourceKey: 'meta_ads' }, { at, createEntities: true, attrKind: 'meta_lead', eventExternalId: seen ? null : ext, skipEvent: !!seen, activityText: `Lead from a Meta lead form${data.campaign_name ? ` (${data.campaign_name})` : ''}`, auditAction: 'lead_create_meta', createdByName: 'Meta Lead Ads' }); result = 'created'; }
  if (seen) await st(db, `UPDATE crm_attribution_events SET resolved = 1, lead_id = COALESCE(lead_id, (SELECT id FROM crm_leads WHERE phone_norm = ? OR whatsapp_norm = ? OR email = ? ORDER BY created_at DESC LIMIT 1)) WHERE id = ?`, fields.phone_norm, fields.whatsapp_norm, fields.email, seen.id).run();
  return result;
}

export async function resolveUnresolved(ctx) {
  const { db, env, actor } = ctx; actor.require('settings.integrations');
  if (!env.META_PAGE_TOKEN) throw E.conflict('META_PAGE_TOKEN is not set on this server', 'meta_not_configured');
  const rows = await all(db, `SELECT raw FROM crm_attribution_events WHERE resolved = 0 AND kind = 'meta_lead' AND external_id LIKE 'leadgen:%' ORDER BY at LIMIT 25`);
  const out = { created: 0, touched: 0, unresolved: 0, duplicate: 0, ignored: 0 };
  for (const r of rows) { const v = jparse(r.raw, {}); out[await processLeadgen(env, db, v, { retry: true })]++; }
  await db.batch([auditSt(db, actor, 'meta_resolve', 'integration', 'meta', null, out)]);
  const left = (await first(db, `SELECT COUNT(*) n FROM crm_attribution_events WHERE resolved = 0`)).n;
  return { ...out, stillUnresolved: left };
}
