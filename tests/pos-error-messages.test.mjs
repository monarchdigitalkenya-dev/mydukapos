import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';

// Zip 143: "Could not reach the server — check your connection" was shown for every failure in the POS apps too.
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

for (const app of APPS) {
  test(`${app}: a failed request is explained by what really happened`, async () => {
    let status = 500;
    const fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/health')) return json({ ok: true });
      if (u.includes('/api/probe-me')) { if (status === 'net') throw new TypeError('Failed to fetch'); return json({ error: 'x' }, status); }
      return json({});
    };
    const { w, close } = await boot(app, { fetch, wait: 1200 });
    await w.eval("fetch('/api/probe-me').catch(() => {})");
    assert.match(w.eval("netErrText('Could not load')"), /server had a problem \(error 500\)\. Your internet works/);
    status = 401; await w.eval("fetch('/api/probe-me').catch(() => {})");
    assert.match(w.eval("netErrText('Could not reach the server')"), /^This device or your staff sign-in must be confirmed again/);
    status = 429; await w.eval("fetch('/api/probe-me').catch(() => {})");
    assert.match(w.eval("netErrText('Could not save')"), /too many requests/);
    w.__posNetInternetProbe = () => Promise.resolve(false);
    status = 'net'; await w.eval("fetch('/api/probe-me').catch(() => {})");
    w.eval("window.fetch = () => Promise.reject(new TypeError('Failed to fetch'))");
    await w.eval("PosNet.check('test')");
    assert.match(w.eval("netErrText('Could not save')"), /this device is offline/, 'truly offline -> offline');
    assert.equal(w.eval("netErrMsg({ name: 'Error', message: 'That subdomain is taken.' }, 'Could not save')"), 'That subdomain is taken.', 'a server message is kept');
    assert.doesNotMatch(w.eval("netErrMsg(new TypeError('Failed to fetch'), 'Could not save')"), /Failed to fetch/, 'a browser error text is not shown');
    await new Promise((r) => setTimeout(r, 800));
    close();
  });
}
