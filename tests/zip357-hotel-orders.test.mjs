import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { boot, ROOT } from './helpers.mjs';

// zip 357: Hotel Service Orders - tiles like the Sales Counter, ✏️ Edit on every line (qty, Retail / Wholesale / Custom price, note),
// an ORDERS tab in the Sales Counter's Tabs window, and the MD icon on every installed app except Aqua.
const APP = 'hotel/index.html';
const INV = [
  { code: 'BRG', type: 'service', name: 'Beef Burger', category: 'Mains', price: 650, unit: 'pcs', vatCategory: 'A' },
  { code: 'TSK', type: 'item', name: 'Tusker Lager', category: 'Beer', price: 300, wholesalePrice: 180, wholesaleSellingPrice: 250, qty: 48, unit: 'pcs', vatCategory: 'A' },
];
const STAFF = [{ id: 'w1', name: 'Wanjiru', roles: ['service-tab', 'hosp-role:waiter'], salesTabMigrated: true }];
async function app() {
  const b = await boot(APP, { storage: { pos_inventory: JSON.stringify(INV), pos_staff: JSON.stringify(STAFF) }, wait: 1500 });
  b.w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; window.__tickets = []; queuePrintJob = function () { return Promise.resolve(); }");
  return b;
}

test('Service Orders menu: one tile per item with a square picture box, the name and the price at the bottom', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("renderSvcMenu()");
  const tiles = [...d.querySelectorAll('#svc-menu .svc-menu-btn')];
  assert.equal(tiles.length, 2);
  for (const t of tiles) {
    assert.ok(t.querySelector('.svc-pic'), 'picture box');
    assert.ok(t.querySelector('strong.svc-nm'), 'name');
    assert.match(t.querySelector('.svc-pr').textContent, /KES/);
  }
  b.close();
});

test('✏️ Edit: quantity, Wholesale / Custom price and note reach the posted order and its bill', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("svcAdd('TSK'); svcAdd('BRG'); renderSvcDraft()");
  assert.equal(d.querySelectorAll('#svc-draft .svc-edit').length, 2, 'an Edit button on each line');
  w.eval("svcEditLine(0)");
  d.getElementById('svc-edit-qty').value = '2';
  d.querySelector('input[name="svc-edit-tier"][value="wholesale"]').checked = true;
  d.getElementById('svc-edit-note').value = 'cold';
  w.eval('svcEditSave(0)');
  w.eval("svcEditLine(1)");
  d.querySelector('input[name="svc-edit-tier"][value="custom"]').checked = true;
  d.getElementById('svc-edit-price').value = '600';
  w.eval('svcEditSave(1)');
  assert.equal(d.getElementById('svc-edit-modal'), null, 'closed after saving');
  w.eval("svcAdd('TSK')");                                              // a plain tap adds a NEW retail line, never into the wholesale one
  const lines = JSON.parse(w.eval('JSON.stringify(svcDraft.lines)'));
  assert.equal(lines.length, 3);
  assert.deepEqual([lines[0].qty, lines[0].price, lines[0].priceTier, lines[0].note], [2, 250, 'wholesale', 'cold']);
  assert.deepEqual([lines[1].price, lines[1].priceTier], [600, 'custom']);
  d.getElementById('svc-new-guest').value = 'Ann';
  w.eval('svcPostOrder()');
  const due = w.eval("hospTabDue(tabs.find(t => t.status === 'OPEN'))");
  assert.equal(due, 2 * 250 + 600 + 300, 'the bill uses the edited prices');
  b.close();
});

test('✏️ Edit: a bad quantity or custom price is refused in the window; Remove deletes the line', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("svcAdd('BRG'); svcEditLine(0)");
  d.getElementById('svc-edit-qty').value = 'abc';
  assert.equal(w.eval('svcEditSave(0)'), false);
  assert.match(d.getElementById('svc-edit-err').textContent, /quantity/);
  d.getElementById('svc-edit-qty').value = '1';
  d.querySelector('input[name="svc-edit-tier"][value="custom"]').checked = true;
  d.getElementById('svc-edit-price').value = '';
  assert.equal(w.eval('svcEditSave(0)'), false);
  w.eval('svcEditRemove(0)');
  assert.equal(w.eval('svcDraft.lines.length'), 0);
  b.close();
});

test('✏️ Edit: a WAITER changing a price needs the management password', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("currentServer = staff.find(s => s.id === 'w1'); window.__asked = 0; requireManagementApproval = function (m, fn) { window.__asked++; }");
  w.eval("svcAdd('BRG'); svcEditLine(0)");
  d.querySelector('input[name="svc-edit-tier"][value="custom"]').checked = true;
  d.getElementById('svc-edit-price').value = '1';
  w.eval('svcEditSave(0)');
  assert.equal(w.eval('window.__asked'), 1, 'asked for the password');
  assert.equal(w.eval('svcDraft.lines[0].price'), undefined, 'not changed without it');
  b.close();
});

test('Sales Counter Tabs window has an ORDERS tab listing open orders, ready ones first; the Tabs button stays and counts them', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("svcAdd('BRG'); document.getElementById('svc-new-guest').value = 'First'; svcPostOrder()");
  w.eval("svcAdd('TSK'); document.getElementById('svc-new-guest').value = 'Second'; svcPostOrder()");
  w.eval("const t = tabs.find(x => x.label.includes('Second')); hospSetLineStatus(t.id, hospTabLines(t).map(l => l.lineId), 'READY')");
  assert.ok(d.getElementById('sc-tabs-btn'), 'the Tabs button on the Sales Counter');
  w.eval("openQuickTabsModal('orders')");
  assert.equal(d.getElementById('qt-pane-orders').style.display, '');
  assert.equal(d.getElementById('qt-pane-tabs').style.display, 'none');
  const cards = [...d.querySelectorAll('#qt-orders-list .qt-order')].map((c) => c.textContent);
  assert.equal(cards.length, 2);
  assert.match(cards[0], /Second/); assert.match(cards[0], /ready/i);
  assert.equal(d.getElementById('qt-n-orders').textContent, '2');
  assert.match(d.getElementById('sc-tabs-btn').textContent, /\(2\)/);
  w.eval("quickTabsShow('tabs')");
  assert.equal(d.getElementById('qt-pane-tabs').style.display, '');
  b.close();
});

test('every installed app uses the MD icon except Aqua (manifests, Windows, Android)', () => {
  const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
  const md = md5('icons/icon-512.png');
  for (const a of ['hotel', 'hospital', 'owner', 'pharmacy', 'production', 'services']) {
    assert.equal(md5(a + '/icons/icon-512.png'), md, a);
    assert.equal(md5(a + '/icons/icon-192.png'), md5('icons/icon-192.png'), a);
  }
  assert.notEqual(md5('water/icons/icon-512.png'), md, 'Aqua keeps its own');
  const win = md5('native/windows/build/shop.png');
  for (const n of ['hotel', 'hmis', 'production', 'owner', 'pharmacy', 'services']) assert.equal(md5('native/windows/build/' + n + '.png'), win, n);
  assert.notEqual(md5('native/windows/build/aquapos.png'), win);
});
