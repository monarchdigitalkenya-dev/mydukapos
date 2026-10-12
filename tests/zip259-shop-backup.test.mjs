// zip 259: Permanent Shops Backup & Restore - the owner-console buttons in a REAL browser (headless Chromium), the REAL server code over fake KV / D1 /
// shop-database (Durable Object) bindings. Export from "old" deployment A, restore into an empty "new" deployment B, compare.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';

let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = (!chromium && 'Playwright not installed') || (!hasSqlite && 'node:sqlite missing');
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);

async function world(label) {
  const kv = makeKV(); kv.data.set('owner-session:tok', { value: '1' });
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), SHOP_STORE: await makeBinding(), ROOT_DOMAIN: 'mydukapos.store' };
  return { label, kv, env };
}
async function seed(w) {
  const lic = await load('functions/api/_license.js'), led = await load('functions/api/_ledger.js'), st = await load('functions/api/_state-store.js');
  const a = await lic.createClient(w.env, 'permanent', 'Alpha Hardware', 'shop');
  const b = await lic.createClient(w.env, 'permanent', 'Beta Hotel', 'hotel');
  const demo = await lic.createClient(w.env, 'demo', 'Demo Co', 'shop');
  await w.kv.delete('pos-data:mode:' + b.id); st.forgetShopMode(w.env, b.id);                    // Beta is a plain KV shop, Alpha a database (Durable Object) shop
  await st.shopCall(w.env, a.id, 'push', { body: { businessName: 'Alpha Hardware', pwHash: 'hashA', inventory: [{ code: 'A', name: 'Nails', qty: 9, price: 5, updatedAt: 5 }], customers: [{ id: 'c1', name: 'Jane', phone: '0712345678', updatedAt: 5 }], salesLog: [{ id: 's1', refNumber: 'R1', timestamp: '2026-10-01T08:00:00.000Z', paymentMethod: 'cash', cashAmount: 50, servedBy: 'Ann', items: [{ code: 'A', name: 'Nails', qty: 10, price: 5 }], updatedAt: 1000 }] }, serverNow: Date.now() });
  await w.kv.put('pos-data:state:' + b.id, JSON.stringify({ businessName: 'Beta Hotel', pwHash: 'hashB', inventory: [{ code: 'R1', name: 'Room', qty: 3, price: 900, updatedAt: 5 }] }));
  await w.kv.put('receipt-settings:' + b.id, JSON.stringify({ footer: 'Thanks' }));
  await w.kv.put('gateway-config:v1:' + b.id, 'SEALED-SECRET');                                    // must NEVER travel
  await w.kv.put('staff-sess:' + b.id + ':x', 'session');                                            // must NEVER travel
  await w.kv.put('callback-key:c2b:' + b.id, '{"k":"secret"}');
  await w.kv.put('till-payment:' + b.id + ':QAB1', JSON.stringify({ amount: 10, trusted: true }));
  await w.kv.put('till-payment:' + demo.id + ':QDEMO', JSON.stringify({ amount: 1 }));              // a demo shop's record is left out
  await led.recordPush(w.env, a.id, { salesLog: [{ id: 's1', refNumber: 'R1', timestamp: '2026-10-01T08:00:00.000Z', paymentMethod: 'cash', cashAmount: 50, servedBy: 'Ann', items: [{ code: 'A', name: 'Nails', qty: 10, price: 5 }], updatedAt: 1000 }] });
  await led.recordPush(w.env, b.id, { salesLog: [{ id: 'b1', refNumber: 'B1', timestamp: '2026-10-02T09:30:00.000Z', paymentMethod: 'mpesa', mpesaAmount: 900, mpesaReceiptNumber: 'QWE1234567', servedBy: 'Bob', items: [{ code: 'R1', name: 'Room', qty: 1, price: 900 }], updatedAt: 2000 }] });
  const till = await load('functions/api/_till-store.js'); await till.ensureTillSchema(w.env.LEDGER_DB); await till.insertTill(w.env.LEDGER_DB, b.id, { code: 'QAB1', amount: 10, paidAt: 5, name: 'Pat', receivedAt: 6 });
  const acct = await load('functions/api/_account.js');
  await acct.saveAccount(w.env, { email: 'alpha@example.com', phone: '0712345678', fullName: 'Alpha Owner', passwordHash: 'HASH', salt: 'SALT', demoClientId: a.id, createdAt: 1, product: 'shop', approvalStatus: 'approved' });
  await w.kv.put('demo-account-session:abc', 'alpha@example.com');
  return { a, b, demo };
}
const HARNESS = (() => { const s = fs.readFileSync(path.join(ROOT, 'owner/index.html'), 'utf8'); const i = s.indexOf('<!-- SHOP BACKUP & RESTORE'); const j = s.indexOf('</script>', i) + 9; return '<!doctype html><html><body><div id="permanent-links-tab"></div><script>function ownerAuthHeaders(){return {Authorization:"Bearer tok"}}</script>' + s.slice(i, j) + '</body></html>'; })();

async function open(browser, w, { auth = true } = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true }); const page = await ctx.newPage();
  const m = await load('functions/api/owner-backup.js'); const seen = [];
  await page.route('http://x.test/api/owner-backup', async (route) => {
    const req = route.request(); seen.push(req.postData());
    const r = await m.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-backup', { method: 'POST', body: req.postData(), headers: auth ? { Authorization: 'Bearer tok' } : {} }), env: w.env });
    await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() });
  });
  await page.route('http://x.test/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: HARNESS }));
  await page.goto('http://x.test/'); return { page, ctx, seen };
}

test('export from deployment A, restore into empty deployment B: shops, links, data, logins and counts match; secrets never travel; retry is safe', { skip, timeout: 240000 }, async () => {
  const A = await world('A'), B = await world('B'), { a, b, demo } = await seed(A);
  const browser = await chromium.launch();
  try {
    // ---------------- export (old deployment)
    const x = await open(browser, A);
    await x.page.click('#sb-export'); await x.page.waitForSelector('#sb-go');
    const dlP = x.page.waitForEvent('download', { timeout: 60000 }); dlP.catch(() => {}); await x.page.click('#sb-go');
    await x.page.waitForSelector('#sb-final .sb-note', { timeout: 60000 }).catch(async () => { throw new Error('export did not finish: ' + (await x.page.textContent('#sb-stage')) + ' | ' + (await x.page.textContent('#sb-log'))); });
    const fin = await x.page.textContent('#sb-final'); if (!/Complete\./.test(fin)) throw new Error('export: ' + fin + ' | ' + (await x.page.textContent('#sb-log')));
    const dl = await dlP;
    const file = path.join(ROOT, 'tests', '.tmp-backup.mdpbackup.gz'); await dl.saveAs(file);
    await x.page.waitForSelector('#sb-final .sb-note', { timeout: 60000 });
    assert.match(await x.page.textContent('#sb-final'), /Complete\./, await x.page.textContent('#sb-final'));
    const raw = (await import('node:zlib')).gunzipSync(fs.readFileSync(file)).toString('utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].format, 'mydukapos-permanent-shops-backup'); assert.equal(lines[0].version, 1);
    const shops = lines.filter((l) => l.t === 'shop'); assert.deepEqual(shops.map((s) => s.slug).sort(), ['alpha-hardware', 'beta-hotel']);
    assert.ok(!shops.some((s) => s.id === demo.id), 'demo shops are excluded');
    assert.equal(shops.find((s) => s.id === a.id).record.id, a.id, 'the original c code is in the record');
    for (const secret of ['SEALED-SECRET', '"k":"secret"', 'QDEMO']) assert.ok(!raw.includes(secret), 'never exported: ' + secret);
    const kvKeys = lines.filter((l) => l.t === 'kv').map((l) => l.key); for (const bad of ['gateway-config', 'staff-sess', 'callback-key', 'demo-account-session', 'license:']) assert.ok(!kvKeys.some((k) => k.startsWith(bad)), 'key never exported: ' + bad);
    assert.ok(lines[0].excludedKeyPrefixes['gateway-config:'] === 1, 'the header counts what was left out');
    assert.ok(raw.includes('hashA') && raw.includes('"salt":"SALT"') && raw.includes('"passwordHash":"HASH"'), 'password / PIN hashes are kept so logins survive');
    assert.equal(lines.at(-1).t, 'trailer'); assert.equal(lines.at(-1).complete, true);
    assert.ok(lines.filter((l) => l.t === 'row').some((l) => l.table === 'till_payments'), 'till payments travel too');

    // ---------------- restore (new deployment)
    const y = await open(browser, B);
    await y.page.click('#sb-restore'); await y.page.setInputFiles('#sb-file', file);
    await y.page.waitForSelector('#sb-do', { timeout: 60000 });
    const preview = await y.page.textContent('#sb-prev');
    assert.match(preview, /Integrity check passed/); assert.match(preview, /alpha-hardware\.mydukapos\.store/); assert.match(preview, /Beta Hotel/);
    assert.equal(await y.page.isDisabled('#sb-do'), false);
    y.page.on('dialog', (d) => d.accept());
    await y.page.click('#sb-do'); await y.page.waitForSelector('#sb-final table', { timeout: 120000 });
    const report = await y.page.textContent('#sb-final'); assert.match(report, /All restored shops verified/, report);

    const lic = await load('functions/api/_license.js');
    for (const s of [a, b]) {
      const got = await lic.getLicense(B.env, s.id); assert.ok(got, 'licence restored'); assert.equal(got.slug, s.slug); assert.equal(got.product, s.product); assert.equal(got.type, 'permanent'); assert.equal(got.createdAt, s.createdAt, 'timestamps kept');
      assert.equal(await B.kv.get('slug:' + s.slug), s.id, 'subdomain maps to the original c code');
    }
    assert.equal(await B.kv.get('receipt-settings:' + b.id), JSON.stringify({ footer: 'Thanks' }));
    assert.equal(await B.kv.get('gateway-config:v1:' + b.id), null, 'credentials stay behind');
    assert.ok(JSON.parse(await B.kv.get('pos-data:state:' + b.id)).inventory[0].name === 'Room', 'KV shop state restored');
    const st = await load('functions/api/_state-store.js');
    const aState = JSON.parse(await (await st.shopCall(B.env, a.id, 'export', {})).text());
    assert.equal(aState.inventory[0].name, 'Nails'); assert.equal(aState.salesLog[0].id, 's1'); assert.equal(aState.customers[0].name, 'Jane'); assert.equal(aState.pwHash, 'hashA');
    const q = (w, sql, ...p) => w.env.LEDGER_DB.query ? w.env.LEDGER_DB.query(sql, ...p) : null;
    const rowsA = A.env.LEDGER_DB.query('select sale_id, ts, total from ledger_sales order by sale_id'), rowsB = B.env.LEDGER_DB.query('select sale_id, ts, total from ledger_sales order by sale_id');
    assert.deepEqual(rowsB, rowsA, 'sales rows identical, timestamps included');
    assert.equal(B.env.LEDGER_DB.query("select count(*) n from till_payments")[0].n, 1);
    const acc = await load('functions/api/_account.js'); const ac = await acc.getAccount(B.env, 'alpha@example.com'); assert.equal(ac.passwordHash, 'HASH'); assert.equal(ac.demoClientId, a.id);
    assert.equal(await B.kv.get('demo-account-session:abc'), null, 'sessions are not restored');
    assert.equal(await lic.getLicense(B.env, demo.id), null, 'demo shop not restored');

    // ---------------- running the same file again changes nothing (no duplicates), and says the shops already exist
    const before = { sales: B.env.LEDGER_DB.query('select count(*) n from ledger_sales')[0].n, audit: B.env.LEDGER_DB.query('select count(*) n from ledger_payments')[0].n, keys: B.kv.data.size };
    const z = await open(browser, B); z.page.on('dialog', (d) => d.accept());
    await z.page.click('#sb-restore'); await z.page.setInputFiles('#sb-file', file); await z.page.waitForSelector('#sb-do', { timeout: 60000 });
    assert.match(await z.page.textContent('#sb-prev'), /Already here/);
    await z.page.click('#sb-do'); await z.page.waitForSelector('#sb-final table', { timeout: 120000 });
    assert.match(await z.page.textContent('#sb-final'), /All restored shops verified/);
    assert.equal(B.env.LEDGER_DB.query('select count(*) n from ledger_sales')[0].n, before.sales); assert.equal(B.env.LEDGER_DB.query('select count(*) n from ledger_payments')[0].n, before.audit);
    assert.equal(B.kv.data.size, before.keys, 'no extra keys');

    // ---------------- a damaged file is refused BEFORE anything changes
    const bad = raw.replace('Nails', 'Nailz'); const badFile = path.join(ROOT, 'tests', '.tmp-bad.mdpbackup'); fs.writeFileSync(badFile, bad);
    const C = await world('C'); const c = await open(browser, C); await c.page.click('#sb-restore'); await c.page.setInputFiles('#sb-file', badFile);
    await c.page.waitForSelector('#sb-prev .sb-note.e', { timeout: 60000 });
    assert.match(await c.page.textContent('#sb-prev'), /integrity check failed/i); assert.equal(C.kv.data.size, 1, 'nothing was written (only the test session key exists)');
    fs.rmSync(badFile, { force: true });

    // ---------------- a conflicting shop in the new deployment stops the restore until the owner chooses
    const D = await world('D'); await (await load('functions/api/_license.js')).createClient(D.env, 'permanent', 'Alpha Hardware', 'shop');
    const d = await open(browser, D); await d.page.click('#sb-restore'); await d.page.setInputFiles('#sb-file', file); await d.page.waitForSelector('#sb-do', { timeout: 60000 });
    assert.match(await d.page.textContent('#sb-prev'), /CONFLICT/); assert.equal(await d.page.isDisabled('#sb-do'), true, 'restore waits for a decision');
    fs.rmSync(file, { force: true });
  } finally { await browser.close(); fs.rmSync(path.join(ROOT, 'tests', '.tmp-backup.mdpbackup.gz'), { force: true }); }
});

test('only the platform owner can use the backup endpoint', async () => {
  const w = await world('A'); const m = await load('functions/api/owner-backup.js');
  for (const headers of [{}, { Authorization: 'Bearer nope' }]) {
    const r = await m.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-backup', { method: 'POST', body: JSON.stringify({ op: 'x-shops' }), headers }), env: w.env });
    assert.equal(r.status, 401);
  }
  const g = await m.onRequestGet({}); assert.equal(g.status, 405);
  const ok = await m.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-backup', { method: 'POST', body: JSON.stringify({ op: 'x-schema' }), headers: { Authorization: 'Bearer tok' } }), env: w.env });
  assert.equal(ok.status, 200); assert.match(ok.headers.get('cache-control'), /no-store/);
});
