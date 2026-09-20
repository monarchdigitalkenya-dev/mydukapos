import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APPS, boot, ROOT } from './helpers.mjs';

for (const app of [...APPS, 'owner/index.html']) {
  test(`${app}: uncaught errors are reported once, noise is ignored`, async () => {
    const calls = [];
    const fetch = (u, o) => { calls.push({ u: String(u), body: o && o.body }); return Promise.resolve({ ok: true, status: 204, json: async () => ({}) }); };
    const { w, close } = await boot(app, { fetch, wait: 900 });
    calls.length = 0;
    const err = () => new w.ErrorEvent('error', { message: 'boom is not defined', error: Object.assign(new Error('boom is not defined'), { stack: 'ReferenceError: boom is not defined\n    at x (a.js:1:1)' }), filename: 'https://x/index.html', lineno: 10, colno: 2 });
    w.dispatchEvent(err());
    w.dispatchEvent(err());                                                                      // duplicate
    w.dispatchEvent(new w.ErrorEvent('error', { message: 'ResizeObserver loop limit exceeded' })); // known noise
    w.dispatchEvent(Object.assign(new w.Event('unhandledrejection'), { reason: new Error('promise went wrong') }));
    const reports = calls.filter((c) => c.u.includes('/api/client-log')).map((c) => JSON.parse(c.body));
    assert.equal(reports.length, 2, 'one report per distinct error: ' + JSON.stringify(reports.map((r) => r.message)));
    assert.equal(reports[0].message, 'boom is not defined');
    assert.equal(reports[0].kind, 'error');
    assert.equal(reports[1].kind, 'promise');
    assert.match(reports[0].stack, /ReferenceError/);
    close();
  });
}

test('owner console: Errors tab lists grouped errors', async () => {
  const data = { days: ['2026-09-19'], total: 7, errors: [
    { fp: 'a1', app: 'hotel', kind: 'error', message: 'Cannot read properties of undefined', stack: 'TypeError\n at f', count: 5, shopCount: 2, last: Date.now(), ua: 'Chrome' },
    { fp: 'b2', app: 'water', kind: 'promise', message: 'x <b>bold</b>', count: 2, shopCount: 1, last: Date.now() } ] };
  const fetch = (u) => Promise.resolve({ ok: true, status: 200, json: async () => (String(u).includes('/api/client-log') ? data : {}) });
  const { w, d, close } = await boot('owner/index.html', { fetch, wait: 900 });
  assert.ok(d.getElementById('errors-tab-btn'), 'tab button');
  await w.eval('loadClientErrors()');
  const html = d.getElementById('errors-list').innerHTML;
  assert.match(html, /Cannot read properties of undefined/);
  assert.match(html, /×5/);
  assert.ok(!html.includes('<b>bold</b>'), 'error text must be escaped');
  d.getElementById('errors-app-filter').value = 'water';
  w.eval('renderClientErrors()');
  assert.ok(!d.getElementById('errors-list').innerHTML.includes('Cannot read'));
  close();
});

test('client-log server: dedupes, requires owner to read, survives garbage', async () => {
  const { onRequestPost, onRequestGet } = await import(pathToFileURL(path.join(ROOT, 'functions/api/client-log.js')).href);
  const store = new Map();
  const kv = { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } };
  store.set('license:C1', JSON.stringify({ id: 'C1', type: 'permanent', slug: 'shop' }));
  store.set('owner-session:tok', '1');
  const env = { mydukapos_kv: kv };
  const post = (body, q = '?c=C1') => onRequestPost({ request: new Request('https://x.pages.dev/api/client-log' + q, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), env });
  const get = (auth) => onRequestGet({ request: new Request('https://x.pages.dev/api/client-log', { headers: auth ? { Authorization: 'Bearer ' + auth } : {} }), env });

  const rep = { app: 'hotel', kind: 'error', message: 'boom', stack: 'E\n at f (https://a/b/x.js:1:2)' };
  assert.equal((await post(rep)).status, 204);
  await post(rep); await post(rep);
  await post({ app: 'water', message: 'other' }, '?c=C2');
  assert.equal((await post('x'.repeat(9000))).status, 204);
  assert.equal((await post('not json')).status, 204);
  assert.equal((await get()).status, 401);
  assert.equal((await get('wrong')).status, 401);
  const out = await (await get('tok')).json();
  assert.equal(out.errors.length, 2);
  assert.equal(out.errors.find((e) => e.app === 'hotel').count, 3);
});
