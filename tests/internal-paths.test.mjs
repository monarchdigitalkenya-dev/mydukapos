import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

// The project folder is uploaded as public files; internal ones must answer 404 while every real page still works.
const mw = () => import(pathToFileURL(path.join(ROOT, 'functions/_middleware.js')).href);
const hit = async (p, method = 'GET') => {
  const { onRequest } = await mw();
  let passed = false;
  const res = await onRequest({ request: new Request('https://georgehardware.mydukapos.store' + p, { method }), env: { ROOT_DOMAIN: 'mydukapos.store' }, next: async () => { passed = true; return new Response('page'); } });
  return { status: res.status, passed };
};

test('internal files and folders are not served', async () => {
  for (const p of ['/tests/money.test.mjs', '/src/shared/functions.js', '/tools/lib.mjs', '/wildcard-router/shop-store.js', '/functions/api/pos-sync.js',
    '/node_modules/x/index.js', '/.git/config', '/wrangler.toml', '/wrangler.staging.toml', '/package.json', '/package-lock.json', '/SYNC_AUTH_DESIGN.md',
    '/STAGING_SETUP.md', '/README.md', '/DRIFT_REPORT.md', '/.gitignore', '/.dev.vars', '/.env', '/.env.production', '/%74ests/money.test.mjs', '/TESTS/x.js']) {
    const r = await hit(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.passed, false, p + ' must not reach the static files');
  }
  assert.equal((await hit('/tests/x.js', 'POST')).status, 404, 'any method');
});

test('every real page, asset and API route still works', async () => {
  for (const p of ['/', '/index.html', '/water/index.html', '/hotel/index.html', '/owner/index.html', '/public-site/index.html', '/public-site/img/logo.png',
    '/icons/icon-192.png', '/manifest.webmanifest', '/sw.js', '/water/sw.js', '/api/pos-sync', '/api/history', '/api/owner-storage', '/testimonials/a.png', '/sources.html', '/srcset.js']) {
    const r = await hit(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.passed, true, p);
  }
});

test('the files it hides are really the internal ones (nothing an app or the public site loads is on the list)', async () => {
  const fs = await import('node:fs');
  const { isInternalPath } = await mw();
  const refs = new Set();
  for (const f of ['index.html', 'water/index.html', 'hotel/index.html', 'hospital/index.html', 'school/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'owner/index.html', 'public-site/index.html', 'public-site/app.html', 'public-site/dashboard.html', 'sw.js']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/(?:src|href)=["'](\/[^"'#?]+)["']/g)) refs.add(m[1]);
  }
  const blocked = [...refs].filter((p) => isInternalPath(p));
  assert.deepEqual(blocked, [], 'pages reference blocked paths: ' + blocked.join(', '));
});
