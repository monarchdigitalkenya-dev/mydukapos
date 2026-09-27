import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// Zip 145 — "installed apps show OFFLINE with working internet". In a REAL browser with the REAL service worker: an installed app on a
// slow line (the server takes 6 s to answer) opens its cached copy at once, the download is NOT abandoned, the cached copy is replaced,
// the open app is told a newer version is ready, and the next open is the new release. (Before, the download was aborted at 3.5 s and
// the installed app stayed on its old copy — with its old offline detection — for good.) Skipped where Playwright is not installed.
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';

test('installed app on a slow line: opens at once from cache, then catches up to the new release by itself', { skip, timeout: 90000 }, async () => {
  let version = 'A', delay = 0;
  const page = () => `<!doctype html><meta charset="utf-8"><title>t</title><div id="v">${version}</div>
    <script>window.__told = null; if (navigator.serviceWorker) { navigator.serviceWorker.addEventListener('message', (e) => { window.__told = e.data; }); navigator.serviceWorker.register('sw.js'); }</script>`;
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/' || p === '/index.html') {
      const body = page(), v = version;
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/html', ETag: `"${v}"`, 'Cache-Control': 'no-cache' }); res.end(body); }, delay);
      return;
    }
    const f = path.join(ROOT, p);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.png') ? 'image/png' : 'application/json' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const tab = await ctx.newPage();
    // 1. install (fast line)
    await tab.goto(base);
    await tab.evaluate(() => navigator.serviceWorker.ready);
    await tab.reload();
    await tab.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
    assert.equal(await tab.textContent('#v'), 'A');
    await tab.waitForTimeout(500);
    // 2. a new release is deployed, and the line is slow (6 s to answer)
    version = 'B'; delay = 6000;
    const t0 = Date.now();
    await tab.reload();
    assert.equal(await tab.textContent('#v'), 'A', 'opens from the cached copy');
    assert.ok(Date.now() - t0 < 5500, `opened without waiting for the slow line (${Date.now() - t0} ms)`);
    // 3. the download carried on, replaced the copy, and the open app was told
    await tab.waitForFunction(() => window.__told && window.__told.type === 'app-update-ready', null, { timeout: 15000 });
    // 4. the next open (still a slow line) is the new release
    await tab.reload();
    assert.equal(await tab.textContent('#v'), 'B', 'the next open is the new release — no longer stuck on the old copy');
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
