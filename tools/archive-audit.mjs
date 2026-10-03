#!/usr/bin/env node
// tools/archive-audit.mjs — zip 186. ARCHIVE ledger_audit rows to gzip NDJSON files BEFORE tools/prune-audit.mjs deletes anything. It only READS the database.
//
//   node tools\archive-audit.mjs                       archives exactly the rows `prune-audit --run` would delete (scope "dups"), chunk by chunk
//   node tools\archive-audit.mjs --scope all           archives EVERY audit row (about 460 bytes each before compression: allow time and disk)
//   options: --db mydukapos-ledger  --local  --chunk 100000 (use the SAME value as for the prune: "dups" is decided inside one chunk)  --read-size 20000
//            --from-id N  --to-id N  --out backup\audit  --min-age-min 10  --strategy dups|retries|both  --sleep-ms 0  --max-chunks N
//
// Output: <out>\ledger_audit_<fromId>-<toId>.ndjson.gz   (one JSON row per line, all columns)   and   <out>\manifest.json (rows + sha256 per file).
// Resumable: a chunk whose file is already listed in the manifest is skipped. Nothing is deleted here. Uploading to R2 is a manual step (see docs\INCIDENT_LEDGER_AUDIT_186.md):
//   npx wrangler r2 object put <bucket>/audit-archive/<file> --file=backup\audit\<file> --remote
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { makeWranglerExec, chunkRanges, sql as pruneSql, getBounds, isStorageFull, DEFAULTS } from './prune-audit.mjs';

export function parseArgs(argv) {
  const o = { db: DEFAULTS.db, remote: true, chunk: DEFAULTS.chunk, readSize: 20000, fromId: null, toId: null, out: path.join('backup', 'audit'), scope: 'dups', strategy: 'both', minAgeMin: 10, sleepMs: 0, maxChunks: Infinity, errors: [], help: false };
  const int = (n, v, min, max = Infinity) => { const x = Number(v); if (!Number.isInteger(x) || x < min || x > max) { o.errors.push(`${n} needs a whole number from ${min} (got "${v}")`); return null; } return x; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const eq = a.startsWith('--') && a.includes('=') ? a.slice(a.indexOf('=') + 1) : null; const name = eq != null ? a.slice(0, a.indexOf('=')) : a;
    const get = () => (eq != null ? eq : argv[++i]);
    switch (name) {
      case '--local': o.remote = false; break;
      case '--remote': o.remote = true; break;
      case '--help': case '-h': o.help = true; break;
      case '--db': { const v = get(); if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(v))) o.errors.push('--db is not a database name'); else o.db = v; break; }
      case '--chunk': { const v = int('--chunk', get(), 1000, 1000000); if (v != null) o.chunk = v; break; }
      case '--read-size': { const v = int('--read-size', get(), 100, 100000); if (v != null) o.readSize = v; break; }
      case '--from-id': { const v = int('--from-id', get(), 0); if (v != null) o.fromId = v; break; }
      case '--to-id': { const v = int('--to-id', get(), 0); if (v != null) o.toId = v; break; }
      case '--min-age-min': { const v = int('--min-age-min', get(), 10); if (v != null) o.minAgeMin = v; break; }
      case '--sleep-ms': { const v = int('--sleep-ms', get(), 0, 60000); if (v != null) o.sleepMs = v; break; }
      case '--max-chunks': { const v = int('--max-chunks', get(), 1); if (v != null) o.maxChunks = v; break; }
      case '--out': { const v = get(); if (!v) o.errors.push('--out needs a folder'); else o.out = v; break; }
      case '--scope': { const v = get(); if (!['dups', 'all'].includes(v)) o.errors.push('--scope must be dups or all'); else o.scope = v; break; }
      case '--strategy': { const v = get(); if (!['dups', 'retries', 'both'].includes(v)) o.errors.push('--strategy must be dups, retries or both'); else o.strategy = v; break; }
      default: o.errors.push(`unknown option ${a}`);
    }
  }
  if (o.fromId != null && o.toId != null && o.fromId > o.toId) o.errors.push('--from-id is after --to-id');
  return o;
}
export const archiveFileName = (a, b) => `ledger_audit_${a}-${b}.ndjson.gz`;
// the rows of one chunk to archive, in id order, `limit` at a time after `afterId` (keyset paging: bounded work per call)
export function selectSql(a, b, cutoff, scope, strategy, afterId, limit) {
  const where = scope === 'all' ? `id BETWEEN ${Math.max(a, afterId + 1)} AND ${b} AND at < ${Math.trunc(cutoff)}` : `id > ${afterId} AND ${pruneSql.predicate(a, b, cutoff, strategy)}`;
  return `SELECT id, client_id, kind, rec_id, action, version, amount, status, actor, source, at, snapshot FROM ledger_audit WHERE ${where} ORDER BY id LIMIT ${Math.trunc(limit)}`;
}
export const toNdjson = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

export async function archive(opts, exec, io = {}) {
  const log = io.log || console.log; const fsApi = io.fs || fs;
  const { lo, hi } = await getBounds(exec);
  if (lo == null) { log('ledger_audit is empty.'); return { rows: 0, files: 0 }; }
  const from = opts.fromId != null ? opts.fromId : lo, to = opts.toId != null ? opts.toId : hi;
  const cutoff = Date.now() - opts.minAgeMin * 60000;
  fsApi.mkdirSync(opts.out, { recursive: true });
  const mf = path.join(opts.out, 'manifest.json');
  let manifest = { files: {} };
  try { manifest = JSON.parse(fsApi.readFileSync(mf, 'utf8')); manifest.files = manifest.files || {}; } catch (e) { /* new */ }
  let rows = 0, files = 0, k = 0;
  log(`Archiving (read-only) scope ${opts.scope}, ids ${from} .. ${to}, chunk ${opts.chunk} -> ${opts.out}`);
  for (const [a, b] of chunkRanges(from, to, opts.chunk)) {
    if (k++ >= opts.maxChunks) break;
    const name = archiveFileName(a, b);
    if (manifest.files[name] && fsApi.existsSync(path.join(opts.out, name))) { log(`  ${a}..${b}: already archived (${manifest.files[name].rows} rows), skipped`); continue; }
    const parts = []; let after = a - 1, n = 0;
    for (;;) {
      const got = (await exec.sql(selectSql(a, b, cutoff, opts.scope, opts.strategy, after, opts.readSize))).results || [];
      if (!got.length) break;
      parts.push(toNdjson(got)); n += got.length; after = Number(got[got.length - 1].id);
      if (got.length < opts.readSize) break;
    }
    if (!n) { log(`  ${a}..${b}: nothing to archive`); continue; }
    const gz = zlib.gzipSync(Buffer.from(parts.join(''), 'utf8'));
    const tmp = path.join(opts.out, name + '.part');
    fsApi.writeFileSync(tmp, gz); fsApi.renameSync(tmp, path.join(opts.out, name));
    manifest.files[name] = { from: a, to: b, rows: n, bytes: gz.length, sha256: crypto.createHash('sha256').update(gz).digest('hex'), scope: opts.scope, at: new Date().toISOString() };
    fsApi.writeFileSync(mf, JSON.stringify(manifest, null, 2));
    rows += n; files++;
    log(`  ${a}..${b}: ${n} rows -> ${name} (${gz.length} bytes)`);
    if (opts.sleepMs) await new Promise((r) => setTimeout(r, opts.sleepMs));
  }
  log(`Archived ${rows} row(s) in ${files} new file(s). Nothing was deleted. Next: node tools\\prune-audit.mjs --dry-run  then  --run (same --chunk).`);
  return { rows, files, manifest };
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help || o.errors.length) { if (o.errors.length) console.error(o.errors.map((e) => 'Error: ' + e).join('\n')); console.error('Usage: node tools\\archive-audit.mjs [--scope dups|all] [--chunk 100000] [--from-id N] [--to-id N] [--out backup\\audit] [--db NAME] [--local]'); return o.help ? 0 : 2; }
  try { await archive(o, makeWranglerExec({ db: o.db, remote: o.remote })); return 0; }
  catch (e) { console.error(isStorageFull(e) ? 'The database is full (read-only archiving should still work: retry) - ' + e.message : 'ERROR: ' + ((e && e.message) || e)); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
