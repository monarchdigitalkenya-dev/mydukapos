// tools/setup-audit-db.mjs — one command that sets up the SEPARATE audit database (zip 187).   node tools\setup-audit-db.mjs
//   1. creates the D1 database `mydukapos-audit` (or finds it if it already exists),
//   2. adds the LEDGER_AUDIT_DB binding to wrangler.toml and wildcard-router\wrangler.toml (skipped when already there),
//   3. creates its table (sql\audit-db\0001_audit.sql).
// Safe to run again. Needs `npx wrangler login` done once. Options: --name mydukapos-audit   --no-sql (skip step 3)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BINDING = 'LEDGER_AUDIT_DB';
export const bindingBlock = (name, id, why) => `\n# ${why}\n[[d1_databases]]\nbinding = "${BINDING}"\ndatabase_name = "${name}"\ndatabase_id = "${id}"\n`;

// Adds the binding block to a toml text unless a LEDGER_AUDIT_DB binding is already there (even a commented-out example is NOT counted: only a live line is).
export function patchToml(text, name, id, why = 'zip 187: the separate AUDIT database (audit rows live here so a flood of them can never fill the sales database).') {
  const live = text.split(/\r?\n/).some((l) => /^\s*binding\s*=\s*"LEDGER_AUDIT_DB"/.test(l));
  if (live) return { text, changed: false };
  const sep = text.endsWith('\n') ? '' : '\n';
  return { text: text + sep + bindingBlock(name, id, why), changed: true };
}

// wrangler prints the id as `"database_id": "..."` (create --json / info --json) or `database_id = "..."` (create). Take the first UUID that follows "database_id".
export function parseDatabaseId(out) {
  const m = String(out || '').match(/database_id["']?\s*[:=]\s*["']?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/) || String(out || '').match(/\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/);
  return m ? m[1].toLowerCase() : null;
}

function wr(args) {
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', ...args], { encoding: 'utf8', shell: process.platform === 'win32' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

async function main() {
  const argv = process.argv.slice(2);
  const name = argv.includes('--name') ? argv[argv.indexOf('--name') + 1] : 'mydukapos-audit';
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(`\n== Audit database: ${name} ==`);
  let id = parseDatabaseId(wr(['d1', 'info', name, '--json']).out);
  if (id) console.log('Found the existing database, id ' + id);
  else {
    console.log('Creating it ...');
    const c = wr(['d1', 'create', name]);
    id = parseDatabaseId(c.out);
    if (!id) { console.error('\nCould not create or read the database id. Output:\n' + c.out + '\n\nRun "npx wrangler login" and try again, or create it in the Cloudflare dashboard (Workers > D1) and paste its id into both toml files by hand.'); process.exit(1); }
    console.log('Created, id ' + id);
  }
  for (const f of ['wrangler.toml', path.join('wildcard-router', 'wrangler.toml')]) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) { console.log('skip (missing): ' + f); continue; }
    const r = patchToml(fs.readFileSync(p, 'utf8'), name, id);
    if (r.changed) { fs.copyFileSync(p, p + '.bak-zip187'); fs.writeFileSync(p, r.text); console.log('binding added to ' + f + ' (backup: ' + f + '.bak-zip187)'); }
    else console.log('binding already in ' + f);
  }
  if (!argv.includes('--no-sql')) {
    const x = wr(['d1', 'execute', name, '--remote', '--file=' + path.join(root, 'sql', 'audit-db', '0001_audit.sql')]);
    if (x.code !== 0) { console.error('\nCreating the table failed:\n' + x.out + '\n(The server also creates the table itself on its first audit write, so this is not fatal.)'); }
    else console.log('table created');
  }
  console.log('\nDone. Next: apply the migrations, then npm run deploy:router and npm run deploy.');
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
