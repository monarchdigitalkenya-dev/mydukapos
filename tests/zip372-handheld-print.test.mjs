import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 372: on a handheld POS with its own printer, Print prints the receipt on it (never the page).
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];
function bridge(w, o = {}) {
  w.__calls = []; w.__pages = 0;
  w.MyDukaNative = {
    info: () => JSON.stringify({ platform: 'android', module: 'shop', appName: 'MyDukaPOS', version: '1.0.0', build: 1, builtinPrinter: o.installed !== false }),
    printPage: () => { w.__pages++; },
    btList: (cb) => setTimeout(() => w.__myDukaNativeCb(cb, { ok: true, devices: [] }), 5),
    btPrint: () => {},
    builtinStatus: (cb) => setTimeout(() => w.__myDukaNativeCb(cb, { ok: true, installed: true, connected: true, ready: true, serviceVersion: '1.2', device: { manufacturer: 'Senraise', model: 'H10S', android: '13' }, packages: [] }), 5),
    builtinPrint: (b64, jobId, cb) => { w.__calls.push({ bytes: Buffer.from(b64, 'base64'), jobId }); setTimeout(() => w.__myDukaNativeCb(cb, { ok: true, state: 'accepted by the printer service' }), 20); },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = (w) => w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; document.getElementById('login-screen').style.display = 'none'");
async function sale(w) {
  w.eval("addToCart('A'); currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '500'");
  w.eval('autoPrintEnabled = false'); await w.eval('checkoutCart()'); await sleep(200);
}

test('a handheld that never had a printer chosen uses its built-in printer by itself; Print sends the receipt, not the page', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Duka' }, beforeParse: (w) => bridge(w), wait: 2600 });
  const { w } = b;
  try {
    quiet(w);
    for (let i = 0; i < 40 && !w.localStorage.getItem('pos_native_printer_v1'); i++) await sleep(100);
    assert.equal(JSON.parse(w.localStorage.getItem('pos_native_printer_v1')).kind, 'android-builtin');
    assert.equal(w.eval('printerMode'), 'bluetooth');
    assert.equal(w.localStorage.getItem('pos_receipt_width'), '58');
    await sale(w);
    await w.eval('printReceipt()'); await sleep(300);
    assert.equal(w.__calls.length, 1, 'the receipt went to the built-in printer');
    assert.equal(w.__pages, 0, 'the page was NOT sent to the Android print dialog');
  } finally { b.close(); }
});

test('a choice the person made is never overridden (system dialog on purpose, or another printer)', async () => {
  for (const pre of [{ pos_printer_mode: 'system' }, { pos_native_printer_v1: JSON.stringify({ kind: 'android-bt', name: 'Zebra', address: 'AA' }) }]) {
    const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), ...pre }, beforeParse: (w) => bridge(w), wait: 2600 });
    try {
      const saved = b.w.localStorage.getItem('pos_native_printer_v1');
      if (pre.pos_printer_mode) assert.equal(saved, null); else assert.equal(JSON.parse(saved).kind, 'android-bt');
      assert.equal(b.w.eval('printerMode'), pre.pos_printer_mode || 'system');
    } finally { b.close(); }
  }
});

test('a saved built-in printer whose mode fell back to "system" is repaired; a phone without a built-in printer is untouched; the page-print fallback is isolated to the receipt', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_native_printer_v1: JSON.stringify({ kind: 'android-builtin', name: 'Built-in printer' }) }, beforeParse: (w) => bridge(w), wait: 2600 });
  try { assert.equal(b.w.eval('printerMode'), 'bluetooth'); assert.ok(b.w.document.getElementById('native-print-isolate'), 'isolation rules exist for the dialog fallback'); assert.match(b.w.document.getElementById('native-print-isolate').textContent, /printing-receipt > \*:not\(#receipt-modal\)/); } finally { b.close(); }
  const c = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS) }, beforeParse: (w) => bridge(w, { installed: false }), wait: 2600 });
  try { assert.equal(c.w.localStorage.getItem('pos_native_printer_v1'), null); assert.equal(c.w.eval('printerMode'), 'system'); } finally { c.close(); }
  const d = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS) }, wait: 1500 });
  try { assert.equal(d.w.eval('printerMode'), 'system'); assert.equal(d.w.document.getElementById('native-print-isolate'), null, 'a normal browser is untouched'); } finally { d.close(); }
});
