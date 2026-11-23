// zip 273 (found while moving to a new Cloudflare account): the router used to forward EVERY shop address to the hard-coded project address
// mydukapos.pages.dev. A new account's project has its own address (mydukapos-3ao.pages.dev); with the old constant its shop traffic went to the OLD
// account's project and database. The upstream is now the router's PAGES_ORIGIN variable (default unchanged for the original account).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import worker, { upstreamHost } from '../wildcard-router/worker.js';
import { readPagesHost, writePagesHost, run } from '../tools/switch-account.mjs';

const realFetch = globalThis.fetch;
async function forwarded(env, url = 'https://georgehardware.mydukapos.store/api/pos-sync?c=C1') {
  let seen = null;
  globalThis.fetch = async (req) => { seen = req; return new Response('ok'); };
  try { await worker.fetch(new Request(url), env); } finally { globalThis.fetch = realFetch; }
  return seen;
}

test('the router forwards to PAGES_ORIGIN, keeps the original host in X-Forwarded-Host, and falls back to the original account\'s address only when none is set', async () => {
  const r = await forwarded({ PAGES_ORIGIN: 'mydukapos-3ao.pages.dev', ROUTER_SHARED_SECRET: 's3cret' });
  assert.equal(new URL(r.url).hostname, 'mydukapos-3ao.pages.dev');
  assert.equal(r.headers.get('X-Forwarded-Host'), 'georgehardware.mydukapos.store');
  assert.equal(r.headers.get('X-Router-Secret'), 's3cret');
  assert.equal(new URL((await forwarded({})).url).hostname, 'mydukapos-3ao.pages.dev', 'zip 294: the default is the NEW account\'s project, never the deleted old one');
  assert.equal(upstreamHost({ PAGES_ORIGIN: 'https://evil.example/' }), 'mydukapos-3ao.pages.dev', 'only a *.pages.dev address is accepted');
  assert.equal(upstreamHost({ PAGES_ORIGIN: 'evil.com' }), 'mydukapos-3ao.pages.dev');
});

test('switch-account --pages-host writes [vars] PAGES_ORIGIN (added, then replaced), rejects a wrong address, and --show reports it', () => {
  const t1 = 'name = "x"\n\n[[d1_databases]]\nbinding = "LEDGER_DB"\ndatabase_id = "a"\n';
  const a = writePagesHost(t1, 'mydukapos-3ao.pages.dev');
  assert.equal(readPagesHost(a), 'mydukapos-3ao.pages.dev'); assert.match(a, /\[vars\]\nPAGES_ORIGIN = "mydukapos-3ao\.pages\.dev"/);
  assert.ok(a.includes('database_id = "a"'), 'nothing else changed');
  const b = writePagesHost(a, 'other.pages.dev'); assert.equal(readPagesHost(b), 'other.pages.dev'); assert.equal((b.match(/PAGES_ORIGIN/g) || []).length, 1);
  const crlf = writePagesHost('name = "x"\r\n', 'a.pages.dev'); assert.ok(crlf.includes('\r\n[vars]\r\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-'));
  fs.mkdirSync(path.join(dir, 'wildcard-router'));
  fs.writeFileSync(path.join(dir, 'wrangler.toml'), '[[kv_namespaces]]\nbinding = "mydukapos_kv"\nid = "' + 'a'.repeat(32) + '"\n');
  fs.writeFileSync(path.join(dir, 'wildcard-router', 'wrangler.toml'), t1);
  const out = []; const log = (m) => out.push(m);
  assert.equal(run(['--pages-host', 'https://evil.com'], dir, log), 2);
  assert.equal(run(['--pages-host', 'mydukapos-3ao.pages.dev'], dir, log), 0);
  assert.equal(readPagesHost(fs.readFileSync(path.join(dir, 'wildcard-router', 'wrangler.toml'), 'utf8')), 'mydukapos-3ao.pages.dev');
  assert.ok(fs.existsSync(path.join(dir, 'wildcard-router', 'wrangler.toml.old-account')));
  out.length = 0; run(['--show'], dir, log);
  assert.match(out.join('\n'), /Router forwards shop addresses to: mydukapos-3ao\.pages\.dev/);
});
