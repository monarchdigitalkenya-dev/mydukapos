// functions/api/_demo-const.js — zip 262: constants shared by the shared-demo code. Not a route.
// The public demos all unlock with the password 0000 (shown on the website).
// zip 326: 0000 is only the password the shared demos are seeded with; it is NOT reserved - a real shop may use it too.
export const DEMO_PASSWORD = '0000';
export const DEMO_PASSWORD_HASH = '9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0';   // sha256('0000'), the same unsalted hash the apps use for their local password
export const SEED_VERSION = 7;                                         // bump to re-seed every shared demo on the next visit (see _shared-demos.js)
