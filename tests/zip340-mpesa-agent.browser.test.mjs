// zip 340: Inventory: match extra "Item (Size)" items to the real size - same variant, no new code.
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
const serve = () => new Promise((r) => { const s = http.createServer((q, res) => { const p = path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); }); s.listen(0, '127.0.0.1', () => r(s)); });
const H = crypto.createHash('sha256').update('pw').digest('hex');

async function open(browser, base, file, seed, vp = { width: 1366, height: 768 }) {
  const ctx = await browser.newContext({ viewport: vp });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([h, invJson]) => {
    if (localStorage.getItem('seeded')) return; localStorage.setItem('seeded', '1');
    localStorage.setItem('pos_cash_config', JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }])); localStorage.setItem('pos_round_up', '0');
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'T'); const s = JSON.parse(invJson); for (const k of Object.keys(s)) localStorage.setItem(k, typeof s[k] === 'string' ? s[k] : JSON.stringify(s[k]));
  }, [H, JSON.stringify(seed)]);
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
  await page.goto(base + '/' + file); await page.waitForTimeout(1500);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; window.showToast = () => {}; });
  return { ctx, page, errs };
}



test('M-PESA Agent: ledger rules', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const b = await chromium.launch();
  try {
    const { page, errs } = await open(b, base, 'index.html', {});
    await page.waitForTimeout(1500);
    const r = await page.evaluate(async () => {
      const o = {}; const M = window.MPA; o.has = !!M && !!document.getElementById('mpesa-agent-tab') && !!document.getElementById('mpesa-agent-tab-btn');
      o.inLockable = LOCKABLE_TABS.some(t => t.id === 'mpesa-agent-tab');
      
      mpesaAgentCfg.push({ id: 'cfg', openCash: 10000, openFloat: 50000, setup: true, tariff: { deposit: [{ upTo: 1000, fee: 10 }, { upTo: null, fee: 20 }], withdrawal: [] }, grants: {}, updatedAt: 1 });
      o.b0 = M.balances();
      o.dep = M.post({ type: 'deposit', amount: '1,500', opId: 'a1' }); o.fee = o.dep.entry && o.dep.entry.fee;
      o.dup = M.post({ type: 'deposit', amount: '1500', opId: 'a1' }).duplicate; // idempotent
      o.b1 = M.balances();
      o.wd = M.post({ type: 'withdrawal', amount: '2000', opId: 'a2' }); o.b2 = M.balances();
      o.dec = M.post({ type: 'deposit', amount: '10.5', opId: 'a3' }).err; o.neg = M.post({ type: 'deposit', amount: '-5', opId: 'a4' }).err; o.zero = M.post({ type: 'deposit', amount: '0', opId: 'a5' }).err;
      o.over = M.post({ type: 'withdrawal', amount: '200000', opId: 'a6' }); // float 50000-... -> cash short
      o.buy = M.post({ type: 'buy_float', amount: '5000', src: 'bank', opId: 'a7' }); o.b3 = M.balances();
      o.rev = M.reverse('mpa-a1', 'wrong number'); o.b4 = M.balances(); o.rev2 = M.reverse('mpa-a1', 'again').err;
      o.revrev = M.reverse('mpa-rev-mpa-a1', 'x').err;
      o.flags = M.review(); o.entries = mpesaAgentTx.length;
      return o;
    });
    assert.ok(r.has && r.inLockable);
    assert.deepEqual(r.b0, { cash: 10000, float: 50000 });
    assert.equal(r.fee, 20); assert.ok(r.dup);
    assert.deepEqual(r.b1, { cash: 11500, float: 48500 });
    assert.deepEqual(r.b2, { cash: 9500, float: 50500 });
    assert.ok(r.dec && r.neg && r.zero);
    assert.ok(r.over.err && r.over.needOverride, 'large withdrawal blocked: cash short');
    assert.deepEqual(r.b3, { cash: 9500, float: 55500 });
    assert.ok(r.rev.ok); assert.deepEqual(r.b4, { cash: 8000, float: 57000 });
    assert.ok(r.rev2 && r.revrev);
    assert.deepEqual(r.flags, {});
    assert.deepEqual(errs, []);
  } finally { await b.close(); srv.close(); }
});

test('M-PESA Agent: UI posts, closes the day and respects permissions', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const b = await chromium.launch();
  try {
    const { page, errs } = await open(b, base, 'index.html', { pos_mpesa_agent_cfg: [{ id: 'cfg', openCash: 5000, openFloat: 20000, setup: true, lowCash: 1000, lowFloat: 1000, updatedAt: 1 }] });
    await page.evaluate(() => { window.confirm = () => false; guardedSwitchTab({ preventDefault() {}, currentTarget: null, target: null }, 'mpesa-agent-tab'); });
    await page.waitForTimeout(1200);
    await page.click('[data-mpa="goto"][data-t="deposit"]');
    await page.fill('#mpa-amt', '3000'); await page.click('#mpa-post'); await page.waitForTimeout(200);
    await page.click('[data-mpa="goto"][data-t="withdrawal"]');
    await page.fill('#mpa-amt', '1000'); await page.click('#mpa-post'); await page.waitForTimeout(200);
    const bal = await page.evaluate(() => MPA.balances()); assert.deepEqual(bal, { cash: 7000, float: 18000 });
    await page.click('[data-mpa="goto"][data-t="recon"]');
    await page.fill('#mpa-cc', '6900'); await page.fill('#mpa-cf', '18000');
    assert.match(await page.textContent('#mpa-var'), /-100/);
    await page.click('#mpa-close'); await page.waitForTimeout(200);
    const cl = await page.evaluate(() => mpesaAgentClosings.map(c => [c.varCash, c.varFloat, c.approval.status]));
    assert.equal(cl.length, 1); assert.equal(cl[0][0], -100);
    // permissions: a non-manager staff member cannot reverse or save settings
    const p = await page.evaluate(() => { isAdminServing = () => false; staff.push({ id: 's1', name: 'Kim', roles: ['mpesa-agent-tab'] }); currentServer = { id: 's1', name: 'Kim' }; return { rev: MPA.reverse(mpesaAgentTx[0].id, 'x').err, adj: MPA.adjust({ cash: '5', reason: 'r', opId: 'z' }).err }; });
    assert.ok(p.rev && p.adj);
    const ov = await page.evaluate(() => MPA.post({ type: 'deposit', amount: '90000', opId: 'big', override: true, overrideReason: 'x' }).err);
    assert.match(ov, /not allowed|Not enough/);
    const ov2 = await page.evaluate(() => { const L = mpesaAgentCfg; L[0].grants = { s1: ['reverse'] }; return MPA.reverse(mpesaAgentTx[0].id, 'granted').err || 'ok'; });
    assert.equal(ov2, 'ok');
    assert.deepEqual(errs, []);
  } finally { await b.close(); srv.close(); }
});
