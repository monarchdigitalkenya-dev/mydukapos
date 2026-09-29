import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

// zip 155: "it doesn't carry the link's logo and receipt settings". A NEW device (the Android / Windows app, a new phone) starts with empty
// defaults; if its first push lands before it ever pulled, those defaults used to be saved over the shop's real logo and receipt settings.
const merge = (existing, incoming) => import(pathToFileURL(path.join(ROOT, 'functions/api/_merge.js')).href).then((m) => m.mergeIncomingState(existing, incoming));

const SHOP = { businessName: 'Biz', receiptLogo: 'data:image/png;base64,AAAA', receiptShowLogo: true, receiptFooterNotes: 'Thanks!', receiptContact: '0700', receiptWidth: '80', paymentDetails: 'Till 123', receiptQr: 'data:qr', receiptItemAlign: 'right' };

test('a brand-new device pushing empty / default settings does not wipe the shop\'s logo and receipt settings', async () => {
  const fresh = { businessName: 'Biz', receiptLogo: '', receiptFooterNotes: '', receiptContact: '', paymentDetails: '', receiptQr: '', updatedAt: Date.now() };
  const out = await merge({ ...SHOP, updatedAt: 1 }, fresh);
  // (only BLANK unstamped values are held back: a filled-in unstamped value is a real edit from a device without a baseline, see the Aqua POS revert test)
  for (const k of ['receiptLogo', 'receiptFooterNotes', 'receiptContact', 'paymentDetails', 'receiptQr']) assert.equal(out[k], SHOP[k], k + ' kept');
});

test('a person who really changes or removes a setting on a device that had the shop\'s data (stamped) still can', async () => {
  const t = Date.now();
  const out = await merge({ ...SHOP, updatedAt: 1 }, { ...SHOP, receiptLogo: '', receiptFooterNotes: 'New footer', receiptShowLogo: false, _fieldTimes: { receiptLogo: t, receiptFooterNotes: t, receiptShowLogo: t }, updatedAt: t });
  assert.equal(out.receiptLogo, '');
  assert.equal(out.receiptFooterNotes, 'New footer');
  assert.equal(out.receiptShowLogo, false);
  assert.equal(out.receiptContact, '0700', 'an untouched setting stays');
});

test('the very first device of a shop with no settings yet can set them', async () => {
  const out = await merge({ businessName: 'Biz', updatedAt: 1 }, { businessName: 'Biz', receiptLogo: 'data:logo', receiptFooterNotes: 'Hi', updatedAt: 2 });
  assert.equal(out.receiptLogo, 'data:logo');
  assert.equal(out.receiptFooterNotes, 'Hi');
});
