# Zip 162

## Hotel Sales Counter (8 requests)
1. After a sale the receipt screen says just **✓ Sale saved** (shared block, so every app).
2. "View & Print Receipt" button is now **✅ Confirm** (M-Pesa hint text updated).
3. Menu import accepts a blank, "-", "—", "N/A" price (price 0, add prices later); real garbage is still flagged.
4. Mobile: total + payment method + Confirm are one **sticky bottom bar**; compact method buttons; 16 px inputs; floating cart / scroll-up / keyboard buttons lift above the bar.
5. Settings → "Payment methods to show": choose among Cash, M-Pesa, Split, Bill, Tab (all by default; at least one must stay). Applies to the counter and to Settle Tab.
6. Table/Room and customer name are optional (auto "Guest N").
7. Settle Tab: removed "Split by person" and "Pay a share"; cash with nothing typed = exact cash, so settling is one tap.
8. See 4.

## Services engine (multi-industry)
One engine, 10 business types (phone repair, car wash, garage, salon, barber, laundry, cleaning, electronics, tailoring, other): dynamic forms/terminology/statuses/validation, catalog with price variants, quotes + approvals + extra charges, payments (via Bills), materials (stock), photos (private R2, offline queue), appointments & walk-ins, 11 new reports, customer/vehicle history, notifications as wa.me/sms/mailto links (never auto-sent), 16 staff permissions with presets, custom fields, audit. Old records untouched; business type switch keeps history.
Fixed: template cache served stale custom fields / status edits.

## Leftovers
Photo grid shows remaining qty; 0.5 qty past sales; CRM paging/lazy-load; water re-link; test clock fix (crm-leads).

## Honest limits
Services features were verified with automated tests and a real 390 px Chromium pass (job → deposit → status → reports → history → custom fields); not every industry screen was clicked by hand — please try each business type. Two tills adding legacy (classic) jobs at the same instant can still lose one record (pre-existing; engine jobs merge safely).
