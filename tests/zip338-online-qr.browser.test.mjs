// zip 338, in a real browser: the guest page asks for name / phone / address on the public code; the hotel gives every online customer their own bill;
// the Settings panel can make the public QR and print it on receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/json' };
const serve = () => new Promise((r) => { const s = http.createServer((q, res) => { let p = path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html'); if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); }); s.listen(0, '127.0.0.1', () => r(s)); });
const H = crypto.createHash('sha256').update('pw').digest('hex');
const TOKEN = 'A'.repeat(32);

test('guest page: the public code asks for name, phone and address and refuses an empty form', { skip, timeout: 90000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const posted = [];
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await ctx.route('**/api/qr-order**', async (r) => {
      const req = r.request();
      if (req.method() === 'GET') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ business: 'Lake View', location: { label: 'Order from home', kind: 'online' }, session: 's1', open: true, payment: null, menu: { categories: [], items: [{ code: 'BRG', name: 'Beef Burger', price: 650 }], modifierGroups: [], note: '' } }) });
      posted.push(JSON.parse(req.postData())); return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ error: 'stop here' }), status: 400 });
    });
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
    await page.goto(`${base}/order/?t=${TOKEN}`); await page.waitForSelector('.item .add');
    assert.match(await page.locator('#loc').innerText(), /Order from home/);
    await page.click('.item .add'); await page.click('#bar-go');
    const panel = page.locator('#sheet-panel');
    assert.equal(await panel.locator('input[type=tel]').count(), 1, 'a phone box');
    await panel.locator('button.go').click();
    assert.match(await panel.locator('.err').innerText(), /name/i); assert.equal(posted.length, 0, 'nothing is sent while details are missing');
    await panel.locator('input[aria-label="Your name"]').fill('Mary');
    await panel.locator('button.go').click(); assert.match(await panel.locator('.err').innerText(), /phone/i);
    await panel.locator('input[type=tel]').fill('0712 345 678');
    await panel.locator('button.go').click(); assert.match(await panel.locator('.err').innerText(), /deliver/i);
    await panel.locator('input[aria-label="Delivery address"]').fill('Kilimani');
    await panel.locator('button.go').click(); await page.waitForTimeout(300);
    assert.equal(posted.length, 1);
    assert.deepEqual([posted[0].name, posted[0].phone, posted[0].mode, posted[0].address], ['Mary', '0712 345 678', 'delivery', 'Kilimani']);
    assert.deepEqual(errs, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('hotel: each online customer gets their own bill; the panel offers the public QR and the receipt button', { skip, timeout: 90000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await ctx.route('**/api/**', (r) => r.abort());
    await ctx.addInitScript(([h, inv]) => {
      if (localStorage.getItem('seeded')) return; localStorage.setItem('seeded', '1');
      localStorage.setItem('pos_cash_config', JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }])); localStorage.setItem('pos_round_up', '0');
      localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'T'); localStorage.setItem('pos_inventory', inv);
    }, [H, JSON.stringify([{ code: 'BRG', type: 'service', name: 'Beef Burger', price: 650, qty: 0, unit: 'pcs' }])]);
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
    await page.goto(base + '/hotel/index.html'); await page.waitForTimeout(1500);
    await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; window.showToast = () => {}; window.print = () => {}; });
    const res = await page.evaluate(() => {
      const mk = (id, name, phone) => ({ id, kind: 'online', label: 'Order from home', name, phone, note: 'DELIVERY to: Kilimani', status: 'CLAIMED', owner: 'Alice', total: 650, items: [{ code: 'BRG', name: 'Beef Burger', qty: 1, price: 650, line: 0 }] });
      hospPrintRound = () => {};
      hospApplyClaimed(mk('qo-aaaa1111', 'Mary', '0712345678')); hospApplyClaimed(mk('qo-bbbb2222', 'Joe', '0722000111'));
      return tabs.filter((t) => t.status === 'OPEN').map((t) => [t.label, t.customerName, t.customerPhone, t.source, t.orderType]);
    });
    assert.equal(res.length, 2, 'two customers, two bills');
    assert.deepEqual(res.map((r) => r[1]).sort(), ['Joe', 'Mary']);
    assert.ok(res.every((r) => r[3] === 'ONLINE_QR' && r[4] === 'TAKEAWAY'));
    assert.ok(res.every((r) => /^Online: /.test(r[0])));
    // settings panel
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<div id="qr-panel-body"></div>'); renderQrPanel(); });
    assert.match(await page.locator('#qr-online-box').innerText(), /Make the public QR/);
    await page.evaluate(() => { hospQrCodes = [{ token: 'B'.repeat(32), kind: 'online', label: 'Order from home', active: true, locId: 'l1' }]; renderQrPanel(); });
    assert.match(await page.locator('#qr-online-box').innerText(), /Print it on every receipt/);
    // the receipt button turns the code into the receipt QR
    await page.evaluate(() => { hospQrOnlineEnsure = async () => hospQrCodes[0]; });
    await page.evaluate(() => hospQrOnlineToReceipt());
    const rq = await page.evaluate(() => ({ on: receiptShowQr, cap: receiptQrCaption, img: receiptQrData.slice(0, 22) }));
    assert.deepEqual(rq, { on: true, cap: 'Scan to order from home', img: 'data:image/png;base64,' });
    assert.deepEqual(errs, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
