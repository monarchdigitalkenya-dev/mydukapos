import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const APPS = { shop: 'index.html', hotel: 'hotel/index.html', hospital: 'hospital/index.html', pharmacy: 'pharmacy/index.html', school: 'school/index.html', production: 'production/index.html', services: 'services/index.html', water: 'water/index.html', owner: 'owner/index.html' };
const stem = (t) => t.replace(/^[^\p{L}]+/u, '').replace(/\d+$/, '').replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [key, file] of Object.entries(APPS)) {
  test(`${key}: has its own guide covering EVERY tab, opens from 📖 / Settings / Version, searches, prints; version card reads 1.0.0`, async () => {
    const fetch = async (u) => (String(u).includes('/api/owner-auth') ? { ok: true, status: 200, json: async () => ({ authenticated: true, ownerClientId: 'OWN', hasAccount: true }) } : Promise.reject(new Error('offline')));
    const storage = key === 'owner' ? { pos_owner_session_token: 'tok', pos_owner_client_id: 'OWN' } : {};
    const b = await boot(file, { fetch, storage, wait: key === 'owner' ? 2500 : 1500 });
    const { w, d, errors } = b;
    w.eval("showToast = function (m) { window.__t = (window.__t || []).concat(m); }");
    const g = JSON.parse(w.eval('JSON.stringify(window.__GUIDE_DATA)'));
    assert.ok(g && g.chapters.length >= 10, 'a full guide');
    assert.equal(g.version, '1.0.0');
    for (const c of g.chapters) assert.ok(c.title && (c.steps || c.sections || c.tabs), `chapter ${c.id} has content`);

    // every tab of THIS app is described in the guide
    const tabs = [...d.querySelectorAll('.tabs .tab-link')].map((x) => stem(x.textContent));
    const described = new Set(g.chapters.find((c) => c.id === 'alltabs').tabs.map((t) => t[0]));
    const missing = tabs.filter((t) => !described.has(t));
    assert.deepEqual(missing, [], `tabs missing from the guide: ${missing.join(', ')}`);

    // version card
    const card = d.getElementById('settings-section-install').textContent.replace(/\s+/g, ' ');
    assert.match(card, /Version 1\.0\.0/); assert.match(card, /The best software in existence\./);

    // the three ways in
    assert.ok(d.getElementById('guide-header-btn'), 'the 📖 in the header');
    assert.ok(d.getElementById('guide-open-settings-btn'), 'the button in Settings ▸ Guide');
    assert.ok(d.getElementById('guide-open-version-btn'), 'the button on the Version card');
    d.getElementById('guide-header-btn').click();
    assert.equal(d.getElementById('guide-modal').style.display, 'block');
    assert.equal(d.querySelectorAll('#guide-body details').length, g.chapters.length, 'every chapter is listed');
    assert.match(d.getElementById('guide-title').textContent, new RegExp(g.module.split(' ')[0]));
    // search
    w.eval("guideSearch('printer')");
    const hits = d.querySelectorAll('#guide-body details').length;
    assert.ok(hits >= 1 && hits <= g.chapters.length, 'a search narrows the chapters');
    w.eval("guideSearch('zzzzqqqq')");
    assert.match(d.getElementById('guide-body').textContent, /Nothing matches/);
    w.eval("guideSearch(''); guideJump('start')");
    assert.ok(d.getElementById('guide-ch-start').open);
    // print
    w.eval("window.__w = 0; window.open = () => ({ document: { write(h) { window.__html = h; }, close() {} }, focus() {}, print() { window.__w++; } })");
    w.eval('guidePrint()'); await sleep(450);
    assert.equal(w.eval('window.__w'), 1); assert.match(w.eval('window.__html'), new RegExp(g.title.split(' — ')[0]));
    w.eval('guideClose()');
    assert.equal(d.getElementById('guide-modal').style.display, 'none');
    await sleep(key === 'owner' ? 1200 : 100);
    assert.deepEqual(errors, []);
    b.close();
  });
}

test('each guide is about ITS module (and only that module)', () => {
  const read = (k) => JSON.stringify(JSON.parse(require_guide(k)).chapters);
  function require_guide(k) { return globalThis.__g[k]; }
  globalThis.__g = {};
  for (const k of Object.keys(APPS)) {
    const html = globalThis.process.getBuiltinModule('fs').readFileSync(new URL(`../src/shared/blocks/guide-data/${k}.html`, import.meta.url), 'utf8');
    globalThis.__g[k] = JSON.stringify(JSON.parse(html.match(/window\.__GUIDE_DATA = (.*);<\/script>/s)[1]));
  }
  const has = (k, re) => assert.match(read(k), re, `${k} guide should mention ${re}`);
  const not = (k, re) => assert.doesNotMatch(read(k), re, `${k} guide should NOT mention ${re}`);
  has('hospital', /visit reference/); has('hospital', /Reception \/ Registration/); has('hospital', /Wards & Beds/); has('hospital', /Insurance/); not('hospital', /Gas Refill/);
  has('hotel', /Kitchen/); has('hotel', /Open New Tab/); has('hotel', /Dish/); has('hotel', /optional but recommended/); not('hotel', /Bazaar/);
  has('pharmacy', /soonest-expiring batch/); has('pharmacy', /Dosage/); not('pharmacy', /Wards/);
  has('school', /Bazaar Fund/); has('school', /Promote a Class/); has('school', /Fee Balances/); not('school', /Hold sale/); not('school', /Bill \(Pay Later\)/);
  has('production', /Hiring Counter/); has('production', /Assemble & Add to Stock/);
  has('services', /Client Registry/); has('services', /Print Intake Tag/); has('services', /Bookings/);
  has('water', /Bulk Tank/); has('water', /Price per Litre/); has('water', /Both sites/); not('water', /Stock Take/); not('water', /Low-stock|low-stock button/);
  has('owner', /Generate Link/); has('owner', /Click-to-WhatsApp/); has('owner', /Errors/); not('owner', /Connect Bluetooth Printer/); not('owner', /Batch Commit/);
  has('shop', /Gas Refill/); has('shop', /Cross-Branch/);
  for (const k of Object.keys(APPS)) { not(k, /Test print/); not(k, /Held¹/); }
});
