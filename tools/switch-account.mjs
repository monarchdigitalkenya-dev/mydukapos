// tools/switch-account.mjs - zip 269. Points wrangler.toml AND wildcard-router/wrangler.toml at the resources of ANOTHER Cloudflare account.
//
//   node tools\switch-account.mjs --show                         what ids the two files hold now (and whether they agree)
//   node tools\switch-account.mjs --kv <id> --ledger <id> --audit <id> --owner <id>
//                                                                writes the new account's ids into BOTH files (keeps a copy of each as *.old-account the first time)
//   node tools\switch-account.mjs --pages-host <address>        writes the new project's *.pages.dev address into wildcard-router\wrangler.toml ([vars] PAGES_ORIGIN): the router forwards every
//                                                                shop subdomain THERE. Without it the router forwards to the original account's project (zip 273)
//   node tools\switch-account.mjs --back                         puts the *.old-account copies back (the old account's ids)
//   node tools\switch-account.mjs --noroute                      writes wildcard-router\wrangler.noroute.toml: the router config WITHOUT the *.mydukapos.store route, for deploying the
//                                                                router before the domain is active in the new account (a route on a zone the account does not have makes the deploy fail)
//
// Why this exists: the ids in wrangler.toml belong to ONE account. setup-audit-db / setup-owner-db leave a binding that is already in the file alone, so on a new
// account they would create the database but keep the OLD id in the file. Only the ids change; names, bucket names and every other line stay exactly as they are.
//   --kv      the KV namespace id of `mydukapos_kv`            (32 hex characters)   npx wrangler kv namespace list
//   --ledger  the D1 database id of `mydukapos-ledger`         (a UUID)             npx wrangler d1 list
//   --audit   ... of `mydukapos-audit`      --owner  ... of `mydukapos-owner`
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILES = ['wrangler.toml', path.join('wildcard-router', 'wrangler.toml')];
const D1_NAMES = { ledger: 'mydukapos-ledger', audit: 'mydukapos-audit', owner: 'mydukapos-owner' };
const KV_RE = /^[0-9a-f]{32}$/i, UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const val = (line) => (line.match(/=\s*"([^"]*)"/) || [])[1] || '';

// -> { kv, ledger, audit, owner }: the live ids in one toml text (a commented line is never read)
export function readIds(text) {
  const out = { kv: '', ledger: '', audit: '', owner: '' };
  let block = '', name = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[\[/.test(line)) { block = line; name = ''; continue; }
    if (/^\[/.test(line)) { block = ''; continue; }
    if (line.startsWith('#')) continue;
    if (block === '[[kv_namespaces]]' && /^binding\s*=/.test(line)) name = val(line);
    if (block === '[[kv_namespaces]]' && /^id\s*=/.test(line) && name === 'mydukapos_kv') out.kv = val(line);
    if (block === '[[d1_databases]]' && /^database_name\s*=/.test(line)) name = val(line);
    if (block === '[[d1_databases]]' && /^database_id\s*=/.test(line)) for (const [k, n] of Object.entries(D1_NAMES)) if (name === n) out[k] = val(line);
    if (block === '[[d1_databases]]' && /^database_id\s*=/.test(line) && !name) out._unnamed = true;
  }
  return out;
}

// -> { text, changed: ['kv', ...] }: the same text with the given ids written in (only those lines change)
export function writeIds(text, ids) {
  const lines = text.split(/\r?\n/), changed = new Set();
  // pass 1: the name of every block (the name line can come after the id line in principle)
  const blocks = []; let cur = null;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (/^\[\[/.test(line)) { cur = { head: line, name: '', idLine: -1 }; blocks.push(cur); return; }
    if (/^\[/.test(line)) { cur = null; return; }
    if (!cur || line.startsWith('#')) return;
    if (cur.head === '[[kv_namespaces]]') { if (/^binding\s*=/.test(line)) cur.name = val(line); if (/^id\s*=/.test(line)) cur.idLine = i; }
    if (cur.head === '[[d1_databases]]') { if (/^database_name\s*=/.test(line)) cur.name = val(line); if (/^database_id\s*=/.test(line)) cur.idLine = i; }
  });
  for (const b of blocks) {
    let key = '';
    if (b.head === '[[kv_namespaces]]' && b.name === 'mydukapos_kv') key = 'kv';
    if (b.head === '[[d1_databases]]') for (const [k, n] of Object.entries(D1_NAMES)) if (b.name === n) key = k;
    if (!key || !ids[key] || b.idLine < 0) continue;
    lines[b.idLine] = lines[b.idLine].replace(/"[^"]*"/, `"${ids[key]}"`);
    changed.add(key);
  }
  return { text: lines.join(text.includes('\r\n') ? '\r\n' : '\n'), changed: [...changed] };
}

// the router config with its [[routes]] block taken out (everything else, ids included, as it is)
export function withoutRoutes(text) {
  const out = []; let skipping = false;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (/^\[\[routes\]\]/.test(t)) { skipping = true; continue; }
    if (skipping && /^\[/.test(t)) skipping = false;
    if (!skipping) out.push(raw);
  }
  return out.join(text.includes('\r\n') ? '\r\n' : '\n');
}

const PAGES_HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.pages\.dev$/i;
// -> the PAGES_ORIGIN the router config holds ('' when none)
export function readPagesHost(text) {
  let inVars = false;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (/^\[/.test(t)) { inVars = t === '[vars]'; continue; }
    if (inVars && /^PAGES_ORIGIN\s*=/.test(t)) return val(t);
  }
  return '';
}
// -> the same text with [vars] PAGES_ORIGIN set (added when absent, replaced when present)
export function writePagesHost(text, host) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n', lines = text.split(/\r?\n/);
  let inVars = false, varsAt = -1, keyAt = -1;
  lines.forEach((raw, i) => { const t = raw.trim(); if (/^\[/.test(t)) { inVars = t === '[vars]'; if (inVars) varsAt = i; return; } if (inVars && /^PAGES_ORIGIN\s*=/.test(t)) keyAt = i; });
  if (keyAt >= 0) lines[keyAt] = `PAGES_ORIGIN = "${host}"`;
  else if (varsAt >= 0) lines.splice(varsAt + 1, 0, `PAGES_ORIGIN = "${host}"`);
  else { while (lines.length && lines[lines.length - 1].trim() === '') lines.pop(); lines.push('', '[vars]', `PAGES_ORIGIN = "${host}"`, ''); }
  return lines.join(nl);
}

export function validate(ids) {
  const bad = [];
  if (ids.kv && !KV_RE.test(ids.kv)) bad.push('--kv must be 32 hex characters (npx wrangler kv namespace list)');
  for (const k of ['ledger', 'audit', 'owner']) if (ids[k] && !UUID_RE.test(ids[k])) bad.push(`--${k} must be a database id like 12f9b35e-d4d9-468d-ac8c-2b3ff6b3848d (npx wrangler d1 list)`);
  return bad;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); o[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; } }
  return o;
}

export function run(argv, root = ROOT, log = console.log) {
  const o = parseArgs(argv);
  const p = (f) => path.join(root, f);
  if (o.back) {
    for (const f of FILES) { if (!fs.existsSync(p(f) + '.old-account')) { log(`no ${f}.old-account copy - nothing to put back`); return 1; } }
    for (const f of FILES) fs.copyFileSync(p(f) + '.old-account', p(f));
    log('Put the old account\'s ids back in both files.'); return 0;
  }
  if (o['pages-host']) {
    const host = String(o['pages-host'] === true ? '' : o['pages-host']).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!PAGES_HOST_RE.test(host)) { log('ERROR: --pages-host must be your Pages project address like mydukapos-3ao.pages.dev (the address the deploy printed, without https://).'); return 2; }
    const rf = FILES[1], text = fs.readFileSync(p(rf), 'utf8');
    if (!fs.existsSync(p(rf) + '.old-account')) fs.copyFileSync(p(rf), p(rf) + '.old-account');
    fs.writeFileSync(p(rf), writePagesHost(text, host));
    log(`Written: the router now forwards every shop address to ${host}. Deploy it with:\n  npm run deploy:router`);
    // zip 284: --pages-host together with the four ids used to skip the host silently. Now both are written in one command.
    if (!(o.kv || o.ledger || o.audit || o.owner)) return 0;
  }
  if (o.noroute) {
    const src = fs.readFileSync(p(FILES[1]), 'utf8'), dst = path.join('wildcard-router', 'wrangler.noroute.toml');
    fs.writeFileSync(p(dst), '# GENERATED by tools/switch-account.mjs --noroute: wildcard-router/wrangler.toml without its route. Delete it after the domain is active and deploy with npm run deploy:router.\n' + withoutRoutes(src));
    log('Wrote ' + dst + '. Deploy the router without the route with:\n  npx wrangler deploy --config wildcard-router\\wrangler.noroute.toml'); return 0;
  }
  if (o.show || !(o.kv || o.ledger || o.audit || o.owner)) {
    const all = FILES.map((f) => ({ f, ids: readIds(fs.readFileSync(p(f), 'utf8')) }));
    for (const { f, ids } of all) log(`${f}\n  KV mydukapos_kv      ${ids.kv || '-'}\n  D1 mydukapos-ledger  ${ids.ledger || '-'}\n  D1 mydukapos-audit   ${ids.audit || '-'}\n  D1 mydukapos-owner   ${ids.owner || '-'}`);
    const a = all[0].ids, b = all[1].ids;
    const host = readPagesHost(fs.readFileSync(p(FILES[1]), 'utf8'));
    log(host ? `Router forwards shop addresses to: ${host}` : 'Router forwards shop addresses to: (not set: the built-in default mydukapos.pages.dev, the ORIGINAL account\'s project). On a new account run: node tools\\switch-account.mjs --pages-host <your project>.pages.dev');
    const same = ['ledger', 'audit', 'owner'].every((k) => a[k] === b[k]);
    log(same ? 'The two files agree on the database ids.' : 'WARNING: the two files hold DIFFERENT database ids.');
    return same ? 0 : 1;
  }
  const ids = { kv: o.kv === true ? '' : o.kv || '', ledger: o.ledger === true ? '' : o.ledger || '', audit: o.audit === true ? '' : o.audit || '', owner: o.owner === true ? '' : o.owner || '' };
  const bad = validate(ids);
  if (bad.length) { bad.forEach((m) => log('ERROR: ' + m)); return 2; }
  const missing = ['kv', 'ledger', 'audit', 'owner'].filter((k) => !ids[k]);
  if (missing.length) { log('ERROR: give all four ids (missing: ' + missing.map((k) => '--' + k).join(', ') + '). A half-switched config would mix two accounts.'); return 2; }
  const staged = FILES.map((f) => ({ f, ...writeIds(fs.readFileSync(p(f), 'utf8'), ids) }));
  // the router file has no KV namespace; the Pages file has all four. Every id that exists in a file must have been written.
  const expect = { 'wrangler.toml': ['kv', 'ledger', 'audit', 'owner'], [path.join('wildcard-router', 'wrangler.toml')]: ['ledger', 'audit', 'owner'] };
  for (const s of staged) { const lack = expect[s.f].filter((k) => !s.changed.includes(k)); if (lack.length) { log(`ERROR: ${s.f} has no ${lack.join(', ')} entry to change - nothing was written.`); return 2; } }
  for (const s of staged) { if (!fs.existsSync(p(s.f) + '.old-account')) fs.copyFileSync(p(s.f), p(s.f) + '.old-account'); fs.writeFileSync(p(s.f), s.text); }
  log('Written. Both files now point at the new account:');
  return run(['--show'], root, log);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)));
