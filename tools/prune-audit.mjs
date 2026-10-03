#!/usr/bin/env node
// tools/prune-audit.mjs — zip 186. INCIDENT TOOL: remove the RETRY-STORM DUPLICATES from ledger_audit (21.8M rows / 10 GB), safely and resumably.
//
//   node tools\prune-audit.mjs --measure             read-only: where the rows are (busiest records, rows carrying a retry counter) per id range
//   node tools\prune-audit.mjs --dry-run             read-only: how many rows each chunk WOULD delete
//   node tools\prune-audit.mjs --run                 deletes (asks you to type YES; --yes skips the question)       (wrapper: tools\prune-audit.cmd)
//
//   options: --db mydukapos-ledger  --local (use the local database, default is --remote)  --chunk 100000  --from-id N (resume)  --to-id N
//            --strategy dups|retries|both (default both)  --global-dups (afterwards, collapse the hottest groups that span chunks)
//            --backup-dir backup  --min-age-min 10 (never lower than 10)  --sample-every 1 (--measure: look at every Nth chunk)  --sleep-ms 0
//
// WHAT IT DELETES (and nothing else): ledger_audit rows that are duplicates made by resending the same record:
//   * "dups": inside one id chunk, every row except the FIRST (MIN id) of a group of rows with the same (client_id, kind, rec_id, version, action, status, amount)
//     AND the same snapshot once the retry counters (`tries` ...) are removed. (Stricter than the bare key in the incident brief: two rows that share a version but
//     differ in content are a real change and are both kept.)
//   * "retries": a row whose snapshot carries `tries` > 1 that is NOT the first row of its group in the chunk.
//   * never a row younger than --min-age-min (10) minutes; never any other table; every statement is limited to ONE id range (a primary-key scan, quick).
// Because every group keeps its first row per chunk, a group that spans several chunks keeps one row per chunk; --global-dups collapses the hottest of them.
//
// HOW THE DELETE GUARD IS HANDLED (a trigger refuses every DELETE on ledger_audit: 'financial records are never deleted'):
//   SAFE path      migration 0007 is applied (the trigger SQL mentions audit_prune_open): set ledger_meta audit_prune_open='1', prune, set it back to '0' (finally).
//   EMERGENCY path migration 0007 is NOT applied: the exact trigger SQL is saved to <backup-dir>\ledger_audit_delete_guard.sql, the trigger is DROPPED, the prune runs,
//                  and the trigger is RE-CREATED from the saved file in a `finally` (also on Ctrl+C / any error) and verified. If that fails, it tells you the exact command.
// If D1 answers SQLITE 7500 (database full) it stops: even DROP TRIGGER / the flag need a free page; see the Time Travel advice it prints.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULTS = { db: 'mydukapos-ledger', chunk: 100000, minAgeMin: 10, backupDir: 'backup', strategy: 'both', sampleEvery: 1, sleepMs: 0, topGroups: 20 };
export const GUARD_TRIGGER = 'no_delete_ledger_audit';
export const GUARD_FILE = 'ledger_audit_delete_guard.sql';
export const BOOKMARK = '0000005a-00000274-000050f8-0eab0f524911cea51e06be55e8214cef';       // Time Travel bookmark from the incident brief (2026-10-03 00:09 EAT)
export const VOLATILE = ['tries', '_tries', 'retries', 'retryCount', '_retryCount', 'lastTryAt'];

// ---------- argument parsing ----------
export function parseArgs(argv) {
  const o = { mode: null, db: DEFAULTS.db, remote: true, chunk: DEFAULTS.chunk, fromId: null, toId: null, strategy: DEFAULTS.strategy, globalDups: false, yes: false, backupDir: DEFAULTS.backupDir, minAgeMin: DEFAULTS.minAgeMin, sampleEvery: DEFAULTS.sampleEvery, sleepMs: DEFAULTS.sleepMs, maxChunks: Infinity, errors: [], help: false };
  const num = (name, v, min, max = Infinity) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) { o.errors.push(`${name} needs a whole number from ${min}${Number.isFinite(max) ? ' to ' + max : ''} (got "${v}")`); return null; } return n; };
  const modes = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v == null || v.startsWith('--')) { o.errors.push(`${a} needs a value`); return null; } return v; };
    const eq = a.indexOf('=') > 0 && a.startsWith('--') ? a.slice(a.indexOf('=') + 1) : null;
    const name = eq != null ? a.slice(0, a.indexOf('=')) : a;
    const get = () => (eq != null ? eq : val());
    switch (name) {
      case '--measure': modes.push('measure'); break;
      case '--dry-run': modes.push('dry-run'); break;
      case '--run': modes.push('run'); break;
      case '--yes': case '-y': o.yes = true; break;
      case '--global-dups': o.globalDups = true; break;
      case '--local': o.remote = false; break;
      case '--remote': o.remote = true; break;
      case '--help': case '-h': o.help = true; break;
      case '--db': { const v = get(); if (v != null) { if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) o.errors.push(`--db "${v}" is not a database name`); else o.db = v; } break; }
      case '--chunk': { const v = num('--chunk', get(), 1000, 1000000); if (v != null) o.chunk = v; break; }
      case '--from-id': { const v = num('--from-id', get(), 0); if (v != null) o.fromId = v; break; }
      case '--to-id': { const v = num('--to-id', get(), 0); if (v != null) o.toId = v; break; }
      case '--min-age-min': { const v = num('--min-age-min', get(), 10); if (v != null) o.minAgeMin = v; break; }
      case '--sample-every': { const v = num('--sample-every', get(), 1); if (v != null) o.sampleEvery = v; break; }
      case '--sleep-ms': { const v = num('--sleep-ms', get(), 0, 60000); if (v != null) o.sleepMs = v; break; }
      case '--max-chunks': { const v = num('--max-chunks', get(), 1); if (v != null) o.maxChunks = v; break; }
      case '--backup-dir': { const v = get(); if (v != null) o.backupDir = v; break; }
      case '--strategy': { const v = get(); if (v != null) { if (!['dups', 'retries', 'both'].includes(v)) o.errors.push(`--strategy must be dups, retries or both (got "${v}")`); else o.strategy = v; } break; }
      default: o.errors.push(`unknown option ${a}`);
    }
  }
  if (modes.length > 1) o.errors.push(`choose ONE of --measure, --dry-run, --run (got ${modes.join(', ')})`);
  o.mode = modes[0] || null;
  if (!o.mode && !o.help) o.errors.push('choose one of --measure, --dry-run, --run');
  if (o.fromId != null && o.toId != null && o.fromId > o.toId) o.errors.push('--from-id is after --to-id');
  return o;
}
export const USAGE = `Usage: node tools\\prune-audit.mjs (--measure | --dry-run | --run) [--db NAME] [--local] [--chunk 100000] [--from-id N] [--to-id N]
       [--strategy dups|retries|both] [--global-dups] [--backup-dir backup] [--min-age-min 10] [--sample-every N] [--sleep-ms N] [--yes]`;

// ---------- chunking ----------
// Inclusive id ranges [a, b] of `size` ids covering from..to, oldest first.
export function chunkRanges(from, to, size) {
  const out = [];
  if (!(Number.isFinite(from) && Number.isFinite(to)) || to < from || !(size > 0)) return out;
  for (let a = from; a <= to; a += size) out.push([a, Math.min(to, a + size - 1)]);
  return out;
}
export const nextChunkStart = (b) => b + 1;

// ---------- SQL generation (everything is literal: wrangler --command cannot bind; no double quotes, %, ^, & or | so it is safe inside cmd.exe "..." ) ----------
export const sqlLit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/'/g, "''").replace(/[\r\n]+/g, ' ')}'`);
const int = (n) => { const x = Math.trunc(Number(n)); if (!Number.isFinite(x)) throw new Error('not a number: ' + n); return x; };
const RM = VOLATILE.map((f) => `'$.${f}'`).join(', ');
// the snapshot with the retry counters removed (only when it is JSON: a stub or a legacy value is compared as it is)
export const SNAP_NORM = `CASE WHEN json_valid(snapshot) THEN json_remove(snapshot, ${RM}) ELSE snapshot END`;
const TRIES = `CASE WHEN json_valid(snapshot) THEN json_extract(snapshot, '$.tries') END`;
const GROUP_BY = `client_id, kind, rec_id, version, action, status, amount, ${SNAP_NORM}`;
const firstOfGroup = (a, b) => `SELECT MIN(id) FROM ledger_audit WHERE id BETWEEN ${int(a)} AND ${int(b)} GROUP BY ${GROUP_BY}`;

export const sql = {
  bounds: () => `SELECT MIN(id) AS lo, MAX(id) AS hi FROM ledger_audit`,
  // read-only distribution queries (brief A3), one id range at a time
  topGroups: (a, b, n = DEFAULTS.topGroups) => `SELECT client_id, kind, rec_id, COUNT(*) AS c, MAX(${TRIES}) AS max_tries FROM ledger_audit WHERE id BETWEEN ${int(a)} AND ${int(b)} GROUP BY client_id, kind, rec_id ORDER BY c DESC LIMIT ${int(n)}`,
  retryShare: (a, b) => `SELECT SUM(CASE WHEN COALESCE(${TRIES}, 1) > 1 THEN 1 ELSE 0 END) AS retry_rows, COUNT(*) AS total FROM ledger_audit WHERE id BETWEEN ${int(a)} AND ${int(b)}`,
  dupShare: (a, b, cutoff) => `SELECT COUNT(*) AS dup_rows FROM ledger_audit WHERE id BETWEEN ${int(a)} AND ${int(b)} AND at < ${int(cutoff)} AND id NOT IN (${firstOfGroup(a, b)})`,
  // the predicate of what a chunk deletes, per strategy
  predicate: (a, b, cutoff, strategy) => {
    const base = `id BETWEEN ${int(a)} AND ${int(b)} AND at < ${int(cutoff)} AND id NOT IN (${firstOfGroup(a, b)})`;
    return strategy === 'retries' ? `${base} AND COALESCE(${TRIES}, 1) > 1` : base;           // 'dups' and 'both' = every non-first duplicate (a retry row IS one)
  },
  count: (a, b, cutoff, strategy) => `SELECT COUNT(*) AS n FROM ledger_audit WHERE ${sql.predicate(a, b, cutoff, strategy)}`,
  del: (a, b, cutoff, strategy) => `DELETE FROM ledger_audit WHERE ${sql.predicate(a, b, cutoff, strategy)}`,
  // --global-dups: the groups that are big inside a range, then one bounded delete per group through ix_ledger_audit_rec (client_id, kind, rec_id)
  hotGroups: (a, b, minCount = 50, n = 200) => `SELECT client_id, kind, rec_id, version, action, COUNT(*) AS c FROM ledger_audit WHERE id BETWEEN ${int(a)} AND ${int(b)} GROUP BY client_id, kind, rec_id, version, action HAVING COUNT(*) >= ${int(minCount)} ORDER BY c DESC LIMIT ${int(n)}`,
  delGroup: (g, cutoff) => {
    const w = `client_id = ${sqlLit(g.client_id)} AND kind = ${sqlLit(g.kind)} AND rec_id = ${sqlLit(g.rec_id)} AND version IS ${sqlLit(g.version == null ? null : Number(g.version))} AND action = ${sqlLit(g.action)}`;
    return `DELETE FROM ledger_audit WHERE ${w} AND at < ${int(cutoff)} AND id <> (SELECT MIN(id) FROM ledger_audit WHERE ${w})`;
  },
  guardSql: () => `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'ledger_audit' AND name = ${sqlLit(GUARD_TRIGGER)}`,
  allTriggers: () => `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'ledger_audit'`,
  dropGuard: () => `DROP TRIGGER IF EXISTS ${GUARD_TRIGGER}`,
  openFlag: () => `INSERT INTO ledger_meta (k, v) VALUES ('audit_prune_open', '1') ON CONFLICT (k) DO UPDATE SET v = '1'`,
  closeFlag: () => `INSERT INTO ledger_meta (k, v) VALUES ('audit_prune_open', '0') ON CONFLICT (k) DO UPDATE SET v = '0'`,
  readFlag: () => `SELECT v FROM ledger_meta WHERE k = 'audit_prune_open'`,
};
// 0007 is applied when the delete guard knows the flag
export const guardIsSafePath = (guardSqlText) => /audit_prune_open/.test(String(guardSqlText || ''));
export const oneLine = (s) => String(s).replace(/[\r\n\t]+/g, ' ');

// ---------- output of `wrangler d1 execute --json` ----------
export function parseWranglerJson(text) {
  const t = String(text || '');
  const i = t.search(/[\[{]/);
  if (i < 0) throw new Error('no JSON in the wrangler output: ' + t.slice(0, 200));
  const j = JSON.parse(t.slice(i, t.lastIndexOf(t[i] === '[' ? ']' : '}') + 1));
  const first = Array.isArray(j) ? j[0] : j;
  if (first && first.error) throw new Error(typeof first.error === 'string' ? first.error : JSON.stringify(first.error));
  const all = Array.isArray(j) ? j : [j];
  const changes = all.reduce((n, r) => n + (Number(r && r.meta && r.meta.changes) || 0), 0);
  return { results: (first && first.results) || [], meta: (first && first.meta) || {}, changes, all };
}
export const STORAGE_FULL = /\[7500\]|\b7500:|SQLITE[_ ]?7500|exceeded maximum db(?:atabase)? size|maximum database size|SQLITE_FULL|database or disk is full/i;
export const isStorageFull = (e) => STORAGE_FULL.test(String((e && e.message) || e || ''));
export const isTimeout = (e) => /timeout|timed out|too long|exceeded.*(time|cpu)|statement.*limit|SQLITE_TOOBIG|etimedout|network connection lost/i.test(String((e && e.message) || e || ''));
export const quoteArg = (s, win = process.platform === 'win32') => (win ? `"${String(s)}"` : String(s));

// The real executor: npx wrangler d1 execute <db> --remote --json --yes --command "<sql>" | --file <path>
export function makeWranglerExec({ db, remote = true, cwd = process.cwd(), spawnFn = spawn } = {}) {
  const win = process.platform === 'win32';
  const run = (extra) => new Promise((resolve, reject) => {
    const args = ['wrangler', 'd1', 'execute', db, remote ? '--remote' : '--local', '--json', '--yes', ...extra];
    const p = spawnFn('npx', args, { cwd, shell: win, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`wrangler exited ${code}: ${(err + out).trim().slice(0, 600)}`))));
  });
  return {
    sql: async (s) => parseWranglerJson(await run(['--command', quoteArg(oneLine(s), win)])),
    file: async (f) => parseWranglerJson(await run(['--file', quoteArg(f, win)])),
    // used only by the 2nd Ctrl+C: a blocking best-effort restore
    fileSync: (f) => { const r = spawnSync('npx', ['wrangler', 'd1', 'execute', db, remote ? '--remote' : '--local', '--json', '--yes', '--file', quoteArg(f, win)], { cwd, shell: win, encoding: 'utf8' }); return r.status === 0; },
  };
}

// ---------- advice texts ----------
export const adviceStorageFull = (db = DEFAULTS.db) => `
!!  D1 answered SQLITE 7500: the database is FULL. Nothing can be deleted or changed (not even DROP TRIGGER / the prune flag) while it is.
!!  Nothing was lost by this script. The way out is a Time Travel restore to a bookmark from BEFORE the explosion (it DISCARDS every write after that moment):
!!      npx wrangler d1 time-travel info ${db}
!!      npx wrangler d1 time-travel restore ${db} --bookmark=<a bookmark from before the runaway>        (the incident brief recorded ${BOOKMARK})
!!  Read docs\\INCIDENT_LEDGER_AUDIT_186.md first: tills that still hold unsynced sales will re-send them (the server is idempotent now).
!!  Time Travel prints the bookmark of the state it replaced, which can undo the restore.`;

// ---------- the runner (exec is injected: tests use node:sqlite, real runs use wrangler) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n0 = (v) => Number(v) || 0;

export async function getBounds(exec) {
  const r = (await exec.sql(sql.bounds())).results[0] || {};
  return { lo: r.lo == null ? null : Number(r.lo), hi: r.hi == null ? null : Number(r.hi) };
}

export async function measure(opts, exec, log = console.log) {
  const { lo, hi } = await getBounds(exec);
  if (lo == null) { log('ledger_audit is empty.'); return { rows: 0 }; }
  const from = opts.fromId != null ? opts.fromId : lo, to = opts.toId != null ? opts.toId : hi;
  log(`ledger_audit ids ${lo} .. ${hi} (about ${hi - lo + 1} rows incl. gaps). Measuring ${from} .. ${to} in chunks of ${opts.chunk}, every ${opts.sampleEvery}th chunk. READ-ONLY.`);
  const cutoff = Date.now() - opts.minAgeMin * 60000;
  let total = 0, retry = 0, dup = 0, seen = 0, i = 0;
  const hot = [];
  for (const [a, b] of chunkRanges(from, to, opts.chunk)) {
    if (i++ % opts.sampleEvery) continue;
    const rs = (await exec.sql(sql.retryShare(a, b))).results[0] || {};
    const ds = (await exec.sql(sql.dupShare(a, b, cutoff))).results[0] || {};
    const tg = (await exec.sql(sql.topGroups(a, b, 5))).results || [];
    total += n0(rs.total); retry += n0(rs.retry_rows); dup += n0(ds.dup_rows); seen++;
    log(`  ${a}..${b}: rows ${n0(rs.total)}, with tries>1: ${n0(rs.retry_rows)}, removable duplicates: ${n0(ds.dup_rows)}; busiest: ${tg.slice(0, 3).map((g) => `${g.client_id}/${g.kind}/${g.rec_id} x${g.c} (tries<=${g.max_tries})`).join('; ') || '-'}`);
    for (const g of tg) hot.push(g);
  }
  hot.sort((x, y) => n0(y.c) - n0(x.c));
  log(`\nSampled ${seen} chunk(s): ${total} rows, ${retry} carry tries>1, ${dup} are removable duplicates (${total ? Math.round((dup / total) * 100) : 0}%).`);
  log('Busiest records seen:'); hot.slice(0, 10).forEach((g) => log(`  ${g.client_id} ${g.kind} ${g.rec_id}: ${g.c} rows in one chunk, max tries ${g.max_tries}`));
  return { rows: total, retry, dup, chunks: seen };
}

export async function dryRun(opts, exec, log = console.log) {
  const { lo, hi } = await getBounds(exec);
  if (lo == null) { log('ledger_audit is empty.'); return { would: 0 }; }
  const from = opts.fromId != null ? opts.fromId : lo, to = opts.toId != null ? opts.toId : hi;
  const cutoff = Date.now() - opts.minAgeMin * 60000;
  log(`DRY RUN (nothing is deleted): strategy ${opts.strategy}, ids ${from} .. ${to}, chunk ${opts.chunk}, rows younger than ${opts.minAgeMin} min are never touched.`);
  let would = 0, k = 0;
  for (const [a, b] of chunkRanges(from, to, opts.chunk)) {
    if (k++ >= opts.maxChunks) break;
    const n = n0(((await exec.sql(sql.count(a, b, cutoff, opts.strategy))).results[0] || {}).n);
    would += n; log(`  ${a}..${b}: would delete ${n}`);
  }
  log(`TOTAL that --run would delete: ${would}`);
  return { would };
}

export function checkBackup(dir, fsApi = fs) {
  try { if (!fsApi.existsSync(dir) || !fsApi.statSync(dir).isDirectory()) return { ok: false, why: `the backup folder "${dir}" does not exist: run tools\\backup-all.cmd first` }; } catch (e) { return { ok: false, why: String(e.message) }; }
  const sqlFiles = fsApi.readdirSync(dir).filter((f) => /\.sql$/i.test(f) && f !== GUARD_FILE);
  if (!sqlFiles.length) return { ok: false, why: `"${dir}" has no .sql backup files: run tools\\backup-all.cmd first` };
  return { ok: true, files: sqlFiles.length };
}

export const guardFileText = (rows) => `-- ledger_audit delete-guard trigger(s), captured ${new Date().toISOString()} by tools/prune-audit.mjs BEFORE the prune.\n-- To restore by hand:  npx wrangler d1 execute mydukapos-ledger --remote --file=${GUARD_FILE}\n${rows.map((r) => `\n-- ${r.name}\n${String(r.sql).trim().replace(/;?\s*$/, '')};`).join('\n')}\n`;

// SAFE path / EMERGENCY path + the prune loop. `io` = { log, warn, confirm(question)->Promise<string>, fs, onStop(fn) }.
export async function runPrune(opts, exec, io = {}) {
  const log = io.log || console.log, warn = io.warn || console.warn, fsApi = io.fs || fs;
  const state = { stop: false, deleted: 0, lastDone: null, path: null, guardDropped: false, flagOpen: false, guardFile: null };
  if (io.onStop) io.onStop(() => { state.stop = true; });
  const bk = checkBackup(opts.backupDir, fsApi);
  if (!bk.ok) { warn('STOP: ' + bk.why); return { ok: false, reason: 'no_backup', ...state }; }
  log(`Backup folder "${opts.backupDir}" found (${bk.files} .sql file(s)).`);
  const { lo, hi } = await getBounds(exec);
  if (lo == null) { log('ledger_audit is empty: nothing to do.'); return { ok: true, ...state }; }
  const from = opts.fromId != null ? opts.fromId : lo, to = opts.toId != null ? opts.toId : hi;
  if (!opts.yes) {
    warn(`\n  ABOUT TO DELETE audit rows from ${opts.db} (${opts.remote ? 'REMOTE / LIVE' : 'local'}): ids ${from} .. ${to}, strategy ${opts.strategy}, chunks of ${opts.chunk}.\n  Only duplicates made by re-sending a record are removed (the first row of every group stays); rows younger than ${opts.minAgeMin} minutes are never touched.\n  Deleted rows cannot be undone except by Time Travel / your backup of the OTHER tables. Run --dry-run first if you have not.`);
    const ans = io.confirm ? await io.confirm('  Type YES (capitals) to continue: ') : '';
    if (String(ans).trim() !== 'YES') { warn('Not confirmed: nothing was changed.'); return { ok: false, reason: 'not_confirmed', ...state }; }
  }
  const guardRows = (await exec.sql(sql.allTriggers())).results || [];
  const guard = guardRows.find((r) => r.name === GUARD_TRIGGER);
  state.path = guard && guardIsSafePath(guard.sql) ? 'safe' : 'emergency';
  try {
    if (state.path === 'safe') {
      log('SAFE path: migration 0007 is applied. Opening the prune flag (audit_prune_open=1); it is closed again at the end.');
      await exec.sql(sql.openFlag()); state.flagOpen = true;
    } else {
      warn('\n  !!! EMERGENCY path: migration 0007 is NOT applied, so the delete guard has to be DROPPED while the prune runs.');
      warn('  !!! The trigger SQL is saved first and re-created at the end (also on Ctrl+C or an error). Financial records are unprotected until then.');
      if (!guard) { warn('STOP: the trigger ' + GUARD_TRIGGER + ' was not found (is this the right database?). Nothing changed.'); return { ok: false, reason: 'no_guard', ...state }; }
      state.guardFile = path.join(opts.backupDir, GUARD_FILE);
      fsApi.writeFileSync(state.guardFile, guardFileText(guardRows.filter((r) => r.name === GUARD_TRIGGER)));
      const back = fsApi.readFileSync(state.guardFile, 'utf8');
      if (!/CREATE TRIGGER/i.test(back)) { warn('STOP: could not save the guard SQL; nothing changed.'); return { ok: false, reason: 'guard_not_saved', ...state }; }
      log(`Saved the guard to ${state.guardFile}`);
      await exec.sql(sql.dropGuard()); state.guardDropped = true;
      log('Guard dropped.');
    }
    if (io.onSecondStop) io.onSecondStop(() => { try { if (state.guardDropped && exec.fileSync) exec.fileSync(state.guardFile); } catch (e) { /* best effort */ } });
    await pruneLoop(opts, exec, { log, warn, state, from, to, sleepFn: io.sleep || sleep });
    if (opts.globalDups && !state.stop) await globalDups(opts, exec, { log, warn, state, from, to });
  } catch (e) {
    state.error = e;
    if (isStorageFull(e)) { warn(adviceStorageFull(opts.db)); state.storageFull = true; }
    else warn('\nERROR: ' + ((e && e.message) || e));
  } finally {
    await restoreGuard(opts, exec, { log, warn, state, fsApi });
  }
  try {
    const b = await getBounds(exec);
    const upper = b.lo == null ? 0 : b.hi - b.lo + 1;
    log(`\nDeleted ${state.deleted} row(s) in this run. ledger_audit now spans ids ${b.lo} .. ${b.hi}: at most about ${Math.max(0, upper - state.deleted)} row(s) remain (estimate: id span minus the rows removed from inside it).`);
    state.remainingUpper = upper;
  } catch (e) { warn('(could not read the remaining row estimate: ' + ((e && e.message) || e) + ')'); }
  if (state.lastDone != null && (state.stop || state.error)) log(`To continue where this stopped:  node tools\\prune-audit.mjs --run --from-id ${state.lastDone + 1}`);
  log('Note: D1 keeps the file size at its high-water mark after deletes; freed pages are reused, so writes work again. See docs\\INCIDENT_LEDGER_AUDIT_186.md for shrinking.');
  state.ok = !state.error && !state.guardStillMissing && !state.flagStillOpen;
  return state;
}

async function pruneLoop(opts, exec, ctx) {
  const { log, warn, state, from, to, sleepFn } = ctx;
  const cutoff = Date.now() - opts.minAgeMin * 60000;
  let size = opts.chunk, a = from, done = 0;
  log(`Pruning ids ${from} .. ${to} (strategy ${opts.strategy}). Rows with at >= ${new Date(cutoff).toISOString()} are never deleted.`);
  while (a <= to) {
    if (state.stop) { warn('Stop requested: finishing cleanly.'); break; }
    if (done >= opts.maxChunks) break;
    const b = Math.min(to, a + size - 1);
    let r;
    try { r = await exec.sql(sql.del(a, b, cutoff, opts.strategy)); }
    catch (e) {
      if (isStorageFull(e)) throw e;
      if (isTimeout(e) && size > 1000) { size = Math.max(1000, Math.floor(size / 2)); warn(`  chunk ${a}..${b} timed out: retrying with chunks of ${size}`); continue; }
      throw e;
    }
    const n = r.changes; state.deleted += n; state.lastDone = b; done++;
    log(`  ${a}..${b}: deleted ${n} (run total ${state.deleted})`);
    a = nextChunkStart(b);
    if (opts.sleepMs) await sleepFn(opts.sleepMs);
  }
}

// groups that span chunks: collapse the hottest ones with one bounded DELETE each
async function globalDups(opts, exec, ctx) {
  const { log, state, from, to } = ctx;
  const cutoff = Date.now() - opts.minAgeMin * 60000;
  log('Global duplicates: looking for the hottest groups (>= 50 rows in one chunk) ...');
  const seen = new Set();
  for (const [a, b] of chunkRanges(from, to, opts.chunk)) {
    if (state.stop) return;
    const groups = (await exec.sql(sql.hotGroups(a, b))).results || [];
    for (const g of groups) {
      const key = [g.client_id, g.kind, g.rec_id, g.version, g.action].join('|');
      if (seen.has(key)) continue; seen.add(key);
      const r = await exec.sql(sql.delGroup(g, cutoff));
      state.deleted += r.changes;
      if (r.changes) log(`  ${g.client_id} ${g.kind} ${g.rec_id} v${g.version} ${g.action}: removed ${r.changes} duplicate(s) across chunks`);
    }
  }
}

async function restoreGuard(opts, exec, ctx) {
  const { log, warn, state, fsApi } = ctx;
  if (state.flagOpen) {
    try {
      await exec.sql(sql.closeFlag());
      const v = ((await exec.sql(sql.readFlag())).results[0] || {}).v;
      if (String(v) !== '0') throw new Error('flag reads ' + v);
      state.flagOpen = false; log('Prune flag closed (audit_prune_open=0): the audit table is delete-protected again.');
    } catch (e) {
      state.flagStillOpen = true;
      warn('\n!!! COULD NOT CLOSE THE PRUNE FLAG. Audit rows older than 10 minutes can still be deleted until you run:');
      warn(`!!!   npx wrangler d1 execute ${opts.db} ${opts.remote ? '--remote' : '--local'} --command "INSERT INTO ledger_meta (k, v) VALUES ('audit_prune_open', '0') ON CONFLICT (k) DO UPDATE SET v = '0'"`);
    }
  }
  if (state.guardDropped) {
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        await exec.file(state.guardFile);
        const row = ((await exec.sql(sql.guardSql())).results || [])[0];
        ok = !!(row && /never deleted/i.test(row.sql || ''));
      } catch (e) { warn(`  re-creating the guard failed (attempt ${attempt}): ${(e && e.message) || e}`); }
    }
    if (ok) { state.guardDropped = false; log(`The delete guard ${GUARD_TRIGGER} is back and verified.`); }
    else {
      state.guardStillMissing = true;
      warn('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      warn(`!!! THE DELETE GUARD IS STILL MISSING. Financial audit rows are NOT protected. Run NOW:`);
      warn(`!!!   npx wrangler d1 execute ${opts.db} ${opts.remote ? '--remote' : '--local'} --file=${state.guardFile}`);
      warn('!!!   (or apply migration 0007, which installs the guarded version)');
      warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    }
  }
}

// ---------- main ----------
async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help || opts.errors.length) { if (opts.errors.length) console.error(opts.errors.map((e) => 'Error: ' + e).join('\n')); console.error(USAGE); return opts.help ? 0 : 2; }
  const exec = makeWranglerExec({ db: opts.db, remote: opts.remote });
  try {
    if (opts.mode === 'measure') { await measure(opts, exec); return 0; }
    if (opts.mode === 'dry-run') { await dryRun(opts, exec); return 0; }
    let sigints = 0, stopFn = null, secondFn = null;
    process.on('SIGINT', () => {
      sigints++;
      if (sigints === 1) { console.warn('\nCtrl+C: finishing the current chunk, then restoring the delete guard. Press Ctrl+C again to force (the guard is restored first).'); if (stopFn) stopFn(); }
      else { console.warn('\nForced exit: restoring the guard first ...'); try { if (secondFn) secondFn(); } finally { process.exit(130); } }
    });
    const io = {
      log: (...a) => console.log(...a), warn: (...a) => console.warn(...a),
      confirm: (q) => new Promise((resolve) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); resolve(a); }); }),
      onStop: (f) => { stopFn = f; }, onSecondStop: (f) => { secondFn = f; },
    };
    const r = await runPrune(opts, exec, io);
    return r.ok ? 0 : 1;
  } catch (e) {
    if (isStorageFull(e)) console.error(adviceStorageFull(opts.db)); else console.error('ERROR: ' + ((e && e.message) || e));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
