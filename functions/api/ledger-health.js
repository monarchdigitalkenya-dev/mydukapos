// functions/api/ledger-health.js — Cloudflare Pages Function (Owner Console). zip 186: the audit table health check (incident: 21.8M audit rows).
//
//   GET  /api/ledger-health                 (owner signed in)  -> ledger_audit approximate rows (MAX(id)), rows/min + rows in the last hour (estimate),
//                                              the 5 busiest records / shops over the newest 5000 ids, database size and % of the 10 GB cap (when D1 reports it),
//                                              the kill switch / prune flag, the daily watchdog's last alert.   Read-only, bounded (a few indexed queries).
//   POST /api/ledger-health { audit: 'off' | 'on' }   (owner signed in)  -> the AUDIT KILL SWITCH (ledger_meta audit_disabled): records and sales are still
//                                              saved, only the audit history rows are skipped while it is 'off'. Every change is itself logged in ledger_meta.
import { requireOwnerAuth } from './_owner-auth.js';
import { ledgerDb } from './_ledger.js';
import { auditDb } from './_audit-db.js';
import { ledgerHealth, readAlert } from './_ledger-health.js';
import { isStorageFull } from './_retry.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function onRequestGet(context) {
  const { env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  const db = ledgerDb(env);
  if (!db) return json({ error: 'The transaction database (D1) is not connected to this deployment.', code: 'no_d1' }, 503);
  try {
    const h = await ledgerHealth(db, { auditDb: auditDb(env) });
    h.alert = await readAlert(db);
    return json({ ok: true, ...h });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e).slice(0, 200), ...(isStorageFull(e) ? { code: 'storage_full' } : {}) }, 503);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  const db = ledgerDb(env);
  if (!db) return json({ error: 'The transaction database (D1) is not connected to this deployment.', code: 'no_d1' }, 503);
  let body = null;
  try { body = await request.json(); } catch (e) { body = null; }
  const want = body && body.audit;
  if (want !== 'off' && want !== 'on') return json({ error: "Send { audit: 'off' } or { audit: 'on' }." }, 400);
  try {
    await db.prepare(`INSERT INTO ledger_meta (k, v) VALUES ('audit_disabled', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(want === 'off' ? '1' : '0').run();
    await db.prepare(`INSERT INTO ledger_meta (k, v) VALUES ('audit_disabled_at', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(`${new Date().toISOString()} ${want}`).run();
    return json({ ok: true, audit: want, note: want === 'off' ? 'Audit rows are NOT being written. Records and sales are still saved. Turn it back on once the cause is fixed.' : 'Audit rows are being written again.' });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e).slice(0, 200), ...(isStorageFull(e) ? { code: 'storage_full' } : {}) }, isStorageFull(e) ? 507 : 503);
  }
}
