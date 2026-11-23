import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { pathToFileURL } from 'node:url';

// zip 332: People > Staff hub + tick-box bulk payroll on a phone, in every module that has payroll (server calls are stubbed).
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
const serve = () => new Promise((r) => { const s = http.createServer((q, res) => { const p = path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); }); s.listen(0, '127.0.0.1', () => r(s)); });

const EMPS = [
  { emp_id: 'E1', emp_no: 'EMP-1', name: 'Ann Wanjiru', job_title: 'Nurse', status: 'active', pay_frequency: 'monthly', salary_state: 'set', basic_pay: 30000, rate_unit: 'period', pos_staff_id: 'st-1' },
  { emp_id: 'E2', emp_no: 'EMP-2', name: 'Ben Otieno', job_title: 'Guard', status: 'active', pay_frequency: 'monthly', salary_state: 'unset' },
];
const GET = (id) => ({ ok: true, employee: { ...EMPS.find((e) => e.emp_id === id), hr: { employment_basis: 'permanent', work_schedule: 'full_time' }, flags: {} }, numbers: [{ num_id: 'N0', kind: 'national_id', label: null, value: '31245678' }], payLines: [], history: [], lineMeta: {} });
for (const file of ['index.html', 'hotel/index.html', 'water/index.html', 'services/index.html']) {
  test(`${file}: Staff tab is a list of names; a tap opens one popup with numbers, documents and access; adding staff is on the tab`, { skip, timeout: 100000 }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
    const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await ctx.route('**/api/**', async (r) => {
        if (!/\/api\/payroll/.test(r.request().url())) return r.abort();
        const b = JSON.parse(r.request().postData() || '{}'); let out = { ok: true };
        if (b.action === 'whoami') out = { ok: true, sid: 'admin', admin: true, perms: [], name: 'Admin' };
        else if (b.action === 'me') out = { ok: true, employee: null, payslips: [] };
        else if (b.action === 'employee.list') out = { ok: true, employees: EMPS, filters: { cadres: [], departments: [], branches: [] } };
        else if (b.action === 'employee.get') out = GET(b.empId);
        else if (b.action === 'doc.list') out = { ok: true, documents: [{ doc_id: 'D1', title: 'National ID copy', category: 'national_id', status: 'active', size: 2000, expiry_date: '2027-01-01' }] };
        else if (b.action === 'hr.alerts') out = { ok: true, ended: [], ending_soon: [], salary_not_entered: [], pending_deductions: 0 };
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
      });
      await ctx.addInitScript(() => { localStorage.setItem('pos_cash_config', JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }])); window.staffSessionFor = () => ({ token: 't' }); });
      const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
      await page.goto(base + '/' + file); await page.waitForTimeout(1500);
      await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; });
      await page.evaluate(() => { window.staffSessionFor = () => ({ token: 't' }); window.staffSessionEnsure = async () => {}; });
      await page.evaluate(() => { const b = document.querySelector('.tab-link[data-tab="staff-tab"]'); if (b) b.click(); else performTabSwitch(null, 'staff-tab'); });
      await page.waitForSelector('#prl-staff-hub .prr', { timeout: 9000 });
      const names = await page.evaluate(() => Array.from(document.querySelectorAll('#prl-staff-hub .prr b')).map((x) => x.textContent));
      assert.deepEqual(names, ['Ann Wanjiru', 'Ben Otieno'], 'just a list of names');
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#staff-tab > .panel:not(.prl)')).display), 'none', 'the old roster block is not shown any more');
      // a tap opens the popup - the Payroll tab is NOT opened
      await page.click('#prl-staff-hub .prr >> nth=1');
      await page.waitForSelector('#prl-staff-pop.on #pe-numbers-box', { timeout: 9000 });
      assert.equal(await page.evaluate(() => document.getElementById('payroll-tab').classList.contains('active')), false, 'no redirect to the Payroll tab');
      const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('#prl-staff-pop .prl-sub button')).map((x) => x.textContent));
      for (const t of ['Personal', 'Employment', 'Salary & deductions', 'Documents']) assert.ok(tabs.includes(t), 'popup has ' + t + ' / ' + tabs.join('|'));
      assert.ok(!tabs.some((t) => /Login/.test(t)), 'Ben has no POS login');
      await page.click('#prl-staff-pop .prl-sub button:has-text("Documents")');
      await page.waitForTimeout(800); const dtxt = await page.evaluate(() => document.getElementById('prl-staff-pop').innerText); assert.match(dtxt, /Documents?/); assert.ok(/National ID copy/.test(dtxt), 'DOCS TAB: ' + dtxt.slice(0, 600));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
      await page.click('#prl-staff-pop .prl-pop-bar button');
      assert.equal(await page.evaluate(() => document.getElementById('prl-staff-pop').classList.contains('on')), false);
      // a person with a POS sign-in also gets the "Login & access" tab, holding the app's own roster card
      await page.evaluate(() => { staff.push({ id: 'st-1', name: 'Ann Wanjiru', roles: [], pinHash: 'x' }); });
      await page.click('#prl-staff-hub .prr >> nth=0');
      await page.waitForSelector('#prl-staff-pop .prl-sub button:has-text("Login & access")', { timeout: 9000 });
      await page.click('#prl-staff-pop .prl-sub button:has-text("Login & access")');
      await page.waitForSelector('#prl-staff-pop #prl-access-host .staff-roster-card', { timeout: 9000 });
      const acc = await page.evaluate(() => document.getElementById('prl-access-host').innerText);
      assert.match(acc, /Ann Wanjiru/); assert.match(acc, /Allowed tabs/);
      await page.click('#prl-staff-pop .prl-pop-bar button');
      assert.equal(await page.evaluate(() => !!document.querySelector('#payroll-tab > .panel.prl')), true, 'the payroll panel went back to its tab');
      // Add staff lives on the tab
      await page.click('text=➕ Add staff');
      await page.waitForSelector('#prl-staff-pop.on .prl-add-choice', { timeout: 5000 });
      await page.click('text=Someone who will sign in to the POS');
      const inPop = await page.evaluate(() => !!document.querySelector('#prl-staff-pop #new-staff-name-input') && !!document.querySelector('#prl-staff-pop #invite-link-result'));
      assert.ok(inPop, 'the invite form (name, tabs, manager, link) is in the popup, not in Settings');
      assert.equal(await page.evaluate(() => !!document.querySelector('#settings-section-staff #new-staff-name-input')), false);
      await page.click('#prl-staff-pop .prl-pop-bar button');
      await page.click('text=➕ Add staff'); await page.waitForSelector('.prl-add-choice');
      await page.click('text=A staff record only');
      await page.waitForSelector('#prl-staff-pop #pe-name', { timeout: 9000 });
      assert.equal(await page.evaluate(() => !!document.querySelector('#prl-staff-pop #pe-numbers-box')), true, 'a new record can take registration numbers too');
      assert.deepEqual(errs, []);
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}
