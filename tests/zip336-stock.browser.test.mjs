// zip 336, in a real (headless Chromium) browser with the server stubbed: Store <-> Inventory without duplicates in every module, packaging levels at
// the Sales Counter, FEFO batches at checkout (Pharmacy / Hospital), a cost correction through the manager pop-up, and the Sales Counter / tabs at
// desktop, tablet and phone sizes.
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
const MODULES = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];

async function openApp(browser, base, file, { inv = [], viewport = { width: 1280, height: 900 }, api = null } = {}) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 700, hasTouch: viewport.width < 700 });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/api/**', async (r) => { if (api) { const out = await api(r.request()); if (out) return r.fulfill({ status: out.status || 200, contentType: 'application/json', body: JSON.stringify(out.body) }); } return r.abort(); });
  await ctx.addInitScript(([h, invJson]) => {
    if (localStorage.getItem('seeded')) return; localStorage.setItem('seeded', '1');
    localStorage.setItem('pos_cash_config', JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }])); localStorage.setItem('pos_round_up', '0');
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'T'); localStorage.setItem('pos_inventory', invJson);
  }, [H, JSON.stringify(inv)]);
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
  await page.goto(base + '/' + file); await page.waitForTimeout(1500);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; window.__toasts = []; window.showToast = (m, bad) => { window.__toasts.push((bad ? '!' : '') + m); }; window.print = () => {}; });
  return { ctx, page, errs };
}

for (const file of MODULES) {
  test(`${file}: Test A - Store -> Inventory credits the SAME item (no duplicate), once; look-alikes wait for a person; Inventory -> Store goes to the chosen line, once`, { skip, timeout: 120000 }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const calls = [];
      let failNextDeposit = true;
      const storeItems = [{ id: 'st1', code: 'G-STORE', name: 'Hospital gloves', unit: 'bags', price: 100, qty: 10 }];
      const api = async (req) => {
        if (!/\/api\/store/.test(req.url())) return null;
        const b = JSON.parse(req.postData() || '{}'); calls.push(b);
        if (b.action === 'removeFromStore') return { body: { items: storeItems, withdrawn: [{ movementId: 'x-1', storeItemId: 'st1', code: 'G-STORE', name: 'Hospital gloves', unit: 'bags', price: 100, wholesalePrice: 60, qty: 5, status: 'IN_TRANSIT' }] } };
        if (b.action === 'receive') return { body: { ok: true, received: b.movementIds } };
        if (b.action === 'get') return { body: { items: storeItems } };
        if (b.action === 'linkCode') return { body: { ok: true, linked: false } };
        if (b.action === 'depositFromBranch') { if (failNextDeposit) { failNextDeposit = false; return { status: 503, body: { error: 'The store could not take that right now - nothing was moved. Try again.' } }; } return { body: { moved: true, items: storeItems.map((x) => ({ ...x, qty: x.qty + 3 })) } }; }
        return { body: {} };
      };
      const inv = [
        { code: '00012', type: 'item', name: 'Hospital gloves', price: 100, wholesalePrice: 60, qty: 10, unit: 'bags', vatCategory: 'A' },
        { code: 'S1', type: 'item', name: 'Syringe', price: 10, wholesalePrice: 5, qty: 4, unit: 'pcs', vatCategory: 'A' },
        { code: 'S2', type: 'item', name: 'Syringe', price: 10, wholesalePrice: 5, qty: 6, unit: 'pcs', vatCategory: 'A' },
      ];
      const { ctx, page, errs } = await openApp(browser, base, file, { inv, api });
      // Store -> Inventory: 5 bags from the Store line that has its OWN code (G-STORE)
      await page.evaluate(async () => { const i = document.createElement('input'); i.id = 'store-take-qty-st1'; i.value = '5'; document.body.appendChild(i); await takeFromStore('st1'); });
      let st = await page.evaluate(() => inventory.filter((p) => /gloves/i.test(p.name)).map((p) => [p.code, p.qty]));
      assert.deepEqual(st, [['00012', 15]], 'Store 10 -> Inventory 10 + 5 = 15 on the SAME item, no second "Hospital gloves"');
      assert.ok(calls.some((c) => c.action === 'receive' && c.movementIds.includes('x-1')), 'confirmed as received');
      // the same transfer again (a retry / the reconcile poll) is not added twice
      await page.evaluate(() => { storeApplyWithdrawn({ movementId: 'x-1', storeItemId: 'st1', code: 'G-STORE', name: 'Hospital gloves', unit: 'bags', qty: 5 }); });
      assert.equal(await page.evaluate(() => inventory.find((p) => p.code === '00012').qty), 15);
      assert.equal(await page.evaluate(() => stockMovementLog.filter((m) => m.code === '00012' && /Transfer from Store/.test(m.reason)).length), 1, 'one stock movement');
      // two look-alike "Syringe" items: held, NOT confirmed, nothing added, until a person picks
      const held = await page.evaluate(() => { const ok = storeApplyWithdrawn({ movementId: 'x-2', storeItemId: 'st2', code: null, name: 'Syringe', unit: 'pcs', qty: 3 }); storeConfirmReceived([{ movementId: 'x-2' }]); return [ok, inventory.filter((p) => p.name === 'Syringe').map((p) => p.qty), JSON.parse(localStorage.getItem('se_store_held') || '[]').length]; });
      assert.deepEqual(held, [false, [4, 6], 1]);
      assert.ok(!calls.some((c) => c.action === 'receive' && c.movementIds.includes('x-2')), 'a held transfer is not confirmed');
      await page.evaluate(() => spxOpenHeldTransfers());
      await page.selectOption('#spx-hold-x-2', 'S2');
      await page.click('#spx-ov [data-spx="resolve"]');
      assert.deepEqual(await page.evaluate(() => inventory.filter((p) => p.name === 'Syringe').map((p) => p.qty)), [4, 9]);
      assert.ok(calls.some((c) => c.action === 'receive' && c.movementIds.includes('x-2')), 'confirmed once applied');
      // Inventory -> Store: 3 bags back; the first answer fails (nothing moves), the retry with the SAME key moves it once
      await page.evaluate(() => openMoveStock('00012'));
      await page.waitForSelector('#spx-mv-line option[value="st1"]', { state: 'attached', timeout: 5000 });
      assert.equal(await page.inputValue('#spx-mv-line'), 'st1', 'the store line it came from is chosen');
      await page.fill('#spx-mv-qty', '3');
      await page.click('#spx-mv-go'); await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => inventory.find((p) => p.code === '00012').qty), 15, 'a failed move changes nothing');
      assert.match(await page.textContent('#spx-mv-err'), /nothing was moved/);
      await page.click('#spx-mv-go'); await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => inventory.find((p) => p.code === '00012').qty), 12, 'Inventory 15 - 3 = 12');
      const deps = calls.filter((c) => c.action === 'depositFromBranch');
      assert.equal(deps.length, 2); assert.equal(deps[0].idemKey, deps[1].idemKey, 'the retry carries the same key (the server applies it once)');
      assert.deepEqual([deps[1].items[0].code, deps[1].items[0].storeItemId, deps[1].items[0].qty], ['00012', 'st1', 3]);
      assert.equal(await page.evaluate(() => inventory.filter((p) => /gloves/i.test(p.name)).length), 1, 'still one gloves item');
      assert.deepEqual(errs, []);
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}

for (const file of ['index.html', 'hospital/index.html', 'pharmacy/index.html', 'hotel/index.html']) {
  test(`${file}: Test D - carton 10 packets, packet 20; 2 cartons = 400; sell 3 packets + 7 = 333 (chooser, checkout, the sale keeps the package size)`, { skip, timeout: 120000 }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const inv = [{ code: 'SW', type: 'item', name: 'Sweets', price: 10, wholesalePrice: 6, qty: 0, unit: 'mini-packet', vatCategory: 'A' }];
      const { ctx, page, errs } = await openApp(browser, base, file, { inv });
      const ids = await page.evaluate(() => { const p = inventory[0]; const b = SE.buildLevels([{ name: 'Carton', parent: 'Packet', count: 10 }, { name: 'Packet', parent: 'base', count: 20, price: 180, barcode: '600123' }], p.unit, []); p.packs = b.packs; p.qty = SE.toBase(p, 2, b.packs[0].id); return b.packs.map((l) => l.id); });
      assert.equal(await page.evaluate(() => inventory[0].qty), 400);
      await page.evaluate(() => { try { performTabSwitch(null, 'sales-tab'); } catch (e) { /* default tab */ } });
      for (let i = 0; i < 2; i++) { await page.evaluate(() => addToCart('SW')); await page.waitForSelector('#spx-ov.on [data-spx="lvl"]'); await page.click(`#spx-ov [data-spx="lvl"][data-id="${ids[1]}"]`); }
      await page.evaluate(() => handleBarcodeScan('600123'));                 // the packet barcode adds a packet without the chooser
      await page.evaluate(() => addToCart('SW')); await page.waitForSelector('#spx-ov.on [data-spx="base"]'); await page.click('#spx-ov [data-spx="base"]');
      await page.evaluate((id) => { const k = Object.keys(currentCart).find((x) => !/::pack::/.test(x)); currentCart[k].qty = 7; renderCart(); void id; }, ids[1]);
      const cart = await page.evaluate(() => Object.values(currentCart).map((l) => [l.qty, l.saleMode || null, l.price]).sort());
      assert.deepEqual(cart.map((c) => c[0]).sort(), [3, 7]);
      assert.ok(cart.some((c) => c[0] === 3 && /^pack:/.test(c[1]) && c[2] === 180), 'a line of 3 packets at the packet price');
      await page.evaluate(async () => { currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '5000'; await checkoutCart(); });
      assert.equal(await page.evaluate(() => inventory[0].qty), 333, '400 - 60 - 7');
      assert.equal(await page.evaluate(() => SE.label(inventory[0], inventory[0].qty)), '1 Carton + 6 Packet + 13 mini-packet');
      const line = await page.evaluate(() => salesLog[salesLog.length - 1].items.find((l) => /^pack:/.test(l.saleMode || '')));
      assert.equal(line.packPer, 20, 'the sale keeps how many a packet held');
      assert.equal(line.qty, 3);
      // a void of that line gives back 60, not 3
      await page.evaluate((m) => restoreStockForSaleUnit(inventory[0], 3, m), line.saleMode);
      assert.equal(await page.evaluate(() => inventory[0].qty), 393);
      // the package breakdown shows in Inventory and Stock Take; Stock Take can count by package
      await page.evaluate(() => { try { closeReceipt(); } catch (e) { const m = document.getElementById('receipt-modal'); if (m) m.style.display = 'none'; } });
      await page.evaluate(() => { inventory[0].qty = 333; try { renderAllViews(); } catch (e) { /* views */ } performTabSwitch(null, 'inventory-list-tab'); });
      await page.waitForFunction(() => Array.from(document.querySelectorAll('#inventory-list-tab .spx-packlbl')).some((x) => /1 Carton \+ 6 Packet \+ 13 mini-packet/.test(x.textContent)), null, { timeout: 8000 });
      // (straight to the tab: this test shop has a password, and the app may ask for it before Stock Take)
      await page.evaluate(() => { document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active')); const t = document.getElementById('stock-take-tab'); t.classList.add('active'); t.style.display = ''; try { renderStockTake(); } catch (e) { /* drawn by its own block */ } });
      await page.waitForSelector('#stock-take-tab .spx-packlbl button', { timeout: 8000 });
      await page.click('#stock-take-tab .spx-packlbl button');
      await page.fill(`#spx-cp-${ids[0]}`, '1'); await page.fill(`#spx-cp-${ids[1]}`, '6'); await page.fill('#spx-cp-base', '10');
      await page.click('#spx-ov [data-spx="go"]');
      assert.equal(await page.evaluate(() => { const b = document.querySelector('#stock-take-tab .spx-packlbl'); const row = b.closest('tr') || b.parentNode.parentNode; return row.querySelector('input.st-input, input[type="number"]').value; }), '330', '1 carton + 6 packets + 10 loose = 330');
      await page.evaluate(() => performTabSwitch(null, 'sales-tab'));
      // the cart cannot take more packets than there are units
      await page.evaluate(() => { currentCart = {}; inventory[0].qty = 25; });
      await page.evaluate(() => handleBarcodeScan('600123')); await page.evaluate(() => handleBarcodeScan('600123'));
      assert.equal(await page.evaluate(() => Object.values(currentCart).reduce((t, l) => t + l.qty, 0)), 1, 'only one packet of 20 fits in 25');
      assert.deepEqual(errs, []);
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}

for (const file of ['pharmacy/index.html', 'hospital/index.html']) {
  test(`${file}: Test C - FEFO at checkout: earliest usable batch first, expired / quarantined never; the sale line carries its batches and their cost; a void goes back into them`, { skip, timeout: 120000 }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const B = (id, exp, qty, cost, status, at) => ({ id, batchNumber: id, batchNo: id, expiryDate: exp, qty, cost, status: status || 'ok', receivedAt: at });
      const inv = [{ code: 'AMX', type: 'item', name: 'Amoxicillin 250mg caps', price: 20, wholesalePrice: 99, unit: 'caps', vatCategory: 'A', qty: 75,
        batches: [B('OLD-EXPIRED', '2025-12-31', 40, 1, 'ok', 1), B('QUAR', '2026-12-01', 10, 2, 'quarantine', 2), B('EARLY', '2027-01-31', 5, 4, 'ok', 3), B('LATE', '2027-08-31', 20, 6, 'ok', 4)] }];
      const { ctx, page, errs } = await openApp(browser, base, file, { inv });
      assert.equal(await page.evaluate(() => getAvailableStock(inventory[0])), 25, 'only usable batches can be sold');
      // more than the usable stock: refused at checkout, nothing taken
      await page.evaluate(() => { currentCart = { AMX: { code: 'AMX', cartKey: 'AMX', name: 'Amoxicillin 250mg caps', price: 20, wholesalePrice: 99, unit: 'caps', isService: false, vatCategory: 'A', qty: 30 } }; });
      await page.evaluate(async () => { currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '5000'; await checkoutCart(); });
      assert.equal(await page.evaluate(() => inventory[0].qty), 75);
      assert.ok((await page.evaluate(() => window.__toasts.join(' | '))).match(/only 25 can be sold.*expired, quarantined or recalled/), await page.evaluate(() => window.__toasts.join(' | ')));
      // 6: 5 from EARLY (cost 4) + 1 from LATE (cost 6)
      await page.evaluate(() => { currentCart = {}; for (let i = 0; i < 6; i++) addToCart('AMX'); });
      assert.equal(await page.evaluate(() => Object.values(currentCart)[0].qty), 6);
      await page.evaluate(async () => { currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '5000'; await checkoutCart(); });
      const after = await page.evaluate(() => Object.fromEntries(inventory[0].batches.map((b) => [b.id, b.qty])));
      assert.deepEqual(after, { 'OLD-EXPIRED': 40, QUAR: 10, LATE: 19 }, 'EARLY used up, LATE -1, expired and quarantined untouched');
      const line = await page.evaluate(() => salesLog[salesLog.length - 1].items[0]);
      assert.deepEqual(line.lots.map((l) => [l.id, l.q, l.c]), [['EARLY', 5, 4], ['LATE', 1, 6]]);
      assert.equal(Math.round(line.wholesalePrice * line.qty * 100) / 100, 26, 'COGS = 5 x 4 + 1 x 6 (not 6 x 99, the current cost price)');
      // void: back into EARLY and LATE (EARLY recreated with its expiry and cost)
      await page.evaluate((l) => restoreStockForSaleUnit(inventory[0], l.qty, l.saleMode, l), line);
      const back = await page.evaluate(() => inventory[0].batches.filter((b) => b.id === 'EARLY' || b.id === 'LATE').map((b) => [b.id, b.qty, b.cost, b.expiryDate]).sort());
      assert.deepEqual(back, [['EARLY', 5, 4, '2027-01-31'], ['LATE', 20, 6, '2027-08-31']]);
      assert.equal(await page.evaluate(() => inventory[0].qty), 75);
      // all usable stock gone -> the item cannot even be added
      await page.evaluate(() => { inventory[0].batches = inventory[0].batches.filter((b) => b.id === 'OLD-EXPIRED'); inventory[0].qty = 40; currentCart = {}; addToCart('AMX'); });
      assert.equal(await page.evaluate(() => Object.keys(currentCart).length), 0);
      assert.match(await page.evaluate(() => window.__toasts[window.__toasts.length - 1]), /cannot be sold.*expir/);
      assert.deepEqual(errs, []);
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}

test('hospital: Test E (UI) - a manager corrects a wrong cost, restating past sales; the profit report changes, the sales do not', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const sent = [];
    const corrections = [];
    const api = async (req) => {
      if (!/\/api\/cost-control/.test(req.url())) return null;
      const b = JSON.parse(req.postData() || '{}');
      sent.push({ b, proof: req.headers()['x-pay-proof'] || null });
      if (b.action === 'list') return { body: { ok: true, corrections, adjustments: [], audit: [], settings: {} } };
      if (b.action === 'correct') { const row = { corr_id: b.corrId, code: b.code, lot_id: b.lotId || null, mode: b.mode, old_cost: b.oldCost, new_cost: b.newCost, date_from: b.from, date_to: b.to, reason: b.reason, actor: 'Admin', actor_kind: 'admin', at: Date.now() }; corrections.push(row); return { body: { ok: true, correction: row, who: { kind: 'admin', name: 'Admin' } } }; }
      return { body: { ok: true } };
    };
    const inv = [{ code: 'GL', type: 'item', name: 'Gloves', price: 50, wholesalePrice: 2000, qty: 30, unit: 'pcs', vatCategory: 'A' }];
    const { ctx, page, errs } = await openApp(browser, base, 'hospital/index.html', { inv, api });
    await page.evaluate(async () => { for (let i = 0; i < 2; i++) addToCart('GL'); currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '1000'; await checkoutCart(); });
    await page.evaluate(() => { try { performTabSwitch(null, 'profits-tab'); } catch (e) { /* tab */ } renderProfitReport(); });
    const before = await page.evaluate(() => document.getElementById('profit-cost-total').textContent);
    assert.match(before, /4,?000/);
    await page.evaluate(() => spxCorrectCost('GL'));
    await page.fill('#spx-cc-new', '10');
    await page.check('[name="spx-cc-mode"][value="restate"]');
    await page.fill('#spx-cc-from', new Date(Date.now() - 86400000).toISOString().slice(0, 10));
    await page.fill('#spx-cc-why', 'carton cost (2,000) typed as the cost of each glove');
    await page.waitForFunction(() => /COGS|cost of goods sold/i.test(document.getElementById('spx-cc-prev').textContent));
    assert.match(await page.textContent('#spx-cc-prev'), /2 ?\/? ?|line/);
    await page.click('#spx-cc-go');
    await page.waitForSelector('#pay-confirm-pw');
    await page.fill('#pay-confirm-pw', 'pw'); await page.click('#pay-confirm-ok');
    await page.waitForFunction(() => !document.getElementById('spx-ov').classList.contains('on'), null, { timeout: 8000 });
    const c = sent.find((x) => x.b.action === 'correct');
    assert.ok(c && c.proof, 'sent WITH the server-checked proof');
    assert.deepEqual([c.b.code, c.b.oldCost, c.b.newCost, c.b.mode], ['GL', 2000, 10, 'restate']);
    await page.evaluate(() => renderProfitReport());
    assert.match(await page.evaluate(() => document.getElementById('profit-cost-total').textContent), /KES 20\.00/);
    assert.equal(await page.evaluate(() => salesLog[salesLog.length - 1].items[0].wholesalePrice), 2000, 'the sale record itself is unchanged');
    assert.equal(await page.evaluate(() => inventory[0].wholesalePrice), 10, 'the cost price from now on');
    assert.match(await page.evaluate(() => document.getElementById('spx-profit-tools').textContent), /corrected cost/);
    assert.deepEqual(errs, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('Test G - Sales Counter and the busiest tabs fit desktop, tablet and phone: no sideways scroll, search and COMPLETE SALE reachable, nothing covers the cart', { skip, timeout: 240000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const inv = Array.from({ length: 24 }, (_, i) => ({ code: 'T' + i, type: 'item', name: ['Paracetamol 500mg tabs', 'Amoxicillin 250mg caps', 'Hospital gloves (box)', 'Syringe 5ml'][i % 4] + ' #' + i, price: 50 + i, wholesalePrice: 30, qty: 10 + i, unit: 'pcs', vatCategory: 'A' }));
    for (const [w, h] of [[1440, 900], [820, 1180], [390, 844]]) {
      for (const file of ['hospital/index.html', 'pharmacy/index.html', 'index.html']) {
        const { ctx, page, errs } = await openApp(browser, base, file, { inv, viewport: { width: w, height: h } });
        await page.evaluate(() => { try { performTabSwitch(null, 'sales-tab'); } catch (e) { /* default */ } addToCart('T1'); addToCart('T2'); addToCart('T3'); });
        await page.waitForTimeout(1200);
        const m = await page.evaluate(() => {
          const r = (el) => el ? el.getBoundingClientRect() : null, vis = (b) => !!b && b.width > 0 && b.height > 0;
          const search = r(document.getElementById('sales-search')), btn = r(document.getElementById('main-checkout-btn'));
          const rows = Array.from(document.querySelectorAll('#cart-table tbody tr')).map(r), bar = r(document.getElementById('cart-sticky-bar'));
          const covered = bar && getComputedStyle(document.getElementById('cart-sticky-bar')).position !== 'sticky' ? rows.filter((x) => x.bottom > bar.top + 2 && x.top < bar.bottom - 2).length : 0;
          return { sw: document.documentElement.scrollWidth, vw: window.innerWidth, vh: window.innerHeight, search, btn, searchVis: vis(search), covered };
        });
        assert.ok(m.sw <= m.vw + 1, `${file} @${w}: no sideways scroll (${m.sw} > ${m.vw})`);
        assert.ok(m.searchVis && m.search.top >= 0 && m.search.top < m.vh, `${file} @${w}: the search box is on screen`);
        if (w >= 760 && file === 'hospital/index.html') {
          assert.ok(m.btn && m.btn.bottom <= m.vh + 1 && m.btn.top >= 0, `hospital @${w}: COMPLETE SALE is on screen without scrolling (${JSON.stringify(m.btn)})`);
          assert.equal(m.covered, 0, `hospital @${w}: the totals never cover a cart line`);
        }
        for (const tab of ['inventory-list-tab', 'restock-tab', 'profits-tab', 'store-tab', 'stock-take-tab']) {
          const sw = await page.evaluate(async (t) => { try { performTabSwitch(null, t); } catch (e) { return 0; } await new Promise((r) => setTimeout(r, 200)); return document.documentElement.scrollWidth - window.innerWidth; }, tab);
          assert.ok(sw <= 1, `${file} ${tab} @${w}: no sideways scroll (${sw}px)`);
        }
        assert.deepEqual(errs, [], `${file} @${w}`);
        await ctx.close();
      }
    }
  } finally { await browser.close(); srv.close(); }
});

test('hospital: the HMIS counter keeps search first, patient billing in one strip, compact tiles and the dose folded; COMPLETE SALE shows it is busy', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const inv = [{ code: 'P', type: 'item', name: 'Paracetamol', price: 10, wholesalePrice: 5, qty: 50, unit: 'tabs', vatCategory: 'A' }];
    const { ctx, page, errs } = await openApp(browser, base, 'hospital/index.html', { inv, viewport: { width: 1280, height: 860 } });
    await page.evaluate(() => { try { performTabSwitch(null, 'sales-tab'); } catch (e) { /* default */ } addToCart('P'); });
    await page.waitForTimeout(1500);
    const o = await page.evaluate(() => {
      const prod = document.querySelector('#sales-tab .pos-products');
      const top = (el) => el.getBoundingClientRect().top;
      return { on: document.getElementById('sales-tab').classList.contains('hc-on'), searchFirst: top(document.querySelector('#sales-tab .search-container')) < top(document.getElementById('hc-strip')),
        billInStrip: document.getElementById('patient-bill-panel').parentNode.id, compact: !!document.querySelector('#item-image-grid .item-grid-cell.hc-noimg'), dose: !!document.querySelector('#cart-table details.hc-dose'), inProd: !!prod.querySelector('#hc-strip') };
    });
    assert.deepEqual(o, { on: true, searchFirst: true, billInStrip: 'hc-strip', compact: true, dose: true, inProd: true });
    // COMPLETE SALE is visibly busy while a sale is saved, and comes back afterwards
    const busy = await page.evaluate(async () => { const b = document.getElementById('main-checkout-btn'); currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '100'; b.click(); const during = b.hasAttribute('data-lf-busy') && /Completing/.test(b.textContent); await new Promise((r) => setTimeout(r, 1500)); return [during, b.hasAttribute('data-lf-busy'), salesLog.length]; });
    assert.deepEqual(busy, [true, false, 1]);
    assert.deepEqual(errs, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
