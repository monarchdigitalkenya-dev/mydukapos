import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';

// zip 155: "I change a setting, refresh, and it is back." A setting is sent with a change stamp only when the device knows what the server had.
// After a page reload the server often answers "unchanged" (nothing newer) - and then the device never learnt that baseline, so its NEXT
// change went out unstamped and the server ignored it in favour of an older stamped value.
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0));
const setFooter = (w, v) => w.eval(`receiptFooterNotes = ${JSON.stringify(v)}; safeSetItem('pos_receipt_footer_notes', receiptFooterNotes); queuePush()`);

test('a setting changed AFTER a reload (server "unchanged") is kept, not put back by an older stamped value', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_biz_name: 'Biz' });
  a.w.eval('showToast = function () {}');
  await a.w.eval('pushNow()');
  setFooter(a.w, 'first footer'); await settled(a);           // first change: stamped
  assert.equal(s.serverState().receiptFooterNotes, 'first footer');
  const store1 = deviceStorage(a.w); a.close();
  const a2 = await openDevice('index.html', s, store1, 1800);  // reload: the server has nothing newer, so this pull is "unchanged"
  a2.w.eval('showToast = function () {}');
  setFooter(a2.w, 'second footer'); await settled(a2);
  assert.equal(s.serverState().receiptFooterNotes, 'second footer', 'the change made after the reload reached the server');
  const store2 = deviceStorage(a2.w); a2.close();
  const a3 = await openDevice('index.html', s, store2, 1800);
  assert.equal(a3.w.eval('receiptFooterNotes'), 'second footer', 'and is still there after another refresh');
  a3.close();
});
