process.env.TZ = 'Africa/Nairobi';                       // the golden hashes below print the sale's date and time
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APPS, boot, decodeEscPos, until, ROOT } from './helpers.mjs';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { mergeIncomingState, SETTINGS_NEED_STAMP_FIELDS } from '../functions/api/_merge.js';

// zip 158 — "Adjust receipt size": the letter size (points) is CHOSEN, it drives the columns, and a window shows a live sample receipt.
// Every app is covered; the print engine itself (raster path, relay jobs) is exercised with a fake canvas.

// what the default (7 pt = 32 / 48 columns) produces for this sale - the default must stay byte for byte the same. Recorded at zip 158;
// re-recorded at zip 316 after reviewing the printed text line by line: since then the TOTAL is printed big and bold (double size, its own line
// on a 58 mm roll), deliberately. USB / Bluetooth bytes and relay bytes are still identical to each other.
// zip 379: byte fingerprints updated on purpose - every receipt now prints DARK (ESC E 1 + ESC G 1 = bold + double-strike)
const GOLDEN = {
  'index.html@58': { grid: '62b8db3e11988ef3', bytes: '4035473dc009bc23', sectioned: 'e8581d7804a61e70' },
  'index.html@80': { grid: 'd4f470e3f6fb0787', bytes: 'dffaefc8094e772d', sectioned: '51559fd1ca5e161d' },
  'water/index.html@58': { grid: '3fe1a49f6aedb028', bytes: '990d135e9de96fed', sectioned: '990d135e9de96fed' },
  'water/index.html@80': { grid: '45dc26ee4d9f2d8f', bytes: '59284f2a92634367', sectioned: '59284f2a92634367' },
  'hotel/index.html@58': { grid: '62b8db3e11988ef3', bytes: 'e8581d7804a61e70', sectioned: 'e8581d7804a61e70' },
  'hotel/index.html@80': { grid: 'd4f470e3f6fb0787', bytes: '51559fd1ca5e161d', sectioned: '51559fd1ca5e161d' },
  'hospital/index.html@58': { grid: '62b8db3e11988ef3', bytes: 'e8581d7804a61e70', sectioned: 'e8581d7804a61e70' },
  'hospital/index.html@80': { grid: 'd4f470e3f6fb0787', bytes: '51559fd1ca5e161d', sectioned: '51559fd1ca5e161d' },
  'production/index.html@58': { grid: '62b8db3e11988ef3', bytes: 'e8581d7804a61e70', sectioned: 'e8581d7804a61e70' },
  'production/index.html@80': { grid: 'd4f470e3f6fb0787', bytes: '51559fd1ca5e161d', sectioned: '51559fd1ca5e161d' },
  'services/index.html@58': { grid: '62b8db3e11988ef3', bytes: '4035473dc009bc23', sectioned: 'e8581d7804a61e70' },
  'services/index.html@80': { grid: 'd4f470e3f6fb0787', bytes: 'dffaefc8094e772d', sectioned: '51559fd1ca5e161d' },
  'pharmacy/index.html@58': { grid: '62b8db3e11988ef3', bytes: 'e8581d7804a61e70', sectioned: 'e8581d7804a61e70' },
  'pharmacy/index.html@80': { grid: 'd4f470e3f6fb0787', bytes: '51559fd1ca5e161d', sectioned: '51559fd1ca5e161d' },
};
const SALE = { id: 'g1', timestamp: new Date('2026-09-26T17:39:36+03:00').getTime(), paymentMethod: 'cash', amountTendered: 5000, change: 1576.5, refNumber: 'R-00012', servedBy: 'Jane', orderType: 'walkin',
  items: [
    { code: '00012', name: 'Padlock Brass 50mm Heavy Duty Long Name Item', qty: 2, price: 450, unit: 'pcs', vatCategory: 'A' },
    { code: '00420', name: 'Nails 3" (1kg)', qty: 1, price: 183.5, unit: 'pcs', vatCategory: 'A' },
    { code: '00777', name: 'Cement 50kg – Bamburi', qty: 3, price: 780, unit: 'pcs', vatCategory: 'B' } ] };
const hash = (x) => crypto.createHash('sha256').update(x).digest('hex').slice(0, 16);
const STORE = { pos_biz_name: 'GOLDEN SHOP', aqua_biz_name: 'GOLDEN SHOP', pos_receipt_show_barcode: 'true', pos_receipt_print_vat: 'true' };   // zip 253: barcode and VAT are opt-in Receipt Settings; these tests check the layout with both on
const gridText = (d) => [...d.querySelectorAll('#receipt-body .receipt-grid .rg-l')].map((e) => e.textContent).join('\n');
const $ = (d, id) => d.getElementById(id);

// A minimal 2D canvas: every non-space character paints a block, measureText is a perfect 0.6 em monospace. Records what was drawn.
function fakeCanvas(log = []) {
  return function () {
    const cv = this;
    if (!cv.__ctx) {
      let px = 12, data = null;
      const ensure = () => { if (!data || data.length !== cv.width * cv.height * 4) data = new Uint8ClampedArray(cv.width * cv.height * 4).fill(255); };
      cv.__ctx = {
        set font(v) { const m = /(\d+(?:\.\d+)?)px/.exec(v); if (m) px = parseFloat(m[1]); this._f = v; }, get font() { return this._f; },
        fillStyle: '#000', textBaseline: 'top',
        measureText: (t) => ({ width: String(t).length * 0.6 * px }),
        fillRect() { ensure(); if (this.fillStyle === '#ffffff') data.fill(255); },
        fillText(t, x, y) {
          ensure(); log.push({ t: String(t), x, y, font: this._f, W: cv.width });
          for (let i = 0; i < t.length; i++) {
            if (t[i] === ' ') continue;
            const x0 = Math.floor(x + i * 0.6 * px);
            for (let yy = Math.floor(y); yy < Math.floor(y + px * 0.7) && yy < cv.height; yy++) for (let xx = x0; xx < x0 + Math.max(1, Math.floor(0.4 * px)) && xx < cv.width; xx++) { const k = (yy * cv.width + xx) * 4; data[k] = data[k + 1] = data[k + 2] = 0; }
          }
        },
        getImageData(x, y, w, h) { ensure(); return { data, width: w, height: h }; },
      };
    }
    return cv.__ctx;
  };
}
// GS v 0 pieces of a byte stream: [{ bpr, rows, dataLen }]
function rasters(bytes) {
  const a = Array.from(bytes), out = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0x1D && a[i + 1] === 0x76 && a[i + 2] === 0x30) {
      const bpr = a[i + 4] + a[i + 5] * 256, rows = a[i + 6] + a[i + 7] * 256;
      out.push({ bpr, rows, at: i, dataLen: bpr * rows }); i += 7 + bpr * rows;
    }
  }
  return out;
}
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0));
const quiet = (w) => { w.__toasts = []; w.eval('showToast = function (m, e) { window.__toasts.push(String(m)); }'); };

for (const app of APPS) {
  test(`${app}: the standard size (7 pt) is 32 / 48 columns and prints exactly what it always did`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: STORE, wait: 700 });
    quiet(w);
    assert.equal(w.eval('receiptFontPtNow()'), 7, 'the default letter size is 7 pt');
    for (const mm of ['58', '80']) {
      w.eval(`receiptWidth='${mm}'; receiptCustomWidth='';`);
      assert.equal(w.eval('getPaperCols()'), mm === '58' ? 32 : 48, `${mm} mm columns`);
      w.eval('renderReceipt(' + JSON.stringify(SALE) + ')');
      assert.equal(d.querySelector('#receipt-body .receipt-grid').style.getPropertyValue('--rg-font'), '9.333px', 'the grid is drawn at 7 pt = 9.333 px');
      const bytes = w.eval("typeof buildReceiptEscPosBytes === 'function' ? buildReceiptEscPosBytes(lastReceiptHeader,lastReceiptItemSection,lastReceiptFooter) : buildEscPosBytes(lastReceiptText)");
      const sect = w.eval('buildSectionedReceiptBytes(lastReceiptHeader,lastReceiptItemSection,lastReceiptFooter)');
      const g = GOLDEN[`${app}@${mm}`];
      assert.equal(hash(gridText(d)), g.grid, `${app} ${mm} mm: the preview text is unchanged`);
      assert.equal(hash(Buffer.from(bytes)), g.bytes, `${app} ${mm} mm: the USB / Bluetooth bytes are unchanged`);
      assert.equal(hash(Buffer.from(sect)), g.sectioned, `${app} ${mm} mm: the relay bytes are unchanged`);
      assert.equal(decodeEscPos(bytes).fontA, true);
    }
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: Settings has ONE "Adjust receipt size" button and no paper-width select or scale slider; the served page has no scale leftovers`, async () => {
    const html = fs.readFileSync(path.join(ROOT, app), 'utf8');
    for (const bad of [/receiptScale/, /receipt-scale/, /print-zoom/, /Print Scale/i, /--receipt-print-scale/, /receipt-width-select/, /receipt-width-custom-input/, /fitReceiptGrids/]) assert.doesNotMatch(html, bad, `${app}: ${bad}`);
    assert.equal((html.match(/id="receipt-size-open-btn"/g) || []).length, 1, 'one Adjust receipt size button');
    assert.match(html, /🔠 Adjust receipt size/);
    assert.match(html, /id="receipt-size-modal"/);
    // the only mention of the old storage keys is the silent clean-up
    const hits = html.split('\n').filter((l) => /pos_receipt_scale|aqua_receipt_scale/.test(l));
    assert.ok(hits.every((l) => /rxDel\(/.test(l)), `${app}: old scale keys are only ever deleted`);
    const { d, close } = await boot(app, { wait: 500 });
    assert.equal(d.querySelectorAll('input[type=range][id*=scale]').length, 0);
    assert.equal(d.querySelectorAll('#settings-section-receipts [id*="scale"]').length, 0);
    assert.equal($(d, 'receipt-size-modal').parentElement, d.body, 'the window is a top-level page element (the print CSS hides everything but the receipt)');
    close();
  });

  test(`${app}: an old stored receipt scale does nothing and is removed; old scale in a synced payload is ignored`, async () => {
    const { w, close } = await boot(app, { storage: { pos_receipt_scale: '130', aqua_receipt_scale: '70' }, wait: 600 });
    assert.equal(w.eval('getPaperCols()'), 48);
    assert.equal(w.localStorage.getItem('pos_receipt_scale'), null);
    assert.equal(w.localStorage.getItem('aqua_receipt_scale'), null);
    assert.equal(w.eval("typeof receiptScale"), 'undefined');
    const payload = w.eval("JSON.stringify(typeof collectSyncPayload === 'function' ? collectSyncPayload() : {})");
    assert.doesNotMatch(payload, /receiptScale/, 'the app no longer sends a scale');
    w.eval("try { applyRemotePayload({ receiptScale: 70, receiptWidth: '80' }); } catch (e) {}");   // an old server copy: harmless
    assert.equal(w.eval('getPaperCols()'), 48);
    close();
  });

  test(`${app}: the window opens at the current size; − / + / typing / chips change the columns and the live sample; the sample is the real receipt`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: { ...STORE, pos_receipt_font_pt: '9' }, wait: 700 });
    quiet(w);
    w.eval("receiptWidth='80'; receiptCustomWidth=''; setDevicePaperWidth('', true)");
    w.eval('receiptSizeOpen()');
    assert.equal($(d, 'receipt-size-modal').style.display, 'block');
    assert.equal($(d, 'rsz-pt').value, '9', 'starts at the CURRENT saved size');
    const box = $(d, 'rsz-paper');
    assert.equal(box.dataset.pt, '9'); assert.equal(box.style.width, '80mm', 'a box as wide as the paper');
    const cols9 = Number(box.dataset.cols);
    assert.equal(cols9, Math.floor((72 * 96 / 25.4) / (0.6 * 12 * 1.005)), 'characters per line from the size');
    assert.match($(d, 'rsz-cols').textContent, new RegExp(`^${cols9} characters per line`));
    const text = () => [...box.querySelectorAll('.rg-l')].map((e) => e.textContent).join('\n');
    const t9 = text();
    assert.match(t9, /TEST RECEIPT/); assert.match(t9, /GOLDEN SHOP/); assert.match(t9, /Bread 400g/); assert.match(t9, /Extra Long Product Name/); assert.match(t9, /TOTAL +KES 891\.50/); assert.match(t9, /Payment Method: CASH/); assert.match(t9, /CHANGE +KES 108\.50/); assert.match(t9, /Ref: SAMPLE-0001/);
    assert.ok(box.querySelector('.receipt-grid-barcode svg'), 'the reference barcode is drawn');
    assert.match(box.querySelector('.receipt-grid').style.getPropertyValue('--rg-font'), /^12\.000px$/);
    // − and +
    w.eval('receiptSizeStep(0.5)');
    assert.equal($(d, 'rsz-pt').value, '9.5'); assert.equal(box.dataset.pt, '9.5');
    assert.ok(Number(box.dataset.cols) < cols9, 'bigger letters: fewer characters per line');
    assert.notEqual(text(), t9, 'the sample changed');
    w.eval('receiptSizeStep(-0.5); receiptSizeStep(-0.5)');
    assert.equal(box.dataset.pt, '8.5'); assert.ok(Number(box.dataset.cols) > cols9);
    // typing (clamped to 5-20, steps of 0.5) and the chips
    w.eval("receiptSizeSetPt('25', true)"); assert.equal(box.dataset.pt, '20');
    w.eval("receiptSizeSetPt('4', true)"); assert.equal(box.dataset.pt, '5');
    w.eval("receiptSizeSetPt('7.3', true)"); assert.equal(box.dataset.pt, '7.5');
    $(d, 'rsz-pt').value = '11'; $(d, 'rsz-pt').dispatchEvent(new w.Event('input')); assert.equal(box.dataset.pt, '11');
    d.querySelector('[data-rsz-pt="10"]').click(); assert.equal(box.dataset.pt, '10'); assert.ok(d.querySelector('[data-rsz-pt="10"]').classList.contains('active'));
    d.querySelector('[data-rsz-pt="7"]').click(); assert.equal(box.dataset.cols, '48');
    // the saved size did not move
    assert.equal(w.eval('receiptFontPtNow()'), 9); assert.equal(w.localStorage.getItem('pos_receipt_font_pt'), '9');
    assert.equal(w.eval('window.__receiptTrial'), null, 'no trial value is left in force');
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: Cancel and Reset never save; Save stores paper + size, closes and says so`, async () => {
    const { w, d, close } = await boot(app, { storage: STORE, wait: 700 });
    quiet(w);
    w.eval("receiptWidth='80'; receiptCustomWidth=''; setDevicePaperWidth('', true)");
    // Cancel
    w.eval('receiptSizeOpen()'); w.eval("receiptSizeSetPaper('58'); receiptSizeSetPt(12, true)");
    d.querySelector('#receipt-size-modal .rsz-b-cancel').click();
    assert.equal($(d, 'receipt-size-modal').style.display, 'none');
    assert.equal(w.eval('receiptFontPtNow()'), 7); assert.equal(w.eval("receiptWidth"), '80'); assert.equal(w.localStorage.getItem('pos_receipt_font_pt'), null);
    assert.equal(w.eval('getPaperCols()'), 48);
    // Reset to standard (only in the window)
    w.eval('receiptSizeOpen(); receiptSizeSetPt(12, true)'); d.querySelector('.rsz-b-reset').click();
    assert.equal($(d, 'rsz-pt').value, '7'); w.eval('receiptSizeCancel()');
    // Save 58 mm at 10 pt
    w.eval("receiptSizeOpen(); receiptSizeSetPaper('58'); receiptSizeSetPt(10, true)");
    d.getElementById('rsz-save-btn').click();
    assert.equal($(d, 'receipt-size-modal').style.display, 'none');
    assert.equal(w.eval('receiptFontPtNow()'), 10);
    assert.equal(w.localStorage.getItem('pos_receipt_font_pt'), '10');
    assert.equal(w.eval('receiptWidth'), '58'); assert.equal(w.localStorage.getItem(app === 'water/index.html' ? 'aqua_receipt_width' : 'pos_receipt_width'), '58');
    assert.equal(w.eval('getPaperCols()'), Math.floor((48 * 96 / 25.4) / (0.6 * (10 * 96 / 72) * 1.005)));
    assert.ok(w.__toasts.some((t) => /Receipts will now print at 10 pt on 58 mm paper/.test(t)), 'toast: ' + w.__toasts.join(' | '));
    // real receipts now use it, and Settings shows the summary
    w.eval('renderReceipt(' + JSON.stringify(SALE) + ')');
    assert.equal(d.querySelector('#receipt-body .receipt-grid').dataset.pt, '10');
    assert.match([...d.querySelectorAll('.receipt-size-now')].map((e) => e.textContent).join(' '), /58 mm paper · 10 pt letters/);
    // Save with a custom width
    w.eval("receiptSizeOpen(); receiptSizeSetPaper('custom'); receiptSizeSetCustom('100'); receiptSizeSetPt(9, true)");
    assert.equal($(d, 'rsz-paper').style.width, '100mm');
    d.getElementById('rsz-save-btn').click();
    assert.equal(w.eval('receiptWidth'), 'custom'); assert.equal(w.eval('receiptCustomWidth'), '100'); assert.equal(w.eval('receiptPaperMm()'), 100);
    close();
  });

  test(`${app}: a custom width must be 30-300 mm; nothing overflows the paper at any size from 5 to 20 pt`, async () => {
    const { w, d, close } = await boot(app, { storage: STORE, wait: 700 });
    quiet(w);
    w.eval("setDevicePaperWidth('', true); receiptSizeOpen(); receiptSizeSetPaper('custom')");
    for (const bad of ['', '12', '29', '301', 'abc']) {
      w.eval(`receiptSizeSetCustom(${JSON.stringify(bad)})`);
      assert.equal($(d, 'rsz-save-btn').disabled, true, `Save is off for "${bad}"`); assert.equal($(d, 'rsz-print-btn').disabled, true);
    }
    const sweep = app === 'index.html' ? [5, 5.5, 6, 6.5, 7, 7.5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] : [5, 7, 10, 14, 20];
    for (const mm of ['58', '80', '40', '100', '120', '30', '300']) {
      if (mm === '58' || mm === '80') w.eval(`receiptSizeSetPaper('${mm}')`); else w.eval(`receiptSizeSetPaper('custom'); receiptSizeSetCustom('${mm}')`);
      for (const pt of sweep) {
        w.eval(`receiptSizeSetPt(${pt}, true)`);
        const box = $(d, 'rsz-paper'), cols = Number(box.dataset.cols);
        const printablePx = w.eval(`receiptPrintableMm(${mm}) * 96 / 25.4`), fontPx = pt * 96 / 72;
        assert.ok(cols * 0.6 * fontPx <= printablePx + 0.01, `${mm} mm @ ${pt} pt: ${cols} columns of ${(0.6 * fontPx).toFixed(2)}px do not fit ${printablePx.toFixed(1)}px`);
        const lines = [...box.querySelectorAll('.rg-l')].map((e) => e.textContent);
        assert.ok(lines.length > 15);
        for (const l of lines) assert.ok(l.length <= cols, `${mm} mm @ ${pt} pt: a line is wider than ${cols}: "${l}"`);
        assert.ok(cols >= 1);
      }
    }
    // the size of 7 pt gives exactly 32 / 48 on the two standard rolls
    w.eval("receiptSizeSetPaper('58'); receiptSizeSetPt(7, true)"); assert.equal($(d, 'rsz-paper').dataset.cols, '32');
    w.eval("receiptSizeSetPaper('80')"); assert.equal($(d, 'rsz-paper').dataset.cols, '48');
    close();
  });

  test(`${app}: "Print test receipt" prints the sample at the UNSAVED paper and size through the system dialog, and leaves everything as it was`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: STORE, wait: 700 });
    quiet(w);
    w.eval("receiptWidth='80'; receiptCustomWidth=''; setDevicePaperWidth('', true); printerMode='system'; receiptCopies = 3;");
    w.eval('renderReceipt(' + JSON.stringify({ ...SALE, id: 'keep1' }) + ')');
    const before = { html: $(d, 'receipt-body').innerHTML, header: w.eval('lastReceiptHeader'), sale: w.eval('currentReceiptSale.id'), display: $(d, 'receipt-modal').style.display };
    let seen = null, prints = 0;
    w.print = () => {
      prints++;
      seen = { mm: w.eval('receiptPaperMm()'), pt: w.eval('receiptFontPtNow()'), cols: w.eval('getPaperCols()'), page: $(d, 'print-page-style').textContent, font: d.querySelector('#receipt-body .receipt-grid').style.getPropertyValue('--rg-font'),
        text: $(d, 'receipt-body').textContent, paper: d.body.style.getPropertyValue('--rg-paper'), copies: d.querySelectorAll('.receipt-copy-extra').length };
      w.dispatchEvent(new w.Event('afterprint'));
    };
    w.eval("receiptSizeOpen(); receiptSizeSetPaper('58'); receiptSizeSetPt(11, true)");
    await w.eval('receiptSizeTestPrint()');
    assert.equal(prints, 1, 'one print');
    assert.equal(seen.mm, 58); assert.equal(seen.pt, 11); assert.equal(seen.font, '14.667px'); assert.equal(seen.paper, '58mm');
    assert.match(seen.page, /size: 58mm \d+mm;/); assert.match(seen.text, /TEST RECEIPT/); assert.match(seen.text, /Bread 400g/);
    assert.equal(seen.copies, 0, 'a test is one copy even when the shop prints several');
    assert.equal(seen.cols, Math.floor((48 * 96 / 25.4) / (0.6 * (11 * 96 / 72) * 1.005)));
    // afterwards: saved settings, the receipt that was on screen, and the vars are the real ones again
    assert.equal(w.eval('receiptFontPtNow()'), 7); assert.equal(w.eval('receiptPaperMm()'), 80); assert.equal(w.localStorage.getItem('pos_receipt_font_pt'), null); assert.equal(w.eval('receiptWidth'), '80');
    assert.equal(w.eval('window.__receiptTrial'), null); assert.equal(w.eval('!!window.__receiptTestPrint'), false);
    assert.equal($(d, 'receipt-body').innerHTML, before.html); assert.equal(w.eval('lastReceiptHeader'), before.header); assert.equal(w.eval('currentReceiptSale.id'), before.sale); assert.equal($(d, 'receipt-modal').style.display, before.display);
    assert.equal(d.body.style.getPropertyValue('--rg-paper'), '80mm');
    assert.equal(w.eval('getPaperCols()'), 48);
    assert.equal($(d, 'receipt-size-modal').style.display, 'block', 'the window stays open');
    assert.ok(w.__toasts.some((t) => /Test receipt sent: 11 pt on 58 mm paper/.test(t)));
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: the test print goes to a connected Bluetooth printer as a picture at the trial size (dots = paper's printable width), and leaves the saved settings alone`, async () => {
    const log = [];
    const { w, close } = await boot(app, { storage: STORE, wait: 700, getContext: fakeCanvas(log) });
    quiet(w);
    const sent = [];
    w.nativeBytePrinter = () => true; w.nativeSendBytes = async (b) => { sent.push(new Uint8Array(b)); };
    w.eval("receiptWidth='80'; receiptCustomWidth=''; setDevicePaperWidth('', true); printerMode='bluetooth';");
    w.eval("receiptSizeOpen(); receiptSizeSetPaper('58'); receiptSizeSetPt(10, true)");
    await w.eval('receiptSizeTestPrint()');
    assert.equal(sent.length, 1, 'one job to the printer');
    const bytes = sent[0], rs = rasters(bytes);
    assert.ok(rs.length >= 3, 'the receipt is pictures');
    for (const r of rs) { assert.ok(r.rows >= 1 && r.rows <= 200, 'bands of at most 200 rows'); }
    const textBands = rs.filter((r) => r.bpr === 48);
    assert.ok(textBands.length >= 3, '58 mm paper = 384 dots = 48 bytes a row');
    assert.equal(rs.filter((r) => r.bpr !== 48 && r.bpr !== 72).length, 0);
    assert.deepEqual(Array.from(bytes.slice(0, 5)), [0x1B, 0x40, 0x1B, 0x4D, 0x00]);
    assert.deepEqual(Array.from(bytes.slice(-4)), [0x1D, 0x56, 0x42, 0x00], 'ends with the cut');
    const last = rs[rs.length - 1]; assert.ok(last.at + 8 + last.dataLen <= bytes.length);
    assert.ok(log.some((c) => /TEST RECEIPT/.test(c.t)), 'the sample text was drawn');
    assert.equal(w.eval('receiptFontPtNow()'), 7); assert.equal(w.localStorage.getItem('pos_receipt_font_pt'), null); assert.equal(w.eval('receiptWidth'), '80');
    close();
  });
}

test('the chosen size becomes the receipt: text width, centred bold header, bold TOTAL, aligned columns, all as pictures at the dot width (58 and 80 mm)', async () => {
  const log = [];
  const { w, d, close } = await boot('index.html', { storage: STORE, wait: 800, getContext: fakeCanvas(log) });
  quiet(w);
  for (const [mm, dots] of [['58', 384], ['80', 576]]) {
    w.eval(`receiptWidth='${mm}'; receiptCustomWidth=''; receiptFontPtSave(10);`);
    log.length = 0;
    w.eval('renderReceipt(' + JSON.stringify(SALE) + ')');
    assert.equal(w.eval('receiptPrintDots()'), dots);
    const bytes = w.eval('buildReceiptEscPosBytes(lastReceiptHeader,lastReceiptItemSection,lastReceiptFooter)');
    const sect = w.eval('buildSectionedReceiptBytes(lastReceiptHeader,lastReceiptItemSection,lastReceiptFooter)');
    assert.equal(hash(Buffer.from(bytes)), hash(Buffer.from(sect)), 'both builders make the same picture');
    const rs = rasters(bytes);
    const textBands = rs.filter((r) => r.bpr === dots / 8);
    assert.ok(textBands.length >= 3);
    const rows = textBands.reduce((n, r) => n + r.rows, 0);
    assert.ok(bytes.length > rows * dots / 8 && bytes.length < rows * dots / 8 + 4000 + 8 * rs.length + 4000, 'total length is sane');
    assert.ok(bytes.length < 150000);
    // what was drawn
    const fontPx = 10 * 203 / 72, cw = 0.6 * fontPx;
    const drew = (re) => log.filter((c) => re.test(c.t));
    const name = drew(/GOLDEN SHOP/)[0];
    assert.ok(name && /^bold /.test(name.font), 'the business name is bold');
    assert.ok(Math.abs(name.x - Math.floor((dots - name.t.length * cw) / 2)) <= 1, 'the header is centred on the dot width');
    const total = drew(/^TOTAL\s/)[0]; assert.ok(total && /^bold /.test(total.font), 'TOTAL is bold'); assert.equal(total.x, 0, 'the items are left aligned');
    const bread = drew(/Padlock/)[0]; assert.ok(bread && !/^bold /.test(bread.font));
    assert.ok(drew(/^\s*Thank you|^business!$/)[0].x > 0, 'the footer is centred');
    // no line is wider than the dots
    for (const c of log) assert.ok(c.x + c.t.length * cw <= dots + 1, `"${c.t}" fits ${dots} dots`);
    // the Ref barcode (raster) is there and the cut is last
    assert.ok(rs.some((r) => r.rows === 56), 'the reference barcode picture');
    assert.deepEqual(Array.from(bytes.slice(-4)), [0x1D, 0x56, 0x42, 0x00]);
  }
  // plain documents (kitchen ticket / reports): text at 7 pt, a picture otherwise
  w.eval('receiptFontPtSave(7)');
  assert.equal(rasters(w.eval("buildEscPosBytes('KITCHEN TICKET\\nTable 4\\n2 x Chicken')")).length, 0, '7 pt: the ordinary text bytes');
  w.eval('receiptFontPtSave(12)');
  const plain = w.eval("buildEscPosBytes('KITCHEN TICKET\\nTable 4\\n2 x Chicken')");
  assert.ok(rasters(plain).length >= 1, '12 pt: a picture'); assert.equal(decodeEscPos(plain).text.trim(), '');
  assert.ok(log.some((c) => /KITCHEN TICKET/.test(c.t)));
  close();
});

test('a raster print with no canvas falls back to the ordinary text bytes and says so (never a blank or cut-off receipt)', async () => {
  const { w, close } = await boot('index.html', { storage: STORE, wait: 700 });      // jsdom has no canvas: getContext() is null
  quiet(w);
  w.eval("receiptWidth='58'; receiptFontPtSave(10); renderReceipt(" + JSON.stringify(SALE) + ')');
  const bytes = w.eval('buildReceiptEscPosBytes(lastReceiptHeader,lastReceiptItemSection,lastReceiptFooter)');
  const dec = decodeEscPos(bytes);
  assert.match(dec.text, /GOLDEN SHOP/); assert.match(dec.text, /TOTAL/); assert.ok(rasters(bytes).length <= 1, 'text (plus the barcode picture)');
  assert.ok(w.__toasts.some((t) => /cannot draw the chosen letter size/.test(t)), 'the person is told: ' + w.__toasts.join('|'));
  close();
});

test('a long receipt at a big size is sent to the print relay as several jobs in order, none over the limit, nothing lost', async () => {
  const log = [];
  const posted = [];
  const fetchMock = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (String(url).includes('/api/print-relay')) {
      if (body.action === 'checkAvailable') return new Response(JSON.stringify({ available: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (body.action === 'submit') { posted.push(body); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    }
    throw new Error('offline');
  };
  const { w, close } = await boot('index.html', { storage: STORE, wait: 800, getContext: fakeCanvas(log), fetch: fetchMock });
  quiet(w);
  w.eval("receiptWidth='80'; receiptFontPtSave(14); printerMode='system';");
  const items = Array.from({ length: 45 }, (_, i) => ({ code: 'P' + i, name: 'Assorted hardware item number ' + i + ' extra long name', qty: 1 + (i % 4), price: 100 + i * 7.5, unit: 'pcs', vatCategory: 'A' }));
  w.eval('renderReceipt(' + JSON.stringify({ ...SALE, id: 'long1', items, amountTendered: 99999, change: 1 }) + ')');
  const direct = w.eval('buildSectionedReceiptBytes(lastReceiptHeader,lastReceiptItemSection,lastReceiptFooter)');
  const jobs = w.eval('receiptRelayByteJobs(lastReceiptHeader,lastReceiptItemSection,lastReceiptFooter)');
  assert.ok(direct.length > 140000, 'this receipt is bigger than one relay job (' + direct.length + ' bytes)');
  assert.ok(jobs.length >= 2); jobs.forEach((j) => assert.ok(j.length <= 140000));
  const joined = Buffer.concat(jobs.map((j) => Buffer.from(j)));
  assert.equal(hash(joined), hash(Buffer.from(direct)), 'the jobs are the whole receipt, in order');
  assert.deepEqual(Array.from(jobs[jobs.length - 1].slice(-4)), [0x1D, 0x56, 0x42, 0x00], 'only the last job cuts');
  jobs.slice(0, -1).forEach((j) => assert.notDeepEqual(Array.from(j.slice(-4)), [0x1D, 0x56, 0x42, 0x00]));
  // and through the real path
  w.eval('window.__relayAvail = { at: Date.now(), value: true, pending: null }');
  posted.length = 0;
  await w.eval('printViaSystemDialog()');
  assert.equal(posted.length, jobs.length, 'every job was submitted');
  const back = Buffer.concat(posted.map((p) => { assert.ok(p.bytesB64 && p.bytesB64.length <= 200000, 'each job carries its bytes'); return Buffer.from(p.bytesB64, 'base64'); }));
  assert.equal(hash(back), hash(Buffer.from(direct)));
  assert.equal(rasters(back).reduce((n, r) => n + r.rows, 0), rasters(direct).reduce((n, r) => n + r.rows, 0), 'no row was dropped');
  close();
});

test('at 7 pt the relay still gets ONE job of text bytes', async () => {
  const posted = [];
  const fetchMock = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (String(url).includes('/api/print-relay')) {
      if (body.action === 'checkAvailable') return new Response(JSON.stringify({ available: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (body.action === 'submit') { posted.push(body); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    }
    throw new Error('offline');
  };
  const { w, close } = await boot('index.html', { storage: STORE, wait: 700, fetch: fetchMock });
  quiet(w);
  w.eval("printerMode='system'; renderReceipt(" + JSON.stringify(SALE) + ')');
  w.eval('window.__relayAvail = { at: Date.now(), value: true, pending: null }');
  await w.eval('printViaSystemDialog()');
  assert.equal(posted.length, 1);
  assert.equal(hash(Buffer.from(posted[0].bytesB64, 'base64')), GOLDEN['index.html@80'].sectioned);
  close();
});

test('Adjust receipt size edits THIS device\'s printer paper when it has its own, the shop paper otherwise', async () => {
  const { w, d, close } = await boot('index.html', { storage: STORE, wait: 700 });
  quiet(w);
  w.eval("receiptWidth='80'; receiptCustomWidth=''; setDevicePaperWidth('58', true)");
  w.eval('receiptSizeOpen()');
  assert.equal(d.querySelector('[data-rsz-paper="58"]').classList.contains('active'), true, 'starts at the paper in force (this device: 58)');
  assert.match($(d, 'rsz-paper-note').textContent, /THIS device/);
  w.eval("receiptSizeSetPaper('custom'); receiptSizeSetCustom('90'); receiptSizeSetPt(8, true)");
  d.getElementById('rsz-save-btn').click();
  assert.equal(w.localStorage.getItem('pos_device_paper_mm'), '90', 'the device override was edited');
  assert.equal(w.eval('receiptWidth'), '80', 'the shop paper was not touched');
  assert.equal(w.eval('receiptPaperMm()'), 90);
  assert.match([...d.querySelectorAll('.receipt-size-now')].map((e) => e.textContent).join(' '), /90 mm paper · 8 pt letters .*this device's printer/);
  // without an override the shop paper is edited
  w.eval("setDevicePaperWidth('', true); receiptSizeOpen()");
  assert.match($(d, 'rsz-paper-note').textContent, /whole shop/);
  w.eval("receiptSizeSetPaper('58')"); d.getElementById('rsz-save-btn').click();
  assert.equal(w.eval('receiptWidth'), '58'); assert.equal(w.localStorage.getItem('pos_device_paper_mm'), null);
  close();
});

test('an open receipt is laid out again when the size is saved, and the shop\'s other settings still work (logo, stamp, item alignment) in the sample', async () => {
  const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const { w, d, close } = await boot('index.html', { storage: { ...STORE, pos_receipt_logo: LOGO, pos_receipt_show_logo: 'true', pos_receipt_stamp_src: LOGO, pos_receipt_show_stamp: 'true', pos_receipt_item_align: 'right' }, wait: 800 });
  quiet(w);
  w.eval('renderReceipt(' + JSON.stringify(SALE) + ')');
  assert.equal(d.querySelector('#receipt-body .receipt-grid').dataset.pt, '7');
  w.eval('receiptSizeOpen()');
  const box = $(d, 'rsz-paper');
  assert.ok(box.querySelector('.rsz-brand img'), 'the logo is in the sample'); assert.ok(box.querySelector('.rg-stamp img'), 'the stamp is in the sample');
  const total = [...box.querySelectorAll('.rg-l')].find((e) => /TOTAL/.test(e.textContent)).textContent;
  assert.equal(total.length, total.trimStart().length + (total.length - total.trimStart().length)); assert.ok(/^ +TOTAL/.test(total) || total.length <= 48, 'items follow the alignment setting');
  w.eval("receiptSizeSetPt(12, true)"); d.getElementById('rsz-save-btn').click();
  assert.equal(d.querySelector('#receipt-body .receipt-grid').dataset.pt, '12', 'the receipt that was open is drawn again at the new size');
  close();
});

for (const app of APPS) {
  test(`${app}: Save syncs the size to the shop's other devices; a fresh device's default never replaces it; Cancel sends nothing`, async () => {
    const s = makeServer();
    const a = await openDevice(app, s, { pos_biz_name: 'Mama Njeri', aqua_biz_name: 'Mama Njeri' });
    quiet(a.w);
    a.w.eval("receiptSizeOpen(); receiptSizeSetPaper('58'); receiptSizeSetPt(9.5, true)");
    a.w.eval('receiptSizeCancel()');
    a.w.eval('queuePush()'); await settled(a);
    assert.equal(s.serverState().receiptFontPt, undefined, 'a cancelled change sends nothing (and a device with no size of its own sends none)');
    a.w.eval("receiptSizeOpen(); receiptSizeSetPaper('58'); receiptSizeSetPt(9.5, true); receiptSizeSave()");
    await settled(a);
    assert.equal(s.serverState().receiptFontPt, 9.5, 'the server has the size');
    if (app !== 'water/index.html') assert.equal(s.serverState().receiptWidth, '58', 'and the paper');
    // a second device picks both up
    const b = await openDevice(app, s, {}, 2500);
    quiet(b.w);
    try { await b.w.eval("(typeof pullFromServer === 'function' ? pullFromServer : pullState)()"); } catch (e) { /* the periodic pull does it */ }
    assert.equal(b.w.eval('receiptFontPtNow()'), 9.5, 'device 2 pulled the size');
    assert.equal(b.w.localStorage.getItem('pos_receipt_font_pt'), '9.5');
    if (app !== 'water/index.html') assert.equal(b.w.eval('receiptPaperMm()'), 58);
    b.w.eval('renderReceipt(' + JSON.stringify(SALE) + ')');
    assert.equal(b.w.document.querySelector('#receipt-body .receipt-grid').dataset.pt, '9.5');
    // a brand-new device that pushes before it ever pulled must not put its default 7 over the shop's size
    s.state.down = true;
    const c = await openDevice(app, s, {}, 900);
    quiet(c.w); s.state.down = false;
    c.w.eval('queuePush()'); await settled(c); await sleep(200);
    assert.equal(s.serverState().receiptFontPt, 9.5, 'the shop keeps its size');
    // and a later change on device 2 reaches device 1
    b.w.eval("receiptSizeOpen(); receiptSizeSetPt(11, true); receiptSizeSave()"); await settled(b);
    assert.equal(s.serverState().receiptFontPt, 11);
    a.close(); b.close(); c.close();
  });
}

test('the shared receipt settings of a branch group carry the size like the paper width', async () => {
  const { w, close } = await boot('index.html', { wait: 700 });
  quiet(w);
  w.eval('receiptFontPtSave(10)');
  const snap = w.eval('collectReceiptSettingsSnapshot()');
  assert.equal(snap.stamp.receiptFontPt, 10); assert.equal(snap.width, '80');
  assert.equal(Object.keys(snap).filter((k) => /scale/i.test(k)).length, 0);
  const { w: w2, close: close2 } = await boot('index.html', { wait: 700 });
  quiet(w2);
  w2.eval(`applyReceiptSettingsSnapshot(${JSON.stringify(snap)})`);
  assert.equal(w2.eval('receiptFontPtNow()'), 10);
  w2.eval(`applyReceiptSettingsSnapshot(${JSON.stringify({ ...snap, stamp: { ...snap.stamp, receiptFontPt: undefined } })})`);
  assert.equal(w2.eval('receiptFontPtNow()'), 10, 'a snapshot from an older app has no size and leaves it alone');
  close(); close2();
});

test('server: receiptFontPt is a stamped whole-value setting; an old app\'s receiptScale is accepted and simply dropped', () => {
  assert.ok(SETTINGS_NEED_STAMP_FIELDS.includes('receiptFontPt'));
  assert.ok(!SETTINGS_NEED_STAMP_FIELDS.includes('receiptScale'));
  // a real change (stamped) replaces; a stale / default copy (unstamped) does not replace a stamped value
  const stored = { receiptFontPt: 10, _fieldTimes: { receiptFontPt: 1000 } };
  assert.equal(mergeIncomingState(stored, { receiptFontPt: 7 }).receiptFontPt, 10, 'unstamped default ignored');
  assert.equal(mergeIncomingState(stored, { receiptFontPt: 12, _fieldTimes: { receiptFontPt: 2000 } }).receiptFontPt, 12, 'stamped change wins');
  assert.equal(mergeIncomingState(stored, { receiptFontPt: 8, _fieldTimes: { receiptFontPt: 500 } }).receiptFontPt, 10, 'an older stamp loses');
  // an old client
  const m = mergeIncomingState({ receiptScale: 110, receiptWidth: '80', _fieldTimes: { receiptScale: 5 } }, { receiptScale: 120, receiptWidth: '58', _fieldTimes: { receiptScale: 9, receiptWidth: 9 } });
  assert.equal('receiptScale' in m, false, 'not kept'); assert.equal(m.receiptWidth, '58', 'everything else merges normally'); assert.equal(m._fieldTimes.receiptScale, undefined);
  const fresh = mergeIncomingState({ receiptScale: 110 }, { pwHash: 'x' });
  assert.equal('receiptScale' in fresh, false, 'a value stored earlier is dropped');
});

test('the user guides describe Adjust receipt size', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'src/shared/blocks/guide-data'))) {
    const t = fs.readFileSync(path.join(ROOT, 'src/shared/blocks/guide-data', f), 'utf8');
    assert.doesNotMatch(t, /Print Scale/i, f);
    if (/owner/.test(f)) continue;
    assert.match(t, /Adjust receipt size/, f);
  }
});
