// zip 331: import the hotel room-services price list from Excel / CSV.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './helpers.mjs';

const STAFF = [{ id: 'm1', name: 'Mo', isManager: true, roles: ['hotel-tab'] }];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app() {
  const fetch = async () => new Response('{}', { status: 404 });
  const b = await boot('hotel/index.html', { storage: { pos_inventory: '[]', pos_rooms: '[]', pos_tables: '[]', pos_staff: JSON.stringify(STAFF) }, fetch, wait: 900 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; currentServer = staff.find(s => s.id === 'm1')");
  return b;
}
const parse = (w, rows) => J(w, `hospParseServiceRows(${JSON.stringify(rows)})`);
const pick = (w, file) => w.eval(`(async () => { const f = new File([new Uint8Array(${JSON.stringify([...file.bytes])})], '${file.name}'); await hospServicesImportFile({ target: { files: [f], value: 'x' } }); })()`);

test('I1 parser: header variants, free, commas, KES, bad rows with line numbers, duplicates', async () => {
  const { w, close } = await app();
  try {
    let r = parse(w, [['Category', 'Item', 'Amount'], ['Laundry', 'Cap', '100'], ['Laundry', 'Tie', 'Free'], ['Dry cleaning', 'Wedding gown', '1,000'], ['Laundry', 'Shoes', 'KES 200'], [], ['Laundry', 'Vest', ''], ['Laundry', 'Skirt', 'abc'], ['Laundry', '', '50'], ['Laundry', 'Cap', '120']]);
    const by = (g, n) => r.items.find((x) => x.group === g && x.name === n);
    assert.equal(by('Laundry', 'Cap').price, 120, 'last duplicate wins');
    assert.equal(by('Laundry', 'Tie').price, 0);
    assert.equal(by('Dry cleaning', 'Wedding gown').price, 1000);
    assert.equal(by('Laundry', 'Shoes').price, 200);
    assert.equal(r.items.length, 4);
    const hard = r.problems.filter((p) => !p.soft).map((p) => p.line);
    assert.deepEqual(hard, [7, 8, 9], 'blank price, text price and blank name are reported by row number');
    r = parse(w, [['Suits', 600], ['Tie', 'free']]);                           // two columns, no header
    assert.deepEqual(r.items.map((x) => [x.group, x.name, x.price]), [['Other', 'Suits', 600], ['Other', 'Tie', 0]]);
    r = parse(w, [['Laundry', 'Cap', 100], ['Laundry', 'Vest', 100]]);          // three columns, no header
    assert.equal(r.items.length, 2);
    r = parse(w, [['Group', 'Service', 'Price'], ['Laundry', 'Cap', '-5']]);
    assert.equal(r.items.length, 0); assert.equal(r.problems.length, 1);
  } finally { close(); }
});

test('I2 apply: new vs changed vs same; nothing is deleted; no duplicates', async () => {
  const { w, close } = await app();
  try {
    w.eval('hospLoadStarterServices()');
    w.eval("hospAddRoomService('Ironing', 'Shirt pressing', 80)");
    const p = parse(w, [['Group', 'Service', 'Price'], ['Dry cleaning', 'Suits', 700], ['Laundry', 'Cap', 100], ['Laundry', 'Bedsheet', 150]]);
    w.eval(`window.__rsImportPending = ${JSON.stringify(p)}`);
    const plan = J(w, 'hospServiceImportPlan(window.__rsImportPending)');
    assert.equal(plan.add.length, 1); assert.equal(plan.change.length, 1); assert.equal(plan.same, 1);
    const r = J(w, 'hospConfirmServiceImport()');
    assert.deepEqual([r.added, r.changed], [1, 1]);
    assert.equal(w.eval('hospRoomServices().length'), 27, '25 + ironing + bedsheet, nothing removed');
    assert.equal(J(w, "hospRoomServices().find(x => x.name === 'Suits')").price, 700);
    assert.ok(w.eval("hospRoomServices().some(x => x.name === 'Shirt pressing')"));
    assert.equal(w.eval('window.__rsImportPending'), null);
  } finally { close(); }
});

test('I3 CSV file through the file input, with preview then confirm', async () => {
  const { w, d, close } = await app();
  try {
    w.eval('renderHotel()');
    assert.ok(d.getElementById('hotel-body').textContent.includes('Import from Excel'));
    const csv = '﻿Group,Service,Price (KES)\r\nLaundry,Cap,100\r\nLaundry,"Tie, silk",Free\r\nLaundry,Bad,xx\r\n';
    await pick(w, { name: 'p.csv', bytes: Buffer.from(csv, 'utf8') });
    const pend = J(w, 'window.__rsImportPending');
    assert.equal(pend.items.length, 2); assert.equal(pend.problems.length, 1);
    w.eval('renderHotel()');
    const box = d.getElementById('rs-import-box');
    assert.ok(box.textContent.includes('Ready to import'), 'preview is shown after the screen redraws');
    w.eval('hospConfirmServiceImport()');
    assert.equal(w.eval('hospRoomServices().length'), 2);
    assert.equal(J(w, "hospRoomServices().find(x => x.name === 'Tie, silk')").price, 0);
  } finally { close(); }
});

test('I4 the generated White Star .xlsx imports all 25 items (SheetJS injected for the test)', async () => {
  const lib = '/tmp/xl/node_modules/xlsx/dist/xlsx.full.min.js';
  if (!fs.existsSync(lib)) return;                 // test-only dependency; skipped when absent
  const { w, close } = await app();
  try {
    w.eval(fs.readFileSync(lib, 'utf8'));
    w.eval('window.loadSheetJs = loadSheetJs = async () => window.XLSX');
    await pick(w, { name: 'w.xlsx', bytes: fs.readFileSync('docs/White_Star_room_services.xlsx') });
    const pend = J(w, 'window.__rsImportPending');
    assert.equal(pend.items.length, 25, 'the Instructions sheet adds no rows');
    assert.equal(pend.problems.filter((p) => !p.soft).length, 0);
    assert.equal(pend.items.find((x) => x.name === 'Leather jacket').price, 500);
    assert.equal(pend.items.find((x) => x.name === 'Tie').price, 0);
    w.eval('hospConfirmServiceImport()');
    assert.equal(w.eval('hospRoomServices().length'), 25);
    // same as the built-in starter list
    assert.equal(w.eval('hospLoadStarterServices()'), 0);
  } finally { close(); }
});
