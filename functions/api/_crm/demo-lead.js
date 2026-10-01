// functions/api/_crm/demo-lead.js — website registrations / demo requests (functions/api/demo-account.js) -> CRM leads (NOT a route).
// Two users: demo-account.js pushes each NEW registration / demo request as it happens (best-effort, never breaks the signup), and legacy.js maps the
// old Owner Console "Website leads / Web signups" list (KV demo-account-index:v1) with the SAME identity ('demo:<email>'), so a person who is both
// pushed live and migrated later is one lead, never two.
import { ledgerDb } from '../_ledger.js';
import { ensureCrmSchema } from './schema.js';
import { cleanContact, createLeadCore, recordTouch, findDuplicates } from './leads.js';
import { attrFromInput } from './attribution.js';
import { text, first, st, now } from './core.js';

export const demoLegacyId = (email, phone) => {
  const e = String(email || '').trim().toLowerCase();
  if (e) return 'demo:' + e;
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 7 ? 'demo:tel:' + d.slice(-9) : null;
};

// the human-readable note lines shared by the live push and the migration
export function demoNotes({ product, branchName, demoStatus, generatedAt, expiresAt, registeredOnly }) {
  const iso = (t) => (Number.isFinite(Number(t)) && Number(t) > 0 ? new Date(Number(t)).toISOString() : null);
  return [
    registeredOnly ? 'Website account: registered, no demo yet' : 'Website demo request',
    product ? `Product: ${product}` : null, branchName ? `Branch / business name: ${branchName}` : null,
    !registeredOnly && demoStatus ? `Demo status: ${demoStatus}` : null, iso(generatedAt) ? `Demo generated: ${iso(generatedAt)}` : null, iso(expiresAt) ? `Demo expires: ${iso(expiresAt)}` : null,
  ].filter(Boolean).join('\n');
}

// Best-effort: never throws. -> { ok, action: 'created'|'touched'|'skipped', reason? }
export async function pushWebsiteLead(env, { fullName, phone, email, product, businessName, kind, attrInput, expiresAt }) {
  try {
    const db = ledgerDb(env);
    if (!db) return { ok: false, action: 'skipped', reason: 'no_db' };
    await ensureCrmSchema(db);
    const { fields } = cleanContact({ name: fullName, phone, email, businessName });      // an unusable phone / email is simply left out (errors ignored on purpose)
    if (!fields.name) fields.name = text(fullName, 120) || fields.phone || fields.email || 'Website visitor';
    const requested = kind === 'demo';
    const attr = attrFromInput(attrInput || {});
    let productIds = [];
    const pk = text(product, 40);
    if (pk) { const p = await first(db, `SELECT id FROM crm_products WHERE active = 1 AND key = ?`, pk); if (p) productIds = [p.id]; }
    const summary = requested ? `Requested a website demo${pk ? ' of ' + pk : ''}${businessName ? ' for ' + text(businessName, 120) : ''}` : 'Registered a website account again';
    const dups = await findDuplicates(db, fields);
    if (dups.length) {
      const row = dups[0].row, t = now();
      await recordTouch(db, row, { attr, kind: 'form', sourceKey: 'signup', summary });
      if (productIds.length) await st(db, `INSERT OR IGNORE INTO crm_lead_products (lead_id, product_id, added_at, added_by) VALUES (?,?,?,NULL)`, row.id, productIds[0], t).run();
      return { ok: true, action: 'touched' };
    }
    fields.notes = demoNotes({ product: pk, branchName: text(businessName, 160), demoStatus: requested ? 'active' : null, generatedAt: requested ? now() : null, expiresAt, registeredOnly: !requested });
    await createLeadCore(db, null, { fields, attr, sourceKey: 'signup', productIds }, {
      legacyId: demoLegacyId(fields.email, fields.phone_norm), attrKind: 'form', createdByName: 'Website signup', auditAction: 'lead_create_website',
      activityText: requested ? 'Website signup with a demo request' : 'Website signup (registered, no demo yet)',
    });
    return { ok: true, action: 'created' };
  } catch (e) {
    console.error('demo lead -> crm', e && e.message || e);
    return { ok: false, action: 'skipped', reason: 'error' };
  }
}
