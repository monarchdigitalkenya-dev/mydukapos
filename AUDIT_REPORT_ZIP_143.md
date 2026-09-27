# MyDukaPOS — System audit report (Zip 143, built on Zip 142)

**Method:** every fix below was first reproduced on the untouched Zip 142 (a new automated test that FAILS on Zip 142), then fixed,
then the same test passes, then the whole suite (≈1,300 tests: real apps in a simulated browser + real server code) was re-run.
Nothing was redesigned; existing behaviour was kept wherever it was correct.

---

## A. Systems audited
| Area | What was inspected |
|---|---|
| Apps | Shop (root), Aqua POS (water), Hotel/Hospitality, Hospital/HMIS, Production, Services, Pharmacy, Owner Console, public site, QR order page |
| Shared code | `src/shared/functions.js` (≈400 shared functions), shared blocks: connectivity (PosNet), device-security, staff-session, sales-journal, one-tab, storage |
| Server | all 70 `functions/api` endpoints (auth gate of each), `_merge.js`, `pos-sync.js`, `_state-store.js`, `wildcard-router` Durable Objects (ShopStore, SyncRoom) |
| Roles | tab roles, Secondary Admin (Settings sections), staff PIN / link sign-in, owner-console staff |
| Connectivity | PosNet manager, `/api/health`, licence polling, owner-console fetch guard, every error message |
| Sync / persistence | owner-console own-shop sync, POS push/pull (existing no-revert tests), stock ledger, sales journal |
| Payments | STK push + callback, C2B confirmation/validation/registration, KCB IPN, `mpesa-verify`, Paystack/Paywave webhooks |
| Barcodes | keyboard-wedge scanner (all apps), camera scanner entry points, Add-Item online lookup, `barcode-lookup` server |
| Tax | `vatRateForCategory` (single shared VAT source, no hard-coded 16% anywhere), barcode lookup vs VAT |
| Printing | `thermalAscii` / wrapping (58/80 mm, Unicode → printable), existing receipt test matrix |
| Security | escaping (XSS), CORS middleware, callback authenticity, login brute force, IDOR on media/radiology/history, SSRF (image-proxy), QR public input |
| Service worker | network-first pages, API never cached |

## B. Bugs found and fixed
| # | Sev | Module / location | Problem | Root cause | Fix | Verified by |
|---|---|---|---|---|---|---|
| 1 | CRITICAL | Owner Console, `escapeQuotes` | Stored XSS: a tenant's business/client name or a public website/WhatsApp lead ran script in the owner's browser (owner session → every shop) | helper only escaped `'`; used inside `onclick="…"` and `value="…"` | JS+HTML escaping inside handlers; `escapeHtml` for `value=`/`id=`; removed double-escapes | `owner-xss` (fails on 142) |
| 2 | HIGH | Shared POS `escapeQuotes` | `&#39;` in a name broke out of `onclick` (browser decodes it to `'`); `<` unescaped in `<option>` text | `&`,`<`,`>` not encoded | encode them; 6 id look-ups decode the same way | `owner-xss` |
| 3 | HIGH | Payments (`mpesa-callback`, `mpesa-c2b-confirmation`, `kcb-ipn`, `mpesa-verify`) | Anyone knowing a shop id could post a fake "payment received" and get a made-up M-Pesa code **verified** (cashier fraud) or mark an STK prompt paid | callbacks trusted `?c=` alone | per-shop secret key in callback URLs (`_callback-key.js`); unsigned posts not trusted once a key exists; backward compatible | `signed-callbacks` |
| 4 | HIGH | Owner Console + all apps, `checkLicenseStatus` | App **locked** ("not recognized" / "offline — connect to the internet") on a server hiccup with internet working | any HTTP answer (5xx `{error}`) taken as the licence; non-JSON errors treated as offline; bad answer saved as checkpoint | only a real answer (`valid` boolean, 2xx) is believed; hiccup keeps last answer; server returns 503 on storage errors | `license-hiccup` (fails on 142) |
| 5 | HIGH | Owner Console, all network messages | "Check your connection" for every failure | catch-all messages | `ownerFailReason()`: offline / server error N / session ended / 429 / timeout, from the fetch guard + PosNet | `owner-connectivity` (fails on 142) |
| 6 | HIGH | Owner Console, own-shop sync | Edits **reverted** (e.g. item renamed, back to old name on next poll) | pull applied wholesale over edits not yet on the server (debounce window, push in flight, failed push) | change counter; pull only when nothing is unsent, else push first | `owner-connectivity` #4 (reproduced "New name → Old name" on 142) |
| 7 | HIGH | All apps, roles | Staff without the Sales Counter still landed on it; scans opened it; label said "always included" | `isTabLocked('sales-tab')` always false; start-up/fallbacks forced the till | Sales Counter is a real role; first-allowed-tab fallback; "no tabs" notice; shortcuts guarded | `role-tabs` (fails on 142) |
| 8 | MEDIUM | All apps, Secondary Admin | Settings button always hidden for staff given Settings sections | visibility code hid it unconditionally | shown when the member has admin sections (sections still gated) | `role-tabs` |
| 9 | MEDIUM | Owner Console staff | 🔗 Generate Link always visible to console staff | hard-coded always-visible | role like others; existing staff migrated once | `role-tabs` |
| 10 | HIGH | Owner / website / recovery sign-in | Unlimited password guessing on the one account that controls every shop | no limit | failed-attempt throttle per IP and per account | `login-throttle` |
| 11 | MEDIUM | Aqua POS | **No hardware scanner support** although Settings said so | handler never added | keyboard-wedge handler + Enter fallback | `scanner` |
| 12 | MEDIUM | All apps, scanner | Scanning with the cursor in cash/qty/price left the barcode digits in that field (e.g. cash = 5901234123457) | wedge types into the focused field | scanned text removed from non-code fields; search cleared | `scanner` |
| 13 | MEDIUM | All apps, scanner | Slow (Bluetooth/Android) scanner or typed code + Enter did nothing | no Enter handler on the search box | exact code + Enter adds the item | `scanner` |
| 14 | MEDIUM | Add New Items | Scan A then B: A's slower lookup wrote A's name over B; typed names overwritten | no staleness check | answer ignored if the code changed; typed name kept | `scanner` |
| 15 | MEDIUM | `barcode-lookup` | slow source held the scan; free quota (100/day, shared by all shops) spent repeatedly; no validation | no timeout/cache | 4 s timeouts, shared KV cache (misses 1 day), code validation; quota errors not cached as "unknown" | code review + `scanner` |
| 16 | MEDIUM | POS apps, ~190 messages | same "check your connection" for every failure | catch-all | `netErrText()` fed by the device-security fetch wrapper | `pos-error-messages` |
| 17 | LOW | `image-proxy` | open proxy for the internet; redirects not re-checked | no licence gate | licence required; redirects followed by hand and checked | code review |

## C. Reliability improvements
* **Offline/online:** licence polling can no longer lock or say "offline" on a server error; every error names its real cause; the
  existing PosNet manager (health probe + independent internet probe) is now also the source for Owner Console / POS messages.
* **Sync:** Owner Console own-shop sync never applies a pull over an unsent change (POS apps already had this; their tests still pass).
* **APIs:** `license-status` 503 instead of a crash; `barcode-lookup` timeouts + cache.
* **Cloudflare:** no new products. Existing KV is used for the barcode cache, callback keys and login throttle.
* **Caching:** service worker reviewed (network-first pages, API never cached) — correct, unchanged.

## D. Security findings
Fixed: #1, #2, #3, #10, #17 above.
Checked and sound: tenant isolation (every endpoint resolves the shop server-side; media/radiology/history keys are scoped by the
resolved shop id and ids are validated), CORS middleware, QR-order public input (validated, server-priced, escaped), Paystack /
Paywave webhooks (signed), WhatsApp webhook (signed).

## E. Barcodes
Audited: the keyboard-wedge detector (fast keys + Enter/Tab suffix, capture phase, min length), routing per tab (Sales, Add Items,
Restock, Contracts, scanner test), variant/piece codes, camera scanner entry, Add-Item lookup (local first → online), server lookup.
Fixed: #11–#15. The online lookup never sets VAT; the toast now asks the user to check the VAT class.

## F. Owner Console "connect to the internet"
Two real causes, both fixed:
1. The 30-second licence check treated ANY failed/odd answer as either the licence itself (→ lock screen) or as "offline"
   (→ offline estimate → "This device is offline … connect to the internet"). A single Cloudflare/KV hiccup was enough.
2. Every failed owner request (expired session, server error, rate limit, slow endpoint, non-JSON error page) printed
   "check your connection".
The connectivity manager itself (health probe + independent internet probe) was already correct and is now what decides "offline".

## G. Data integrity (no reverts)
* Reproduced the Owner Console revert on Zip 142 in a test: rename → push fails → another device saves → poll → name reverted.
  Fixed and the same test passes. The server copy also receives the edit once it is reachable.
* POS apps: the existing suites for reverts, stale devices, stock take exactly-once, double push, clock drift, five tills all pass.

## H. Test results
* Zip 142 baseline: 1,237 tests, 1,237 passed.
* New test files (10): role-tabs, owner-connectivity, owner-xss, signed-callbacks, scanner, license-hiccup, pos-error-messages,
  login-throttle (+ updated fixture in dashboard-branch-refresh to match the real licence API).
* Zip 143 full run: **1,307 tests, 1,307 passed, 0 failed** (Kenya time, per-test time limit).

## I. Files changed
`functions/api/`: _callback-key.js (new), _ratelimit.js, account-recovery.js, barcode-lookup.js, demo-account.js, gateway-config.js,
image-proxy.js, kcb-ipn.js, license-status.js, mpesa-c2b-confirmation.js, mpesa-c2b-register.js, mpesa-callback.js, mpesa-stkpush.js,
mpesa-verify.js, owner-auth.js · all 7 app `index.html` + `owner/index.html` · `src/shared/functions.js`,
`src/shared/blocks/device-security.html`, guide data (7) · `tools/build-guides.mjs` · tests.

## J. Database changes
None. No schema change, no migration, nothing deleted. New KV keys only: `callback-key:<rail>:<shop>`, `till-payment-rejected:*`
(30-day TTL), `barcode-cache:v1:*`, `rl:loginfail:*` (2-hour TTL). Staff records get `salesTabMigrated` in the Owner Console
(the POS apps already had it).

## K. Cloudflare changes
None to configuration. No router/Durable Object change (`npm run deploy:router` not needed).

## L. Remaining risks (not changed — need your decision)
1. **HIGH — the shop link is the credential.** Unless a shop turns on *Settings ▸ Devices & Security ▸ Only paired devices may sync*,
   anyone with a shop's link can download its data, including staff PIN and password hashes (unsalted SHA-256: a 4-digit PIN falls
   instantly). The fix already exists but is opt-in. **Recommendation:** make "paired devices only" the default for new shops, and move
   PIN checks server-side (the zip 141 staff-session work is the start of this). Changing auth for live shops blind was out of scope.
2. **MEDIUM — KV-mode shops with two devices** can lose a concurrent save (KV is not transactional). Mitigated already: such shops move
   to their own database automatically (ShopStore Durable Object). Keep `deploy:router` current.
3. **LOW — new items default to VAT class A (16 %).** Not a guess from outside data, but a silent default. Consider requiring an
   explicit VAT choice on new items if your customers sell many zero-rated/exempt goods.
4. **Not verifiable here:** real Bluetooth/USB printers and scanners, real M-Pesa / KCB callbacks, real Cloudflare edge behaviour.
   These are covered by simulated tests only. After deploying, do one real STK payment, one till payment (after "Register Till URLs")
   and one scan on each device type.
