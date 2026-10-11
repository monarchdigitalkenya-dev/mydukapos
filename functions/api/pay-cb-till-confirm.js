// functions/api/pay-cb-till-confirm.js — Cloudflare Pages Function (zip 250)
//
// The Till / Paybill CONFIRMATION address given to Safaricom by "Register Till URLs". Same handler as mpesa-c2b-confirmation.js, under a name
// without "mpesa" in it (Safaricom's production RegisterURL refuses addresses containing mpesa / m-pesa / safaricom). The old route stays in
// place for shops that registered it before.
export { onRequestPost, onRequest } from './mpesa-c2b-confirmation.js';
