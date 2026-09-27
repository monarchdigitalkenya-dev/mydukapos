import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';

// Zip 143. The licence is re-checked every 30 s. A server hiccup (a 5xx with a JSON { error }, or a Cloudflare error page that is
// not JSON) was taken as the licence answer — `valid` missing -> the app LOCKED ("This link isn't recognized", or with an old
// checkpoint "This device is offline … connect to the internet") while the internet worked. Only a real answer may lock it.
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const lockShown = (d) => { const el = d.getElementById('license-lock-screen'); return !!el && el.style.display === 'flex'; };

for (const app of [...APPS, 'owner/index.html']) {
  test(`${app}: a licence-server hiccup never locks the app; a real "locked" answer still does`, async () => {
    let mode = 'ok';
    const fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/license-status')) {
        if (mode === 'ok') return json({ valid: true, reason: 'permanent', type: 'permanent', serverNow: Date.now(), clientId: 'C1' });
        if (mode === 'json500') return json({ error: 'KV unavailable' }, 500);
        if (mode === 'html') return new Response('<html>error code: 1101</html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
        if (mode === 'locked') return json({ valid: false, reason: 'locked', type: 'permanent', serverNow: Date.now() });
      }
      if (u.includes('/api/owner-auth')) return json({ hasAccount: true, authenticated: true, ownerClientId: 'C1' });
      if (u.includes('/api/health')) return json({ ok: true });
      return json({});
    };
    const storage = app.startsWith('owner/') ? { pos_owner_session_token: 'o2.tok', pos_owner_client_id: 'C1' } : {};
    const { w, d, close } = await boot(app, { fetch, storage, wait: 1500 });
    await w.eval('checkLicenseStatus()');
    assert.equal(lockShown(d), false, 'valid licence: open');
    for (mode of ['json500', 'html']) {
      await w.eval('checkLicenseStatus()');
      assert.equal(lockShown(d), false, `${mode}: still open — a server hiccup is not a licence answer`);
      assert.equal(w.eval('licenseInfo.valid'), true, `${mode}: the last real answer stands`);
    }
    const cp = JSON.parse(w.localStorage.getItem('pos_license_checkpoint') || '{}');
    assert.equal(cp.valid, true, 'the saved checkpoint was not overwritten by the hiccup');
    mode = 'locked';
    await w.eval('checkLicenseStatus()');
    assert.equal(lockShown(d), true, 'a real "locked" answer still locks');
    await new Promise((r) => setTimeout(r, 800));
    close();
  });
}
