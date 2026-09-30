// functions/api/_crm/attribution.js — where a lead came from (NOT a route). Every touch is kept in crm_attribution_events; the lead's first_* fields
// are written ONCE (at creation) and never overwritten. Fields the source did not provide stay NULL — nothing is guessed.
import { all, first, run, st, now, newId, text, jstr } from './core.js';

// -> plain object of the attribution fields present in `raw` (a form body, an import row ...)
export function attrFromInput(raw = {}) {
  const g = (...ks) => { for (const k of ks) { const v = text(raw[k], 300); if (v) return v; } return null; };
  return {
    utm_source: g('utm_source', 'utmSource'), utm_medium: g('utm_medium', 'utmMedium'), utm_campaign: g('utm_campaign', 'utmCampaign'),
    utm_content: g('utm_content', 'utmContent'), utm_term: g('utm_term', 'utmTerm'),
    referrer: g('referrer'), landing_url: g('landing_url', 'landingUrl', 'page_url', 'pageUrl'), click_id: g('click_id', 'clickId', 'fbclid', 'gclid', 'ctwa_clid'),
    ext_campaign_id: g('ext_campaign_id', 'extCampaignId'), ext_adset_id: g('ext_adset_id', 'extAdsetId'), ext_ad_id: g('ext_ad_id', 'extAdId'),
    campaign_name: g('campaign_name', 'campaignName'), adset_name: g('adset_name', 'adsetName'), ad_name: g('ad_name', 'adName'), headline: g('headline'),
  };
}
export const hasAttr = (a) => !!a && Object.values(a).some((v) => v != null);

const ensureRow = async (db, table, where, args, cols, vals) => {
  let r = await first(db, `SELECT id FROM ${table} WHERE ${where}`, ...args);
  if (r) return r.id;
  const id = newId(); const t = now();
  await run(db, `INSERT OR IGNORE INTO ${table} (id, ${cols.join(',')}, created_at, updated_at) VALUES (?, ${cols.map(() => '?').join(',')}, ?, ?)`, id, ...vals, t, t);
  r = await first(db, `SELECT id FROM ${table} WHERE ${where}`, ...args);
  return r ? r.id : null;
};
// Ties an attribution to the campaign / ad set / ad rows. Rows are created only from ids a platform really sent (`create`); a website UTM is only
// MATCHED to an existing campaign (by external id or name), never turned into an invented campaign.
export async function resolveEntities(db, a, { create = false, platform = 'meta', sourceKey = 'meta_ads' } = {}) {
  const out = { campaignId: null, adsetId: null, adId: null };
  if (!a) return out;
  const extC = a.ext_campaign_id, extS = a.ext_adset_id, extA = a.ext_ad_id;
  if (extC) {
    const r = await first(db, `SELECT id FROM crm_campaigns WHERE platform = ? AND external_id = ?`, platform, extC);
    out.campaignId = r ? r.id : create ? await ensureRow(db, 'crm_campaigns', 'platform = ? AND external_id = ?', [platform, extC], ['name', 'platform', 'source_key', 'external_id'], [a.campaign_name || 'Campaign ' + extC, platform, sourceKey, extC]) : null;
  } else if (a.utm_campaign) {
    const r = await first(db, `SELECT id FROM crm_campaigns WHERE external_id = ? OR lower(name) = lower(?) ORDER BY created_at LIMIT 1`, a.utm_campaign, a.utm_campaign);
    out.campaignId = r ? r.id : null;
  }
  if (extS) {
    const r = await first(db, `SELECT id, campaign_id FROM crm_adsets WHERE external_id = ?`, extS);
    if (r) { out.adsetId = r.id; out.campaignId = out.campaignId || r.campaign_id; }
    else if (create && out.campaignId) out.adsetId = await ensureRow(db, 'crm_adsets', 'external_id = ?', [extS], ['campaign_id', 'name', 'external_id'], [out.campaignId, a.adset_name || 'Ad set ' + extS, extS]);
  }
  if (extA) {
    const r = await first(db, `SELECT id, adset_id, campaign_id FROM crm_ads WHERE external_id = ?`, extA);
    if (r) { out.adId = r.id; out.adsetId = out.adsetId || r.adset_id; out.campaignId = out.campaignId || r.campaign_id; }
    else if (create) {
      out.adId = await ensureRow(db, 'crm_ads', 'external_id = ?', [extA], ['adset_id', 'campaign_id', 'name', 'external_id', 'headline'], [out.adsetId, out.campaignId, a.ad_name || a.headline || 'Ad ' + extA, extA, a.headline || null]);
    }
  } else if (a.utm_content && out.campaignId) {
    const r = await first(db, `SELECT id, adset_id FROM crm_ads WHERE campaign_id = ? AND (external_id = ? OR lower(name) = lower(?)) LIMIT 1`, out.campaignId, a.utm_content, a.utm_content);
    if (r) { out.adId = r.id; out.adsetId = out.adsetId || r.adset_id; }
  }
  return out;
}
// statement that records one touch
export const eventSt = (db, leadId, kind, sourceKey, a, ids, o = {}) => st(db,
  `INSERT OR IGNORE INTO crm_attribution_events (id, lead_id, kind, source_key, campaign_id, adset_id, ad_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer, landing_url, ext_campaign_id, ext_adset_id, ext_ad_id, click_id, headline, external_id, resolved, raw, at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  o.id || newId(), leadId, kind, sourceKey || null, ids && ids.campaignId || null, ids && ids.adsetId || null, ids && ids.adId || null,
  a && a.utm_source || null, a && a.utm_medium || null, a && a.utm_campaign || null, a && a.utm_content || null, a && a.utm_term || null,
  a && a.referrer || null, a && a.landing_url || null, a && a.ext_campaign_id || null, a && a.ext_adset_id || null, a && a.ext_ad_id || null,
  a && a.click_id || null, a && a.headline || null, o.externalId || null, o.resolved === false ? 0 : 1, o.raw ? jstr(o.raw) : null, o.at || now());

// the lead columns holding the FIRST touch (set at creation only)
export function firstTouchCols(sourceKey, a, ids, at) {
  return {
    first_source_key: sourceKey || null, first_campaign_id: ids && ids.campaignId || null, first_adset_id: ids && ids.adsetId || null, first_ad_id: ids && ids.adId || null,
    first_utm_source: a && a.utm_source || null, first_utm_medium: a && a.utm_medium || null, first_utm_campaign: a && a.utm_campaign || null,
    first_utm_content: a && a.utm_content || null, first_utm_term: a && a.utm_term || null, first_referrer: a && a.referrer || null,
    first_landing_url: a && a.landing_url || null, first_touch_at: at,
  };
}
