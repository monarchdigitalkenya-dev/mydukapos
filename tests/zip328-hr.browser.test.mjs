import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// Zip 328 — Staff & HR screens in a REAL browser against the REAL server code: conditional fields, contract rule, filters, history, PDF-only picker, HR settings.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
let chromium;
try { const req = createRequire(import.meta.url); chromium = req(execSync('npm root -g').toString().trim() + '/playwright').chromium; } catch { /* no playwright */ }

test('HR UI: employment fields follow the basis, the contract rule is shown, filters, change history, PDF-only picker, HR settings', { skip: !chromium, timeout: 280000 }, async () => {
  const app = 'index.html';
  const route = await load('functions/api/payroll.js'), sess = await load('functions/api/staff-session.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  const H = crypto.createHash('sha256').update('pw').digest('hex'), PIN = crypto.createHash('sha256').update('1234').digest('hex');
  kv.data.set('pos-data:state:C1', { value: JSON.stringify({ pwHash: H, staff: [{ id: 's-mary', name: 'Mary', pinHash: PIN, roles: [] }] }) });
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1() };
  const srv = http.createServer((req, res) => { const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const errors = [];
  try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.route('**/api/**', async (r) => {
        const rq = r.request(), u = new URL(rq.url());
        const mod = u.pathname === '/api/payroll' ? route : u.pathname === '/api/staff-session' ? sess : null;
        if (!mod) return r.abort();
        const req = new Request(rq.url(), { method: rq.method(), headers: rq.headers(), body: rq.method() === 'GET' ? undefined : rq.postData() });
        const res = await (rq.method() === 'GET' ? mod.onRequestGet : mod.onRequestPost)({ request: req, env });
        const buf = Buffer.from(await res.arrayBuffer());
        r.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: buf });
      });
      await ctx.addInitScript(([hh, app]) => { if (sessionStorage.getItem('s')) return; sessionStorage.setItem('s', '1'); localStorage.setItem('pos_pw_hash', hh); localStorage.setItem('pos_biz_name', 'Test Biz Ltd'); }, [H, app]);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
      await page.goto(base + '/' + app + '?c=C1'); await page.waitForTimeout(1500);
      await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = 'block'; });
      await page.evaluate(() => { document.getElementById('payroll-tab-btn').click(); });
      await page.waitForTimeout(800);
      await page.fill('#prl-unlock', 'pw'); await page.click('text=Unlock payroll'); await page.waitForTimeout(2500);
      // add staff: the end-date / duration fields follow the basis
      await page.click('#prl-body >> text=Add staff'); await page.waitForTimeout(300);
      await page.fill('#pe-name', 'Con Tract'); await page.fill('#pe-job_title', 'Driver'); await page.fill('#pe-start_date', '2026-03-01'); await page.fill('#pe-basic_pay', '0');
      assert.equal(await page.isVisible('#pe-internship_months'), false, 'duration only for interns');
      await page.selectOption('#pe-employment_basis', 'intern');
      assert.equal(await page.isVisible('#pe-internship_months'), true);
      await page.selectOption('#pe-employment_basis', 'contract');
      assert.match(await page.innerText('#pe-basis-note'), /contract needs an end date/i);
      await page.click('#prl-body >> text=Save employee'); await page.waitForTimeout(900);
      assert.match(await page.innerText('#prl-msg'), /contract needs an employment end date/i, 'the rule is explained, nothing saved');
      await page.fill('#pe-end_date', '2027-02-28'); await page.fill('#pe-cadre', 'Support'); await page.fill('#pe-supervisor_name', 'Boss Man');
      await page.click('#prl-body >> text=Save employee'); await page.waitForTimeout(1200);
      assert.match(await page.innerText('#prl-body'), /EMP-001/);
      assert.match(await page.innerText('#prl-body'), /KES 0/, 'KES 0 was saved as a real salary (not "not entered")');
      await page.click('.prl-sub >> text=Personal'); await page.waitForTimeout(600);
      assert.match(await page.innerText('#prl-body'), /Support/); assert.match(await page.innerText('#prl-body'), /Boss Man/);
      assert.match(await page.innerText('#prl-body'), /Contract/);
      // a second person with NO salary typed
      await page.evaluate(() => Payroll.go('staff')); await page.waitForTimeout(800);
      await page.click('#prl-body >> text=Add staff'); await page.waitForTimeout(300);
      await page.fill('#pe-name', 'No Salary'); await page.fill('#pe-cadre', 'Senior');
      await page.click('#prl-body >> text=Save employee'); await page.waitForTimeout(1200);
      await page.evaluate(() => Payroll.go('staff')); await page.waitForTimeout(900);
      const list = await page.innerText('#prl-body');
      assert.match(list, /salary not entered/i); assert.match(list, /without a salary entered/i);
      // filters
      await page.selectOption('#hf-cadre', 'Senior'); await page.waitForTimeout(900);
      const f1 = await page.innerText('#prl-body');
      assert.match(f1, /No Salary/); assert.doesNotMatch(f1, /Con Tract/, 'the cadre filter narrows the list');
      await page.click('#prl-body >> text=Clear filters'); await page.waitForTimeout(700);
      // open Con Tract: change history after an edit
      await page.click('#prl-body >> text=Con Tract'); await page.waitForTimeout(900);
      await page.click('.prl-sub >> text=Employment'); await page.waitForTimeout(500);
      await page.fill('#pe-job_title', 'Senior Driver'); await page.click('#prl-body >> text=Save employment details'); await page.waitForTimeout(1000);
      await page.click('.prl-sub >> text=Change history'); await page.waitForTimeout(800);
      assert.match(await page.innerText('#prl-body'), /Job title: Driver → Senior Driver/);
      // documents: the picker only offers PDF, and a non-PDF is refused with a clear message before upload
      await page.click('.prl-sub >> text=Documents'); await page.waitForTimeout(800);
      assert.match(await page.getAttribute('#pd-file', 'accept'), /pdf/); assert.doesNotMatch(await page.getAttribute('#pd-file', 'accept'), /image|docx/);
      await page.setInputFiles('#pd-file', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]) });
      await page.click('#prl-body >> text=Save document'); await page.waitForTimeout(700);
      assert.match(await page.innerText('#prl-msg'), /Only PDF files/i);
      await page.setInputFiles('#pd-file', { name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF') });
      await page.fill('#pd-title', 'CV'); await page.selectOption('#pd-cat', 'cv'); await page.click('#prl-body >> text=Save document'); await page.waitForTimeout(1200);
      assert.match(await page.innerText('#prl-body'), /CV/);
      // HR settings + reports
      await page.evaluate(() => Payroll.go('settings')); await page.waitForTimeout(1500);
      assert.ok(await page.isVisible('#hr-settings'));
      await page.check('#hs-wk'); await page.click('#prl-body >> text=Save HR settings'); await page.waitForTimeout(1000);
      await page.click('text=Make last week\'s reports now'); await page.waitForTimeout(1500);
      assert.match(await page.innerText('#prl-body'), /Weekly · .*\n?.*2 made|2 made/);
      assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  } finally { await browser.close(); srv.close(); }
});
