#!/usr/bin/env node
// tools/audit-monthly.mjs — zip 188. Owner-run MONTHLY archive + prune of the separate audit database (mydukapos-audit), from your PC.
//   node tools\audit-monthly.mjs                 dry run: shows how many rows are older than 90 days (changes nothing)
//   node tools\audit-monthly.mjs --run           archives them to backup\audit-monthly\<YYYY-MM>\*.ndjson.gz (+ manifest.json with sha256), verifies each file, THEN deletes exactly those ids
//   options: --db mydukapos-audit  --days 90  --rows 20000 (rows per file)  --out backup\audit-monthly  --local  --max-files N
// Safe order per file: read rows -> write .gz -> read it back and compare row count + sha256 -> delete that id range (only rows older than the cutoff). A failure stops
// before any delete. Re-running continues where it stopped. It never touches the sales database.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { makeWranglerExec } from './prune-audit.mjs';

export function parseArgs(argv) {
  const o = { db: 'mydukapos-audit', days: 90, rows: 20000, out: path.join('backup', 'audit-monthly'), remote: true, run: false, maxFiles: Infinity, errors: [] };
  const int = (n, v, min, max) => { const x = Number(v); if (!Number.isInteger(x) || x < min || x > max) { o.errors.push(`${n} needs a whole number ${min}..${max} (got "${v}")`); return null; } return x; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--run': o.run = true; break;
      case '--local': o.remote = false; break;
      case '--help': case '-h': o.help = true; break;
      case '--db': { const v = argv[++i]; if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(v))) o.errors.push('--db is not a database name'); else o.db = v; break; }
      case '--days': { const v = int('--days', argv[++i], 1, 3650); if (v != null) o.days = v; break; }
      case '--rows': { const v = int('--rows', argv[++i], 100, 50000); if (v != null) o.rows = v; break; }
      case '--max-files': { const v = int('--max-files', argv[++i], 1, 100000); if (v != null) o.maxFiles = v; break; }
      case '--out': { const v = argv[++i]; if (!v) o.errors.push('--out needs a folder'); else o.out = v; break; }
      default: o.errors.push(`unknown option ${a}`);
    }
  }
  return o;
}
export const COLS = 'id, client_id, kind, rec_id, action, version, amount, status, actor, source, at, snapshot';
export const monthDir = (now) => new Date(now).toISOString().slice(0, 7);

export async function auditMonthly(o, exec, io = {}) {
  const log = io.log || console.log, fsApi = io.fs || fs, now = io.now || Date.now();
  const cutoff = Math.trunc(now - o.days * 86400000);
  const cnt = ((await exec.sql(`SELECT COUNT(*) AS n, MIN(id) AS lo, MAX(id) AS hi FROM ledger_audit WHERE at < ${cutoff}`)).results || [])[0] || {};
  const n = Number(cnt.n) || 0;
  log(`Audit rows older than ${o.days} days: ${n}${n ? ` (ids ${cnt.lo}..${cnt.hi})` : ''}`);
  if (!o.run) { log(n ? 'Dry run: nothing changed. Run again with --run to archive and then delete them.' : 'Nothing to do.'); return { rows: n, files: 0, deleted: 0 }; }
  if (!n) return { rows: 0, files: 0, deleted: 0 };
  const dir = path.join(o.out, monthDir(now)); fsApi.mkdirSync(dir, { recursive: true });
  const mf = path.join(dir, 'manifest.json'); let manifest = { files: {} };
  try { manifest = JSON.parse(fsApi.readFileSync(mf, 'utf8')); manifest.files = manifest.files || {}; } catch (e) { /* new */ }
  let files = 0, archived = 0, deleted = 0;
  while (files < o.maxFiles) {
    const got = (await exec.sql(`SELECT ${COLS} FROM ledger_audit WHERE at < ${cutoff} ORDER BY id LIMIT ${o.rows}`)).results || [];
    if (!got.length) break;
    const from = Number(got[0].id), to = Number(got[got.length - 1].id);
    const name = `ledger_audit_${from}-${to}.ndjson.gz`, file = path.join(dir, name);
    const gz = zlib.gzipSync(Buffer.from(got.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'));
    const sha = crypto.createHash('sha256').update(gz).digest('hex');
    fsApi.writeFileSync(file + '.part', gz); fsApi.renameSync(file + '.part', file);
    const back = fsApi.readFileSync(file);                                   // verify what is on disk before anything is deleted
    const lines = zlib.gunzipSync(back).toString('utf8').split('\n').filter(Boolean).length;
    if (crypto.createHash('sha256').update(back).digest('hex') !== sha || lines !== got.length) throw new Error(`verify failed for ${name}: nothing deleted`);
    manifest.files[name] = { from, to, rows: got.length, bytes: gz.length, sha256: sha, cutoff, at: new Date(now).toISOString() };
    fsApi.writeFileSync(mf, JSON.stringify(manifest, null, 2));
    const del = await exec.sql(`DELETE FROM ledger_audit WHERE id BETWEEN ${from} AND ${to} AND at < ${cutoff}`);
    const ch = Number((((del.results || [])[0] || {}).meta || {}).changes ?? (del.meta || {}).changes ?? got.length);
    archived += got.length; deleted += ch; files++;
    log(`  ${name}: ${got.length} rows archived and verified, ${ch} deleted`);
    if (got.length < o.rows) break;
  }
  log(`Done: ${archived} rows in ${files} file(s) under ${dir}; ${deleted} rows deleted from ${o.db}. Keep the folder (or copy it to R2/OneDrive).`);
  return { rows: archived, files, deleted };
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help || o.errors.length) { if (o.errors.length) console.error(o.errors.map((e) => 'Error: ' + e).join('\n')); console.error('Usage: node tools\\audit-monthly.mjs [--run] [--days 90] [--rows 20000] [--db mydukapos-audit] [--out backup\\audit-monthly] [--local] [--max-files N]'); return o.errors.length ? 2 : 0; }
  try { await auditMonthly(o, makeWranglerExec({ db: o.db, remote: o.remote })); return 0; } catch (e) { console.error('ERROR: ' + ((e && e.message) || e)); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
