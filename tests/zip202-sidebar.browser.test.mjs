import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// zip 202: the sidebar navigation (src/shared/blocks/sidebar-nav.html) in a real Chromium. The sidebar is BUILT FROM the real tab buttons the app already
// shows or hides per user, so these tests check the user-visible promises: only permitted tabs appear, groups are only folders (never grant children,
// vanish when empty), every permitted tab is reachable, collapse / drawer / themes / clock / Clock Out work, and the old bar is out of sight.
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const H = crypto.createHash('sha256').update('pw').digest('hex');
const INV = [{ code: 'A1', type: 'item', name: 'Soda', category: 'Drinks', price: 100, wholesalePrice: 60, qty: 50, unit: 'pcs' }];
const APPS = [
  { key: 'shop', file: 'index.html' }, { key: 'hotel', file: 'hotel/index.html' }, { key: 'pharmacy', file: 'pharmacy/index.html' },
  { key: 'production', file: 'production/index.html' }, { key: 'services', file: 'services/index.html' }, { key: 'hospital', file: 'hospital/index.html' },
  { key: 'water', file: 'water/index.html', water: true },
];

async function withApp(fn) {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try { await fn(browser, base); } finally { await browser.close(); srv.close(); }
}
async function open(browser, base, app, { width = 1280, height = 800, theme = null, collapsed = false, ctx = null } = {}) {
  const phone = width < 700;
  ctx = ctx || await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone });
  if (!ctx.__seeded) {
    ctx.__seeded = true;
    await ctx.route('**/api/**', (r) => r.abort());
    await ctx.addInitScript(([h, inv, water, th, col]) => {
      if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
      const pre = water ? 'aqua_' : 'pos_';
      localStorage.setItem(pre + 'pw_hash', h); localStorage.setItem(pre + 'biz_name', 'C&T Solution');
      for (const k of ['pos_notif_prompt_last', 'pos_cd_detect_last', 'aqua_notif_prompt_last']) localStorage.setItem(k, String(Date.now()));
      if (!water) localStorage.setItem('pos_inventory', JSON.stringify(inv)); else localStorage.setItem('aqua_products', '[]');
      localStorage.setItem('pos_locked_tabs', '[]');
      if (th) localStorage.setItem('mdp-theme', th);
      if (col) localStorage.setItem('pos_snav_collapsed', '1');
    }, [H, INV, !!app.water, theme, collapsed]);
  }
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.goto(base + '/' + app.file); await page.waitForTimeout(1300);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; });
  await page.waitForFunction(() => window.sidebarNav && window.sidebarNav.on(), null, { timeout: 8000 });
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}
const entries = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#snav .sn-list [data-go]')).map((b) => b.dataset.go));
const groups = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#snav .sn-group')).map((g) => g.dataset.g));
const asStaff = async (page, roles) => {
  await page.evaluate((r) => {
    staff = [{ id: 's1', name: 'Ann', roles: r, pinHash: 'x', updatedAt: 1 }]; currentServer = { id: 's1', name: 'Ann' };
    sessionStorage.setItem('pos_current_server', JSON.stringify(currentServer)); applyServerVisibility(); updateServerBtnLabel && updateServerBtnLabel();
  }, roles);
  await page.waitForTimeout(500);
};

test('owner (shop): every group and tab is there, every permitted tab has an entry, and each entry opens its own tab', { skip, timeout: 240000 }, async () => {
  await withApp(async (browser, base) => {
    const { page, errors } = await open(browser, base, APPS[0]);
    const g = await groups(page);
    for (const id of ['sell', 'stock', 'fin', 'rep', 'people', 'biz', 'sys']) assert.ok(g.includes(id), 'group ' + id);   // zip 304: Sell, Stock, Money, Reports, People, Business, System
    const e = await entries(page);
    assert.ok(e.includes('sales-tab') && e.includes('dashboard-tab'));
    const real = await page.evaluate(() => Array.from(document.querySelectorAll('.tab-link[data-tab]')).filter((b) => b.style.display !== 'none').map((b) => b.dataset.tab));
    assert.deepEqual([...new Set(e)].sort(), [...new Set(real)].sort(), 'the sidebar lists exactly the tabs the app shows');
    // the old bar is out of sight (not deleted)
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('nav.tabs')).visibility), 'hidden');
    // every entry opens its tab
    for (const id of e) {
      await page.evaluate((t) => { const b = document.querySelector('#snav [data-go="' + t + '"]'); b.click(); }, id);
      await page.waitForTimeout(120);
      const act = await page.evaluate(() => (document.querySelector('.tab-content.active') || {}).id);
      assert.equal(act, id, 'opened ' + id);
    }
    assert.deepEqual(errors, []);
  });
});

test('staff with Sales Counter + Stock Take sees only those (Stock > Stock Take); no Inventory, Restock, Add Items, Barcode, Finance, Reports, Settings', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const { page } = await open(browser, base, APPS[0]);
    await asStaff(page, ['sales-tab', 'stock-take-tab']);
    assert.deepEqual((await entries(page)).sort(), ['sales-tab', 'stock-take-tab']);
    assert.deepEqual(await groups(page), ['stock']);
    const html = await page.evaluate(() => document.querySelector('#snav .sn-list').textContent);
    const whole = await page.evaluate(() => document.getElementById('snav').textContent);
    for (const w of ['Inventory', 'Restock', 'Add New Items', 'Barcode', 'Money', 'Reports', 'Settings', 'Staff']) assert.ok(!html.includes(w), w + ' is not mentioned');
    assert.match(whole, /Clock Out/); assert.match(whole, /Ann/);
  });
});

test('staff with ONE finance tab sees Finances > that tab only; a group with no permitted child is gone; no tabs = a calm message', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const { page } = await open(browser, base, APPS[0]);
    await asStaff(page, ['bills-tab']);
    assert.deepEqual(await entries(page), ['bills-tab']); assert.deepEqual(await groups(page), ['fin']);
    await asStaff(page, ['profits-tab']);
    assert.deepEqual(await entries(page), ['profits-tab']);
    await asStaff(page, ['expenses-add-only']);
    assert.deepEqual(await entries(page), ['profits-tab'], 'the add-expense-only grant still reaches Profits & Expenses');
    await asStaff(page, []);
    assert.deepEqual(await entries(page), []); assert.deepEqual(await groups(page), []);
    assert.match(await page.evaluate(() => document.querySelector('#snav .sn-list').textContent), /Nothing assigned/);
  });
});

test('access is still enforced by the app: a staff member cannot open a tab that was not granted, sidebar or not', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const { page } = await open(browser, base, APPS[0]);
    await asStaff(page, ['sales-tab']);
    await page.evaluate(() => { const b = document.querySelector('.tab-link[data-tab="profits-tab"]'); guardedSwitchTab({ currentTarget: b }, 'profits-tab'); });
    await page.waitForTimeout(300);
    assert.notEqual(await page.evaluate(() => (document.querySelector('.tab-content.active') || {}).id), 'profits-tab', 'the password prompt stands in the way');
    assert.equal(await page.evaluate(() => isTabLocked('profits-tab')), true);
  });
});

test('collapse to an icon rail with tooltips and a group fly-out; remembered after a reload; the drawer button does the same job on a phone', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const { ctx, page } = await open(browser, base, APPS[0]);
    const pad = () => page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingLeft));
    const wide = await pad(); assert.ok(wide > 150);
    await page.click('#snav-burger'); await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.body.classList.contains('snav-collapsed')), true);
    assert.ok((await pad()) < 100, 'the page gets the room back');
    assert.equal(await page.evaluate(() => document.querySelector('#snav [data-go="dashboard-tab"]').title), 'Dashboard', 'tooltip');
    await page.click('#snav .sn-parent[data-grp="stock"]'); await page.waitForTimeout(200);
    assert.ok(await page.evaluate(() => document.getElementById('snav-fly').classList.contains('on') && document.querySelectorAll('#snav-fly [data-go]').length >= 3), 'fly-out lists the group');
    await page.click('#snav-fly [data-go="stock-take-tab"]'); await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.querySelector('.tab-content.active').id), 'stock-take-tab');
    // remembered
    const again = await open(browser, base, APPS[0], { ctx });
    assert.equal(await again.page.evaluate(() => document.body.classList.contains('snav-collapsed')), true);
  });
});

test('phone: the sidebar is a drawer (hamburger opens it, choosing a page or tapping outside closes it), no horizontal scrolling bar', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const { page } = await open(browser, base, APPS[0], { width: 390, height: 844 });
    const left = () => page.evaluate(() => Math.round(document.getElementById('snav').getBoundingClientRect().right));
    assert.ok((await left()) <= 0, 'hidden off-screen at first');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).paddingLeft), '0px');
    await page.tap('#snav-burger'); await page.waitForTimeout(400);
    assert.ok((await left()) > 200, 'opened over the page');
    await page.tap('#snav .sn-parent[data-grp="stock"]'); await page.waitForTimeout(300);
    await page.tap('#snav [data-go="restock-tab"]'); await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.querySelector('.tab-content.active').id), 'restock-tab');
    assert.ok((await left()) <= 0, 'closed after choosing');
    await page.tap('#snav-burger'); await page.waitForTimeout(300);
    await page.mouse.click(380, 500); await page.waitForTimeout(300);
    assert.ok((await left()) <= 0, 'closed by tapping outside');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no sideways scrolling');
  });
});

test('light and dark both look designed: the sidebar follows the theme', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const a = await open(browser, base, APPS[0]);
    const light = await a.page.evaluate(() => getComputedStyle(document.getElementById('snav')).backgroundColor);
    const b = await open(browser, base, APPS[0], { theme: 'dark' });
    const dark = await b.page.evaluate(() => getComputedStyle(document.getElementById('snav')).backgroundColor);
    assert.notEqual(light, dark);
    assert.match(light, /255, 255, 255/);
  });
});

test('the clock is always in the header and ticks; Clock Out is a visible button that signs the person out', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const { page } = await open(browser, base, APPS[0]);
    const t = await page.evaluate(() => document.querySelector('#snav-clock').textContent);
    assert.match(t, /\d{1,2}:\d{2}\s?(AM|PM)/);
    assert.equal(await page.evaluate(() => { const r = document.querySelector('#snav-clock').getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.right <= innerWidth; }), true);
    await page.click('#snav-burger'); await page.waitForTimeout(300);                       // collapsed: the clock stays
    assert.equal(await page.evaluate(() => document.querySelector('#snav-clock').getBoundingClientRect().width > 0), true);
    await page.click('#snav-burger'); await page.waitForTimeout(300);
    await asStaff(page, ['sales-tab']);
    assert.equal(await page.evaluate(() => { const b = document.querySelector('#snav [data-act="out"]'); const r = b.getBoundingClientRect(); return r.width > 40 && r.bottom <= innerHeight; }), true, 'Clock Out is visible without opening any menu');
    await page.evaluate(() => { window.__out = 0; const o = window.logoutServer; window.logoutServer = function () { window.__out++; }; });
    await page.click('#snav [data-act="out"]');
    assert.equal(await page.evaluate(() => window.__out), 1, 'it calls the app\'s own Clock Out');
  });
});

test('switching the sidebar off (or an error) brings the old tab bar back', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const { page } = await open(browser, base, APPS[0]);
    await page.evaluate(() => window.sidebarNav.off());
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('nav.tabs')).visibility), 'visible');
    assert.equal(await page.evaluate(() => !!document.getElementById('snav')), false);
  });
});

for (const app of APPS) {
  test(`${app.key}: the sidebar is there, lists exactly the permitted tabs, and a staff member with one tab sees just that`, { skip, timeout: 120000 }, async () => {
    await withApp(async (browser, base) => {
      const { page, errors } = await open(browser, base, app);
      const e = await entries(page);
      const real = await page.evaluate(() => Array.from(document.querySelectorAll('.tab-link[data-tab]')).filter((b) => b.style.display !== 'none' && document.getElementById(b.dataset.tab)).map((b) => b.dataset.tab));
      assert.deepEqual([...new Set(e)].sort(), [...new Set(real)].sort());
      assert.ok(e.length >= 5);
      const one = e.find((x) => x !== 'settings-tab' && x !== 'staff-tab');
      await asStaff(page, [one]);
      assert.deepEqual(await entries(page), [one], 'only the granted tab');
      assert.equal(await page.evaluate(() => document.querySelectorAll('#snav .sn-group').length <= 1), true);
      assert.deepEqual(errors, []);
    });
  });
}

test('accordion: opening one folder closes the others', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const { page } = await open(browser, base, APPS[0]);
    await page.evaluate(() => { document.querySelector('#snav .sn-parent[data-grp="fin"]').click(); });
    await page.waitForTimeout(150);
    await page.evaluate(() => { document.querySelector('#snav .sn-parent[data-grp="stock"]').click(); });
    await page.waitForTimeout(150);
    const opened = await page.evaluate(() => Array.from(document.querySelectorAll('#snav .sn-group.open')).map((g) => g.dataset.g));
    assert.deepEqual(opened, ['stock']);
  });
});
