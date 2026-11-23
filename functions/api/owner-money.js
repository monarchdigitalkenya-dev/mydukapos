// functions/api/owner-money.js — Cloudflare Pages Function (zip 304). OWNER ONLY. The Owner Console's ONE money record (see _owner-money.js).
//
//   summary   { from, to }                         -> the figures (one calculation) + their definitions, for the Dashboard and the Money tab
//   list      { from, to, kind, status, q, offset, limit, all }  -> the entries behind those figures (same filters, same totals)
//   links     {}                                   -> permanent links with their payment status and the entry that counts them
//   record    { key, kind, clientId, amount, method, receipt, date, note, agreed, chargeRef, separate }  -> a payment the owner received by hand
//   status    { ref, status, reason }              -> count / exclude an entry (audited; a gateway-verified payment can only be refunded)
//   refund    { ref, amount, reason, key, confirm }-> money returned, linked to the original
//   reconcile-preview { sales }                    -> what the old records add up to, which entries are probable duplicates, and the corrected total
//   reconcile-apply   { sales, confirm }           -> writes that reconciliation (safe to run again: every entry has a fixed ref)
//   log       {}                                   -> the audit trail of the money record
// Nothing here deletes a payment. Opening, refreshing or exporting never writes anything.
import { requireOwnerAuth, getOwnerAccount } from './_owner-auth.js';
import { listClientSummaries } from './_license.js';
import { readState } from './_state-store.js';
import { listPays } from './billing-renew.js';
import { readSettings } from './_billing-core.js';
import { reversePayment } from './_billing.js';
import {
  db, ensureMoneySchema, recordMoney, setStatus, getRow, listAll, listLog, filterRows, summarize, rowFromBillingEvent, toCents, KINDS, DEFINITIONS, linkToCharge,
} from './_owner-money.js';

const json = (b, st = 200) => new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const clamp = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const nameKey = (s) => String(s || '').trim().toLowerCase();
const RECON_KEY = 'owner-money:recon:v1';

/* ---------- requests that are not money yet: pending and failed (read live, never stored as money) ---------- */
async function requestRows(env, summaries) {
  const out = [];
  try {
    let ids = []; try { ids = JSON.parse((await env.mydukapos_kv.get('buy-index:v1')) || '[]'); } catch (e) { ids = []; }
    const reqs = (await Promise.all(ids.slice(0, 120).map(async (id) => { try { const r = await env.mydukapos_kv.get('buy:' + id); return r ? JSON.parse(r) : null; } catch (e) { return null; } }))).filter(Boolean);
    for (const r of reqs) {
      const st = r.status === 'pending' || r.status === 'claimed' ? 'pending' : r.status === 'failed' || r.status === 'rejected' ? (r.status === 'failed' ? 'failed' : 'cancelled') : null;
      if (!st) continue;
      out.push({ ref: 'req:link:' + r.id, kind: r.kind === 'branch' ? 'branch_sale' : 'link_sale', client_id: r.clientId || '', label: r.name || r.phone || 'Link request', amount_c: toCents(r.amount || 0), status: st,
        method: r.method === 'stk' ? 'mpesa' : 'mpesa (manual)', provider: r.method || '', provider_ref: '', verified: 0, source: 'request', related_ref: '', created_at: r.createdAt || r.claimedAt || 0,
        note: st === 'pending' ? (r.status === 'claimed' ? 'Buyer says they paid - confirm in Create a Link after checking M-Pesa' : 'Payment prompt sent, not confirmed') : (r.resultDesc || 'Payment did not go through'), virtual: true });
    }
  } catch (e) { /* requests are extra information */ }
  try {
    for (const p of await listPays(env, 120)) {
      const st = p.status === 'pending' || p.status === 'claimed' ? 'pending' : p.status === 'rejected' ? 'cancelled' : p.status === 'failed' ? 'failed' : null;
      if (!st) continue;
      out.push({ ref: 'req:pay:' + p.id, kind: p.kind === 'link' ? 'link_sale' : p.kind === 'renewal' ? 'subscription' : 'addon', client_id: p.clientId || '', label: '', amount_c: toCents(p.amount || 0), status: st,
        method: 'mpesa', provider: '', provider_ref: '', verified: 0, source: 'request', related_ref: '', created_at: p.createdAt || 0, note: st === 'pending' ? (p.status === 'claimed' ? 'Shop says it paid - confirm in Subscriptions & Pricing' : 'Payment prompt sent, not confirmed') : 'Rejected / failed', virtual: true });
    }
  } catch (e) { /* extra information */ }
  try {
    const price = (await readSettings(env)).prices.link || 3000;
    for (const c of summaries) if (c.type === 'demo' && c.paymentClaimed && !c.deleted) out.push({ ref: 'req:claim:' + c.id, kind: 'link_sale', client_id: c.id, label: c.businessName || c.label || c.slug || c.id, amount_c: toCents(price), status: 'pending', method: 'mpesa (manual)', provider: '', provider_ref: '', verified: 0, source: 'request', related_ref: '', created_at: c.paymentClaimedAt || c.createdAt || 0, note: 'Demo says it paid for a permanent link - confirm after checking M-Pesa', virtual: true });
  } catch (e) { /* extra information */ }
  return out;
}
function labelRows(rows, summaries) {
  const names = {}; for (const c of summaries) names[c.id] = c.businessName || c.label || c.slug || c.id;
  return rows.map((r) => (r.label || !r.client_id ? r : { ...r, label: names[r.client_id] || r.client_id }));
}
async function everything(env, { withRequests = true } = {}) {
  let summaries = await listClientSummaries(env, {}).catch(() => []);
  try { const acct = await getOwnerAccount(env); if (acct && acct.ownerClientId) summaries = summaries.filter((c) => c.id !== acct.ownerClientId); } catch (e) { /* the owner's own console link stays listed */ }
  let rows = await listAll(env);
  if (withRequests) rows = rows.concat(await requestRows(env, summaries));
  return { rows: labelRows(rows, summaries), summaries };
}
const range = (b) => ({ from: Number(b.from) || 0, to: Number(b.to) || 0 });

/* ---------- reconciliation of the old records ---------- */
async function billingEvents(env) {
  const out = []; let cursor;
  for (let i = 0; i < 30; i++) {
    const page = await env.mydukapos_kv.list({ prefix: 'bill-evt:', cursor, limit: 100 });
    const vals = await Promise.all(page.keys.map(async (k) => { try { return JSON.parse(await env.mydukapos_kv.get(k.name)); } catch (e) { return null; } }));
    for (const v of vals) if (v) out.push(v);
    if (page.list_complete || !page.cursor) break; cursor = page.cursor;
  }
  // a reversed purchase: bill-ref carries the reversal mark
  for (const e of out) if (e && e.ref && !e.reversed) { try { const raw = await env.mydukapos_kv.get('bill-ref:' + e.ref); const m = raw ? JSON.parse(raw) : null; if (m && m.reversed) e.reversed = m.reversed; } catch (x) { /* as listed */ } }
  return out;
}
function saleAmountC(s) {
  if (!s || s.voided || s.paid === false || s._deleted) return 0;
  const nominal = (s.items || []).reduce((a, l) => a + (Number(l.price) || 0) * (Number(l.qty) || 0), 0);
  return toCents(typeof s.amountReceived === 'number' ? s.amountReceived : nominal);
}
function classify(s) {
  const n = String((s.items && s.items[0] && s.items[0].name) || '');
  if (s.isLicenseSale && !s.licenseClientId) return 'other';                 // a link sale whose link can no longer be found: counted, as other income
  if (s.licenseClientId && /^License payment/i.test(n)) return 'link-balance';
  if (s.licenseClientId) return 'link-income';
  if (s.groupIncomeDebt) return 'person-balance';
  if (/^Quote\b/i.test(n)) return 'person-income';
  return 'other';
}
// The whole report. Pure apart from the reads; writes nothing.
async function buildReconciliation(env, clientSales) {
  const summaries = await listClientSummaries(env, {}).catch(() => []);
  const byId = {}; for (const c of summaries) byId[c.id] = c;
  const groupOf = (id) => nameKey(byId[id] && byId[id].clientName) || '';
  let sales = [];
  let serverRead = false;
  try {
    const acct = await getOwnerAccount(env);
    if (acct && acct.ownerClientId) { const st = await readState(env, 'pos-data:state:' + acct.ownerClientId, null); if (st && Array.isArray(st.salesLog)) { sales = st.salesLog.slice(); serverRead = true; } }
  } catch (e) { /* use the device's copy */ }
  const have = new Set(sales.map((s) => s && String(s.id)));
  for (const s of Array.isArray(clientSales) ? clientSales.slice(0, 20000) : []) if (s && s.id != null && !have.has(String(s.id))) { sales.push(s); have.add(String(s.id)); }
  let groups = {}; try { groups = JSON.parse((await env.mydukapos_kv.get('owner-group-income:v1')) || '{}') || {}; } catch (e) { groups = {}; }
  const events = await billingEvents(env);

  // BEFORE: the figures the old screens showed
  const dashboardC = sales.reduce((a, s) => a + saleAmountC(s), 0);
  let billingC = 0;
  for (const e of events) { if (e.kind === 'purchase' || e.kind === 'renewal' || e.kind === 'addon') billingC += toCents(e.amount || 0); else if (e.kind === 'reversal') billingC -= toCents(Math.abs(e.amount || 0)); }

  const rows = [], why = {};
  const add = (row, reason) => { rows.push(row); why[row.ref] = reason || ''; };
  // 1. the billing ledger: server-confirmed, counted
  const purchasedBy = {};                                                      // clientId -> the billing purchase row
  for (const e of events) {
    const r = rowFromBillingEvent(e); if (!r) continue;
    r.label = (byId[r.client_id] && (byId[r.client_id].businessName || byId[r.client_id].label)) || r.label;
    add(r, r.status === 'complimentary' ? 'Given free: not a sale' : r.verified ? 'Confirmed by the payment gateway' : 'Confirmed by you (Confirm payment)');
    if ((r.kind === 'link_sale' || r.kind === 'branch_sale') && r.status === 'success' && !e.reversed) purchasedBy[r.client_id] = r;
  }
  // 2. the console's sales book
  const counted = [];                                                          // { cls, who, c, at, ref } of counted manual rows, for the double-entry check
  const linkIncomeBy = {};                                                     // clientId -> counted per-link income row
  const linkIncomeSeen = {};                                                   // clientId -> the sales book has its 💰 entry (counted or flagged)
  const usedGroupEntries = new Set();
  const groupEntry = (gk, c, at) => { const g = groups[gk]; if (!g || !Array.isArray(g.entries)) return null; return g.entries.find((x) => x && !usedGroupEntries.has(x.id) && toCents(x.paid || 0) === c && Math.abs((x.at || 0) - at) < 86400000) || null; };
  // an old "License (Permanent)" bill settled at the counter carries the link, not the client id: find the client from the link's address
  const bySlug = {}; for (const c of summaries) if (c.slug) bySlug[String(c.slug).toLowerCase()] = c.id;
  const fromLink = (link) => { const m = /^https?:\/\/([a-z0-9-]+)\./i.exec(String(link || '')); return m ? bySlug[m[1].toLowerCase()] || '' : ''; };
  const sorted = sales.filter((s) => s && saleAmountC(s) > 0).map((s) => (s.licenseClientId || !s.isLicenseSale ? s : { ...s, licenseClientId: fromLink(s.licenseLink) || undefined, _fromLink: true }))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  for (const s of sorted) {
    const c = saleAmountC(s), at = new Date(s.timestamp).getTime() || 0, cls = classify(s);
    if (cls === 'link-income') linkIncomeSeen[s.licenseClientId] = true;
    const who = s.licenseClientId ? 'c:' + s.licenseClientId : 'n:' + nameKey((s.groupIncomeDebt && s.groupIncomeDebt.groupKey) || s.customerName);
    const row = { ref: 'legacy:sale:' + s.id, kind: cls.startsWith('link') ? 'link_sale' : 'other_income', client_id: s.licenseClientId || '', group_key: cls.startsWith('person') ? nameKey((s.groupIncomeDebt && s.groupIncomeDebt.groupKey) || s.customerName) : (s.licenseClientId ? groupOf(s.licenseClientId) : ''),
      label: s.customerName || '', amount_c: c, status: 'success', method: s.paymentMethod === 'cash' ? 'cash' : s.paymentMethod === 'mpesa' ? 'mpesa' : String(s.paymentMethod || ''), provider: 'manual', provider_ref: String(s.mpesaReceiptNumber || ''),
      verified: 0, source: 'legacy-import', related_ref: '', created_at: at, confirmed_at: at, note: clamp((s.items || []).map((l) => l.name).join(', '), 300), actor: s.servedBy || 'owner', meta: { legacy: cls, saleId: s.id } };
    let reason = { 'link-income': 'Entered with the 💰 Income recorded switch', 'link-balance': 'A balance paid on a link (Bills tab)', 'person-income': 'Entered under Quote & Payments', 'person-balance': 'A quote balance paid (Bills tab)', other: 'A sale in the console’s own sales book' }[cls];
    if (cls === 'person-income') { const ge = groupEntry(row.group_key, c, at); if (ge) { usedGroupEntries.add(ge.id); row.meta.groupEntry = ge.id; } }
    // probable duplicates
    if (cls === 'link-income' && purchasedBy[s.licenseClientId]) {
      const p = purchasedBy[s.licenseClientId]; row.status = 'review'; row.related_ref = p.ref;
      reason = `Probable duplicate: this link’s sale (${(p.amount_c / 100).toLocaleString('en-KE')} KES) was already recorded automatically when the payment was confirmed (${new Date(p.created_at).toLocaleDateString('en-GB')}).`;
    } else if (cls === 'person-income' || cls === 'person-balance') {
      const links = summaries.filter((x) => x.type === 'permanent' && nameKey(x.clientName) === row.group_key);
      const hit = links.map((l) => purchasedBy[l.id] || linkIncomeBy[l.id]).find((x) => x && Math.abs(x.amount_c - c) <= 100);
      if (hit) { row.status = 'review'; row.related_ref = hit.ref; reason = `Probable duplicate: the same amount was already recorded for ${hit.label || 'this person’s link'} (${new Date(hit.created_at).toLocaleDateString('en-GB')}).`; }
    }
    if (row.status === 'success') {
      const twin = counted.find((x) => x.cls === cls && x.who === who && x.c === c && Math.abs(x.at - at) < 10 * 60000);
      if (twin) { row.status = 'review'; row.related_ref = twin.ref; reason = 'Possible double entry: the same amount for the same client a few minutes earlier.'; }
    }
    if (row.status === 'success') { counted.push({ cls, who, c, at, ref: row.ref }); if (cls === 'link-income') linkIncomeBy[s.licenseClientId] = row; }
    add(row, reason);
  }
  // 3. records on the server that the sales book does not have (the device copy was cleared, or another device recorded them)
  for (const c of summaries) {
    const rv = c.revenue; if (!rv || !(Number(rv.paid) > 0) || linkIncomeBy[c.id] || linkIncomeSeen[c.id]) continue;     // the same 💰 entry as a sale already read
    const row = { ref: 'legacy:link:' + c.id, kind: 'link_sale', client_id: c.id, group_key: nameKey(c.clientName), label: c.businessName || c.label || c.id, amount_c: toCents(rv.paid), status: 'success', method: rv.method || '', provider: 'manual', provider_ref: '', verified: 0, source: 'legacy-import', related_ref: '', created_at: rv.at || c.confirmedAt || c.createdAt || 0, note: 'Per-link income recorded on the link (no matching sale in the sales book)', actor: 'owner', meta: { legacy: 'link-record' } };
    let reason = 'Recorded on the link with the 💰 switch';
    if (purchasedBy[c.id]) { row.status = 'review'; row.related_ref = purchasedBy[c.id].ref; reason = 'Probable duplicate: this link’s sale was already recorded automatically when the payment was confirmed.'; }
    else linkIncomeBy[c.id] = row;
    add(row, reason);
  }
  for (const gk of Object.keys(groups)) {
    for (const e of (groups[gk] && groups[gk].entries) || []) {
      if (!e || usedGroupEntries.has(e.id) || !(Number(e.paid) > 0)) continue;
      const c = toCents(e.paid);
      const row = { ref: 'legacy:group:' + e.id, kind: 'other_income', client_id: '', group_key: gk, label: (groups[gk].label || gk), amount_c: c, status: 'success', method: e.method || '', provider: 'manual', provider_ref: '', verified: 0, source: 'legacy-import', related_ref: '', created_at: e.at || 0, note: clamp('Quote & Payments entry' + (e.note ? ': ' + e.note : ''), 300), actor: 'owner', meta: { legacy: 'group-record' } };
      let reason = 'Entered under Quote & Payments (no matching sale in the sales book)';
      const links = summaries.filter((x) => x.type === 'permanent' && nameKey(x.clientName) === gk);
      const hit = links.map((l) => purchasedBy[l.id] || linkIncomeBy[l.id]).find((x) => x && Math.abs(x.amount_c - c) <= 100);
      if (hit) { row.status = 'review'; row.related_ref = hit.ref; reason = `Probable duplicate: the same amount was already recorded for ${hit.label || 'this person’s link'}.`; }
      add(row, reason);
    }
  }
  // 4. amounts agreed but not fully paid: kept as "agreed" (not money) so the outstanding balance stays visible
  for (const c of summaries) {
    const rv = c.revenue; if (!rv || !(Number(rv.agreed) > 0)) continue;
    // a link whose sale was confirmed in the billing ledger: that confirmed payment covers the agreed amount (only an agreed amount ABOVE it can still be owed)
    const covered = purchasedBy[c.id] ? purchasedBy[c.id].amount_c : 0;
    const agreedC = toCents(rv.agreed) - covered;
    if (agreedC <= 0) continue;
    const chargeRef = 'legacy:charge:link:' + c.id;
    add({ ref: chargeRef, kind: 'charge', client_id: c.id, group_key: nameKey(c.clientName), label: c.businessName || c.label || c.id, amount_c: agreedC, status: 'open', method: '', provider: 'manual', provider_ref: '', verified: 0, source: 'legacy-import', related_ref: '', created_at: rv.at || 0, note: 'Amount agreed for this link (💰 switch)', actor: 'owner', meta: { legacy: 'agreed' } }, 'Agreed amount - not money, used for the outstanding balance');
    for (const r of rows) if (r.client_id === c.id && r.kind === 'link_sale' && r.source === 'legacy-import' && !r.related_ref) r.related_ref = chargeRef;
  }
  for (const gk of Object.keys(groups)) for (const e of (groups[gk] && groups[gk].entries) || []) {
    if (!e || !(Number(e.agreed) > Number(e.paid || 0) + 0.004)) continue;
    const chargeRef = 'legacy:charge:group:' + e.id;
    add({ ref: chargeRef, kind: 'charge', client_id: '', group_key: gk, label: groups[gk].label || gk, amount_c: toCents(e.agreed), status: 'open', method: '', provider: 'manual', provider_ref: '', verified: 0, source: 'legacy-import', related_ref: '', created_at: e.at || 0, note: clamp('Amount agreed (Quote & Payments)' + (e.note ? ': ' + e.note : ''), 300), actor: 'owner', meta: { legacy: 'agreed' } }, 'Agreed amount - not money, used for the outstanding balance');
    for (const r of rows) if ((r.ref === 'legacy:group:' + e.id || (r.meta && r.meta.groupEntry === e.id)) && !r.related_ref) r.related_ref = chargeRef;
    // balances paid on that quote (person-balance sales) belong to it as well
    for (const r of rows) if (r.meta && r.meta.legacy === 'person-balance' && r.group_key === gk && !r.related_ref) r.related_ref = chargeRef;
  }
  // receipts used twice: only the first counts
  const seenRcpt = {};
  for (const r of rows.slice().sort((a, b) => a.created_at - b.created_at)) {
    if (!r.provider_ref || r.status !== 'success' || r.kind === 'refund') continue;
    if (seenRcpt[r.provider_ref]) { r.status = 'review'; r.related_ref = seenRcpt[r.provider_ref]; why[r.ref] = `The M-Pesa receipt ${r.provider_ref} is already counted in another entry.`; }
    else seenRcpt[r.provider_ref] = r.ref;
  }
  const after = summarize(rows);
  return {
    serverRead, salesRead: sales.length, eventsRead: events.length,
    before: { dashboardC, billingC, bothC: dashboardC + billingC },
    after: { collectedC: after.collectedC, netC: after.netC, refundsC: after.refundsC, reviewC: after.reviewC, reviewN: after.reviewN, linkSalesC: after.linkSalesC, outstandingC: after.outstandingC },
    rows: rows.map((r) => ({ ...r, reason: why[r.ref] || '' })),
  };
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  let b = {}; try { b = await request.json(); } catch (e) { return json({ error: 'Invalid request.' }, 400); }
  const actor = 'owner';
  const store = db(env) ? 'd1' : 'kv';
  if (db(env)) { try { await ensureMoneySchema(db(env)); } catch (e) { return json({ error: 'The owner database could not be opened: ' + clamp(e && e.message, 120) }, 503); } }
  switch (String(b.action || '')) {
    case 'summary': {
      const { rows } = await everything(env);
      const f = filterRows(rows, range(b));
      let recon = null; try { recon = JSON.parse((await env.mydukapos_kv.get(RECON_KEY)) || 'null'); } catch (e) { recon = null; }
      return json({ ok: true, store, summary: summarize(f), allTime: range(b).from || range(b).to ? summarize(rows) : undefined, definitions: DEFINITIONS, kinds: KINDS, reconciled: recon ? { at: recon.at, before: recon.before, after: recon.after } : null,
        recent: rows.filter((r) => r.status === 'success' && KINDS[r.kind] && KINDS[r.kind].money).slice(0, 8), attention: rows.filter((r) => r.status === 'pending' || r.status === 'review' || r.status === 'failed').slice(0, 12) });
    }
    case 'list': {
      const { rows } = await everything(env, { withRequests: b.requests !== false });
      const f = filterRows(rows, { ...range(b), kind: clamp(b.kind, 30), status: clamp(b.status, 30), q: clamp(b.q, 80), clientId: clamp(b.clientId, 80) });
      const offset = Math.max(0, Number(b.offset) || 0), limit = b.all ? f.length : Math.min(200, Math.max(1, Number(b.limit) || 50));
      const refunded = {}; for (const r of rows) if (r.kind === 'refund' && r.status === 'success' && r.related_ref) refunded[r.related_ref] = (refunded[r.related_ref] || 0) + (Number(r.amount_c) || 0);
      return json({ ok: true, store, total: f.length, summary: summarize(f), rows: f.slice(offset, offset + limit).map((r) => ({ ...r, refunded_c: refunded[r.ref] || 0 })) });
    }
    case 'links': {
      const { rows, summaries } = await everything(env);
      const per = {};
      for (const r of rows) {
        if (!(r.kind === 'link_sale' || r.kind === 'branch_sale') || !r.client_id) continue;
        const p = per[r.client_id] || (per[r.client_id] = { paidC: 0, refs: [], status: '' });
        if (r.status === 'success') { p.paidC += Number(r.amount_c) || 0; p.refs.push(r.ref); p.status = 'paid'; }
        else if (r.status === 'complimentary' && !p.status) p.status = 'complimentary';
        else if (r.status === 'pending' && p.status !== 'paid') p.status = 'pending';
        else if (r.status === 'review' && !p.status) p.status = 'review';
      }
      const list = summaries.filter((c) => !c.deleted && c.source !== 'shared-demo').map((c) => ({
        id: c.id, name: c.businessName || c.label || c.slug || c.id, clientName: c.clientName || '', slug: c.slug || '', product: c.product, type: c.type, source: c.source || '', createdAt: c.createdAt || 0, confirmedAt: c.confirmedAt || 0,
        locked: !!c.locked, valid: c.valid !== false, phone: c.phone || '', payment: per[c.id] ? per[c.id].status : (c.type === 'permanent' ? 'none' : 'demo'), paidC: per[c.id] ? per[c.id].paidC : 0, refs: per[c.id] ? per[c.id].refs : [],
      }));
      return json({ ok: true, links: list });
    }
    case 'record': {
      const kind = KINDS[b.kind] && b.kind !== 'refund' ? b.kind : null;
      if (!kind) return json({ error: 'Choose what this payment was for.' }, 400);
      const key = clamp(b.key, 60); if (!/^[A-Za-z0-9_-]{8,60}$/.test(key)) return json({ error: 'Missing form key - reload the page and try again.' }, 400);
      const amountC = toCents(b.amount);
      if (kind !== 'charge' && !(amountC > 0)) return json({ error: 'Enter the amount received (more than 0).' }, 400);
      if (kind === 'charge' && !(amountC > 0)) return json({ error: 'Enter the amount agreed.' }, 400);
      if (amountC > 100000000) return json({ error: 'That amount is too large.' }, 400);
      const note = clamp(b.note, 300); if (!note) return json({ error: 'Write a short description (what it was for).' }, 400);
      const method = ['mpesa', 'cash', 'bank', 'card', 'other'].includes(b.method) ? b.method : 'other';
      const receipt = clamp(b.receipt, 40).toUpperCase();
      if (method === 'mpesa' && kind !== 'charge' && !receipt) return json({ error: 'Enter the M-Pesa code, so the same payment can never be counted twice.' }, 400);
      const date = b.date ? Date.parse(String(b.date)) : Date.now();
      if (!Number.isFinite(date) || date > Date.now() + 86400000) return json({ error: 'Enter a valid date (not in the future).' }, 400);
      const summaries = await listClientSummaries(env, {}).catch(() => []);
      const client = b.clientId ? summaries.find((c) => c.id === b.clientId) : null;
      if (b.clientId && !client) return json({ error: 'That link was not found.' }, 404);
      if ((kind === 'link_sale' || kind === 'branch_sale') && !client) return json({ error: 'Choose the link this sale is for.' }, 400);
      const ref = (kind === 'charge' ? 'charge:' : 'manual:') + key;
      const prior = await getRow(env, ref);
      if (prior) return json({ ok: true, dup: true, row: prior });                       // the same form sent twice: nothing new
      const chargeRef = clamp(b.chargeRef, 200);
      let charge0 = null;
      if (chargeRef) { charge0 = await getRow(env, chargeRef); if (!charge0 || charge0.kind !== 'charge') return json({ error: 'That agreed amount was not found.' }, 404); }
      const towardsAgreed = !!(charge0 && client && charge0.client_id === client.id);        // a balance paid on THIS link's agreed amount is not a second sale
      if ((kind === 'link_sale' || kind === 'branch_sale') && b.separate !== true && !towardsAgreed) {
        const existing = (await listAll(env)).find((r) => r.client_id === client.id && (r.kind === 'link_sale' || r.kind === 'branch_sale') && (r.status === 'success' || r.status === 'review'));
        if (existing) return json({ error: `This link already has a sale recorded (${(existing.amount_c / 100).toLocaleString('en-KE')} KES on ${new Date(existing.created_at).toLocaleDateString('en-GB')}, ${existing.source === 'gateway' ? 'confirmed by the payment gateway' : existing.source}). Only record it again if this is a DIFFERENT payment.`, needSeparate: true, existing: existing.ref }, 409);
      }
      if (b.separate === true && !clamp(b.separateReason, 200)) return json({ error: 'Say why this is a separate payment.' }, 400);
      const row = { ref, kind, client_id: client ? client.id : '', group_key: nameKey(client ? client.clientName : b.groupKey), label: client ? (client.businessName || client.label || client.id) : clamp(b.label, 120), amount_c: amountC,
        status: kind === 'charge' ? 'open' : 'success', method, provider: 'manual', provider_ref: kind === 'charge' ? '' : receipt, verified: 0, source: 'manual', related_ref: chargeRef, created_at: date, confirmed_at: kind === 'charge' ? null : Date.now(),
        note: note + (b.separate === true ? ' [separate payment: ' + clamp(b.separateReason, 200) + ']' : ''), actor, meta: { enteredAt: Date.now() } };
      const r = await recordMoney(env, row);
      let charge = null;
      const agreedC = toCents(b.agreed);
      if (r.inserted && kind !== 'charge' && agreedC > amountC && !chargeRef) {
        const cref = 'charge:' + key;
        charge = (await recordMoney(env, { ...row, ref: cref, kind: 'charge', amount_c: agreedC, status: 'open', provider_ref: '', related_ref: '', confirmed_at: null, note: 'Amount agreed: ' + note })).row;
        await linkToCharge(env, ref, cref);
      }
      const saved = await getRow(env, ref);
      return json({ ok: true, row: saved, charge, review: saved && saved.status === 'review' });
    }
    case 'status': {
      const ref = clamp(b.ref, 200), row = await getRow(env, ref);
      if (!row) return json({ error: 'No such entry.' }, 404);
      if (row.verified) return json({ error: 'A payment confirmed by the payment gateway cannot be excluded. If the money went back, record a refund.' }, 400);
      const to = String(b.status || '');
      const allowed = { review: ['success', 'excluded'], success: ['excluded'], excluded: ['success'], open: ['cancelled'], pending: ['cancelled'] };
      if (!(allowed[row.status] || []).includes(to)) return json({ error: `An entry that is "${row.status}" cannot be changed to "${to}".` }, 400);
      const r = await setStatus(env, ref, to, { actor, reason: b.reason });
      return json(r, r.ok ? 200 : 400);
    }
    case 'refund': {
      const ref = clamp(b.ref, 200), row = await getRow(env, ref);
      if (!row || !KINDS[row.kind] || !KINDS[row.kind].money || row.status !== 'success') return json({ error: 'Only a counted payment can be refunded.' }, 400);
      const reason = clamp(b.reason, 300); if (!reason) return json({ error: 'Give the reason for the refund.' }, 400);
      if (b.confirm !== true) return json({ needConfirm: true, summary: [`Record that ${(row.amount_c / 100).toLocaleString('en-KE')} KES (or part of it) was returned to ${row.label || 'the client'}. The original payment stays in the record; the refund is subtracted from net revenue. Access is not changed.`] }, 409);
      let meta = {}; try { meta = JSON.parse(row.meta_json || '{}'); } catch (e) { meta = {}; }
      if (meta.billing) {                                                                // a billing-ledger payment: the billing reversal (it also voids an unused referral reward)
        const r = await reversePayment(env, ref, actor, { note: reason });
        return json(r.ok ? { ok: true, dup: !!r.dup, via: 'billing' } : r, r.ok ? 200 : 400);
      }
      const all = await listAll(env);
      const already = all.filter((x) => x.kind === 'refund' && x.status === 'success' && x.related_ref === ref).reduce((a, x) => a + (Number(x.amount_c) || 0), 0);
      const amt = b.amount ? toCents(b.amount) : row.amount_c - already;
      if (!(amt > 0) || amt > row.amount_c - already) return json({ error: `The refund must be between 1 and ${((row.amount_c - already) / 100).toLocaleString('en-KE')} KES.` }, 400);
      const key = clamp(b.key, 60); if (!/^[A-Za-z0-9_-]{8,60}$/.test(key)) return json({ error: 'Missing form key - reload the page and try again.' }, 400);
      const r = await recordMoney(env, { ref: 'refund:' + key, kind: 'refund', client_id: row.client_id, group_key: row.group_key, label: row.label, amount_c: amt, status: 'success', method: clamp(b.method, 20) || row.method, provider: 'manual', provider_ref: '', verified: 0, source: 'manual', related_ref: ref, created_at: Date.now(), confirmed_at: Date.now(), note: reason, actor, meta: {} });
      return json({ ok: true, dup: !r.inserted, row: r.row || r.existing });
    }
    case 'reconcile-preview': {
      const rep = await buildReconciliation(env, b.sales);
      const existing = new Set((await listAll(env)).map((r) => r.ref));
      return json({ ok: true, store, ...rep, rows: rep.rows.map((r) => ({ ...r, already: existing.has(r.ref) })) });
    }
    case 'reconcile-apply': {
      if (b.confirm !== true) return json({ needConfirm: true }, 409);
      const before = summarize(await listAll(env));
      const rep = await buildReconciliation(env, b.sales);
      let added = 0, kept = 0;
      for (const r of rep.rows) { const { reason, ...row } = r; row.note = clamp((reason ? reason + ' ' : '') + (row.note || ''), 600); const x = await recordMoney(env, row); if (x.inserted) added++; else kept++; }
      const after = summarize(await listAll(env));
      const snap = { at: Date.now(), actor, before: rep.before, recordBefore: { collectedC: before.collectedC }, after: { collectedC: after.collectedC, netC: after.netC, reviewC: after.reviewC, reviewN: after.reviewN, linkSalesC: after.linkSalesC, outstandingC: after.outstandingC }, added, kept, salesRead: rep.salesRead, eventsRead: rep.eventsRead, serverRead: rep.serverRead };
      await env.mydukapos_kv.put(RECON_KEY, JSON.stringify(snap));
      try { if (db(env)) await db(env).prepare(`INSERT INTO owner_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind('recon:' + snap.at, JSON.stringify(snap)).run(); } catch (e) { /* the KV copy is enough */ }
      return json({ ok: true, ...snap });
    }
    case 'log': return json({ ok: true, rows: await listLog(env, { limit: Number(b.limit) || 150 }) });
    default: return json({ error: 'Unknown action.' }, 400);
  }
}
