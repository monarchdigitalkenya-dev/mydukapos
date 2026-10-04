import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { boot, ROOT, decodeEscPos } from './helpers.mjs';

const require = createRequire(import.meta.url);
const raw = require('../native/windows/printraw.js');

// ---------- main-process module (no Windows needed: PowerShell is faked) ----------
test('printraw: the script uses the RAW datatype and the winspool API, never the print dialog', () => {
  const ps = raw.psScript(0);
  assert.match(ps, /RAW/); assert.match(ps, /OpenPrinter/); assert.match(ps, /StartDocPrinter/); assert.match(ps, /WritePrinter/);
  assert.match(ps, /MYDUKA_PRN/, 'the printer name is passed through the environment, never pasted into the script');
  assert.ok(raw.encodePs('a').length > 0);
});

test('printraw: honest answers for every outcome', () => {
  const ok = raw.interpret(JSON.stringify({ raw: 'OK|12|40', printerStatus: '', jobStatus: 'gone' }), 40);
  assert.equal(ok.ok, true); assert.equal(ok.stage, 'sent'); assert.equal(ok.jobId, 12);
  const off = raw.interpret(JSON.stringify({ raw: 'OK|12|40', workOffline: true }), 40);
  assert.equal(off.ok, false); assert.match(off.error, /OFFLINE/); assert.equal(off.queued, true);
  const e1801 = raw.interpret(JSON.stringify({ raw: 'ERR|open|1801' }), 40);
  assert.equal(e1801.ok, false); assert.equal(e1801.stage, 'open'); assert.match(e1801.error, /does not know a printer/);
  const bad = raw.interpret('garbage', 10);
  assert.equal(bad.ok, false); assert.equal(bad.stage, 'powershell');
  const job = raw.interpret(JSON.stringify({ raw: 'OK|3|9', jobStatus: 'PaperOut' }), 9);
  assert.equal(job.ok, false); assert.match(job.error, /PaperOut/);
});

test('printraw: Windows printer status bits are decoded', () => {
  assert.equal(raw.decodeStatus(0).ready, true);
  const s = raw.decodeStatus(0x80 | 0x10);
  assert.equal(s.ready, false); assert.match(s.text, /offline/); assert.match(s.text, /out of paper/);
});

test('printraw: sendRaw validates, writes the bytes to a temp file, runs one job at a time and cleans up', async () => {
  assert.equal((await raw.sendRaw({ deviceName: '', bytes: Buffer.from('x') })).ok, false);
  assert.equal((await raw.sendRaw({ deviceName: 'P', bytes: Buffer.alloc(0) })).ok, false);
  let running = 0, maxRunning = 0; const seen = [];
  const exec = (cmd, args, opts, cb) => {
    running++; maxRunning = Math.max(maxRunning, running);
    seen.push({ name: opts.env.MYDUKA_PRN, data: fs.readFileSync(opts.env.MYDUKA_FILE) });
    setTimeout(() => { running--; cb(null, JSON.stringify({ raw: 'OK|1|' + seen[seen.length - 1].data.length, jobStatus: 'gone' }), ''); }, 15);
  };
  const jobs = [0, 1, 2].map((i) => raw.sendRaw({ deviceName: 'XP-80', bytes: Buffer.from([0x1b, 0x40, i]), exec, verifyMs: 0 }));
  const rs = await Promise.all(jobs);
  assert.ok(rs.every((r) => r.ok), JSON.stringify(rs));
  assert.equal(maxRunning, 1, 'jobs never overlap');
  assert.deepEqual(seen.map((s) => s.data[2]), [0, 1, 2], 'in order, each its own data');
  assert.ok(!fs.existsSync(JSON.stringify(0)));
  const fail = await raw.sendRaw({ deviceName: 'XP-80', bytes: Buffer.from('x'), exec: (c, a, o, cb) => cb(Object.assign(new Error('x'), { killed: true }), '', '') });
  assert.equal(fail.ok, false); assert.match(fail.error, /did not answer in time/);
  const after = await raw.sendRaw({ deviceName: 'XP-80', bytes: Buffer.from('x'), exec, verifyMs: 0 });
  assert.equal(after.ok, true, 'one failure never blocks the next print');
});

test('exe wiring: main.js, preload.js and the build list all carry the raw printing path', () => {
  const main = fs.readFileSync(path.join(ROOT, 'native/windows/main.js'), 'utf8');
  const pre = fs.readFileSync(path.join(ROOT, 'native/windows/preload.js'), 'utf8');
  const build = fs.readFileSync(path.join(ROOT, 'native/windows/build.mjs'), 'utf8');
  for (const ch of ['native:rawPrint', 'native:printerStatus', 'native:printLog']) assert.ok(main.includes(ch), ch);
  for (const fn of ['rawPrint', 'printerStatus', 'printLog']) assert.ok(pre.includes(fn), fn);
  assert.ok(/printraw\.js/.test(build), 'printraw.js is packed into the installer');
  assert.ok(/fromOurs\(e\)/.test(main.slice(main.indexOf('native:rawPrint'), main.indexOf('native:rawPrint') + 300)), 'only our own pages may print');
});

// ---------- the app, with a fake Windows exe ----------
function winBridge(w, behaviour = {}) {
  w.__raw = [];
  w.MyDukaNative = {
    info: () => ({ platform: 'windows', version: '1.0.0' }),
    printers: async () => ({ ok: true, printers: [{ name: 'XP-80C', displayName: 'XP-80C', isDefault: true }] }),
    printerStatus: async () => ({ ok: true, found: true, name: 'XP-80C', status: behaviour.status || { ready: true, text: 'ready' }, driver: 'Xprinter' }),
    printLog: async () => ({ ok: true, lines: ['one line'] }),
    rawPrint: async (name, b64) => { w.__raw.push({ name, bytes: Buffer.from(b64, 'base64') }); return behaviour.fail ? { ok: false, stage: 'open', error: behaviour.fail } : { ok: true, stage: 'sent', state: 'sent' }; },
    print: async () => ({ ok: true }), printHtml: async () => ({ ok: true }),
  };
}
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha Soap', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const prep = (w) => w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; document.getElementById('login-screen').style.display = 'none'");

test('Windows exe: choosing a thermal printer sends raw ESC/POS (init … text … feed + cut) and a real sale prints through it', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Duka Test' }, beforeParse: (w) => winBridge(w), wait: 1200 });
  const { w, d } = b; prep(w);
  w.eval("document.querySelector('.tab-link[data-tab=\"settings-tab\"]').click(); document.querySelector('[data-section=\"settings-section-install\"]').click()");
  await new Promise((r) => setTimeout(r, 100));
  await w.eval('nativePrinterScan()');
  await w.eval('nativePrinterPick(0)');
  assert.match(d.getElementById('native-printer-list').textContent, /Thermal receipt printer/);
  await w.eval("nativePrinterUse('raw')");
  assert.equal(JSON.parse(w.localStorage.getItem('pos_native_printer_v1')).kind, 'windows-raw');
  assert.equal(w.eval('printerMode'), 'bluetooth');
  const t = w.__raw[0].bytes;
  assert.deepEqual([...t.subarray(0, 2)], [0x1b, 0x40], 'starts with ESC @');
  assert.deepEqual([...t.subarray(t.length - 4)], [0x1d, 0x56, 0x42, 0x00], 'ends with feed + cut');
  assert.equal(w.__raw[0].name, 'XP-80C');
  w.eval("autoPrintEnabled = false; addToCart('A'); currentPaymentMethod = 'cash'");
  d.getElementById('cash-tendered-input').value = '500';
  await w.eval('checkoutCart()');
  const before = w.__raw.length;
  await w.eval('printReceipt()');
  assert.equal(w.__raw.length, before + 1, 'one print = one job');
  const last = w.__raw[w.__raw.length - 1].bytes;
  assert.deepEqual([...last.subarray(0, 2)], [0x1b, 0x40]);
  assert.match(Buffer.from(last).toString('latin1'), /Alpha|Duka/);
  assert.equal(w.eval('salesLog.length'), 1);
  b.close();
});

test('Windows exe: a failed print says exactly why, keeps the sale, and does not mark the receipt printed', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_native_printer_v1: JSON.stringify({ kind: 'windows-raw', deviceName: 'XP-80C' }), pos_printer_mode: 'bluetooth' }, beforeParse: (w) => winBridge(w, { fail: 'The printer is not ready (switched off, unplugged or offline).' }), wait: 1200 });
  const { w } = b; prep(w);
  w.eval("autoPrintEnabled = false; addToCart('A'); currentPaymentMethod = 'cash'");
  w.document.getElementById('cash-tendered-input').value = '500';
  await w.eval('checkoutCart()');
  await w.eval('printReceipt()');
  assert.match(w.eval('window.__toasts.join(" | ")'), /not ready \(switched off/);
  assert.equal(w.eval('salesLog.length'), 1, 'the sale is recorded whatever the printer does');
  assert.ok(!w.eval('salesLog[0].printedAt'), 'a failed print is never marked printed');
  assert.ok(w.eval('nativePrintLog().some(function (x) { return !x.ok; })'), 'the failure is in the print log');
  await w.eval('printReceipt()');   // the till is not frozen: another try works
  assert.equal(w.__raw.length, 2);
  b.close();
});

test('Windows exe: the diagnostic ladder sends 4 increasing tests and the health panel reports the printer honestly', async () => {
  const b = await boot('index.html', { storage: { pos_native_printer_v1: JSON.stringify({ kind: 'windows-raw', deviceName: 'XP-80C' }), pos_printer_mode: 'bluetooth' }, beforeParse: (w) => winBridge(w, { status: { ready: false, text: 'offline' } }), wait: 1200 });
  const { w, d } = b; prep(w);
  w.eval("document.querySelector('.tab-link[data-tab=\"settings-tab\"]').click(); document.querySelector('[data-section=\"settings-section-install\"]').click()");
  await new Promise((r) => setTimeout(r, 300));
  assert.match(d.getElementById('native-printer-health').textContent, /reports: offline/);
  for (const l of [1, 2, 3, 4]) await w.eval('nativePrinterLadder(' + l + ')');
  assert.equal(w.__raw.length, 4);
  const hasCut = (x) => x.bytes.includes(0x1d) && Buffer.from(x.bytes).includes(Buffer.from([0x1d, 0x56]));
  assert.equal(hasCut(w.__raw[0]), false, 'test 2 = plain text, no cut');
  assert.equal(hasCut(w.__raw[1]), false, 'test 3 = text + feed, no cut');
  assert.equal(hasCut(w.__raw[2]), true, 'test 4 = text + feed + cut');
  assert.ok(Buffer.from(w.__raw[1].bytes).includes(Buffer.from([0x1b, 0x64])), 'feed command present');
  b.close();
});

test('web version unchanged: with no exe there is no raw printer and printing uses the old paths', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS) }, wait: 600 });
  assert.equal(b.w.eval('typeof window.nativeBytePrinter === "function" ? window.nativeBytePrinter() : null'), null);
  b.close();
});

// ---------- Order Ticket (hotel) ----------
test('order ticket: its own settings, spaced text, minimal feed, chosen cut — and the receipt is untouched', async () => {
  const b = await boot('hotel/index.html', { wait: 900 });
  const { w } = b;
  const defaults = JSON.parse(JSON.stringify(w.eval('ticketCfg()')));
  assert.deepEqual({ ...defaults }, { mm: 0, pt: 11.5, ls: 0, gap: 0, top: 0, feed: 1, cut: 'partial' });
  const text = ['*** ORDER TICKET ***', '', 'TABLE 4', '--------------------------------', '2x  Burger', '     - Fries', '1x  Juice', '--------------------------------', 'Guest: A'].join('\n');
  // default bytes: init, text, ONE feed line, partial cut — no big blank
  let bytes = Buffer.from(w.eval('Array.from(buildTicketBytes(' + JSON.stringify(text) + '))'));
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40]);
  assert.ok(bytes.includes(Buffer.from([0x1b, 0x64, 0x01, 0x1d, 0x56, 0x42, 0x00])), 'feed of exactly one line, then the cut');
  assert.ok(bytes.includes(Buffer.from([0x1d, 0x56, 0x42, 0x00])), 'partial cut');
  assert.ok(!Buffer.from(bytes).toString('latin1').includes('\n\n\n\n'), 'no run of blank lines');
  // changed settings
  w.localStorage.setItem('pos_ticket_size_v1', JSON.stringify({ top: 2, ls: 2, gap: 1, feed: 0, cut: 'full' }));
  bytes = Buffer.from(w.eval('Array.from(buildTicketBytes(' + JSON.stringify(text) + '))'));
  assert.ok(bytes.includes(Buffer.from([0x1d, 0x56, 0x41, 0x00])), 'full cut');
  assert.ok(!bytes.includes(Buffer.from([0x1b, 0x64])), 'feed 0 sends no feed');
  assert.ok(bytes.includes(Buffer.from([0x1b, 0x33, 54])), 'line spacing set');
  const spaced = w.eval('ticketPrepare(' + JSON.stringify(text) + ')').split('\n');
  assert.equal(spaced[0], ''); assert.equal(spaced[1], '', '2 lines above');
  const iBurger = spaced.indexOf('2x  Burger');
  assert.equal(spaced[iBurger + 1], '     - Fries'); assert.equal(spaced[iBurger + 2], '', 'a blank line between items');
  assert.equal(spaced[iBurger + 3], '1x  Juice');
  w.localStorage.setItem('pos_ticket_size_v1', JSON.stringify({ cut: 'none' }));
  bytes = Buffer.from(w.eval('Array.from(buildTicketBytes(' + JSON.stringify(text) + '))'));
  assert.ok(!bytes.includes(Buffer.from([0x1d, 0x56])), 'no cut at all');
  // buildEscPosBytes picks the ticket builder only for the ticket itself
  w.eval('lastKitchenTicketText = ' + JSON.stringify(text));
  const viaGeneric = Buffer.from(w.eval('Array.from(buildEscPosBytes(lastKitchenTicketText))'));
  assert.ok(!viaGeneric.includes(Buffer.from([0x1d, 0x56])), 'the ticket (cut: none) went through the ticket builder');
  b.close();
});

test('order ticket: the settings screen has the new controls, the test button prints a dummy ticket through the real pipeline', async () => {
  const sent = [];
  const b = await boot('hotel/index.html', { storage: { pos_printer_mode: 'bluetooth', pos_native_printer_v1: JSON.stringify({ kind: 'windows-raw', deviceName: 'KIT-1' }) }, beforeParse: (w) => winBridge(w), wait: 1000 });
  const { w, d } = b; prep(w);
  w.eval('ticketSizeOpen()');
  const m = d.getElementById('ticket-size-modal').textContent;
  for (const t of ['Space above the ticket', 'Line spacing', 'Space between items', 'Paper pushed out', 'Cutter', 'Print test order ticket', 'Printable width']) assert.ok(m.includes(t), t);
  w.eval("ticketSizeOpt('cut', 'full'); ticketSizeOpt('feed', 2)");
  assert.equal(w.eval('__ticketDraft.cut'), 'full');
  await w.eval('ticketSizeTest()');
  assert.equal(w.__raw.length, 1, 'one test = one job on the ticket printer');
  const bytes = w.__raw[0].bytes;
  assert.match(Buffer.from(bytes).toString('latin1'), /ORDER TICKET[\s\S]*Chicken Burger/);
  assert.ok(bytes.includes(Buffer.from([0x1d, 0x56, 0x41, 0x00])), 'the UNSAVED full-cut setting was used for the test');
  assert.ok(!w.localStorage.getItem('pos_ticket_size_v1'), 'a test never saves the settings');
  w.eval('ticketSizeSave()');
  assert.equal(JSON.parse(w.localStorage.getItem('pos_ticket_size_v1')).cut, 'full');
  b.close();
});

// ---------- zip 207: speed ----------
import { EventEmitter } from 'node:events';
function fakePs(log) {
  return () => {
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.stdin = Object.assign(new EventEmitter(), { write(line) { const r = JSON.parse(line); log.push(r); setTimeout(() => p.stdout.emit('data', Buffer.from(JSON.stringify({ id: r.id, raw: 'OK|7|' + fs.readFileSync(r.file).length, jobStatus: 'gone' }) + '\n')), 5); } });
    p.kill = () => { p.emit('exit'); };
    setTimeout(() => p.stdout.emit('data', Buffer.from('READY\n')), 5);
    return p;
  };
}
test('speed: one long-lived PowerShell serves every print (started once, not once per print)', async () => {
  raw.workerKill();
  const log = []; let starts = 0; const sp = fakePs(log); const spawn = (...a) => { starts++; return sp(...a); };
  const t0 = Date.now();
  const rs = [];
  for (let i = 0; i < 5; i++) rs.push(await raw.sendRaw({ deviceName: 'XP-80', bytes: Buffer.from([0x1b, 0x40, i]), spawn }));
  assert.ok(rs.every((r) => r.ok && r.stage === 'sent'), JSON.stringify(rs));
  assert.equal(starts, 1, 'PowerShell was started once');
  assert.equal(log.length, 5);
  assert.ok(Date.now() - t0 < 1500, 'five prints in well under 1.5 s');
  raw.workerKill();
});
test('speed: a worker that dies or never answers falls back to the one-shot way, the print still happens', async () => {
  raw.workerKill();
  const deadSpawn = () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = Object.assign(new EventEmitter(), { write() {} }); p.kill = () => {}; setTimeout(() => p.emit('exit'), 5); return p; };
  const r = await raw.sendRaw({ deviceName: 'XP-80', bytes: Buffer.from('x'), spawn: deadSpawn, warmMs: 200, powershell: process.execPath, timeoutMs: 2000 });
  assert.equal(r.ok, false, 'one-shot ran (and, with node as fake PowerShell, honestly failed) instead of hanging');
  assert.ok(r.error);
  raw.workerKill();
});
test('speed: a button doing slow work shows a spinner after 0.2 s, never for background chatter, and a quick one never does', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const fetch = async (u) => { if (String(u).includes('slow')) await gate; return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}', clone() { return this; } }; };
  const b = await boot('index.html', { fetch, wait: 700 });
  const { w, d } = b;
  const mk = (id, js) => { const x = d.createElement('button'); x.id = id; x.textContent = id; x.onclick = () => w.eval(js); d.body.appendChild(x); return x; };
  const slow = mk('slowb', "fetch('/api/slow')"), bg = mk('bgb', "fetch('/api/health'); new Promise(r=>setTimeout(r,0)); window.__x=1"), quick = mk('quickb', 'window.__q=1');
  slow.click(); bg.click(); quick.click();
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(slow.classList.contains('mk-busy'), 'slow action shows busy');
  assert.ok(!quick.classList.contains('mk-busy')); assert.ok(!bg.classList.contains('mk-busy'), 'background chatter is not "working"');
  release(); await new Promise((r) => setTimeout(r, 400));
  assert.ok(!slow.classList.contains('mk-busy'), 'busy clears when the work is done');
  b.close();
});
