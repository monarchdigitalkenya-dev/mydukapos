import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, ROOT } from './helpers.mjs';

// zip 336 — the built-in thermal printer of Senraise-type Android handheld terminals (H10 / H10S). The Android side cannot run here (no
// Android SDK / device): its source is checked statically below, and the page side runs against a fake of NativeBridge.java.
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha Soap with a really long product name that must wrap', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];

function bridge(w, o = {}) {
  w.__calls = []; w.__status = 0;
  const status = o.status || { ok: true, installed: true, connected: true, ready: true, serviceVersion: '1.2', device: { manufacturer: 'Senraise', model: 'H10S', android: '13' }, packages: [{ package: 'recieptservice.com.recieptservice', version: '1.2' }] };
  w.MyDukaNative = {
    info: () => JSON.stringify({ platform: 'android', module: 'shop', appName: 'MyDukaPOS', version: '1.0.0', build: 1, builtinPrinter: o.installed !== false }),
    printPage: () => {},
    btList: (cb) => setTimeout(() => w.__myDukaNativeCb(cb, { ok: true, devices: [] }), 5),
    btPrint: () => {},
    builtinStatus: (cb) => { w.__status++; setTimeout(() => w.__myDukaNativeCb(cb, status), 5); },
    builtinPrint: (b64, jobId, cb) => {
      w.__calls.push({ bytes: Buffer.from(b64, 'base64'), jobId });
      const fail = o.failFirst && w.__calls.length === 1;
      setTimeout(() => w.__myDukaNativeCb(cb, fail ? { ok: false, stage: 'send', error: 'The printer service rejected the job: dead object' } : { ok: true, state: 'accepted by the printer service' }), 20);
    },
  };
}
const quiet = (w) => w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; document.getElementById('login-screen').style.display = 'none'");

test('static: AIDL keeps the vendor method order, bridge + manifest + gradle are wired, no other printer path was removed', () => {
  const aidl = read('native/android/app/src/main/aidl/recieptservice/com/recieptservice/PrinterInterface.aidl');
  const names = [...aidl.matchAll(/^\s*(?:void|String)\s+(\w+)\(/gm)].map((m) => m[1]);
  assert.deepEqual(names, ['printEpson', 'getServiceVersion', 'printText', 'printBitmap', 'printBarCode', 'printQRCode', 'setAlignment', 'setTextSize', 'nextLine', 'printTableText', 'setTextBold'], 'order fixes the Binder transaction numbers');
  assert.match(aidl, /package recieptservice\.com\.recieptservice;/);
  const nb = read('native/android/app/src/main/java/com/mydukapos/app/NativeBridge.java');
  for (const m of ['builtinStatus', 'builtinPrint', 'btPrint', 'btList', 'printPage']) assert.match(nb, new RegExp('public void ' + m + '\\('), m);
  assert.match(nb, /builtinPrint\(String base64, String jobId, String cbId\)[\s\S]{0,80}if \(!allowed\(\)\) return;/, 'only MyDukaPOS pages may print');
  assert.match(read('native/android/app/src/main/AndroidManifest.xml'), /<queries>[\s\S]*recieptservice\.com\.recieptservice/);
  assert.match(read('native/android/app/build.gradle'), /aidl true/);
  const bp = read('native/android/app/src/main/java/com/mydukapos/app/BuiltinPrinter.java');
  assert.match(bp, /setClassName\(PKG, CLS\)/); assert.match(bp, /svc\.printEpson\(bytes\)/);
  assert.match(bp, /duplicate/); assert.match(bp, /paperStatus/);
  assert.ok(!/root|su -c|Runtime\.getRuntime/.test(bp), 'no root / shell tricks');
});

test('static: the settings block is in every app and offers the built-in printer', () => {
  for (const f of ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'water/index.html']) {
    const h = read(f);
    assert.match(h, /android-builtin/, f); assert.match(h, /nativeBuiltinUse/, f); assert.match(h, /builtinPrint/, f);
  }
});

test('in the app on the terminal: the printer is found, chosen, tested; width defaults to 58 only when never set; a real sale prints through the thermal path', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Duka Test' }, beforeParse: (w) => bridge(w), wait: 1200 });
  const { w, d } = b; quiet(w);
  assert.equal(w.eval('nativeApp.builtinPrinter'), true);
  w.eval("document.querySelector('.tab-link[data-tab=\"settings-tab\"]').click(); document.querySelector('[data-section=\"settings-section-install\"]').click()");
  await new Promise((r) => setTimeout(r, 100));
  assert.match(d.getElementById('native-printers').textContent, /Use this terminal's built-in printer/);
  await w.eval('nativeBuiltinUse()');
  assert.match(d.getElementById('native-printer-status').textContent, /accepted the test page[\s\S]*cannot tell the app if paper is missing/);
  assert.equal(w.eval('printerMode'), 'bluetooth');
  assert.equal(w.eval('receiptWidth'), '58', 'first use: the maker\'s 58 mm roll');
  assert.match(w.__calls[0].bytes.toString('latin1'), /printer test[\s\S]*Duka Test/);
  assert.deepEqual([...w.__calls[0].bytes.subarray(0, 2)], [0x1b, 0x40], 'ESC @ initialises the printer');
  await new Promise((r) => setTimeout(r, 100));
  assert.match(d.getElementById('native-builtin-health').textContent, /connected[\s\S]*Senraise H10S[\s\S]*not.*report paper-out/i);
  // a real sale + receipt
  w.eval("autoPrintEnabled = false; addToCart('A'); currentPaymentMethod = 'cash'");
  d.getElementById('cash-tendered-input').value = '500';
  const before = w.__calls.length;
  await w.eval('checkoutCart()');
  assert.equal(w.eval('salesLog.length'), 1);
  assert.equal(w.__calls.length, before, 'completing a sale never prints by itself unless auto-print is on');
  await w.eval('printReceipt()');
  assert.equal(w.__calls.length, before + 1);
  assert.match(w.__calls[before].bytes.toString('latin1'), /Alpha Soap/);
  b.close();
});

test('an existing receipt width is never overwritten', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_receipt_width: '80' }, beforeParse: (w) => bridge(w), wait: 1200 });
  const { w } = b; quiet(w);
  await w.eval('nativeBuiltinUse()');
  assert.equal(w.eval('receiptWidth'), '80'); b.close();
});

test('duplicates: the same bytes twice within 2.5 s are ONE job; a failed print can be retried at once; a later reprint prints again', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_native_printer_v1: JSON.stringify({ kind: 'android-builtin', name: 'Built-in printer' }), pos_printer_mode: 'bluetooth' }, beforeParse: (w) => bridge(w, { failFirst: true }), wait: 1200 });
  const { w } = b; quiet(w);
  const bytes = 'new Uint8Array([27,64,65,66,10])';
  // first attempt fails (service rejected) -> says why, sale unaffected
  await assert.rejects(w.eval('nativeSendBytes(' + bytes + ')'), /rejected the job/);
  // the retry is allowed immediately and is really sent
  await w.eval('nativeSendBytes(' + bytes + ')');
  assert.equal(w.__calls.length, 2);
  // a double tap while / right after: one job only
  await Promise.all([w.eval('nativeSendBytes(' + bytes + ')'), w.eval('nativeSendBytes(' + bytes + ')')]);
  assert.equal(w.__calls.length, 2, 'repeat within 2.5 s was not sent again');
  // different content is its own job
  await w.eval('nativeSendBytes(new Uint8Array([27,64,67,10]))');
  assert.equal(w.__calls.length, 3);
  // explicit job id is passed to Android, which remembers it (never prints a retried job twice)
  await w.eval("nativeSendBytes(new Uint8Array([1,2,3]), { jobId: 'sale-42' })");
  assert.match(w.__calls[3].jobId, /^sale-42_/);
  await new Promise((r) => setTimeout(r, 2700));
  await w.eval('nativeSendBytes(' + bytes + ')');
  assert.equal(w.__calls.length, 5, 'a deliberate reprint after the window prints again');
  assert.match(w.eval("nativePrintLog().map(x => x.msg).join('|')"), /not sent again/);
  b.close();
});

test('a terminal WITHOUT the Senraise service: clear message, nothing saved, other printers untouched', async () => {
  const none = { ok: true, installed: false, connected: false, error: 'This terminal does not have the Senraise printer service (recieptservice.com.recieptservice). The built-in printer cannot be used by this app on this device.', device: { manufacturer: 'Other', model: 'X' }, packages: [] };
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS) }, beforeParse: (w) => bridge(w, { status: none }), wait: 1200 });
  const { w, d } = b; quiet(w);
  w.eval("document.querySelector('.tab-link[data-tab=\"settings-tab\"]').click(); document.querySelector('[data-section=\"settings-section-install\"]').click()");
  await new Promise((r) => setTimeout(r, 100));
  await w.eval('nativeBuiltinUse()');
  assert.match(d.getElementById('native-printer-status').textContent, /does not have the Senraise printer service[\s\S]*Bluetooth printer or the Android print dialog/);
  assert.equal(w.eval("localStorage.getItem('pos_native_printer_v1')"), null);
  assert.equal(w.eval('window.nativeBytePrinter()'), null);
  b.close();
});

test('the app on a phone (no built-in printer): no button, Bluetooth choice unchanged', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS) }, beforeParse: (w) => bridge(w, { installed: false }), wait: 1200 });
  const { w, d } = b; quiet(w);
  w.eval("document.querySelector('.tab-link[data-tab=\"settings-tab\"]').click(); document.querySelector('[data-section=\"settings-section-install\"]').click()");
  await new Promise((r) => setTimeout(r, 100));
  const t = d.getElementById('native-printers').textContent;
  assert.ok(!/built-in printer/i.test(t)); assert.match(t, /Choose a Bluetooth printer/);
  b.close();
});
