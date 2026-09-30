// functions/api/_crm/sales.js — revenue (crm_sales), Convert, sales list (NOT a route).
import { E, json, all, first, st, many, now, newId, text, int, money, oneOf, round2, auditSt, activitySt, notifySt, emitSt, optRange, arr } from './core.js';
import { getLeadFor, assignLead, LEAD_SELECT, leadOut } from './leads.js';
import { salesScope, staffIdsFor } from './scope.js';
import { notifyMany, managers } from './notify.js';
import { createClient, clientLink } from '../_license.js';

export const saleOut = (s) => ({ id: s.id, leadId: s.lead_id, leadName: s.lead_name, customerId: s.customer_id, productId: s.product_id, productLabel: s.product_label, quantity: s.quantity, unitPrice: s.unit_price, discount: s.discount, total: s.total, paymentStatus: s.payment_status, amountPaid: s.amount_paid, closedBy: s.closed_by, closedByName: s.closed_by_name, source: s.source_key, campaignId: s.campaign_id, adsetId: s.adset_id, adId: s.ad_id, campaignName: s.campaign_name || null, adsetName: s.adset_name || null, adName: s.ad_name || null, soldAt: s.sold_at, notes: s.notes });
const S_SELECT = `SELECT s.*, l.name AS lead_name, (SELECT name FROM crm_campaigns WHERE id = s.campaign_id) AS campaign_name, (SELECT name FROM crm_adsets WHERE id = s.adset_id) AS adset_name, (SELECT name FROM crm_ads WHERE id = s.ad_id) AS ad_name FROM crm_sales s JOIN crm_leads l ON l.id = s.lead_id`;

export async function convertLead(ctx) {
  const { db, actor, env, request } = ctx; actor.require('sales.record');
  let lead = await getLeadFor(ctx, ctx.params.id, { write: true });
  const b = await ctx.json();
  const product = b.productId ? await first(db, `SELECT * FROM crm_products WHERE id = ? AND active = 1`, String(b.productId)) : null;
  if (!product) throw E.bad('Choose a product', 'invalid_product');
  const quantity = int(b.quantity, 'quantity', { min: 1, max: 100000, dflt: 1 });
  const unitPrice = money(b.unitPrice, 'unitPrice');
  const discount = money(b.discount, 'discount', { dflt: 0 });
  const total = round2(quantity * unitPrice - discount);
  if (total < 0) throw E.bad('The discount is larger than the price', 'invalid_discount');
  const paymentStatus = oneOf(String(b.paymentStatus || 'unpaid'), ['paid', 'partial', 'unpaid'], 'paymentStatus');
  let paid = paymentStatus === 'paid' ? total : 0;
  if (paymentStatus === 'partial') { paid = money(b.amountPaid, 'amountPaid'); if (!(paid > 0 && paid < total)) throw E.bad('A part payment must be more than 0 and less than the total', 'invalid_amount_paid'); }
  const won = await first(db, `SELECT key, label FROM crm_statuses WHERE is_won = 1 AND active = 1 ORDER BY position LIMIT 1`);
  if (!won) throw E.conflict('No "won" status is configured', 'no_won_status');
  if (!lead.owner_id) { const r = await assignLead(ctx, lead, actor.user, { kindOverride: 'claim' }); lead = r.lead; }   // the closer owns what they close
  const t = now(), id = newId();
  const stmts = [
    st(db, `INSERT INTO crm_sales (id, lead_id, product_id, product_label, quantity, unit_price, discount, total, payment_status, amount_paid, closed_by, closed_by_name, source_key, campaign_id, adset_id, ad_id, sold_at, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, lead.id, product.id, product.label, quantity, unitPrice, discount, total, paymentStatus, paid, actor.id, actor.name, lead.first_source_key || lead.source_key, lead.first_campaign_id, lead.first_adset_id, lead.first_ad_id, t, text(b.notes, 500), t, t),
    st(db, `UPDATE crm_leads SET status_key = ?, lost_reason_key = NULL, lost_at = NULL, converted_at = COALESCE(converted_at, ?), actual_value = (SELECT SUM(total) FROM crm_sales WHERE lead_id = ?), first_contact_at = COALESCE(first_contact_at, ?), updated_at = ?, last_activity_at = ? WHERE id = ?`, won.key, t, lead.id, t, t, t, lead.id),
    st(db, `INSERT OR IGNORE INTO crm_lead_products (lead_id, product_id, added_at, added_by) VALUES (?,?,?,?)`, lead.id, product.id, t, actor.id),
    activitySt(db, actor, lead.id, 'sale', `Sale: ${quantity} × ${product.label} — total ${total}${discount ? ` (discount ${discount})` : ''}, ${paymentStatus}`, { saleId: id, total, paymentStatus }, t),
    auditSt(db, actor, 'sale_create', 'sale', id, null, { leadId: lead.id, productId: product.id, quantity, unitPrice, discount, total, paymentStatus, amountPaid: paid, previousStatus: lead.status_key }, t),
    auditSt(db, actor, 'lead_status', 'lead', lead.id, { status: lead.status_key, actualValue: lead.actual_value ?? null }, { status: won.key, viaSale: id, actualValue: round2((lead.actual_value || 0) + total) }, t),
    emitSt(db, actor, 'lead.converted', { entity: 'lead', entityId: lead.id, leadId: lead.id, data: { saleId: id, total, productId: product.id } }, t),
    emitSt(db, actor, 'sale.recorded', { entity: 'sale', entityId: id, leadId: lead.id, data: { total, paymentStatus, closedBy: actor.id } }, t),
  ];
  const targets = [...(await managers(db, actor.id)), ...(lead.owner_id && lead.owner_id !== actor.id ? [lead.owner_id] : [])];
  stmts.push(...notifyMany(db, targets, actor.id, 'conversion', `Sale closed: ${lead.name}`, `${product.label} · ${total} · by ${actor.name}`, { leadId: lead.id, entity: 'sale', entityId: id, at: t }));
  await db.batch(stmts);

  // optional MyDuka client record (the account the customer will use). The sale is already safe in D1; a failure here is reported, never hidden.
  const out = {};
  const cc = b.createClient;
  if (cc) {
    try {
      const type = cc && typeof cc === 'object' && (cc.type === 'permanent' || cc.type === 'demo') ? cc.type : (paymentStatus === 'paid' ? 'permanent' : 'demo');
      const record = await createClient(env, type, lead.business_name || lead.name, product.license_product || 'shop', { phone: lead.phone || '', clientName: lead.name, source: 'crm', agreedAmount: total, paidAmount: paid });
      const link = clientLink(env, record, new URL(request.url).origin);
      const cid = newId();
      await db.batch([
        st(db, `INSERT INTO crm_customers (id, lead_id, license_client_id, license_type, product_key, name, phone, link, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, cid, lead.id, record.id, type, record.product, lead.name, lead.phone, link, actor.id, t),
        st(db, `UPDATE crm_sales SET customer_id = ? WHERE id = ?`, cid, id),
        st(db, `UPDATE crm_leads SET customer_id = ? WHERE id = ?`, cid, lead.id),
        activitySt(db, actor, lead.id, 'customer', `MyDuka ${type} client created (${record.product})`, { licenseClientId: record.id }, t),
        auditSt(db, actor, 'customer_create', 'customer', cid, null, { leadId: lead.id, licenseClientId: record.id, type, product: record.product }, t),
      ]);
      out.customer = { id: cid, licenseClientId: record.id, type, product: record.product, link };
    } catch (e) { out.clientError = 'The sale was saved, but the MyDuka client could not be created: ' + String(e && e.message || e).slice(0, 200); }
  }
  const sale = await first(db, `${S_SELECT} WHERE s.id = ?`, id);
  return json({ sale: saleOut(sale), lead: leadOut(await first(db, `${LEAD_SELECT} WHERE l.id = ?`, lead.id)), ...out }, 201);
}

export function salesFilter(actor, q, staffIds) {
  const sc = salesScope(actor, 's');
  if (!sc) throw E.forbidden('You cannot see revenue', 'forbidden');
  const where = [sc.sql], args = [...sc.args];
  const r = optRange(q.get('from'), q.get('to'));
  if (r.from != null) { where.push('s.sold_at >= ?'); args.push(r.from); }
  if (r.to != null) { where.push('s.sold_at < ?'); args.push(r.to); }
  for (const [p, col] of [['product', 's.product_id'], ['campaign', 's.campaign_id'], ['adset', 's.adset_id'], ['ad', 's.ad_id'], ['source', 's.source_key'], ['lead', 's.lead_id']]) if (q.get(p)) { where.push(`${col} = ?`); args.push(q.get(p)); }
  const staff = q.get('staff');
  if (staff) {
    if (staffIds && !staffIds.includes(staff)) throw E.forbidden('You cannot look at that person\'s revenue', 'forbidden');
    where.push('s.closed_by = ?'); args.push(staff);
  }
  return { where: where.join(' AND '), args };
}
export async function listSales(ctx) {
  const { db, actor, query } = ctx;
  const level = actor.has('revenue.company') ? 'company' : actor.has('revenue.team') ? 'team' : actor.has('revenue.own') ? 'own' : null;
  if (!level) throw E.forbidden('You cannot see revenue', 'forbidden');
  const f = salesFilter(actor, query, level === 'own' ? [actor.id] : null);
  const limit = Math.min(1000, Math.max(1, parseInt(query.get('limit'), 10) || 1000));     // zip 161: `limit` is optional (default and maximum stay 1000); the totals always cover every sale
  const [rows, [tot]] = await many(db, [st(db, `${S_SELECT} WHERE ${f.where} ORDER BY s.sold_at DESC, s.id LIMIT ${limit}`, ...f.args), st(db, `SELECT COUNT(*) n, COALESCE(SUM(total),0) revenue, COALESCE(SUM(amount_paid),0) collected FROM crm_sales s WHERE ${f.where}`, ...f.args)]);
  return { items: rows.map(saleOut), totals: { count: tot.n, revenue: round2(tot.revenue), collected: round2(tot.collected), outstanding: round2(tot.revenue - tot.collected) }, scope: level };
}
async function saleFor(ctx, id) {
  const sc = salesScope(ctx.actor, 's');
  if (!sc) throw E.forbidden('You cannot see revenue', 'forbidden');
  const s = typeof id === 'string' ? await first(ctx.db, `${S_SELECT} WHERE s.id = ? AND ${sc.sql}`, id, ...sc.args) : null;
  if (!s) throw E.notFound('Sale not found', 'sale_not_found');
  return s;
}
export async function getSale(ctx) { return { sale: saleOut(await saleFor(ctx, ctx.params.id)) }; }
export async function patchSale(ctx) {
  const { db, actor } = ctx; actor.require('sales.record');
  const s = await saleFor(ctx, ctx.params.id);
  const b = await ctx.json();
  const set = {};
  if ('paymentStatus' in b) {
    const ps = oneOf(String(b.paymentStatus), ['paid', 'partial', 'unpaid'], 'paymentStatus');
    set.payment_status = ps;
    if (ps === 'paid') set.amount_paid = s.total; else if (ps === 'unpaid') set.amount_paid = 0;
    else { const p = money(b.amountPaid, 'amountPaid'); if (!(p > 0 && p < s.total)) throw E.bad('A part payment must be more than 0 and less than the total', 'invalid_amount_paid'); set.amount_paid = p; }
  }
  if ('notes' in b) set.notes = text(b.notes, 500);
  const cols = Object.keys(set);
  if (!cols.length) throw E.bad('nothing to change', 'no_changes');
  const prev = {}; cols.forEach((c) => { prev[c] = s[c]; });
  const t = now();
  await db.batch([
    st(db, `UPDATE crm_sales SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => set[c]), t, s.id),
    activitySt(db, actor, s.lead_id, 'sale', `Payment status: ${s.payment_status} → ${set.payment_status || s.payment_status}${set.amount_paid != null ? ` (paid ${set.amount_paid} of ${s.total})` : ''}`, { saleId: s.id, set }, t),
    auditSt(db, actor, 'sale_update', 'sale', s.id, prev, set, t),
  ]);
  return { sale: saleOut(await first(db, `${S_SELECT} WHERE s.id = ?`, s.id)) };
}
