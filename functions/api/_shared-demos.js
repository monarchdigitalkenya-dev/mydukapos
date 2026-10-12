// functions/api/_shared-demos.js — zip 262. Not a route.
//
// THE SHARED PUBLIC DEMOS. One fixed, permanent demo shop per product. A visitor never creates anything: they open the product's fixed address
// (demo-<name>.<domain>), sign in with the demo password (0000) and use a fully loaded business. The server treats these shops as read-only
// (see _license.js: sharedDemo), so one visitor cannot change what the next one sees - their edits live only on their own device, and "Reset demo"
// (shared-demo.html block) clears that device's copy.
//
//   * the shop records are FIXED (id demo_<name>, address demo-<name>): created once, never per visitor, never deleted by a visit
//   * the sample data is built by pure generators (_demo-seeds.js) and stored with seedInitialState() - the same path a real shop's setup uses
//   * seeding is idempotent and versioned: it runs when the demo has never been seeded, when SEED_VERSION is raised, or when the copy is older than
//     REFRESH_MS (so the relative dates stay current). The same ids are produced every time.
//   * nothing here touches any other shop: a demo id can only ever resolve to a record with sharedDemo === true (checked again right before writing)

import { ensureSharedDemoRecord, clientLink, getLicense } from './_license.js';
import { seedInitialState } from './pos-sync.js';
import { buildDemoSeed } from './_demo-seeds.js';
import { DEMO_PASSWORD_HASH, SEED_VERSION } from './_demo-const.js';

const REFRESH_MS = 14 * 24 * 3600 * 1000;
export const SEED_MARK = 'shared-demo-seed:';

// key -> shop record + the gallery text. `product` is the license product (the Shop app serves retail, hardware and liquor).
export const SHARED_DEMOS = [
  { key: 'hospital', product: 'hospital', title: 'Hospital HMIS', tag: 'Clinical', blurb: 'Patients, visits with SOAP notes and vitals, prescriptions, lab results with reference ranges, admissions, appointments, queue and pharmacy stock with expiry.', features: ['Patient register & allergies', 'Consolidated prescriptions with NA items', 'Labs with reference ranges', 'Admissions & bed charges', 'Appointments & queue', 'Medicine stock with expiry'] },
  { key: 'hotel', product: 'hotel', title: 'Hotel & Restaurant', tag: 'Hospitality', blurb: 'A working restaurant with tables, a bar, rooms with guests checked in, room charges, and a month of sales.', features: ['Tables, tabs & kitchen menu', 'Rooms, check-in & deposits', 'Bar & drinks', 'Room service charges', 'Daily sales reports'] },
  { key: 'retail', product: 'shop', title: 'Retail Shop', tag: 'Retail', blurb: 'A neighbourhood supermarket: groceries, household, personal care, snacks and more, with customers on credit and a month of sales.', features: ['Barcode-ready catalogue', 'Categories & stock alerts', 'Customers, bills & statements', 'Cash, M-Pesa & card sales', 'Profit and stock reports'] },
  { key: 'hardware', product: 'shop', title: 'Hardware Store', tag: 'Retail', blurb: 'Cement, steel, plumbing, electrical, paint, timber and tools - sold by the bag, kilogram, gram, metre, foot, litre and piece, with decimal quantities.', features: ['Sold by kg, g, m, ft, L and pcs', 'Partial quantities', 'Category & sub-category browsing', 'Credit customers', 'Stock and margin reports'] },
  { key: 'liquor', product: 'shop', title: 'Liquor Store', tag: 'Retail', blurb: 'Brandy, whisky, vodka, gin, rum, tequila, wines, beer, cider, RTDs, soft drinks and mixers - grouped into sub-categories with stock movements.', features: ['Category › sub-category stock', 'Bottles, cans & crates', 'Fast counter filtering', 'Stock movements', 'Sales by category'] },
  { key: 'pharmacy', product: 'pharmacy', title: 'Pharmacy', tag: 'Health', blurb: 'Medicines by batch with expiry dates, an expired batch flagged, low-stock alerts, patients and a month of sales.', features: ['Batch & expiry tracking', 'Low-stock & expired alerts', 'Patient records & allergies', 'Cash / M-Pesa sales', 'Supplier orders'] },
  { key: 'production', product: 'production', title: 'Production & Bakery', tag: 'Manufacturing', blurb: 'Bread, cakes, dairy and packaged foods with raw materials, production batches and sales.', features: ['Production batches', 'Raw materials stock', 'Finished-goods sales', 'Cost per unit', 'Wholesale & retail pricing'] },
  { key: 'services', product: 'services', title: 'Salon & Services', tag: 'Services', blurb: 'Salon services with bookings, service jobs in progress, customers and a month of takings.', features: ['Bookings calendar', 'Service jobs & quotes', 'Staff & customers', 'Cash / M-Pesa payments', 'Daily takings'] },
  { key: 'water', product: 'water', title: 'Water Business', tag: 'Distribution', blurb: 'Bottled water and refills with a storage tank, tank refill log, customers on credit and daily sales.', features: ['Bottled & refill sales', 'Tank volume & refill log', 'Customers & credit', 'Cash / M-Pesa payments', 'Sales reports'] },
].map((d) => ({ ...d, id: 'demo_' + d.key, slug: 'demo-' + d.key, label: d.title + ' (sample)', password: '0000' }));

export function findSharedDemo(key) { return SHARED_DEMOS.find((d) => d.key === String(key || '').toLowerCase()) || null; }

// Make sure this demo's shop record exists and carries the current sample data. Safe to call on every visit: when nothing is due it costs one KV read for the
// seed mark and one for the record. `force` (Owner Console only) re-seeds at once.
export async function ensureSharedDemo(env, spec, opts = {}) {
  const { record } = await ensureSharedDemoRecord(env, { id: spec.id, product: spec.product, slug: spec.slug, label: spec.label, svcType: spec.key === 'services' ? 'salon' : undefined });
  if (!record || record.sharedDemo !== true) throw new Error('not a shared demo');            // hard guard: never seed a real shop
  const now = Date.now();
  let mark = null;
  try { mark = JSON.parse((await env.mydukapos_kv.get(SEED_MARK + spec.id)) || 'null'); } catch (e) { mark = null; }
  const due = opts.force || !mark || mark.v !== SEED_VERSION || now - (mark.at || 0) > REFRESH_MS;
  let seeded = false;
  if (due) {
    const seed = buildDemoSeed(spec.key, now);
    await seedInitialState(env, spec.id, { ...seed, pwHash: DEMO_PASSWORD_HASH, adminPwHash: DEMO_PASSWORD_HASH, demoSeedVersion: SEED_VERSION, demoSeededAt: now });
    await env.mydukapos_kv.put(SEED_MARK + spec.id, JSON.stringify({ v: SEED_VERSION, at: now }));
    seeded = true;
  }
  return { record, seeded };
}

export function demoLink(env, spec, origin) {
  return clientLink(env, { id: spec.id, slug: spec.slug, product: spec.product }, origin);
}
export { getLicense };
