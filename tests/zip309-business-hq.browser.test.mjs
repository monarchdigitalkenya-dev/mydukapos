import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';

// zip 309: the Business HQ screen in a REAL browser, inside the real Shop and Hotel apps, talking to the REAL server code (every /api/* request
// is answered by the matching Pages Function with the fakes), on a phone and a desktop.
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) { try { chromium = createRequire('/opt/npm-tools/node_modules/')('playwright').chromium; } catch (e2) { chromium = null; } }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function backend() {
  const kv = makeKV(), shop = await makeBinding();
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), SHOP_STORE: shop, LICENSE_CACHE_MS: '0', EDGE_CACHE_MS: '0' };
  const lic = (id, slug, extra) => { kv.data.set('license:' + id, { value: JSON.stringify({ id, type: 'permanent', product: 'shop', slug, label: slug, branchGroupId: 'G', createdAt: 1, ...extra }) }); kv.data.set('slug:' + slug, { value: id }); kv.data.set('pos-data:mode:' + id, { value: 'do' }); };
  lic('M', 'main', { isMainBranch: true }); lic('B', 'westlands');
  kv.data.set('branch-group:G', { value: JSON.stringify(['M', 'B']) }); kv.data.set('license-index:v1', { value: '[]' });
  const push = (id, body) => shop.get(id).fetch('https://shop-store/push', { method: 'POST', body: JSON.stringify({ body, serverNow: Date.now(), _shop: id }) });
  await push('M', { businessName: 'Biz', adminPwHash: sha('ownerpass'), pwHash: sha('ownerpass'), staff: [{ id: 's-jane', name: 'Jane Wanjiru', pinHash: sha('1111'), roles: ['sales-tab'], updatedAt: 1 }] });
  await push('B', { businessName: 'Westlands', staff: [] });
  const fns = new Map();
  const handle = async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.pathname.startsWith('/api/')) {
      const name = u.pathname.slice(5).replace(/[^a-z0-9-]/gi, '');
      const f = path.join(ROOT, 'functions/api', name + '.js');
      if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '{}' });
      if (!fns.has(name)) fns.set(name, await import(pathToFileURL(f).href));
      const m = fns.get(name), method = req.method();
      const fn = method === 'POST' ? m.onRequestPost : method === 'GET' ? m.onRequestGet : m.onRequestOptions;
      if (!fn) return route.fulfill({ status: 405, body: '{}' });
      const request = new Request(req.url(), { method, headers: req.headers(), body: method === 'POST' ? req.postData() : undefined });
      try { const res = await fn({ request, env, waitUntil() {} }); return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) }); }
      catch (e) { return route.fulfill({ status: 500, body: JSON.stringify({ error: String(e && e.message) }) }); }
    }
    let p = u.pathname === '/' ? '/index.html' : u.pathname; let f = path.join(ROOT, p);
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');   // zip 381: /hotel/ is the app itself, as on the real site
    if (!fs.existsSync(f) || !f.startsWith(ROOT)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: /\.html$/.test(f) ? 'text/html' : /\.js$/.test(f) ? 'text/javascript' : /\.css$/.test(f) ? 'text/css' : 'application/octet-stream', body: fs.readFileSync(f) });
  };
  return { env, shop, handle };
}

for (const [app, vp] of [['index.html', { width: 1366, height: 860 }], ['hotel/index.html', { width: 390, height: 844 }]]) {
  test(`browser (${app}, ${vp.width}px): owner signs in, names a branch, places a person at a second branch; the audit shows it`, { skip: !chromium || !hasSqlite, timeout: 180000 }, async () => {
    const be = await backend();
    const b = await chromium.launch();
    try {
      const ctx = await b.newContext({ viewport: vp, isMobile: vp.width < 600, hasTouch: vp.width < 600 });
      await ctx.route('https://main.mydukapos.store/**', be.handle);
      await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
      const p = await ctx.newPage(); const errs = [];
      p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept());
      await p.goto('https://main.mydukapos.store/' + (app === 'index.html' ? '' : app), { waitUntil: 'load' });
      await p.waitForFunction(() => typeof window.openBusinessHQ === 'function', null, { timeout: 30000 });
      await p.evaluate(() => window.openBusinessHQ());
      // zip 325: no password - the Admin signed in on the main branch's till opens HQ straight away
      await p.waitForSelector('#bhq [data-tab="branches"]', { timeout: 20000 });     // zip 310: HQ opens on the Dashboard
      await p.click('#bhq [data-tab="branches"]');
      await p.waitForSelector('#bhq [data-edit="B"]', { timeout: 20000 });
      assert.match(await p.textContent('#bhq .bhq-body'), /2 branches · 2 active/);
      if (process.env.BHQ_SHOT) await p.screenshot({ path: process.env.BHQ_SHOT + '-' + vp.width + '-branches.png' });
      // name and code the Westlands branch
      await p.click('#bhq [data-edit="B"]');
      await p.fill('#bhq-b-name', 'Westlands'); await p.fill('#bhq-b-code', 'wld'); await p.fill('#bhq-b-loc', 'Westlands, Nairobi');
      await p.click('#bhq .bhq-modal button[type=submit]');
      await p.waitForFunction(() => !document.querySelector('#bhq .bhq-modal') && /WLD/.test(document.querySelector('#bhq .bhq-body').textContent), null, { timeout: 20000 });
      // place Jane at Westlands too
      await p.click('#bhq [data-tab="staff"]');
      await p.waitForSelector('#bhq [data-move="s-jane"]', { timeout: 20000 });
      await p.click('#bhq [data-move="s-jane"]');
      await p.fill('#bhq-a-why', 'covers weekends');
      if (process.env.BHQ_SHOT) await p.screenshot({ path: process.env.BHQ_SHOT + '-' + vp.width + '-assign.png' });
      await p.click('#bhq .bhq-modal button[type=submit]');
      await p.waitForFunction(() => { const t = document.querySelector('#bhq .bhq-body'); return t && /Westlands · WLD/.test(t.textContent) && document.querySelectorAll('#bhq .bhq-chip:not(.gone)').length >= 2; }, null, { timeout: 20000 });
      const westStaff = JSON.parse(await (await be.shop.get('B').fetch('https://shop-store/export', { method: 'POST', body: '{}' })).text()).staff || [];
      assert.ok(westStaff.some((s) => s.id === 's-jane' && !s.removed), 'Jane is in the Westlands staff list on the server');
      await p.click('#bhq [data-tab="more"]');     // zip 311: the audit trail is under More
      await p.click('#bhq [data-tab="audit"]');
      await p.waitForFunction(() => /Added to another branch/.test(document.querySelector('#bhq .bhq-body').textContent), null, { timeout: 20000 });
      assert.match(await p.textContent('#bhq .bhq-body'), /covers weekends/);
      if (process.env.BHQ_SHOT) { await p.click('#bhq [data-tab="staff"]'); await p.waitForTimeout(800); await p.screenshot({ path: process.env.BHQ_SHOT + '-' + vp.width + '-staff.png' }); await p.click('#bhq [data-tab="more"]'); await p.click('#bhq [data-tab="audit"]'); await p.waitForTimeout(800); }
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no sideways scroll');
      assert.deepEqual(errs.filter((e) => !/Failed to fetch|NetworkError|Load failed/.test(e)), []);
      await ctx.close();
    } finally { await b.close(); }
  });
}
