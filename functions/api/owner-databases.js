// functions/api/owner-databases.js — Cloudflare Pages Function (Owner Console, owner session required). zip 194.
//
// The "Databases" card of the Owner Console's Storage tab: monitor EVERY database and clean up. (/api/owner-storage is the older per-SHOP size / archive
// endpoint and is unchanged; this one is about the databases themselves.)
//
//   GET                                   -> the report (see buildReport in _storage-report.js): { settings, limit, stores:[{ id, name, kind, bound, sizeBytes|null,
//                                            sizeReason, limitBytes, pctUsed, tables:[{ name, rows, bytes|null }], groups }], categories, lastCleanup, backups }
//   POST { action: 'save-settings', limitGb?, retention?: { audit, batches, shop_backups }, autoCleanup?, autoBackup? }  -> { ok, settings }
//   POST { action: 'cleanup' }            -> { ok, result: { archived, removed, results:[{ id, archived, removed, skipped?, error? }], errors } }
//   POST { action: 'backup-now' }         -> { ok, backup: { ok, rows, bytes, dbs, error? } }     (409 when no R2 bucket is bound)
//
// Same owner session check as every owner endpoint (requireOwnerAuth). Nothing a shop or staff member can reach calls this.
import { requireOwnerAuth } from './_owner-auth.js';
import { buildReport, saveSettings, runCleanup, backupNow } from './_storage-report.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

export async function onRequestGet(context) {
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  try { return json(await buildReport(context.env)); }
  catch (e) { return json({ error: 'The report could not be built: ' + String((e && e.message) || e).slice(0, 200) }, 500); }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid request body.' }, 400); }
  const action = body && body.action;
  try {
    if (action === 'save-settings') {
      const r = await saveSettings(env, body);
      if (r.error) return json({ error: r.error }, r.error.startsWith('Settings could not') ? 500 : 400);
      return json({ ok: true, settings: r.settings, savedIn: r.savedIn });
    }
    if (action === 'cleanup') {
      const result = await runCleanup(env, { trigger: 'manual' });
      return json({ ok: result.ok, result });
    }
    if (action === 'backup-now') {
      const backup = await backupNow(env, { trigger: 'manual' });
      if (backup.notConfigured) return json({ error: backup.error, backup }, 409);
      return json({ ok: backup.ok, backup });
    }
  } catch (e) { return json({ error: String((e && e.message) || e).slice(0, 300) }, 500); }
  return json({ error: 'Unknown action.' }, 400);
}
