// A stand-in for the SHOP_STORE Durable Object binding: one real ShopStore (on node:sqlite) per shop id.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

// node:sqlite exists from Node 22.5. On older Node these tests are skipped, not failed.
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (e) { /* skipped below */ }
export const hasSqlite = !!DatabaseSync;

export function fakeDoState() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(q, ...b) {
      const st = db.prepare(q);
      if (/^\s*(select|with|pragma)/i.test(q)) { const rows = st.all(...b); return { toArray: () => rows }; }
      st.run(...b); return { toArray: () => [] };
    },
  };
  return { storage: { sql, transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } } };
}

export async function makeBinding({ failOn } = {}) {
  const { ShopStore } = await import(pathToFileURL(path.join(ROOT, 'wildcard-router/shop-store.js')).href);
  const stores = new Map();
  const binding = {
    stores,
    idFromName: (n) => n,
    get: (id) => ({
      fetch: async (url, opts) => {
        if (failOn && String(url).endsWith(failOn)) return new Response('{"error":"boom"}', { status: 500 });
        if (!stores.has(id)) stores.set(id, new ShopStore(fakeDoState(), {}));
        return stores.get(id).fetch(new Request(url, opts));
      },
    }),
  };
  return binding;
}
