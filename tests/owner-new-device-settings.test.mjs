import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT, until } from './helpers.mjs';

// zip 155: the Owner Console on a NEW device (the Android / Windows app) pushed its empty defaults before it pulled, and the owner's logo, receipt
// notes and payment details were overwritten with blanks on the server. It must carry them instead, and a real change must still go through.
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const OWNER = { pos_owner_session_token: 'o2.tok', pos_owner_client_id: 'OWN1' };

async function server(initial) {
  const { mergeIncomingState } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_merge.js')).href);
  const state = { data: { ...initial, updatedAt: 1000 }, pushes: [] };
  const fetch = async (url, opts = {}) => {
    const u = String(url), method = (opts.method || 'GET').toUpperCase();
    if (/\/api\/owner-auth/.test(u)) return json({ hasAccount: true, authenticated: true, ownerClientId: 'OWN1' });
    if (/\/api\/health/.test(u)) return json({ ok: true });
    if (/\/api\/pos-sync/.test(u)) {
      if (method === 'GET') return json(state.data);
      const body = JSON.parse(opts.body); state.pushes.push(body);
      const merged = mergeIncomingState(state.data, body); merged.updatedAt = Math.max(Date.now(), (state.data.updatedAt || 0) + 1);
      const prev = state.data.updatedAt; state.data = merged;
      return json({ ok: true, updatedAt: merged.updatedAt, prev });
    }
    return json({});
  };
  return { state, fetch };
}

test('a new device running the Owner Console does not wipe the logo / receipt notes / payment details / tab locks on the server', async () => {
  const s = await server({ businessName: 'Owner Shop', pwHash: 'h1', adminPwHash: 'h2', receiptLogo: LOGO, receiptShowLogo: true, receiptFooterNotes: 'Thanks!', paymentDetails: 'Till 123', lockedTabs: ['settings-tab'], vatRateA: 16 });
  const t = await boot('owner/index.html', { storage: OWNER, fetch: s.fetch, wait: 2500 });
  t.w.eval('showToast = function () {}');
  await t.w.eval('pushNow()');
  await new Promise((r) => setTimeout(r, 200));
  const d = s.state.data;
  assert.equal(d.receiptLogo, LOGO, 'logo kept');
  assert.equal(d.receiptShowLogo, true);
  assert.equal(d.receiptFooterNotes, 'Thanks!');
  assert.equal(d.paymentDetails, 'Till 123');
  assert.deepEqual(d.lockedTabs, ['settings-tab']);
  // and the new device shows them after its pull
  assert.equal(t.w.eval('receiptLogoData'), LOGO);
  assert.equal(t.w.eval('receiptFooterNotes'), 'Thanks!');
  t.close();
});

test('an Owner Console change to a setting still goes through (stamped), also right after a reload', async () => {
  const s = await server({ businessName: 'Owner Shop', pwHash: 'h1', adminPwHash: 'h2', receiptFooterNotes: 'old notes', paymentDetails: 'Till 123' });
  const t = await boot('owner/index.html', { storage: OWNER, fetch: s.fetch, wait: 2500 });
  t.w.eval('showToast = function () {}');
  t.w.eval("receiptFooterNotes = 'new notes'; safeSetItem('pos_receipt_footer_notes', receiptFooterNotes); queuePush()");
  assert.ok(await until(() => s.state.data.receiptFooterNotes === 'new notes', 8000), 'the new footer notes reached the server');
  assert.equal(s.state.data.paymentDetails, 'Till 123', 'an untouched setting stays');
  t.close();
});
