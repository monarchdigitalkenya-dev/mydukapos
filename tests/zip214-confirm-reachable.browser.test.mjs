import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

// Zip 214 - the Confirm button must always be reachable (on a short screen it fell below the clipped checkout card).
let chromium;
try { const req = createRequire(import.meta.url); chromium = req(execSync('npm root -g').toString().trim() + '/playwright').chromium; } catch { /* no playwright */ }

test('Confirm is reachable on short / narrow screens in shop and hotel', { skip: !chromium, timeout: 280000 }, async () => {
  const srv = http.createServer((req, res) => { const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const H = crypto.createHash('sha256').update('pw').digest('hex');
  const inv = []; for (let i = 0; i < 12; i++) inv.push({ code: 'C' + i, type: 'item', name: 'Lager ' + i, category: 'Beer', price: 230, qty: 30, unit: 'pcs' });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const bad = [];
  try {
    for (const app of ['hotel/index.html', 'index.html']) for (const [w, h] of [[1366, 560], [1366, 700], [1024, 600], [1280, 420]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      await ctx.route('**/api/**', r => r.abort());
      await ctx.addInitScript(([hh, inv]) => { if (sessionStorage.getItem('s')) return; sessionStorage.setItem('s', '1'); localStorage.setItem('pos_pw_hash', hh); localStorage.setItem('pos_biz_name', 'T'); localStorage.setItem('pos_inventory', JSON.stringify(inv)); }, [H, inv]);
      const page = await ctx.newPage();
      await page.goto(base + '/' + app); await page.waitForTimeout(1200);
      await page.evaluate(() => { document.getElementById('login-screen').style.display = 'none'; });
      await page.evaluate(() => { for (let i = 0; i < 2; i++) { const c = document.querySelectorAll('#item-image-grid .item-grid-cell')[i]; if (c) c.click(); } });
      await page.waitForTimeout(300);
      for (const m of ['cash', 'mpesa', 'split']) {
        await page.evaluate((m) => setPaymentMethod(m), m); await page.waitForTimeout(350);
        const r = await page.evaluate(() => { const b = document.getElementById('main-checkout-btn'); b.scrollIntoView({ block: 'end' }); const rc = b.getBoundingClientRect(); let e = b.parentElement, clip = null; while (e && e !== document.documentElement) { const cs = getComputedStyle(e); if (cs.overflowY !== 'visible') { const pr = e.getBoundingClientRect(); if (rc.bottom > pr.bottom + 1 || rc.top < pr.top - 1) { clip = e.className; break; } } e = e.parentElement; } return { clip, off: rc.bottom > innerHeight + 1 || rc.top < 0, shown: rc.height > 0 }; });
        if (r.clip || r.off || !r.shown) bad.push(app + ' ' + w + 'x' + h + ' ' + m + ' ' + JSON.stringify(r));
      }
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }
  assert.deepEqual(bad, []);
});
