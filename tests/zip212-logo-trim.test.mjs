import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

test('logo raster: blank margins are cut off, an all-white logo prints nothing (no tall empty strip above the shop name)', async () => {
  const b = await boot('index.html', { wait: 800 });
  const f = b.w.receiptLogoRasterFromRgba;
  const mk = (w, h, black) => { const a = new Uint8ClampedArray(w * h * 4).fill(255); black.forEach(([x, y]) => { const i = (y * w + x) * 4; a[i] = a[i + 1] = a[i + 2] = 0; }); return a; };
  assert.equal(f(mk(64, 64, []), 64, 64, 384), null, 'all white -> nothing to print');
  const allBlack = []; for (let y = 20; y < 30; y++) for (let x = 10; x < 50; x++) allBlack.push([x, y]);
  const out = f(mk(64, 64, allBlack), 64, 64, 384);
  // GS v 0 header: rows (yL yH) at bytes 6,7 -> only the 10 black rows are sent, not 64
  assert.deepEqual([out[0], out[1], out[2]], [0x1d, 0x76, 0x30]);
  assert.equal(out[6] + out[7] * 256, 10);
  b.close();
});
