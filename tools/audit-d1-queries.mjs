// tools/audit-d1-queries.mjs — does every SQL statement the server sends to D1 use an index? (zip 159)
//   node tools/audit-d1-queries.mjs            table of statements that SCAN a table, and the ones it could not analyse
//   node tools/audit-d1-queries.mjs --all      every statement with its query plan
// Reads every SQL string out of functions/**.js (SELECT / UPDATE / DELETE, and INSERT ... SELECT), replaces `${...}` interpolations with `?` or a
// list of `?`, creates the REAL schema (the same statements ensureLedgerSchema / ensureCrmSchema run) in SQLite and asks SQLite for EXPLAIN QUERY PLAN.
// A plan line "SCAN <table>" without an index means the statement reads every row of that table, however large it grows. Not every SCAN is a problem
// (a small settings table, a per-shop table that stays a few hundred rows): the report says which is which. SQLite's planner is not D1's, but D1 IS SQLite.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
process.removeAllListeners('warning');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);

export async function buildDb() {
  const db = new DatabaseSync(':memory:');
  const { LEDGER_SCHEMA } = await load('functions/api/_ledger-schema.js');
  const { CRM_SCHEMA, CRM_SPEED_SCHEMA } = await load('functions/api/_crm/schema.js');
  for (const s of LEDGER_SCHEMA) db.exec(s);
  for (const s of CRM_SCHEMA) db.exec(s);
  for (const s of CRM_SPEED_SCHEMA) db.exec(s);
  try { const eff = await load('functions/api/_efficiency-schema.js'); for (const s of eff.EFFICIENCY_SCHEMA) db.exec(s); } catch (e) { /* not there yet */ }
  return db;
}

function walk(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

// String literals (backtick / single / double quoted) that look like a SQL statement.
export function extractSql(text) {
  const out = [];
  const re = /`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text))) {
    let s = m[1] != null ? m[1] : m[2] != null ? m[2] : m[3];
    if (!/^\s*(SELECT|UPDATE|DELETE|WITH|INSERT)\b/i.test(s)) continue;
    if (!/\b(FROM|WHERE|SET)\b/i.test(s)) continue;
    if (/^\s*INSERT/i.test(s) && !/\bSELECT\b/i.test(s)) continue;              // a plain INSERT ... VALUES touches no existing rows
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ sql: s, line });
  }
  return out;
}
// ${...} -> ?  (a `${x.map(() => '?').join(',')}` list -> ?,?,? )
export function normalise(sql) {
  return sql.replace(/\$\{[^}]*\.join\([^)]*\)\}/g, '?,?,?').replace(/\$\{[^}]*\}/g, (x) => (/\b(WHERE|AND|ORDER|LIMIT|JOIN)\b/i.test(x) ? '' : '?')).replace(/\\`/g, '`').replace(/\\'/g, "'");
}

export async function auditAll() {
  const db = await buildDb();
  const rows = [];
  for (const file of walk(path.join(ROOT, 'functions'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const { sql, line } of extractSql(text)) {
      const n = normalise(sql);
      const rel = path.relative(ROOT, file);
      const stmt = /^\s*(WITH|SELECT)/i.test(n) ? n : n;
      let plan = null, error = null;
      try {
        const nb = (n.match(/\?/g) || []).length;
        plan = db.prepare('EXPLAIN QUERY PLAN ' + stmt).all(...Array(nb).fill(null)).map((r) => r.detail);
      } catch (e) { error = String(e.message).slice(0, 100); }
      rows.push({ file: rel, line, sql: n.replace(/\s+/g, ' ').trim(), plan, error });
    }
  }
  return rows;
}

// SCAN of a table (not "SCAN ... USING INDEX"/covering index; SEARCH is fine; a scan of a tiny config table is fine)
const SMALL = new Set(['crm_meta', 'crm_roles', 'crm_statuses', 'crm_classifications', 'crm_sources', 'crm_lost_reasons', 'crm_products', 'crm_settings', 'ledger_meta', 'crm_users', 'crm_permissions']);
export function scans(plan) {
  return (plan || []).filter((d) => /^SCAN\b/.test(d) && !/USING (COVERING )?INDEX/.test(d) && !/^SCAN (\d+|\w+ USING INTEGER PRIMARY KEY)/.test(d)).map((d) => d.replace(/^SCAN( TABLE)? /, '').split(/\s/)[0]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = await auditAll();
  const all = process.argv.includes('--all');
  let bad = 0, unparsed = 0;
  for (const r of rows) {
    if (r.error) { unparsed++; if (all) console.log(`?? ${r.file}:${r.line} (${r.error})`); continue; }
    const sc = scans(r.plan).filter((t) => !SMALL.has(t));
    if (sc.length) { bad++; console.log(`SCAN ${[...new Set(sc)].join(',')}  ${r.file}:${r.line}\n   ${r.sql.slice(0, 220)}\n   ${r.plan.join(' | ')}`); }
    else if (all) console.log(`ok   ${r.file}:${r.line}  ${r.plan.join(' | ')}`);
  }
  console.log(`\n${rows.length} statements read, ${rows.length - unparsed} analysed, ${bad} scan a table, ${unparsed} could not be analysed (interpolated fragments).`);
  process.exit(0);
}
