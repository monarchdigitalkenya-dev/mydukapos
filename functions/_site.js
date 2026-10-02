// functions/_site.js — shared constants for the PUBLIC marketing site, NOT a route (Pages ignores files starting with "_" for routing).
//
// One list of what the public site contains, used by the middleware (clean URLs), robots.txt, sitemap.xml and the page generator
// (tools/build-public-pages.mjs). Everything here is public information that is already on the site; nothing private belongs in this file.

import { getRootDomain, hostnameFromRequest, subdomainLabel } from './api/_license.js';

export const SITE_NAME = 'mydukapos';
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
};
// Files the marketing pages load with root-relative URLs (kept next to the pages in /public-site/).
export const APEX_FILES = /^\/(?:app\.html|dashboard\.html|site\.css|site\.js|img\/[A-Za-z0-9_.-]+)$/;

// Product pages, /products/<id>. Names and one-line descriptions match public-site/app.html (checked by tests/zip177-public-site.test.mjs).
export const PRODUCT_PAGES = {
  shop: { name: 'Shop POS', description: 'Point of sale for retail shops, hardware stores, supermarkets and minimarts: barcode inventory, wholesale and retail pricing, multi-branch, M-Pesa and KRA eTIMS, working offline.' },
  hotel: { name: 'Hotel / Restaurant / Bar POS', description: 'One POS for hotels, restaurants and bars: tables, rooms, takeaway and kitchen tickets, connected, with M-Pesa and offline operation.' },
  hospital: { name: 'Hospital / HMIS', description: 'A lightweight hospital management system: patient records, consultations, pharmacy dispensing and billing, without the complexity of enterprise HMIS software.' },
  production: { name: 'Production POS', description: 'POS for businesses that build what they sell: assemble finished goods from raw components, hire equipment out and track every batch.' },
  pharmacy: { name: 'Pharmacy POS', description: 'Pharmacy point of sale with batch-level expiry tracking, FEFO stock rotation and prescription records.' },
  services: { name: 'Services POS (Repairs, Salons & Bookings)', description: 'POS for phone and electronics repair shops, salons, barbershops, garages and laundromats: client jobs, staff bookings and appointments.' },
  water: { name: 'Water Refill Station POS (AquaPOS)', description: 'POS for water refill stations and bottling shops: dispensers, bales and bulk tanks, tiered pricing, delivery zones and refill tracking.' },
};

// Everything in sitemap.xml (path, how often it changes, priority). The Offers page is listed because it always exists, even with no active offer.
export function sitemapEntries() {
  const e = [
    { path: '/', changefreq: 'weekly', priority: '1.0' },
    ...Object.keys(PRODUCT_PAGES).map((k) => ({ path: '/products/' + k, changefreq: 'monthly', priority: '0.8' })),
    { path: '/offers', changefreq: 'daily', priority: '0.7' },
    { path: '/faq', changefreq: 'monthly', priority: '0.6' },
    { path: '/contact', changefreq: 'yearly', priority: '0.5' },
    { path: '/terms', changefreq: 'yearly', priority: '0.3' },
    { path: '/privacy', changefreq: 'yearly', priority: '0.3' },
    { path: '/cookies', changefreq: 'yearly', priority: '0.2' },
    { path: '/acceptable-use', changefreq: 'yearly', priority: '0.2' },
  ];
  return e;
}

// The paths robots.txt keeps crawlers out of (apps, consoles, APIs). robots.txt is a courtesy, not security — all of these are also protected by
// sign-in and answer with X-Robots-Tag: noindex (see _headers).
export const PRIVATE_PATHS = ['/api/', '/owner/', '/crm/', '/hotel/', '/hospital/', '/pharmacy/', '/production/', '/services/', '/water/', '/order/', '/dashboard.html'];

// Is this request for the bare apex domain (or www) — the marketing site — as opposed to a client's own subdomain or any other host?
export function isApexRequest(request, env) {
  const hostname = hostnameFromRequest(request, env);
  const rootDomain = getRootDomain(env);
  const label = subdomainLabel(hostname, rootDomain);
  // subdomainLabel() returns '' for both the bare apex/www AND for any hostname that isn't under this root domain at all (e.g. a *.pages.dev
  // preview URL) — the explicit hostname === rootDomain / www check is what narrows this down to specifically the apex case.
  return !label && (hostname === rootDomain || hostname === `www.${rootDomain}`);
}

