// zip 336: loads the Stock Engine block (src/shared/blocks/stock-engine.html) into a plain Node context for unit tests.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers.mjs';
export function loadSE(extra = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'src/shared/blocks/stock-engine.html'), 'utf8');
  const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  let n = 0;
  const store = new Map();
  const ctx = { console, Date, Math, JSON, Number, String, Array, Object, Map, WeakMap, Set, isFinite, RegExp,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    genSaleId: () => 'id' + (++n), ...extra };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(js, ctx);
  return ctx;
}
