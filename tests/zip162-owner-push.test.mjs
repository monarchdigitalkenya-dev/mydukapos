import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';

// zip 162, job 5. The Owner Console has its own pushNow (it ignores skipPrePull). Conclusion (see CHANGES_ZIP_162_LEFTOVERS.md): it does NOT need the
// zip 160 pre-pull / stamping machinery, because it never stamps records (no stampDirty*), so a record carried from old storage keeps its own
// updatedAt and loses to the server's newer copy or tombstone; settings are left out until a pull (zip 155) and deletions are tracked by key acks.
// This test pins that: an owner console with OLD storage pushes FIRST and must not resurrect a till's deletion nor overwrite newer stock.
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const OWNER = { pos_owner_session_token: 'o2.tok', pos_owner_client_id: 'OWN1' };

test('owner console with stale storage pushing before any pull does not resurrect deleted items or overwrite newer stock', async () => {
  const { mergeIncomingState } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_merge.js')).href);
  const state = { data: { businessName: 'Shop', pwHash: 'h1', adminPwHash: 'h2', updatedAt: 9000,
    inventory: [{ code: 'A', name: 'Alpha', price: 10, qty: 10, updatedAt: 6000 }, { code: 'B', _deleted: true, updatedAt: 5000 }] } };
  const fetch = async (url, opts = {}) => {
    const u = String(url), method = (opts.method || 'GET').toUpperCase();
    if (/\/api\/owner-auth/.test(u)) return json({ hasAccount: true, authenticated: true, ownerClientId: 'OWN1' });
    if (/\/api\/health/.test(u)) return json({ ok: true });
    if (/\/api\/pos-sync/.test(u)) {
      if (method === 'GET') return json(state.data);
      const merged = mergeIncomingState(state.data, JSON.parse(opts.body)); const prev = state.data.updatedAt;
      merged.updatedAt = Math.max(Date.now(), prev + 1); state.data = merged;
      return json({ ok: true, updatedAt: merged.updatedAt, prev });
    }
    return json({});
  };
  const stale = [{ code: 'A', name: 'Alpha', price: 10, qty: 99, updatedAt: 1000 }, { code: 'B', name: 'Beta', price: 5, qty: 3, updatedAt: 1000 }];
  const t = await boot('owner/index.html', { storage: { ...OWNER, pos_inventory: JSON.stringify(stale) }, fetch, wait: 300 });
  t.w.eval('showToast = function () {}');
  await t.w.eval('pushNow()');
  await new Promise((r) => setTimeout(r, 300));
  const inv = state.data.inventory;
  const A = inv.find((i) => i.code === 'A'), B = inv.find((i) => i.code === 'B');
  assert.equal(A.qty, 10, 'newer server stock wins over the stale copy');
  assert.ok(B._deleted, 'the till\'s deletion survives');
  assert.equal(A.updatedAt, 6000, 'untouched records are not re-stamped');
  t.close();
});

test('owner console source has no per-record stamping, so the zip 160 stamp safeguards are not needed there', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'owner/index.html'), 'utf8');
  assert.ok(!/stampDirtyInventory|stampDirtyExtraSyncedFields/.test(src));
  assert.ok(/__ownerPulled/.test(src), 'settings stay out of a pre-pull push');
});
