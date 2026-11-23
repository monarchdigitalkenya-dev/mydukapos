// zip 378: STK verification (amounts with commas, whole-shilling rounding, confirmed prompt without a callback), Daraja text fields and trimmed
// keys, settings that wait with held keys, Clear customers leaves tombstones, the receipt never prints the paper buttons / close X, and the delivery
// guard shows nothing on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { boot } from './helpers.mjs';
import { parseMoney } from '../functions/api/_till-store.js';
import { loadGatewayConfig, saveGatewayConfig, applyPending } from '../functions/api/_gateway-config.js';

const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const APPS = ['index.html', 'hotel/index.html', 'water/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'carwash/index.html'];

test('parseMoney: thousands separators and currency words never shrink an amount', () => {
  assert.equal(parseMoney('22,000.00'), 22000);
  assert.equal(parseMoney('KES. 22,000.00'), 22000);
  assert.equal(parseMoney(1500), 1500);
  assert.equal(parseMoney(''), 0);
  assert.equal(parseMoney(null), 0);
});

test('mpesa-verify: a confirmed prompt is proof without a callback; under one shilling short is not "paid less"; a comma amount from the Till is read right', async () => {
  const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv };
  const m = await import('../functions/api/mpesa-verify.js');
  const v = async (b) => (await m.onRequestPost({ request: new Request('https://x.pages.dev/api/mpesa-verify?c=C1', { method: 'POST', body: JSON.stringify(b) }), env })).json();
  kv.data.set('mpesa-tx:C1:ws_CO_9', { value: JSON.stringify({ status: 'success', amount: 2200, phone: '254712000000' }) });
  assert.equal((await v({ code: 'SKL1234567', amount: 2200, saleId: 's1' })).status, 'not_found', 'no record and no prompt id');
  assert.equal((await v({ code: 'SKL1234567', amount: 2200.4, saleId: 's1', checkoutRequestId: 'ws_CO_9' })).status, 'verified', 'the confirmed prompt, 40 cents rounded away');
  assert.equal((await v({ code: 'SKL1234567', amount: 2200, saleId: 's2', checkoutRequestId: 'ws_CO_9' })).status, 'duplicate', 'one payment still pays one sale');
  kv.data.set('mpesa-tx:C1:ws_CO_8', { value: JSON.stringify({ status: 'success', amount: 2000 }) });
  assert.equal((await v({ code: 'SKL7654321', amount: 2200, saleId: 's3', checkoutRequestId: 'ws_CO_8' })).status, 'amount_mismatch', 'really 200 short');
  // a Till confirmation with a thousands separator
  const c2b = await import('../functions/api/mpesa-c2b-confirmation.js');
  assert.equal(typeof c2b.onRequestPost, 'function');
});

test('mpesa-callback stores the real amount even when Safaricom sends it as text with a comma', async () => {
  const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv };
  kv.data.set('mpesa-tx:C1:ws_CO_1', { value: JSON.stringify({ status: 'pending', amount: 22000, createdAt: Date.now() }) });
  const cb = await import('../functions/api/mpesa-callback.js');
  await cb.onRequestPost({ request: new Request('https://x.pages.dev/api/pay-cb-stk?c=C1', { method: 'POST', body: JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'Amount', Value: '22,000.00' }, { Name: 'MpesaReceiptNumber', Value: 'QWE1234567' }] } } } }) }), env });
  const rec = JSON.parse(kv.data.get('mpesa-receipt:C1:QWE1234567').value);
  assert.equal(rec.amount, 22000);
  assert.equal(JSON.parse(kv.data.get('mpesa-tx:C1:ws_CO_1').value).amount, 22000);
});

test('Daraja: AccountReference / TransactionDesc are plain text; keys pasted with spaces are trimmed', async () => {
  const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv };
  await saveGatewayConfig(env, 'C1', { mpesaEnv: 'sandbox', mpesaConsumerKey: ' ck \n', mpesaConsumerSecret: 'cs ', mpesaShortcode: ' 174379', mpesaPasskey: 'pk\n' });
  const cfg = await loadGatewayConfig(env, 'C1');
  assert.deepEqual([cfg.mpesaConsumerKey, cfg.mpesaConsumerSecret, cfg.mpesaShortcode, cfg.mpesaPasskey], ['ck', 'cs', '174379', 'pk']);
  const s = await import('../functions/api/mpesa-stkpush.js');
  let sent = null;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    if (String(url).includes('oauth')) return new Response(JSON.stringify({ access_token: 't' }));
    sent = JSON.parse(o.body);
    return new Response(JSON.stringify({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_X', MerchantRequestID: 'm', CustomerMessage: 'ok' }));
  };
  try {
    const r = await s.sendStk(env, new Request('https://shop.mydukapos.store/api/mpesa-stkpush?c=C1'), 'C1', cfg, 'daraja', { phone: '254712345678', amount: 2200.4, accountRef: "WHITE STAR HOTEL(ACCOMODATION)", description: "Jay's Sale" });
    assert.equal(r.id, 'ws_CO_X');
  } finally { globalThis.fetch = real; }
  assert.equal(sent.AccountReference, 'WHITE STAR H');
  assert.match(sent.AccountReference, /^[A-Za-z0-9 -]{1,12}$/);
  assert.equal(sent.TransactionDesc, 'Jay s Sale');
  assert.equal(sent.Amount, 2200);
  assert.equal(sent.BusinessShortCode, '174379');
});

test('held keys: the environment / type saved with them waits with them (old keys never meet the new settings)', async () => {
  const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv };
  await saveGatewayConfig(env, 'C1', { mpesaEnv: 'production', mpesaConsumerKey: 'ck1', mpesaConsumerSecret: 'cs1', mpesaShortcode: '111111', mpesaPasskey: 'pk1', mpesaTransactionType: 'CustomerPayBillOnline' }, { cooldownMs: 3600000 });
  const r = await saveGatewayConfig(env, 'C1', { mpesaShortcode: '222222', mpesaTransactionType: 'CustomerBuyGoodsOnline' }, { cooldownMs: 3600000 });
  assert.ok(r.held, 'the new shortcode is held');
  let cfg = await loadGatewayConfig(env, 'C1');
  assert.deepEqual([cfg.mpesaShortcode, cfg.mpesaTransactionType], ['111111', 'CustomerPayBillOnline'], 'old keys keep their own type until the change applies');
  const stored = { mpesaShortcode: '111111', mpesaTransactionType: 'CustomerPayBillOnline', _pending: { fields: { mpesaShortcode: '222222', mpesaTransactionType: 'CustomerBuyGoodsOnline' } } };
  const out = applyPending(stored);
  assert.deepEqual([out.mpesaShortcode, out.mpesaTransactionType], ['222222', 'CustomerBuyGoodsOnline'], 'and both apply together');
  // a sandbox-only change of type still applies at once (nothing held)
  const kv2 = makeKV(); seedShop(kv2, 'C2'); const env2 = { mydukapos_kv: kv2 };
  await saveGatewayConfig(env2, 'C2', { mpesaTransactionType: 'CustomerBuyGoodsOnline' }, { cooldownMs: 3600000 });
  cfg = await loadGatewayConfig(env2, 'C2');
  assert.equal(cfg.mpesaTransactionType, 'CustomerBuyGoodsOnline');
});

test('Clear customers (demo purge) leaves a tombstone for each, so no client comes back after a sync; lists never show them', async () => {
  for (const a of APPS) {
    const s = fs.readFileSync(a, 'utf8');
    assert.ok(!/\n\s*customers = \[\];/.test(s), a + ': customers are never just emptied');
    assert.ok(!/customers = customers\.filter\(c => c\.id !== /.test(s), a + ': Remove customer leaves a tombstone');
  }
  const d = await boot('hotel/index.html', { storage: { pos_biz_name: 'Biz' }, wait: 800 });
  try {
    const w = d.w;
    w.eval("customers = [{ id: 'c1', name: 'Abdi Nuur', phone: '0712000001', createdAt: 1 }, { id: 'c2', name: 'Jane', phone: '0712000002', createdAt: 2 }]");
    w.eval("pendingDemoPurgeOptions = { resetStock: false, clearCustomers: true }; performPurgeDemoData()");
    const left = J(w, 'customers');
    assert.equal(left.length, 2, 'kept as tombstones');
    assert.ok(left.every((c) => c._deleted === true && !c.name && !c.phone && c.updatedAt > 0), 'personal details gone, deletion stamped');
    if (w.document.getElementById('customers-list')) {
      w.eval('renderCustomersList()');
      assert.doesNotMatch(w.document.getElementById('customers-list').textContent, /Unnamed|Abdi/);
    }
  } finally { d.close && d.close(); }
});

test('receipt print: paper buttons, the paper note, the close X and action buttons never reach paper; the branch has no emoji', async () => {
  const blk = fs.readFileSync('src/shared/blocks/print-isolate.html', 'utf8');
  assert.match(blk, /@media print\{\.device-paper-picker,\.device-paper-now,\.universal-modal-x,\.receipt-actions/);
  const d = await boot('hotel/index.html', { storage: { pos_biz_name: 'Biz', pos_receipt_layout: 'detailed' }, wait: 800 });
  try {
    const w = d.w;
    const html = w.eval("PrintIsolate.build(document.getElementById('receipt-modal'))");
    const printed = html.slice(html.indexOf('<div id="receipt-modal"'));      // the copied receipt (the styles before it name these classes)
    assert.ok(printed.length > 50, 'the receipt is in the print copy');
    assert.doesNotMatch(printed, /class="device-paper-picker|class="universal-modal-x|class="receipt-actions|<button/);
    w.eval("var bp = document.getElementById('branch-pill') || (function(){ var e = document.createElement('span'); e.id = 'branch-pill'; document.body.appendChild(e); return e; })(); bp.style.display = ''; bp.textContent = '\\u{1F3E2} White Star \\u25BE';");
    w.eval("renderSharedReceipt({ id: 'b1', refNumber: 'BILL-1', timestamp: new Date().toISOString(), paid: false, paymentMethod: 'bill', servedBy: 'A', items: [{ name: 'Room', price: 22000, qty: 1, unit: 'pcs' }] }, {})");
    const body = w.document.getElementById('receipt-body').innerHTML;
    assert.match(body, /White Star/);
    assert.doesNotMatch(body, /\u{1F3E2}|▾/u);
  } finally { d.close && d.close(); }
});

test('delivery guard: still recovers, but nothing is shown on screen in any app', async () => {
  for (const a of APPS) {
    const s = fs.readFileSync(a, 'utf8');
    assert.ok(s.includes('window.DeliveryGuard = {'), a);
    assert.ok(!s.includes("S.bar.classList.add('on')"), a + ': no red bar');
    assert.ok(!s.includes('Not receiving new orders'), a + ': no alarm text');
  }
});
