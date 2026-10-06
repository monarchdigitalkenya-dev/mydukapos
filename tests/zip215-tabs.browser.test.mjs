import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

// Zip 215 - (a) Sales Counter and Bills can be hidden and are REMOVED (bar, More, side menu) until ticked again;
//           (b) Aqua POS: Add New Items, Inventory and Materials are three separate tabs.
let chromium;
try { const req = createRequire(import.meta.url); chromium = req(execSync('npm root -g').toString().trim() + '/playwright').chromium; } catch { /* no playwright */ }

test('hidden tabs are removed everywhere; Aqua has separate Inventory / Add New Items / Materials tabs', { skip: !chromium, timeout: 200000 }, async () => {
  const srv = http.createServer((req, res) => { const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const H = crypto.createHash('sha256').update('pw').digest('hex');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.route('**/api/**', r => r.abort());
    await ctx.addInitScript((h) => { localStorage.setItem('pos_cash_reg_on', '0'); if (sessionStorage.getItem('s')) return; sessionStorage.setItem('s', '1'); localStorage.setItem('aqua_pw_hash', h); localStorage.setItem('aqua_business_name', 'T'); localStorage.setItem('pos_ptl_tabs_off', JSON.stringify(['sales-tab', 'bills-tab'])); }, H);
    const page = await ctx.newPage();
    await page.goto(base + '/water/index.html#shop'); await page.waitForTimeout(1500);
    await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = 'block'; });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const vis = (id) => { const b = document.getElementById(id); if (!b) return 'missing'; const cs = getComputedStyle(b); const r = b.getBoundingClientRect(); return cs.display !== 'none' && r.width > 0; };
      const side = Array.from(document.querySelectorAll('#snav .sn-item, #snav a, #snav button')).map(e => (e.textContent || '').trim());
      const act = document.querySelector('.tab-content.active'); 
      return { sales: vis('sales-tab-btn'), bills: vis('bills-tab-btn'), settings: vis('settings-tab-btn'), inv: !!document.getElementById('inventory-tab'), add: !!document.getElementById('add-item-tab'), mat: !!document.getElementById('materials-tab'),
        invHasMaterials: !!document.querySelector('#inventory-tab #raw-materials-table'), matHasMaterials: !!document.querySelector('#materials-tab #raw-materials-table'), addHasForm: !!document.querySelector('#add-item-tab h3'), invHasForm: !!(document.querySelector('#inventory-tab') && /Add Product/.test(document.getElementById('inventory-tab').textContent)),
        side: side.join('|'), active: act && act.id };
    });
    assert.equal(r.sales, false, 'Sales Counter button removed'); assert.equal(r.bills, false, 'Bills button removed');
    assert.notEqual(r.settings, false, 'Settings always stays');
    assert.doesNotMatch(r.side, /Sales Counter/); assert.doesNotMatch(r.side, /Bills/);
    assert.notEqual(r.active, 'sales-tab', 'the hidden tab is not left on screen');
    assert.equal(r.inv && r.add && r.mat, true, 'three tabs exist');
    assert.equal(r.invHasMaterials, false); assert.equal(r.matHasMaterials, true); assert.equal(r.invHasForm, false);
    // bringing them back
    await page.evaluate(() => { localStorage.removeItem('pos_ptl_tabs_off'); });
    await page.reload(); await page.waitForTimeout(1500);
    const back = await page.evaluate(() => { const b = document.getElementById('bills-tab-btn'); return !!b && getComputedStyle(b).display !== 'none'; });
    assert.equal(back, true, 'ticked again = back');
  } finally { await browser.close(); srv.close(); }
});
