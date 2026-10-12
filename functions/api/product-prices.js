// functions/api/product-prices.js — Cloudflare Pages Function (zip 263)
// Owner Console -> Prices. { action: 'get' } lists every product with its price, branch price and the website price used when none is set;
// { action: 'set', prices: { shop: 3500 }, branchPrices: { shop: 2000 } } saves them (an empty value removes that override). Owner session only.
import { requireOwnerAuth } from './_owner-auth.js';
import { PRODUCTS } from './_license.js';
import { readPrices, savePrices, websitePrice } from './_prices.js';

const json = (b, st) => new Response(JSON.stringify(b), { status: st || 200, headers: { 'Content-Type': 'application/json' } });

export async function onRequestPost(context) {
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  let body = {}; try { body = await context.request.json(); } catch (e) { return json({ error: 'Invalid request.' }, 400); }
  const { env } = context;
  if (body.action === 'set') await savePrices(env, body);
  else if (body.action !== 'get') return json({ error: 'Unknown action.' }, 400);
  const cur = await readPrices(env);
  return json({ ...cur, websitePrice: await websitePrice(env), products: Object.keys(PRODUCTS).map((id) => ({ id, label: PRODUCTS[id].label })) });
}
