import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Owner Console 💾 Storage tab: renders the list from /api/owner-storage, shows the alert + badge, and drives Compress.
const SHOPS = {
  policy: { warn: 8 * 1048576, max: 24 * 1048576, autoCompress: 6 * 1048576 },
  shops: [
    { id: 'A', label: 'Refused Shop', slug: 'refused', bytes: 26 * 1048576, stored: 26 * 1048576, gz: false, at: Date.now(), writers: [{ ip: '41.1.1.1', cc: 'KE' }], level: 'refused', rejected: { bytes: 26 * 1048576, at: Date.now() } },
    { id: 'B', label: 'Large Shop', slug: 'large', bytes: 9 * 1048576, stored: 9 * 1048576, gz: false, at: Date.now(), writers: [], level: 'warn' },
    { id: 'C', label: 'Small Shop', slug: 'small', bytes: 120000, stored: 120000, gz: false, at: Date.now(), writers: [], level: 'ok' },
    { id: 'D', label: 'Never Measured', slug: null, bytes: null, stored: null, gz: false, at: null, writers: [], level: 'unknown' },
  ],
  rateLimited: [{ name: 'sms', clientId: 'C', label: 'Small Shop', limit: 1500, count: 3, first: 1, last: Date.now() }],
  serverNow: Date.now(),
};

test('Storage tab lists shops, flags the big ones, and compresses through the API', async () => {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), method: opts.method || 'GET', body });
    if (String(url).includes('/api/owner-storage')) {
      if (body && body.action === 'compress') return { ok: true, status: 200, json: async () => ({ clientId: body.clientId, changed: true, gz: true, bytes: 9437184, storedBefore: 9437184, stored: 1200000, ratio: 7.9 }) };
      if (body && body.action === 'measure') return { ok: true, status: 200, json: async () => ({ clientId: body.clientId, bytes: 500000, stored: 500000, gz: false, fields: [{ name: 'salesLog', bytes: 400000, items: 900 }] }) };
      return { ok: true, status: 200, json: async () => SHOPS };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const { w, d, errors, close } = await boot('owner/index.html', { fetch, wait: 900 });
  await w.eval('loadStorage()');
  const rows = [...d.querySelectorAll('#storage-table tbody tr')];
  assert.equal(rows.length, 4);
  assert.match(rows[0].textContent, /Refused Shop/);
  assert.match(rows[0].textContent, /Refused — too big/);
  assert.match(rows[1].textContent, /Large/);
  assert.match(rows[3].textContent, /Not measured yet/);
  const alert = d.getElementById('storage-alert');
  assert.equal(alert.style.display, 'block');
  assert.match(alert.textContent, /no longer syncing/);
  assert.equal(d.getElementById('storage-alert-badge').textContent, '1', 'only a REFUSED shop earns a red badge — the rest archive themselves');
  assert.match(d.getElementById('storage-ratelimits').textContent, /Small Shop.*text messages/);

  await w.eval("storageMeasure('D')");
  assert.match(d.querySelector('#storage-table').textContent, /salesLog/);

  w.confirm = () => true;
  await w.eval("storageCompress('B', true)");
  const post = calls.find((c) => c.body && c.body.action === 'compress');
  assert.deepEqual(post.body, { action: 'compress', clientId: 'B' });
  assert.match(d.getElementById('storage-summary').textContent, /Compressed: .* → .* on disk \(7\.9× smaller\)/);
  assert.deepEqual(errors, []);
  close();
});

test('Storage tab: Archive asks for days, calls the API, and lists / restores archives', async () => {
  const calls = [];
  const arch = [{ id: '1700000000000', archivedAt: 1700000000000, keepDays: 90, counts: { salesLog: 120, stockMovementLog: 30 }, bytes: 250000 }];
  const fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push(body);
    if (!String(url).includes('/api/owner-storage')) return { ok: false, status: 404, json: async () => ({}) };
    if (body && body.action === 'archive') return { ok: true, status: 200, json: async () => ({ changed: true, counts: { salesLog: 120, stockMovementLog: 30 }, bytesBefore: 9000000, bytesAfter: 2000000, archiveId: '1700000000000' }) };
    if (body && body.action === 'archives') return { ok: true, status: 200, json: async () => ({ archives: arch }) };
    if (body && body.action === 'restoreArchive') return { ok: true, status: 200, json: async () => ({ restored: 150 }) };
    return { ok: true, status: 200, json: async () => SHOPS };
  };
  const { w, d, errors, close } = await boot('owner/index.html', { fetch, wait: 900 });
  await w.eval('loadStorage()');
  w.prompt = () => '60';
  w.confirm = () => true;
  await w.eval("storageArchive('B')");
  const post = calls.find((c) => c && c.action === 'archive');
  assert.deepEqual(post, { action: 'archive', clientId: 'B', keepDays: 60 });
  assert.match(d.getElementById('storage-summary').textContent, /Archived 150 records; the live shop went from 8\.58 MB to 1\.91 MB/);
  await w.eval("storageShowArchives('B')");
  assert.match(d.getElementById('storage-table').textContent, /120 salesLog, 30 stockMovementLog/);
  await w.eval("storageRestoreArchive('B', '1700000000000')");
  assert.match(d.getElementById('storage-summary').textContent, /Restored 150 records/);
  w.prompt = () => '3';                                        // below the 7-day floor: refused client-side
  const n = calls.length;
  await w.eval("storageArchive('B')");
  assert.equal(calls.length, n, 'no request for a silly value');
  assert.deepEqual(errors, []);
  close();
});

test('Storage tab: moving a shop to its own database (and back) goes through the API and shows database shops distinctly', async () => {
  const calls = [];
  const shops = JSON.parse(JSON.stringify(SHOPS));
  shops.shops[1].mode = 'db'; shops.shops[1].db = { bytes: 20000000, records: 61234 };
  shops.shops[1].level = 'ok';
  const fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push(body);
    if (!String(url).includes('/api/owner-storage')) return { ok: false, status: 404, json: async () => ({}) };
    if (body && body.action === 'migrate') return { ok: true, status: 200, json: async () => ({ changed: true, mode: 'db', records: 5000 }) };
    if (body && body.action === 'unmigrate') return { ok: true, status: 200, json: async () => ({ changed: true, mode: 'kv' }) };
    return { ok: true, status: 200, json: async () => shops };
  };
  const { w, d, errors, close } = await boot('owner/index.html', { fetch, wait: 900 });
  await w.eval('loadStorage()');
  const rows = [...d.querySelectorAll('#storage-table tbody tr')];
  assert.match(rows[1].textContent, /own database/);
  assert.match(rows[1].textContent, /61,234 records/);
  assert.match(rows[1].textContent, /Back to single record/);
  assert.doesNotMatch(rows[1].textContent, /Compress|Archive old history/, 'compress/archive are not offered for a database shop');
  assert.match(rows[2].textContent, /Move to database/);
  w.confirm = () => true;
  await w.eval("storageMigrate('C', true)");
  assert.deepEqual(calls.find((c) => c && c.action === 'migrate'), { action: 'migrate', clientId: 'C' });
  assert.match(d.getElementById('storage-summary').textContent, /now lives in its own database \(5,000 records\)/);
  await w.eval("storageMigrate('B', false)");
  assert.deepEqual(calls.find((c) => c && c.action === 'unmigrate'), { action: 'unmigrate', clientId: 'B' });
  assert.deepEqual(errors, []);
  close();
});

test('Storage tab: "Test the database" shows each step and a clear verdict', async () => {
  const fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (!String(url).includes('/api/owner-storage')) return { ok: false, status: 404, json: async () => ({}) };
    if (body && body.action === 'dbSelfTest') return { ok: true, status: 200, json: async () => ({ ok: false, steps: [{ name: 'SQL works', ok: true, ms: 3 }, { name: 'point-in-time restore is available', ok: false, soft: true, detail: 'no getCurrentBookmark' }, { name: 'transactions roll back', ok: false, detail: 'left its write behind' }] }) };
    return { ok: true, status: 200, json: async () => SHOPS };
  };
  const { w, d, errors, close } = await boot('owner/index.html', { fetch, wait: 900 });
  await w.eval('storageSelfTest()');
  const box = d.getElementById('storage-selftest');
  assert.equal(box.style.display, 'block');
  assert.match(box.textContent, /SQL works/);
  assert.match(box.textContent, /left its write behind/);
  assert.match(box.textContent, /do NOT move shops yet/);
  assert.deepEqual(errors, []);
  close();
});
