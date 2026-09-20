import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';

// A new device on a database shop gets a recent window; the older history is fetched quietly, page by page, and merged in.
const DAY = 86400000;
const now = Date.now();
const sale = (id, age) => ({ id, timestamp: new Date(now - age * DAY).toISOString(), paymentMethod: 'cash' });
const OLD = Array.from({ length: 2500 }, (_, i) => sale('old' + String(i).padStart(4, '0'), 130 + (i % 40)));   // older than the 120-day window

function historyFetch(log) {
  return async (url) => {
    const u = new URL(String(url), 'https://demo.mydukapos.store');
    if (!u.pathname.endsWith('/api/history')) return { ok: false, status: 404, json: async () => ({}) };
    log.push(u.search);
    const col = u.searchParams.get('col');
    const rows = col === 'salesLog' ? OLD : [];
    const limit = Number(u.searchParams.get('limit'));
    const after = u.searchParams.get('after');
    const start = after ? rows.findIndex((r) => r.id === after.split(':')[1]) + 1 : 0;
    const page = rows.slice(start, start + limit);
    const next = start + limit < rows.length ? `${Date.parse(page.at(-1).timestamp)}:${page.at(-1).id}` : null;
    return { ok: true, status: 200, json: async () => ({ records: page, next }) };
  };
}

for (const app of APPS.filter((a) => a !== 'owner/index.html')) {
  test(`${app}: older history is fetched in the background, merged in order, saved, and not sent back to the server`, async () => {
    const calls = [];
    const { w, errors, close } = await boot(app, { fetch: historyFetch(calls), wait: 300 });
    const key = JSON.parse(w.eval('JSON.stringify(window.__LOG_KEYS)')).salesLog;
    w.eval(`salesLog = ${JSON.stringify([sale('recent1', 5), sale('recent2', 1)])}`);
    // this session has already pushed once, so the acknowledged-records map exists
    w.eval("window.__pushAck = { salesLog: new Map([['i:recent1', pushSigOf(salesLog[0])], ['i:recent2', pushSigOf(salesLog[1])]]) }");
    const hotFrom = now - 120 * DAY;
    assert.equal(await w.eval(`hydrateOlderHistory(${hotFrom})`), true);
    assert.equal(w.eval('salesLog.length'), 2502);
    const ids = JSON.parse(w.eval('JSON.stringify(salesLog.map(s => s.id))'));
    assert.equal(ids.at(-1), 'recent2', 'newest last');
    assert.ok(ids.indexOf('old0000') < ids.indexOf('recent1'), 'older history sits before the recent sales');
    assert.equal(JSON.parse(w.localStorage.getItem(key)).length, 2502, 'saved on the device');
    assert.equal(calls.filter((c) => c.includes('col=salesLog')).length, 3, '2,500 records = 3 pages of 1,000');
    assert.equal(w.eval('slimPayloadForPush({ salesLog }).body.salesLog.length'), 0, 'the fetched records are not pushed back');
    // only once per install
    const before = calls.length;
    assert.equal(await w.eval(`hydrateOlderHistory(${hotFrom})`), false);
    assert.equal(calls.length, before, 'no more requests');
    assert.deepEqual(errors, []);
    close();
  });
}

test('it never fills a device: it stops when the device is more than half full, and it leaves the flag unset only on failure', async () => {
  const calls = [];
  const a = await boot('index.html', { fetch: historyFetch(calls), wait: 300 });
  a.w.eval('salesLog = []; window.__storageUsedChars = () => 3000000');           // already 60% full
  await a.w.eval(`hydrateOlderHistory(${now - 120 * DAY})`);
  assert.equal(calls.length, 0, 'no requests at all');
  assert.equal(a.w.eval('salesLog.length'), 0);
  a.close();

  const b = await boot('index.html', { fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }), wait: 300 });
  b.w.eval('salesLog = []');
  await b.w.eval(`hydrateOlderHistory(${now - 120 * DAY})`);
  assert.notEqual(b.w.localStorage.getItem('pos_hydrated_v1'), '1', 'a failed attempt is retried next session');
  b.close();
});

test('a pull that carries a hot-window marker schedules the fetch; a plain pull does not', async () => {
  const calls = [];
  const { w, close } = await boot('index.html', { fetch: historyFetch(calls), wait: 300 });
  w.eval('salesLog = []');
  w.eval('window.__scheduled = 0; const _st = window.setTimeout; window.setTimeout = function (fn, ms) { if (ms === 4000) { window.__scheduled++; return 0; } return _st.apply(window, arguments); }');
  w.eval('preparePulledPayload({ updatedAt: 1, salesLog: [] })');
  assert.equal(w.eval('window.__scheduled'), 0);
  w.eval(`preparePulledPayload({ updatedAt: 1, salesLog: [], _hotFrom: ${now} })`);
  assert.equal(w.eval('window.__scheduled'), 1);
  close();
});
