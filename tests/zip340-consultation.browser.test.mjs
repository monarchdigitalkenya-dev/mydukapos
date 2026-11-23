// zip 340: consultation workspace - large popup, safety chips, drafts, admin fee, consumables once, no-diagnosis lab, idempotent save.
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

async function open(browser, base, file, seed, vp = { width: 1366, height: 768 }) {
  const ctx = await browser.newContext({ viewport: vp });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([h, invJson]) => {
    if (localStorage.getItem('seeded')) return; localStorage.setItem('seeded', '1');
    localStorage.setItem('pos_cash_config', JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }])); localStorage.setItem('pos_round_up', '0');
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'T'); const s = JSON.parse(invJson); for (const k of Object.keys(s)) localStorage.setItem(k, typeof s[k] === 'string' ? s[k] : JSON.stringify(s[k]));
  }, [H, JSON.stringify(seed)]);
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
  await page.goto(base + '/' + file); await page.waitForTimeout(1500);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; window.showToast = () => {}; });
  return { ctx, page, errs };
}


const SEED = {
  pos_patients: [{ id: 'P-1', name: 'Jane Doe', sex: 'female', phone: '0700', allergies: 'Penicillin' }, { id: 'P-2', name: 'John Clear', sex: 'male', phone: '0711' }],
  pos_inventory: [
    { code: 'CEFT', type: 'item', name: 'Ceftriaxone inj', price: 200, qty: 20, unit: 'pcs', vatCategory: 'A', adminFee: 50 },
    { code: 'GAUZE', type: 'item', name: 'Gauze', price: 10, qty: 5, unit: 'pcs', vatCategory: 'A' },
    { code: 'dressing', type: 'service', name: 'Wound dressing', price: 300, unit: 'use', vatCategory: 'A', consumables: [{ code: 'GAUZE', qty: 2 }] },
    { code: 'AMOX', type: 'item', name: 'Amoxicillin', price: 20, qty: 50, unit: 'pcs', vatCategory: 'A' },
  ],
};

test('consultation popup is 90-96% of the screen with sticky header/footer and no overflow at every size', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    for (const vp of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 820, height: 1100 }, { width: 390, height: 800 }]) {
      const { ctx, page, errs } = await open(browser, base, 'hospital/index.html', SEED, vp);
      await page.evaluate(() => openPatientVisitModal('P-1')); await page.waitForTimeout(250);
      const m = await page.evaluate(() => { const b = document.querySelector('.cw-box').getBoundingClientRect(); return { fw: b.width / innerWidth, fh: b.height / innerHeight, hs: document.documentElement.scrollWidth > innerWidth, head: document.querySelector('.cw-head').getBoundingClientRect().height > 0, footIn: document.querySelector('.cw-foot').getBoundingClientRect().bottom <= innerHeight + 1, ids: ['visit-diagnosis-input', 'visit-soap-s-input', 'visit-soap-p-input', 'visit-disposition-select', 'visit-service-select', 'lab-test-name-input'].every(i => !!document.getElementById(i)), notesVisible: !!document.getElementById('visit-notes-input').offsetParent }; });
      assert.ok(m.fw >= 0.9 && m.fw <= 1.001, 'width ' + m.fw + ' @' + vp.width); assert.ok(m.fh >= 0.9 && m.fh <= 1.001, 'height ' + m.fh + ' @' + vp.width);
      assert.equal(m.hs, false); assert.ok(m.head && m.footIn && m.ids); assert.equal(m.notesVisible, false, 'Treatment Notes is gone');
      assert.deepEqual(errs, []); await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }
});

test('allergy and vitals are never shown as normal when missing', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const { ctx, page } = await open(browser, base, 'hospital/index.html', SEED);
    await page.evaluate(() => openPatientVisitModal('P-1'));
    assert.match(await page.textContent('#cw-allergy'), /Allergies: Penicillin/); assert.match(await page.textContent('#cw-vitals'), /not recorded/i);
    await page.evaluate(() => { closePatientVisitModal(); openPatientVisitModal('P-2'); });
    assert.match(await page.textContent('#cw-allergy'), /not recorded/i); assert.doesNotMatch(await page.textContent('#cw-allergy'), /no known/i);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('admin fee only on administered medicine, consumables once, lab without diagnosis, double save is one visit, draft cleared', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const { ctx, page } = await open(browser, base, 'hospital/index.html', SEED);
    await page.evaluate(() => { openPatientVisitModal('P-1'); addVisitMedicationRow(); updateVisitMedicationRowAndRerender(0, 'code', 'CEFT'); updateVisitMedicationRowAndRerender(0, 'give', 'im'); addVisitMedicationRow(); updateVisitMedicationRowAndRerender(1, 'code', 'AMOX');
      document.getElementById('visit-service-select').value = 'dressing'; addVisitService(); document.getElementById('lab-test-name-input').value = 'Malaria RDT'; requestLabTest(); cwSaveDraft(true); });
    assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('pos_visit_drafts'))).length), 1);
    await page.evaluate(() => { saveVisit(); saveVisit(); });
    const r = await page.evaluate(() => ({ n: visits.length, dx: visits[0].diagnosis, pend: visits[0].diagnosisPending, gauze: inventory.find(x => x.code === 'GAUZE').qty, ceftStock: inventory.find(x => x.code === 'CEFT').qty, charges: patientCharges.map(c => c.name + '|' + c.price * c.qty), drafts: Object.keys(JSON.parse(localStorage.getItem('pos_visit_drafts') || '{}')).length }));
    assert.equal(r.n, 1); assert.equal(r.dx, 'Diagnosis pending'); assert.equal(r.pend, true); assert.equal(r.gauze, 3); assert.equal(r.ceftStock, 20, 'stock still comes out at the cashier, not here');
    assert.ok(r.charges.includes('Administration fee — Ceftriaxone inj (IM)|50')); assert.ok(!r.charges.some(c => /Administration fee.*Amoxicillin/.test(c)), 'no fee on take-home');
    assert.equal(r.charges.filter(c => /^Wound dressing/.test(c)).length, 1); assert.equal(r.drafts, 0);
    const again = await page.evaluate(() => { const b = patientCharges.length; createVisitCharges(visits[0], patients[0], [], 100, [], []); cwApplyConsumables(visits[0]); return [b, patientCharges.length, inventory.find(x => x.code === 'GAUZE').qty]; });
    assert.deepEqual(again, [r.charges.length, r.charges.length, 3]);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
