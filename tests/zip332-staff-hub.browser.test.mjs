import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// zip 332: People > Staff hub + tick-box bulk payroll on a phone, in every module that has payroll (server calls are stubbed).
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
const serve = () => new Promise((r) => { const s = http.createServer((q, res) => { const p = path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); }); s.listen(0, '127.0.0.1', () => r(s)); });
const EMPS = [
  { emp_id: 'E1', emp_no: 'EMP-1', name: 'Ann Wanjiru', job_title: 'Nurse', status: 'active', pay_frequency: 'monthly', salary_state: 'set', salary: 30000 },
  { emp_id: 'E2', emp_no: 'EMP-2', name: 'Ben Otieno', job_title: 'Cashier', status: 'active', pay_frequency: 'monthly', salary_state: 'set', salary: 20000 },
  { emp_id: 'E3', emp_no: 'EMP-3', name: 'Cy Kamau', job_title: 'Guard', status: 'active', pay_frequency: 'monthly', salary_state: 'unset' },
];
for (const file of ['hospital/index.html', 'index.html', 'hotel/index.html', 'water/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html']) {
  test(`${file}: Staff hub lists staff and bulk payroll sends only the ticked people`, { skip, timeout: 90000 }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
    const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      let created = null;
      await ctx.route('**/api/**', async (r) => {
        const u = r.request().url();
        if (!/\/api\/payroll/.test(u)) return r.abort();
        const b = JSON.parse(r.request().postData() || '{}'); let out = { ok: true };
        if (b.action === 'whoami') out = { ok: true, sid: 'admin', admin: true, perms: [], name: 'Admin' };
        else if (b.action === 'me') out = { ok: true, employee: null, payslips: [] };
        else if (b.action === 'employee.list') out = { ok: true, employees: EMPS, filters: { cadres: [], departments: [], branches: [] } };
        else if (b.action === 'hr.alerts') out = { ok: true, ended: [], ending_soon: [], salary_not_entered: [], pending_deductions: 0 };
        else if (b.action === 'run.create') { created = b; out = { ok: true, runId: 'R1', ref: 'PR-1', warnings: [] }; }
        else if (b.action === 'run.list') out = { ok: true, runs: [] };
        else if (b.action === 'run.get') out = { ok: true, run: { run_id: 'R1', ref: 'PR-1', label: 'x', status: 'draft', kind: 'regular', period_start: '2026-10-01', period_end: '2026-10-31', total_basic: 0, total_additions: 0, total_deductions: 0, total_net: 0 }, items: [] };
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
      });
      await ctx.addInitScript(() => { localStorage.setItem('pos_cash_config', JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }])); window.staffSessionFor = () => ({ token: 't' }); });
      const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
      await page.goto(base + '/' + file); await page.waitForTimeout(1500);
      await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; window.staffSessionFor = () => ({ token: 't' }); });
      const hasStaffTab = await page.evaluate(() => !!document.getElementById('staff-tab'));
      assert.ok(hasStaffTab, 'the app has a Staff tab');
      await page.evaluate(() => { const b = document.querySelector('.tab-link[data-tab="staff-tab"]'); if (b) b.click(); else if (typeof performTabSwitch === 'function') performTabSwitch(null, 'staff-tab'); });
      await page.waitForSelector('#prl-staff-hub .prr', { timeout: 9000 });
      const hub = await page.evaluate(() => document.getElementById('prl-staff-hub').textContent);
      assert.match(hub, /Add staff/); assert.match(hub, /Payroll runs/); assert.match(hub, /Ann Wanjiru/); assert.match(hub, /Ben Otieno/);
      // bulk payroll
      await page.evaluate(() => Payroll.hub('runs', 'bulk'));
      await page.waitForSelector('.nr-tick', { timeout: 9000 });
      const ticks = await page.evaluate(() => Array.from(document.querySelectorAll('.nr-tick')).map((c) => [c.value, c.checked, c.disabled]));
      assert.deepEqual(ticks, [['E1', true, false], ['E2', true, false], ['E3', false, true]], 'everyone with a salary starts ticked; no salary = cannot be ticked');
      await page.evaluate(() => { document.querySelector('.nr-tick[value="E2"]').click(); });
      assert.match(await page.evaluate(() => document.getElementById('nr-go').textContent), /1 person/);
      await page.evaluate(() => document.getElementById('nr-go').click());
      await page.waitForFunction(() => true); await page.waitForTimeout(600);
      assert.deepEqual(created && created.empIds, ['E1']);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
      assert.deepEqual(errs, []);
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}
