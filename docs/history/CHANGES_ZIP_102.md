# Zip 102 - Hospital: prescribe unstocked medicine + carry/not-carry at dispensing; Owner Console: Trash (30-day recycle bin) for deleted links
Hospital (hospital/index.html):
- Visit/diagnosis form: "Not stocked here" checkbox per medication row -> free-text name, no charge, no stock deduction.
- Cashier "Dispense/Bill": carry-checklist panel before a medication bill loads into the cart; unticking declines
  that charge (reason captured, audited) instead of charging/dispensing it.
- New "Print slip" button + printExternalPrescriptionForRef(): prints not-stocked + declined meds with dosage.
- tests/patient-billing.test.mjs updated (6 call sites) for the new confirmMedicationCarry() step.
- tests/hmis-integrity.test.mjs: +6 tests (78 total).

Owner Console (owner/index.html) + server (functions/api/_license.js, owner-lock.js, owner-clients.js):
- Deleting a client link now soft-deletes (Trash) instead of permanently removing it.
- New "Trash" tab: lists deleted links with days remaining, one-click Restore.
- 30-day auto-purge (permanent removal + email unlink) runs whenever the Trash tab is opened.
- tools/build-guides.mjs: owner guide's tab list/description updated for Trash; regenerated + synced.
- New tests/license-trash.test.mjs (4 tests): soft-delete, restore, list separation, purge behavior.

Full 83-file test suite: zero failures. No router changes -> deploy:router not needed.
