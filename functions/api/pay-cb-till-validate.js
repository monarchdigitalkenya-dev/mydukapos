// functions/api/pay-cb-till-validate.js — Cloudflare Pages Function (zip 250)
//
// The Till / Paybill VALIDATION address given to Safaricom by "Register Till URLs". Same handler as mpesa-c2b-validation.js, under a name
// without "mpesa" in it (see pay-cb-till-confirm.js).
export { onRequestPost, onRequest } from './mpesa-c2b-validation.js';
