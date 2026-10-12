# HMIS additions (zip 259) — hospital app

Everything lives in `hospital/index.html`; the new code is the hospital-only shared block `src/shared/blocks/hmis-clinical.html`
(synced by `node tools/sync-shared.mjs`) plus small in-place edits. Existing modules, data and screens are untouched; every new
function is guarded and old records keep working.

## What was audited (root causes)
| Problem | Cause in the code | Fix |
|---|---|---|
| Two prescription documents (in-stock vs "external slip") | `printPrescription` read only the draft rows with a stock code and `printExternalPrescriptionForRef` was a separate pop-up for not-stocked / declined drugs | Both now build ONE document (`renderRx`): Medication · Prescribed · Dosage · **Availability (Available / NA)** · Dispensed · Outstanding. Availability comes from stock / declined charge; dispensed comes from the charge's dispensing state — kept separate |
| Lab tests were free text | `addLabTestRequest(patientId, testName)` only | Preloaded, configurable catalogue + "Request Lab" picker + structured result forms |
| Inpatient bill = bed + nursing only | `confirmDischarge` posted `days × rate − deposit`; labs, medicines, meals were never tied to the admission | One admission account (`hmisAccount`) combining bed, lab, pharmacy, meals, services, deposits/payments → balance |
| No transfer | bed fixed on the admission | `bedHistory` segments, free-bed check at the moment of transfer |

## Prescriptions
* `NA` = not available at this facility (not stocked / out of stock / quantity short / declined at the counter) — printed in red, with the reason.
* Outstanding is `prescribed − dispensed` for available items; NA rows show "—" (the patient buys them elsewhere).
* From the visit screen the document is built from the live draft; from a saved visit (`printExternalPrescriptionForRef`) from the visit + its charges (awaiting payment / awaiting dispensing / dispensed). No stock is moved and no charge is created by printing.
* Receipts, discharge summaries and every other template are unchanged.

## Lab catalogue
* ~25 starter tests (Urinalysis, Haematology, Malaria, Chemistry, Stool, Microbiology, Serology, Other) live **in code**; only your changes are stored (`hmisConfig`, synced per record) — so nothing is preloaded into patient data and sync stays tiny.
* ⚙️ Lab Catalogue (Laboratory tab): enable/disable, edit name, category, code, specimen, collection instructions, result fields (type number/text/select, units, reference range, options), price, turnaround, "needs verification", available (reagents), active; add your own tests.
* 📚 Request Lab (Laboratory tab and the visit screen): search, category chips, multi-select, indication, priority (Routine/Urgent/STAT). Appears in the lab queue as Pending; paid status badge unchanged; a repeat request for the same patient within an hour is refused. Price: catalogue price → else a matching Service item (old behaviour).
* Structured result form: urinalysis (macroscopy, dipstick chemistry, microscopy deposits) and every catalogue test. Blank by default. Draft (not released) → Finalise (auto High/Low/Abnormal flags, summary text written to the normal result fields so every old screen still shows it) → Verify (a different person when more than one staff member exists) → Print report (patient, specimen, indication, times, units, ranges, flags, entered/verified by, status). Amending a released result requires a reason and keeps the original (`amendments`).
* **The uploaded PDF "lab sample results_261012_010615.pdf" was not present in the upload folder**, so the urinalysis layout follows the structure described in the brief (macroscopy, microscopy, pH/SG, ketones, leucocytes, blood, nitrites, protein, glucose, bilirubin, urobilinogen, deposits RBCs/pus cells). Send the PDF and the field list/order/ranges can be matched exactly in ⚙️ Lab Catalogue → Urinalysis (no code change).

## Inpatient
Admissions table → **💼 Account** opens the inpatient panel (tabs):
* **Account** — bed & nursing, laboratory, pharmacy, meals, services; deposits/payments; "paid at cashier"; balance (or credit). Lines are the patient's own `patientCharges` created during the stay (or tagged `admissionId`) — never copied, so nothing is counted twice; charges before admission are excluded. Unpaid items stay unpaid until the cashier collects them (Patient Bill) — discharge never marks anything paid. Take payment (posts a normal cash sale, like the admission deposit), refund (needs a reason, cannot exceed the credit, recorded as an expense so the till reconciles), reverse a payment (reason, original kept, reversal row). Print statement.
* **Meals** — configurable menu (diet type, meal slot, price), patient diet, billing policy *charge per meal* or *included in bed rate* (recorded at no charge). The same meal for the same day is added once (`postKey`); cancelling an unpaid meal voids it (kept in history).
* **MAR** — administered / withheld / refused / missed; reason mandatory unless administered; time, user. Recording a dose does not touch stock or billing.
* **Charges** — configurable charge types (per day = once per date, or per use) and the Setup panel: meals policy, bed/nursing rate per ward type (pre-fills admissions and transfers), meal and charge prices.
* **Bed & leave** — transfer to a free bed (checked again at the click; old bed → Cleaning; history kept), leave of absence (bed held and billed). Days are billed once overall: a day is charged at the bed occupied when that day started (`admBedTotal`), so a transfer cannot double-bill.
* Discharge: warns if items are unpaid, then the existing discharge flow (bed → Cleaning); the printed summary now includes the consolidated account and a snapshot is stored (`finalAccount`). Readmitting a discharged patient creates a new admission linked with `readmitOf`; history is never overwritten.

## History at a glance
Opening a patient's visit shows allergies, current admission, last visit/diagnosis/prescription and the three latest results, with a Full timeline button.

## Data, sync, migration
* New collection `hmisConfig` (localStorage `pos_hmis_config`): registered for sync, merged per record by id on the server (`functions/api/_merge.js`), included in the app backup/restore state. No migration: it starts empty. Rollback = remove the zip; the old app ignores unknown records. New fields on existing records (`labResults.testId/fields/stage/…`, `admissions.bedHistory/ledger/mar/leaves/…`, `patientCharges.admissionId/postKey/mealDate`) are additive.
* **Back up before deploying** (Settings → Backup, and the owner "Permanent Shops Backup" for the whole platform).

## Roles / audit
Every new action writes to the audit log (lab catalogue changes, requests, results, verification, amendments, meals, charges, payments, refunds, reversals, transfers, leave, MAR, discharge). Access follows the existing tab locks and staff roles (Laboratory, Wards, Cashier). Fine-grained per-action permissions beyond those are **not** added in this zip.

## Not done in this zip (honest list)
* Role-based navigation rewrite / fewer-click redesign of the whole app (the new features add one-tap entry points: 📚 Request Lab, 💼 Account, history card) — a full navigation redesign needs your decisions on roles per screen.
* Per-department stock integration for lab reagents; the lab "available" switch is manual.
* HMIS reports beyond the existing ones (the account statement and lab report are printable; occupancy/revenue-by-department reports were not added).
* The two PDFs in the brief were not available (see above).

## Tests
`tests/zip259-hmis.test.mjs` (9 scenarios, synthetic patients only): preloaded-nothing / catalogue coverage, consolidated prescription with NA, prescribed/dispensed/outstanding, Request Lab (multi-select, disable, duplicate guard, pricing), structured urinalysis draft→final→verify→print→amend, transfer with no double occupancy and single billing of days, one account with meals / charges / payments / refunds / reversal, MAR rules, discharge with unpaid warning + bed release + readmission link, history summary and sync state. `tests/hmis-integrity.test.mjs` updated for the consolidated prescription.
