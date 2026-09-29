import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';

// zip 155: "the Android / Windows app does not carry the link's logo and receipt settings". A NEW device must (1) receive them when it opens the
// link and (2) never wipe them, even when its first push reaches the server before it has ever pulled.
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0));

async function shopWithSettings(app) {
  const s = makeServer();
  const a = await openDevice(app, s, { pos_biz_name: 'Mama Njeri', aqua_biz_name: 'Mama Njeri' });
  a.w.eval(`showToast = function () {}`);
  a.w.eval(`receiptLogoData = ${JSON.stringify(LOGO)}; safeSetItem('pos_receipt_logo', receiptLogoData); receiptShowLogo = true; safeSetItem('pos_receipt_show_logo', 'true');
            receiptFooterNotes = 'Goods once sold are not returnable'; safeSetItem('pos_receipt_footer_notes', receiptFooterNotes);
            receiptContact = '0700 111 222'; safeSetItem('pos_receipt_contact', receiptContact); receiptWidth = '58'; safeSetItem('pos_receipt_width', '58');
            extraSettingsApply({ receiptStampSrc: ${JSON.stringify(LOGO)}, receiptShowStamp: true, receiptStampAngle: -10 });`);
  a.w.eval('queuePush()');
  await settled(a);
  return { s, a };
}

test('a brand-new device that opens the shop link gets the logo, the receipt settings and the stamp', async () => {
  const { s, a } = await shopWithSettings('index.html');
  assert.equal(s.serverState().receiptLogo, LOGO, 'the server has the logo');
  const b = await openDevice('index.html', s, {}, 2500);        // nothing on this device: like a freshly installed app
  assert.equal(b.w.eval('receiptLogoData'), LOGO, 'logo');
  assert.equal(b.w.eval('receiptShowLogo'), true, 'print-logo switch');
  assert.equal(b.w.eval('receiptFooterNotes'), 'Goods once sold are not returnable');
  assert.equal(b.w.eval('receiptContact'), '0700 111 222');
  assert.equal(b.w.eval('receiptWidth'), '58');
  assert.equal(b.w.eval('rxSettings.showStamp'), true, 'stamp on');
  assert.equal(b.w.eval('rxSettings.stampAngle'), -10, 'stamp tilt');
  assert.equal(b.w.eval('rxSettings.stampSrc'), LOGO, 'stamp picture');
  a.close(); b.close();
});

test('a new device whose first push reaches the server BEFORE it ever pulled does not wipe the shop\'s settings', async () => {
  const { s, a } = await shopWithSettings('index.html');
  s.state.down = true;                                          // the new device starts with no connection: it keeps its empty defaults
  const b = await openDevice('index.html', s, {}, 900);
  b.w.eval('showToast = function () {}');
  s.state.down = false;
  b.w.eval('queuePush()');                                      // its first contact with the server is a PUSH of those defaults
  await settled(b);
  await sleep(200);
  const st = s.serverState();
  assert.equal(st.receiptLogo, LOGO, 'logo kept');
  assert.equal(st.receiptShowLogo, true, 'print-logo kept');
  assert.equal(st.receiptFooterNotes, 'Goods once sold are not returnable', 'footer kept');
  assert.equal(st.receiptContact, '0700 111 222', 'contact kept');
  assert.equal(st.receiptWidth, '58', 'paper width kept');
  assert.equal(st.receiptShowStamp, true, 'stamp kept');
  // and the first device, refreshed, still has everything
  const a2 = await openDevice('index.html', s, deviceStorage(a.w), 1500);
  assert.equal(a2.w.eval('receiptLogoData'), LOGO);
  a.close(); b.close(); a2.close();
});

test('removing the logo on a device that has the shop\'s data still removes it everywhere', async () => {
  const { s, a } = await shopWithSettings('index.html');
  a.w.eval("removeReceiptLogo && removeReceiptLogo()");
  await settled(a);
  assert.equal(s.serverState().receiptLogo, '', 'a real removal (stamped change) goes through');
  a.close();
});
