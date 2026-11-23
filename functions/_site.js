// functions/_site.js — shared constants for the PUBLIC marketing site, NOT a route (Pages ignores files starting with "_" for routing).
//
// One list of what the public site contains, used by the middleware (clean URLs), robots.txt, sitemap.xml and the page generator
// (tools/build-public-pages.mjs). Everything here is public information that is already on the site; nothing private belongs in this file.

import { getRootDomain, hostnameFromRequest, subdomainLabel } from './api/_license.js';

export const SITE_NAME = 'MyDukaPOS';
export const DEFAULT_SITE_ORIGIN = 'https://mydukapos.store';   // only used when the request itself has no usable host (tests, tools)
export const SUPPORT_WHATSAPP = '254791598506';                  // the number already on the public site's WhatsApp button

// Legal pages: served on EVERY host (the POS sign-up screens on a client's own subdomain link to them).
export const LEGAL_PAGES = {
  '/terms': 'terms',
  '/privacy': 'privacy',
  '/cookies': 'cookies',
  '/acceptable-use': 'acceptable-use',
};
// Marketing pages: the apex only.
export const APEX_PAGES = {
  '/faq': 'faq',
  '/contact': 'contact',
  '/offers': 'offers',
  '/shop': 'shop',
  '/portfolio': 'portfolio',
  '/websites': 'websites',   // zip 303: the website-development offer + enquiry form
};
// Files the marketing pages load with root-relative URLs (kept next to the pages in /public-site/).
export const APEX_FILES = /^\/(?:app\.html|dashboard\.html|site\.css|site\.js|premium\.css|home-pro\.(?:css|js)|motion\.js|shop-art\.js|shop-ui\.js|shop-catalog\.json|img\/[A-Za-z0-9_.-]+)$/;

// Product pages, /products/<id>. Names and one-line descriptions match public-site/app.html (checked by tests/zip177-public-site.test.mjs).
export const PRODUCT_PAGES = {
  shop: { name: 'Shop POS', description: 'Point of sale for retail shops, hardware stores, supermarkets and minimarts: barcode inventory, wholesale and retail pricing, multi-branch, M-Pesa payments and tax records, with offline selling.' },
  hotel: { name: 'Hotel / Restaurant / Bar POS', description: 'One POS for hotels, restaurants and bars: tables, rooms, takeaway and kitchen tickets, connected, with M-Pesa and offline operation.' },
  hospital: { name: 'Hospital / HMIS', description: 'A lightweight hospital management system: patient records, consultations, pharmacy dispensing and billing, without the complexity of enterprise HMIS software.' },
  production: { name: 'Production POS', description: 'POS for businesses that build what they sell: assemble finished goods from raw components, hire equipment out and track every batch.' },
  pharmacy: { name: 'Pharmacy POS', description: 'Pharmacy point of sale with batch-level expiry tracking, FEFO stock rotation and prescription records.' },
  services: { name: 'Services POS (Repairs, Salons & Bookings)', description: 'POS for phone and electronics repair shops, salons, barbershops, garages and laundromats: client jobs, staff bookings and appointments.' },
  water: { name: 'Water Refill Station POS (AquaPOS)', description: 'POS for water refill stations and bottling shops: dispensers, bales and bulk tanks, tiered pricing, delivery zones and refill tracking.' },
  carwash: { name: 'Car Wash & Cleaning', description: 'Car wash and cleaning management: check-in by number plate, a live jobs board, carpets and house cleaning, 9 + 1 loyalty, automatic SMS, job billing with M-Pesa and staff reports.' },
};

// Everything in sitemap.xml: the indexable public pages and nothing else. Each entry is { path, group }.
// No <priority> / <changefreq> (Google ignores both) and no <lastmod>: the site keeps no genuine per-page "last changed" date, and a made-up
// date is worse than none. If a real date source appears (a CMS, a build manifest), add `lastmod` to the entry and sitemap.xml.js will print it.
// The Offers page is listed because it always exists, even with no active offer.
export function sitemapEntries() {
  return [
    { path: '/', group: 'home' },
    ...Object.keys(PRODUCT_PAGES).map((k) => ({ path: '/products/' + k, group: 'product' })),
    { path: '/shop', group: 'page' },
    { path: '/websites', group: 'page' },
    { path: '/portfolio', group: 'page' },
    { path: '/offers', group: 'page' },
    { path: '/faq', group: 'page' },
    { path: '/contact', group: 'page' },
    { path: '/terms', group: 'legal' },
    { path: '/privacy', group: 'legal' },
    { path: '/cookies', group: 'legal' },
    { path: '/acceptable-use', group: 'legal' },
  ];
}

// Every public URL path the application serves on the apex, indexable or not, with the reason when it is kept out of search.
// Used by the Owner Console SEO audit so "discovered" and "eligible" are counted separately.
export const NOINDEX_PUBLIC = [
  { path: '/dashboard.html', reason: 'Signed-in account page (noindex header + meta)' },
  { path: '/pesapal-done.html', reason: 'Payment return page (noindex header)' },
  { path: '/app.html', reason: 'Template behind /products/<id>; the clean product URLs are the indexable ones' },
];

// The paths robots.txt keeps crawlers out of (apps, consoles, APIs). robots.txt is a courtesy, not security — all of these are also protected by
// sign-in and answer with X-Robots-Tag: noindex (see _headers).
export const PRIVATE_PATHS = ['/api/', '/owner/', '/crm/', '/hotel/', '/hospital/', '/pharmacy/', '/production/', '/services/', '/water/', '/carwash/', '/order/', '/dashboard.html', '/pesapal-done.html', '/pay/'];

// The ONE canonical origin for legal pages, canonical URLs and the sitemap: the apex of this deployment's root domain (ROOT_DOMAIN), or the default
// production origin when the env has none. Never the current subdomain, never a *.pages.dev preview.
export function canonicalOrigin(env) {
  const root = env && getRootDomain(env);
  return root ? `https://${root}` : DEFAULT_SITE_ORIGIN;
}

// Is this request for a client's own subdomain (shop.mydukapos.store) as opposed to the apex, www, a *.pages.dev preview or localhost?
export function isTenantHost(request, env) {
  return !!subdomainLabel(hostnameFromRequest(request, env), getRootDomain(env));
}

// Is this request for the bare apex domain (or www) — the marketing site — as opposed to a client's own subdomain or any other host?
export function isApexRequest(request, env) {
  const hostname = hostnameFromRequest(request, env);
  const rootDomain = getRootDomain(env);
  const label = subdomainLabel(hostname, rootDomain);
  // subdomainLabel() returns '' for both the bare apex/www AND for any hostname that isn't under this root domain at all (e.g. a *.pages.dev
  // preview URL) — the explicit hostname === rootDomain / www check is what narrows this down to specifically the apex case.
  return !label && (hostname === rootDomain || hostname === `www.${rootDomain}`);
}

