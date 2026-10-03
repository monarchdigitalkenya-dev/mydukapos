// tools/setup-owner-db.mjs — one command that sets up the small shared OWNER database (zip 187).   node tools\setup-owner-db.mjs
//   1. creates the D1 database `mydukapos-owner` (or finds it if it already exists),
//   2. adds the OWNER_DB binding to wrangler.toml and wildcard-router\wrangler.toml (skipped when already there; a backup .bak-zip187 is kept),
//   3. creates its tables (sql\owner-db\0001_owner.sql).
// Safe to run again. Needs `npx wrangler login` done once. Options: --name mydukapos-owner   --no-sql (skip step 3)
// It cannot fill the database: after deploying, open the Owner Console's status route (GET /api/owner-db) and run the rebuild
// (POST /api/owner-db {"action":"rebuild"}) while signed in as the owner. Until that rebuild succeeds the console keeps reading KV.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BINDING = 'OWNER_DB';
export const bindingBlock = (name, id, why) => `\n# ${why}\n[[d1_databases]]\nbinding = "${BINDING}"\ndatabase_name = "${name}"\ndatabase_id = "${id}"\n`;

// Adds the binding block to a toml text unless an OWNER_DB binding is already there (a commented-out example is NOT counted: only a live line is).
export function patchToml(text, name, id, why = 'zip 187: the small shared OWNER database (a read model of the Owner Console list; KV stays the source of truth).') {
  const live = text.split(/\r?\n/).some((l) => /^\s*binding\s*=\s*"OWNER_DB"/.test(l));
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
  const name = argv.includes('--name') ? argv[argv.indexOf('--name') + 1] : 'mydukapos-owner';
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(`\n== Owner database: ${name} ==`);
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
    const x = wr(['d1', 'execute', name, '--remote', '--file=' + path.join(root, 'sql', 'owner-db', '0001_owner.sql')]);
    if (x.code !== 0) { console.error('\nCreating the tables failed:\n' + x.out + '\n(The server also creates the tables itself on its first write, so this is not fatal.)'); }
    else console.log('tables created');
  }
  console.log('\nDone. Next:\n  1. npm run deploy  (and npm run deploy:router if you want the binding on the router too)\n  2. sign in to the Owner Console, then open  /api/owner-db  (status) and run the rebuild:  POST /api/owner-db  {"action":"rebuild"}\n  Until the rebuild succeeds the Owner Console keeps reading from KV, exactly as before. KV is always the source of truth.');
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
