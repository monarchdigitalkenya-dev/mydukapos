import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// Zip 217 — the Chama screens in a real phone-sized Chromium, talking to the real server code: set-up, sign-in, paste an M-Pesa message, the secretary confirms it, the member sees it.
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) { try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ } }
const skip = !chromium && 'Playwright not installed';
const route = await import(pathToFileURL(path.join(ROOT, 'functions/api/chama.js')).href);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const SMS = 'UJ4QY98MZL Confirmed. Ksh100.00 sent to Gabriel Njuguna on 4/10/26 at 11:08 PM. New M-PESA balance is Ksh44.40. Transaction cost, Ksh0.00. Amount you can transact within the day is 498,520.00. See all your balances now https://saf.cx/kWQpy';

test('Chama in a phone browser: set-up, sign-in, report an M-Pesa payment, confirm it, member sees it', { skip, timeout: 120000 }, async () => {
  const kv = makeKV(); seedShop(kv, 'G1', { product: 'chama' }); const env = { mydukapos_kv: kv, LEDGER_DB: makeD1() };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/chama') {
      const body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
      const resp = await route.onRequestPost({ request: new Request('http://x' + req.url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'X-Chama-Token': req.headers['x-chama-token'] || '' } }), env });
      res.writeHead(resp.status, { 'content-type': 'application/json' }); return res.end(await resp.text());
    }
    let p = path.join(ROOT, decodeURIComponent(u.pathname)); if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch(); const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: 'block' }); const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
    await page.goto(base + '/chama/?c=G1'); await page.waitForSelector('#s-g');
    await page.fill('#s-g', 'Umoja Chama'); await page.fill('#s-n', 'Alice Admin'); await page.fill('#s-p', '0711000001'); await page.fill('#s-pin', '1234'); await page.click('text=Create my chama');
    await page.waitForSelector('text=Hello Alice');
    // settings: 6,000 every two months, staff add a member through the screen
    await page.click('.nav >> text=Staff'); await page.click('text=Settings'); await page.waitForSelector('#st-a');
    await page.fill('#st-a', '6000'); await page.selectOption('#st-f', 'bimonthly'); await page.click('text=Save settings'); await page.waitForSelector('.toast');
    await page.click('.nav >> text=Staff'); await page.click('text=Add, roles, devices'); await page.click('text=Add member'); await page.fill('#am-n', 'Mary Wanjiku'); await page.fill('#am-p', '0722000001'); await page.click('.sheet button:text-is("Add")');
    await page.waitForSelector('text=Member added'); const pin = (await page.textContent('.sheet .ok div')).trim(); assert.match(pin, /^\d{4}$/);
    await page.click('text=Done');
    await page.click('.nav >> text=More'); await page.click('text=Sign out'); await page.waitForSelector('#l-p');
    // Mary: first sign-in forces her own PIN
    await page.fill('#l-p', '0722000001'); await page.fill('#l-pin', pin); await page.click('#l-b'); await page.waitForSelector('#p-o');
    await page.fill('#p-o', pin); await page.fill('#p-n', '5678'); await page.click('text=Save PIN'); await page.waitForSelector('text=Hello Mary');
    assert.ok(await page.isVisible('text=of KES 6,000'));
    // report the exact M-Pesa message
    await page.click('.nav >> text=Pay'); await page.fill('#pm', SMS); await page.waitForSelector('#pv .ok');
    const seen = await page.textContent('#pv'); assert.match(seen, /KES 100/); assert.match(seen, /UJ4QY98MZL/); assert.ok(!/44\.40|498,520|saf\.cx/.test(await page.textContent('body') .then((t) => t.replace(SMS, ''))), 'balance, limit and link are never shown');
    await page.click('text=Send for confirmation'); await page.waitForSelector('text=Waiting');
    // no sideways scroll on a phone
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    // a second try with the same code is refused on screen
    await page.fill('#pm', SMS); await page.waitForSelector('#pv .err');
    await page.click('.nav >> text=More'); await page.click('text=Sign out');
    // the admin confirms it
    await page.fill('#l-p', '0711000001'); await page.fill('#l-pin', '1234'); await page.click('#l-b'); await page.waitForSelector('text=Hello Alice');
    await page.click('.nav >> text=Staff'); await page.click('text=Payment inbox'); await page.waitForSelector('text=Mary Wanjiku'); await page.click('.card button:has-text("Confirm")'); await page.waitForSelector('text=Nothing here');
    await page.click('.nav >> text=More'); await page.click('text=Sign out');
    await page.fill('#l-p', '0722000001'); await page.fill('#l-pin', '5678'); await page.click('#l-b'); await page.waitForSelector('text=Hello Mary');
    const hero = (await page.textContent('.hero')).replace(/\s+/g, ' '); assert.match(hero, /KES 100 of KES 6,000/, hero + JSON.stringify(await env.LEDGER_DB.query('select status,amount_cents from chama_report')) + JSON.stringify(await env.LEDGER_DB.query('select kind,amount_cents,ref_id from chama_ledger')));
    assert.ok(await page.isVisible('text=Remaining KES 5,900'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
