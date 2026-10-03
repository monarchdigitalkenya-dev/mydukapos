# Zip 99 - Hospital: SHA / DHA eClaims credentials + claim submission
- New: functions/api/_sha-config.js, sha-config.js, sha-test.js, sha-claim-submit.js
- hospital/index.html: Settings -> Insurance / Institutions -> SHA panel; "Submit to SHA" button on claims
- tests/sha-integration.test.mjs (11 tests, server), hmis-integrity.test.mjs (+4 tests, client)
- Router files unchanged -> deploy:router not needed.
- IMPORTANT: the claim payload is best-effort against the public Kenya eClaims IG, not yet validated against a live DHA sandbox. See HMIS_GAP_ANALYSIS.md.
