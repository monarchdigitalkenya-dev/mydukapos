// functions/api/_prices.js — shared helper, NOT a route (zip 263).
//
// What a product's link costs, editable by the owner (Owner Console -> Prices) instead of being fixed in code:
//   * price per product (shop, hotel, ...); a product with none uses the website price (Owner Console -> Website), which defaults to KES 3,000;
//   * a branch price per product, optional; with none a branch costs the same as the product.
// Stored in KV as { prices: { shop: 3000 }, branchPrices: { hotel: 2000 } }.

import { PRODUCTS } from './_license.js';

export const PRICES_KEY = 'product-prices:v1';
const pos = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 && n <= 10000000 ? n : 0; };

export async function readPrices(env) {
  let o = {}; try { o = JSON.parse((await env.mydukapos_kv.get(PRICES_KEY)) || '{}') || {}; } catch (e) { o = {}; }
  return { prices: o.prices && typeof o.prices === 'object' ? o.prices : {}, branchPrices: o.branchPrices && typeof o.branchPrices === 'object' ? o.branchPrices : {} };
}
export async function websitePrice(env) {
  let c = {}; try { c = JSON.parse((await env.mydukapos_kv.get('website-content')) || '{}'); } catch (e) { c = {}; }
  return pos(c.price) || 3000;
}
// { amount, branchAmount } for one product
export async function priceFor(env, product) {
  const { prices, branchPrices } = await readPrices(env);
  const amount = pos(prices[product]) || await websitePrice(env);
  return { amount, branchAmount: pos(branchPrices[product]) || amount };
}
// owner save: only known products, only positive whole numbers; an empty / zero value removes the override
export async function savePrices(env, body) {
  const clean = (m) => { const out = {}; for (const id of Object.keys(PRODUCTS)) { const n = pos(m && m[id]); if (n) out[id] = n; } return out; };
  const next = { prices: clean(body && body.prices), branchPrices: clean(body && body.branchPrices) };
  await env.mydukapos_kv.put(PRICES_KEY, JSON.stringify(next));
  return next;
}
