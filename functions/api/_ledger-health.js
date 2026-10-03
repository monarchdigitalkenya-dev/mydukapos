// functions/api/_ledger-health.js — shared helper, NOT a route. (zip 186, incident: ledger_audit grew to 21.8M rows / the 10 GB D1 cap)
//
// A cheap, READ-ONLY, bounded health reading of the D1 ledger, used by GET /api/ledger-health (owner) and by the router Worker's daily size watchdog.
// Nothing here scans ledger_audit: a COUNT(*) over millions of rows is far too slow, so rows are estimated from the id range (MAX(id) - MIN(id) + 1: an UPPER BOUND
// once old rows have been pruned) and the write rate from ONE probe row 5000 ids back. Every query is a rowid seek or a scan of at most SAMPLE rows.
export const D1_CAP_BYTES = 10 * 1000 * 1000 * 1000;                 // Cloudflare D1: 10 GB per database (size_after 9999998976 was "full")
export const SAMPLE_ROWS = 5000;
export const WARN_PCT = 60, CRIT_PCT = 80;
export const GROWTH_WARN_PER_MIN = 3000;                              // rows/min: a busy night is a few hundred; the incident was ~5000/min

export async function ledgerHealth(db, { now = Date.now(), sample = SAMPLE_ROWS, auditDb = null } = {}) {
  const t0 = Date.now();
  const adb = auditDb || null;                                        // zip 187: the separate audit database, when bound: the audit figures come from it, the size of the SALES database from db
  const out = { at: now, auditRows: null, auditMaxId: null, auditMinId: null, ratePerMin: null, rowsLastHourEstimate: null, topRecords: [], topTenants: [], sizeBytes: null, pctOfCap: null, flags: {}, level: 'ok', notes: [] };
  const qdb = adb || db;
  if (adb) out.auditSeparate = true;
  let rng;
  try { rng = await qdb.prepare(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM ledger_audit`).all(); }
  catch (e) { if (!adb) throw e; rng = { results: [], meta: null }; out.auditError = String((e && e.message) || e).slice(0, 120); }     // audit DB not created yet / unreachable: the sales database's figures still come back
  const r0 = (rng.results && rng.results[0]) || {};
  out.auditMinId = r0.lo == null ? null : Number(r0.lo); out.auditMaxId = r0.hi == null ? null : Number(r0.hi);
  out.auditRows = out.auditMaxId == null ? 0 : out.auditMaxId - out.auditMinId + 1;
  out.auditRowsIsUpperBound = true;
  if (rng.meta && Number(rng.meta.size_after) > 0) {
    const b = Number(rng.meta.size_after), pc = Math.round((b / D1_CAP_BYTES) * 1000) / 10;
    if (adb) { out.auditSizeBytes = b; out.auditPctOfCap = pc; } else { out.sizeBytes = b; out.pctOfCap = pc; }
  }
  if (out.auditMaxId != null) {
    const from = Math.max(out.auditMinId, out.auditMaxId - sample);
    const probe = await qdb.prepare(`SELECT id, at FROM ledger_audit WHERE id >= ? ORDER BY id LIMIT 1`).bind(from).first();
    if (probe && probe.at) {
      const secs = Math.max(1, (now - Number(probe.at)) / 1000), rows = out.auditMaxId - Number(probe.id);
      if (rows > 0) { out.ratePerMin = Math.round((rows / secs) * 60); out.rowsLastHourEstimate = Math.min(out.auditRows, Math.round((rows / secs) * 3600)); }
      else { out.ratePerMin = 0; out.rowsLastHourEstimate = 0; }
    }
    // the busiest records / shops over the newest `sample` ids (a rowid range scan: bounded)
    const lo = out.auditMaxId - sample;
    out.topRecords = ((await qdb.prepare(`SELECT client_id, kind, rec_id, COUNT(*) AS c, MAX(version) AS version FROM ledger_audit WHERE id > ? GROUP BY client_id, kind, rec_id ORDER BY c DESC LIMIT 5`).bind(lo).all()).results) || [];
    out.topTenants = ((await qdb.prepare(`SELECT client_id, COUNT(*) AS c FROM ledger_audit WHERE id > ? GROUP BY client_id ORDER BY c DESC LIMIT 5`).bind(lo).all()).results) || [];
  }
  try {
    const fl = await db.prepare(`SELECT k, v FROM ledger_meta WHERE k IN ('audit_disabled', 'audit_prune_open', 'schema')`).all();
    for (const r of fl.results || []) out.flags[r.k] = r.v;
    if (adb && fl.meta && Number(fl.meta.size_after) > 0) { out.sizeBytes = Number(fl.meta.size_after); out.pctOfCap = Math.round((out.sizeBytes / D1_CAP_BYTES) * 1000) / 10; }
  } catch (e) { /* ledger_meta missing: flags stay empty */ }
  out.auditDisabled = out.flags.audit_disabled === '1';
  out.pruneOpen = out.flags.audit_prune_open === '1';
  out.schema = out.flags.schema == null ? null : Number(out.flags.schema);
  Object.assign(out, classify(out));
  out.ms = Date.now() - t0;
  return out;
}

// -> { level: 'ok' | 'warning' | 'critical', notes: [...] }   (60% / 80% of the cap, runaway growth, audit switched off, prune flag left open, old triggers)
export function classify(h) {
  const notes = []; let level = 'ok';
  const bump = (l) => { if (l === 'critical' || (l === 'warning' && level === 'ok')) level = l; };
  if (h.pctOfCap != null) {
    if (h.pctOfCap >= CRIT_PCT) { bump('critical'); notes.push(`database is ${h.pctOfCap}% of the 10 GB cap`); }
    else if (h.pctOfCap >= WARN_PCT) { bump('warning'); notes.push(`database is ${h.pctOfCap}% of the 10 GB cap`); }
  }
  if (h.auditPctOfCap != null) {                                       // the audit database (zip 187): a warning only - selling does not depend on it
    if (h.auditPctOfCap >= CRIT_PCT) { bump('warning'); notes.push(`the AUDIT database is ${h.auditPctOfCap}% of its 10 GB cap: prune it (node tools\\prune-audit.mjs --db mydukapos-audit); sales are not affected`); }
    else if (h.auditPctOfCap >= WARN_PCT) { bump('warning'); notes.push(`the AUDIT database is ${h.auditPctOfCap}% of its 10 GB cap`); }
  }
  if (h.ratePerMin != null && h.ratePerMin >= GROWTH_WARN_PER_MIN) { bump('warning'); notes.push(`ledger_audit is growing at about ${h.ratePerMin} rows/min`); }
  if (h.auditDisabled) { bump('warning'); notes.push('audit writes are switched OFF (ledger_meta audit_disabled=1): turn them back on once the cause is fixed'); }
  if (h.pruneOpen) { bump('warning'); notes.push('the audit prune flag is OPEN (ledger_meta audit_prune_open=1): close it - audit rows older than 10 minutes can be deleted while it is'); }
  if (h.schema != null && h.schema < 3) { bump('warning'); notes.push('migration 0007 (quiet audit triggers) is not applied'); }
  return { level, notes };
}

// Remember the reading as ledger_meta 'size_alert' (the owner console / the health endpoint show it). Best effort: a FULL database cannot take this write.
export async function saveAlert(db, h) {
  const v = JSON.stringify({ at: h.at, level: h.level, notes: h.notes, pctOfCap: h.pctOfCap, auditRows: h.auditRows, ratePerMin: h.ratePerMin });
  await db.prepare(`INSERT INTO ledger_meta (k, v) VALUES ('size_alert', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(v).run();
}
export async function readAlert(db) {
  try { const r = await db.prepare(`SELECT v FROM ledger_meta WHERE k = 'size_alert'`).first(); return r && r.v ? JSON.parse(r.v) : null; } catch (e) { return null; }
}
