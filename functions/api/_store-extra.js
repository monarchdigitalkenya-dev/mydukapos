// functions/api/_store-extra.js - the extra details a Store item can carry beyond name / code / unit / prices / qty (zip 301):
// category, supplier, notes, reorder level, minimum selling price, and the variant link (a variant is its own store line, with
// parentId pointing at its group line; the group line has isGroup = true and holds no stock itself).
// Kept apart from the stock columns so a stock change can never be blocked by, or corrupt, a descriptive detail.
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : null; };

// Returns { set: {...}, clear: [...] } from a loose fields object. Unknown keys are ignored. A blank value clears the detail.
export function cleanExtras(f) {
  const set = {}, clear = [];
  if (!f || typeof f !== 'object') return { set, clear };
  for (const [k, max] of [['category', 60], ['supplier', 80], ['notes', 400], ['variantName', 80], ['parentId', 40]]) {
    if (f[k] === undefined) continue;
    const s = String(f[k] == null ? '' : f[k]).trim().slice(0, max);
    if (s) set[k] = s; else clear.push(k);
  }
  for (const k of ['reorderLevel', 'minimumPrice']) {
    if (f[k] === undefined) continue;
    if (f[k] === '' || f[k] === null) { clear.push(k); continue; }
    const n = num(f[k]); if (n === null) return { error: `Enter a valid ${k === 'reorderLevel' ? 'reorder level' : 'minimum price'}.` };
    set[k] = n;
  }
  if (f.isGroup !== undefined) { if (f.isGroup) set.isGroup = true; else clear.push('isGroup'); }
  return { set, clear };
}

export function applyExtras(obj, ex) {
  const o = Object.assign({}, obj || {});
  for (const k of ex.clear || []) delete o[k];
  Object.assign(o, ex.set || {});
  return o;
}

export const EXTRA_KEYS = ['category', 'supplier', 'notes', 'variantName', 'parentId', 'reorderLevel', 'minimumPrice', 'isGroup'];
