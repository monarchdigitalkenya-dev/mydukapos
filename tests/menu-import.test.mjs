import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, ROOT } from './helpers.mjs';
import { shapeCaptureResult } from '../functions/api/_capture-shape.js';

// A menu (photo or Excel) becomes DISHES in the Hotel POS: sold by price, no stock. Server side: a menu's printed price is the SELLING price.
const menuItem = (name, price, cat, extra = {}) => ({ detected_name: name, detected_code: '', category: cat, quantity: 0, unit_cost: price, retail_price: 0, wholesale_price: 0, confidence_score: 0.9, ...extra });

test('server: a menu photo is read as dishes with selling prices (a "KSH 50" is not a buying cost); invoices and recipes are untouched', () => {
  let r = shapeCaptureResult({ document_type: 'menu', items: [menuItem('Tea', 50, 'Hot Beverages'), menuItem('Rice', 150, 'Meals'), menuItem('Soda', 60, 'Cold Beverages')], recipes: [] });
  assert.equal(r.document_type, 'menu');
  assert.deepEqual(r.items.map((i) => [i.detected_name, i.retail_price, i.unit_cost, i.quantity, i.category]), [['Tea', 50, 0, 0, 'Hot Beverages'], ['Rice', 150, 0, 0, 'Meals'], ['Soda', 60, 0, 0, 'Cold Beverages']]);
  // the person ticked "this is a menu" but the model labelled it items: the lines look like a menu, so it is one
  r = shapeCaptureResult({ document_type: 'items', items: [menuItem('Tea', 50, ''), menuItem('Rice', 150, '')] }, { menu: true });
  assert.equal(r.document_type, 'menu');
  // an invoice (quantities and buying costs) stays an invoice even if it was mislabelled
  r = shapeCaptureResult({ document_type: 'menu', items: [{ ...menuItem('Sugar 2kg', 150, ''), quantity: 24 }, { ...menuItem('Flour', 120, ''), quantity: 10 }] });
  assert.equal(r.document_type, 'items'); assert.equal(r.items[0].unit_cost, 150); assert.equal(r.items[0].quantity, 24);
  // plain invoice
  r = shapeCaptureResult({ document_type: 'items', items: [{ detected_name: 'Chair', quantity: 5, unit_cost: 200, retail_price: 300, confidence_score: 0.8 }] });
  assert.equal(r.document_type, 'items'); assert.equal(r.items[0].retail_price, 300);
  // recipe wins
  r = shapeCaptureResult({ document_type: 'recipe', recipes: [{ dish_name: 'Chapati', yield_qty: 10, selling_price: 20, ingredients: [{ name: 'Flour', unit: 'kg', quantity: 1, unit_cost: 150 }] }], items: [] });
  assert.equal(r.document_type, 'recipe');
  // the endpoint asks the model for menus and passes the person's tick through
  const src = fs.readFileSync(path.join(ROOT, 'functions/api/ai-capture-list.js'), 'utf8');
  assert.match(src, /KIND 3 — a MENU/); assert.match(src, /body\.mode === 'menu'/); assert.match(src, /shapeCaptureResult\(result\.data/);
});

const MENU_ROWS = [['Category', 'Code', 'Name', 'Price', 'Cost Price', 'Unit', 'Qty', 'Item Type'],
  ['Hot Beverages', 'HB01', 'Tea', '50', '', 'pcs', '1000', 'Dish'], ['Hot Beverages', 'HB02', 'Special Tea', '100', '', 'pcs', '1000', 'Dish'], ['Meals', 'ML01', 'Rice', '150', '', 'pcs', '1000', 'Dish']];
async function hotel(extra = {}) {
  const b = await boot('hotel/index.html', { wait: 1500, ...extra });
  b.w.eval("showToast = function (m) { window.__t = (window.__t || []).concat(m); }; window.confirm = () => true; window.detectCsvColumnsAI = async () => null");
  return b;
}
const openImport = async (b, rows) => { b.w.__rows = rows; await b.w.eval('beginInventoryFileImport(window.__rows, "menu.xlsx")'); await new Promise((r) => setTimeout(r, 150)); };
const inv = (b) => JSON.parse(b.w.eval('JSON.stringify(inventory)'));

test('Excel: an "Item Type = Dish" column makes Dishes (no stock), the review says so, and they can be sold', async () => {
  const b = await hotel();
  await openImport(b, MENU_ROWS);
  const { d, w } = b;
  assert.equal(d.getElementById('capture-review-kind').value, 'dish', 'the review is set to Dishes');
  assert.ok(d.getElementById('capture-review-modal').classList.contains('capture-dish-mode'), 'no quantity / cost columns for dishes');
  assert.equal(d.getElementById('capture-review-th-retail-label').textContent, 'Price');
  w.eval('commitCaptureReview()');
  const dishes = inv(b).filter((p) => p.type === 'service');
  assert.equal(dishes.length, 3);
  assert.deepEqual(dishes.map((p) => [p.code, p.name, p.price, p.category, p.qty]), [['HB01', 'Tea', 50, 'Hot Beverages', null], ['HB02', 'Special Tea', 100, 'Hot Beverages', null], ['ML01', 'Rice', 150, 'Meals', null]]);
  assert.equal(inv(b).filter((p) => p.type === 'item').length, 0, 'nothing was added as stocked items');
  assert.match((w.__t || []).join(' '), /3 dishes added/);
  w.eval("addToCart('HB01'); addToCart('ML01')");
  assert.equal(w.eval('Object.keys(currentCart).length'), 2, 'sellable with no stock');
  assert.equal(w.eval('cartTotal()'), 200);
  // importing the same menu again updates prices, never duplicates
  const again = MENU_ROWS.map((r, i) => (i === 1 ? ['Hot Beverages', 'HB01', 'Tea', '60', '', 'pcs', '1000', 'Dish'] : r));
  await openImport(b, again); w.eval('commitCaptureReview()');
  assert.equal(inv(b).filter((p) => p.type === 'service').length, 3); assert.equal(inv(b).find((p) => p.code === 'HB01').price, 60);
  assert.deepEqual(b.errors, []);
  b.close();
});

test('Excel: a sheet with only names and prices defaults to Dishes; a stock sheet with quantities stays Items; Item Type can mix both', async () => {
  let b = await hotel();
  await openImport(b, [['Name', 'Price'], ['Mandazi', '40'], ['Sausage', '50']]);
  assert.equal(b.d.getElementById('capture-review-kind').value, 'dish', 'names + prices only = a menu');
  b.w.eval('commitCaptureReview()');
  assert.deepEqual(inv(b).map((p) => [p.name, p.type, p.price]), [['Mandazi', 'service', 40], ['Sausage', 'service', 50]]);
  b.close();
  b = await hotel();
  await openImport(b, [['Name', 'Price', 'Cost Price', 'Qty'], ['Sugar 1kg', '200', '150', '40']]);
  assert.equal(b.d.getElementById('capture-review-kind').value, 'item', 'a stock sheet stays stock');
  b.w.eval('commitCaptureReview()');
  const s = inv(b)[0]; assert.deepEqual([s.name, s.type, s.price, s.wholesalePrice, s.qty], ['Sugar 1kg', 'item', 200, 150, 40]);
  b.close();
  b = await hotel();
  await openImport(b, [['Name', 'Price', 'Qty', 'Item Type'], ['Fries', '150', '', 'Dish'], ['Soda crate', '900', '12', 'Item']]);
  b.w.eval('commitCaptureReview()');
  assert.deepEqual(inv(b).map((p) => [p.name, p.type, p.qty]), [['Fries', 'service', null], ['Soda crate', 'item', 12]]);
  b.close();
});

test('a dish without a price is refused with the names listed; nothing is created until it is fixed; the choice can be changed in the review', async () => {
  const b = await hotel();
  await openImport(b, [['Name', 'Price'], ['Tea', '50'], ['Mystery Dish', '']]);
  b.w.eval('commitCaptureReview()');
  assert.match(b.d.getElementById('capture-review-error').textContent, /no price yet.*Mystery Dish/);
  assert.equal(inv(b).length, 0);
  // switch the whole list to Items in the review: they are then added as stocked items (as before)
  b.d.getElementById('capture-review-kind').value = 'item'; b.w.eval('captureReviewKindChanged()');
  assert.ok(!b.d.getElementById('capture-review-modal').classList.contains('capture-dish-mode'));
  b.w.eval('commitCaptureReview()');
  assert.deepEqual(inv(b).map((p) => [p.name, p.type]), [['Tea', 'item'], ['Mystery Dish', 'item']]);
  b.close();
});

test('photo: a menu (or "This is a menu" ticked) opens the review as Dishes with the prices as selling prices; a restock capture has no such choice', async () => {
  const calls = [];
  const fetch = async (url, opts) => {
    if (String(url).includes('/api/ai-capture-list') && opts && opts.method === 'PUT') { calls.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ document_type: 'menu', recipes: [], items: [{ detected_name: 'Tea', detected_code: '', category: 'Hot Beverages', quantity: 0, unit_cost: 0, retail_price: 50, wholesale_price: 0, confidence_score: 0.95 }, { detected_name: 'Chapati', detected_code: '', category: 'Meals', quantity: 0, unit_cost: 0, retail_price: 50, wholesale_price: 0, confidence_score: 0.9 }] }) }; }
    if (String(url).includes('/api/ai-capture-list')) return { ok: true, status: 200, json: async () => ({ configured: true }) };
    return Promise.reject(new Error('offline'));
  };
  const b = await hotel({ fetch });
  const { w, d } = b;
  await w.eval("openCaptureSourceModal('add-item')");
  assert.equal(d.getElementById('capture-menu-mode-row').style.display, 'flex', 'the menu tick is offered when adding new items');
  d.getElementById('capture-menu-mode').checked = true;
  await w.eval("runAiCaptureOnImage('data:image/png;base64,AAAA')");
  assert.equal(calls[0].mode, 'menu', 'the person\'s tick reaches the AI');
  assert.equal(d.getElementById('capture-review-kind').value, 'dish');
  assert.equal(d.querySelectorAll('#capture-review-tbody tr').length, 2);
  w.eval('commitCaptureReview()');
  assert.deepEqual(inv(b).map((p) => [p.name, p.type, p.price, p.category]), [['Tea', 'service', 50, 'Hot Beverages'], ['Chapati', 'service', 50, 'Meals']]);
  // restock capture: no Dish choice
  await w.eval("openCaptureSourceModal('restock')");
  assert.equal(d.getElementById('capture-menu-mode-row').style.display, 'none');
  await w.eval("runAiCaptureOnImage('data:image/png;base64,AAAA')");
  assert.equal(d.getElementById('capture-review-kind-row').style.display, 'none', 'restocking is always items');
  assert.equal(calls[1].mode, undefined);
  assert.deepEqual(b.errors, []);
  b.close();
});
