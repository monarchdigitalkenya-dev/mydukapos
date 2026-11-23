// zip 338: a variant sent back from the Store ("Grey fleece (30)", code PARENT::<id>) adds to the SAME variant every time, never creates a stray item,
// and an old stray item can be merged into its variant.
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

test('index.html: variant coming back from the Store adds to the existing variant, repeatedly, no stray item', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const inv = [
      { code: 'GREYFLEECE', type: 'item', name: 'Grey fleece', price: 100, qty: 8, unit: 'pcs', hasVariants: true, variants: [
        { id: 'v-28', code: 'GREYFLEECE-28', name: '28', qty: 3, price: 100 }, { id: 'v-30', code: 'GREYFLEECE-30', name: '30', qty: 5, price: 100 } ] },
    ];
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await ctx.route('**/api/**', (r) => r.abort());
    await ctx.addInitScript(([h, invJson]) => {
      if (localStorage.getItem('seeded')) return; localStorage.setItem('seeded', '1');
      localStorage.setItem('pos_cash_config', JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }])); localStorage.setItem('pos_round_up', '0');
      localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'T'); localStorage.setItem('pos_inventory', invJson);
    }, [H, JSON.stringify(inv)]);
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
    await page.goto(base + '/index.html'); await page.waitForTimeout(1500);
    await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; window.showToast = () => {}; });
    // two returns, each with a DIFFERENT (unknown) variant id in the code -> must land on variant "30" both times
    for (const [i, q] of [[1, 2], [2, 2]]) {
      await page.evaluate(([i, q]) => { storeApplyWithdrawn({ movementId: 'm-' + i, storeItemId: 's1', code: 'GREYFLEECE::unknown-' + i, name: 'Grey fleece (30)', unit: 'pcs', qty: q }); }, [i, q]);
    }
    const st = await page.evaluate(() => ({ n: inventory.length, v: inventory[0].variants.map((v) => [v.name, v.qty]), stray: inventory.filter((p) => /::/.test(p.code)).length }));
    assert.equal(st.n, 1, 'no new item');
    assert.equal(st.stray, 0);
    assert.deepEqual(st.v, [['28', 3], ['30', 9]], '5 + 2 + 2, once each');
    // the same movement again is not added twice
    await page.evaluate(() => { storeApplyWithdrawn({ movementId: 'm-1', storeItemId: 's1', code: 'GREYFLEECE::unknown-1', name: 'Grey fleece (30)', unit: 'pcs', qty: 2 }); });
    assert.equal(await page.evaluate(() => inventory[0].variants[1].qty), 9);
    // a variant that has its OWN code, returned twice: both land on the variant, never on the parent (the remembered link must not point at an item with sizes)
    for (const i of [1, 2]) await page.evaluate((i) => { storeApplyWithdrawn({ movementId: 'c-' + i, storeItemId: 'sc1', code: 'GREYFLEECE-28', name: 'Grey fleece (28)', unit: 'pcs', qty: 1 }); }, i);
    assert.deepEqual(await page.evaluate(() => inventory[0].variants.map((v) => [v.name, v.qty])), [['28', 5], ['30', 9]]);
    assert.equal(await page.evaluate(() => inventory.length), 1);
    // an old stray item is found and merged
    await page.evaluate(() => { inventory.push({ code: 'GREYFLEECE::old', type: 'item', name: 'Grey fleece (28)', price: 100, qty: 4, unit: 'pcs' }); });
    const found = await page.evaluate(() => SE.strayVariants(inventory).map((x) => [x.stray.code, x.variant.name]));
    assert.deepEqual(found, [['GREYFLEECE::old', '28']]);
    await page.evaluate(() => { window.confirm = () => true; spxStoreCheck(); });
    await page.click('[data-spx="stray"]');
    const after = await page.evaluate(() => ({ v: inventory[0].variants.map((v) => [v.name, v.qty]), stray: inventory.find((p) => p.code === 'GREYFLEECE::old') }));
    assert.deepEqual(after.v, [['28', 9], ['30', 9]]);
    assert.equal(after.stray.archived, true); assert.equal(after.stray.qty, 0);
    assert.deepEqual(errs, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
