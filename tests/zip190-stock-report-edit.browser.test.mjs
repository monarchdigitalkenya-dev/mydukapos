import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// zip 190: "✏️ Edit stock report" (src/shared/blocks/stock-report-edit.html). The admin corrects what the Stock Report SHOWS (opening / added / removed /
// sold / closing for the period on screen) behind the management password, with a reason; the correction is a report-only record (never the stock
// movement log, never live quantities), shown with a "✎ corrected" marker, in the totals, the value totals and the CSV, restorable (password again),
// kept in a history, written to the synced admin activity log and surviving a reload. Real Chromium, offline (api aborted), every app that has the tab.
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const H = sha('pw'), MGMT = sha('mgmt1234');
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// Rice: closing 20 = live qty; today: +10 restock, +1 return, -2 damaged, 5 sold  =>  opening 20 - 11 + 2 + 5 = 16.   Beans: 3 sold  =>  closing 8, opening 11.
const APPS = {
  shop: { page: '/index.html', pw: 'pos_admin_pw_hash', login: ['pos_pw_hash', 'pos_biz_name'], inv: 'pos_inventory', sales: 'pos_sales_log', moves: 'pos_stock_movement_log', items: 'inventory' },
  hotel: { page: '/hotel/index.html', pw: 'pos_admin_pw_hash', login: ['pos_pw_hash', 'pos_biz_name'], inv: 'pos_inventory', sales: 'pos_sales_log', moves: 'pos_stock_movement_log', items: 'inventory' },
  pharmacy: { page: '/pharmacy/index.html', pw: 'pos_admin_pw_hash', login: ['pos_pw_hash', 'pos_biz_name'], inv: 'pos_inventory', sales: 'pos_sales_log', moves: 'pos_stock_movement_log', items: 'inventory' },
  production: { page: '/production/index.html', pw: 'pos_admin_pw_hash', login: ['pos_pw_hash', 'pos_biz_name'], inv: 'pos_inventory', sales: 'pos_sales_log', moves: 'pos_stock_movement_log', items: 'inventory' },
  services: { page: '/services/index.html', pw: 'pos_admin_pw_hash', login: ['pos_pw_hash', 'pos_biz_name'], inv: 'pos_inventory', sales: 'pos_sales_log', moves: 'pos_stock_movement_log', items: 'inventory' },
  hospital: { page: '/hospital/index.html', pw: 'pos_admin_pw_hash', login: ['pos_pw_hash', 'pos_biz_name'], inv: 'pos_inventory', sales: 'pos_sales_log', moves: 'pos_stock_movement_log', items: 'inventory' },
  water: { page: '/water/index.html', pw: 'aqua_admin_pw_hash', login: ['aqua_pw_hash', 'aqua_biz_name'], inv: 'aqua_products', sales: 'aqua_sales_log', moves: 'aqua_stock_movement_log', items: 'products' },
};
function seed() {
  const inv = [
    { code: 'R1', type: 'item', name: 'Rice', category: 'Food', price: 100, wholesalePrice: 60, qty: 20, unit: 'pcs' },
    { code: 'B1', type: 'item', name: 'Beans', category: 'Food', price: 150, wholesalePrice: 100, qty: 8, unit: 'pcs' },
  ];
  const mv = (id, code, name, delta, reason, ms) => ({ id, timestamp: iso(ms), code, name, delta, type: delta > 0 ? 'added' : 'removed', reason, by: 'Admin' });
  const moves = [mv('m1', 'R1', 'Rice', 10, 'Restock', 3000), mv('m2', 'R1', 'Rice', 1, 'Return', 2500), mv('m3', 'R1', 'Rice', -2, 'Damaged', 2200)];
  const sale = (id, code, name, price, qty, wp) => ({ id, refNumber: 'ref-' + id, timestamp: iso(1500), items: [{ code, name, price, qty, unit: 'pcs', wholesalePrice: wp }], servedBy: 'Admin', paymentMethod: 'cash', paid: true, cashAmount: price * qty, mpesaAmount: 0 });
  return { inv, moves, sales: [sale('s1', 'R1', 'Rice', 100, 5, 60), sale('s2', 'B1', 'Beans', 150, 3, 100)] };
}

async function open(browser, base, app, width = 1100) {
  const A = APPS[app], d = seed();
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 700, hasTouch: width < 700, acceptDownloads: true });
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([a, h, mg, data]) => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    localStorage.setItem(a.login[0], h); localStorage.setItem(a.login[1], 'Test Shop'); localStorage.setItem(a.pw, mg);
    localStorage.setItem(a.inv, JSON.stringify(data.inv)); localStorage.setItem(a.sales, JSON.stringify(data.sales)); localStorage.setItem(a.moves, JSON.stringify(data.moves));
  }, [A, H, MGMT, d]);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.goto(base + A.page); await page.waitForTimeout(1500);
  await showReport(page);
  return { ctx, page, errors, A };
}
async function showReport(page) {
  await page.evaluate(() => {
    for (const id of ['login-screen', 'registration-screen']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
    const a = document.getElementById('app-container'); if (a) a.style.display = '';
    document.querySelector('.tab-link[data-tab="stock-report-tab"]').click();
  });
  await page.waitForSelector('#stock-report-table tbody tr td', { timeout: 8000 });
  await page.waitForTimeout(400);
}
async function withBrowser(fn) {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try { await fn(browser, base); } finally { await browser.close(); srv.close(); }
}
// the displayed figures of one item row: [opening, added, removed, sold, closing] (numbers) + the row's text
const rowOf = (page, name) => page.evaluate((nm) => {
  const tr = Array.from(document.querySelectorAll('#stock-report-table tbody tr')).find((r) => r.children[1] && r.children[1].textContent.includes(nm));
  if (!tr) return null;
  const val = (td) => { const i = td.querySelector('.sre-in'); return i ? Number(i.value) : parseFloat(td.textContent); };
  return { v: [2, 3, 4, 5, 6].map((i) => val(tr.children[i])), text: tr.textContent, cls: tr.className, bad: tr.classList.contains('sre-bad-row') };
}, name);
const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; }, sel);
const fill = (page, code, f, v) => page.fill(`.sre-in[data-code="${code}"][data-f="${f}"]`, String(v));
const money = (n) => 'KES ' + n.toFixed(2);
async function pw(page, value) {
  await page.waitForFunction(() => { const m = document.getElementById('admin-pw-modal'); return m && getComputedStyle(m).display !== 'none'; }, null, { timeout: 5000 });
  await page.fill('#admin-pw-input', value);
  await page.evaluate(() => submitAdminPassword());
  await page.waitForTimeout(500);
}
// byte-identical books: the movement log, the sales and every item field (the sync's own "updatedAt" stamp, which any push attempt may refresh, is left out)
const snap = (page, A) => page.evaluate((a) => { const strip = (list) => JSON.stringify(list.map((p) => { const c = { ...p }; delete c.updatedAt; return c; })); const rawInv = JSON.parse(localStorage.getItem(a.inv)); return JSON.stringify([strip(eval(a.items)), JSON.stringify(stockMovementLog), JSON.stringify(salesLog), localStorage.getItem(a.moves), strip(rawInv), localStorage.getItem(a.sales)]); }, A);
const startEdit = async (page) => { await page.click('#sre-edit-btn'); await pw(page, 'mgmt1234'); await page.waitForSelector('.sre-in', { timeout: 5000 }); };

for (const app of Object.keys(APPS)) {
  test(`${app}: admin edits the stock report behind the password, corrections are report-only, marked, restorable, exported and kept`, { skip, timeout: 180000 }, async () => {
    await withBrowser(async (browser, base) => {
      const { ctx, page, errors, A } = await open(browser, base, app);
      const before = await rowOf(page, 'Rice');
      assert.deepEqual(before.v, [16, 11, 2, 5, 20], 'the report derives opening/added/removed/sold/closing from the movement log and sales');
      assert.deepEqual((await rowOf(page, 'Beans')).v, [11, 0, 0, 3, 8]);
      const costOf = async () => page.evaluate(() => (document.getElementById('srv-total-cost') || document.getElementById('stock-report-value-cost') || {}).textContent);
      assert.equal(await costOf(), money(20 * 60 + 8 * 100));

      // ---- who sees the button ----
      assert.equal(await visible(page, '#sre-edit-btn'), true, 'admin sees the button');
      await page.evaluate(() => { currentServer = { id: 'st1', name: 'Amina' }; renderStockReport(); });
      assert.equal(await visible(page, '#sre-edit-btn'), false, 'a staff login never sees it');
      await page.evaluate(() => { currentServer = null; renderStockReport(); });
      assert.equal(await visible(page, '#sre-edit-btn'), true);

      // ---- the password gate ----
      const s0 = await snap(page, A);
      await page.click('#sre-edit-btn');
      await pw(page, 'wrong-password');
      assert.equal(await page.evaluate(() => document.getElementById('admin-pw-error').textContent.length > 0), true, 'wrong password is refused');
      assert.equal(await page.locator('.sre-in').count(), 0, 'nothing is editable after a wrong password');
      assert.equal(await visible(page, '#sre-panel'), false);
      await pw(page, 'mgmt1234');
      await page.waitForSelector('.sre-in');
      assert.equal(await visible(page, '#sre-panel'), true, 'the right password opens edit mode');
      assert.match(await page.textContent('#sre-panel'), /don't change current stock — use Stock Take for that/);
      assert.deepEqual((await rowOf(page, 'Rice')).v, [16, 11, 2, 5, 20], 'inputs start at the figures shown');

      // ---- live arithmetic check, mandatory reason, confirm on a mismatch ----
      await fill(page, 'R1', 'opening', 14); await fill(page, 'R1', 'closing', 19);
      let r = await rowOf(page, 'Rice');
      assert.equal(r.bad, true); assert.match(r.text, /14 \+ 11 - 2 - 5 = 18, but Closing says 19/);
      assert.match(await page.textContent('#sre-sum'), /1 row changed · 1 does not add up/);
      await page.click('#sre-save');
      assert.equal(await page.evaluate(() => __stockRepEdit.isEditing()), true, 'no reason: still editing, nothing saved');
      assert.equal(await page.evaluate(() => __stockRepEdit.events().length), 0);
      await page.fill('#sre-reason', 'Opening and closing were wrong after the restock bug');
      let asked = null; page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
      await page.click('#sre-save'); await page.waitForTimeout(300);
      assert.match(asked || '', /do(es)? not add up/); assert.equal(await page.evaluate(() => __stockRepEdit.isEditing()), true, 'declining the confirm keeps editing');
      await fill(page, 'R1', 'closing', 18);                                        // 14 + 11 - 2 - 5 = 18: adds up
      r = await rowOf(page, 'Rice'); assert.equal(r.bad, false);
      await page.click('#sre-save'); await page.waitForTimeout(500);

      // ---- the report now shows the corrected figures ----
      assert.equal(await page.evaluate(() => __stockRepEdit.isEditing()), false);
      r = await rowOf(page, 'Rice');
      assert.deepEqual(r.v, [14, 11, 2, 5, 18]); assert.match(r.text, /✎ corrected/);
      assert.deepEqual((await rowOf(page, 'Beans')).v, [11, 0, 0, 3, 8], 'other items are untouched');
      assert.equal(await costOf(), money(18 * 60 + 8 * 100), 'value totals follow the corrected closing');
      const totals = await page.evaluate(() => [document.getElementById('stock-report-total-opening-val').textContent, document.getElementById('stock-report-total-closing-val').textContent]);
      assert.deepEqual(totals, [money(14 * 60 + 11 * 100), money(18 * 60 + 8 * 100)], 'the totals row follows the corrected figures');
      const tip = await page.evaluate(() => Array.from(document.querySelectorAll('.sre-mark')).map((m) => m.title));
      assert.equal(tip.length, 2, 'a ✎ on each corrected figure (opening, closing)');
      assert.ok(tip.every((t) => /corrected from \d+ to \d+ by .+Reason: Opening and closing were wrong/.test(t)));
      assert.match(await page.textContent('#sre-bar'), /1 item in this period has corrected figures/);

      // ---- report only: the books are byte-identical ----
      assert.equal(await snap(page, A), s0, 'movement log, sales and live quantities are unchanged');
      assert.equal(await page.evaluate((a) => eval(a.items).find((p) => p.code === 'R1').qty, A), 20);

      // ---- audit + sync: an event in the synced admin activity log, queued for push ----
      const ev = await page.evaluate(() => __stockRepEdit.events());
      assert.equal(ev.length, 1); assert.equal(ev[0].kind, 'set'); assert.equal(ev[0].code, 'R1');
      assert.deepEqual(ev[0].fields.closing, { orig: 20, corr: 18 }); assert.deepEqual(ev[0].fields.opening, { orig: 16, corr: 14 });
      assert.equal(ev[0].fields.added, undefined, 'only the changed figures are stored');
      assert.ok(ev[0].by && ev[0].at && ev[0].reason);
      const pushed = await page.evaluate(() => { const p = collectSyncPayload(); return (p.adminActivityLog || []).filter((e) => e.srCorr).map((e) => ({ id: e.id, who: e.userName, label: e.sectionLabel, code: e.srCorr.code })); });
      assert.equal(pushed.length, 1, 'the correction travels in the sync payload (adminActivityLog, merged by id on the server)'); assert.equal(pushed[0].code, 'R1');
      assert.match(pushed[0].label, /Stock report corrected: Rice/);
      // a second device that only has the synced log (no local list) still sees the correction
      await page.evaluate((a) => { const k = typeof appStoreKey === 'function' ? appStoreKey('pos_stock_report_corrections') : 'pos_stock_report_corrections'; localStorage.removeItem(k); renderStockReport(); }, A);
      assert.deepEqual((await rowOf(page, 'Rice')).v, [14, 11, 2, 5, 18], 'rebuilt from the synced log');

      // ---- show original / history ----
      await page.check('#sre-orig');
      r = await rowOf(page, 'Rice'); assert.deepEqual(r.v, [16, 11, 2, 5, 20]); assert.match(r.text, /has correction \(hidden\)/);
      assert.equal(await costOf(), money(20 * 60 + 8 * 100));
      await page.uncheck('#sre-orig');
      assert.deepEqual((await rowOf(page, 'Rice')).v, [14, 11, 2, 5, 18]);
      assert.match(await page.textContent('#sre-hist-btn'), /\(1\)/);
      await page.click('#sre-hist-btn');
      assert.match(await page.textContent('#sre-history'), /Rice[\s\S]*Correction[\s\S]*Active[\s\S]*Closing 20 → 18[\s\S]*Reason: Opening and closing were wrong/);

      // ---- CSV carries the corrected figures (and the originals) ----
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#sre-csv-btn')]);
      const csv = fs.readFileSync(await dl.path(), 'utf8');
      assert.match(csv, /R1,Rice,[^,]*,14,11,2,5,18,/); assert.match(csv, /,Yes,16,11,2,5,20,/); assert.match(csv, /B1,Beans,[^,]*,11,0,0,3,8,.*,No,/);

      // ---- print carries the marker ----
      await page.evaluate(() => { window.autoPrintEnabled = false; printStockReport(); });
      assert.match(await page.evaluate(() => document.getElementById('sales-report-body').textContent), /Rice ✎[\s\S]*1 item with corrected figures/);
      assert.match(await page.evaluate(() => lastReportText), /1 item(\(s\))? with corrected figures[\s\S]*Rice/);
      await page.evaluate(() => { document.getElementById('sales-report-modal').style.display = 'none'; });

      // ---- survives a reload ----
      await page.reload(); await page.waitForTimeout(1500); await showReport(page);
      assert.deepEqual((await rowOf(page, 'Rice')).v, [14, 11, 2, 5, 18], 'the correction survives a reload');

      // ---- restore original: password-gated, recorded, history keeps both ----
      await page.click('.sre-mark');
      assert.equal(await visible(page, '#sre-pop'), true); assert.match(await page.textContent('#sre-pop'), /Opening: 16 → 14[\s\S]*Why: Opening and closing were wrong/);
      await page.click('#sre-pop [data-sre-rowrestore]');
      await pw(page, 'wrong-password');
      assert.deepEqual((await rowOf(page, 'Rice')).v, [14, 11, 2, 5, 18], 'wrong password: not restored');
      page.once('dialog', (d) => d.accept('Restored: the code bug was fixed'));
      await pw(page, 'mgmt1234'); await page.waitForTimeout(400);
      assert.deepEqual((await rowOf(page, 'Rice')).v, [16, 11, 2, 5, 20], 'original figures are back');
      assert.equal(await page.locator('.sre-mark').count(), 0);
      assert.equal(await costOf(), money(20 * 60 + 8 * 100));
      const ev2 = await page.evaluate(() => __stockRepEdit.events());
      assert.deepEqual(ev2.map((e) => e.kind), ['set', 'restore']); assert.equal(ev2[1].target, ev2[0].id);
      assert.equal(await page.evaluate(() => __stockRepEdit.active().length), 0);
      assert.equal(await page.evaluate(() => adminActivityLog.filter((e) => e.srCorr).length), 2, 'both events are in the audit log');
      await page.click('#sre-hist-btn'); if (!(await visible(page, '#sre-history'))) await page.click('#sre-hist-btn');
      const hist = await page.textContent('#sre-history');
      assert.match(hist, /Original restored[\s\S]*Reason: Restored: the code bug was fixed/); assert.match(hist, /Correction/); assert.ok(!/Active/.test(hist));
      assert.equal(await snap(page, A), s0, 'still byte-identical after the restore');

      // ---- a mismatching save is allowed after a confirm ----
      await startEdit(page);
      await fill(page, 'B1', 'closing', 9);
      await page.fill('#sre-reason', 'Counted nine on the shelf');
      page.once('dialog', (d) => d.accept());
      await page.click('#sre-save'); await page.waitForTimeout(500);
      r = await rowOf(page, 'Beans'); assert.deepEqual(r.v, [11, 0, 0, 3, 9]); assert.match(r.text, /✎ corrected/);
      assert.equal(await page.evaluate(() => __stockRepEdit.active().length), 1);

      // ---- edit mode closes (nothing saved) when the period changes ----
      await startEdit(page);
      await fill(page, 'R1', 'sold', 4);
      await page.evaluate(() => { document.getElementById('stock-report-date-picker').value = '2020-01-02'; renderStockReport(); });
      assert.equal(await page.evaluate(() => __stockRepEdit.isEditing()), false);
      assert.equal(await page.locator('.sre-in').count(), 0);
      assert.equal(await page.evaluate(() => __stockRepEdit.events().length), 3, 'nothing extra was saved');

      assert.deepEqual(errors, []);
      await ctx.close();
    });
  });

  test(`${app}: phone (390px): edit mode is usable, big inputs, nothing scrolls sideways`, { skip, timeout: 120000 }, async () => {
    await withBrowser(async (browser, base) => {
      const { ctx, page, errors } = await open(browser, base, app, 390);
      await startEdit(page);
      const m = await page.evaluate(() => {
        const i = document.querySelector('.sre-in[data-code="R1"][data-f="closing"]'), b = i.getBoundingClientRect(), p = document.getElementById('sre-panel').getBoundingClientRect();
        return { font: parseFloat(getComputedStyle(i).fontSize), h: b.height, w: b.width, right: b.right, vw: window.innerWidth, sw: document.documentElement.scrollWidth, panelRight: p.right, panelLeft: p.left };
      });
      assert.ok(m.font >= 16, 'no zoom-on-tap: ' + m.font); assert.ok(m.h >= 40, 'tap target ' + m.h); assert.ok(m.right <= m.vw + 1, 'input inside the screen');
      assert.ok(m.sw <= m.vw + 1, `no sideways scroll (${m.sw} > ${m.vw})`); assert.ok(m.panelLeft >= 0 && m.panelRight <= m.vw + 1);
      await page.fill('.sre-in[data-code="R1"][data-f="closing"]', '19'); await page.fill('.sre-in[data-code="R1"][data-f="opening"]', '15');
      await page.fill('#sre-reason', 'phone fix');
      await page.click('#sre-save'); await page.waitForTimeout(500);
      assert.deepEqual((await rowOf(page, 'Rice')).v, [15, 11, 2, 5, 19]);
      await page.click('.sre-mark');
      const pop = await page.evaluate(() => { const r = document.getElementById('sre-pop').getBoundingClientRect(); return { l: r.left, r: r.right, vw: window.innerWidth, sw: document.documentElement.scrollWidth }; });
      assert.ok(pop.l >= 0 && pop.r <= pop.vw + 1 && pop.sw <= pop.vw + 1, 'the popover fits the phone');
      assert.deepEqual(errors, []);
      await ctx.close();
    });
  });
}

test('dark mode: the edit panel and badges use the theme (no hard-coded light surface)', { skip, timeout: 90000 }, async () => {
  await withBrowser(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, 'shop');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await startEdit(page);
    const c = await page.evaluate(() => { const p = getComputedStyle(document.getElementById('sre-panel')); return { bg: p.backgroundColor, fg: p.color }; });
    const lum = (s) => { const m = s.match(/\d+/g).map(Number); return (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / 255; };
    assert.ok(Math.abs(lum(c.bg) - lum(c.fg)) > 0.3, `readable panel in dark mode: ${c.bg} on ${c.fg}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});
