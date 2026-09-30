// functions/api/_migrate.js — shared helper, NOT a route.
//
// Moves ONE shop from a single JSON record into its own database (wildcard-router/shop-store.js), verified, with the old record kept as a
// rollback copy. Used by the Owner Console's "Move to database" buttons AND automatically when a link becomes permanent.
// While it runs the shop is flagged 'migrating', so pushes are told to retry in a few seconds (503) — nothing can land in the wrong place.
// On any failure the shop is left EXACTLY as it was and the error is thrown.

import { readStateRaw, shopMode, shopCall, MODE_PREFIX, forgetShopMode } from './_state-store.js';
import { MERGE_BY_ID_FIELDS } from './_merge.js';

export async function migrateShopToDatabase(env, clientId) {
  if (!env.SHOP_STORE) throw new Error('the shop database is not set up on this project (no SHOP_STORE binding)');
  const modeKey = MODE_PREFIX + clientId;
  const current = await shopMode(env, clientId);
  if (current === 'do') return { changed: false };
  if (current === 'migrating') throw new Error('a move is already in progress for this shop');
  await env.mydukapos_kv.put(modeKey, 'migrating', { expirationTtl: 300 });
  forgetShopMode(env, clientId);
  try {
    const cur = await readStateRaw(env, 'pos-data:state:' + clientId);
    const state = cur ? JSON.parse(cur.text) : { updatedAt: 0 };
    const imp = await shopCall(env, clientId, 'import', { state });
    if (!imp.ok) throw new Error('import failed');
    const stats = await (await shopCall(env, clientId, 'stats', {})).json();
    const have = new Map((stats.collections || []).map((c) => [c.col, c.n]));
    for (const col of MERGE_BY_ID_FIELDS) {
      const want = Array.isArray(state[col]) ? state[col].length : 0;
      if (want && (have.get(col) || 0) < want) throw new Error(`verification failed for ${col} (${have.get(col) || 0} of ${want})`);
    }
    // A save that was already on its way when the move began may land in the old record just after it was read. Give it a moment,
    // then bring anything newer across too (the database merges by record and applies each stock movement once). (zip 123)
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, env.MIGRATE_SETTLE_MS != null ? Number(env.MIGRATE_SETTLE_MS) : 1500));
      const again = await readStateRaw(env, 'pos-data:state:' + clientId);
      const later = again ? JSON.parse(again.text) : null;
      if (!later || (Number(later.updatedAt) || 0) <= (Number(state.updatedAt) || 0)) break;
      const imp2 = await shopCall(env, clientId, 'import', { state: later });
      if (!imp2.ok) throw new Error('import failed');
      state.updatedAt = later.updatedAt;
    }
    const records = (stats.collections || []).reduce((n, c) => n + c.n, 0);
    await env.mydukapos_kv.put(modeKey, 'do', { metadata: { at: Date.now(), records, bytes: stats.bytes } });
    forgetShopMode(env, clientId);
    return { changed: true, records, bytes: stats.bytes };
  } catch (e) {
    await env.mydukapos_kv.delete(modeKey);            // leave the shop exactly as it was
    forgetShopMode(env, clientId);
    throw e;
  }
}
