import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// Zip 144 — the receipt as a REAL browser lays it out for printing (print media, the real @page), at 58 mm and 80 mm, with real
// fonts: every line is exactly one line tall (the browser wrapped nothing), nothing sticks out past the printable width, and the
// text fills that width. Skipped where Playwright is not installed. Screenshots go to RECEIPT_SHOTS (if set).
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/json' };
function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const SALE = { id: 'n1', timestamp: new Date('2026-09-26T17:39:36+03:00').getTime(), paymentMethod: 'cash', amountTendered: 400, change: 50,
  refNumber: 'ref-00002001', servedBy: 'John', items: [
    { code: '00012', name: 'Predator Shin-Guards (Black)', qty: 1, price: 350, unit: 'pcs', vatCategory: 'A' },
    { code: '5901234123457', name: 'Extra Heavy Duty Galvanised Corrugated Roofing Sheet Gauge 28 (3 metre, blue)', qty: 1250, price: 987.5, unit: 'pcs', vatCategory: 'B' }] };

for (const app of ['index.html', 'hotel/index.html', 'water/index.html']) {
  test(`${app}: real Chromium, print media — 58 mm and 80 mm receipts wrap nothing, overflow nothing, fill the printable width`, { skip }, async () => {
    const srv = await serve();
    const base = `http://127.0.0.1:${srv.address().port}`;
    const browser = await chromium.launch();
    try {
      for (const mm of ['58', '80']) {
        const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
        await ctx.route('**/api/**', (r) => r.abort());
        await ctx.addInitScript(([w]) => {
          ['pos_', 'aqua_'].forEach((p) => { localStorage.setItem(p + 'biz_name', 'NILE SPORTS WEAR'); localStorage.setItem(p + 'receipt_contact', '0704472629, 0725533442'); localStorage.setItem(p + 'receipt_extra_info', 'NORWICH UNION\nMAMA NGINA STREET'); });
          localStorage.setItem('pos_receipt_width', w); localStorage.setItem('aqua_receipt_width', w);
          // zip 253: the barcode under the reference is an opt-in Receipt Setting; this test checks it fits the paper, so it is switched on
          localStorage.setItem('pos_receipt_show_barcode', 'true'); localStorage.setItem('aqua_receipt_show_barcode', 'true');
        }, [mm]);
        const page = await ctx.newPage();
        await page.goto(`${base}/${app}`);
        await page.waitForTimeout(1500);
        await page.evaluate(([sale, w]) => {
          ['login-screen', 'staff-login-screen', 'auth-choice-screen'].forEach((id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
          window.receiptWidth = w; try { receiptWidth = w; } catch (e) { /* */ }
          window.autoPrintEnabled = false; try { autoPrintEnabled = false; } catch (e) { /* */ }
          renderReceipt(sale);
        }, [SALE, mm]);
        await page.waitForTimeout(300);
        await page.evaluate(() => { setPrintMode('receipt'); });
        await page.emulateMedia({ media: 'print' });
        await page.waitForTimeout(200);
        const m = await page.evaluate(() => {
          const g = document.querySelector('#receipt-body .receipt-grid');
          const rows = [...g.querySelectorAll('.rg-l')];
          const lh = parseFloat(getComputedStyle(rows[0]).lineHeight);
          const paper = document.getElementById('receipt-paper').getBoundingClientRect();
          const cs = getComputedStyle(document.getElementById('receipt-paper'));
          const inner = paper.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          return {
            cols: Number(g.dataset.cols), gridW: g.getBoundingClientRect().width, inner, paperW: paper.width,
            // the grand total is printed BIG on purpose (.rg-big: 2em, line-height 1.2): such a row is measured against ITS OWN line height
            tallest: Math.max(...rows.filter((r) => !r.classList.contains('rg-big')).map((r) => r.getBoundingClientRect().height)), lh,
            bigWrapped: rows.filter((r) => r.classList.contains('rg-big') && r.getBoundingClientRect().height > parseFloat(getComputedStyle(r).lineHeight) * 1.05).map((r) => r.textContent),
            overflow: rows.filter((r) => r.scrollWidth > Math.ceil(g.getBoundingClientRect().width) + 1).map((r) => r.textContent),
            barcodeW: (document.querySelector('.receipt-grid-barcode svg') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width,
            page: document.getElementById('print-page-style').textContent,
            // a truly monospaced font on the lines themselves: 10 × "i" is exactly as wide as 10 × "M"
            mono: (() => { const r = rows[0]; const probe = (t) => { const sp = document.createElement('span'); sp.style.cssText = 'font: inherit !important;'; sp.textContent = t; r.appendChild(sp); const w = sp.getBoundingClientRect().width; sp.remove(); return w; }; return Math.abs(probe('iiiiiiiiii') - probe('MMMMMMMMMM')) < 0.5; })(),
            rowFont: getComputedStyle(rows[0]).fontFamily,
          };
        });
        const label = `${app} ${mm}mm`;
        const mmPx = 96 / 25.4;
        assert.equal(m.cols, mm === '58' ? 32 : 48, `${label}: columns`);
        assert.ok(m.mono, `${label}: the receipt lines are not in a monospaced font (${m.rowFont}) — columns cannot line up`);
        assert.match(m.page, new RegExp(`size: ${mm}mm \\d+mm;`), `${label}: @page is the roll`);
        // what the browser REALLY prints on: the PDF page size (an invalid @page size falls back to Letter / A4 — 216 / 210 mm)
        const pdf = (await page.pdf({ preferCSSPageSize: true, printBackground: true })).toString('latin1');
        const box = /MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(pdf);
        assert.ok(box, `${label}: PDF page size readable`);
        const pageMm = Number(box[1]) * 25.4 / 72, pageHmm = Number(box[2]) * 25.4 / 72;
        assert.ok(Math.abs(pageMm - Number(mm)) < 1, `${label}: printed page is ${pageMm.toFixed(1)} mm wide, not ${mm} mm (A4/Letter fallback)`);
        assert.ok(pageHmm > 40 && pageHmm < 400, `${label}: page as long as the receipt (${pageHmm.toFixed(0)} mm)`);
        assert.ok(Math.abs(m.paperW - Number(mm) * mmPx) < 2, `${label}: the paper is ${mm} mm wide (${m.paperW}px)`);
        assert.ok(m.gridW <= m.inner + 0.5, `${label}: text ${m.gridW}px wider than the printable area ${m.inner}px`);
        assert.ok(m.gridW >= m.inner * 0.97, `${label}: text fills the printable width (${m.gridW} of ${m.inner}px)`);
        assert.ok(m.tallest <= m.lh * 1.05, `${label}: a line wrapped in the browser (row ${m.tallest}px, line ${m.lh}px)`);
        assert.deepEqual(m.bigWrapped, [], `${label}: a big total line wrapped in the browser`);
        assert.deepEqual(m.overflow, [], `${label}: rows overflowing`);
        assert.ok(m.barcodeW > 0 && m.barcodeW <= m.inner + 0.5, `${label}: barcode inside the printable width (${m.barcodeW}px)`);
        if (process.env.RECEIPT_SHOTS) {
          await page.emulateMedia({ media: 'screen' });
          await page.evaluate((sale) => { document.body.classList.remove('printing-receipt'); renderReceipt(sale); }, SALE);   // printing closed the preview (as it should)
          await page.waitForTimeout(200);
          const el = await page.$('#receipt-paper');
          await el.screenshot({ path: path.join(process.env.RECEIPT_SHOTS, `${app.split('/')[0].replace('.html', '') || 'shop'}-${mm}mm.png`) });
          await page.evaluate(() => { setPrintMode('receipt'); });
          await page.emulateMedia({ media: 'print' });
          await page.pdf({ path: path.join(process.env.RECEIPT_SHOTS, `${app.split('/')[0].replace('.html', '') || 'shop'}-${mm}mm.pdf`), preferCSSPageSize: true, printBackground: true });
        }
        await ctx.close();
      }
    } finally { await browser.close(); srv.close(); }
  });
}
