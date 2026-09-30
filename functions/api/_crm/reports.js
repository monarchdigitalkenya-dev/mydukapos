// functions/api/_crm/reports.js — dashboard + reports (NOT a route). Every figure is computed from real rows in D1; a ratio whose denominator is
// zero (or an ad spend that was never entered) is null, never a guess. Ranges are Africa/Nairobi days.
import { E, all, first, st, many, batcher, now, round2, rangeFor, nairobiDay, dayStart, DAY, addDays, isDay, optRange, placeholders } from './core.js';
import { reportLevel, staffIdsFor, staffFilter, inClause, salesScope, revenueLevel } from './scope.js';
import { campaignMetrics, metricsOf, metricsStatements, metricsFrom } from './campaigns.js';
import { sweepReminders } from './followups.js';
import { readSettings } from './config.js';

const OPEN = `l.status_key NOT IN (SELECT key FROM crm_statuses WHERE is_won = 1 OR is_lost = 1)`;
const pct = (a, b) => (b > 0 ? round2((a / b) * 100) : null);
const avgMin = (ms) => (ms == null ? null : round2(ms / 60000));

async function setup(ctx, { defaultRange = 'month' } = {}) {
  const { db, actor, query } = ctx;
  const level = reportLevel(actor);
  if (!level) throw E.forbidden('Missing permission: reports.own', 'forbidden');
  const allowed = await staffIdsFor(db, actor, level);
  const ids = staffFilter(allowed, query.get('staff'));
  const r = query.get('range') ? rangeFor(query.get('range'), query.get('from'), query.get('to')) : (query.get('from') || query.get('to')) ? rangeFor('custom', query.get('from') || query.get('to'), query.get('to') || query.get('from')) : rangeFor(defaultRange);
  const owner = ids ? inClause('l.owner_id', ids) : { sql: '1=1', args: [] };
  const sales = salesScope(actor, 's');
  const sc = ids ? inClause('s.closed_by', ids) : { sql: '1=1', args: [] };
  return { level, ids, r, owner, sales: sales ? { sql: `${sales.sql} AND ${sc.sql}`, args: [...sales.args, ...sc.args] } : null, allowed };
}
// extra lead filters shared by the reports
function leadFilters(q, a = 'l') {
  const w = [], args = [];
  if (q.get('source')) { w.push(`${a}.first_source_key = ?`); args.push(q.get('source')); }
  if (q.get('campaign')) { w.push(`${a}.first_campaign_id = ?`); args.push(q.get('campaign')); }
  if (q.get('product')) { w.push(`EXISTS (SELECT 1 FROM crm_lead_products lp WHERE lp.lead_id = ${a}.id AND lp.product_id = ?)`); args.push(q.get('product')); }
  return { sql: w.length ? ' AND ' + w.join(' AND ') : '', args };
}
const rangeInfo = (r) => ({ range: r.range, from: r.from, to: r.to, fromDay: r.fromDay, toDay: r.toDay });

// ---------------- dashboard ----------------
// zip 161: the dashboard used to be ~90 sequential D1 round trips (about 30 queries, then 3 more for every staff member). Every query is now built first and they all travel
// in ONE db.batch (one round trip, one consistent snapshot); the per-person loop became GROUP BY queries; the five lead counters that each scanned crm_leads
// are one scan. The figures are the same (tests/zip158-crm*.test.mjs and tests/zip161-crm-speed.test.mjs compare them).
export async function dashboard(ctx) {
  const { db, actor, query } = ctx;
  await sweepReminders(db, actor.meta);
  const s = await setup(ctx, { defaultRange: 'today' });
  const { r, owner } = s;
  const t = now(), todayEnd = dayStart(nairobiDay(t)) + DAY, todayStart = dayStart(nairobiDay(t));
  const lf = leadFilters(query, 'l');
  const Larg = [...owner.args, ...lf.args];
  const L = `FROM crm_leads l WHERE l.deleted_at IS NULL AND ${owner.sql}${lf.sql}`;
  const B = [];                                                       // the batch: statements in the order they are read back
  const q = (sql, ...a) => { B.push(st(db, sql, ...a)); return B.length - 1; };
  // one pass over the viewer's leads for the period counters AND the state right now
  const iLeads = q(`SELECT COUNT(*) total,
      SUM(CASE WHEN l.created_at >= ? AND l.created_at < ? THEN 1 ELSE 0 END) created_n, SUM(CASE WHEN l.created_at >= ? AND l.created_at < ? AND l.converted_at IS NOT NULL THEN 1 ELSE 0 END) created_won,
      SUM(CASE WHEN l.first_contact_at >= ? AND l.first_contact_at < ? THEN 1 ELSE 0 END) contacted, SUM(CASE WHEN l.converted_at >= ? AND l.converted_at < ? THEN 1 ELSE 0 END) converted, SUM(CASE WHEN l.lost_at >= ? AND l.lost_at < ? THEN 1 ELSE 0 END) lost,
      SUM(CASE WHEN l.status_key = 'new' THEN 1 ELSE 0 END) new_, SUM(CASE WHEN l.owner_id IS NULL AND ${OPEN} THEN 1 ELSE 0 END) unassigned, SUM(CASE WHEN l.owner_id IS NOT NULL AND ${OPEN} THEN 1 ELSE 0 END) assigned,
      SUM(CASE WHEN l.claimed_at IS NOT NULL AND l.claimed_at >= ? AND l.claimed_at < ? THEN 1 ELSE 0 END) claimed,
      SUM(CASE WHEN l.status_key = 'awaiting_response' THEN 1 ELSE 0 END) awaiting, SUM(CASE WHEN l.status_key = 'followup_required' THEN 1 ELSE 0 END) followup_required,
      SUM(CASE WHEN l.status_key = 'qualified' THEN 1 ELSE 0 END) qualified, SUM(CASE WHEN l.status_key = 'potential' OR l.class_key = 'potential' THEN 1 ELSE 0 END) potential,
      SUM(CASE WHEN l.class_key = 'dead' OR l.lost_at IS NOT NULL THEN 1 ELSE 0 END) dead, SUM(CASE WHEN l.converted_at IS NOT NULL THEN 1 ELSE 0 END) won ${L}`,
    r.from, r.to, r.from, r.to, r.from, r.to, r.from, r.to, r.from, r.to, r.from, r.to, ...Larg);
  const iStatuses = q(`SELECT key, label, color FROM crm_statuses WHERE active = 1 ORDER BY position`);
  const iPipe = q(`SELECT l.status_key k, COUNT(*) n ${L} GROUP BY l.status_key`, ...Larg);
  const iSource = q(`SELECT COALESCE(l.first_source_key, l.source_key) AS source, COUNT(*) n, SUM(CASE WHEN l.converted_at IS NOT NULL THEN 1 ELSE 0 END) won ${L} AND l.created_at >= ? AND l.created_at < ? GROUP BY 1 ORDER BY n DESC`, ...Larg, r.from, r.to);
  const fuOwner = s.ids ? inClause('f.assigned_user_id', s.ids) : { sql: '1=1', args: [] };
  const iFu = q(`SELECT SUM(CASE WHEN f.due_at < ? THEN 1 ELSE 0 END) overdue, SUM(CASE WHEN f.due_at >= ? AND f.due_at < ? THEN 1 ELSE 0 END) today, SUM(CASE WHEN f.due_at >= ? THEN 1 ELSE 0 END) upcoming FROM crm_followups f JOIN crm_leads l ON l.id = f.lead_id WHERE f.status = 'open' AND l.deleted_at IS NULL AND ${fuOwner.sql}`, t, t, todayEnd, todayEnd, ...fuOwner.args);
  const mOwner = s.ids ? inClause('m.user_id', s.ids) : { sql: '1=1', args: [] };
  const iMt = q(`SELECT SUM(CASE WHEN m.starts_at >= ? AND m.starts_at < ? AND m.status IN ('scheduled','confirmed','rescheduled') THEN 1 ELSE 0 END) today, SUM(CASE WHEN m.starts_at >= ? AND m.starts_at < ? AND m.status IN ('scheduled','confirmed','rescheduled') THEN 1 ELSE 0 END) next7, SUM(CASE WHEN m.starts_at >= ? AND m.starts_at < ? AND m.status = 'completed' THEN 1 ELSE 0 END) completed, SUM(CASE WHEN m.starts_at >= ? AND m.starts_at < ? AND m.status = 'no_show' THEN 1 ELSE 0 END) no_show FROM crm_meetings m JOIN crm_leads l ON l.id = m.lead_id WHERE l.deleted_at IS NULL AND ${mOwner.sql}`, todayStart, todayEnd, todayEnd, todayEnd + 7 * DAY, r.from, r.to, r.from, r.to, ...mOwner.args);
  const iPool = q(`SELECT COUNT(*) n FROM crm_leads l WHERE l.deleted_at IS NULL AND l.owner_id IS NULL AND ${OPEN}`);
  const iAction = q(`SELECT COUNT(*) n ${L} AND ${OPEN} AND (l.status_key = 'followup_required' OR EXISTS (SELECT 1 FROM crm_followups f WHERE f.lead_id = l.id AND f.status = 'open' AND f.due_at < ?))`, ...Larg, todayEnd);
  let iRev = -1, iProd = -1;
  if (s.sales) {
    iRev = q(`SELECT COUNT(*) n, COALESCE(SUM(total),0) rev, COALESCE(SUM(amount_paid),0) paid FROM crm_sales s WHERE ${s.sales.sql} AND s.sold_at >= ? AND s.sold_at < ?`, ...s.sales.args, r.from, r.to);
    iProd = q(`SELECT s.product_id, s.product_label, COUNT(*) n, SUM(s.total) rev FROM crm_sales s WHERE ${s.sales.sql} AND s.sold_at >= ? AND s.sold_at < ? GROUP BY s.product_id ORDER BY rev DESC LIMIT 10`, ...s.sales.args, r.from, r.to);
  }
  const wantCamp = actor.has('campaigns.view'), companyWide = s.level === 'company' && !s.ids;
  const by = {};
  if (wantCamp) for (const [col, tbl, kind] of [['first_campaign_id', 'crm_campaigns', 'campaign'], ['first_adset_id', 'crm_adsets', 'adset'], ['first_ad_id', 'crm_ads', 'ad']]) {
    by[kind] = q(`SELECT l.${col} id, x.name, COUNT(*) n, SUM(CASE WHEN l.converted_at IS NOT NULL THEN 1 ELSE 0 END) won FROM crm_leads l JOIN ${tbl} x ON x.id = l.${col} WHERE l.deleted_at IS NULL AND ${owner.sql}${lf.sql} AND l.created_at >= ? AND l.created_at < ? GROUP BY l.${col} ORDER BY n DESC LIMIT 20`, ...Larg, r.from, r.to);
  }
  let iMetrics = -1;
  if (wantCamp && companyWide) { iMetrics = B.length; B.push(...metricsStatements(db, r)); }                    // 9 statements, read back as one block
  // staff board: one grouped query per figure instead of three per person
  const iUsers = q(`SELECT id, name FROM crm_users WHERE ${s.ids ? `id IN (${placeholders(s.ids.length)})` : "archived = 0 AND status != 'invited'"} ORDER BY name COLLATE NOCASE`, ...(s.ids || []));
  const iContacts = q(`SELECT user_id k, COUNT(*) n FROM crm_contact_attempts WHERE at >= ? AND at < ? GROUP BY user_id`, r.from, r.to);
  const iOpenBy = q(`SELECT l.owner_id k, COUNT(*) n FROM crm_leads l WHERE l.owner_id IS NOT NULL AND l.deleted_at IS NULL AND ${OPEN} GROUP BY l.owner_id`);
  const iRespBy = q(`SELECT l.owner_id k, AVG(l.first_contact_at - COALESCE(l.assigned_at, l.created_at)) a FROM crm_leads l WHERE l.owner_id IS NOT NULL AND l.deleted_at IS NULL AND l.first_contact_at >= ? AND l.first_contact_at < ? AND l.first_contact_at >= COALESCE(l.assigned_at, l.created_at)${lf.sql} GROUP BY l.owner_id`, r.from, r.to, ...lf.args);
  const iSoldBy = s.sales ? q(`SELECT s.closed_by k, COUNT(*) n, COALESCE(SUM(total),0) rev FROM crm_sales s WHERE s.closed_by IS NOT NULL AND ${s.sales.sql} AND s.sold_at >= ? AND s.sold_at < ? GROUP BY s.closed_by`, ...s.sales.args, r.from, r.to) : -1;
  const iResp = q(`SELECT AVG(l.first_contact_at - l.created_at) c, AVG(l.first_contact_at - l.assigned_at) a, AVG(l.first_response_at - l.created_at) r, COUNT(l.first_contact_at) n ${L} AND l.created_at >= ? AND l.created_at < ? AND l.first_contact_at >= l.created_at`, ...Larg, r.from, r.to);
  // what the signed-in person has on their own plate (independent of the staff filter and of what they may see company-wide)
  const iMe = q(`SELECT SUM(CASE WHEN ${OPEN} AND l.status_key = 'new' THEN 1 ELSE 0 END) new_, SUM(CASE WHEN ${OPEN} THEN 1 ELSE 0 END) assigned, SUM(CASE WHEN ${OPEN} AND l.claimed_at >= ? AND l.claimed_at < ? THEN 1 ELSE 0 END) claimed, SUM(CASE WHEN ${OPEN} AND (l.status_key = 'potential' OR l.class_key = 'potential') THEN 1 ELSE 0 END) potential, SUM(CASE WHEN l.converted_at >= ? AND l.converted_at < ? THEN 1 ELSE 0 END) conversions FROM crm_leads l WHERE l.deleted_at IS NULL AND l.owner_id = ?`, r.from, r.to, r.from, r.to, actor.id);
  const iMeFu = q(`SELECT SUM(CASE WHEN f.due_at < ? THEN 1 ELSE 0 END) overdue, SUM(CASE WHEN f.due_at >= ? AND f.due_at < ? THEN 1 ELSE 0 END) today FROM crm_followups f JOIN crm_leads l ON l.id = f.lead_id WHERE f.status = 'open' AND l.deleted_at IS NULL AND f.assigned_user_id = ?`, t, t, todayEnd, actor.id);
  const iMeMt = q(`SELECT COUNT(*) n FROM crm_meetings m JOIN crm_leads l ON l.id = m.lead_id WHERE l.deleted_at IS NULL AND m.user_id = ? AND m.status IN ('scheduled','confirmed','rescheduled') AND m.starts_at >= ? AND m.starts_at < ?`, actor.id, todayStart, todayEnd);
  const iMeRev = actor.has('revenue.own') || actor.has('revenue.team') || actor.has('revenue.company') ? q(`SELECT COALESCE(SUM(total),0) rev FROM crm_sales s WHERE s.closed_by = ? AND s.sold_at >= ? AND s.sold_at < ?`, actor.id, r.from, r.to) : -1;
  const iInbox = actor.has('inbox.view') ? q(...(() => { const own = actor.has('leads.all') ? { sql: '1=1', args: [] } : { sql: '(cl.owner_id = ? OR cl.owner_id IS NULL) AND c.lead_id IS NOT NULL', args: [actor.id] }; return [`SELECT COALESCE(SUM(c.unread_count),0) n FROM crm_conversations c LEFT JOIN crm_leads cl ON cl.id = c.lead_id WHERE ${own.sql}`, ...own.args]; })()) : -1;

  const R = await many(db, B);                                                                   // ---- the ONE round trip ----
  const lead = R[iLeads][0] || {};
  const created = { n: lead.created_n || 0, won: lead.created_won || 0 };
  const cur = { total: lead.total || 0, new: lead.new_ || 0, unassigned: lead.unassigned || 0, assigned: lead.assigned || 0, claimed: lead.claimed || 0, awaitingResponse: lead.awaiting || 0, followupRequired: lead.followup_required || 0, qualified: lead.qualified || 0, potential: lead.potential || 0, dead: lead.dead || 0, wonTotal: lead.won || 0 };
  const pipeCount = new Map(R[iPipe].map((x) => [x.k, x.n]));
  const fu = R[iFu][0], mt = R[iMt][0];
  const out = {
    range: rangeInfo(r), scope: s.level, staff: s.ids && s.ids.length === 1 ? s.ids[0] : null,
    leads: { created: created.n, contacted: lead.contacted || 0, converted: lead.converted || 0, lost: lead.lost || 0, conversionRate: pct(created.won, created.n), ...cur, requiringActionToday: R[iAction][0].n || 0 },
    pipeline: R[iStatuses].map((p) => ({ key: p.key, label: p.label, color: p.color, count: pipeCount.get(p.key) || 0 })),
    bySource: R[iSource].map((x) => ({ source: x.source, leads: x.n, won: x.won || 0 })),
    followups: { overdue: fu.overdue || 0, today: fu.today || 0, upcoming: fu.upcoming || 0 },
    meetings: { today: mt.today || 0, next7Days: mt.next7 || 0, completed: mt.completed || 0, noShow: mt.no_show || 0 },
    pool: R[iPool][0].n, revenue: null, marketing: null, staffBoard: null, inboxUnread: null,
  };
  if (s.sales) {
    const rv = R[iRev][0];
    const avgDeal = rv.n ? round2(rv.rev / rv.n) : null;
    out.revenue = { avgDealValue: avgDeal, revenuePerLead: created.n ? round2(rv.rev / created.n) : null, revenuePerConvertedLead: (lead.converted || 0) ? round2(rv.rev / lead.converted) : null, deals: rv.n, total: round2(rv.rev), collected: round2(rv.paid), outstanding: round2(rv.rev - rv.paid), byProduct: R[iProd].map((p) => ({ productId: p.product_id, product: p.product_label, deals: p.n, revenue: round2(p.rev) })) };
  }
  const m = iMetrics >= 0 ? metricsFrom(R.slice(iMetrics, iMetrics + 9), actor.has('campaigns.revenue')) : null;
  if (wantCamp) {
    // leads by campaign / ad set / ad inside the viewer's scope; spend-based figures (CPL, CPA, ROAS) only where money was really spent and the viewer sees the company
    const rowsOf = (kind) => R[by[kind]].map((x) => { const mm = m && m[kind].get(x.id); const sp = mm ? mm.spend : 0; return { id: x.id, name: x.name, leads: x.n, won: x.won || 0, spend: m ? sp : null, cpl: sp > 0 ? mm.cpl : null, cpa: sp > 0 ? mm.cpa : null, roas: sp > 0 ? mm.roas : null, revenue: mm ? mm.revenue : null }; });
    out.byCampaign = rowsOf('campaign'); out.byAdset = rowsOf('adset'); out.byAd = rowsOf('ad');
  }
  if (wantCamp && companyWide) {                                                                 // marketing figures are company-wide: only when the viewer sees the company
    let spend = 0, leads = 0, won = 0, revenue = 0, collected = 0;
    for (const v of m.campaign.values()) { spend += v.spend; leads += v.leads; won += v.wonLeads; revenue += v.revenue || 0; collected += v.collected || 0; }
    // spend that was entered at ad-set / ad level rolls into its campaign already (one level per campaign and day)
    out.marketing = metricsOf(spend, leads, won, null, revenue, collected, actor.has('campaigns.revenue'));
    if (!(spend > 0)) { out.marketing.cpl = null; out.marketing.cpa = null; out.marketing.roas = null; }
    delete out.marketing.sales;
  }
  {
    const contacts = new Map(R[iContacts].map((x) => [x.k, x.n])), openBy = new Map(R[iOpenBy].map((x) => [x.k, x.n])), respBy = new Map(R[iRespBy].map((x) => [x.k, x.a]));
    const soldBy = iSoldBy >= 0 ? new Map(R[iSoldBy].map((x) => [x.k, x])) : null;
    const rows = [];
    for (const u of R[iUsers]) {
      const row = { userId: u.id, name: u.name, openLeads: openBy.get(u.id) || 0, contactAttempts: contacts.get(u.id) || 0, avgResponseMinutes: avgMin(respBy.has(u.id) ? respBy.get(u.id) : null), dealsClosed: null, revenue: null };
      if (soldBy) { const sv = soldBy.get(u.id); row.dealsClosed = sv ? sv.n : 0; row.revenue = round2(sv ? sv.rev : 0); }
      if (row.openLeads || row.contactAttempts || row.dealsClosed) rows.push(row);
    }
    out.staffBoard = rows;
    const rr = R[iResp][0];
    out.response = { leadsContacted: rr.n || 0, avgCreatedToFirstContactMinutes: avgMin(rr.c), avgAssignedToFirstContactMinutes: avgMin(rr.a), avgFirstResponseMinutes: avgMin(rr.r) };
    const me = R[iMe][0], mf = R[iMeFu][0], mm = R[iMeMt][0], mr = iMeRev >= 0 ? R[iMeRev][0] : null;
    out.mine = { newLeads: me.new_ || 0, assigned: me.assigned || 0, claimed: me.claimed || 0, potential: me.potential || 0, followupsToday: mf.today || 0, followupsOverdue: mf.overdue || 0, meetingsToday: mm.n || 0, conversions: me.conversions || 0, revenue: mr ? round2(mr.rev) : null };
  }
  if (iInbox >= 0) out.inboxUnread = R[iInbox][0].n;
  return out;
}

// ---------------- reports ----------------
export async function reportStaff(ctx) {
  const { db, actor, query } = ctx; const bx = batcher(db);
  const s = await setup(ctx);
  const lf = leadFilters(query, 'l');
  const { r } = s;
  const users_ = bx.all(`SELECT id, name, role, status, archived FROM crm_users ${s.ids ? `WHERE id IN (${placeholders(s.ids.length)})` : ''} ORDER BY name COLLATE NOCASE`, ...(s.ids || []));
  const m = (rows, k = 'k') => new Map(rows.map((x) => [x[k], x]));
  const received_ = bx.all(`SELECT o.user_id k, COUNT(DISTINCT o.lead_id) n FROM crm_lead_owners o JOIN crm_leads l ON l.id = o.lead_id WHERE o.user_id IS NOT NULL AND o.started_at >= ? AND o.started_at < ?${lf.sql} GROUP BY o.user_id`, r.from, r.to, ...lf.args).then(m);
  const contacts_ = bx.all(`SELECT c.user_id k, COUNT(*) n, COUNT(DISTINCT c.lead_id) leads FROM crm_contact_attempts c JOIN crm_leads l ON l.id = c.lead_id WHERE c.at >= ? AND c.at < ?${lf.sql} GROUP BY c.user_id`, r.from, r.to, ...lf.args).then(m);
  const lostM_ = bx.all(`SELECT l.owner_id k, COUNT(*) n FROM crm_leads l WHERE l.deleted_at IS NULL AND l.lost_at >= ? AND l.lost_at < ?${lf.sql} GROUP BY l.owner_id`, r.from, r.to, ...lf.args).then(m);
  const resp_ = bx.all(`SELECT l.owner_id k, AVG(l.first_contact_at - COALESCE(l.assigned_at, l.created_at)) avg_ms, COUNT(*) n FROM crm_leads l WHERE l.deleted_at IS NULL AND l.first_contact_at >= ? AND l.first_contact_at < ? AND l.first_contact_at >= COALESCE(l.assigned_at, l.created_at)${lf.sql} GROUP BY l.owner_id`, r.from, r.to, ...lf.args).then(m);
  const fuDone_ = bx.all(`SELECT f.completed_by k, COUNT(*) n FROM crm_followups f JOIN crm_leads l ON l.id = f.lead_id WHERE f.status = 'done' AND f.completed_at >= ? AND f.completed_at < ?${lf.sql} GROUP BY f.completed_by`, r.from, r.to, ...lf.args).then(m);
  const fuLate_ = bx.all(`SELECT f.assigned_user_id k, COUNT(*) n FROM crm_followups f JOIN crm_leads l ON l.id = f.lead_id WHERE f.status = 'open' AND f.due_at < ?${lf.sql} GROUP BY f.assigned_user_id`, now(), ...lf.args).then(m);
  const meet_ = bx.all(`SELECT mt.user_id k, SUM(CASE WHEN mt.status = 'completed' THEN 1 ELSE 0 END) done, SUM(CASE WHEN mt.status = 'no_show' THEN 1 ELSE 0 END) no_show FROM crm_meetings mt JOIN crm_leads l ON l.id = mt.lead_id WHERE mt.starts_at >= ? AND mt.starts_at < ?${lf.sql} GROUP BY mt.user_id`, r.from, r.to, ...lf.args).then(m);
  const claimed_ = bx.all(`SELECT o.user_id k, COUNT(DISTINCT o.lead_id) n FROM crm_lead_owners o JOIN crm_leads l ON l.id = o.lead_id WHERE o.kind = 'claim' AND o.started_at >= ? AND o.started_at < ?${lf.sql} GROUP BY o.user_id`, r.from, r.to, ...lf.args).then(m);
  const meetSet_ = bx.all(`SELECT mt.created_by k, COUNT(*) n FROM crm_meetings mt JOIN crm_leads l ON l.id = mt.lead_id WHERE mt.created_at >= ? AND mt.created_at < ?${lf.sql} GROUP BY mt.created_by`, r.from, r.to, ...lf.args).then(m);
  const fuSet_ = bx.all(`SELECT f.created_by k, COUNT(*) n FROM crm_followups f JOIN crm_leads l ON l.id = f.lead_id WHERE f.created_at >= ? AND f.created_at < ?${lf.sql} GROUP BY f.created_by`, r.from, r.to, ...lf.args).then(m);
  const dist = new Map();
  const distRows_ = bx.all(`SELECT l.owner_id k, l.status_key st, COUNT(*) n FROM crm_leads l WHERE l.deleted_at IS NULL AND l.owner_id IS NOT NULL AND l.created_at >= ? AND l.created_at < ?${lf.sql} GROUP BY l.owner_id, l.status_key`, r.from, r.to, ...lf.args);
  const sold_ = s.sales ? bx.all(`SELECT s.closed_by k, COUNT(*) n, SUM(s.total) rev, SUM(s.amount_paid) paid FROM crm_sales s JOIN crm_leads l ON l.id = s.lead_id WHERE ${s.sales.sql} AND s.sold_at >= ? AND s.sold_at < ?${lf.sql} GROUP BY s.closed_by`, ...s.sales.args, r.from, r.to, ...lf.args).then(m) : null;
  await bx.run();                                                         // zip 161: every query above in ONE round trip
  const [users, received, contacts, lostM, resp, fuDone, fuLate, meet, claimed, meetSet, fuSet] = await Promise.all([users_, received_, contacts_, lostM_, resp_, fuDone_, fuLate_, meet_, claimed_, meetSet_, fuSet_]);
  for (const x of await distRows_) { if (!dist.has(x.k)) dist.set(x.k, {}); dist.get(x.k)[x.st] = x.n; }
  const sold = sold_ ? await sold_ : null;
  const rows = users.map((u) => {
    const sv = sold && sold.get(u.id);
    const rc = (received.get(u.id) || {}).n || 0;
    return { userId: u.id, name: u.name, role: u.role, status: u.status, archived: !!u.archived,
      leadsReceived: rc, leadsClaimed: (claimed.get(u.id) || {}).n || 0, statusDistribution: dist.get(u.id) || {}, meetingsScheduled: (meetSet.get(u.id) || {}).n || 0, followupsCreated: (fuSet.get(u.id) || {}).n || 0, avgResponseMinutes: resp.get(u.id) ? avgMin(resp.get(u.id).avg_ms) : null, contactAttempts: (contacts.get(u.id) || {}).n || 0, leadsContacted: (contacts.get(u.id) || {}).leads || 0,
      avgFirstContactMinutes: resp.get(u.id) ? avgMin(resp.get(u.id).avg_ms) : null, lost: (lostM.get(u.id) || {}).n || 0,
      followupsDone: (fuDone.get(u.id) || {}).n || 0, followupsOverdue: (fuLate.get(u.id) || {}).n || 0,
      meetingsCompleted: (meet.get(u.id) || {}).done || 0, meetingsNoShow: (meet.get(u.id) || {}).no_show || 0,
      dealsClosed: sold ? (sv ? sv.n : 0) : null, revenue: sold ? round2(sv ? sv.rev : 0) : null, collected: sold ? round2(sv ? sv.paid : 0) : null,
      closeRate: sold ? pct(sv ? sv.n : 0, rc) : null };
  }).filter((x) => x.leadsReceived || x.contactAttempts || x.dealsClosed || x.lost || x.followupsDone || x.followupsOverdue || x.meetingsCompleted || x.meetingsNoShow || !x.archived);
  return { ...rangeInfo(r), scope: s.level, rows };
}

export async function reportSources(ctx) {
  const { db, actor, query } = ctx; const bx = batcher(db);
  const s = await setup(ctx);
  const lf = leadFilters(query, 'l'), { r } = s;
  const leads_ = bx.all(`SELECT COALESCE(l.first_source_key, l.source_key) k, COUNT(*) n, SUM(CASE WHEN l.first_contact_at IS NOT NULL THEN 1 ELSE 0 END) contacted, SUM(CASE WHEN l.converted_at IS NOT NULL THEN 1 ELSE 0 END) won, SUM(CASE WHEN l.lost_at IS NOT NULL THEN 1 ELSE 0 END) lost FROM crm_leads l WHERE l.deleted_at IS NULL AND ${s.owner.sql} AND l.created_at >= ? AND l.created_at < ?${lf.sql} GROUP BY 1`, ...s.owner.args, r.from, r.to, ...lf.args);
  const sales_ = s.sales ? bx.all(`SELECT s.source_key k, COUNT(*) n, SUM(s.total) rev, SUM(s.amount_paid) paid FROM crm_sales s WHERE ${s.sales.sql} AND s.sold_at >= ? AND s.sold_at < ?${query.get('product') ? ' AND s.product_id = ?' : ''}${query.get('campaign') ? ' AND s.campaign_id = ?' : ''} GROUP BY s.source_key`, ...s.sales.args, r.from, r.to, ...(query.get('product') ? [query.get('product')] : []), ...(query.get('campaign') ? [query.get('campaign')] : [])) : null;
  const canSpend = actor.has('campaigns.view') && s.level === 'company' && !s.ids;
  const spend_ = canSpend ? bx.all(`SELECT COALESCE(c.source_key, 'meta_ads') k, SUM(sp.amount) v FROM crm_spend sp JOIN crm_campaigns c ON c.id = sp.campaign_id WHERE sp.date >= ? AND sp.date <= ? GROUP BY 1`, r.fromDay, r.toDay) : null;
  const labels_ = bx.all(`SELECT key, label FROM crm_sources`);
  await bx.run();                                     // zip 161: one round trip for all four
  const leads = await leads_, sales = sales_ ? new Map((await sales_).map((x) => [x.k, x])) : null, spend = spend_ ? new Map((await spend_).map((x) => [x.k, x.v])) : null, labels = new Map((await labels_).map((x) => [x.key, x.label]));
  const keys = new Set([...leads.map((x) => x.k), ...(sales ? sales.keys() : []), ...(spend ? spend.keys() : [])]);
  const rows = [...keys].map((k) => {
    const l = leads.find((x) => x.k === k) || {}, sv = sales && sales.get(k), sp = spend ? round2(spend.get(k) || 0) : null;
    const canRev = !!sales && actor.has('campaigns.revenue') && canSpend;
    return { source: k, label: labels.get(k) || k, leads: l.n || 0, contacted: l.contacted || 0, won: l.won || 0, lost: l.lost || 0, conversionRate: pct(l.won || 0, l.n || 0),
      deals: sales ? (sv ? sv.n : 0) : null, revenue: sales ? round2(sv ? sv.rev : 0) : null, collected: sales ? round2(sv ? sv.paid : 0) : null,
      spend: sp, cpl: sp > 0 && l.n ? round2(sp / l.n) : null, cpa: sp > 0 && l.won ? round2(sp / l.won) : null, roas: sp > 0 && canRev ? round2((sv ? sv.rev : 0) / sp) : null };
  }).sort((a, b) => b.leads - a.leads);
  return { ...rangeInfo(r), scope: s.level, rows };
}

export async function reportCampaigns(ctx) {
  const { db, actor, query } = ctx; actor.require('campaigns.view');
  if (!reportLevel(actor)) throw E.forbidden('Missing permission: reports.own', 'forbidden');
  const r = query.get('range') ? rangeFor(query.get('range'), query.get('from'), query.get('to')) : (query.get('from') || query.get('to')) ? rangeFor('custom', query.get('from') || query.get('to'), query.get('to') || query.get('from')) : rangeFor('month');
  const m = await campaignMetrics(db, r, actor.has('campaigns.revenue'));
  const [c, a, d] = await many(db, [st(db, `SELECT * FROM crm_campaigns ORDER BY name`), st(db, `SELECT * FROM crm_adsets ORDER BY name`), st(db, `SELECT * FROM crm_ads ORDER BY name`)]);   // zip 161: one trip
  const rows = [];
  for (const x of c) { if (query.get('campaign') && x.id !== query.get('campaign')) continue; if (query.get('source') && x.source_key !== query.get('source')) continue; rows.push({ level: 'campaign', id: x.id, name: x.name, parentId: null, campaignId: x.id, status: x.status, ...(m.campaign.get(x.id) || m.empty) }); }
  const inC = new Set(rows.map((x) => x.id));
  for (const x of a) if (inC.has(x.campaign_id)) rows.push({ level: 'adset', id: x.id, name: x.name, parentId: x.campaign_id, campaignId: x.campaign_id, status: x.status, ...(m.adset.get(x.id) || m.empty) });
  for (const x of d) if (!x.campaign_id || inC.has(x.campaign_id)) { if (!x.campaign_id && (query.get('campaign') || query.get('source'))) continue; rows.push({ level: 'ad', id: x.id, name: x.name, parentId: x.adset_id, campaignId: x.campaign_id, status: x.status, ...(m.ad.get(x.id) || m.empty) }); }
  return { ...rangeInfo(r), rows };
}

export async function reportProducts(ctx) {
  const { db, actor, query } = ctx; const bx = batcher(db);
  const s = await setup(ctx);
  const { r } = s;
  const prods_ = bx.all(`SELECT id, key, label FROM crm_products ORDER BY position`);
  const interest_ = bx.all(`SELECT lp.product_id k, COUNT(DISTINCT lp.lead_id) n FROM crm_lead_products lp JOIN crm_leads l ON l.id = lp.lead_id WHERE l.deleted_at IS NULL AND ${s.owner.sql} AND l.created_at >= ? AND l.created_at < ? GROUP BY lp.product_id`, ...s.owner.args, r.from, r.to);
  const sold_ = s.sales ? bx.all(`SELECT s.product_id k, COUNT(*) n, SUM(s.quantity) qty, SUM(s.total) rev, SUM(s.discount) disc, SUM(s.amount_paid) paid FROM crm_sales s WHERE ${s.sales.sql} AND s.sold_at >= ? AND s.sold_at < ?${query.get('source') ? ' AND s.source_key = ?' : ''}${query.get('campaign') ? ' AND s.campaign_id = ?' : ''} GROUP BY s.product_id`, ...s.sales.args, r.from, r.to, ...(query.get('source') ? [query.get('source')] : []), ...(query.get('campaign') ? [query.get('campaign')] : [])) : null;
  await bx.run();                                     // zip 161: one trip
  const prods = await prods_, interest = new Map((await interest_).map((x) => [x.k, x.n])), sold = sold_ ? new Map((await sold_).map((x) => [x.k, x])) : null;
  const rows = prods.filter((p) => !query.get('product') || p.id === query.get('product')).map((p) => {
    const sv = sold && sold.get(p.id);
    return { productId: p.id, key: p.key, product: p.label, leadsInterested: interest.get(p.id) || 0, deals: sold ? (sv ? sv.n : 0) : null, quantity: sold ? (sv ? sv.qty : 0) : null, revenue: sold ? round2(sv ? sv.rev : 0) : null, discounts: sold ? round2(sv ? sv.disc : 0) : null, collected: sold ? round2(sv ? sv.paid : 0) : null };
  });
  return { ...rangeInfo(r), scope: s.level, rows };
}

export async function reportFunnel(ctx) {
  const { db, query } = ctx; const bx = batcher(db);
  const s = await setup(ctx);
  const lf = leadFilters(query, 'l'), { r } = s;
  const base = `FROM crm_leads l WHERE l.deleted_at IS NULL AND ${s.owner.sql} AND l.created_at >= ? AND l.created_at < ?${lf.sql}`;
  const ba = [...s.owner.args, r.from, r.to, ...lf.args];
  const tot_ = bx.first(`SELECT COUNT(*) n, SUM(CASE WHEN l.first_contact_at IS NOT NULL THEN 1 ELSE 0 END) contacted, SUM(CASE WHEN l.first_response_at IS NOT NULL THEN 1 ELSE 0 END) responded, SUM(CASE WHEN l.converted_at IS NOT NULL THEN 1 ELSE 0 END) won, SUM(CASE WHEN l.lost_at IS NOT NULL THEN 1 ELSE 0 END) lost ${base}`, ...ba);
  const statuses_ = bx.all(`SELECT key, label, color, is_won, is_lost FROM crm_statuses WHERE active = 1 ORDER BY position`);
  const cur_ = bx.all(`SELECT l.status_key k, COUNT(*) n ${base} GROUP BY l.status_key`, ...ba);
  // "reached" = the lead is at this status now OR its status history (the activity log) shows it was here
  const reached_ = bx.all(`SELECT k, COUNT(DISTINCT id) n FROM (
      SELECT l.id, l.status_key k ${base}
      UNION ALL SELECT l.id, json_extract(a.data, '$.to') k FROM crm_leads l JOIN crm_activities a ON a.lead_id = l.id AND a.type = 'status' WHERE l.deleted_at IS NULL AND ${s.owner.sql} AND l.created_at >= ? AND l.created_at < ?${lf.sql}
      UNION ALL SELECT l.id, 'new' k ${base}) WHERE k IS NOT NULL GROUP BY k`, ...ba, ...ba, ...ba);
  await bx.run();                                     // zip 161: one trip
  const tot = await tot_, statuses = await statuses_, cur = new Map((await cur_).map((x) => [x.k, x.n])), reached = new Map((await reached_).map((x) => [x.k, x.n]));
  const stages = statuses.map((x) => ({ key: x.key, label: x.label, color: x.color, isWon: !!x.is_won, isLost: !!x.is_lost, current: cur.get(x.key) || 0, reached: x.key === 'new' ? tot.n : (x.is_won ? (tot.won || 0) : (reached.get(x.key) || 0)) }));
  return { ...rangeInfo(r), scope: s.level, totals: { created: tot.n || 0, contacted: tot.contacted || 0, responded: tot.responded || 0, won: tot.won || 0, lost: tot.lost || 0, contactRate: pct(tot.contacted || 0, tot.n || 0), conversionRate: pct(tot.won || 0, tot.n || 0) }, stages };
}

export async function reportResponse(ctx) {
  const { db, query } = ctx;
  const s = await setup(ctx);
  const lf = leadFilters(query, 'l'), { r } = s;
  const settings = await readSettings(db);
  const rows = await all(db, `SELECT l.id, l.owner_id, l.owner_id AS oid, u.name owner_name, COALESCE(l.first_source_key, l.source_key) source, l.created_at, l.assigned_at, l.claimed_at, l.first_contact_at, l.first_response_at, l.converted_at FROM crm_leads l LEFT JOIN crm_users u ON u.id = l.owner_id WHERE l.deleted_at IS NULL AND ${s.owner.sql} AND l.created_at >= ? AND l.created_at < ?${lf.sql} LIMIT 20000`, ...s.owner.args, r.from, r.to, ...lf.args);
  const stat = (arr) => { const a = arr.filter((x) => x >= 0).sort((x, y) => x - y); if (!a.length) return { count: 0, avgMinutes: null, medianMinutes: null }; const mid = a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; return { count: a.length, avgMinutes: avgMin(a.reduce((x, y) => x + y, 0) / a.length), medianMinutes: avgMin(mid) }; };
  const d = (row, a, b) => (row[a] != null && row[b] != null ? row[b] - row[a] : null);
  const col = (a, b, list = rows) => stat(list.map((x) => d(x, a, b)).filter((x) => x != null));
  const group = (key, name) => { const g = new Map(); for (const x of rows) { const k = x[key] || '—'; (g.get(k) || g.set(k, { key: k, name: name(x), list: [] }).get(k)).list.push(x); } return [...g.values()].map((v) => ({ key: v.key, name: v.name, leads: v.list.length, createdToFirstContact: col('created_at', 'first_contact_at', v.list), assignedToFirstContact: col('assigned_at', 'first_contact_at', v.list) })); };
  const within = rows.filter((x) => x.first_contact_at != null && x.first_contact_at - (x.assigned_at || x.created_at) <= settings.firstContactTargetMinutes * 60000).length;
  const withContact = rows.filter((x) => x.first_contact_at != null).length;
  return { ...rangeInfo(r), scope: s.level, leads: rows.length, targetMinutes: settings.firstContactTargetMinutes,
    createdToAssigned: col('created_at', 'assigned_at'), createdToClaimed: col('created_at', 'claimed_at'), createdToFirstContact: col('created_at', 'first_contact_at'),
    assignedToFirstContact: col('assigned_at', 'first_contact_at'), claimedToFirstContact: col('claimed_at', 'first_contact_at'), createdToFirstResponse: col('created_at', 'first_response_at'), createdToConverted: col('created_at', 'converted_at'),
    contactedWithinTargetPct: pct(within, withContact), neverContacted: rows.length - withContact,
    byStaff: group('owner_id', (x) => x.owner_name || 'Unassigned'), bySource: group('source', (x) => x.source) };
}
