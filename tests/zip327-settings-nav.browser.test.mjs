// zip 327: Settings navigation - grouped left list on desktop, dropdown on phones, search, permissions respected. Real Chromium (Playwright).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';
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
async function open(browser, base, app, width, height, scheme = 'light') {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
  await ctx.route('**/api/**', (r) => r.abort());
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/' + app); await page.waitForTimeout(1600);
  await page.evaluate(() => {
    for (const id of ['login-screen', 'registration-screen']) { const l = document.getElementById(id); if (l) l.style.display = 'none'; }
    const b = document.getElementById('settings-tab-btn'); if (b) b.click();
    if (typeof showSettingsSection === 'function') showSettingsSection('settings-section-general');
  });
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}
const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html'];

for (const app of APPS) {
  test(`${app}: desktop - one compact sticky list on the left, content on the right, no sideways scroll`, { skip }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const { ctx, page, errors } = await open(browser, base, app, 1366, 800);
      const m = await page.evaluate(() => {
        const nav = document.getElementById('settings-subnav'), sec = document.querySelector('.settings-section-content.active');
        const nr = nav.getBoundingClientRect(), sr = sec.getBoundingClientRect(), btns = [...nav.querySelectorAll('.settings-subtab-btn')].filter((b) => b.offsetParent);
        return { navW: nr.width, navLeft: nr.left, secLeft: sr.left, nBtns: btns.length, sticky: getComputedStyle(nav).position, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                 headings: [...nav.querySelectorAll('.stp-lbl')].filter((h) => h.offsetParent).map((h) => h.textContent.trim()), selectShown: !!document.getElementById('stp-nav').offsetParent,
                 navRows: new Set(btns.map((b) => Math.round(b.getBoundingClientRect().left))).size };
      });
      assert.ok(m.navW <= 260 && m.navW >= 180, 'compact list: ' + m.navW);
      assert.ok(m.secLeft > m.navLeft + m.navW - 2, 'content sits to the right of the list');
      assert.equal(m.sticky, 'sticky'); assert.equal(m.selectShown, false, 'the dropdown is for phones');
      assert.equal(m.navRows, 1, 'a single column of buttons (not wrapped pill rows)');
      assert.ok(m.nBtns >= 10); assert.ok(m.headings.some((h) => /^Business/.test(h)), 'group headings: ' + m.headings);
      assert.ok(m.overflowX <= 1, 'no horizontal overflow: ' + m.overflowX);
      assert.deepEqual(errors, []);
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });

  test(`${app}: phone - dropdown + search replace the pill rows, switching sections works, no sideways scroll`, { skip }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const { ctx, page, errors } = await open(browser, base, app, 390, 800);
      const m = await page.evaluate(() => ({ selectShown: !!document.getElementById('stp-nav').offsetParent, pillsShown: [...document.querySelectorAll('#settings-subnav .settings-subtab-btn')].filter((b) => b.offsetParent).length,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, opts: document.getElementById('stp-nav').options.length, navH: document.getElementById('settings-subnav').getBoundingClientRect().height }));
      assert.equal(m.selectShown, true); assert.equal(m.pillsShown, 0, 'no stacked pill rows'); assert.ok(m.overflowX <= 1, 'overflow ' + m.overflowX); assert.ok(m.opts >= 10);
      assert.ok(m.navH < 170, 'the whole navigation is one short block, not 10 rows: ' + m.navH);
      const target = await page.evaluate(() => { const o = [...document.getElementById('stp-nav').options].find((x) => /backup/i.test(x.textContent)); return o ? o.value : null; });
      assert.ok(target, 'a Backups option exists');
      await page.selectOption('#stp-nav', target);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.querySelector('.settings-section-content.active').id), target);
      assert.deepEqual(errors, []);
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}

test('search: finds by section name and by words inside a section, shows an empty state, opens the section, never reads field values', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const { ctx, page } = await open(browser, base, 'index.html', 1366, 800);
    const shown = () => page.evaluate(() => [...document.querySelectorAll('#settings-subnav .settings-subtab-btn')].filter((b) => b.offsetParent).map((b) => b.dataset.section));
    const all = await shown();
    await page.fill('#stp-q', 'onfon'); await page.waitForTimeout(300);
    const onfon = await shown();
    assert.ok(onfon.includes('settings-section-broadcast'), 'Onfon is found, in the SMS section: ' + onfon);
    assert.ok(onfon.length < all.length);
    await page.fill('#stp-q', 'backup'); await page.waitForTimeout(300);
    assert.ok((await shown()).includes('settings-section-backups'));
    await page.fill('#stp-q', 'qqzzxx nothing'); await page.waitForTimeout(300);
    assert.equal((await shown()).length, 0);
    assert.ok(await page.evaluate(() => document.getElementById('stp-empty').offsetParent !== null), 'empty state shown');
    // a typed-in secret in a field is NOT searchable (text only)
    await page.fill('#stp-q', ''); await page.waitForTimeout(200);
    await page.evaluate(() => { const i = document.getElementById('sms-onfon-access-key') || document.querySelector('#settings-section-broadcast input[type=password], #settings-section-broadcast input[type=text]'); if (i) i.value = 'SUPERSECRETVALUE99'; });
    await page.fill('#stp-q', 'supersecretvalue99'); await page.waitForTimeout(300);
    assert.equal((await shown()).length, 0, 'field values are never indexed');
    await page.fill('#stp-q', 'sms broadcast'); await page.waitForTimeout(300);
    await page.press('#stp-q', 'Enter'); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.querySelector('.settings-section-content.active').id), 'settings-section-broadcast', 'Enter opens the first match');
    assert.ok(await page.evaluate(() => document.getElementById('sms-onfon-access-key') ? true : !!document.querySelector('#settings-section-broadcast [id*="onfon"]')), 'the Onfon fields live in that section');
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('permissions: a section the admin gate hid is not in the list, the dropdown, or the search - and cannot be opened', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const { ctx, page } = await open(browser, base, 'index.html', 1366, 800);
    await page.evaluate(() => { window.currentAdminSettingsRestriction = () => ['settings-section-general', 'settings-section-receipts']; applySecondaryAdminSettingsGate(); });
    await page.waitForTimeout(400);
    const vis = await page.evaluate(() => [...document.querySelectorAll('#settings-subnav .settings-subtab-btn')].filter((b) => b.offsetParent).map((b) => b.dataset.section));
    assert.deepEqual(vis.sort(), ['settings-section-general', 'settings-section-receipts']);
    const opts = await page.evaluate(() => [...document.getElementById('stp-nav').options].map((o) => o.value).sort());
    assert.deepEqual(opts, ['settings-section-general', 'settings-section-receipts']);
    await page.fill('#stp-q', 'backup'); await page.waitForTimeout(300);
    assert.equal((await page.evaluate(() => [...document.querySelectorAll('#settings-subnav .settings-subtab-btn')].filter((b) => b.offsetParent).length)), 0, 'search does not reveal a hidden section');
    await page.evaluate(() => { window.showToast = function () {}; showSettingsSection('settings-section-backups'); });
    assert.notEqual(await page.evaluate(() => document.querySelector('.settings-section-content.active').id), 'settings-section-backups', 'the server-side / gate refusal still applies');
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('dark theme: list text and the active item stay readable', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const { ctx, page } = await open(browser, base, 'index.html', 1366, 800, 'dark');
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.body.classList.add('dark'); });
    const c = await page.evaluate(() => {
      const lum = (s) => { const m = s.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(m[0]) + .7152 * f(m[1]) + .0722 * f(m[2]); };
      const bg = (el) => { for (let e = el; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) return b; } return 'rgb(255,255,255)'; };
      const out = []; for (const b of [...document.querySelectorAll('#settings-subnav .settings-subtab-btn')].filter((x) => x.offsetParent).slice(0, 12)) {
        const fg = getComputedStyle(b).color, back = bg(b), a = lum(fg), z = lum(back), hi = Math.max(a, z), lo = Math.min(a, z); out.push((hi + .05) / (lo + .05)); }
      return out;
    });
    assert.ok(c.length >= 5); assert.ok(Math.min(...c) >= 3, 'contrast ratios ' + c.map((x) => x.toFixed(1)));
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
