// zip 379: receipts print DARK on thermal printers; no status indicators on screen (no "Not receiving new orders", no Live pill,
// no "Stock confirmed by the server" bar, no offline pill).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const APPS = ['index.html', 'hotel/index.html', 'water/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'carwash/index.html'];

test('every print starts dark (bold + double-strike) and the raster letters are bold with a black outline', () => {
  for (const a of APPS) {
    const s = fs.readFileSync(a, 'utf8');
    assert.ok(!/0x1B, 0x40, 0x1B, 0x4D, 0x00\]/.test(s), a + ': no plain (light) init left');
    assert.ok(s.includes('if (lum < 190)'), a + ': grey letter edges print black');
    assert.ok(s.includes("ctx.font = `bold ${px}px ${face}`;"), a + ': raster letters are bold');
    assert.ok(s.includes('-webkit-text-stroke:.35px #000'), a + ': the page print of a receipt is black and bold');
  }
});

test('no status indicator text is left in any app', () => {
  for (const a of APPS) {
    const s = fs.readFileSync(a, 'utf8');
    assert.ok(!s.includes('Not receiving new orders'), a);
    assert.ok(!s.includes("'Stock confirmed by the server '"), a + ': no stock bar text');
    if (s.includes('psr-js')) assert.ok(s.includes("function bar() { var old = $('psr-bar');"), a + ': stock bar removed');
    assert.ok(s.includes('zip 379: no pill on screen at all'), a + ': no offline pill');
  }
});
