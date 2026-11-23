// zip 284: `switch-account --kv .. --ledger .. --audit .. --owner .. --pages-host X` in ONE command used to write the four ids and silently ignore --pages-host,
// so the router kept forwarding shop addresses to the OLD account's project (error 1016 / 503 on shop subdomains). Both are now written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPagesHost, run } from '../tools/switch-account.mjs';

test('--pages-host together with the four ids writes the ids AND PAGES_ORIGIN', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa284-'));
  fs.mkdirSync(path.join(dir, 'wildcard-router'));
  const NAMES = { LEDGER_DB: 'mydukapos-ledger', LEDGER_AUDIT_DB: 'mydukapos-audit', OWNER_DB: 'mydukapos-owner' };
  const d1 = (b) => `[[d1_databases]]\nbinding = "${b}"\ndatabase_name = "${NAMES[b]}"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\n`;
  fs.writeFileSync(path.join(dir, 'wrangler.toml'), '[[kv_namespaces]]\nbinding = "mydukapos_kv"\nid = "' + 'a'.repeat(32) + '"\n' + d1('LEDGER_DB') + d1('LEDGER_AUDIT_DB') + d1('OWNER_DB'));
  fs.writeFileSync(path.join(dir, 'wildcard-router', 'wrangler.toml'), 'name = "r"\n' + d1('LEDGER_DB') + d1('LEDGER_AUDIT_DB') + d1('OWNER_DB'));
  const out = []; const log = (m) => out.push(m);
  const code = run(['--kv', 'e34ec52d47f44f899a0daeb3fcf54a08', '--ledger', '5cb41a51-8b84-46f3-b152-1f6ef3668143', '--audit', 'b5d57318-63ee-4b12-98ab-50cbcadf8763', '--owner', 'f505cb96-d38a-4f6c-bb0c-6f6f59857d02', '--pages-host', 'mydukapos-3ao.pages.dev'], dir, log);
  assert.equal(code, 0);
  const router = fs.readFileSync(path.join(dir, 'wildcard-router', 'wrangler.toml'), 'utf8');
  assert.equal(readPagesHost(router), 'mydukapos-3ao.pages.dev');
  assert.ok(router.includes('5cb41a51-8b84-46f3-b152-1f6ef3668143'));
  assert.match(out.join('\n'), /Router forwards shop addresses to: mydukapos-3ao\.pages\.dev/);
});
