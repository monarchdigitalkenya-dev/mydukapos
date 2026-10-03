import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// zip 192: (1) the Windows exe prints a SNAPSHOT of the receipt / order ticket (own window, paper size passed in) - never the live page; the method can be changed;
//          (2) Hotel > Settings > Order Ticket Size: paper width + letter size, auto-fit, saved, used by the print page.
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const H = crypto.createHash('sha256').update('pw').digest('hex');
const INV = [{ code: 'A1', type: 'item', name: 'Simba Stick', category: 'Ice Cream', price: 50, wholesalePrice: 30, qty: 50, unit: 'pcs' }];

async function open(browser, base, { native = false, method = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([h, inv, native, method]) => {
    if (sessionStorage.getItem('s')) return; sessionStorage.setItem('s', '1');
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'Hannan Snacks'); localStorage.setItem('pos_inventory', JSON.stringify(inv));
    for (const k of ['pos_notif_prompt_last', 'pos_cd_detect_last']) localStorage.setItem(k, String(Date.now()));
    if (native) {
      window.__calls = [];
      window.MyDukaNative = { info: () => ({ platform: 'windows', version: '1.0.0' }),
        print: (o) => { window.__calls.push(['print', o]); return Promise.resolve({ ok: true }); },
        printHtml: (o) => { window.__calls.push(['printHtml', o]); return Promise.resolve({ ok: true }); },
        printers: () => Promise.resolve({ ok: true, printers: [] }), netPrint: () => Promise.resolve({ ok: true }) };
      localStorage.setItem('pos_native_printer_v1', JSON.stringify({ kind: 'windows-driver', deviceName: 'XP-80' }));
      if (method) localStorage.setItem('pos_native_print_method', method);
    }
  }, [H, INV, native, method]);
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.goto(base + '/hotel/index.html'); await page.waitForTimeout(1500);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; });
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}
const SALE = `(()=>{ const sale={id:'S1',refNumber:'R-1',timestamp:new Date().toISOString(),paymentMethod:'cash',cashAmount:50,servedBy:'Jane',items:[{code:'A1',name:'Simba Stick',qty:1,price:50}]}; currentReceiptSale = sale; renderReceipt(sale); document.getElementById('receipt-modal').style.display='flex'; return 1; })()`;

test('exe: receipt goes to printHtml as a snapshot with the paper size; the snapshot prints text', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  try {
    const { ctx, page, errors } = await open(browser, base, { native: true });
    await page.evaluate(SALE);
    await page.evaluate(() => { setPrintMode('receipt'); window.print(); });
    await page.waitForFunction(() => window.__calls.length > 0, null, { timeout: 5000 });
    const c = await page.evaluate(() => window.__calls[0]);
    assert.equal(c[0], 'printHtml'); assert.equal(c[1].deviceName, 'XP-80');
    assert.ok(c[1].widthMm >= 50 && c[1].heightMm >= 40, 'paper size passed: ' + JSON.stringify([c[1].widthMm, c[1].heightMm]));
    assert.ok(/Simba Stick/.test(c[1].html) && /printing-receipt/.test(c[1].html) && /<style>/.test(c[1].html), 'the snapshot carries the receipt, the print class and the styles');
    assert.ok(!/<script/i.test(c[1].html.replace(/<style>[\s\S]*?<\/style>/, '')), 'no script in the snapshot');
    // the snapshot, printed to PDF the way the exe's hidden window would, has the receipt on its page
    const p2 = await ctx.newPage(); await p2.setContent(c[1].html); await p2.emulateMedia({ media: 'print' });
    const pdf = await p2.pdf({ preferCSSPageSize: true, printBackground: true });
    fs.writeFileSync('/tmp/zip192_snapshot.pdf', pdf); fs.writeFileSync('/tmp/zip192_snapshot.html', c[1].html);
    const txt = execSync('pdftotext /tmp/zip192_snapshot.pdf -', { encoding: 'utf8' });
    assert.ok(/Simba Stick/.test(txt), 'snapshot PDF has the receipt text, not an empty page');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('exe: method 2 prints the live page with the paper size; method 3 uses the Windows window', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  try {
    let t = await open(browser, base, { native: true, method: 'page' });
    await t.page.evaluate(SALE); await t.page.evaluate(() => { setPrintMode('receipt'); window.print(); });
    await t.page.waitForFunction(() => window.__calls.length > 0, null, { timeout: 5000 });
    const c = await t.page.evaluate(() => window.__calls[0]);
    assert.equal(c[0], 'print'); assert.ok(c[1].widthMm >= 50 && c[1].heightMm >= 40);
    await t.ctx.close();
    t = await open(browser, base, { native: true, method: 'dialog' });
    await t.page.evaluate(SALE); await t.page.evaluate(() => { window.__np = 0; window.print(); });
    await t.page.waitForTimeout(600);
    assert.equal(await t.page.evaluate(() => window.__calls.length), 0, 'dialog method: no silent job');
  } finally { await browser.close(); srv.close(); }
});

test('hotel: Order Ticket Size - paper, letters, auto-fit, save, and the print page uses it', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  try {
    const { page, errors } = await open(browser, base);
    assert.ok(await page.evaluate(() => !!document.getElementById('ticket-size-open-btn')), 'the settings button exists');
    await page.evaluate(() => { lastKitchenTicketText = ticketSizeSample(); ticketSizeOpen(); });
    await page.evaluate(() => ticketSizeSet(58));
    for (let i = 0; i < 18; i++) await page.evaluate(() => ticketSizeStep(0.5));   // 11.5 -> 20 pt
    const big = await page.evaluate(() => ({ note: document.getElementById('ticket-fit-note').textContent, px: parseFloat(document.getElementById('ticket-sample-text').style.fontSize), want: 20 * 96 / 72 }));
    assert.ok(/smaller automatically/.test(big.note) && big.px < big.want, 'too big for 58 mm is shrunk: ' + JSON.stringify(big));
    // the longest sample line fits on the sample paper without wrapping
    const fits = await page.evaluate(() => { const t = document.getElementById('ticket-sample-text'); const r = document.createRange(); r.selectNodeContents(t); return r.getClientRects().length; });
    assert.ok(fits > 0);
    await page.evaluate(() => ticketSizeSave());
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('pos_ticket_size_v1'))), { mm: 58, pt: 20 });
    const pg = await page.evaluate(() => { setKitchenPrintPage(); return { rule: document.getElementById('print-page-style').textContent, w: document.body.style.getPropertyValue('--receipt-print-width'), f: document.body.style.getPropertyValue('--ticket-font') }; });
    assert.match(pg.rule, /size: 58mm /); assert.equal(pg.w, '58mm'); assert.ok(parseFloat(pg.f) > 8 && parseFloat(pg.f) < 20 * 96 / 72);
    assert.match(await page.evaluate(() => document.querySelector('.ticket-size-now').textContent), /58 mm paper, letters 20 pt/);
    // 80 mm, 11.5 pt: fits, not shrunk
    await page.evaluate(() => { ticketSizeOpen(); ticketSizeSet(80); ticketSizeReset(); ticketSizeSet(80); });
    assert.match(await page.evaluate(() => document.getElementById('ticket-fit-note').textContent), /^Fits on 80 mm/);
    await page.evaluate(() => ticketSizeSave());
    // Reset -> same as the receipt
    await page.evaluate(() => { ticketSizeOpen(); ticketSizeReset(); ticketSizeSave(); setKitchenPrintPage(); });
    const rw = await page.evaluate(() => [document.body.style.getPropertyValue('--receipt-print-width'), receiptPaperMm()]);
    assert.equal(rw[0], rw[1] + 'mm');
    // cancel does not save
    await page.evaluate(() => { ticketSizeOpen(); ticketSizeSet(58); ticketSizeCancel(); });
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('pos_ticket_size_v1'))), { mm: 0, pt: 11.5 });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('exe sources: main.js / preload.js expose printHtml and pass the paper size', () => {
  const m = fs.readFileSync(path.join(ROOT, 'native/windows/main.js'), 'utf8'), p = fs.readFileSync(path.join(ROOT, 'native/windows/preload.js'), 'utf8');
  assert.match(m, /ipcMain\.handle\('native:printHtml'/); assert.match(m, /pageSize = \{ width: Math\.round\(w \* 1000\)/); assert.match(p, /printHtml:/);
});
