import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';

// Zip 245. An installed app that opens without the shop token must not say "This link no longer exists" for a live link:
// (1) the manifest the page hands the browser carries the token in start_url; (2) a token-less launch says the link is MISSING (with a box to paste it).
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const MANIFEST = { id: '/x/?source=pwa', name: 'X', start_url: './?source=pwa', scope: './', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] };

for (const app of APPS) {
  const dir = app === 'index.html' ? '/' : '/' + app.replace('index.html', '');
  test(`${app}: "no longer exists" is said ONLY for a proven-deleted link; not-found / no-link never claims removal, never locks a working shop`, async () => {
    const ans = (reason) => async (u) => String(u).includes('license-status') ? json({ valid: false, reason, serverNow: Date.now() }) : json({});
    const shown = (d) => d.getElementById('license-lock-screen').style.display === 'flex';
    // (a) opened with no link at all: the first answer locks nothing, a second one shows "open your shop link" - never "removed"
    let b = await boot(app, { url: `https://mydukapos.store${dir}?source=pwa`, fetch: ans('no_link'), wait: 900 });
    assert.equal(shown(b.d), false, 'one unproven answer does not lock the app');
    await b.w.eval('checkLicenseStatus()'); await b.w.eval('checkLicenseStatus()');
    assert.equal(shown(b.d), true);
    assert.match(b.d.getElementById('license-lock-title').textContent, /Open your shop link/);
    assert.doesNotMatch(b.d.getElementById('license-lock-title').textContent + b.d.getElementById('license-lock-reason').textContent, /no longer exists|has been removed and can no longer/);
    assert.ok(b.d.getElementById('ilg-input'), 'a box to paste the link');
    b.close();
    // (b) a link that is simply not found: "could not confirm", nothing removed
    b = await boot(app, { url: `https://mydukapos.store${dir}?c=abc`, fetch: ans('not_found'), wait: 900 });
    await b.w.eval('checkLicenseStatus()'); await b.w.eval('checkLicenseStatus()');
    assert.match(b.d.getElementById('license-lock-title').textContent, /could not confirm/);
    assert.match(b.d.getElementById('license-lock-reason').textContent, /Nothing has been removed/);
    b.close();
    // (c) a shop that worked before is never locked by a not-found answer
    const cp = { serverNow: Date.now(), remainingMs: null, type: 'permanent', valid: true, reason: 'permanent', checkedAtLocal: Date.now(), link: 'abc' };
    b = await boot(app, { url: `https://mydukapos.store${dir}?c=abc`, storage: { pos_license_checkpoint: JSON.stringify(cp) }, fetch: ans('not_found'), wait: 900 });
    for (let i = 0; i < 4; i++) await b.w.eval('checkLicenseStatus()');
    assert.equal(shown(b.d), false, 'known-good shop stays open');
    assert.equal(JSON.parse(b.w.localStorage.getItem('pos_license_checkpoint')).valid, true, 'the good checkpoint is not overwritten');
    b.close();
    // (d) a proven-deleted link says so
    b = await boot(app, { url: `https://mydukapos.store${dir}?c=abc`, fetch: ans('deleted'), wait: 900 });
    assert.equal(shown(b.d), true);
    assert.match(b.d.getElementById('license-lock-title').textContent, /no longer exists/);
    assert.equal(b.d.getElementById('ilg-input'), null);
    b.close();
  });

  test(`${app}: the manifest handed to the browser carries the shop token in start_url (absolute, same id)`, async () => {
    const fetch = async (u) => String(u).includes('manifest') ? json(MANIFEST) : json({ valid: true, reason: 'permanent', type: 'permanent' });
    const b = await boot(app, { url: `https://mydukapos.store${dir}?c=abc123`, fetch, wait: 900,
      beforeParse: (w) => { let blob = null; w.Blob = class { constructor(p) { this.t = p.join(''); w.__blobText = this.t; } }; w.URL.createObjectURL = () => 'blob:test'; } });
    await new Promise((r) => setTimeout(r, 400));
    const link = b.d.querySelector('link[rel="manifest"]');
    const txt = b.w.__blobText;
    if (!txt) { b.close(); return assert.fail('manifest was not rebuilt'); }
    const m = JSON.parse(txt);
    assert.match(m.start_url, /^https:\/\/mydukapos\.store\//);
    assert.equal(new URL(m.start_url).searchParams.get('c'), 'abc123');
    assert.equal(m.id.startsWith('https://mydukapos.store/'), true);
    assert.ok(m.icons[0].src.startsWith('https://'));
    assert.equal(link.getAttribute('href'), 'blob:test');
    b.close();
  });

  test(`${app}: on a shop subdomain the manifest is left alone`, async () => {
    const fetch = async (u) => json(String(u).includes('manifest') ? MANIFEST : { valid: true, reason: 'permanent', type: 'permanent' });
    const b = await boot(app, { url: `https://georgehardware.mydukapos.store${dir}?c=zzz`, fetch, wait: 900 });
    assert.equal(b.d.querySelector('link[rel="manifest"]').getAttribute('data-link-token'), null);
    b.close();
  });
}
