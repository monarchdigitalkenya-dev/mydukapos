import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';

// Zip 150. (1) An installed app opens at start_url with no ?c= token, so a shop on a ?c= link saw "This link no longer exists".
// The token is now kept per address + app and reused. (2) One link's saved licence answer (a demo countdown) must never be applied
// to a different link opened on the same address (a permanent one saying "trial has ended").
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const offline = () => Promise.reject(new Error('offline'));

for (const app of APPS) {
  const dir = app === 'index.html' ? '/' : '/' + app.replace('index.html', '');
  test(`${app}: an installed launch (no ?c=) reuses the token from the first visit; a shop subdomain never stores one`, async () => {
    const seen = [];
    const fetch = async (u) => { seen.push(String(u)); return json({}); };
    // first visit through the ?c= link
    let b = await boot(app, { url: `https://mydukapos.store${dir}?c=abc123`, fetch, wait: 600 });
    assert.equal(b.w.eval('clientToken'), 'abc123');
    const stored = b.w.localStorage.getItem('pos_link_token:' + dir);
    assert.equal(stored, 'abc123', 'token kept on the device');
    b.close();
    // installed launch: start_url has no c
    b = await boot(app, { url: `https://mydukapos.store${dir}?source=pwa`, storage: { ['pos_link_token:' + dir]: 'abc123' }, fetch, wait: 600 });
    assert.equal(b.w.eval('clientToken'), 'abc123', 'installed launch uses the kept token');
    assert.ok(b.w.eval("apiUrl('/api/license-status')").includes('c=abc123'));
    b.close();
    // subdomain: address names the shop; nothing stored, nothing restored
    b = await boot(app, { url: `https://georgehardware.mydukapos.store${dir}?source=pwa`, storage: { ['pos_link_token:' + dir]: 'abc123' }, fetch, wait: 600 });
    assert.equal(b.w.eval('clientToken'), '', 'no token added on a subdomain (would change the password salt)');
    b.close();
    b = await boot(app, { url: `https://georgehardware.mydukapos.store${dir}?c=zzz`, fetch, wait: 600 });
    assert.equal(b.w.localStorage.getItem('pos_link_token:' + dir), null, 'a subdomain visit stores nothing');
    b.close();
  });

  test(`${app}: a saved demo answer from another link is not used for this link`, async () => {
    const cp = { serverNow: Date.now() - 1e6, remainingMs: 1000, type: 'demo', valid: true, reason: 'demo_active', checkedAtLocal: Date.now() - 1e6, link: 'DEMOLINK' };
    const { w, close } = await boot(app, { url: `https://mydukapos.store${dir}?c=PERMLINK`, storage: { pos_license_checkpoint: JSON.stringify(cp) }, fetch: offline, wait: 600 });
    assert.equal(w.eval('estimateLicenseOffline()'), null, 'other link\'s checkpoint ignored (no "trial ended")');
    w.eval("saveLicenseCheckpoint({ serverNow: Date.now(), remainingMs: null, type: 'permanent', valid: true, reason: 'permanent' })");
    const est = w.eval('estimateLicenseOffline()');
    assert.equal(est && est.valid, true, 'this link\'s own checkpoint still works offline');
    close();
  });
}
