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

const PDFJS = ['/tmp/pdfjs-t/node_modules/pdfjs-dist/build', path.join(ROOT, 'node_modules/pdfjs-dist/build')].find((d) => fs.existsSync(path.join(d, 'pdf.min.js')));
const EMP = { emp_id: 'E1', emp_no: 'EMP-1', name: 'Wanjiku Kamau', job_title: 'Nurse', status: 'active', pay_frequency: 'monthly', salary_state: 'set', basic_pay: 30000, rate_unit: 'period', employment_type: 'contract', phone: '0712000111', email: 'w@x.co', id_number: '31245678', cadre: 'B', employment_basis: 'contract', work_schedule: 'part_time', end_date: '2027-03-01', branch_name: 'Main' };
const EMP_GET = { ...EMP, hr: { employment_basis: 'contract', work_schedule: 'part_time', cadre: 'B', designation: 'Staff nurse', end_date: '2027-03-01', salary_state: 'set' }, flags: { lifecycle: 'active' } };
const route = await import(pathToFileURL(path.join(ROOT, 'functions/api/payroll.js')).href);
const staffAuth = await import(pathToFileURL(path.join(ROOT, 'functions/api/_staff-auth.js')).href);

async function open(browser, base, file, state) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  await ctx.route('**/api/**', async (r) => {
    const u = r.request().url(); if (!/\/api\/payroll/.test(u)) return r.abort();
    const b = JSON.parse(r.request().postData() || '{}'); let out = { ok: true };
    if (b.action === 'whoami') out = { ok: true, sid: 'admin', admin: true, perms: [], name: 'Admin' };
    else if (b.action === 'me') out = { ok: true, employee: null, payslips: [] };
    else if (b.action === 'employee.list') out = { ok: true, employees: [EMP], filters: { cadres: [], departments: [], branches: [] } };
    else if (b.action === 'employee.get') out = { ok: true, employee: EMP_GET, numbers: state.numbers, payLines: [], history: [], lineMeta: {} };
    else if (b.action === 'employee.save') { state.saved = b; out = { ok: true, employee: EMP_GET }; }
    else if (b.action === 'numbers.save') { state.numSave = b; state.numbers = b.numbers.filter((n) => n.value.trim()).map((n, i) => ({ num_id: 'N' + i, kind: n.kind, label: n.label || null, value: n.value })); out = { ok: true, numbers: state.numbers }; }
    else if (b.action === 'numbers.all') out = { ok: true, numbers: state.numbers.map((n) => ({ emp_id: 'E1', ...n })), kinds: {} };
    else if (b.action === 'doc.list') out = { ok: true, documents: [{ doc_id: 'D1', title: 'National ID copy', category: 'national_id', status: 'active', size: 2000, expiry_date: '2027-01-01' }] };
    else if (b.action === 'hr.alerts') out = { ok: true, ended: [], ending_soon: [], salary_not_entered: [], pending_deductions: 0 };
    else if (b.action === 'run.list') out = { ok: true, runs: [] };
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
  if (PDFJS) {
    await ctx.route(/pdf\.min\.js$/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(PDFJS, 'pdf.min.js')) }));
    await ctx.route(/pdf\.worker\.min\.js$/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(PDFJS, 'pdf.worker.min.js')) }));
  }
  await ctx.addInitScript(() => { localStorage.setItem('pos_cash_config', JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }])); window.staffSessionFor = () => ({ token: 't' }); });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
  await page.goto(base + '/' + file); await page.waitForTimeout(1500);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; });
  await page.evaluate(() => { window.staffSessionFor = () => ({ token: 't' }); window.staffSessionEnsure = async () => {}; });
  await page.evaluate(() => { const b = document.querySelector('.tab-link[data-tab="staff-tab"]'); if (b) b.click(); else if (typeof performTabSwitch === 'function') performTabSwitch(null, 'staff-tab'); });
  return { ctx, page, errs };
}
const noise = (page, w, h, type) => page.evaluate(async ([w2, h2, t]) => {
  const cv = document.createElement('canvas'); cv.width = w2; cv.height = h2; const cx = cv.getContext('2d'), im = cx.createImageData(w2, h2);
  for (let i = 0; i < im.data.length; i += 4) { im.data[i] = Math.random() * 255; im.data[i + 1] = Math.random() * 255; im.data[i + 2] = Math.random() * 255; im.data[i + 3] = 255; }
  cx.putImageData(im, 0, 0); const b = await new Promise((r) => cv.toBlob(r, t)); return b.size;
}, [w, h, type]);

for (const file of ['water/index.html', 'index.html', 'hospital/index.html']) {
  test(`${file}: numbers editor, staff info PDF and staff list CSV`, { skip, timeout: 90000 }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port, state = { numbers: [{ num_id: 'N0', kind: 'national_id', label: null, value: '31245678' }, { num_id: 'N1', kind: 'phone', label: null, value: '0733000222' }] };
    const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
    try {
      const { ctx, page, errs } = await open(browser, base, file, state);
      await page.waitForSelector('#prl-staff-hub .prr', { timeout: 9000 }).catch(async (e) => { throw new Error(e.message.split('\n')[0] + ' HUB=' + (await page.evaluate(() => (document.getElementById('prl-staff-hub') || {}).textContent)) + ' ERRS=' + JSON.stringify(errs) + ' SS=' + (await page.evaluate(() => typeof window.staffSessionFor + ' ' + JSON.stringify(window.staffSessionFor && window.staffSessionFor('admin'))))); });
      await page.evaluate(() => Payroll.hub('staff', 'emp:E1')); await page.waitForSelector('#pe-numbers-box', { timeout: 9000 });
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('#pe-nums .pn-row')].filter((r) => r.querySelector('.pn-val').value.trim()).length), 2, 'the saved numbers are listed (the empty preloaded rows for the role are extra)');
      // add a licence, an employment ID, a second phone and a custom one, leave one row blank
      for (let i = 0; i < 4; i++) await page.evaluate(() => Payroll.numAdd());
      await page.evaluate(() => {
        const rows = document.querySelectorAll('#pe-nums .pn-row'); const set = (r, k, v, l) => { r.querySelector('.pn-kind').value = k; r.querySelector('.pn-kind').dispatchEvent(new Event('change')); r.querySelector('.pn-val').value = v; if (l) r.querySelector('.pn-label').value = l; };
        const n = rows.length; set(rows[n - 4], 'driving_licence', 'DL-5566'); set(rows[n - 3], 'employment_id', 'EMP/26/14'); set(rows[n - 2], 'phone', '0799123456'); set(rows[n - 1], 'other', '', '');   // the 4 rows just added (the role's preloaded rows come before them)
      });
      assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector('#pe-nums .pn-row:last-child .pn-lw')).display !== 'none'), '"Other" shows the label box');
      await page.evaluate(() => Payroll.__t.S.cur.employee.emp_id && 0); // no-op: keep the page alive
      await page.click('text=💾 Save personal details');
      await page.waitForFunction(() => true); await page.waitForTimeout(600);
      assert.ok(state.numSave, 'numbers.save was sent');
      assert.deepEqual(state.numSave.numbers.filter((n) => n.value.trim()).map((n) => [n.kind, n.value]).sort(), [['national_id', '31245678'], ['phone', '0733000222'], ['driving_licence', 'DL-5566'], ['employment_id', 'EMP/26/14'], ['phone', '0799123456']].sort());
      assert.equal(state.numSave.empId, 'E1');
      // staff info PDF
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=⬇ Download staff info (PDF)')]);
      const pdf = fs.readFileSync(await dl.path()).toString('latin1');
      assert.ok(pdf.startsWith('%PDF-') && /%%EOF\s*$/.test(pdf), 'a real PDF'); assert.match(dl.suggestedFilename(), /^staff-info-Wanjiku_Kamau\.pdf$/);
      for (const t of ['Wanjiku Kamau', 'DL-5566', 'EMP/26/14', '0799123456', 'Contract', 'Part-time', 'National ID copy']) assert.ok(pdf.includes(t), 'the sheet shows ' + t);
      // staff list CSV (from the list screen)
      await page.evaluate(() => Payroll.go('staff')); await page.waitForSelector('#prl-staff-pop:not(.on)', { state: 'attached', timeout: 9000 }); await page.waitForSelector('#prl-staff-hub .prr', { timeout: 9000 });
      const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('text=⬇ Staff list (CSV)')]);
      const csv = fs.readFileSync(await dl2.path(), 'utf8'); const lines = csv.replace(/^﻿/, '').split(/\r\n/);
      assert.match(lines[0], /^Employee No,Name,/); assert.match(lines[0], /Driving licence/); assert.match(lines[0], /Phone number/);
      assert.match(lines[1], /Wanjiku Kamau/); assert.match(lines[1], /DL-5566/); assert.match(lines[1], /0733000222 \| 0799123456/, 'two phones in one cell');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
      assert.deepEqual(errs, []);
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}

test('documents: a big photo becomes a PDF under 1.5 MB that the server accepts; several photos make one PDF; a small PDF is untouched', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port, state = { numbers: [] };
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    const { ctx, page, errs } = await open(browser, base, 'water/index.html', state);
    await page.waitForSelector('#prl-staff-hub .prr', { timeout: 9000 });
    const png = await noise(page, 3200, 2400, 'image/png'); assert.ok(png > 5 * 1024 * 1024, 'the test photo is really big: ' + png);
    const out = await page.evaluate(async () => {
      const mk = async (w, h, name) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const cx = cv.getContext('2d'), im = cx.createImageData(w, h); for (let i = 0; i < im.data.length; i += 4) { im.data[i] = Math.random() * 255; im.data[i + 1] = Math.random() * 255; im.data[i + 2] = Math.random() * 255; im.data[i + 3] = 255; } cx.putImageData(im, 0, 0); const b = await new Promise((r) => cv.toBlob(r, 'image/png')); return new File([b], name, { type: 'image/png' }); };
      const one = await PayrollKit.prepareDoc([await mk(3200, 2400, 'id-front.png')]);
      const two = await PayrollKit.prepareDoc([await mk(2400, 1800, 'a.png'), await mk(2400, 1800, 'b.png')]);
      const small = new File([new Blob(['%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF'], { type: 'application/pdf' })], 'tiny.pdf', { type: 'application/pdf' });
      const keep = await PayrollKit.prepareDoc([small]);
      let bad = ''; try { await PayrollKit.prepareDoc([new File(['x'], 'cv.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })]); } catch (e) { bad = e.message; }
      return { one, two, keep, bad };
    });
    const bytes = (u) => Buffer.from(u.split(',')[1], 'base64');
    for (const k of ['one', 'two']) { const b = bytes(out[k].dataUrl); assert.ok(b.length <= 1.5 * 1024 * 1024, k + ' is ' + b.length); assert.equal(b.slice(0, 5).toString(), '%PDF-'); assert.match(b.slice(-10).toString('latin1'), /%%EOF\s*$/); assert.match(out[k].fileName, /\.pdf$/); assert.ok(out[k].note); }
    assert.equal((bytes(out.two.dataUrl).toString('latin1').match(/\/Type \/Page /g) || []).length, 2, 'two photos = two pages in ONE pdf');
    assert.equal(out.keep.note, ''); assert.equal(out.keep.fileName, 'tiny.pdf');
    assert.match(out.bad, /PDF or a photo/);
    // the server accepts what the screen made
    const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv, LEDGER_DB: makeD1() }; const tok = (await staffAuth.issueSession(env, 'C1', { id: 'admin', name: 'Admin', perms: ['*'], mgr: true })).token;
    const call = async (b) => { const r = await route.onRequestPost({ request: new Request('https://x/api/payroll?c=C1', { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json', 'X-Staff-Token': tok } }) , env }); return { status: r.status, body: await r.json() }; };
    const e = (await call({ action: 'employee.save', employee: { name: 'A', basic_pay: 1 } })).body.employee;
    for (const k of ['one', 'two']) { const r = await call({ action: 'doc.upload', empId: e.emp_id, title: 'ID ' + k, category: 'national_id', fileName: out[k].fileName, dataUrl: out[k].dataUrl }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
    assert.deepEqual(errs, []); await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('documents: a PDF over 1.5 MB is shrunk automatically and still uploads', { skip: skip || (!PDFJS && 'pdfjs-dist not installed here'), timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port, state = { numbers: [] };
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    const { ctx, page, errs } = await open(browser, base, 'water/index.html', state);
    await page.waitForSelector('#prl-staff-hub .prr', { timeout: 9000 });
    const out = await page.evaluate(async () => {
      const cv = document.createElement('canvas'); cv.width = 2200; cv.height = 1600; const cx = cv.getContext('2d'), im = cx.createImageData(2200, 1600);
      for (let i = 0; i < im.data.length; i += 4) { im.data[i] = Math.random() * 255; im.data[i + 1] = Math.random() * 255; im.data[i + 2] = Math.random() * 255; im.data[i + 3] = 255; }
      cx.putImageData(im, 0, 0);
      const jb = new Uint8Array(await (await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.97))).arrayBuffer());
      const pages = [0, 1].map(() => ({ w: 595, h: 432, content: 'q 595 0 0 432 0 0 cm /Im0 Do Q', imgs: [{ w: 2200, h: 1600, comps: 3, bytes: jb }] }));
      const big = PayrollKit.pdfAssemble(pages); const f = new File([big], 'scan.pdf', { type: 'application/pdf' });
      const r = await PayrollKit.prepareDoc([f]); return { inSize: f.size, r };
    });
    assert.ok(out.inSize > 3 * 1024 * 1024, 'input PDF is big: ' + out.inSize);
    const b = Buffer.from(out.r.dataUrl.split(',')[1], 'base64');
    assert.ok(b.length <= 1.5 * 1024 * 1024, 'shrunk to ' + b.length); assert.match(out.r.note, /^Shrunk from/); assert.equal(b.slice(0, 5).toString(), '%PDF-');
    assert.equal((b.toString('latin1').match(/\/Type \/Page /g) || []).length, 2, 'both pages kept');
    assert.deepEqual(errs, []); await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
