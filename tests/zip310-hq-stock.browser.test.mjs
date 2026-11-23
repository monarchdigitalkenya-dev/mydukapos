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

// zip 310: Business HQ Dashboard / Stock / Transfers / Reports / Roles in a REAL browser inside the real apps, every /api/* request answered by
// the real Pages Functions (fakes for KV, D1 and the shop databases). Phone and desktop.
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
  await push('M', { businessName: 'Biz', adminPwHash: sha('ownerpass'), pwHash: sha('ownerpass'), staff: [{ id: 's-jane', name: 'Jane Wanjiru', pinHash: sha('1111'), roles: ['sales-tab'], updatedAt: 1 }],
    inventory: [{ code: 'SUG', name: 'Sugar 1kg', qty: 50, price: 200, wholesalePrice: 150, updatedAt: 1 }, { code: 'OIL', name: 'Cooking oil 1L', qty: 2, price: 400, wholesalePrice: 300, updatedAt: 1 }] });
  await push('B', { businessName: 'Westlands', staff: [], inventory: [] });
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
    const p = u.pathname === '/' ? '/index.html' : u.pathname; let f = path.join(ROOT, p);
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');   // zip 381: /hotel/ is the app itself, as on the real site
    if (!fs.existsSync(f) || !f.startsWith(ROOT)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: /\.html$/.test(f) ? 'text/html' : /\.js$/.test(f) ? 'text/javascript' : /\.css$/.test(f) ? 'text/css' : 'application/octet-stream', body: fs.readFileSync(f) });
  };
  const qty = async (id, code) => { const st = JSON.parse(await (await shop.get(id).fetch('https://shop-store/export', { method: 'POST', body: '{}' })).text()); const i = (st.inventory || []).find((x) => x.code === code); return i ? Number(i.qty) : null; };
  return { env, shop, handle, qty };
}
const body = (p, re) => p.waitForFunction((r) => new RegExp(r).test((document.querySelector('#bhq') || {}).textContent || ''), re.source, { timeout: 20000 });

for (const [app, vp] of [['index.html', { width: 1366, height: 860 }], ['hotel/index.html', { width: 390, height: 844 }]]) {
  test(`browser (${app}, ${vp.width}px): dashboard, a store and a move, a transfer from request to receipt, a report, a role`, { skip: !chromium || !hasSqlite, timeout: 240000 }, async () => {
    const be = await backend();
    const b = await chromium.launch();
    try {
      const ctx = await b.newContext({ viewport: vp, isMobile: vp.width < 600, hasTouch: vp.width < 600, acceptDownloads: true });
      await ctx.route('https://main.mydukapos.store/**', be.handle);
      await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
      const p = await ctx.newPage(); const errs = [];
      p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept());
      await p.goto('https://main.mydukapos.store/' + (app === 'index.html' ? '' : app), { waitUntil: 'load' });
      await p.waitForFunction(() => typeof window.openBusinessHQ === 'function', null, { timeout: 30000 });
      await p.evaluate(() => window.openBusinessHQ());
      // zip 325: no password - HQ opens straight away for the Admin
      await body(p, /Sales today/); await body(p, /Items running low/);
      const shot = async (n) => { if (process.env.BHQ_SHOT) await p.screenshot({ path: process.env.BHQ_SHOT + '-311-' + vp.width + '-' + n + '.png', fullPage: false }); };
      await shot('overview');
      // Stock: one list, a Main store is already there; add to the store, then move right from the item
      await p.click('#bhq [data-tab="stock"]'); await p.waitForSelector('#bhq [data-add="SUG"]');
      assert.match(await p.textContent('#bhq .bhq-items'), /Main store/);
      await p.click('#bhq [data-add="SUG"]'); await p.waitForSelector('#bhq .bhq-modal #bhq-aq');
      assert.ok(await p.isVisible('#bhq .bhq-modal [data-mx]'), 'the X is visible at once');
      await p.fill('#bhq-aq', '20'); await p.click('#bhq .bhq-modal button[type=submit]');
      await p.waitForFunction(() => !document.querySelector('#bhq .bhq-modal') && /Main store\s*20/.test((document.querySelector('#bhq .bhq-items') || {}).textContent || ''), null, { timeout: 20000 });
      await p.click('#bhq [data-mv="SUG"]'); await p.waitForSelector('#bhq .bhq-modal #bhq-mq');
      await p.fill('#bhq-mq', '25'); await p.click('#bhq .bhq-modal button[type=submit]'); await body(p, /Only 20/);
      await p.click('#bhq .bhq-modal [data-qm="bhq-mq"]'); await p.fill('#bhq-mq', '5');
      await shot('move');
      const box = await p.locator('#bhq .bhq-modal .bhq-acts').boundingBox();
      assert.ok(box && box.y + box.height <= vp.height + 1, 'the Move button is on screen without scrolling');
      await p.click('#bhq .bhq-modal button[type=submit]');
      await p.waitForFunction(() => !document.querySelector('#bhq .bhq-modal') && /Main store\s*15/.test((document.querySelector('#bhq .bhq-items') || {}).textContent || ''), null, { timeout: 20000 });
      assert.equal(await be.qty('M', 'SUG'), 55, 'the shop floor got the 5');
      await shot('stock');
      // Send to another branch: goes out at once (no approval step), Westlands confirms
      await p.click('#bhq [data-snd="SUG"]'); await p.waitForSelector('#bhq .bhq-modal #bhq-sq2');
      await p.fill('#bhq-sq2', '10'); await shot('send'); await p.click('#bhq .bhq-modal button[type=submit]');
      await p.waitForFunction(() => !document.querySelector('#bhq .bhq-modal'), null, { timeout: 20000 });
      assert.equal(await be.qty('M', 'SUG'), 45); assert.equal(await be.qty('B', 'SUG'), null, 'on the way: not at Westlands yet');
      await p.click('#bhq [data-tab="xfers"]'); await p.waitForSelector('#bhq [data-x2]');
      await p.click('#bhq [data-x2]'); await p.waitForSelector('#bhq .bhq-modal [data-do="receive"]');
      await p.click('#bhq .bhq-modal [data-probs]'); await p.fill('#bhq .bhq-modal [data-rr]', '9'); await p.fill('#bhq .bhq-modal [data-rd]', '1'); await shot('receive');
      await p.click('#bhq .bhq-modal [data-do="receive"]');
      await p.waitForSelector('#bhq .bhq-modal [data-do="resolve"]');
      assert.equal(await be.qty('B', 'SUG'), 9);
      await p.fill('#bhq .bhq-modal [data-rn]', 'bag torn in the van'); await p.click('#bhq .bhq-modal [data-do="resolve"]');
      await p.waitForFunction(() => /Received/.test((document.querySelector('#bhq .bhq-modal .bhq-mhead') || {}).textContent || '') && !document.querySelector('#bhq .bhq-modal [data-do="resolve"]'), null, { timeout: 20000 });
      await p.click('#bhq .bhq-modal [data-mx]');
      // Reports: stock, consolidated, CSV
      await p.click('#bhq [data-tab="reports"]'); await p.waitForSelector('#bhq-rt');
      await p.selectOption('#bhq-rt', 'report.stock'); await p.click('#bhq-rf button[type=submit]');
      await body(p, /Value at cost/); await body(p, /Main store/);
      const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#bhq [data-a="csv"]')]);
      const csv = fs.readFileSync(await dl.path(), 'utf8');
      assert.match(csv, /Branch,Location,Code,Item/); assert.match(csv, /Main store,SUG/);
      // Roles live under More
      await p.click('#bhq [data-tab="more"]'); await p.click('#bhq [data-tab="roles"]'); await p.waitForSelector('#bhq [data-tpl="cashier"]');
      await p.click('#bhq [data-tpl="cashier"]'); await p.click('#bhq .bhq-modal button[type=submit]');
      await body(p, /Cashier/);
      await p.click('#bhq [data-tab="dash"]'); await body(p, /Latest stock moves/);
      // the Business HQ button in the Staff tab stays, even when a staff member is checked in and when the tab redraws
      await p.click('#bhq [data-a="close"]');
      const kept = await p.evaluate(async () => { const st = document.getElementById('staff-tab'); if (!st) return 'no-staff-tab'; try { window.currentServer = { id: 'x', name: 'X' }; } catch (e) { /* ok */ } st.innerHTML = '<div>redrawn</div>'; await new Promise((r) => setTimeout(r, 300)); const b = st.querySelector('#bhq-open'); return b && b.style.display !== 'none' ? 'kept' : 'gone'; });
      assert.equal(kept, 'kept');
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no sideways scroll');
      assert.deepEqual(errs.filter((e) => !/Failed to fetch|NetworkError|Load failed/.test(e)), []);
      await ctx.close();
    } finally { await b.close(); }
  });
}
