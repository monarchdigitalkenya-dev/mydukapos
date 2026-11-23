// zip 338: hotel phone layout - no sideways scroll on any tab, short top bar, usable form boxes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/json' };
const serve = () => new Promise((r) => { const s = http.createServer((q, res) => { const p = path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); }); s.listen(0, '127.0.0.1', () => r(s)); });
const H = crypto.createHash('sha256').update('pw').digest('hex');

async function open(browser, base, file, inv, vp = { width: 1366, height: 768 }) {
  const ctx = await browser.newContext({ viewport: vp, isMobile: true, hasTouch: true });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([h, invJson]) => {
    if (localStorage.getItem('seeded')) return; localStorage.setItem('seeded', '1');
    localStorage.setItem('pos_cash_config', JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }])); localStorage.setItem('pos_round_up', '0');
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'T'); localStorage.setItem('pos_inventory', invJson);
  }, [H, JSON.stringify(inv)]);
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
  await page.goto(base + '/' + file); await page.waitForTimeout(1500);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; window.showToast = () => {}; });
  return { ctx, page, errs };
}



const INV = [{ code: 'COLA', type: 'item', name: 'Cola', price: 80, qty: 30, unit: 'pcs', category: 'Drinks' }];
const goto = (page, t) => page.evaluate((t) => guardedSwitchTab({ preventDefault() {}, currentTarget: null, target: null }, t), t);

test('hotel on a phone: every tab fits the width, the top bar is short, forms are usable', { skip, timeout: 240000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    for (const w of [360, 390]) {
      const { ctx, page, errs } = await open(browser, base, 'hotel/index.html', INV, { width: w, height: 800 });
      const tabs = await page.evaluate(() => [...document.querySelectorAll('.tab-content')].map((e) => e.id));
      assert.ok(tabs.length > 20);
      for (const t of tabs) {
        await goto(page, t); await page.waitForTimeout(250);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${t} overflows at ${w}`);
      }
      const hh = await page.evaluate(() => document.querySelector('body > header').getBoundingClientRect().height);
      assert.ok(hh <= 140, 'top bar height ' + hh);
      assert.equal(await page.evaluate(() => { const k = document.querySelector('.floating-kb-btn'); return !k || getComputedStyle(k).display === 'none'; }), true);
      // the bar "set up a drink" rows keep boxes wide enough to type in
      await goto(page, 'bar-tab'); await page.waitForTimeout(500);
      const widths = await page.evaluate(() => [...document.querySelectorAll('.bar-cfg-row input:not([type=checkbox])')].map((i) => i.getBoundingClientRect().width));
      assert.ok(widths.length >= 6 && widths.every((x) => x >= 38), 'bar row boxes ' + widths.join(','));
      // the inventory type chips wrap as chips, not one full-width button each
      await goto(page, 'inventory-list-tab'); await page.waitForTimeout(500);
      const bw = await page.evaluate(() => [...document.querySelectorAll('#inv-cat-bar button')].map((b) => b.getBoundingClientRect().width));
      assert.ok(bw.length >= 3 && bw.some((x) => x < w * 0.6), 'chips ' + bw.join(','));
      assert.deepEqual(errs, []);
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }
});
