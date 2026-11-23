# Supplier management (zip 321)

## 1. What existed (traced before building)

| Area | Source of truth before zip 321 |
|---|---|
| Suppliers | `suppliers` list (`{ id, name, phone }`), synced and merged per record (`registerSyncedField('suppliers')`). Edited in the Restock tab. "Remove" deleted the record. |
| Restock | `completeRestock()` (each app) adds the stock, logs `stockMovementLog` and pushes ONE `Restock` expense for the total. It is wrapped by measure-purchase (exact cost, `p.purchases` purchase records with a batch id) and inventory-pro (serial check). |
| Supplier debt | zip 319: `tradeCredits` record `kind: supplier_restock`. A payment was a Restock expense with `supplierDebtId`, plus a copy on the debt. |
| Customer debts | `debts` (Debts tab) and Pay-Later `bills`, which are receivables. |
| Books | Accounts block: Restock expense = Stock / Cash; trade credit "I owe" = Purchases on credit / Accounts payable. |
| Profit | Profits tab and Reports: (sales - cost of goods sold) - ALL expenses, **including Restock purchases**. This is a double count, fixed (see 4). |
| Offline / sync | Everything lives in the till's local storage. Records are pushed and pulled and merged per record id on the server (`MERGE_BY_ID_FIELDS`: suppliers, tradeCredits, expenses, stockMovementLog). Each shop is its own database (per client id). |
| Demo shops | Read-only on the server (zip 262); the device copy is reset hourly (zip 320). |

## 2. Data: no new store, no migration

| Record | Where | Fields added |
|---|---|---|
| Supplier profile | `suppliers` | contact, email, address, taxId, terms, notes, active, createdAt / updatedAt. Old records read as active with no terms. |
| Restock invoice | `tradeCredits` `supplier_restock`, id `rc-<restock expense id>` | supplierId, amount (full total), reference (invoice no.), purchaseId (the measure-purchase batch), restockExpenseId, lines, dueDate, payments[] |
| Opening balance | `tradeCredits` `supplier_opening` | amount, effective date |
| Return / credit note | `tradeCredits` `supplier_return` | appliesTo (the restock), lines, reason, creditNote |
| Correction | `tradeCredits` `supplier_adjust` | sign (+1 owed more / -1 owed less), reason |
| Payment | `expenses` (category Restock), id `sp-<form key>`, or the restock's own expense when paid at the restock | supplierPay, supplierId, allocations [{ id, amount }], paymentMethod, reference, notes. A copy goes on each document it pays (`payments[]`). |

**Balances are derived, never stored:**
- A supplier's balance = opening balances + restocks + corrections up − payments − returns − corrections down.
- An invoice's outstanding amount = its amount − what was allocated to it − returns against it.

Each payment is counted once by its id, whether it is found on the expense or on the documents. A zip 319 restock (id `rc-<expense id>`, payments with `supplierDebtId`) reads the same way.

## 3. Supplier debts in the Debts system

The Debts tab's customer list is unchanged. Below it, "Owed to suppliers" lists each supplier and balance, with Pay, as a separate total. Trade Credits keeps the non-supplier entries; its Settle button on a supplier document opens the payment window, so a debt is never closed without a payment.

## 4. Money counted once

| Event | Stock | Payable | Cash / M-Pesa / Bank | Expense record | Books |
|---|---|---|---|---|---|
| Restock 20,000 on credit | +qty | +20,000 | 0 | none | Stock 20,000 / AP 20,000 |
| Restock 20,000, 5,000 paid (M-Pesa) | +qty | +15,000 net | M-Pesa -5,000 | one, 5,000 | Stock / AP 20,000; AP / M-Pesa 5,000 |
| Later payment 10,000 | 0 | -10,000 | -10,000 | one, 10,000 | AP / cash account 10,000 |
| Restock 8,000 paid in full | +qty | 0 net | -8,000 | one, 8,000 | Stock / AP 8,000; AP / cash 8,000 (= Stock / cash) |
| Return 2,000 | -qty | -2,000 | 0 | none | AP / Stock 2,000 |
| Opening balance 1,500 | 0 | +1,500 | 0 | none | Opening equity / AP 1,500 |

**Profit:**
- Stock bought reaches profit only through cost of goods sold, when it is sold.
- The Profits tab and Reports > Expenses & Profit no longer take Restock purchases and supplier payments off a second time. They are shown as "Stock bought", and the Expenses total reads "(excl. stock bought)".
- This changes the net profit figure every shop sees: it was understated by the stock bought in the period.

**Duplicates:** these ids are fixed per action:
- a restock: `rc-<its expense id>`, plus the restock tab's 1.2-second guard;
- a payment: `sp-<key made when the form opened>`;
- a return or opening balance: `sr-` or `so-<key>`.

A double tap, a retry or a second sync finds the record and adds nothing. On the server, records are merged by id.

## 5. Offline

Everything works offline on the till's own records: profiles, restocks, payments, returns, statements and reports. Records keep their own ids and times and sync with the existing sync. Reports show a note when this device has records not yet sent.

## 6. Reports (print / PDF and CSV)

- Supplier statement (any period; opening balance, running balance, closing).
- Restocks (supplier, period, payment status).
- Outstanding supplier debt with ageing (not yet due, 1-30, 31-60, over 60 days, from the due dates the supplier's terms give; "No due date" when there are no terms).
- Supplier payments.

Printed with the business name, title, period and generation time, through the app's print-panel mechanism. Totals on screen, in print and in CSV come from the same calculation.

## 7. Tests run (`tests/zip321-suppliers.test.mjs`, 15 tests)

| Scenario | Result |
|---|---|
| 1-4 credit 20,000; part paid 5,000 (M-Pesa); later 10,000; final 5,000. Stock, payable, each cash account, expense count and books checked at every step | pass |
| 5 several invoices: chosen allocation, invalid allocations refused, oldest-first default | pass |
| 6 return 2,000: stock, balance, ledger, retry once only, over-return and over-stock refused, credit on a paid invoice | pass |
| 7 double tap on Confirm, repeated restock calls, a payment retried three times | pass |
| 8 recorded offline, pushed twice, server holds one invoice / two payments / one stock movement; a second till pulls the same balance | pass |
| 9 / 14 statement (whole and a period), restock, outstanding, payment reports and CSV agree with the balances; books debits = credits; payables = sum of balances | pass |
| 10 restock with no supplier unchanged; credit without a supplier refused; profit counts rent, not stock again; customer and supplier debts apart | pass |
| 11 two shops' databases: one never sees the other's suppliers, invoices or payments | pass |
| 13 upgrade from zip 319 records and old suppliers: balances kept, old expenses untouched, deactivate instead of delete, picker hides inactive | pass |
| profiles: required name, duplicate warnings (name, phone in any format), opening balance is not stock, purchase or expense | pass |
| each of the 5 apps: tab, permission, part-paid restock once, tab and supplier page show the balance | pass |
| 12 demo shops | the zip 320 demo tests (normal shops untouched, hourly reset) are in the regression run below |

## 8. Limits

- No advances or prepayments to suppliers: a payment can never exceed what is owed. Returns on paid stock become a credit with the supplier, which nets off the supplier's balance (not a specific invoice).
- No discounts or taxes on a restock. The existing restock has none, and the unit cost is what you type.
- The restock date is the time it is recorded (as before). A payment can be dated earlier.
- A payment is corrected with a correction entry, not by deleting it.
- Hospital and Water have no Restock-with-suppliers screen, so they don't get the tab (the profit fix applies there too).
