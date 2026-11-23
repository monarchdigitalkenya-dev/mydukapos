# Zip 307 - Public website: trust, clarity and conversion (implementation report)

## 1. Main problems found (checked against the code, not the copy)

| Claim on the site | What the code actually does | Fixed to |
|---|---|---|
| "KRA-compliant, whatever you sell. Every sale can submit to eTIMS in real time, with the signature on the receipt" (home showcase, every product page) | An OSCU connector exists (`functions/api/etims-submit.js`), but it only works after the business itself is approved by KRA for OSCU and has registered. It has not been verified live against KRA from this codebase. The Tax & Returns tab produces summaries for review, not KRA returns. | "MyDuka helps you review and organise sales and tax records for manual reporting. Not official KRA returns or eTIMS invoices. eTIMS submission needs your business's own KRA approval and setup - ask us." |
| "M-Pesa built in - STK push straight from checkout from day one" (home x3, every product page) | Manual M-Pesa recording always works. STK Push needs the shop's own Daraja/gateway credentials in Settings; the sale is marked paid only on the provider's callback/status. Shared demos simulate it. | "Record M-Pesa payments; automatic prompts (STK Push) work once your own M-Pesa or gateway account is set up; a sale is marked paid only when the provider confirms." |
| Five testimonials with names, towns and five stars | They were built-in sample text in `website-content.js` (defaults), not linked to any real customer. | Removed. The site shows only testimonials the owner ticks "a real customer said this and agreed to it being published" (new checkbox in Owner Console > Website), with no star ratings. With none, the section is hidden. |
| "Pay once. Yours for good. No monthly fee, no renewal, no surprise lock-out", "1x Payment. Ever.", "∞ branches, staff accounts", "Unlimited receipts, staff accounts", "You own it outright, no surprise renewal, ever", "Keep it forever" | Billing (`_billing.js`) has a subscription that starts at a launch date the owner sets, with included branches/staff, add-on prices and a grace period after which a link is suspended. The home page also read a second, older price source (Website editor: 60 days then KES 400) that can contradict Billing. | One pricing section that reads `/api/billing-terms` (the same figures the checkout charges): price (per edition if they differ), subscription and grace if live, included branches/staff and add-ons, what is not included, how to get it. |
| "Never loses a sale", "100% Works fully offline" | Sales are saved on the device first and sent when online; anything still waiting is lost if the browser's data is cleared. | An "Offline, explained honestly" section: works offline / needs internet / when back online / good to know. |
| Hardware "set up and tested before delivery" | No evidence of this in the system. | "Hardware that works with MyDuka POS ... ask us what is set up for you before delivery." |
| Offer strip countdown | Already server-driven (real `endsAt`, hides at the end). | Now also shows the end date and "(Nairobi time)", and never shows an expired offer. |
| Hero: drawn illustration | - | The real app (film poster from the recorded app) is the hero image, with Play. |

Also found: the home page repeated offline / M-Pesa / price messages in 8 sections (19 sections, 24,700 px tall on a phone); two "Restart" buttons at the end of the interactive sale; the heading font variable `--head` was undefined, so many headings fell back to the body font.

## 2. Files and sections changed

- `public-site/index.html` - rebuilt in this order: header (Software, Live demos, Pricing, Hardware, Websites, Help, Sign in + "Try a Live Demo"), hero (new headline/copy, real-app poster + film), offer strip, **Try before you buy** (demos with sample-data notes, the demo's own password, Copy password, Open demo), **Business editions**, **How a sale works** (interactive, labelled), **What you get** (9 verified benefits incl. Payments and Tax records with "setup needed" tags), **Offline, explained honestly**, **Pricing** (one section), **See MyDuka in action** (verifiable proof + genuine testimonials only), Hardware, Website development (unchanged, concepts labelled), final CTA, full footer (product, help & services, legal). Removed: control board with fake figures, "brag" numbers, stock-photo showcases, duplicate feature grids, star testimonials, systems/offers duplicates (still on /shop). Title, description and OG text updated.
- `public-site/home-pro.css` (zip 307 block), `public-site/home-pro.js` (Next step disabled at the last step; film end CTA), `public-site/img/demo-film-poster-640.webp`, `-960.webp` (new, 22 KB / 39 KB).
- `public-site/app.html` - product pages: M-Pesa, eTIMS, till-payment and offline wording; price from Billing per edition; "Keep it forever" removed.
- `public-site/shop.html`, `public-site/shop-ui.js` (nav dropdown says "Hardware", not "Products").
- `tools/build-public-pages.mjs` -> `faq.html`: new answers on eTIMS, M-Pesa and what the price includes; data-safety answer matches the licence.
- `tools/build-home-cards.mjs` -> "Explore this solution" on every edition card.
- `functions/_site.js` (Shop description), `functions/api/website-content.js` (no built-in testimonials, `verified` kept), `owner/index.html` (genuine-testimonial checkbox), `functions/api/hit.js` + `functions/api/get-my-link.js` (journey counts).

## 3. Trust and conversion improvements

- Every tax, payment, offline and pricing statement now matches the code, and the conditions sit beside the price.
- Demos are the second section, say plainly that data is sample, changes stay on the device and no money moves, show the password and copy it.
- One path everywhere: Try a Live Demo -> Get my own link inside the demo -> licence. WhatsApp is in the proof section and footer, not on every button.
- Journey counts (first-party, cookieless, a number per day, Do-Not-Track respected): demo_cta, demo_open, pw_copy, pricing_view, whatsapp, film_play from the page; **link_start** and **link_created** counted by the server when a purchase is started / a link is really created (a click is never counted as a purchase). They appear in the same page-view report (keys starting with `#`).

## 4. Tests actually run

- New `tests/zip307-honest-site.test.mjs` (10 tests, all pass): banned unsupported claims on 9 public pages; required honest statements; one pricing section fed by Billing; no built-in testimonials and verified-only rendering; honest countdown; demo cards; journey counts (browser cannot invent a "purchase" event); licence wording; every internal link resolves; and in Chromium on a 390 px phone and a 1366 px desktop: subscription, limits, add-ons and per-edition price render from Billing, only the ticked testimonial shows, no sideways scroll, Copy password copies 0000, the first Tab reaches "Skip to content".
- Updated and passing: zip203 premium site, zip204 storefront home, zip303, zip305 film, zip177 (FAQ generator).
- Public-site suite: 98 tests, 94 pass. The 4 failures fail the same way on zip 306 (before this work): sign-up form test, a phone storefront tap-target test, the favicon test (`acceptable-use.html` has two favicon links) and nothing else.
- Performance, measured in Chromium against the same mocked API, phone = 4x CPU slowdown + 1.6 Mbit/s, 150 ms latency:

| | Before | After |
|---|---|---|
| Phone page height | 24,753 px, 19 sections | 16,598 px, 12 sections |
| Phone LCP / CLS | 1.26 s / 0.071 | 1.37 s / 0.027 (LCP is now the real app image, served as 39 KB WebP) |
| Desktop LCP / CLS | 0.60 s / 0.008 | 0.59 s / 0.006 |
| Desktop bytes | 614 KB | 372 KB |

  INP was not measured (needs real users); nothing heavy runs on interaction. Fonts could not load in the test sandbox (Google Fonts blocked), so real-world LCP may differ slightly.

## 5. Not done / still open

- The live site may hold Owner Console text saved earlier (in KV). Old saved testimonials stay hidden until ticked as genuine. The Website editor's feature-grid, "why switch" and showcase fields no longer appear on the home page (those sections were removed).
- Not changed: payments, POS logic, demo data, Owner Console money. Portfolio wording on eTIMS is already qualified ("where supported and authorized").
- Existing failing tests listed above were not part of this brief.

## 6. Please confirm before these are advertised

1. **KRA eTIMS:** has any shop submitted to KRA's live (production) eTIMS through MyDuka? If yes, the wording can say "available for approved businesses".
2. **Pricing:** which is current - Billing (Owner Console > Billing) or the older Website editor plan (KES 3,000 incl. 60 days, then KES 400)? The site now shows Billing only.
3. **After the grace period:** the site says a link is "paused until the renewal is paid (your records are not deleted)". Confirm that matches your policy.
4. **Installation and training:** do you offer them, and at what price? The site now says "ask us".
5. **Hardware:** do you set up and test hardware before delivery? If yes, that line can come back.
6. **Testimonials:** if you have real customer quotes with permission, add them in Owner Console > Website and tick the box.
