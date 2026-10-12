# Customer account, statement and invoice (zip 262)

**Source of truth** (nothing is stored as a balance): `bills` (+ `paymentHistory`), `salesLog` purchases, `debts` (+ `payments`), `returns` (refunds and exchange store credit). Code: `customerLedgerBuild()` in `src/shared/functions.js`.

**Sign convention**: each row has *charged*, *paid*, *credit*. Row effect = charged - paid - credit. Running balance = what the customer owes (positive = owes, negative = in credit).

**No double counting**: a bill is one charge plus its payments. Sales-log mirrors of a bill (same `billId`, instalment rows, or the same reference) are skipped; a bill that became a completed sale appears once. Voided bills / sales show as Voided with no effect.

**Linking**: by normalised phone only. Records with only a name are not assigned silently; they are listed under the statement's notes.

**Statement** = full history for the chosen period (opening balance, rows, totals that reconcile to the closing balance). **Invoice** = only open bills and recorded debts (original, applied, outstanding). 58 mm / 80 mm paper uses the same text lines as the receipt printer (32 / 48 columns); A4 uses a table with repeating headings.
