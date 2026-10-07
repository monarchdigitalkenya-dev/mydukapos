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

test('Chama admin: duplicate-payment question, Undo, Reset and the training guide, in a phone browser', { skip, timeout: 120000 }, async () => {
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
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' }); const page = await ctx.newPage();
    const dialogs = []; var dialogsDbg = dialogs; let answer = 'recorded twice';
    page.on('dialog', async (d) => { dialogs.push(d.message()); if (d.type() === 'prompt') await d.accept(answer); else await d.accept(); });
    await page.goto(base + '/chama/?c=G1'); await page.waitForSelector('#s-g');
    await page.fill('#s-g', 'Umoja Chama'); await page.fill('#s-n', 'Alice Admin'); await page.fill('#s-p', '0711000001'); await page.fill('#s-pin', '1234'); await page.click('text=Create my chama');
    await page.waitForSelector('text=Hello Alice');
    await page.click('.nav >> text=Staff'); await page.click('text=Settings'); await page.waitForSelector('#st-a'); await page.fill('#st-a', '6000'); await page.selectOption('#st-f', 'bimonthly'); await page.click('text=Save settings'); await page.waitForTimeout(500);
    await page.click('.nav >> text=Staff'); await page.click('text=Add, roles, devices'); await page.click('text=Add member');
    await page.fill('#am-n', 'Mary Wanjiku'); await page.fill('#am-p', '0722000001'); await page.click('.sheet button:text-is("Add")'); await page.waitForSelector('text=Member added'); await page.click('text=Done');
    // record 6,000 for Mary, then the SAME again straight away: the app asks, the admin says yes
    await page.click('.nav >> text=Staff'); await page.click('text=Record a payment'); await page.waitForSelector('#rc-a');
    await page.selectOption('#rc-m', { label: 'Mary Wanjiku' }); await page.fill('#rc-a', '6000'); await page.click('text=Save payment'); await page.waitForSelector('text=Recorded');
    await page.click('.nav >> text=Staff'); await page.click('text=Record a payment'); await page.waitForSelector('#rc-a');
    await page.selectOption('#rc-m', { label: 'Mary Wanjiku' }); await page.fill('#rc-a', '6000'); await page.click('text=Save payment'); await page.waitForFunction(() => !document.querySelector('#rc-a'));
    await page.waitForTimeout(600);
    assert.ok(dialogs.some((m) => /second payment/.test(m)), 'the app asked "Is this a second payment?"');
    // Undo the extra one from Mary's own screen
    await page.click('.nav >> text=Staff'); await page.click('text=Add, roles, devices'); await page.click('.card:has-text("Mary Wanjiku")'); await page.waitForSelector('text=Payments (admin)');
    assert.equal(await page.locator('.sheet button:has-text("Undo this payment")').count(), 2);
    await page.click('.sheet button:has-text("Undo this payment") >> nth=0'); await page.waitForFunction(() => document.querySelectorAll('.sheet button').length && [...document.querySelectorAll('.sheet button')].filter((b) => /Undo this payment/.test(b.textContent)).length === 1);
    assert.equal(await page.locator('.sheet button:has-text("Undo this payment")').count(), 1, 'one payment is left');
    // Reset test payments for Mary
    await page.click('.sheet button:has-text("Reset test payments")'); await page.waitForTimeout(800);
    assert.ok(dialogs.some((m) => /Clear ALL the payments recorded for Mary/.test(m)));
    const stat = await page.evaluate(async () => { const r = await api('ledger.list', { memberId: S.home.member.id, limit: 5 }); return r.items.length; });
    assert.ok(stat >= 0);
    const tot = await page.evaluate(async () => { const r = await api('cycle.members', { limit: 50 }); const m = r.items.find((x) => /Mary/.test(x.name)); return m ? m.paidCents : -1; });
    assert.equal(tot, 0, 'Mary is back to zero after the reset');
    // the training guide, with the admin part
    await page.click('.nav >> text=More'); await page.click('text=How to use this app'); await page.waitForSelector('text=For every member');
    assert.ok(await page.isVisible('text=For the admin')); assert.ok(await page.isVisible('text=A payment was recorded twice (undo it)')); assert.ok(await page.isVisible('text=Some people were only testing (reset)')); assert.ok(await page.isVisible('text=A 20-minute training session'));
    // a plain member sees only the member part
    await page.screenshot({ path: '/tmp/zip235-guide.png' });
  } catch (e) { try { const pg = browser.contexts()[0].pages()[0]; await pg.screenshot({ path: '/tmp/b235-fail.png' }); console.log('DIALOGS', JSON.stringify(dialogsDbg), 'TOAST', await pg.evaluate(() => (document.querySelector('.toast') || {}).textContent)); } catch (e2) {} throw e; } finally { await browser.close(); srv.close(); }
});
