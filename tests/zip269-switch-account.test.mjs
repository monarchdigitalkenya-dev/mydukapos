import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
import { readIds, writeIds, validate, run, withoutRoutes, FILES } from '../tools/switch-account.mjs';

// Zip 269 - moving to another Cloudflare account: the ids in both wrangler files change together, and nothing else does.
const NEW = { kv: 'a'.repeat(32), ledger: '11111111-1111-4111-8111-111111111111', audit: '22222222-2222-4222-8222-222222222222', owner: '33333333-3333-4333-8333-333333333333' };
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-')); fs.mkdirSync(path.join(d, 'wildcard-router')); for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(d, f)); return d; };

test('the real files: all four ids are found in wrangler.toml and the three database ids in the router file, and they agree', () => {
  const a = readIds(fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8')), b = readIds(fs.readFileSync(path.join(ROOT, 'wildcard-router/wrangler.toml'), 'utf8'));
  assert.match(a.kv, /^[0-9a-f]{32}$/); for (const k of ['ledger', 'audit', 'owner']) { assert.match(a[k], /^[0-9a-f-]{36}$/); assert.equal(a[k], b[k], k + ' agrees'); }
});

test('switching writes the new ids into both files and changes NOTHING else; --back restores the old account', () => {
  const d = tmp(); const before = FILES.map((f) => fs.readFileSync(path.join(d, f), 'utf8')); const out = [];
  assert.equal(run(['--kv', NEW.kv, '--ledger', NEW.ledger, '--audit', NEW.audit, '--owner', NEW.owner], d, (m) => out.push(m)), 0, out.join('\n'));
  FILES.forEach((f, i) => {
    const after = fs.readFileSync(path.join(d, f), 'utf8'); const ids = readIds(after);
    assert.equal(ids.ledger, NEW.ledger); assert.equal(ids.audit, NEW.audit); assert.equal(ids.owner, NEW.owner); if (i === 0) assert.equal(ids.kv, NEW.kv);
    const diff = after.split('\n').map((l, n) => [l, before[i].split('\n')[n]]).filter(([x, y]) => x !== y);
    assert.equal(diff.length, i === 0 ? 4 : 3, 'only the id lines changed in ' + f);
    assert.ok(fs.existsSync(path.join(d, f) + '.old-account'));
  });
  assert.equal(run(['--back'], d, () => {}), 0);
  FILES.forEach((f, i) => assert.equal(fs.readFileSync(path.join(d, f), 'utf8'), before[i]));
});

test('refuses a half switch, a malformed id, and never writes in those cases', () => {
  const d = tmp(); const before = fs.readFileSync(path.join(d, 'wrangler.toml'), 'utf8'); const out = [];
  assert.equal(run(['--kv', NEW.kv, '--ledger', NEW.ledger], d, (m) => out.push(m)), 2); assert.match(out.join(' '), /all four/);
  assert.equal(run(['--kv', 'nope', '--ledger', NEW.ledger, '--audit', NEW.audit, '--owner', NEW.owner], d, () => {}), 2);
  assert.equal(fs.readFileSync(path.join(d, 'wrangler.toml'), 'utf8'), before);
  assert.deepEqual(validate({ kv: NEW.kv, ledger: NEW.ledger }), []); assert.equal(validate({ ledger: 'x' }).length, 1);
});

test('a commented-out example binding is never read or changed', () => {
  const t = '# [[d1_databases]]\n# database_name = "mydukapos-ledger"\n# database_id = "OLD"\n[[d1_databases]]\ndatabase_name = "mydukapos-ledger"\ndatabase_id = "12f9b35e-d4d9-468d-ac8c-2b3ff6b3848d"\n';
  assert.equal(readIds(t).ledger, '12f9b35e-d4d9-468d-ac8c-2b3ff6b3848d');
  const w = writeIds(t, { ledger: NEW.ledger }); assert.match(w.text, /# database_id = "OLD"/); assert.match(w.text, new RegExp(NEW.ledger));
});

test('--noroute writes the router config without its route and with every other line (ids included) unchanged', () => {
  const d = tmp(); const out = [];
  assert.equal(run(['--noroute'], d, (m) => out.push(m)), 0);
  const src = fs.readFileSync(path.join(d, FILES[1]), 'utf8'); const nr = fs.readFileSync(path.join(d, 'wildcard-router/wrangler.noroute.toml'), 'utf8');
  assert.ok(/^\[\[routes\]\]/m.test(src), 'the real file has a route'); assert.ok(!/^\[\[routes\]\]/m.test(nr) && !/^pattern\s*=/m.test(nr) && !/^zone_name\s*=/m.test(nr), 'the copy has none');
  for (const k of ['name = "mydukapos-wildcard-router"', 'main = "worker.js"', 'new_sqlite_classes = ["SyncRoom"]', 'new_sqlite_classes = ["ShopStore"]', 'crons =', 'binding = "LEDGER_DB"', 'binding = "OWNER_DB"']) assert.ok(nr.includes(k), k);
  assert.deepEqual(readIds(nr), readIds(src));
  assert.equal(withoutRoutes('a = 1\n[[routes]]\npattern = "x"\nzone_name = "y"\n\n[[migrations]]\ntag = "t"\n'), 'a = 1\n[[migrations]]\ntag = "t"\n');
});
