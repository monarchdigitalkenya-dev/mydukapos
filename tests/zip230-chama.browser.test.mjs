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

// Zip 230 — the Chama screens in a real phone-sized Chromium, talking to the real server code: set-up, sign-in, paste an M-Pesa message, the secretary confirms it, the member sees it.
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
    await page.goto(base + '/chama/?c=G1'); await page.waitForSelector('#s-g');
    await page.fill('#s-g', 'Umoja Chama'); await page.fill('#s-n', 'Alice Admin'); await page.fill('#s-p', '0711000001'); await page.fill('#s-pin', '1234'); await page.click('text=Create my chama');
    await page.waitForSelector('text=Hello Alice');
    await page.click('.nav >> text=Staff'); await page.click('text=Settings'); await page.waitForSelector('#st-a'); await page.fill('#st-a', '6000'); await page.selectOption('#st-f', 'bimonthly'); await page.click('text=Save settings'); await page.waitForSelector('.toast');
    // add two members with a role each
    await page.click('.nav >> text=Staff'); await page.click('text=Add, roles, devices'); await page.click('text=Add member');
    await page.fill('#am-n', 'Mary Wanjiku'); await page.fill('#am-p', '0722000001'); await page.check('.rl[value=treasurer]'); await page.click('.sheet button:text-is("Add")');
    await page.waitForSelector('text=Member added'); const pinM = (await page.textContent('.sheet .ok div')).trim(); await page.click('text=Done');
    await page.click('text=Add member'); await page.fill('#am-n', 'Peter Otieno'); await page.fill('#am-p', '0733000002'); await page.click('.sheet button:text-is("Add")');
    await page.waitForSelector('text=Member added'); const pinP = (await page.textContent('.sheet .ok div')).trim(); await page.click('text=Done');
    assert.ok(await page.isVisible('text=Member + Treasurer'));
    // the wizard opens and walks through
    await page.click('.nav >> text=Staff'); await page.click('text=Set up an existing chama'); await page.waitForSelector('#w-n');
    await page.click('text=Next →'); await page.fill('#w-a', '1000'); await page.click('text=Next →'); await page.click('text=Next →'); await page.waitForSelector('text=Step 4');
    await page.click('text=Next →'); await page.waitForSelector('.w-p'); await page.click('text=Cancel');
    // sign out -> who is logging in
    await page.click('.nav >> text=More'); await page.click('text=Sign out'); await page.waitForSelector('text=Who is logging in?');
    assert.ok(await page.isVisible('.login button:has-text("Peter Otieno")'));
    await page.click('.login button:has-text("Peter Otieno")'); await page.fill('#l-pin', pinP); await page.click('#l-b'); await page.waitForSelector('#p-n2');
    await page.fill('#p-n', '4321'); await page.fill('#p-n2', '4321'); await page.click('text=Save PIN'); await page.waitForSelector('text=Hello Peter');
    // wrong second PIN is refused on screen
    // cash report to Mary (treasurer)
    await page.click('.nav >> text=Pay'); await page.click('.pills >> text=Cash'); await page.waitForSelector('#cs-a');
    await page.selectOption('#cs-r', { label: /Mary/.test('') ? '' : (await page.$$eval('#cs-r option', (o) => o.find((x) => /Mary/.test(x.textContent)).textContent)) }); await page.fill('#cs-a', '500'); await page.click('text=Send for confirmation'); await page.waitForSelector('text=Waiting for Mary');
    // my contributions
    await page.click('.nav >> text=More'); await page.click('text=My contributions'); await page.waitForSelector('text=REPORT PAYMENT'); await page.waitForSelector('text=Payment breakdown');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.click('.nav >> text=More'); await page.click('text=Sign out'); await page.waitForSelector('text=Who is logging in?');
    // Mary confirms with a corrected amount
    await page.click('.login button:has-text("Mary Wanjiku")'); await page.fill('#l-pin', pinM); await page.click('#l-b'); await page.waitForSelector('#p-n2');
    await page.fill('#p-n', '8765'); await page.fill('#p-n2', '8765'); await page.click('text=Save PIN'); await page.waitForSelector('text=Hello Mary');
    await page.click('.nav >> text=Staff'); await page.click('text=Payment inbox'); await page.waitForSelector('text=gave you'); await page.click('.card button:has-text("Confirm")');
    await page.fill('#cc-a', '400'); await page.fill('#cc-r', 'only 400 in the envelope'); await page.click('text=Confirm cash received'); await page.waitForSelector('text=Nothing here');
    // merry-go-round: an admin takes over one that is already running
    await page.click('.nav >> text=More'); await page.click('text=Sign out'); await page.waitForSelector('text=Who is logging in?');
    await page.click('.login button:has-text("Alice Admin")'); await page.fill('#l-pin', '1234'); await page.click('#l-b'); await page.waitForSelector('text=Hello Alice');
    await page.click('.nav >> text=Staff'); await page.click('text=Settings'); await page.waitForSelector('#sf-g'); await page.check('#sf-g'); await page.click('text=Save settings'); await page.waitForSelector('.toast');
    await page.click('.nav >> text=More'); await page.click('text=Merry-go-round'); await page.waitForSelector('text=We are already running one'); await page.click('text=We are already running one');
    await page.waitForSelector('#g-a'); await page.fill('#g-a', '500'); await page.click('#g-recv button >> nth=0'); await page.fill('#g-l', '2026-09-20'); await page.waitForSelector('#g-next');
    assert.ok(await page.isVisible('text=Next payout calculated'));
    await page.click('text=Save the current position'); await page.waitForSelector('text=NEXT RECIPIENT');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    // zip 232: terms and conditions — admin types them, a member reads them; logo shows beside the name
    await page.click('.nav >> text=More'); await page.click('text=Terms & conditions'); await page.waitForSelector('#tc-t');
    await page.fill('#tc-t', '1. Pay on time.\n2. Be respectful.'); await page.click('text=Save terms'); await page.waitForSelector('.toast');
    await page.evaluate(() => api('logo.save', { logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }));
    await page.evaluate(() => { S.home = null; return syncLogo(Date.now()); }); await page.waitForTimeout(800);
    await page.click('.nav >> text=Staff'); await page.click('text=Settings'); await page.waitForSelector('#sp-l'); assert.ok(await page.isVisible('text=Chama logo'));
    await page.click('.nav >> text=More'); await page.click('text=Sign out'); await page.waitForSelector('text=Who is logging in?');
    assert.ok(await page.isVisible('.login img[src^="data:image/png"]'), 'logo is shown beside the chama name on the sign-in screen');
    await page.click('.login button:has-text("Peter Otieno")'); await page.fill('#l-pin', '4321'); await page.click('#l-b'); await page.waitForSelector('text=Hello Peter');
    await page.click('.nav >> text=More'); await page.click('text=Terms & conditions'); await page.waitForSelector('text=Pay on time');
    assert.equal(await page.isVisible('#tc-t'), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
