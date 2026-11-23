// zip 364 - shop app TILE MENU (Settings > View > Screen view): folders > pages, only permitted tabs, the real tab buttons, remembered per person;
// Aqua POS materials: ONE Edit button holds details, the stock count (an audited adjustment), reorder level, supplier, restock, history, active.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot } from './helpers.mjs';

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OPEN = [];
test.afterEach(() => { while (OPEN.length) { try { OPEN.pop().close(); } catch (e) { /* closed */ } } });

test('shop: switch to the tile menu in Settings > View, open Money > Daily Sales, remembered per person, staff see only their tabs', async () => {
  const staff = [{ id: 'st-jane', name: 'Jane Cashier', pinHash: sha('0000'), roles: ['sales-tab', 'daily-sales-tab', 'customers-tab'], lockedDates: [], salesTabMigrated: true, createdAt: 1, updatedAt: 1 }];
  const storage = { pos_pw_hash: sha('admin-pass'), pos_admin_pw_hash: sha('admin-pass'), pos_biz_name: 'Pixxtech Electronics', pos_staff: JSON.stringify(staff) };
  const A = await boot('index.html', { storage, fetch: () => Promise.reject(new Error('offline')), wait: 1500, webcrypto: true }); OPEN.push(A);
  const { w, d } = A; const ev = (s) => w.eval(s);
  d.getElementById('login-password-input').value = 'admin-pass'; await ev('loginSubmit()'); await wait(1500);
  assert.ok(ev('!!(window.launcherView && window.sidebarNav && window.sidebarNav.model)'), 'tile menu loaded');
  assert.equal(ev('launcherView.mode()'), 'classic', 'starts in the classic sidebar');
  // the switch lives in Settings > View
  const card = d.getElementById('lv-viewcard'); assert.ok(card, 'Screen view card');
  assert.equal(card.closest('.settings-section-content').id, 'settings-section-view');
  assert.ok(card.parentNode.children.length > 1, 'the View section keeps its other switches');
  const r = card.querySelector('input[value="tiles"]'); r.checked = true; r.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(ev('launcherView.mode()'), 'tiles'); assert.equal(w.localStorage.getItem('pos_view:admin'), 'tiles');
  // the ☰ button opens the tiles
  d.getElementById('snav-burger').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.ok(d.body.classList.contains('lv-open'), '☰ opens the tile menu');
  const top = [...d.querySelectorAll('#lv .lv-tile .lv-tx')].map((x) => x.textContent);
  assert.ok(top.includes('Money') && top.includes('Stock') && top.includes('Sales Counter'), top.join());
  d.querySelector('#lv [data-lvgrp="fin"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.ok(d.querySelector('#lv [data-lvgo="daily-sales-tab"]'), 'Money shows Daily Sales');
  assert.match(d.querySelector('#lv .lv-crumb').textContent, /Money/);
  d.querySelector('#lv [data-lvgo="daily-sales-tab"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(300);
  assert.ok(d.getElementById('daily-sales-tab').classList.contains('active'), 'the real tab opened');
  assert.equal(d.body.classList.contains('lv-open'), false, 'menu closed');
  // find a page
  ev('launcherView.open()');
  const f = d.querySelector('#lv .lv-find input'); f.value = 'debt'; f.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.ok(d.querySelector('#lv [data-lvgo="debts-tab"]'), 'search finds Debts');
  // Jane (staff) signs in: her own view (classic, never chosen), then tiles show only her tabs
  ev("currentServer = { id: 'st-jane', name: 'Jane Cashier' }; try { applyServerVisibility(); } catch (e) {}");
  await wait(1400);
  assert.equal(ev('launcherView.mode()'), 'classic', 'Jane has her own view');
  ev("launcherView.setMode('tiles', true)");
  const ids = [...d.querySelectorAll('#lv [data-lvgo], #lv [data-lvgrp]')].map((x) => x.getAttribute('data-lvgo') || x.getAttribute('data-lvgrp'));
  assert.equal(ids.includes('stock'), false, 'no Stock folder for Jane');
  assert.equal(ids.includes('sys'), false, 'no System folder for Jane');
  assert.ok(ids.includes('fin'), 'Money folder (Daily Sales) for Jane');
  assert.equal(w.localStorage.getItem('pos_view:staff:st-jane'), 'tiles');
  // back to admin: tiles again (his last view)
  ev('currentServer = null; try { applyServerVisibility(); } catch (e) {}'); await wait(1400);
  assert.equal(ev('launcherView.mode()'), 'tiles');
  // classic button in the tile footer
  ev('launcherView.open()'); d.querySelector('#lv [data-lvclassic]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(ev('launcherView.mode()'), 'classic'); assert.equal(w.localStorage.getItem('pos_view:admin'), 'classic');
  assert.deepEqual(A.errors, []);
});

test('Aqua POS: one Edit button - details, count correction (audited), reorder level, supplier; bag size alone never changes stock', async () => {
  const A = await boot('water/index.html', { wait: 1200 }); OPEN.push(A);
  const { w, d } = A; const j = (code) => JSON.parse(w.eval(`JSON.stringify((function(){${code}})())`) ?? 'null');
  w.eval("window.confirm = function () { return true; }; rawMaterials.length = 0; matMovements.length = 0; window.__site = (sites.find(function (s) { return s.type === 'production'; }) || sites[0]).id; activeSiteId = window.__site;");
  const r = j("return AquaFlow.saveMaterial({ name: 'Caps blue', cat: 'cap', cost: 500, costPer: 'bag', ppb: 100, bags: 3, loose: 20 });");
  assert.equal(r.ok, true); const id = r.material.id;
  assert.equal(j(`return rawMaterials.find(function (m) { return m.id === '${id}'; }).stockQty`), 320);
  w.eval('AquaMat.render()');
  const btns = [...d.querySelectorAll('#aqm-root .aqm-card .aqm-act button')].map((b) => b.textContent.trim());
  assert.deepEqual(btns, ['✏️ Edit', '📦 Restock'], 'one Edit button (plus Restock for a delivery)');
  // open Edit: the count is there, split in bags + loose
  w.eval(`AquaMat.openEdit('${id}')`);
  assert.equal(d.getElementById('aqf-m-bags').value, '3'); assert.equal(d.getElementById('aqf-m-loose').value, '20');
  assert.ok(d.getElementById('aqf-m-reorder') && d.getElementById('aqf-m-sup'), 'reorder level and supplier in the same window');
  assert.ok([...d.querySelectorAll('#aqf-box button')].some((b) => /History/.test(b.textContent)), 'history from Edit');
  // change only the bag size: the same 320 pieces are re-split, stock untouched
  const ppb = d.getElementById('aqf-m-ppb'); ppb.value = '80'; w.eval('AquaFlow.mPpb()');
  assert.equal(d.getElementById('aqf-m-bags').value, '4'); assert.equal(d.getElementById('aqf-m-loose').value, '0');
  assert.equal(d.getElementById('aqf-m-why').style.display, 'none');
  // correct the count + reorder level, with a reason
  d.getElementById('aqf-m-loose').value = '15'; w.eval('AquaFlow.mQty()');
  assert.equal(d.getElementById('aqf-m-why').style.display, '', 'reason box appears when the count changes');
  d.getElementById('aqf-m-reason').value = 'Stock count';
  d.getElementById('aqf-m-reorder').value = '100';
  d.getElementById('aqf-m-name').value = 'Caps blue 28mm';
  w.eval('AquaFlow.mSave()');
  const m = j(`return rawMaterials.find(function (m) { return m.id === '${id}'; })`);
  assert.equal(m.name, 'Caps blue 28mm'); assert.equal(m.stockQty, 335); assert.equal(m.reorderLevel, 100); assert.equal(m.perBag, 80);
  const mv = j(`return matMovements.filter(function (x) { return x.materialId === '${id}' && x.type === 'adjustment'; })`);
  assert.equal(mv.length, 1); assert.equal(mv[0].qty, 15); assert.equal(mv[0].note, 'Stock count');
  // editing again without touching the count makes no adjustment
  w.eval(`AquaMat.openEdit('${id}')`); d.getElementById('aqf-m-name').value = 'Caps blue 28mm (A)'; w.eval('AquaFlow.mSave()');
  assert.equal(j(`return matMovements.filter(function (x) { return x.materialId === '${id}' && x.type === 'adjustment'; }).length`), 1);
  // deactivate from inside Edit
  w.eval(`AquaMat.openEdit('${id}'); AquaFlow.mMore('toggle')`);
  assert.equal(j(`return rawMaterials.find(function (m) { return m.id === '${id}'; }).active`), false);
  assert.deepEqual(A.errors, []);
});
