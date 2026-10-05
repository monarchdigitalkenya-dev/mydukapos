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

// Zip 216 - Create Payroll in a REAL browser against the REAL server code (route -> engine -> SQL): sign in, add staff, run payroll,
// review -> approve -> pay, open the payslip, make a real PDF. Also: a worker with no payroll rights sees nothing of anyone else's pay.
let chromium;
try { const req = createRequire(import.meta.url); chromium = req(execSync('npm root -g').toString().trim() + '/playwright').chromium; } catch { /* no playwright */ }
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const OUT = process.env.PRL_OUT || '';

for (const app of ['index.html', 'water/index.html']) test(`${app}: Admin runs payroll end to end in the browser; a worker sees only their own paid payslip`, { skip: !chromium, timeout: 280000 }, async () => {
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
    for (const who of ['admin', 'mary']) {
      const ctx = await browser.newContext({ viewport: who === 'admin' ? { width: 1280, height: 900 } : { width: 390, height: 800 } });
      await ctx.route('**/api/**', async (r) => {
        const rq = r.request(), u = new URL(rq.url());
        const mod = u.pathname === '/api/payroll' ? route : u.pathname === '/api/staff-session' ? sess : null;
        if (!mod) return r.abort();
        const req = new Request(rq.url(), { method: rq.method(), headers: rq.headers(), body: rq.method() === 'GET' ? undefined : rq.postData() });
        const res = await (rq.method() === 'GET' ? mod.onRequestGet : mod.onRequestPost)({ request: req, env });
        const buf = Buffer.from(await res.arrayBuffer());
        r.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: buf });
      });
      await ctx.addInitScript(([hh, app]) => { if (sessionStorage.getItem('s')) return; sessionStorage.setItem('s', '1'); localStorage.setItem(app === 'index.html' ? 'pos_pw_hash' : 'aqua_pw_hash', hh); localStorage.setItem(app === 'index.html' ? 'pos_biz_name' : 'aqua_biz_name', 'Test Biz Ltd'); }, [H, app]);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(who + ': ' + String(e.message).slice(0, 200)));
      await page.goto(base + '/' + app + '?c=C1' + (app.startsWith('water') ? '#shop' : '')); await page.waitForTimeout(1500);
      await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = 'block'; });
      if (who === 'mary') {
        // the worker: signs in with her PIN (the app's own staff session), only "My payslips" exists for her, never anyone else's pay
        await page.evaluate(async (pin) => { currentServer = { id: 's-mary', name: 'Mary' }; staffSessionStart('s-mary', pin); }, PIN);
        await page.waitForTimeout(1200);
        await page.evaluate(() => Payroll.open());
        await page.waitForTimeout(1500);
        const t = await page.evaluate(() => document.getElementById('prl-body').innerText);
        assert.doesNotMatch(t, /45,000|Add staff|Run payroll|Settings/, 'a worker sees no one\'s pay and no admin actions');
        assert.match(t, /My payslips|No payroll access|not linked/i);
        await ctx.close(); continue;
      }
      // ---- Admin ----
      const btn = await page.evaluate(() => { const b = document.getElementById('payroll-tab-btn'); return b && getComputedStyle(b).display; });
      assert.notEqual(btn, 'none', 'the Payroll button shows for the Admin');
      await page.evaluate(() => { document.getElementById('payroll-tab-btn').click(); });
      await page.waitForTimeout(800);
      assert.match(await page.innerText('#prl-body'), /Sign in to open payroll/);
      await page.fill('#prl-unlock', 'wrong'); await page.click('text=Unlock payroll'); await page.waitForTimeout(800);
      assert.match(await page.innerText('#prl-unlock-msg'), /Incorrect/i);
      await page.fill('#prl-unlock', 'pw'); await page.click('text=Unlock payroll'); await page.waitForTimeout(2500);
      assert.match(await page.innerText('#prl-body'), /employees/i);
      // add staff through the form
      await page.click('#prl-body >> text=Add staff'); await page.waitForTimeout(300);
      await page.fill('#pe-name', 'John Doe'); await page.fill('#pe-job_title', 'Cashier'); await page.fill('#pe-basic_pay', '30000'); await page.fill('#pe-phone', '0712345678');
      await page.selectOption('#pe-pos', { value: 's-mary' }).catch(() => {});
      await page.click('text=Save employee'); await page.waitForTimeout(1200);
      assert.match(await page.innerText('#prl-body'), /EMP-001/);
      const shot = async (n) => { if (OUT) await page.screenshot({ path: path.join(OUT, `prl-${app.replace(/\W+/g, '_')}-${n}.png`) }); };
      await shot('profile');
      // a repeating allowance + an advance (Payroll sub-tab)
      await page.fill('#pl-label', 'House allowance'); await page.fill('#pl-amount', '5000'); await page.click('#prl-body >> button:has-text("Add")'); await page.waitForTimeout(900);
      await page.selectOption('#pl-kind', 'deduction'); await page.fill('#pl-label', 'Salary advance'); await page.fill('#pl-amount', '2000'); await page.click('#prl-body >> button:has-text("Add")'); await page.waitForTimeout(900);
      // a document
      await page.click('.prl-sub >> text=Documents'); await page.waitForTimeout(700);
      await page.setInputFiles('#pd-file', { name: 'id-copy.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF') });
      await page.click('text=Save document'); await page.waitForTimeout(1200);
      assert.match(await page.innerText('#prl-body'), /id-copy/);
      // run payroll
      await page.click('.prl-nav >> text=Payroll'); await page.waitForTimeout(800);
      await page.click('#prl-body >> text=Run payroll'); await page.waitForTimeout(300);
      await page.click('text=Create draft payroll'); await page.waitForTimeout(1500);
      await shot('run-draft');
      let t = await page.innerText('#prl-body');
      assert.match(t, /Net pay \(1 staff\)/); assert.match(t, /33,000/, 'basic 30,000 + 5,000 - 2,000');
      page.once('dialog', (d) => d.accept()); await page.click('text=Review & lock'); await page.waitForTimeout(1200);
      page.once('dialog', (d) => d.accept()); await page.click('text=Approve payroll'); await page.waitForTimeout(1200);
      await page.click('text=Mark as paid'); await page.waitForTimeout(300);
      await page.fill('#pp-r', 'QXY123'); await page.click('text=Confirm paid'); await page.waitForTimeout(1500);
      t = await page.innerText('#prl-body'); assert.match(t, /Paid/); assert.match(t, /QXY123/);
      assert.equal(await page.locator('text=Mark as paid').count(), 0, 'nothing left to press after paid');
      await shot('run-paid');
      // payslip
      await page.click('.prl-list .prl-row'); await page.waitForTimeout(1200);
      const slip = await page.innerText('#prl-modal-in');
      assert.match(slip, /PAYSLIP/); assert.match(slip, /Test Biz Ltd/); assert.match(slip, /John Doe/); assert.match(slip, /House allowance/); assert.match(slip, /Salary advance/); assert.match(slip, /33,000/); assert.match(slip, /QXY123/);
      const b64 = await page.evaluate(async () => { const b = await Payroll.calc.slipPdfBlob(Payroll.calc.current()); const ab = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < ab.length; i++) s += String.fromCharCode(ab[i]); return btoa(s); });
      const pdfBuf = Buffer.from(b64, 'base64');
      assert.equal(pdfBuf.slice(0, 5).toString(), '%PDF-'); assert.match(pdfBuf.slice(-6).toString(), /%%EOF/);
      assert.ok(pdfBuf.includes(Buffer.from('John Doe')) && pdfBuf.includes(Buffer.from('33,000.00')), 'the PDF carries the name and the net pay');
      fs.writeFileSync(path.join(OUT || '/tmp', `prl-${app.replace(/\W+/g, '_')}-slip.pdf`), pdfBuf);
      await page.screenshot({ path: path.join(OUT || '/tmp', `prl-${app.replace(/\W+/g, '_')}-slip.png`) });
      await ctx.close();
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
