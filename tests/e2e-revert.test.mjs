import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// "I changed something, refreshed, and it was back." Reproduced end to end: a REAL app talking to the REAL server code.
const ITEMS = [{ code: '00001', type: 'item', name: 'Widget', price: 100, wholesaleSellingPrice: 80, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const price = (w) => w.eval("inventory.find(p => p.code === '00001').price");
const quiet = (w) => w.eval('showToast = function () {}');

test('an edit survives a refresh: normal, refreshed at once, server unreachable, or pushes refused', async () => {
  for (const mode of ['online', 'immediate', 'offline', 'refused']) {
    const s = makeServer();
    const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
    await a.w.eval('pushNow()');
    quiet(a.w);
    if (mode === 'offline') s.state.down = true;
    if (mode === 'refused') s.state.status = 413;
    a.w.eval("updateInventoryField('00001', 'price', '99')");
    if (mode !== 'immediate') await sleep(700);
    const store = deviceStorage(a.w); a.close();
    s.state.down = false; s.state.status = null;
    const b = await openDevice('index.html', s, store, 1500);
    assert.equal(price(b.w), 99, mode);
    assert.equal(s.serverState().inventory[0].price, 99, mode + ': and the server has it');
    b.close();
  }
});

test('a setting changed on till A is NOT put back by till B, which has not refreshed and pushes its old copy', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  await a.w.eval('pushNow()');
  await sleep(50);
  const b = await openDevice('index.html', s, deviceStorage(a.w), 1200);          // till B starts from the same state
  quiet(a.w); quiet(b.w);
  a.w.eval("receiptFooterNotes = 'Thank you - new footer'; safeSetItem('pos_receipt_footer_notes', receiptFooterNotes); queuePush()");
  await sleep(900);
  assert.equal(s.serverState().receiptFooterNotes, 'Thank you - new footer');
  b.w.eval("updateInventoryField('00001', 'price', '88')");                        // B saves something unrelated; its payload still carries the OLD footer
  await sleep(900);
  assert.equal(s.serverState().receiptFooterNotes, 'Thank you - new footer', 'the stale copy did not overwrite the change');
  assert.equal(s.serverState().inventory[0].price, 88, 'B\'s own change still went through');
  // A polls and refreshes: still there
  await a.w.eval('pullState()');
  assert.equal(a.w.eval('receiptFooterNotes'), 'Thank you - new footer');
  const a2 = await openDevice('index.html', s, deviceStorage(a.w), 1500);
  assert.equal(a2.w.eval('receiptFooterNotes'), 'Thank you - new footer');
  // and B picks the new footer up on its next pull instead of pushing its old one again
  await b.w.eval('pullState()');
  assert.equal(b.w.eval('receiptFooterNotes'), 'Thank you - new footer');
  a.close(); a2.close(); b.close();
});

test('an incoming update from another till landing while my edit is still unsent does not wipe my edit', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  await a.w.eval('pushNow()');
  quiet(a.w);
  a.w.eval("updateInventoryField('00001', 'price', '99')");                         // edit made, push not fired yet
  const older = s.serverState(); older.updatedAt = Date.now() + 1000;               // another till just pushed something: the server copy is newer but has the OLD price
  await a.w.eval('pullState()');                                                    // the poll fires inside my 300 ms window
  await sleep(600);
  assert.equal(price(a.w), 99, 'my edit is still here');
  assert.equal(s.serverState().inventory[0].price, 99, 'and it reached the server first');
  a.close();
});

test('a change that cannot be sent is kept, retried on the next poll, and delivered once the server answers again', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  await a.w.eval('pushNow()');
  quiet(a.w);
  s.state.status = 500;
  a.w.eval("updateInventoryField('00001', 'price', '55')");
  await sleep(700);
  await a.w.eval('pullState()');                                                     // poll while the server still refuses pushes
  assert.equal(price(a.w), 55, 'not overwritten by a pull');
  s.state.status = null;
  a.w.eval('window.__pushBackoffUntil = 0');                                         // (the short pause after a failure has elapsed)
  await a.w.eval('pullState()');                                                     // next poll retries the push first
  assert.equal(s.serverState().inventory[0].price, 55, 'delivered');
  assert.equal(price(a.w), 55);
  a.close();
});

test('Aqua POS: a setting changed on one till survives another till\'s stale push, and unsent edits are not wiped by a pull', async () => {
  const s = makeServer();
  const a = await openDevice('water/index.html', s, {});
  await a.w.eval('pushNowOrWarn("t")');
  await sleep(50);
  const b = await openDevice('water/index.html', s, deviceStorage(a.w), 1200);
  quiet(a.w); quiet(b.w);
  a.w.eval("billPaymentDetails = 'Till 123456'; safeSetItem('aqua_bill_payment_details', billPaymentDetails); queuePush()");
  await sleep(900);
  assert.equal(s.serverState().billPaymentDetails, 'Till 123456');
  b.w.eval("lowStockThreshold = 9; safeSetItem('aqua_low_stock_threshold', '9'); queuePush()");              // B: unrelated change, but its payload still has the old billPaymentDetails
  await sleep(900);
  assert.equal(s.serverState().billPaymentDetails, 'Till 123456', 'not reverted');
  assert.equal(s.serverState().lowStockThreshold, 9, 'B\'s own change went through');
  // an incoming pull while an edit is unsent
  a.w.eval("billPaymentDetails = 'Till 999'; safeSetItem('aqua_bill_payment_details', billPaymentDetails); queuePush()");
  await a.w.eval('pullFromServer()');                                                                        // fires inside the 300 ms window
  await sleep(700);
  assert.equal(a.w.eval('billPaymentDetails'), 'Till 999');
  assert.equal(s.serverState().billPaymentDetails, 'Till 999');
  a.close(); b.close();
});

test('a shop whose pushes keep failing does not re-send itself on every poll (growing pause), and recovers when the server answers', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  await a.w.eval('pushNow()');
  quiet(a.w);
  s.state.status = 413;
  a.w.eval("updateInventoryField('00001', 'price', '55')");
  await sleep(700);
  const posts = () => s.state.log.filter((l) => l.startsWith('POST')).length;
  const before = posts();
  for (let i = 0; i < 6; i++) await a.w.eval('pullState()');                          // six polls in a row
  assert.ok(posts() - before <= 1, `only ${posts() - before} retry in six polls`);
  assert.equal(price(a.w), 55, 'edit kept meanwhile');
  s.state.status = null;
  a.w.eval('window.__pushBackoffUntil = 0');                                            // (the pause has elapsed)
  await a.w.eval('pullState()');
  assert.equal(s.serverState().inventory[0].price, 55, 'delivered after recovery');
  a.close();
});

test('the client\'s list of per-record collections matches the server\'s, so no setting is stamped as a collection or vice versa', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { ROOT } = await import('./helpers.mjs');
  const { MERGE_BY_ID_FIELDS } = await import(new URL('../functions/api/_merge.js', import.meta.url).href);
  const src = fs.readFileSync(path.join(ROOT, 'src/shared/functions.js'), 'utf8');
  const block = src.match(/const MERGED = new Set\(\[([\s\S]*?)\]\)/)[1];
  const client = [...block.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(client, [...MERGE_BY_ID_FIELDS].sort());
});
