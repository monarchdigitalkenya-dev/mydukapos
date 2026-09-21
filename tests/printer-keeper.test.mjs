import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// "The hardware must not need reconnecting every time it goes on or off": the last-used USB / Bluetooth printer is found again by itself
// (and keeps being looked for while it is off), a print finds a printer that has just been switched on, and a half-sent receipt is never repeated.
const APPS = ['index.html', 'hotel/index.html', 'water/index.html'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(30); } return false; };

// A USB printer. `present` = attached and switched on; `failNext` = number of transfers that fail with a lost-device error.
function makePrinter(name = 'POS-80', serial = 'S1') {
  const log = { written: [], claims: 0, opens: 0 };
  const cfg = { configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 7, endpoints: [{ endpointNumber: 3, direction: 'out', type: 'bulk' }] }] }] };
  const dev = {
    vendorId: 0x0416, productId: 0x5011, serialNumber: serial, productName: name, opened: false, configuration: null, present: true, failAfter: null, transfers: 0,
    async open() { if (!this.present) { const e = new Error('The device was disconnected.'); e.name = 'NotFoundError'; throw e; } log.opens++; this.opened = true; },
    async close() { this.opened = false; },
    async selectConfiguration() { this.configuration = cfg; },
    async claimInterface() { if (!this.present) { const e = new Error('The device was disconnected.'); e.name = 'NotFoundError'; throw e; } log.claims++; await sleep(20); },
    async transferOut(ep, data) {
      this.transfers++;
      if (!this.present || (this.failAfter !== null && this.transfers > this.failAfter)) { const e = new Error('The device was disconnected.'); e.name = 'NotFoundError'; throw e; }
      log.written.push(data.length); return { status: 'ok', bytesWritten: data.length };
    },
  };
  return { dev, log };
}
const nameKey = (app) => (app === 'water/index.html' ? 'aqua_usb_printer_name' : 'pos_usb_printer_name');
const modeStore = (app, name) => ({ [nameKey(app)]: name, pos_printer_mode: 'usb', aqua_printer_mode: 'usb' });
const tick = async (w) => { await w.eval('hwTick()'); };
const usbReady = (w) => w.eval("hwIsReady('usb')");

for (const app of APPS) {
  test(`${app}: a remembered USB printer that is OFF at start is looked for again and again, and connected by itself when it comes on — no button, no refresh`, async () => {
    const { dev } = makePrinter(); dev.present = false;
    let usb;
    const { w, d, close } = await boot(app, { storage: modeStore(app, 'POS-80'), usb: (win) => { usb = new win.EventTarget(); usb.getDevices = async () => [dev].filter((x) => x.present); usb.requestDevice = async () => dev; return usb; }, wait: 1500 });
    w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }");
    assert.equal(usbReady(w), false);
    await tick(w);
    assert.match(d.getElementById('usb-printer-status').textContent, /Looking for POS-80/, 'it says what it is doing');
    const fails1 = w.eval('window.__hwKeeper.fails');
    await tick(w);
    assert.ok(w.eval('window.__hwKeeper.fails') > fails1, 'and keeps checking');
    dev.present = true;                                                                     // the power comes back — no event at all
    assert.ok(await until(async () => { await tick(w); return usbReady(w); }), 'found by the next check');
    assert.match(d.getElementById('usb-printer-status').textContent, /Connected: POS-80/);
    assert.equal(w.eval('usbPrinterEndpoint'), 3);
    close();
  });

  test(`${app}: a power cut while connected: the printer drops, and is picked up again when it returns (also through the browser's "connected" event)`, async () => {
    const { dev } = makePrinter();
    let usb;
    const { w, d, close } = await boot(app, { storage: modeStore(app, 'POS-80'), usb: (win) => { usb = new win.EventTarget(); usb.getDevices = async () => [dev].filter((x) => x.present); usb.requestDevice = async () => dev; return usb; }, wait: 1500 });
    w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }");
    assert.ok(await until(async () => { await tick(w); return usbReady(w); }), 'connected at start');
    dev.present = false; dev.opened = false;                                                // power off
    usb.dispatchEvent(Object.assign(new w.Event('disconnect'), { device: dev }));
    assert.equal(usbReady(w), false);
    await tick(w);
    assert.equal(usbReady(w), false, 'still off: keeps looking, no crash');
    dev.present = true;                                                                     // power on
    usb.dispatchEvent(Object.assign(new w.Event('connect'), { device: dev }));
    assert.ok(await until(() => usbReady(w)), 'back on its own');
    assert.ok(await until(() => w.eval("(window.__toasts || []).filter(m => /Printer connected again/.test(m)).length") === 1), 'and it tells the cashier once');
    close();
  });
}

test('printing right after the printer was switched on — before anything reconnected it — finds it and prints (no "No USB printer connected")', async () => {
  const { dev, log } = makePrinter(); dev.present = false;
  const { w, close } = await boot('index.html', { storage: modeStore('index.html', 'POS-80'), usb: (win) => { const usb = new win.EventTarget(); usb.getDevices = async () => [dev].filter((x) => x.present); usb.requestDevice = async () => dev; return usb; }, wait: 1500 });
  w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }");
  w.eval('window.__hwKeeper.printing = 0; clearTimeout(window.__hwKeeper.timer)');           // (the background loop has not got to it yet)
  dev.present = true;
  const ok = await w.eval("printViaUSB('Hello\\n')");
  assert.equal(ok, true);
  assert.ok(log.written.length > 0);
  assert.equal(w.eval("(window.__toasts || []).some(m => /No USB printer connected/.test(m))"), false);
  close();
});

test('printing while the printer is really off waits a moment, then says so (it does not hang)', async () => {
  const { dev } = makePrinter(); dev.present = false;
  const { w, close } = await boot('index.html', { storage: modeStore('index.html', 'POS-80'), usb: (win) => { const usb = new win.EventTarget(); usb.getDevices = async () => []; usb.requestDevice = async () => dev; return usb; }, wait: 1500 });
  w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.__hwReadyMs = 900");
  const t0 = Date.now();
  const ok = await w.eval("printViaUSB('Hello\\n')");
  assert.equal(ok, false);
  assert.ok(Date.now() - t0 < 4000, 'a short wait, not a hang');
  assert.match((w.__toasts || []).join(' '), /No USB printer connected/);
  close();
});

test('the link dropping before a receipt starts: reconnect and print it once; dropping half way: NOT sent again (no duplicated half receipt)', async () => {
  const { dev, log } = makePrinter();
  const { w, close } = await boot('index.html', { storage: modeStore('index.html', 'POS-80'), usb: (win) => { const usb = new win.EventTarget(); usb.getDevices = async () => [dev].filter((x) => x.present); usb.requestDevice = async () => dev; return usb; }, wait: 1500 });
  w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.__hwReadyMs = 3000");
  assert.ok(await until(async () => { await tick(w); return usbReady(w); }));
  // 1. dead before the first byte, back a moment later
  dev.present = false; dev.opened = false;                                                   // the power went just as the receipt started
  setTimeout(() => { dev.present = true; }, 500);                                            // ...and comes back half a second later
  assert.equal(await w.eval("printViaUSB('Receipt one\\n')"), true, 'sent once after reconnecting');
  const afterOne = log.written.length;
  assert.ok(afterOne >= 1);
  // 2. dies after the first chunk of a long receipt
  const big = 'x'.repeat(9000);
  dev.failAfter = 1; dev.transfers = 0;
  const before = log.written.length;
  assert.equal(await w.eval(`printViaUSB(${JSON.stringify(big)})`), false, 'reported as failed');
  assert.equal(log.written.length - before, 1, 'only the chunk that went out — the job was NOT re-sent');
  close();
});

test('only the REMEMBERED printer is ever claimed: with the printer off, another permitted USB device (a scanner) is left alone', async () => {
  const printer = makePrinter('POS-80', 'P1'), scanner = makePrinter('Scanner', 'Z9');
  printer.dev.present = false;
  const { w, close } = await boot('index.html', { storage: modeStore('index.html', 'POS-80'), usb: (win) => { const usb = new win.EventTarget(); usb.getDevices = async () => [printer.dev, scanner.dev].filter((x) => x.present); usb.requestDevice = async () => printer.dev; return usb; }, wait: 1500 });
  await tick(w); await tick(w);
  assert.equal(scanner.log.claims, 0, 'the scanner was not claimed');
  assert.equal(usbReady(w), false);
  printer.dev.present = true;
  assert.ok(await until(async () => { await tick(w); return usbReady(w); }));
  assert.equal(w.eval('usbPrinterDevice.productName'), 'POS-80');
  assert.equal(scanner.log.claims, 0);
  close();
});

test('two reconnect attempts at once claim the printer once (no fighting over it)', async () => {
  const { dev, log } = makePrinter();
  const { w, close } = await boot('index.html', { storage: modeStore('index.html', 'POS-80'), usb: (win) => { const usb = new win.EventTarget(); usb.getDevices = async () => [dev]; usb.requestDevice = async () => dev; return usb; }, wait: 300 });
  w.eval('clearTimeout(window.__hwKeeper.timer); usbPrinterDevice = null; usbPrinterEndpoint = null');
  await sleep(300);
  const before = log.claims;
  const results = await Promise.all([w.eval('hwUsbReconnect()'), w.eval('hwUsbReconnect()'), w.eval('hwUsbReconnect()')]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(log.claims - before <= 1, true, 'claimed at most once');
  close();
});

test('system-dialog mode: the keeper does nothing (no USB or Bluetooth lookups at all)', async () => {
  let lookups = 0;
  const { w, close } = await boot('index.html', { storage: { pos_printer_mode: 'system' }, usb: (win) => { const usb = new win.EventTarget(); usb.getDevices = async () => { lookups++; return []; }; return usb; }, wait: 1500 });
  await tick(w); await tick(w);
  assert.equal(lookups, 0);
  close();
});

// ---- Bluetooth ----
function makeBtPrinter(name = 'BT-58', id = 'abc123') {
  const state = { on: true, writes: [], connects: 0 };
  const listeners = {};
  const ch = { properties: { write: true, writeWithoutResponse: false }, async writeValue(chunk) { if (!state.on) { const e = new Error('GATT Server is disconnected.'); e.name = 'NetworkError'; throw e; } state.writes.push(chunk.length); }, async writeValueWithoutResponse() {} };
  const server = { async getPrimaryService() { return { async getCharacteristics() { return [ch]; } }; } };
  const device = {
    id, name,
    gatt: { connected: false,
      async connect() { state.connects++; await sleep(10); if (!state.on) { const e = new Error('Connection attempt failed.'); e.name = 'NetworkError'; throw e; } this.connected = true; return server; },
      disconnect() { this.connected = false; } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    emit(type) { (listeners[type] || []).forEach((f) => f({ type })); },
    async watchAdvertisements() { state.watching = true; },
  };
  return { device, state };
}
const btStore = (name, id) => ({ pos_printer_mode: 'bluetooth', aqua_printer_mode: 'bluetooth', pos_bt_printer_name: name, aqua_bt_printer_name: name, ...(id ? { pos_bt_printer_id: id, aqua_bt_printer_id: id } : {}) });
const btReady = (w) => w.eval("hwIsReady('bt')");

test('Bluetooth, same page: the printer is switched off and on — it is reopened by itself (no chooser) and printing works again', async () => {
  const { device, state } = makeBtPrinter();
  const { w, close } = await boot('index.html', { storage: btStore('BT-58', 'abc123'), bluetooth: () => ({ requestDevice: async () => device, getDevices: async () => [device] }), wait: 1500 });
  w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.__hwBtConnectMs = 500");
  assert.ok(await until(async () => { await tick(w); return btReady(w); }), 'found by itself at start (remembered device)');
  state.on = false; device.gatt.connected = false; device.emit('gattserverdisconnected');    // switched off
  assert.equal(btReady(w), false);
  await tick(w);
  assert.equal(btReady(w), false, 'still off: keeps trying');
  state.on = true;                                                                          // switched on
  assert.ok(await until(async () => { await tick(w); return btReady(w); }), 'reopened');
  assert.equal(await w.eval("printViaBluetooth('Hello\\n')"), true);
  assert.ok(state.writes.length > 0);
  close();
});

test('Bluetooth after a reload: the remembered printer is found through the browser\'s list, and connected the moment it advertises', async () => {
  const { device, state } = makeBtPrinter(); state.on = false;
  const { w, close } = await boot('index.html', { storage: btStore('BT-58', 'abc123'), bluetooth: () => ({ requestDevice: async () => device, getDevices: async () => [device] }), wait: 1500 });
  w.eval("window.__hwBtConnectMs = 300");
  await tick(w);
  assert.equal(btReady(w), false);
  assert.equal(state.watching, true, 'asked to be told when it starts advertising');
  state.on = true;
  device.emit('advertisementreceived');                                                     // it was just switched on
  assert.ok(await until(() => btReady(w)), 'connected without waiting for the next poll');
  assert.equal(w.eval("localStorage.getItem('pos_bt_printer_id')"), 'abc123');
  close();
});

test('Bluetooth in a browser that cannot list remembered devices: no crash, and it says to tap Connect once', async () => {
  const { device } = makeBtPrinter();
  const { w, d, close } = await boot('index.html', { storage: btStore('BT-58'), bluetooth: () => ({ requestDevice: async () => device }), wait: 1500 });
  await tick(w);
  assert.match(d.getElementById('bluetooth-printer-status').textContent, /Tap Connect once/);
  assert.equal(btReady(w), false);
  close();
});

test('Bluetooth: a receipt whose first write fails on a dropped link is reconnected and sent once; one that fails part way is not repeated', async () => {
  const { device, state } = makeBtPrinter();
  const { w, close } = await boot('index.html', { storage: btStore('BT-58', 'abc123'), bluetooth: () => ({ requestDevice: async () => device, getDevices: async () => [device] }), wait: 1500 });
  w.eval("showToast = function () {}; window.__hwReadyMs = 3000; window.__hwBtConnectMs = 500");
  assert.ok(await until(async () => { await tick(w); return btReady(w); }));
  // the link is dead before the first chunk, then the printer answers again
  state.on = false;
  setTimeout(() => { state.on = true; }, 400);
  assert.equal(await w.eval("printViaBluetooth('First receipt\\n')"), true);
  const afterFirst = state.writes.length;
  assert.ok(afterFirst >= 1);
  // dies after the first chunk of a long one
  const big = 'y'.repeat(2000);
  let n = 0;
  const realWrite = w.eval('btPrinterCharacteristic').writeValue;
  w.eval('btPrinterCharacteristic').writeValue = async function (c) { if (++n > 1) { const e = new Error('GATT Server is disconnected.'); e.name = 'NetworkError'; throw e; } return realWrite.call(this, c); };
  const before = state.writes.length;
  assert.equal(await w.eval(`printViaBluetooth(${JSON.stringify(big)})`), false);
  assert.equal(state.writes.length - before, 1, 'the one chunk that went out; nothing was re-sent');
  close();
});

test('the print relay stays ON while the printer is switched off and picks up again by itself when it is back', async () => {
  const { dev } = makePrinter();
  let usb;
  const { w, d, close } = await boot('index.html', { storage: { ...modeStore('index.html', 'POS-80'), pos_print_relay_server: 'true' }, usb: (win) => { usb = new win.EventTarget(); usb.getDevices = async () => [dev].filter((x) => x.present); usb.requestDevice = async () => dev; return usb; }, wait: 1500 });
  w.eval("window.pollPrintRelayJobs = function () {}");
  assert.ok(await until(async () => { await tick(w); return usbReady(w); }));
  assert.equal(w.eval('printRelayServerEnabled'), true);
  assert.notEqual(w.eval('printRelayPollInterval'), null, 'polling while the printer is there');
  dev.present = false; dev.opened = false;
  usb.dispatchEvent(Object.assign(new w.Event('disconnect'), { device: dev }));
  assert.equal(w.eval('printRelayServerEnabled'), true, 'the choice is kept');
  assert.equal(w.eval("localStorage.getItem('pos_print_relay_server')"), 'true', 'and stays saved');
  assert.equal(w.eval('printRelayPollInterval'), null, 'polling pauses: nothing here to print on');
  dev.present = true;
  usb.dispatchEvent(Object.assign(new w.Event('connect'), { device: dev }));
  assert.ok(await until(() => usbReady(w)));
  assert.ok(await until(() => w.eval('printRelayPollInterval') !== null), 'polling resumes by itself');
  assert.equal(d.getElementById('print-relay-server-toggle').checked, true);
  close();
});

test('a printer that stops answering does not block printing for ever: the write gives up, the handle is dropped, and the keeper reopens it', async () => {
  const { dev, log } = makePrinter();
  const { w, close } = await boot('index.html', { storage: modeStore('index.html', 'POS-80'), usb: (win) => { const usb = new win.EventTarget(); usb.getDevices = async () => [dev].filter((x) => x.present); usb.requestDevice = async () => dev; return usb; }, wait: 1500 });
  w.eval("showToast = function () {}; window.__hwWriteMs = 250; window.__hwReadyMs = 1500");
  assert.ok(await until(async () => { await tick(w); return usbReady(w); }));
  const realTransfer = dev.transferOut;
  dev.transferOut = () => new Promise(() => {});                                            // hangs, never answers
  const t0 = Date.now();
  assert.equal(await w.eval("printViaUSB('Stuck\\n')"), false);
  assert.ok(Date.now() - t0 < 3000, 'gave up');
  assert.equal(usbReady(w), false, 'the handle was dropped');
  assert.equal(log.written.length, 0, 'and nothing was re-sent');
  dev.transferOut = realTransfer;                                                           // it answers again
  assert.ok(await until(async () => { await tick(w); return usbReady(w); }), 'the keeper reopened it');
  assert.equal(await w.eval("printViaUSB('Works again\\n')"), true, 'and the next receipt prints');
  close();
});
