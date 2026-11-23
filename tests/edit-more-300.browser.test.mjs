import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// Zip 300: change an item after it was added - category, box & piece, serial numbers, variants, and rename an item that already has variants.
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/json' };
function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const INV = [
  { code: 'A1', type: 'item', name: 'Pancakes', price: 200, qty: 10, unit: 'pcs', vatCategory: 'A', category: 'Breakfast', wholesalePrice: 100, updatedAt: 1 },
  { code: 'V1', type: 'item', name: 'Tshirt', price: 500, qty: 7, unit: 'pcs', vatCategory: 'A', hasVariants: true, variants: [
    { id: 'v-a', name: 'Small', code: 'V1-S', price: 500, qty: 3, wholesalePrice: 200 }, { id: 'v-b', name: 'Large', code: 'V1-L', price: 550, qty: 4, wholesalePrice: 220 }], updatedAt: 1 },
];
async function open(browser, base, app) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript((inv) => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('pos_inventory', JSON.stringify(inv)); }, INV);
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/' + app); await page.waitForTimeout(1600);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const l = document.getElementById(id); if (l) l.style.display = 'none'; } const s = document.getElementById('boot-splash'); if (s) s.remove(); window.showToast = () => {}; window.confirm = () => true; });
  return { ctx, page, errors };
}
const inv = (page, code) => page.evaluate((c) => JSON.parse(JSON.stringify(inventory.find((p) => p.code === c))), code);

for (const app of ['index.html', 'pharmacy/index.html']) {
  test(`${app}: Item setup - category, box & piece, serial numbers, variants`, { skip }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const { ctx, page, errors } = await open(browser, base, app);
      await page.evaluate(() => openInventoryEditModal('A1')); await page.waitForTimeout(300);
      assert.ok(await page.locator('#em-panel').isVisible(), 'the Item setup panel shows');
      // category
      await page.fill('#em-cat', 'Lunch'); await page.locator('#em-cat').dispatchEvent('change'); await page.waitForTimeout(150);
      assert.equal((await inv(page, 'A1')).category, 'Lunch');
      // box & piece
      await page.check('#em-dual'); await page.fill('#em-upb', '12'); await page.click('#em-dual-go'); await page.waitForTimeout(200);
      let a = await inv(page, 'A1'); assert.equal(a.dualUnit, true); assert.equal(a.unitsPerBox, 12); assert.equal(a.piecePrice, 16.67);
      // un-tick with no loose pieces
      await page.uncheck('#em-dual'); await page.waitForTimeout(150); assert.equal((await inv(page, 'A1')).dualUnit, false);
      // serial numbers
      if (await page.evaluate(() => typeof serialIsTracked === 'function')) {
        await page.check('#em-ser'); await page.waitForTimeout(150);
        a = await inv(page, 'A1'); assert.equal(a.serialized, true); assert.equal(a.serialUnregistered, 10);
        await page.uncheck('#em-ser'); await page.waitForTimeout(150); assert.equal((await inv(page, 'A1')).serialized, false);
      } else assert.equal(await page.locator('#em-ser').count(), 0, 'no serial option in an app without serial tracking');
      // variants: stock moves to the first variant
      await page.fill('#em-vn', 'Small, Large'); await page.fill('#em-first', 'Regular'); await page.click('#em-vgo'); await page.waitForTimeout(200);
      a = await inv(page, 'A1'); assert.equal(a.hasVariants, true); assert.deepEqual(a.variants.map((v) => [v.name, v.qty]), [['Regular', 10], ['Small', 0], ['Large', 0]]); assert.equal(a.qty, 10);
      assert.equal(new Set(a.variants.map((v) => v.code)).size, 3, 'codes are unique');
      assert.deepEqual(errors, []); await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
  test(`${app}: an item that has variants can be renamed as a whole`, { skip }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const { ctx, page, errors } = await open(browser, base, app);
      await page.evaluate(() => openInventoryEditModal('V1', 'v-a')); await page.waitForTimeout(300);
      assert.ok(await page.locator('#inv-edit-parentname-input').isVisible(), 'the whole-item name box shows when a variant is opened');
      assert.equal(await page.inputValue('#inv-edit-parentname-input'), 'Tshirt');
      await page.fill('#inv-edit-parentname-input', 'Polo shirt'); await page.locator('#inv-edit-parentname-input').dispatchEvent('change'); await page.waitForTimeout(250);
      const v = await inv(page, 'V1'); assert.equal(v.name, 'Polo shirt'); assert.deepEqual(v.variants.map((x) => x.name), ['Small', 'Large'], 'variant names are untouched');
      assert.deepEqual(errors, []); await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}

for (const app of ['index.html', 'hotel/index.html', 'water/index.html']) {
  test(`${app}: a staff member can be renamed and keeps the same id`, { skip }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const { ctx, page, errors } = await open(browser, base, app);
      await page.evaluate(() => { staff.push({ id: 'st-1', name: 'Jon', roles: ['sales-tab'], pinHash: 'x' }, { id: 'st-2', name: 'Mary', roles: [] }); renderStaffList(); });
      assert.equal(await page.locator('#staff-list .sr-btn').count(), 2, 'one Rename button per staff member');
      await page.evaluate(() => document.querySelectorAll('#staff-list .sr-btn')[0].click()); await page.waitForTimeout(150);
      assert.equal(await page.inputValue('#sr-name'), 'Jon');
      await page.fill('#sr-name', 'Mary'); await page.click('#sr-go');
      assert.match(await page.textContent('#sr-err'), /already has this name/);
      await page.fill('#sr-name', 'Jonathan'); await page.click('#sr-go'); await page.waitForTimeout(150);
      const s = await page.evaluate(() => staff.find((x) => x.id === 'st-1'));
      assert.equal(s.name, 'Jonathan'); assert.equal(s.pinHash, 'x');
      assert.match(await page.textContent('#staff-list'), /Jonathan/);
      assert.deepEqual(errors, []); await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}

for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html']) {
  test(`${app}: Stock Valuation has its own tab after Inventory`, { skip }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const { ctx, page, errors } = await open(browser, base, app);
      await page.waitForTimeout(1500);
      const info = await page.evaluate(() => { const b = document.getElementById('stock-value-tab-btn'); const prev = b && b.previousElementSibling; return { btn: !!b, after: prev && prev.getAttribute('data-tab'), inNew: !!document.querySelector('#stock-value-tab #stock-valuation-panel'), inInv: !!document.querySelector('#inventory-list-tab #stock-valuation-panel'), label: b && b.textContent }; });
      assert.equal(info.btn, true); assert.equal(info.after, 'inventory-list-tab'); assert.equal(info.inNew, true); assert.equal(info.inInv, false, 'moved out of Inventory');
      await page.evaluate(() => guardedSwitchTab({ preventDefault() {}, currentTarget: document.getElementById('stock-value-tab-btn'), target: null }, 'stock-value-tab'));
      await page.waitForTimeout(500);
      assert.equal(await page.locator('#stock-valuation-panel').isVisible(), true, 'the valuation panel shows in the new tab');
      assert.equal(await page.locator('#inventory-list-tab').isVisible(), false);
      if (app === 'index.html') { assert.match(info.label, /Workspace/); assert.equal(await page.locator('#ip-entry').isVisible(), true, 'the workspace buttons are in the new tab'); }
      assert.deepEqual(errors, []); await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}

test('index.html: staff who could open Inventory get the Stock Value tab once; a new staff member only sees it when ticked', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await ctx.route('**/api/**', (r) => r.abort());
    await ctx.addInitScript(() => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('pos_staff', JSON.stringify([{ id: 'old', name: 'Old', roles: ['sales-tab', 'inventory-list-tab'], salesTabMigrated: true }, { id: 'cash', name: 'Cash', roles: ['sales-tab'], salesTabMigrated: true }])); });
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/index.html'); await page.waitForTimeout(2500);
    const roles = await page.evaluate(() => Object.fromEntries(staff.map((m) => [m.id, m.roles.slice()])));
    assert.ok(roles.old.includes('stock-value-tab'), 'old inventory staff keep Stock Valuation'); assert.ok(!roles.cash.includes('stock-value-tab'));
    const vis = (r) => page.evaluate((x) => { staff.length = 0; staff.push({ id: 'st-9', name: 'Z', roles: x, svtMigrated: true }); currentServer = { id: 'st-9', name: 'Z' }; applyServerVisibility(); return document.getElementById('stock-value-tab-btn').style.display !== 'none'; }, r);
    assert.equal(await vis(['sales-tab', 'inventory-list-tab']), false); assert.equal(await vis(['sales-tab', 'stock-value-tab']), true);
    assert.deepEqual(errors, []); await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

// zip 301: the global search finds items, dishes/services, customers, staff and screens
for (const app of ['index.html', 'hotel/index.html', 'services/index.html']) {
  test(`${app}: global search finds items, variants, customers, staff and screens, and acts on them`, { skip }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const { ctx, page, errors } = await open(browser, base, app);
      await page.evaluate(() => { inventory.push({ code: 'SV1', type: 'service', name: 'Beef Stew Special', price: 450, qty: 0, unit: 'pcs', category: 'Lunch', updatedAt: 1 }); customers.push({ id: 'c1', name: 'Wanjiku Kamau', phone: '0712000111' }); staff.push({ id: 's7', name: 'Otieno Brian', roles: [] }); });
      await page.keyboard.press('Control+k'); await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.getElementById('gs-modal').classList.contains('open')), true, 'Ctrl+K opens the search');
      const find = async (q) => { await page.fill('#gs-q', q); await page.waitForTimeout(120); return page.evaluate(() => [...document.querySelectorAll('#gs-list .gs-t')].map((e) => e.textContent)); };
      assert.ok((await find('pancake')).includes('Pancakes'), 'item by name');
      assert.ok((await find('v1-l')).includes('Tshirt (Large)'), 'a variant by its code');
      assert.ok((await find('stew')).includes('Beef Stew Special'), 'a dish / service');
      assert.ok((await find('lunch')).includes('Beef Stew Special'), 'by category');
      assert.ok((await find('0712000')).includes('Wanjiku Kamau'), 'customer by phone');
      assert.ok((await find('daily')).some((t) => /Daily Sales/i.test(t)), 'a screen by name');
      assert.deepEqual(await find('zzzzqq'), []);
      await find('pancake'); await page.keyboard.press('Enter'); await page.waitForTimeout(700);
      assert.equal(await page.evaluate(() => document.getElementById('gs-modal').classList.contains('open')), false, 'Enter acts and closes');
      assert.deepEqual(errors, []); await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}

// Zip 301: everything is done INSIDE the Edit popup - variant table, add/remove variants, per-variant box & piece, serial registration.
for (const app of ['index.html', 'pharmacy/index.html', 'services/index.html']) {
  test(`${app}: Edit popup edits variants directly (rename, price, stock, add, remove, box & piece)`, { skip }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const { ctx, page, errors } = await open(browser, base, app);
      await page.evaluate(() => openInventoryEditModal('V1')); await page.waitForTimeout(300);
      assert.equal(await page.locator('#em-panel table.em-vt tbody tr').count(), 2, 'both variants are listed in Edit');
      const row = (id, f) => page.locator(`#em-panel [data-ev="${f}"][data-vid="${id}"]`);
      await row('v-a', 'name').fill('Tiny'); await row('v-a', 'name').dispatchEvent('change'); await page.waitForTimeout(150);
      await row('v-a', 'qty').fill('9'); await row('v-a', 'qty').dispatchEvent('change'); await page.waitForTimeout(150);
      let v = await inv(page, 'V1');
      assert.equal(v.variants[0].name, 'Tiny'); assert.equal(v.variants[0].qty, 9); assert.equal(v.qty, 13, 'parent stock follows the variants');
      await page.fill('#em-vn', 'Medium, XL'); await page.click('#em-vgo'); await page.waitForTimeout(200);
      v = await inv(page, 'V1'); assert.deepEqual(v.variants.map((x) => x.name), ['Tiny', 'Large', 'Medium', 'XL']);
      assert.equal(new Set(v.variants.map((x) => x.code)).size, 4, 'codes are unique');
      await page.fill('#em-vn', 'tiny'); await page.click('#em-vgo'); await page.waitForTimeout(100);
      assert.match(await page.locator('#em-err').textContent(), /already exists/);
      // open one variant (still inside the same popup) and give it box & piece
      await page.evaluate(() => openInventoryEditModal('V1', 'v-b')); await page.waitForTimeout(300);
      assert.ok(await page.locator('#em-panel').isVisible(), 'panel shows in variant mode');
      await page.check('#em-dual'); await page.fill('#em-upb', '6'); await page.click('#em-dual-go'); await page.waitForTimeout(200);
      v = await inv(page, 'V1'); assert.equal(v.variants[1].dualUnit, true); assert.equal(v.variants[1].unitsPerBox, 6); assert.notEqual(v.variants[0].dualUnit, true);
      assert.deepEqual(errors, []);
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}

test('index.html: Edit popup registers serial/IMEI numbers directly and counts them', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, base, 'index.html');
    await page.evaluate(() => openInventoryEditModal('A1')); await page.waitForTimeout(300);
    await page.check('#em-ser'); await page.waitForTimeout(150);
    await page.fill('#em-sl', 'SN-AAA-1\nSN-AAA-2\nSN-AAA-2'); await page.selectOption('#em-st', 'serial'); await page.click('#em-sgo'); await page.waitForTimeout(250);
    const r = await page.evaluate(() => ({ units: serialUnits.filter((u) => u.code === 'A1').length, p: JSON.parse(JSON.stringify(inventory.find((x) => x.code === 'A1'))) }));
    assert.equal(r.units, 2, 'duplicate line refused');
    assert.equal(r.p.serialUnregistered, 8, '2 of the 10 counted units now have numbers');
    assert.equal(r.p.qty, 10, 'stock count unchanged when converting counted units');
    assert.match(await page.locator('#em-err').textContent(), /./);
    // a variant: register on the variant
    await page.evaluate(() => openInventoryEditModal('V1', 'v-a')); await page.waitForTimeout(300);
    await page.check('#em-ser'); await page.fill('#em-sl', 'VS-1'); await page.selectOption('#em-st', 'serial'); await page.click('#em-sgo'); await page.waitForTimeout(250);
    const q = await page.evaluate(() => ({ u: serialUnits.filter((x) => x.code === 'V1' && x.variantId === 'v-a').length, par: inventory.find((x) => x.code === 'V1').qty }));
    assert.equal(q.u, 1); assert.equal(q.par, 7);
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
