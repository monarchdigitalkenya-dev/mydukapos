// Shared test helpers: boots a real app (index.html) in jsdom with just enough browser stubs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APPS = [
  'index.html', 'water/index.html', 'hotel/index.html', 'hospital/index.html',
  'school/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html',
];

// A sale that exercises accents-free ASCII edge cases, a long name, a quote, an en dash and two VAT classes.
export const SAMPLE_SALE = {
  id: 's1', timestamp: Date.now(), paymentMethod: 'cash', amountTendered: 5000, change: 1576.5,
  refNumber: 'R-00012', servedBy: 'Jane', orderType: 'walkin',
  items: [
    { code: '00012', name: 'Padlock Brass 50mm Heavy Duty Long Name Item', qty: 2, price: 450, unit: 'pcs', vatCategory: 'A' },
    { code: '00420', name: 'Nails 3" (1kg)', qty: 1, price: 183.5, unit: 'pcs', vatCategory: 'A' },
    { code: '00777', name: 'Cement 50kg \u2013 Bamburi', qty: 3, price: 780, unit: 'pcs', vatCategory: 'B' },
  ],
};

export async function boot(app, opts = {}) {
  const html = fs.readFileSync(path.join(ROOT, app), 'utf8');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.message).slice(0, 160)));
  const dom = new JSDOM(html, {
    url: 'https://demo.mydukapos.store/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      Object.entries(opts.storage || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.fetch = opts.fetch || (() => Promise.reject(new Error('offline')));
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      w.HTMLCanvasElement.prototype.getContext = opts.getContext || (() => null);
      if (opts.toDataURL) w.HTMLCanvasElement.prototype.toDataURL = opts.toDataURL;
      if (opts.Image) w.Image = opts.Image;
      w.scrollTo = () => {};
      if (!w.TextEncoder) w.TextEncoder = TextEncoder;   // real browsers have these; jsdom does not
      if (!w.TextDecoder) w.TextDecoder = TextDecoder;
      if (!w.CSS) w.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.ResizeObserver = w.IntersectionObserver;
      w.navigator.serviceWorker = { register: () => Promise.resolve({}), addEventListener() {}, ready: Promise.resolve({}) };
      if (opts.indexedDB) w.indexedDB = opts.indexedDB;   // jsdom has none; tests pass a fake-indexeddb factory
      if (opts.usb) Object.defineProperty(w.navigator, 'usb', { value: typeof opts.usb === 'function' ? opts.usb(w) : opts.usb, configurable: true });
    },
  });
  // Wait for the page to finish loading, then a short settle for the app's own async start-up (failed fetches, timers).
  // Was a flat 1200 ms per boot — about half of every test's time. A test that needs longer passes `wait` explicitly.
  if (opts.wait != null) await new Promise((r) => setTimeout(r, opts.wait));
  else {
    const t0 = Date.now();
    while (dom.window.document.readyState !== 'complete' && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 450));
  }
  return { w: dom.window, d: dom.window.document, errors, close: () => dom.window.close() };
}

// Decode ESC/POS bytes into { text, nonAscii, commands } so tests can assert on what a printer would print.
export function decodeEscPos(bytes) {
  const arr = Array.from(bytes);
  let text = '', nonAscii = 0, rasters = 0;
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
    if (b === 0x1B) { const c = arr[i + 1]; i += (c === 0x4D || c === 0x45 || c === 0x61 || c === 0x2D) ? 2 : (c === 0x64 ? 2 : 1); continue; }
    if (b === 0x1D && arr[i + 1] === 0x76 && arr[i + 2] === 0x30) {   // GS v 0: raster image (the Ref barcode) — skip its pixel data
      const bytes = (arr[i + 4] + arr[i + 5] * 256) * (arr[i + 6] + arr[i + 7] * 256);
      i += 7 + bytes; rasters++; continue;
    }
    if (b === 0x1D) { i += (arr[i + 1] === 0x56 && arr[i + 2] === 0x42) ? 3 : 2; continue; }   // GS V B n (4 bytes) vs GS V n (3 bytes)
    if (b >= 0x80) nonAscii++;
    text += String.fromCharCode(b);
  }
  const has = (seq) => { for (let i = 0; i <= arr.length - seq.length; i++) { if (seq.every((v, j) => arr[i + j] === v)) return true; } return false; };
  return { text, nonAscii, rasters, centred: has([0x1B, 0x61, 1]), bold: has([0x1B, 0x45, 1]), fontA: arr.slice(0, 5).join() === '27,64,27,77,0' };
}
