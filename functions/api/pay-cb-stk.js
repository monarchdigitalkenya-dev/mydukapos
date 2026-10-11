// functions/api/pay-cb-stk.js — Cloudflare Pages Function (zip 250)
//
// The address Safaricom is given for the STK Push RESULT. It is the very same handler as mpesa-callback.js; only the NAME is different.
// Safaricom's production system filters out any callback / validation / confirmation URL that contains the words "mpesa", "m-pesa" or
// "safaricom" (any case): the prompt may still be sent, but the result is never delivered, so the till waits for ever. Sandbox does not
// enforce this, which is why it worked there. mpesa-callback.js stays in place for prompts already sent with the old address.
export { onRequestPost, onRequest } from './mpesa-callback.js';
