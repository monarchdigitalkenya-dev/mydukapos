// functions/api/_demo-const.js — zip 262: constants shared by the shared-demo code. Not a route.
// The public demos all unlock with the password 0000 (shown on the website). That password must never protect a REAL shop:
// pos-sync.js refuses to store it for any shop that is not a shared demo and was created after DEMO_PW_ENFORCE_FROM (older shops that already
// used it keep working; nothing existing is locked out).
export const DEMO_PASSWORD = '0000';
export const DEMO_PASSWORD_HASH = '9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0';   // sha256('0000'), the same unsalted hash the apps use for their local password
export const DEMO_PW_ENFORCE_FROM = Date.UTC(2026, 9, 12);
export const SEED_VERSION = 4;                                         // bump to re-seed every shared demo on the next visit (see _shared-demos.js)
