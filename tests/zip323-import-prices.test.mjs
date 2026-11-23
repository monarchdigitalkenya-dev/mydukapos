// zip 323: Excel / CSV inventory import - prices were lost (0) or invisible in the review table.
// Pure Node (no jsdom): the importer and the commit step are lifted out of each app's index.html and run in a vm sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPS = ['index.html', 'hospital/index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];

function grab(html, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(html);
  if (!m) throw new Error('missing function ' + name);
  let i = html.indexOf('{', m.index), d = 0, j = i;
  for (; j < html.length; j++) { if (html[j] === '{') d++; else if (html[j] === '}') { d--; if (!d) break; } }
  return html.slice(m.index, j + 1);
}
function grabConst(html, name) {
  const m = new RegExp('const ' + name + ' = \\{').exec(html);
  let i = html.indexOf('{', m.index), d = 0, j = i;
  for (; j < html.length; j++) { if (html[j] === '{') d++; else if (html[j] === '}') { d--; if (!d) break; } }
  return html.slice(m.index, j + 1) + ';';
}
function load(app) {
  const html = fs.readFileSync(path.join(ROOT, app), 'utf8');
  let code = grabConst(html, 'CSV_FIELD_ALIASES') + '\n';
  for (const n of ['extractNumber', 'findCsvColumn', 'detectCsvColumns', 'buildInventoryItemName', 'parseDoseCell', 'splitVariantNames', 'captureVariantSum', 'finishInventoryFileImport', 'commitCaptureReview', 'updateCaptureReviewField']) {
    try { code += grab(html, n) + '\n'; } catch (e) { if (!/^(parseDoseCell|splitVariantNames|captureVariantSum)$/.test(n)) throw e; }   // the Hotel importer has no size / dose columns
  }
  const el = {};
  const sb = {
    window: {}, captured: null, inventory: [], toast: '', showToast(m) { sb.toast = m; }, safeSetItem() {}, queuePush() {}, renderInventoryTable() {}, closeCaptureReviewModal() {}, renderCaptureReviewTable() {},
    fuzzyPrematchCaptureItems() {}, genSaleId: () => 'G' + Math.random().toString(36).slice(2, 8), commitCaptureVariantItems: () => ({ created: 0, updated: 0, variantsAdded: 0, restocked: 0 }),
    commitCaptureDishRows: (items) => ({ stop: false, rest: items }),
    document: { getElementById: (id) => el[id] || (el[id] = { textContent: '', style: {}, value: '' }), querySelectorAll: () => [] }, captureReviewState: null, captureRowSeq: 0,
    openCaptureReviewModal(o) { sb.captureReviewState = o; sb.captured = o; },
  };
  vm.createContext(sb); vm.runInContext(code, sb);
  return sb;
}
const run = (app, rows) => { const s = load(app); s.finishInventoryFileImport(rows.slice(1), s.detectCsvColumns(rows[0]), 't.xlsx'); return s; };
const priceOf = (s, n) => (s.inventory.find((p) => p.name === n) || {}).price;

for (const app of APPS) {
  test(`${app}: a recognised or loosely written price header reaches the review table and the inventory`, () => {
    for (const hdr of ['Selling Price', 'Unit Price', 'Retail', 'Price (KSh)', 'selling_price', 'SP']) {
      const s = run(app, [['Item Name', 'Qty', 'Cost', hdr], ['Sugar', '10', '150', '200'], ['Rice', '5', '300', '1,420.50']]);
      assert.deepEqual(Array.from(s.captured.items, (i) => i.retail), [200, 1420.5], `${hdr}: the Retail box in the review shows the file's price`);
      s.commitCaptureReview();
      assert.equal(priceOf(s, 'Sugar'), 200, hdr);
      assert.equal(priceOf(s, 'Rice'), 1420.5, hdr);
    }
  });

  test(`${app}: a price typed in the review table is the one committed`, () => {
    const s = run(app, [['Item Name', 'Qty', 'Cost', 'Selling Price'], ['Sugar', '10', '150', '200']]);
    s.updateCaptureReviewField(s.captured.items[0].id, 'retail', '999');
    s.commitCaptureReview();
    assert.equal(priceOf(s, 'Sugar'), 999);
  });

  test(`${app}: empty price / cost / quantity cells never zero an item already in the shop`, () => {
    const s = run(app, [['Code', 'Item Name', 'Qty', 'Cost', 'Selling Price'], ['A1', 'Sugar', '', '', '']]);
    s.inventory.push({ code: 'A1', name: 'Sugar', qty: 40, price: 200, wholesalePrice: 150, wholesaleSellingPrice: 180, type: 'item' });
    s.commitCaptureReview();
    const p = s.inventory[0];
    assert.deepEqual([p.price, p.qty, p.wholesalePrice, p.wholesaleSellingPrice], [200, 40, 150, 180]);
  });

  test(`${app}: real values in the file still update an existing item`, () => {
    const s = run(app, [['Code', 'Item Name', 'Qty', 'Cost', 'Selling Price'], ['A1', 'Sugar', '12', '160', '210']]);
    s.inventory.push({ code: 'A1', name: 'Sugar', qty: 40, price: 200, wholesalePrice: 150, type: 'item' });
    s.commitCaptureReview();
    const p = s.inventory[0];
    assert.deepEqual([p.price, p.qty, p.wholesalePrice], [210, 12, 160]);
  });

  test(`${app}: a file with no selling-price column at all says so before the prices become 0`, () => {
    const s = run(app, [['Item Name', 'Qty', 'Cost'], ['Sugar', '10', '150']]);
    assert.match(s.toast, /No selling-price column/);
  });
}
