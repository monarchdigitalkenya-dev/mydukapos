# KCB Buni guide (beginner)

## What was wrong
The system asked KCB to send the M-Pesa prompt, but it left out headers KCB's gateway uses to route the request, and when KCB said no, you only saw "declined" - no reason. Zip 350 adds the headers and shows KCB's real reason.

## After you deploy, read the red message
- "KCB Buni login failed (sandbox, HTTP 401)": the Consumer Key/Secret is wrong, or the Environment setting does not match where the keys were made (sandbox keys only work on Sandbox, live keys only on Production).
- "KCB Buni did not send the prompt (... HTTP 4xx): <words>": KCB rejected the request itself. Common causes: Till number not linked to your app, wrong Pass Key, or your app is not yet approved for production.
- "Could not reach KCB Buni": network problem on KCB's side. Try again.

## Things only KCB can confirm (email buni@kcbgroup.com with the red message)
1. Your app is approved (go-live) for production and your Till is linked to it.
2. The routeCode for your account (default 207 is used; if they give another, tell me and I will set it).
3. Whether KCB allows calls only from fixed IP addresses (Cloudflare cannot give a fixed IP).
4. Whether Shared Short Code should be ticked: leave it UNTICKED if the Till is your own.

## Test safely
Use Sandbox first with KES 1-10 to your own phone. Only switch to Production after that works.


## Zip 356 - what was still wrong, and what to do now
1. The login sent `grant_type` only in the address; KCB's live login server reads it from the form body, so correct keys were refused. Fixed.
2. Live pushes went to `buni.kcbgroup.com` (KCB's developer portal web page). They now go to the API gateway `api.buni.kcbgroup.com` (the old address is still tried if the gateway answers like a web page).
3. The `messageId` header was 36 characters; KCB allows 32. Fixed.
4. Shared paybill: the request now has KCB's own example shape: `orgShortCode` and `orgPassKey` empty and `invoiceNumber` = `<your KCB account or Till>-<reference>`. The Pass Key decides: **no Pass Key = shared paybill 522522 paid into the number you typed; Pass Key = your own Till.**

### Check your settings (Settings > Payment Gateway > KCB)
- Environment: Production only after KCB approved your app (go-live). Keys from the sandbox portal only work on Sandbox.
- "KCB Till or KCB account number": the number the money must reach.
- Pass Key: leave EMPTY unless KCB gave your Till its own Pass Key.
- Press Save, then try KES 1-10 to your own phone. If it fails, the red message now says which step failed and KCB's own words.

### Only if KCB tells you different addresses
In Cloudflare > Workers & Pages > mydukapos > Settings > Variables, add `KCB_STK_URL` (the full .../stkpush address) and/or `KCB_TOKEN_URL`, then redeploy.
