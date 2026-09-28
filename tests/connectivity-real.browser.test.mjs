import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// Zip 147 — "working internet, but the POS says offline / server refused", "works in one Chrome profile, not in Guest". In a REAL
// browser, with the REAL shop app and its REAL service worker, against a server whose answers we control:
//   * a fresh profile (what Chrome Guest is: no storage, no cache, no service worker) and a profile with an installed app;
//   * the POS health check blocked while the site itself answers, with the outside test sites unreachable (a network that blocks
//     them) -> must NOT say "no internet" (it said so before zip 147);
//   * Cloudflare's security check answering instead of the POS server -> recognised, and an installed app lets the check's page
//     through (before, the service worker swapped in the cached app, so the check could never be passed);
//   * really offline -> offline.
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';

function startServer() {
  const ctl = { health: 'ok', page: 'ok', hits: [] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    ctl.hits.push(p);
    const challenge = () => { res.writeHead(403, { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge', 'Cache-Control': 'no-store' }); res.end('<!doctype html><title>Just a moment...</title><h1 id="cf">Checking your browser</h1>'); };
    if (p === '/api/health') {
      if (ctl.health === 'block') { req.socket.destroy(); return; }
      if (ctl.health === 'challenge') return challenge();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, t: Date.now() }));
    }
    if (p.startsWith('/api/')) {
      if (ctl.health === 'challenge') return challenge();
      if (ctl.health === 'block') { req.socket.destroy(); return; }
      if (p === '/api/pos-sync') {                                   // a minimal sync server: nothing new to pull, every push accepted
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(req.method === 'POST' ? { ok: true, updatedAt: Date.now() } : { unchanged: true, updatedAt: 1 }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{}');
    }
    if (p === '/' || p === '/index.html') {
      if (ctl.page === 'challenge') return challenge();
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
    }
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.png') ? 'image/png' : p.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, ctl, base: `http://127.0.0.1:${srv.address().port}/` })));
}
const net = (page) => page.evaluate(() => ({ state: window.PosNet && window.PosNet.state, title: (document.getElementById('sync-status') || {}).title || '' }));
const waitNet = (page, want, ms = 45000) => page.waitForFunction((w) => window.PosNet && w.includes(window.PosNet.state), want, { timeout: ms, polling: 250 });
// the outside test sites (gstatic, 1.1.1.1) are treated as unreachable: what a network that blocks them looks like
const blockOutside = (ctx) => ctx.route(/gstatic\.com|1\.1\.1\.1/, (r) => r.abort('connectionrefused'));

test('connectivity in a real browser: fresh (Guest) and installed profiles, blocked health, Cloudflare challenge, really offline', { skip, timeout: 240000 }, async () => {
  const { srv, ctl, base } = await startServer();
  const browser = await chromium.launch();
  try {
    // --- 1. a FRESH profile (Chrome Guest): online -> online
    const guest = await browser.newContext(); await blockOutside(guest);
    const g = await guest.newPage();
    await g.goto(base);
    await waitNet(g, ['online']);
    // --- 2. the POS health check is blocked (reset), the site itself answers, the outside sites are blocked: NOT "no internet"
    ctl.health = 'block';
    await g.evaluate(() => window.PosNet.check('test: health blocked'));
    await waitNet(g, ['backend_unavailable', 'offline']);
    const s2 = await net(g);
    assert.equal(s2.state, 'backend_unavailable', 'the site answered, so this device HAS internet: never "offline" (' + JSON.stringify(s2) + ')');
    assert.doesNotMatch(s2.title, /no internet/i);
    const diag = await g.evaluate(() => window.PosNet.diagnostics());
    assert.equal(diag.ownSite, true); assert.equal(diag.health.kind, 'neterr');
    // --- 3. it comes back by itself
    ctl.health = 'ok';
    await g.evaluate(() => window.PosNet.check('test: back'));
    await waitNet(g, ['online']);
    // --- 4. Cloudflare's security check answers instead of the POS server: recognised as such (not "offline", not "link not active")
    ctl.health = 'challenge';
    await g.evaluate(() => window.PosNet.check('test: challenge'));
    await waitNet(g, ['security_check']);
    assert.match((await net(g)).title, /security check/i);
    ctl.health = 'ok';
    await guest.close();

    // --- 5. an INSTALLED app (service worker controlling the page) — the challenge PAGE must be let through so it can be passed
    const inst = await browser.newContext(); await blockOutside(inst);
    const a = await inst.newPage();
    await a.goto(base);
    await a.evaluate(() => navigator.serviceWorker.ready);
    await a.reload();
    await a.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
    await waitNet(a, ['online']);
    ctl.page = 'challenge';
    await a.reload();
    assert.equal(await a.locator('#cf').count(), 1, 'the security check page is shown (not swapped for the cached app), so the browser can pass it');
    ctl.page = 'ok';
    await a.reload();
    await waitNet(a, ['online']);
    // --- 6. really offline: offline (and the installed app still opens)
    await inst.setOffline(true);
    await a.evaluate(() => window.PosNet.check('test: offline'));
    await waitNet(a, ['offline']);
    await a.reload();
    assert.ok(await a.evaluate(() => typeof window.PosNet === 'object'), 'the installed app opens with no internet');
    await inst.setOffline(false);
    await a.evaluate(() => window.PosNet.check('test: back online'));
    await waitNet(a, ['online']);
    await inst.close();
  } finally { await browser.close(); srv.close(); }
});
