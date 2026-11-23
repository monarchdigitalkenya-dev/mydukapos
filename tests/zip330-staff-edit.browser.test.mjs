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

// Zip 330 — every part of a staff member is editable from the Staff tab, in a REAL browser against the REAL server code.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
let chromium;
try { const req = createRequire(import.meta.url); chromium = req(execSync('npm root -g').toString().trim() + '/playwright').chromium; } catch { /* no playwright */ }

test('Staff tab edits: personal details, employment, pay basics, pay lines in place, document details, roles & branches — all from the Staff tab', { skip: !chromium, timeout: 280000 }, async () => {
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
      await page.click('#prl-body >> text=Add staff'); await page.waitForTimeout(300);
      await page.fill('#pe-name', 'Edit Me'); await page.fill('#pe-phone', '0700111222'); await page.fill('#pe-job_title', 'Cook'); await page.fill('#pe-start_date', '2026-03-01'); await page.fill('#pe-basic_pay', '20000');
      await page.click('#prl-body >> text=Save employee'); await page.waitForTimeout(1200);
      await page.evaluate(() => Payroll.go('staff')); await page.waitForTimeout(800);
      await page.click('#prl-body >> text=Edit Me'); await page.waitForTimeout(900);
      // PERSONAL tab is editable
      await page.click('.prl-sub >> text=Personal'); await page.waitForTimeout(500);
      await page.fill('#pe-phone', '0799888777'); await page.fill('#pe-address', 'Kilimani'); await page.fill('#pe-emergency_name', 'Sister');
      await page.click('#prl-body >> text=Save personal details'); await page.waitForTimeout(1000);
      assert.match(await page.innerText('#prl-body'), /0799888777/);
      assert.equal(await page.inputValue('#pe-address'), 'Kilimani', 'the saved value is shown in the form');
      // EMPLOYMENT tab no longer repeats the personal box
      await page.click('.prl-sub >> text=Employment'); await page.waitForTimeout(500);
      assert.equal(await page.isVisible('#pe-phone'), false); assert.equal(await page.inputValue('#pe-job_title'), 'Cook');
      await page.fill('#pe-job_title', 'Head Cook'); await page.fill('#pe-designation', 'Kitchen lead');
      await page.click('#prl-body >> text=Save employment details'); await page.waitForTimeout(1000);
      assert.equal(await page.inputValue('#pe-designation'), 'Kitchen lead');
      // SALARY tab: pay basics editable, pay line added then edited in place
      await page.click('.prl-sub >> text=Salary & deductions'); await page.waitForTimeout(800);
      await page.fill('#pe-basic_pay', '25000'); await page.selectOption('#pe-pay_method', 'mpesa');
      await page.click('#prl-body >> text=Save pay basics'); await page.waitForTimeout(1000);
      assert.match(await page.innerText('#prl-body'), /25,000/);
      await page.fill('#pl-label', 'Meal allowance'); await page.fill('#pl-amount', '3000'); await page.click('#prl-body button:text-is("Add")'); await page.waitForTimeout(1000);
      await page.click('#prl-body a:text-is("edit")'); await page.waitForTimeout(500);
      await page.fill('#el-label', 'Lunch allowance'); await page.fill('#el-amount', '4500'); await page.fill('#el-reason', 'raised'); await page.uncheck('#el-active');
      await page.click('#prl-modal >> text=Save'); await page.waitForTimeout(1000);
      const pay = await page.innerText('#prl-body');
      assert.match(pay, /Lunch allowance/); assert.doesNotMatch(pay, /Meal allowance/, 'edited in place, not duplicated'); assert.match(pay, /4,500/); assert.match(pay, /off/); assert.match(pay, /raised/);
      assert.equal((pay.match(/Lunch allowance/g) || []).length, 1);
      // DOCUMENTS: details edited without a new upload
      await page.click('.prl-sub >> text=Documents'); await page.waitForTimeout(700);
      await page.setInputFiles('#pd-file', { name: 'id.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF') });
      await page.fill('#pd-title', 'ID'); await page.click('#prl-body >> text=Save document'); await page.waitForTimeout(1200);
      await page.click('#prl-body >> text=Edit details'); await page.waitForTimeout(500);
      await page.fill('#de-title', 'National ID card'); await page.selectOption('#de-cat', 'contract'); await page.fill('#de-exp', '2031-05-01');
      await page.click('#prl-modal >> text=Save'); await page.waitForTimeout(1000);
      const docs = await page.innerText('#prl-body');
      assert.match(docs, /National ID card/); assert.match(docs, /2031/); assert.match(docs, /1 KB/);
      // ROLES: main branch + extra branches editable
      await page.click('.prl-sub >> text=Roles & branches'); await page.waitForTimeout(600);
      await page.fill('#ro-main', 'Westlands'); await page.fill('#ro-br', 'Westlands, Main');
      await page.click('#prl-body >> text=Save'); await page.waitForTimeout(1000);
      await page.click('.prl-sub >> text=Roles & branches'); await page.waitForTimeout(500);
      assert.equal(await page.inputValue('#ro-main'), 'Westlands'); assert.equal(await page.inputValue('#ro-br'), 'Westlands, Main');
      // everything above is in the change history
      await page.click('.prl-sub >> text=Change history'); await page.waitForTimeout(800);
      const hist = await page.innerText('#prl-body');
      assert.match(hist, /Job title: Cook → Head Cook/); assert.match(hist, /Branch/);
      assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  } finally { await browser.close(); srv.close(); }
});
