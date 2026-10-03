import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, APPS, boot, until } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';

// Zip 194 — device pairing is gone: a shop whose KV record says mode 'paired' must still serve EVERY device, with or without
// X-Device-Id / X-Device-Token. Server side (real function code over the fake KV / D1) and client side (real app in jsdom + static checks).
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
const PAIRED = JSON.stringify({ mode: 'paired', devices: { dev_1: { h: 'x'.repeat(64), name: 'old', pairedAt: 1, pairedBy: 'x', revoked: true } } });
function shop() {
  const kv = makeKV(); seedShop(kv, 'C1');
  kv.data.set('device-auth:C1', { value: PAIRED });
  return { kv, env: { mydukapos_kv: kv, LEDGER_DB: makeD1() } };
}
const req = (name, method = 'GET', body, headers = {}) => new Request(`https://x.pages.dev/api/${name}?c=C1`, { method, body: method === 'GET' ? undefined : (body === undefined ? '{}' : JSON.stringify(body)), headers: { 'content-type': 'application/json', ...headers } });
const notRefused = async (r) => {
  if (r.status !== 401) return true;
  let b = {}; try { b = await r.clone().json(); } catch (e) { /* none */ }
  return b.code !== 'device_not_paired';
};

test('deviceGuard never refuses: paired record, no headers, wrong headers, revoked device, unreadable KV', async () => {
  const dev = await load('functions/api/_device-auth.js');
  const { env } = shop();
  assert.equal(await dev.deviceGuard(req('pos-sync'), env, 'C1', {}), null, 'no headers');
  assert.equal(await dev.deviceGuard(req('pos-sync', 'GET', undefined, { 'X-Device-Id': 'dev_zzz', 'X-Device-Token': 'nope' }), env, 'C1', {}), null, 'unknown device + bad token');
  assert.equal(await dev.deviceGuard(req('pos-sync', 'GET', undefined, { 'X-Device-Id': 'dev_1', 'X-Device-Token': 'nope' }), env, 'C1', {}), null, 'revoked device');
  assert.equal(await dev.deviceGuard(req('pos-sync'), { mydukapos_kv: { get: async () => { throw new Error('kv down'); } } }, 'C1', {}), null, 'KV error');
  assert.equal((await dev.readDeviceAuth(env, 'C1', { fresh: true })).mode, 'open', 'a stored "paired" is reported as open');
});

test('pos-sync GET and POST succeed for a "paired" shop with NO device headers', async () => {
  const { env } = shop();
  const m = await load('functions/api/pos-sync.js');
  const g = await m.onRequestGet({ request: req('pos-sync'), env, waitUntil() {} });
  assert.equal(g.status, 200);
  const p = await m.onRequestPost({ request: req('pos-sync', 'POST', { inventory: [{ code: 'A', name: 'Alpha', qty: 5, price: 10, updatedAt: Date.now() }] }), env, waitUntil() {} });
  assert.equal(p.status, 200, 'writes are accepted too');
  const g2 = await m.onRequestGet({ request: req('pos-sync'), env, waitUntil() {} });
  assert.equal(g2.status, 200);
  assert.ok(JSON.stringify(await g2.json()).includes('Alpha'), 'and what was written can be read back');
});

test('sync-have, history, store, till-payments, ledger, day-summary, stock-integrity, backups, branches ... are not refused for a "paired" shop without headers', async () => {
  const { env } = shop();
  const calls = [
    ['sync-have', 'onRequestPost', 'POST', { slices: {} }],
    ['history', 'onRequestGet', 'GET'],
    ['store', 'onRequestGet', 'GET'],
    ['till-payments', 'onRequestGet', 'GET'],
    ['ledger', 'onRequestGet', 'GET'],
    ['day-summary', 'onRequestGet', 'GET'],
    ['stock-integrity', 'onRequestGet', 'GET'],
    ['backups', 'onRequestGet', 'GET'],
    ['branches', 'onRequestGet', 'GET'],
    ['media', 'onRequestGet', 'GET'],
    ['print-relay', 'onRequestGet', 'GET'],
    ['mpesa-status', 'onRequestGet', 'GET'],
    ['sms-config', 'onRequestGet', 'GET'],
    ['device-pair', 'onRequestGet', 'GET'],
  ];
  for (const [name, fn, method, body] of calls) {
    const m = await load(`functions/api/${name}.js`);
    if (typeof m[fn] !== 'function') continue;
    let r;
    try { r = await m[fn]({ request: req(name, method, body), env, waitUntil() {}, params: {} }); } catch (e) { continue; }   // a missing binding is not a pairing refusal
    assert.ok(await notRefused(r), `${name} ${method} must not answer 401 device_not_paired (got ${r.status})`);
  }
});

test('EVERY endpoint module: no handler answers device_not_paired for a "paired" shop with no headers (also guards future endpoints)', async () => {
  const dir = path.join(ROOT, 'functions/api');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
  let ran = 0;
  for (const f of files) {
    const m = await load('functions/api/' + f);
    for (const [fn, method] of [['onRequestGet', 'GET'], ['onRequestPost', 'POST'], ['onRequestPut', 'PUT'], ['onRequestDelete', 'DELETE']]) {
      if (typeof m[fn] !== 'function') continue;
      const { env } = shop();
      let r;
      try { r = await Promise.race([Promise.resolve(m[fn]({ request: req(f.replace(/\.js$/, ''), method), env, waitUntil() {}, params: {} })), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000))]); } catch (e) { continue; }
      if (!r || typeof r.status !== 'number') continue;
      ran++;
      assert.ok(await notRefused(r), `${f} ${method} answered 401 device_not_paired`);
    }
  }
  assert.ok(ran > 40, 'the sweep really ran (' + ran + ' handlers)');
  const src = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  // the only place the code may still be mentioned is as the old text inside comments / the retired-guard note: no handler may build that response
  assert.equal((src.match(/code:\s*'device_not_paired'/g) || []).length, 0, 'no endpoint produces device_not_paired any more');
});

test('device-pair: every action works for a device that is not paired; "mode" is accepted but ignored; revoke is harmless', async () => {
  const { kv, env } = shop();
  const m = await load('functions/api/device-pair.js');
  const post = (body, h = {}) => m.onRequestPost({ request: req('device-pair', 'POST', body, h), env });
  const dev = { 'X-Device-Id': 'dev_new' };
  assert.equal((await m.onRequestGet({ request: req('device-pair', 'GET', undefined, dev), env })).status, 200, 'device list readable by anyone with the link');
  const l = await (await m.onRequestGet({ request: req('device-pair', 'GET', undefined, dev), env })).json();
  assert.equal(l.mode, 'open'); assert.ok(Array.isArray(l.devices));
  assert.equal((await post({ action: 'rename', name: 'Front till' }, dev)).status, 200, 'rename needs no pairing');
  assert.equal((await post({ action: 'code' }, dev)).status, 200, 'no "Pair this device first"');
  assert.equal((await post({ action: 'mode', mode: 'paired', proof: 'f'.repeat(64) }, dev)).status, 403, 'wrong password still refused');
  const rec = JSON.parse(kv.data.get('device-auth:C1').value);
  assert.notEqual(rec.mode, 'paired', 'nothing ever stores paired mode again once written through the API');
});

test('owner-health "mode paired" is harmless: it stores open', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'functions/api/owner-health.js'), 'utf8');
  assert.match(src, /rec\.mode = 'open'/);
  assert.doesNotMatch(src, /rec\.mode = body\.mode === 'paired'/);
});

// ---------------------------------------------------------------- client

test('static: no synced app contains the pairing screen, "Pair this device", or the scary retry bar wording', () => {
  const files = [...APPS, 'owner/index.html'];
  for (const f of files) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/id\s*=\s*'device-pair-screen'|el\.id = 'device-pair-screen'/.test(html), f + ': the pair modal is not built');
    assert.ok(!html.includes('dps-go') && !html.includes('dps-later'), f + ': no pair buttons');
    assert.ok(!/Keep working offline/.test(html), f + ': no "Keep working offline" prompt');
    assert.ok(!/Pair this device first/.test(html), f + ': manual sync does not say "Pair this device first"');
    assert.ok(!/posnet-retry-btn/.test(html), f + ': no Retry button');
    assert.ok(!/The server is not answering\. Sales are kept/.test(html), f + ': no scary bar text');
    assert.ok(!/Your internet works, but the POS server is not answering/.test(html), f + ': no "not answering" status text');
  }
  const ds = fs.readFileSync(path.join(ROOT, 'src/shared/blocks/device-security.html'), 'utf8');
  assert.ok(!/showPairScreen\(\)\s*\{|function showPairScreen/.test(ds), 'no showPairScreen function');
  assert.match(ds, /Pairing is no longer needed - every device with the shop link can sync\./);
  assert.ok(!/data-ds="(pair|code|mode|revoke)"/.test(ds), 'no pair / code / require-paired / revoke buttons');
  const sj = fs.readFileSync(path.join(ROOT, 'src/shared/blocks/sales-journal.html'), 'utf8');
  assert.ok(!/Pair this device/.test(sj) && !/showDevicePairScreen/.test(sj));
});

test('client: an OLD server answering 401 device_not_paired to everything never shows a pair screen, never sets auth_required, and the retry bar / red state do not appear', async () => {
  let notPaired = 0;
  const fetch = (u) => {
    const url = String(u);
    if (/\/api\/health/.test(url)) return Promise.resolve(json({ ok: true }));
    if (/\/api\//.test(url)) { notPaired++; return Promise.resolve(json({ error: 'This device is not paired with the shop yet.', code: 'device_not_paired' }, 401)); }
    return Promise.resolve(json({}, 404));
  };
  const t = await boot('index.html', { fetch, wait: 800, storage: { pos_biz_name: 'Biz', pos_pw_hash: 'a'.repeat(64) }, beforeParse: (w) => { w.__posNetRetryBarMs = 0; } });
  await t.w.eval('pullStateOnce()');
  await t.w.eval('pullStateOnce()');
  t.w.eval("PosNet.reportHttp(401, 'device_not_paired'); PosNet.report('auth', 'device_not_paired')");
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(notPaired > 0, 'the old server really refused');
  assert.equal(t.d.getElementById('device-pair-screen'), null, 'no pair modal');
  assert.ok(!/Pair this device/i.test(t.d.body.textContent), 'no "Pair this device" anywhere on the page');
  assert.notEqual(t.w.eval('PosNet.state'), 'auth_required');
  assert.doesNotMatch(t.w.eval('PosNet.message()'), /paired/i);
  assert.equal(t.d.getElementById('posnet-retry-bar'), null);
  assert.equal(typeof t.w.eval('window.showDevicePairScreen'), 'function', 'old callers do not throw');
  t.w.eval('window.showDevicePairScreen()');
  assert.equal(t.d.getElementById('device-pair-screen'), null, 'even an explicit call cannot open the modal');
  t.close();
});

test('client: backend_unavailable / offline show only a small non-blocking pill; the wording never says the server is not answering', async () => {
  const t = await boot('index.html', { fetch: () => Promise.reject(new Error('down')), wait: 600, beforeParse: (w) => { w.__posNetRetryBarMs = 0; } });
  t.w.__posNetInternetProbe = () => Promise.resolve(true); t.w.__posNetOwnProbe = () => Promise.resolve(true); t.w.__posNetSyncProbe = () => Promise.resolve({ kind: 'none' });
  await t.w.eval('PosNet.check("test")');
  assert.equal(t.w.eval('PosNet.state'), 'backend_unavailable', 'the state machine still works');
  assert.ok(await until(() => t.d.getElementById('posnet-offline-pill'), 3000));
  const pill = t.d.getElementById('posnet-offline-pill');
  assert.equal(pill.textContent, 'Saving on this device - will sync automatically');
  assert.match(pill.style.cssText, /pointer-events:\s*none/, 'never blocks a tap');
  assert.equal(pill.querySelector('button'), null);
  assert.doesNotMatch(t.w.eval('PosNet.message()'), /not answering|POS server/i);
  assert.equal(t.d.getElementById('posnet-retry-bar'), null);
  t.close();
});
