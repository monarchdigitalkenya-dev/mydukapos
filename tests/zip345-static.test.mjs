// zip 345: the pieces added in this zip are present in every app that should have them
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const rd = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('server accepts the two new audited actions', () => {
  const s = rd('functions/api/cost-control.js');
  assert.match(s, /'lot_remove'/); assert.match(s, /'profit_edit'/);
});
test('batch tools + profit editor are in every stock app', () => {
  for (const a of ['index.html', 'pharmacy/index.html', 'hospital/index.html']) {
    const h = rd(a);
    for (const k of ['function lotAssign', 'function lotEditId', 'function lotRemove', 'function profitEdit']) assert.ok(h.includes(k), a + ' missing ' + k);
  }
});
test('restock has a Batch ID column (pharmacy + hospital)', () => {
  for (const a of ['pharmacy/index.html', 'hospital/index.html']) assert.match(rd(a), /Batch ID/);
});
test('theme is remembered in storage AND a cookie; receipt paper is forced light', () => {
  for (const a of ['index.html', 'pharmacy/index.html', 'hospital/index.html', 'hotel/index.html', 'water/index.html', 'production/index.html', 'services/index.html', 'owner/index.html']) {
    const h = rd(a); assert.match(h, /__mdpThemeSave/); assert.match(h, /document\.cookie='mdp-theme=/);
  }
  assert.match(rd('index.html'), /\.receipt-paper[^{]*\{[^}]*background: #ffffff !important/);
});
test('hospital registration: location combobox + recent patients + one start button', () => {
  const h = rd('hospital/index.html');
  assert.match(h, /hregAfterSave/); assert.match(h, /patient-ward-input/); assert.match(h, /id="hreg-geo"/);
});
test('serial items: typed serials in Add, Restock gate and Edit-quantity flows exist', () => {
  const h = rd('index.html');
  for (const k of ['id="inv-serial-list"', 'function srOpenAdd', 'function srQtyChange', 'function wrapQtyEdit', 'function restockTracked', '__ipSaveWrapped']) assert.ok(h.includes(k) || h.includes(k.replace(/"/g, "'")), 'missing ' + k);
});
test('car wash: wash item types, staff on create, Task wording', () => {
  const h = rd('services/index.html');
  for (const k of ['SVC_WASH_ITEM_TYPES', 'washItemSec', 'function svcUiStaffList', 'input.jobStaff = js', "newButton: '+ New Task'", 'svcCatTopUp']) assert.ok(h.includes(k), 'missing ' + k);
});
