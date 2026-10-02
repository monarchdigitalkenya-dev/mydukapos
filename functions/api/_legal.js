// functions/api/_legal.js — shared constants, NOT a route.
//
// The version of the legal documents a visitor accepts at sign-up. Bump it (and the date inside public-site/ via `npm run build:public`) whenever
// the Terms or Privacy Policy change in a way that needs fresh consent; the account keeps the version it accepted and when.
// tests/zip177-public-site.test.mjs checks these match the published pages.
export const TERMS_VERSION = '2026-10-01';
export const PRIVACY_VERSION = '2026-10-01';

// What is stored on an account that accepted the terms: the versions, the server's clock, and the channel — never the text typed anywhere else.
export function termsRecord(request, channel) {
  let country = '';
  try { country = String((request && request.cf && request.cf.country) || '').slice(0, 2); } catch (e) { /* not on Cloudflare */ }
  return { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, acceptedAt: Date.now(), channel: String(channel || 'app').slice(0, 20), country };
}
