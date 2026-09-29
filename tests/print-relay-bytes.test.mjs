import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';

// zip 156: the print relay used to carry TEXT only, so a receipt printed by another device lost the logo and the stamp. The sender now also sends the
// finished printer bytes; the printing device sends those bytes to its printer.
const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('server: the bytes travel with the job to the printing device; a value that is not base64 (or too big) is dropped, the text still prints', async () => {
  const { makeKV, seedShop } = await import('./kv-fake.mjs');
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/print-relay.js')).href);
  const call = async (body) => (await m.onRequestPost({ request: new Request('https://x.pages.dev/api/print-relay?c=C1', { method: 'POST', body: JSON.stringify(body) }), env })).json();
  await call({ action: 'registerDevice', deviceId: 'dev-p', name: 'Printer', station: 'Front Counter', printerMode: 'usb', hasPrinter: true, acceptsRelay: true });
  const ok = Buffer.from([0x1B, 0x40, 0x1D, 0x76, 0x30, 0, 1, 2, 3]).toString('base64');
  assert.equal((await call({ action: 'submit', jobType: 'receipt', text: 'RECEIPT 1', bytesB64: ok })).ok, true);
  assert.equal((await call({ action: 'submit', jobType: 'receipt', text: 'RECEIPT 2', bytesB64: '<script>' })).ok, true);
  assert.equal((await call({ action: 'submit', jobType: 'receipt', text: 'RECEIPT 3', bytesB64: 'A'.repeat(262145) })).ok, true);
  const jobs = (await call({ action: 'poll', deviceId: 'dev-p' })).jobs;
  assert.deepEqual(jobs.map((j) => j.text), ['RECEIPT 1', 'RECEIPT 2', 'RECEIPT 3']);
  assert.equal(jobs[0].bytesB64, ok);
  assert.equal(jobs[1].bytesB64, undefined);
  assert.equal(jobs[2].bytesB64, undefined);
});

test('app: the sender puts the finished bytes on the job; the printing device sends exactly those bytes to its printer', async () => {
  for (const app of ['index.html', 'water/index.html', 'hotel/index.html']) {
    const posts = [];
    const fetch = async (url, opts = {}) => {
      const u = String(url);
      if (/print-relay/.test(u)) { const b = JSON.parse(opts.body); posts.push(b); return json(b.action === 'checkAvailable' ? { available: true } : { ok: true, delivered: 1, jobs: [] }); }
      return json({});
    };
    const t = await boot(app, { storage: {}, fetch, wait: 800 });
    t.w.eval('showToast = function () {}');
    // round trip of the encoding
    assert.equal(t.w.eval("Array.from(receiptBytesFromB64(receiptBytesToB64(new Uint8Array([27, 64, 0, 255, 128])))).join()"), '27,64,0,255,128', app);
    // a big block (a logo raster is tens of KB) survives too
    assert.equal(t.w.eval("(function(){ const a = new Uint8Array(40000).map((_, i) => i % 251); const b = receiptBytesFromB64(receiptBytesToB64(a)); return b.length === a.length && b.every((v, i) => v === a[i]); })()"), true, app);
    // the sender
    if (t.w.eval("typeof submitPrintRelayJob") === 'function') {          // (Aqua POS only prints relayed jobs, it never sends any)
      await t.w.eval("submitPrintRelayJob('receipt', 'HELLO', new Uint8Array([27, 64, 65, 10]))");
      const sub = posts.filter((p) => p.action === 'submit').pop();
      assert.equal(sub.text, 'HELLO'); assert.equal(Buffer.from(sub.bytesB64, 'base64').toString('hex'), '1b40410a', app);
    }
    // the printing device: a USB printer connected -> the bytes go out as they are
    t.w.eval("window.__sent = []; printerMode = 'usb'; usbPrinterDevice = {}; usbPrinterEndpoint = 1; sendBytesViaUSB = async function (b) { window.__sent.push(Array.from(b).join()); }; printViaUSB = async function () { window.__sent.push('TEXT'); };");
    await t.w.eval("printRelayedJob({ id: 'j1', jobType: 'receipt', text: 'X', bytesB64: '" + Buffer.from([27, 64, 65, 10]).toString('base64') + "' })");
    await t.w.eval("printRelayedJob({ id: 'j2', jobType: 'receipt', text: 'X' })");
    assert.deepEqual(JSON.parse(t.w.eval('JSON.stringify(window.__sent)')), ['27,64,65,10', 'TEXT'], app + ': bytes when the job has them, text otherwise');
    t.close();
  }
});
