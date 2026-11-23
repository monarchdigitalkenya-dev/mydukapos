// tools/ensure-router-config.mjs - zip 306. Makes sure the router Worker's wrangler file(s) carry the bindings the router's own code needs, WITHOUT
// touching anything else in them (account ids, routes, vars stay exactly as they are). Runs by itself before `npm run deploy:router`, because the
// deploy steps never copy wrangler.toml files over the ones already pointing at your account.
//   SYNC_ROOM  (zip 306): the shop database (ShopStore) tells the shop's live-sync room (SyncRoom, same Worker) "a new version exists" after any
//              change, so devices can ask the room instead of the server. Without it everything still works; devices just check over HTTP more.
//   node tools/ensure-router-config.mjs           add what is missing (prints what it did)
//   node tools/ensure-router-config.mjs --check   exit 1 if something is missing (nothing is written)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILES = ['wrangler.toml', 'wrangler.staging.toml', 'wrangler.noroute.toml'].map((f) => path.join('wildcard-router', f));
const BLOCK = '\n# zip 306: the router\'s own live-sync room, so the shop database can note new versions in it (tools/ensure-router-config.mjs adds this)\n[[durable_objects.bindings]]\nname = "SYNC_ROOM"\nclass_name = "SyncRoom"\n';

export function hasSyncRoom(text) { return /\[\[durable_objects\.bindings\]\][^[]*name\s*=\s*"SYNC_ROOM"/.test(text); }
export function ensure(text) { return hasSyncRoom(text) ? text : text.replace(/\s*$/, '\n') + BLOCK; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let missing = 0;
  for (const f of FILES) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf8');
    if (hasSyncRoom(t)) { console.log(f + ': SYNC_ROOM binding present'); continue; }
    missing++;
    if (check) { console.log(f + ': SYNC_ROOM binding MISSING'); continue; }
    fs.writeFileSync(p, ensure(t));
    console.log(f + ': added the SYNC_ROOM binding');
  }
  if (check && missing) process.exit(1);
}
