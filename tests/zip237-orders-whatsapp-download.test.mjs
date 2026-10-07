import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 237 — Orders: WhatsApp opens even with no supplier number / a very long order; a Download button saves the order as a PDF.
async function app(nItems) {
  const b = await boot('index.html');
  const { w } = b;
  w.eval(`purchaseOrders.push({ id: 'po-x', orderNo: 'PO-0002', createdAt: new Date().toISOString(), supplierId: '', supplierName: '', note: '', status: 'pending', statusHistory: [],
    items: Array.from({ length: ${nItems} }, (_, i) => ({ id: 'l' + i, code: 'C' + i, name: 'Item number ' + i + ' with a fairly long name', unit: 'pcs', qty: 15, cost: 337.5, receivedQty: 0 })) });
    window.__opened = []; window.open = (u) => { window.__opened.push(u); return {}; }; window.prompt = () => null; window.__nav = null;`);
  return b;
}

test('W1: no supplier number — WhatsApp still opens (chat chooser) with the order text', async () => {
  const b = await app(3); const { w } = b;
  w.eval("poSendOrder('po-x')");
  const u = w.eval('window.__opened[0]');
  assert.match(u, /^https:\/\/api\.whatsapp\.com\/send\?text=/);
  assert.match(decodeURIComponent(u), /Order PO-0002/);
  b.close();
});

test('W2: a 63-item order is too long for a link — a short message opens and the full list goes to the clipboard path', async () => {
  const b = await app(63); const { w } = b;
  w.eval("window.__clip = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__clip = t; return Promise.resolve(); } }, configurable: true });");
  w.eval("poSendOrder('po-x')");
  const u = w.eval('window.__opened[0]');
  assert.ok(u.length < 1800, 'link stays short');
  assert.match(decodeURIComponent(u), /63 items/);
  assert.match(w.eval('window.__clip'), /Item number 62/);
  b.close();
});

test('W3: Download button exists on every order and the plain-text sheet lists all lines with the total', async () => {
  const b = await app(63); const { w, d } = b;
  w.eval("poState().filter = 'all'; renderOrdersList()");
  assert.match(d.getElementById('orders-tab').innerHTML, /poDownloadOrder\('po-x'\)/);
  const t = w.eval("poOrderPlainText(purchaseOrders.find(o => o.id === 'po-x'))");
  assert.match(t, /Item number 62/); assert.match(t, /TOTAL \(KES\)\s+318,[0-9]{3}\.[0-9]{2}/);
  b.close();
});
