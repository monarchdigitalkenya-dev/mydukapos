# Zip 100 - Hospital: Reception/Diagnosis least-privilege split + no forced roles
- hospital/index.html: new Reception + Diagnosis tabs (search-first), Patient Records relabelled/moved (admin),
  tab order follows the walk-in journey, Queue/Lab/Radiology/Theatre patient pickers converted to search,
  removed the forced sales-tab migration, new-staff invites start with nothing pre-checked.
- tools/build-guides.mjs: hospital tab list + descriptions updated for the new/renamed tabs; regenerated + synced.
- tests/hmis-integrity.test.mjs: +7 tests (72 total). No server/router changes.
