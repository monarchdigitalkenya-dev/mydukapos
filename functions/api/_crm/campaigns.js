// functions/api/_crm/campaigns.js — campaigns / ad sets / ads / spend and their metrics (NOT a route).
// CPL / CPA / ROAS are computed ONLY when spend > 0 (otherwise null): nothing is ever divided by a made-up number.
import { E, json, all, first, st, now, text, oneOf, money, isDay, nairobiDay, dayStart, addDays, round2, auditSt, optRange, newId } from './core.js';

const STATUSES = ['active', 'paused', 'ended'];
const campOut = (c) => ({ id: c.id, name: c.name, platform: c.platform, source: c.source_key, externalId: c.external_id, objective: c.objective, status: c.status, budget: c.budget, startsOn: c.starts_on, endsOn: c.ends_on, createdAt: c.created_at });
const adsetOut = (a) => ({ id: a.id, campaignId: a.campaign_id, name: a.name, externalId: a.external_id, status: a.status });
const adOut = (a) => ({ id: a.id, adsetId: a.adset_id, campaignId: a.campaign_id, name: a.name, externalId: a.external_id, headline: a.headline, status: a.status });

const ratio = (a, b) => (a > 0 && b > 0 ? round2(a / b) : null);
export function metricsOf(spend, leads, wonLeads, sales, revenue, collected, canRevenue) {
  const sp = round2(spend || 0);
  return { spend: sp, leads: leads || 0, wonLeads: wonLeads || 0, sales: sales || 0, revenue: canRevenue ? round2(revenue || 0) : null, collected: canRevenue ? round2(collected || 0) : null,
    cpl: ratio(sp, leads), cpa: ratio(sp, wonLeads), roas: canRevenue && sp > 0 ? round2((revenue || 0) / sp) : null };
}
// { campaign: Map, adset: Map, ad: Map } id -> metrics for the range (ms, `to` exclusive; either may be null)
export async function campaignMetrics(db, r, canRevenue) {
  const fromDay = r.from != null ? nairobiDay(r.from) : null, toDay = r.to != null ? nairobiDay(r.to - 1) : null;
  const sw = [], sa = [];
  if (fromDay) { sw.push('date >= ?'); sa.push(fromDay); } if (toDay) { sw.push('date <= ?'); sa.push(toDay); }
  const lw = [], la = [];
  if (r.from != null) { lw.push('created_at >= ?'); la.push(r.from); } if (r.to != null) { lw.push('created_at < ?'); la.push(r.to); }
  const vw = [], va = [];
  if (r.from != null) { vw.push('sold_at >= ?'); va.push(r.from); } if (r.to != null) { vw.push('sold_at < ?'); va.push(r.to); }
  const W = (a) => (a.length ? ' AND ' + a.join(' AND ') : '');
  const out = {};
  for (const [kind, spendCol, leadCol, saleCol] of [['campaign', 'campaign_id', 'first_campaign_id', 'campaign_id'], ['adset', 'adset_id', 'first_adset_id', 'adset_id'], ['ad', 'ad_id', 'first_ad_id', 'ad_id']]) {
    const spend = new Map((await all(db, `SELECT ${spendCol} k, SUM(amount) v FROM crm_spend WHERE ${spendCol} IS NOT NULL${W(sw)} GROUP BY ${spendCol}`, ...sa)).map((x) => [x.k, x.v]));
    const leads = new Map((await all(db, `SELECT ${leadCol} k, COUNT(*) n, SUM(CASE WHEN converted_at IS NOT NULL THEN 1 ELSE 0 END) won FROM crm_leads WHERE deleted_at IS NULL AND ${leadCol} IS NOT NULL${W(lw)} GROUP BY ${leadCol}`, ...la)).map((x) => [x.k, x]));
    const sales = new Map((await all(db, `SELECT ${saleCol} k, COUNT(*) n, SUM(total) rev, SUM(amount_paid) paid FROM crm_sales WHERE ${saleCol} IS NOT NULL${W(vw)} GROUP BY ${saleCol}`, ...va)).map((x) => [x.k, x]));
    const m = new Map();
    for (const k of new Set([...spend.keys(), ...leads.keys(), ...sales.keys()])) { const l = leads.get(k) || {}, s = sales.get(k) || {}; m.set(k, metricsOf(spend.get(k), l.n, l.won, s.n, s.rev, s.paid, canRevenue)); }
    out[kind] = m;
  }
  out.empty = metricsOf(0, 0, 0, 0, 0, 0, canRevenue);
  return out;
}

export async function listCampaigns(ctx) {
  const { db, actor, query } = ctx;
  if (query.get('lite') === '1') {                                      // names only (filters in the lead list): no figures
    actor.require('leads.view');
    const [c, s, a] = await Promise.all([all(db, `SELECT * FROM crm_campaigns ORDER BY created_at DESC`), all(db, `SELECT * FROM crm_adsets ORDER BY name`), all(db, `SELECT * FROM crm_ads ORDER BY name`)]);
    return { campaigns: c.map((x) => ({ ...campOut(x), adsets: s.filter((y) => y.campaign_id === x.id).map((y) => ({ ...adsetOut(y), ads: a.filter((z) => z.adset_id === y.id).map(adOut) })) })), unlinkedAds: a.filter((z) => !z.campaign_id).map(adOut) };
  }
  actor.require('campaigns.view');
  const r = optRange(query.get('from'), query.get('to'));
  const m = await campaignMetrics(db, r, actor.has('campaigns.revenue'));
  const [c, s, a] = await Promise.all([all(db, `SELECT * FROM crm_campaigns ORDER BY created_at DESC`), all(db, `SELECT * FROM crm_adsets ORDER BY name`), all(db, `SELECT * FROM crm_ads ORDER BY name`)]);
  const adNode = (z) => ({ ...adOut(z), metrics: m.ad.get(z.id) || m.empty });
  return {
    campaigns: c.map((x) => ({ ...campOut(x), metrics: m.campaign.get(x.id) || m.empty, adsets: s.filter((y) => y.campaign_id === x.id).map((y) => ({ ...adsetOut(y), metrics: m.adset.get(y.id) || m.empty, ads: a.filter((z) => z.adset_id === y.id).map(adNode) })) })),
    unlinkedAds: a.filter((z) => !z.campaign_id).map(adNode),
    range: { from: r.from, to: r.to },
  };
}
export async function getCampaign(ctx) {
  const { db, actor } = ctx; actor.require('campaigns.view');
  const c = await first(db, `SELECT * FROM crm_campaigns WHERE id = ?`, ctx.params.id);
  if (!c) throw E.notFound('Campaign not found', 'campaign_not_found');
  const spend = await all(db, `SELECT * FROM crm_spend WHERE campaign_id = ? ORDER BY date DESC, scope_key LIMIT 500`, c.id);
  return { campaign: campOut(c), spend: spend.map((x) => ({ id: x.id, date: x.date, amount: x.amount, adsetId: x.adset_id, adId: x.ad_id })) };
}

function campFields(b, partial) {
  const o = {};
  if (!partial || 'name' in b) { o.name = text(b.name, 120); if (!o.name) throw E.bad('name is required', 'invalid_name'); }
  if ('platform' in b) { o.platform = text(b.platform, 30) || 'meta'; }
  if ('sourceKey' in b) o.source_key = text(b.sourceKey, 40);
  if ('externalId' in b) o.external_id = text(b.externalId, 80);
  if ('objective' in b) o.objective = text(b.objective, 80);
  if ('status' in b) o.status = oneOf(String(b.status), STATUSES, 'status');
  if ('budget' in b) o.budget = b.budget == null || b.budget === '' ? null : money(b.budget, 'budget');
  for (const [k, c] of [['startsOn', 'starts_on'], ['endsOn', 'ends_on']]) if (k in b) { if (b[k] == null || b[k] === '') o[c] = null; else if (!isDay(b[k])) throw E.bad(`${k} must be YYYY-MM-DD`, 'invalid_date'); else o[c] = b[k]; }
  if (o.starts_on && o.ends_on && o.ends_on < o.starts_on) throw E.bad('endsOn is before startsOn', 'invalid_date');
  return o;
}
async function checkSource(db, key) { if (key && !(await first(db, `SELECT 1 x FROM crm_sources WHERE key = ?`, key))) throw E.bad('Unknown source', 'invalid_source'); }
const dupExt = (e) => (String(e && e.message).includes('UNIQUE') ? E.conflict('That external id is already used', 'duplicate_external_id') : e);

export async function createCampaign(ctx) {
  const { db, actor } = ctx; actor.require('campaigns.create');
  const f = campFields(await ctx.json(), false);
  await checkSource(db, f.source_key);
  const t = now(), id = newId();
  const row = { id, platform: 'meta', source_key: f.source_key ?? 'meta_ads', status: 'active', ...f, created_by: actor.id, created_at: t, updated_at: t };
  const cols = Object.keys(row);
  try { await db.batch([st(db, `INSERT INTO crm_campaigns (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => row[c])), auditSt(db, actor, 'campaign_create', 'campaign', id, null, f, t)]); } catch (e) { throw dupExt(e); }
  return json({ campaign: campOut(await first(db, `SELECT * FROM crm_campaigns WHERE id = ?`, id)) }, 201);
}
export async function patchCampaign(ctx) {
  const { db, actor } = ctx; actor.require('campaigns.edit');
  const c = await first(db, `SELECT * FROM crm_campaigns WHERE id = ?`, ctx.params.id);
  if (!c) throw E.notFound('Campaign not found', 'campaign_not_found');
  const f = campFields(await ctx.json(), true);
  await checkSource(db, f.source_key);
  return applyPatch(ctx, 'crm_campaigns', c, f, 'campaign', () => first(db, `SELECT * FROM crm_campaigns WHERE id = ?`, c.id).then((x) => ({ campaign: campOut(x) })));
}
async function applyPatch(ctx, table, cur, f, entity, out) {
  const { db, actor } = ctx;
  const cols = Object.keys(f).filter((k) => (f[k] ?? null) !== (cur[k] ?? null));
  if (!cols.length) return { ...(await out()), unchanged: true };
  const prev = {}, next = {}; cols.forEach((k) => { prev[k] = cur[k]; next[k] = f[k]; });
  const t = now();
  try { await db.batch([st(db, `UPDATE ${table} SET ${cols.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((k) => f[k]), t, cur.id), auditSt(db, actor, entity + '_update', entity, cur.id, prev, next, t)]); } catch (e) { throw dupExt(e); }
  return out();
}
export async function createAdset(ctx) {
  const { db, actor } = ctx; actor.require('campaigns.create');
  const c = await first(db, `SELECT id FROM crm_campaigns WHERE id = ?`, ctx.params.id);
  if (!c) throw E.notFound('Campaign not found', 'campaign_not_found');
  const b = await ctx.json(); const name = text(b.name, 120);
  if (!name) throw E.bad('name is required', 'invalid_name');
  const t = now(), id = newId();
  try { await db.batch([st(db, `INSERT INTO crm_adsets (id, campaign_id, name, external_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`, id, c.id, name, text(b.externalId, 80), b.status ? oneOf(String(b.status), STATUSES, 'status') : 'active', t, t), auditSt(db, actor, 'adset_create', 'adset', id, null, { campaignId: c.id, name }, t)]); } catch (e) { throw dupExt(e); }
  return json({ adset: adsetOut(await first(db, `SELECT * FROM crm_adsets WHERE id = ?`, id)) }, 201);
}
export async function patchAdset(ctx) {
  const { db, actor } = ctx; actor.require('campaigns.edit');
  const a = await first(db, `SELECT * FROM crm_adsets WHERE id = ?`, ctx.params.id);
  if (!a) throw E.notFound('Ad set not found', 'adset_not_found');
  const b = await ctx.json(), f = {};
  if ('name' in b) { f.name = text(b.name, 120); if (!f.name) throw E.bad('name is required', 'invalid_name'); }
  if ('status' in b) f.status = oneOf(String(b.status), STATUSES, 'status');
  if ('externalId' in b) f.external_id = text(b.externalId, 80);
  return applyPatch(ctx, 'crm_adsets', a, f, 'adset', () => first(db, `SELECT * FROM crm_adsets WHERE id = ?`, a.id).then((x) => ({ adset: adsetOut(x) })));
}
export async function createAd(ctx) {
  const { db, actor } = ctx; actor.require('campaigns.create');
  const a = await first(db, `SELECT * FROM crm_adsets WHERE id = ?`, ctx.params.id);
  if (!a) throw E.notFound('Ad set not found', 'adset_not_found');
  const b = await ctx.json(); const name = text(b.name, 120);
  if (!name) throw E.bad('name is required', 'invalid_name');
  const t = now(), id = newId();
  try { await db.batch([st(db, `INSERT INTO crm_ads (id, adset_id, campaign_id, name, external_id, headline, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`, id, a.id, a.campaign_id, name, text(b.externalId, 80), text(b.headline, 200), b.status ? oneOf(String(b.status), STATUSES, 'status') : 'active', t, t), auditSt(db, actor, 'ad_create', 'ad', id, null, { adsetId: a.id, name }, t)]); } catch (e) { throw dupExt(e); }
  return json({ ad: adOut(await first(db, `SELECT * FROM crm_ads WHERE id = ?`, id)) }, 201);
}
export async function patchAd(ctx) {
  const { db, actor } = ctx; actor.require('campaigns.edit');
  const a = await first(db, `SELECT * FROM crm_ads WHERE id = ?`, ctx.params.id);
  if (!a) throw E.notFound('Ad not found', 'ad_not_found');
  const b = await ctx.json(), f = {};
  if ('name' in b) { f.name = text(b.name, 120); if (!f.name) throw E.bad('name is required', 'invalid_name'); }
  if ('status' in b) f.status = oneOf(String(b.status), STATUSES, 'status');
  if ('externalId' in b) f.external_id = text(b.externalId, 80);
  if ('headline' in b) f.headline = text(b.headline, 200);
  let link = null;
  if ('adsetId' in b && b.adsetId !== a.adset_id) {          // an ad seen first through a WhatsApp click can be filed under its ad set later
    link = await first(db, `SELECT id, campaign_id FROM crm_adsets WHERE id = ?`, b.adsetId);
    if (!link) throw E.bad('Unknown ad set', 'invalid_adset');
    f.adset_id = link.id; f.campaign_id = link.campaign_id;
  }
  const res = await applyPatch(ctx, 'crm_ads', a, f, 'ad', () => first(db, `SELECT * FROM crm_ads WHERE id = ?`, a.id).then((x) => ({ ad: adOut(x) })));
  if (link) {                                                  // fill (never overwrite) the campaign / ad set of leads and sales that only knew the ad
    await db.batch([
      st(db, `UPDATE crm_leads SET first_adset_id = COALESCE(first_adset_id, ?), first_campaign_id = COALESCE(first_campaign_id, ?) WHERE first_ad_id = ?`, link.id, link.campaign_id, a.id),
      st(db, `UPDATE crm_sales SET adset_id = COALESCE(adset_id, ?), campaign_id = COALESCE(campaign_id, ?) WHERE ad_id = ?`, link.id, link.campaign_id, a.id),
      st(db, `UPDATE crm_attribution_events SET adset_id = COALESCE(adset_id, ?), campaign_id = COALESCE(campaign_id, ?) WHERE ad_id = ?`, link.id, link.campaign_id, a.id),
    ]);
  }
  return res;
}

export async function addSpend(ctx) {
  const { db, actor } = ctx; actor.require('campaigns.edit');
  const c = await first(db, `SELECT id FROM crm_campaigns WHERE id = ?`, ctx.params.id);
  if (!c) throw E.notFound('Campaign not found', 'campaign_not_found');
  const b = await ctx.json();
  if (!isDay(b.date)) throw E.bad('date must be YYYY-MM-DD', 'invalid_date');
  if (b.date > addDays(nairobiDay(), 1)) throw E.bad('date is in the future', 'invalid_date');
  const amount = money(b.amount, 'amount');
  let adset = null, ad = null, level = 'campaign';
  if (b.adId) {
    ad = await first(db, `SELECT * FROM crm_ads WHERE id = ?`, String(b.adId));
    if (!ad || ad.campaign_id !== c.id) throw E.bad('That ad is not part of this campaign', 'invalid_ad');
    adset = { id: ad.adset_id }; level = 'ad';
    if (b.adsetId && b.adsetId !== ad.adset_id) throw E.bad('That ad is not in that ad set', 'invalid_ad');
  } else if (b.adsetId) {
    adset = await first(db, `SELECT * FROM crm_adsets WHERE id = ?`, String(b.adsetId));
    if (!adset || adset.campaign_id !== c.id) throw E.bad('That ad set is not part of this campaign', 'invalid_adset');
    level = 'adset';
  }
  const scope = level === 'ad' ? 'ad:' + ad.id : level === 'adset' ? 'adset:' + adset.id : 'campaign:' + c.id;
  // one level per campaign and day (campaign OR ad set OR ad rows), otherwise the same money would be counted twice
  const other = await first(db, `SELECT scope_key FROM crm_spend WHERE campaign_id = ? AND date = ? AND scope_key NOT LIKE ? LIMIT 1`, c.id, b.date, level + ':%');
  if (other) throw E.conflict(`Spend for ${b.date} is already entered at another level (${other.scope_key.split(':')[0]}); use the same level to avoid counting it twice`, 'spend_level_conflict');
  const prev = await first(db, `SELECT id, amount FROM crm_spend WHERE scope_key = ? AND date = ?`, scope, b.date);
  const t = now(), id = prev ? prev.id : newId();
  await db.batch([
    st(db, `INSERT INTO crm_spend (id, campaign_id, adset_id, ad_id, scope_key, date, amount, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_key, date) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`, id, c.id, adset ? adset.id : null, ad ? ad.id : null, scope, b.date, amount, actor.id, t, t),
    auditSt(db, actor, prev ? 'spend_update' : 'spend_create', 'spend', id, prev ? { amount: prev.amount } : null, { campaignId: c.id, scope, date: b.date, amount }, t),
  ]);
  return json({ spend: { id, campaignId: c.id, adsetId: adset ? adset.id : null, adId: ad ? ad.id : null, date: b.date, amount, replaced: !!prev } }, prev ? 200 : 201);
}
