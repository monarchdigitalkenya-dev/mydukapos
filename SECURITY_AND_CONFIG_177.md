# Security and configuration notes — zip 177

## What is implemented (and where)
| Area | What | Where |
|---|---|---|
| Password storage | PBKDF2-SHA256, 100,000 iterations (the Workers maximum), per-password salt. Old one-round SHA-256 records still sign in and are upgraded on the next successful sign-in. | `functions/api/_password.js`, `_account.js`, `_owner-auth.js`, `account-recovery.js` |
| Password rules (website sign-up / reset) | 8+ characters, not one repeated character, not a very common password. The POS in-app sign-up keeps its 4+ character PIN rule on purpose (tills are used with PINs). | `passwordProblem()` |
| Sessions | Signed (HMAC) tokens `d2.` / `o2.`; sign-out revokes; a password change ends older sessions. | `_account.js`, `_owner-auth.js` |
| Terms consent | Required at website and POS sign-up; stores document versions, time, channel, country. No IP stored. | `_legal.js`, `demo-account.js` |
| Verification | 6-digit code by email or WhatsApp; hashed, 10 min, 5 tries, 1 resend/minute, 6 sends/hour. | `functions/api/verify.js` |
| Rate limits | Login failures (existing), contact form (5/h/IP), OTP sends (6/h/account). | `_ratelimit.js` |
| Contact form | Honeypot, minimum fill time, per-IP limit, optional Turnstile. | `functions/api/contact.js` |
| Headers | `nosniff`, `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN`, `Permissions-Policy`, HSTS (no includeSubDomains). Private apps: `X-Robots-Tag: noindex`. `/api` answers carry `nosniff`. | `_headers`, `functions/api/_middleware.js` |
| Crawling | Host-aware `robots.txt`, `sitemap.xml`, `llms.txt`; client hosts are `Disallow: /` and noindex. | `functions/robots.txt.js` etc. |
| Analytics | First-party, cookieless daily page counts; honours Do-Not-Track; no IP, UA or visitor id stored. | `functions/api/hit.js` |
| Offers | Server-clock evaluated; owner-only edits; audit log. | `functions/api/offers.js`, Owner Console ▸ Offers |

## Environment variables (all optional)
| Name | Effect |
|---|---|
| `VERIFICATION_REQUIRED=1` | A website account must verify email or WhatsApp before generating a demo. Default off. |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Cloud API credentials. |
| `WHATSAPP_OTP_TEMPLATE`, `WHATSAPP_OTP_LANG` | Name/language of an **approved authentication template** (Meta only allows business-started messages through templates). Without it WhatsApp verification answers "not available". |
| `CONTACT_NOTIFY_EMAIL` | Also email each contact-form message here (needs the Resend key from Owner Console ▸ Settings). |
| `TURNSTILE_SECRET` | Turns on Cloudflare Turnstile checking in `/api/contact`. The page must then send `cfToken` (the widget is not added until a site key exists). |
| `CONTACT_HOURLY_LIMIT`, `OTP_HOURLY_LIMIT` | Change the limits above. |

## Honest limits — not done in this zip
* **No Content-Security-Policy yet.** The apps and public pages use inline scripts/styles; a CSP that does not break them needs a nonce build step. Do not claim CSP.
* **No CAPTCHA widget** on sign-up; the contact form relies on honeypot + limits (+ Turnstile when you add keys).
* **Legal pages are plain-language drafts**, not lawyer-reviewed, and name no company, address or registration. Add those only when you have them.
* WhatsApp verification cannot be tested end-to-end without your approved template and a live token.
* KV counters (rate limits, analytics) are approximate, not atomic.
* The POS sign-up inside a shop link still accepts 4-digit PINs.
