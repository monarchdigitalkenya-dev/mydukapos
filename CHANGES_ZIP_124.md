# Zip 124 — A sale just made (and printed) always shows in Daily Sales

Builds on zips 118–123.

## The problem
The report: "I made a sale and printed the receipt, but it's not in Daily Sales" (same device).

The sale **was saved**. It is written to the device before the receipt prints, and every sync path keeps sales that exist only
on this device. But the **Daily Sales screen was hiding it**, because its date was filled in once and never moved on:
* **A till left open overnight** (common) kept showing **yesterday**, so today's sales didn't appear.
* **After "jump to a receipt" or "record a past sale"**, the list stayed on that old day. The next new sale didn't appear.
* **A leftover search word** or an **"M-Pesa only" filter** hid a new cash sale.

Separately, a **Pay-Later bill** prints a receipt but lives in the 🧾 Bills tab until it's paid (by design), which also looks
like a "missing" sale.

The tests below reproduce the first three cases on zip 123.

## The fix (all 7 apps, including Aqua)
* **The date follows today.** A date the app filled in moves to today by itself, including across midnight on a till that stays
  open. A date you pick yourself stays while you look at it (`salesDatePickerValue`).
* **Opening Daily Sales always starts on today, unfiltered.** The search box is cleared, the payment filter goes back to "All",
  and a custom range goes back to Daily (`dailySalesOpenOnToday`).
* **Pay-Later bills are pointed out.** Daily Sales now says "Also today: N Pay-Later bill(s) (not paid yet) — they are in the
  🧾 Bills tab until paid."

## Tests added (`tests/daily-sales-today.test.mjs`)
* A till open since yesterday: the sale just made is listed.
* A picked old date is kept while viewing, and reopening the tab shows today with the sale.
* A leftover search or "M-Pesa only" filter no longer hides a new cash sale.
* The Pay-Later bills note.
* Aqua's date follows today too.

The first three fail on zip 123.
