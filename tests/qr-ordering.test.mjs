import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { boot, ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';

// Zip 136 — secure QR / barcode ordering (master prompt §18–21, §36, §64, §74–75, §94 QR tests).
const mod = await import(pathToFileURL(path.join(ROOT, 'functions/api/qr-order.js')).href);
const call = async (env, c, body) => { const r = await mod.onRequestPost({ request: new Request(`https://x.pages.dev/api/qr-order?c=${c}`, { method: 'POST', body: JSON.stringify(body) }), env }); return { status: r.status, d: await r.json() }; };
const get = async (env, c, q) => { const r = await mod.onRequestGet({ request: new Request(`https://x.pages.dev/api/qr-order?c=${c}&${q}`), env }); return { status: r.status, d: await r.json() }; };
const MENU = { business: 'Lake View Hotel', items: [
  { code: 'BRG', name: 'Beef Burger', price: 650, category: 'Mains', modifierGroupIds: ['mg1'] },
  { code: 'TSK', name: 'Tusker Lager', price: 300, category: 'Beer' },
  { code: 'OUT', name: 'Sold out cake', price: 400, category: 'Cakes', available: false },
  { code: 'IMG', name: 'Pizza', price: 900, image: 'data:image/png;base64,AAAA' },
], modifierGroups: [{ id: 'mg1', name: 'Cooking', required: true, max: 1, options: [{ name: 'Medium', price: 0 }, { name: 'Well done', price: 0 }, { name: 'Extra cheese', price: 50 }] }] };
async function shop() {
  const kv = makeKV(); seedShop(kv, 'C1'); seedShop(kv, 'C2');
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1() };
  await call(env, 'C1', { action: 'publishMenu', menu: MENU });
  const t12 = (await call(env, 'C1', { action: 'create', kind: 'table', label: 'Table 12' })).d.code.token;
  const r205 = (await call(env, 'C1', { action: 'create', kind: 'room', label: 'Room 205' })).d.code.token;
  return { kv, env, t12, r205 };
}

test('codes are random tokens (never a table number); a valid scan shows only the published menu for THAT place', async () => {
  const { env, t12, r205 } = await shop();
  assert.match(t12, /^[A-Za-z0-9_-]{32}$/); assert.notEqual(t12, r205);
  assert.doesNotMatch(t12, /12|table/i);
  const r = await get(env, 'C1', `t=${t12}`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.d.business, r.d.location.label, r.d.location.kind], ['Lake View Hotel', 'Table 12', 'table']);
  assert.deepEqual(r.d.menu.items.map((i) => i.code), ['BRG', 'TSK', 'IMG'], 'the unavailable item is not offered');
  assert.equal(r.d.menu.items.find((i) => i.code === 'IMG').image, '', 'only R2 photo addresses are published (no embedded data)');
  assert.equal(JSON.stringify(r.d).includes('wholesale'), false);
});

test('QR security: invalid, manipulated, revoked, expired and other-business tokens all fail the same way', async () => {
  const { env, kv, t12 } = await shop();
  assert.equal((await get(env, 'C1', 't=garbage')).status, 404, 'invalid');
  assert.equal((await get(env, 'C1', `t=${t12.slice(0, -1)}${t12.endsWith('A') ? 'B' : 'A'}`)).status, 404, 'one character changed');
  assert.equal((await get(env, 'C2', `t=${t12}`)).status, 404, 'business A\'s code on business B\'s link');
  assert.equal((await call(env, 'C2', { action: 'order', t: t12, key: 'k-cross-tenant', items: [{ code: 'TSK', qty: 1 }] })).status, 404, 'no ordering across businesses');
  // regenerate: the old code stops at once, the new one works
  const regen = (await call(env, 'C1', { action: 'regenerate', token: t12 })).d.code;
  const n = regen.token;
  assert.equal(regen.locId, (await call(env, 'C1', { action: 'list' })).d.codes.find((c) => c.label === 'Table 12').locId, 'the place keeps its permanent id; only the code changed');
  assert.equal((await get(env, 'C1', `t=${t12}`)).status, 404, 'revoked by regeneration');
  assert.equal((await get(env, 'C1', `t=${n}`)).status, 200);
  await call(env, 'C1', { action: 'revoke', token: n });
  assert.equal((await get(env, 'C1', `t=${n}`)).status, 404, 'switched off');
  // expired
  const e = (await call(env, 'C1', { action: 'create', kind: 'pool', label: 'Pool Cabana 2', expiresAt: Date.now() + 60000 })).d.code.token;
  assert.equal((await get(env, 'C1', `t=${e}`)).status, 200);
  env.LEDGER_DB._db.exec(`update qr_locations set expires_at = ${Date.now() - 1} where token = '${e}'`);
  assert.equal((await get(env, 'C1', `t=${e}`)).status, 404, 'expired');
  // the list the admin sees records who switched what off
  const list = (await call(env, 'C1', { action: 'list' })).d.codes;
  assert.ok(list.some((c) => c.label === 'Table 12' && !c.active && c.revokedAt));   // switched off: the list records when and by whom
});

test('ordering: prices come from the server (never the phone), required choices enforced, unavailable refused, a double tap is ONE order', async () => {
  const { env, t12 } = await shop();
  let r = await call(env, 'C1', { action: 'order', t: t12, key: 'k-order-0001', items: [{ code: 'BRG', qty: 2, price: 1, modifiers: ['Well done', 'Extra cheese'] }] });
  assert.equal(r.status, 400, 'Cooking allows one choice');
  r = await call(env, 'C1', { action: 'order', t: t12, key: 'k-order-0001', items: [{ code: 'BRG', qty: 2, price: 1 }] });
  assert.match(r.d.error, /Choose Cooking/);
  r = await call(env, 'C1', { action: 'order', t: t12, key: 'k-order-0001', items: [{ code: 'OUT', qty: 1 }] });
  assert.equal(r.status, 409);
  r = await call(env, 'C1', { action: 'order', t: t12, key: 'k-order-0001', name: 'Mary <b>', items: [{ code: 'BRG', qty: 2, price: 1, modifiers: ['Well done'] }, { code: 'TSK', qty: 3, price: 0.01 }] });
  assert.equal(r.status, 200);
  assert.equal(r.d.total, 2 * 650 + 3 * 300, 'the phone\'s prices are ignored');
  const again = await call(env, 'C1', { action: 'order', t: t12, key: 'k-order-0001', items: [{ code: 'TSK', qty: 9 }] });
  assert.equal(again.d.orderId, r.d.orderId); assert.equal(again.d.repeated, true);
  const pend = (await call(env, 'C1', { action: 'pending' })).d.orders;
  assert.equal(pend.length, 1, 'one order, not two');
  assert.equal(pend[0].name, 'Mary b', 'markup stripped');
  assert.equal(pend[0].label, 'Table 12');
});

test('rate limit: one code cannot flood the kitchen', async () => {
  const { env, t12 } = await shop();
  let last;
  for (let i = 0; i < 16; i++) last = await call(env, 'C1', { action: 'order', t: t12, key: `k-flood-${String(i).padStart(4, '0')}`, items: [{ code: 'TSK', qty: 1 }] });
  assert.equal(last.status, 429);
});

test('device pairing is no longer required (zip 194): a stored "paired" mode is ignored, staff actions and customers both work', async () => {
  const { kv: kv0, t12, env: env0 } = await shop();
  const kv = makeKV(); for (const [k, v] of kv0.data) kv.data.set(k, v);
  kv.data.set('device-auth:C1', { value: JSON.stringify({ mode: 'paired', devices: {} }) });
  const env = { mydukapos_kv: kv, LEDGER_DB: env0.LEDGER_DB };
  assert.notEqual((await call(env, 'C1', { action: 'list' })).status, 401);
  assert.notEqual((await call(env, 'C1', { action: 'create', kind: 'table', label: 'Table 99' })).status, 401);
  assert.equal((await call(env, 'C1', { action: 'order', t: t12, key: 'k-paired-0001', items: [{ code: 'TSK', qty: 1 }] })).status, 200);
});

test('the customer page builds everything as text (menu data can never inject HTML) and needs no app', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'order/index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy[^>]*script-src 'self'/);
  const js = fs.readFileSync(path.join(ROOT, 'order/app.js'), 'utf8');
  assert.doesNotMatch(js, /innerHTML/);
  const dom = new JSDOM(html.replace('<script src="app.js"></script>', ''), { url: 'https://lake.mydukapos.store/order/?t=' + 'A'.repeat(32), runScripts: 'outside-only' });
  const w = dom.window;
  w.fetch = async () => new Response(JSON.stringify({ business: 'Lake <img src=x onerror=alert(1)>', location: { label: 'Table 12', kind: 'table' }, open: true, menu: { categories: ['Mains'], items: [{ code: 'BRG', name: '<script>alert(1)</script>Burger', price: 650, category: 'Mains', modifierGroupIds: [] }], modifierGroups: [] } }), { status: 200 });
  w.eval(js);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.document.querySelectorAll('script, img[onerror]').length, 0);
  assert.match(w.document.getElementById('main').textContent, /<script>alert\(1\)<\/script>Burger/);
  assert.match(w.document.getElementById('loc').textContent, /Table 12/);
  dom.window.close();
});

test('QR RESTAURANT end to end: scan → menu → order → staff accept → kitchen & bar tickets → the table\'s bill; the customer page follows the kitchen', async () => {
  const { env, t12 } = await shop();
  // the till talks to the real endpoint
  const fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'https://x.pages.dev');
    if (u.pathname === '/api/qr-order') { u.searchParams.set('c', 'C1'); const req = new Request(u.toString(), { method: opts.method || 'GET', body: opts.body, headers: opts.headers }); return (opts.method || 'GET') === 'POST' ? mod.onRequestPost({ request: req, env }) : mod.onRequestGet({ request: req, env }); }
    return new Response('{}', { status: 404 });
  };
  const INV = [{ code: 'BRG', type: 'service', name: 'Beef Burger', category: 'Mains', price: 650, unit: 'pcs', vatCategory: 'A' }, { code: 'TSK', type: 'item', name: 'Tusker Lager', category: 'Beer', price: 300, wholesalePrice: 180, qty: 48, unit: 'pcs', vatCategory: 'A' }, { code: 'OIL', type: 'ingredient', name: 'Cooking oil', price: 1, qty: 10, unit: 'l' }];
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 12']), pos_kitchen_ticket_enabled: 'true', pos_biz_name: 'Lake View Hotel' }, fetch, wait: 1500 });
  const w = b.w;
  w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push(m); }; window.confirm = () => true; window.__tickets = []; queuePrintJob = function () { window.__tickets.push(lastKitchenTicketText); return Promise.resolve(); }");
  // the till publishes its menu: no ingredients
  const menu = JSON.parse(w.eval('JSON.stringify(hospBuildPublicMenu())'));
  assert.deepEqual(menu.items.map((i) => i.code), ['BRG', 'TSK']);
  await w.eval('hospPublishMenu(true)');
  // the customer scans Table 12 and orders (no table number typed anywhere)
  const scan = await get(env, 'C1', `t=${t12}`);
  assert.equal(scan.d.location.label, 'Table 12');
  const ord = await call(env, 'C1', { action: 'order', t: t12, key: 'k-e2e-000001', name: 'Mary', items: [{ code: 'BRG', qty: 2 }, { code: 'TSK', qty: 2 }] });
  // the till sees it and accepts it
  await w.eval("hospQrCodes = [{ token: 'x', active: true }]; hospQrPoll()");
  assert.equal(Number(w.eval('hospQrPending.length')), 1);
  assert.match(w.document.getElementById('qr-orders-badge').textContent, /1/);
  const tabId = await w.eval(`hospClaimQrOrder('${ord.d.orderId}')`);
  const tab = JSON.parse(w.eval(`JSON.stringify(tabs.find(t => t.id === '${tabId}'))`));
  assert.deepEqual([tab.label, tab.source, tab.customerName], ['Table 12', 'TABLE_QR', 'Mary']);
  const ticket = w.eval('window.__tickets[window.__tickets.length - 1]');
  assert.match(ticket, /KITCHEN[\s\S]*QR ORDER — Mary[\s\S]*2x\s+Beef Burger/); assert.match(ticket, /BAR[\s\S]*2x\s+Tusker/);
  assert.equal(Number(w.eval("inventory.find(p => p.code === 'TSK').qty")), 46, 'stock moves only when staff claim');
  assert.equal(Number(w.eval(`hospNetTotal(tabs.find(t => t.id === '${tabId}'))`)), 1900);
  // a second till claiming the same order is told it is already claimed, and nothing moves
  await w.eval(`hospQrPending = [${JSON.stringify((await call(env, 'C1', { action: 'list' })).d && { id: ord.d.orderId, label: 'Table 12', kind: 'table', status: 'SUBMITTED', items: [{ line: 0, code: 'TSK', qty: 2, name: 'Tusker Lager', price: 300 }] })}]`);
  assert.equal(await w.eval(`hospClaimQrOrder('${ord.d.orderId}')`), false);
  assert.equal(Number(w.eval("inventory.find(p => p.code === 'TSK').qty")), 46, 'claimed once');
  // the kitchen marks it ready: the customer's page shows it
  w.eval(`(function () { const t = tabs.find(x => x.id === '${tabId}'); hospSetLineStatus(t.id, hospTabLines(t).map(l => l.lineId), 'READY'); })()`);
  await new Promise((r) => setTimeout(r, 30));
  const status = await get(env, 'C1', `t=${t12}&o=${ord.d.orderId}`);
  assert.equal(status.d.order.status, 'READY');
  // a waiter scanning the same code opens that table's order
  w.eval(`hospQrCodes = [{ token: '${t12}', kind: 'table', label: 'Table 12', active: true }]`);
  const opened = JSON.parse(w.eval(`JSON.stringify((hospScanLocationCode('https://lake.mydukapos.store/order/?t=${t12}') || {}).id)`));
  assert.equal(opened, tabId);
  assert.equal(w.eval("hospScanLocationCode('https://evil.example/order/?t=" + 'Z'.repeat(32) + "')"), null, 'a code not of this shop is refused');
  b.close();
});
