import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';

for (const app of ['index.html', 'water/index.html', 'hotel/index.html']) {
  test(`${app}: USB printer connects, reports unplug, reconnects on replug`, async () => {
    const dev = { vendorId: 1, productId: 2, serialNumber: 'x', productName: 'XP-80',
      configuration: { interfaces: [{ interfaceNumber: 0, alternates: [{ interfaceClass: 7, endpoints: [{ direction: 'out', endpointNumber: 1 }] }] }] },
      async open() {}, async selectConfiguration() {}, async claimInterface() {}, async close() {} };
    let usb;
    const { w, d, close } = await boot(app, {
      usb: (win) => { usb = new win.EventTarget(); usb.requestDevice = async () => dev; usb.getDevices = async () => [dev]; return usb; },
    });
    const status = () => d.getElementById('usb-printer-status').textContent;
    await w.eval('connectUsbPrinter()');
    assert.match(status(), /Connected: XP-80/);
    usb.dispatchEvent(Object.assign(new w.Event('disconnect'), { device: dev }));
    assert.match(status(), /unplugged/);
    assert.equal(w.eval('usbPrinterDevice === null'), true);
    w.eval("printerMode='usb'");
    usb.dispatchEvent(Object.assign(new w.Event('connect'), { device: dev }));
    await until(() => /Connected: XP-80/.test(status()));
    assert.match(status(), /Connected: XP-80/);
    close();
  });
}

// A composite printer (HID interface listed first) with a small input buffer, like many budget USB POS printers.
function compositeDevice(written) {
  const cfg = { configurationValue: 1, interfaces: [
    { interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 3, endpoints: [{ endpointNumber: 1, direction: 'in', type: 'interrupt' }, { endpointNumber: 2, direction: 'out', type: 'interrupt' }] }] },
    { interfaceNumber: 1, alternates: [{ alternateSetting: 0, interfaceClass: 7, endpoints: [{ endpointNumber: 3, direction: 'out', type: 'bulk' }] }] },
  ] };
  const dev = { vendorId: 0x0416, productId: 0x5011, serialNumber: 'S1', productName: 'POS-80', opened: false, configuration: null, claimed: new Set(),
    async open() { this.opened = true; }, async close() { this.opened = false; },
    async selectConfiguration() { this.configuration = cfg; },
    async claimInterface(n) { this.claimed.add(n); },
    async transferOut(ep, data) {
      const iface = cfg.interfaces.find((i) => i.alternates[0].endpoints.some((e) => e.endpointNumber === ep));
      if (!this.claimed.has(iface.interfaceNumber)) { const e = new Error('A transfer error has occurred.'); e.name = 'NetworkError'; throw e; }
      if (iface.alternates[0].interfaceClass !== 7) { written.push({ ep, lost: true }); return { status: 'ok', bytesWritten: data.length }; }   // HID never reaches the print engine
      if (data.length > 1024) { const e = new Error('A transfer error has occurred.'); e.name = 'NetworkError'; throw e; }
      written.push({ ep, n: data.length });
      return { status: 'ok', bytesWritten: data.length };
    } };
  return dev;
}

for (const app of ['hotel/index.html', 'index.html', 'water/index.html', 'production/index.html']) {
  test(`${app}: composite USB printer — claims the printer interface, prints, survives a small input buffer`, async () => {
    const written = [];
    const dev = compositeDevice(written);
    const nameKey = app === 'water/index.html' ? 'aqua_usb_printer_name' : 'pos_usb_printer_name';
    const { w, d, close } = await boot(app, {
      storage: { [nameKey]: 'POS-80', pos_printer_mode: 'usb', aqua_printer_mode: 'usb' },
      usb: (win) => { const usb = new win.EventTarget(); usb.requestDevice = async () => dev; usb.getDevices = async () => [dev]; return usb; },
    });
    if (!w.eval('usbPrinterDevice')) await w.eval('connectUsbPrinter()');
    assert.equal(w.eval('usbPrinterEndpoint'), 3, 'must use the bulk endpoint of the printer-class interface, not the HID one');
    assert.equal(await w.eval("printViaUSB('Hello receipt\\n')"), true);
    assert.equal(await w.eval('printViaUSB(' + JSON.stringify('Line of report text 1234567890\n'.repeat(400)) + ')'), true, 'long job retried in smaller pieces');
    assert.ok(written.length > 0 && written.every((x) => x.ep === 3 && !x.lost), 'every byte reached the printer endpoint');
    assert.ok(written.every((x) => x.n <= 1024));
    close();
  });
}
