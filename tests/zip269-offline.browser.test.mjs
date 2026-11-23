import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

// Zip 269 - every module must OPEN, SIGN IN and SELL with no internet, in a real browser with its real service worker:
// open once online (the service worker keeps the app), cut the network, close and reopen the app, sign in (shop password, staff PIN), make a sale.
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.css': 'text/css' };
function serve() {
  const srv = http.createServer((req, res) => {
    let u = decodeURIComponent(req.url.split('?')[0]);
    // Cloudflare Pages answers /x/index.html with a 308 to /x/ - the same here, so a copy stored through that redirect is tested too
    if (u.endsWith('/index.html')) { res.writeHead(308, { Location: u.slice(0, -'index.html'.length) + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '') }); res.end(); return; }
    if (u.endsWith('/')) u += 'index.html';
    if (u.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(fs.readFileSync(f));
  });
  return new Promise((r) => srv.listen(0, () => r(srv)));
}
const APPS = [['shop', ''], ['hotel', 'hotel/'], ['hospital', 'hospital/'], ['pharmacy', 'pharmacy/'], ['production', 'production/'], ['services', 'services/'], ['water', 'water/']];

for (const [name, dir] of APPS) {
  test(`${name}: opens offline from the service worker, signs in (password and staff PIN) and makes a cash sale with no internet`, { skip, timeout: 120000 }, async () => {
    const srv = await serve(), base = `http://127.0.0.1:${srv.address().port}/${dir}`;
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext(); const page = await ctx.newPage(); const errors = [];
      page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 140)));
      const pfx = name === 'water' ? 'aqua_' : 'pos_';
      // 1. ONLINE: the first visit installs the service worker
      await page.goto(base, { waitUntil: 'load' });
      const sw = await page.evaluate(async () => { const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('no service worker')), 10000))]); return !!reg.active; });
      assert.ok(sw, 'the service worker is active');
      await page.waitForTimeout(2500);                                     // it has fetched and kept the app
      // this shop already exists on the device (the normal day-to-day case): a name, a password, one staff member, one item
      await page.evaluate(([p, pw, pin, nm]) => {
        localStorage.setItem('pos_cash_config', JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }])); localStorage.setItem(p + 'biz_name', 'Offline Shop');   /* zip 304: the cash drawer (on by default since zip 291) would wait for an opening count */ localStorage.setItem(p + 'pw_hash', pw); localStorage.setItem(p + 'admin_pw_hash', pw);
        localStorage.setItem(p + 'staff', JSON.stringify([{ id: 's1', name: 'Mary', pinHash: pin, role: 'cashier' }]));
        localStorage.setItem(p + 'inventory', JSON.stringify([{ code: 'ITM1', type: 'item', name: 'Test item', price: 100, wholesalePrice: 60, qty: 20, unit: 'pcs', vatCategory: 'A' }]));
      }, [pfx, sha('good-pass'), sha('4321'), name]);
      // 2. OFFLINE: cut the network, close the app, open it again
      await ctx.setOffline(true);
      await page.close();
      const p2 = await ctx.newPage(); p2.on('pageerror', (e) => errors.push(String(e.message).slice(0, 140)));
      const resp = await p2.goto(base, { waitUntil: 'load', timeout: 20000 });
      assert.ok(resp && resp.ok(), 'the app opens with no internet');
      await p2.waitForTimeout(1500);
      assert.ok(await p2.evaluate(() => !!document.querySelector('#login-screen')), 'the page is the app');
      const shown = await p2.evaluate(() => { const l = document.getElementById('login-screen'); return !!l && getComputedStyle(l).display !== 'none'; });
      assert.ok(shown, 'the sign-in screen is shown straight away (no "waiting for internet")');
      assert.match(await p2.evaluate(() => document.getElementById('login-screen').innerText), /Offline Shop/);
      // 3. sign in offline: shop password
      await p2.evaluate(() => { try { selectLoginAdmin(); } catch (e) { /* the app has one step */ } });
      await p2.fill('#login-password-input', 'wrong'); await p2.evaluate(() => loginSubmit());
      assert.match(await p2.textContent('#login-error'), /incorrect/i, 'a wrong password is refused offline too');
      await p2.fill('#login-password-input', 'good-pass'); await p2.evaluate(() => loginSubmit());
      await p2.waitForTimeout(500);
      assert.equal(await p2.evaluate(() => getComputedStyle(document.getElementById('login-screen')).display), 'none', 'signed in');
      // staff PIN
      await p2.evaluate(() => { currentServer = null; pendingServerLoginId = 's1'; });
      const hasPin = await p2.evaluate(() => !!document.getElementById('server-pin-input'));
      if (hasPin) {
        await p2.evaluate(() => { document.getElementById('server-pin-input').value = '4321'; return submitServerPin(); });
        assert.equal(await p2.evaluate(() => currentServer && currentServer.name), 'Mary', 'the staff PIN signs in offline');
      }
      // 4. sell with no internet: it is kept on the device and sent when the connection returns
      const sold = await p2.evaluate(async () => {
        if (typeof addToCart !== 'function') return 'no-counter';
        const before = (typeof salesLog !== 'undefined') ? salesLog.length : 0;
        window.__t = []; showToast = function (m, e) { window.__t.push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.print = () => {};
        addToCart('ITM1'); currentPaymentMethod = 'cash'; { const t = document.getElementById('cash-tendered-input'); if (t) t.value = '200'; }
        try { await checkoutCart(); } catch (e) { return 'ERR ' + e.message; }
        const n = (typeof salesLog !== 'undefined' ? salesLog.length : 0) - before;
        return n === 1 ? 1 : 'sales ' + n + ' | toasts ' + JSON.stringify(window.__t) + ' | cart ' + JSON.stringify(Object.keys(currentCart || {})) + ' | login ' + getComputedStyle(document.getElementById('login-screen')).display;
      });
      if (sold !== 'no-counter') assert.equal(sold, 1, 'one sale was recorded while offline: ' + sold);
      const stock = await p2.evaluate(() => { if (typeof inventory === 'undefined') return null; const p = inventory.find((x) => x.code === 'ITM1'); return p ? p.qty : null; });
      if (sold === 1 && stock !== null) assert.equal(stock, 19, 'stock went down');
      // (last, because each extra tab takes the app's one working tab) the installed app starts from "./?source=pwa" and a shop's own link can carry ?c=... - both must open from the saved copy too
      for (const q of ['?source=pwa', '?c=abc123&source=pwa']) {
        const p3 = await ctx.newPage(); const r3 = await p3.goto(base + q, { waitUntil: 'load', timeout: 20000 });
        assert.ok(r3 && r3.ok(), 'opens offline with ' + q); assert.ok(await p3.evaluate(() => !!document.querySelector('#login-screen')), 'is the app (' + q + ')'); await p3.close();
      }
      assert.deepEqual(errors.filter((e) => !/Failed to fetch|NetworkError|Load failed|offline/i.test(e)), [], 'no page errors');
    } finally { await browser.close(); srv.close(); }
  });
}
