import test from 'node:test';
import assert from 'node:assert/strict';
import { APPS, boot, SAMPLE_SALE } from './helpers.mjs';

const REF = 'ref-00000042';
const rawBytes = (w) => Array.from(w.eval("(typeof buildReceiptEscPosBytes === 'function') ? buildReceiptEscPosBytes(lastReceiptHeader, lastReceiptItemSection, lastReceiptFooter) : buildEscPosBytes(lastReceiptText)"));
const indexOf = (bytes, seq, from = 0) => { for (let i = from; i <= bytes.length - seq.length; i++) if (seq.every((v, k) => bytes[i + k] === v)) return i; return -1; };
const text = (bytes) => Buffer.from(bytes).toString('latin1');

for (const app of APPS) {
  for (const [width, bytesPerRow] of [['58', 48], ['80', 72]]) {
    test(`${app} @${width}mm: USB/Bluetooth receipt prints the Ref number and its barcode, then feeds to the cutter`, async () => {
      const { w, errors, close } = await boot(app, { storage: { pos_receipt_show_barcode: 'true' } });   // zip 253: the barcode is an opt-in Receipt Setting
      w.eval(`receiptWidth = '${width}'; renderReceipt(${JSON.stringify({ ...SAMPLE_SALE, refNumber: REF })});`);
      const b = rawBytes(w);
      const refAt = indexOf(b, Array.from(Buffer.from(`Ref: ${REF}`)));
      assert.ok(refAt > 0, 'the Ref number line is sent');
      const rasterAt = indexOf(b, [0x1D, 0x76, 0x30, 0x00], refAt);
      assert.ok(rasterAt > refAt, 'a raster image (the barcode) follows the Ref number');
      assert.equal(b[rasterAt + 4] + b[rasterAt + 5] * 256, bytesPerRow, 'image is exactly one paper width wide');
      const rows = b[rasterAt + 6] + b[rasterAt + 7] * 256;
      assert.equal(rows, 56);
      const first = b.slice(rasterAt + 8, rasterAt + 8 + bytesPerRow);
      // count the bars in the first pixel row: a Code 39 "*REF-00000042*" has 5 bars per character
      let bars = 0, prev = 0;
      for (let px = 0; px < bytesPerRow * 8; px++) { const on = (first[px >> 3] >> (7 - (px & 7))) & 1; if (on && !prev) bars++; prev = on; }
      assert.equal(bars, 14 * 5, 'bars for the 14 characters of *REF-00000042*');
      assert.deepEqual(b.slice(rasterAt + 8, rasterAt + 8 + bytesPerRow * rows).length, bytesPerRow * rows, 'whole image present');
      // every row of the image is identical (a barcode is the same column pattern top to bottom)
      const lastRow = b.slice(rasterAt + 8 + (rows - 1) * bytesPerRow, rasterAt + 8 + rows * bytesPerRow);
      assert.deepEqual(lastRow, first);
      // after the image: feed, then "GS V B 0" (feed to cutter + partial cut) as the very last command
      assert.deepEqual(b.slice(-4), [0x1D, 0x56, 0x42, 0x00], 'feed-to-cut so the last line is never sliced off');
      assert.ok(text(b.slice(rasterAt + 8 + rows * bytesPerRow)).startsWith('\x1B\x64\x03'), 'feed comes after the barcode');
      assert.deepEqual(errors, []);
      close();
    });
  }
}

test('no reference number => no barcode; the barcode off (the default, and the Receipt Setting) removes it but keeps the number', async () => {
  const { w, close } = await boot('hotel/index.html', { storage: { pos_receipt_show_barcode: 'true' } });
  w.eval(`renderReceipt(${JSON.stringify({ ...SAMPLE_SALE, refNumber: undefined })});`);
  assert.equal(indexOf(rawBytes(w), [0x1D, 0x76, 0x30, 0x00]), -1, 'nothing to encode');
  w.eval(`rxSettings.showBarcode = false; renderReceipt(${JSON.stringify({ ...SAMPLE_SALE, refNumber: REF })});`);
  const b = rawBytes(w);
  assert.ok(indexOf(b, Array.from(Buffer.from(`Ref: ${REF}`))) > 0, 'number still printed');
  assert.equal(indexOf(b, [0x1D, 0x76, 0x30, 0x00]), -1, 'barcode switched off');
  close();
});

test('a very long reference still fits the paper or is skipped, never overflows', async () => {
  const { w, close } = await boot('water/index.html');
  w.eval("receiptWidth = '58'");
  const r = w.eval("(() => { const u = buildCode39RasterBytes('A'.repeat(40), 384); return u ? [u[4] + u[5] * 256, u.length] : null; })()");
  assert.equal(r, null, '40 characters cannot fit 58mm at a scannable size, so nothing is drawn');
  close();
});
