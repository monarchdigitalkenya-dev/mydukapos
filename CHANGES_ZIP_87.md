# Zip 87 — Hospital: clinical integrity, referrals, timeline, per-record clinical sync
- hospital/index.html: visit/lab corrections keep the original (reason required); visits are voided not deleted; released lab results cannot be deleted; referrals (lifecycle + letter); patient timeline; critical-vitals flags; duplicate-patient warning; extra audit entries.
- Sync: patients, visits, labResults, admissions, appointments, queue, patientNotes now merge per record (functions/api/_merge.js, src/shared/functions.js -> all apps via npm run sync; pharmacy patients registered too). Removals send tombstones.
- Router files unchanged -> deploy:router not needed.
- tests/hmis-integrity.test.mjs (11 tests). See HMIS_GAP_ANALYSIS.md for what is still missing.
