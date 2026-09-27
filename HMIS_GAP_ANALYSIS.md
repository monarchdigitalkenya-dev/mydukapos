# Hospital module vs. the Kenya HMIS master prompt — gap analysis (zip 87)

Target: `hospital/index.html` (the Hospital POS module). The master prompt describes a multi-tenant SQL/REST system;
this suite is an offline-first, KV-synced single-file PWA per shop, so the prompt was applied **within that
architecture** (same approach as the phased roadmap agreed earlier). Nothing below is claimed unless it was checked in the code.

## 1. Already implemented and working (found in the code, not changed)
- Patient registry (name, age, sex, phone, next of kin, blood type, allergies), Visits, Appointments, Queue with Emergency/Urgent/Routine triage and a stage pipeline (Reception → Triage → Consultation → Lab → Pharmacy → Cashier)
- Vitals: BP, pulse, temp, SpO2, weight, height, BMI
- ICD-10 coded diagnoses (curated subset), visit types outpatient/inpatient
- Laboratory requests/results with normal/abnormal/critical flag; wards, beds, admissions, nursing notes, MAR, discharge
- Billing: visit reference → unpaid charges → one payment at the cashier; institutions/insurance accounts and claims; M-Pesa prompts; KRA eTIMS
- Pharmacy: batch/expiry (FEFO), stock movements; audit log (auditLog); staff, attendance, per-tab staff permissions

## 2. Fixed / added in zip 87
| Spec § | Change |
|---|---|
| 39 Clinical integrity | Editing a visit now needs a **reason** and keeps the original (`visit.amendments`, before/after/who/when/why). **Removing a visit is now a VOID** (kept, greyed, excluded from every hospital report). A **released lab result can no longer be deleted**; correcting it keeps the original value. |
| 36 Audit | Patient edits/removals, visit amendments/voids, lab result entry/correction/removal, referrals and critical vitals are now written to the audit log. |
| 40 Patient timeline | New **📈 Timeline** on every patient: registration, appointments, queue stages, vitals, consultations, prescriptions, labs, admissions/ward notes/discharge, billing/payment, notes, referrals, amendments — newest first, critical events highlighted. |
| 19 Referrals | Internal/external referral from any visit: destination, urgency, reason, clinical summary, transport, lifecycle **pending → sent → received → completed / declined / cancelled** with history, printable referral letter. Stored on the visit, so it syncs with no new collection. |
| 10 Triage | **Critical-vitals flag** (fever ≥39 / ≤35 °C, SpO2 <90 %, BP ≥180/120 or <90 systolic, pulse ≥130 / ≤40; children only temp + SpO2). Shown on the queue, visit history and timeline, toast + audit entry on save. |
| 7 Patient search | **Duplicate detection** on registration (same phone last-9-digits, or same name + age). Advisory — the clerk can still register. |

Tests: `tests/hmis-integrity.test.mjs` (9 tests).

## 3. Gaps that remain (honest list)
**Data-safety bug (highest priority, next zip):** `patients`, `visits`, `labResults`, `admissions`, `appointments`, `queue`, `patientNotes` and `auditLog` are **not** in the server's per-record merge list (`MERGE_BY_ID_FIELDS`) — each is replaced as a whole array on push. Two clinicians on two devices (e.g. reception registering while triage saves vitals) can overwrite each other's changes if one device pushes before it has pulled. Fix = register them in `MERGE_BY_ID_FIELDS` + `registerSyncedField`, with tombstones for removals, and a two-device test.

**Security (architectural):** roles are per-tab, enforced in the browser; PINs are checked on the device (you decided server-verified logins are not wanted because tills work offline). So there is no server-side RBAC and no cashier "hard lock" at API level. Mitigation available inside the design: signed role claims + server-side write filters per collection.

**Missing modules:** Radiology workflow (only a request name), Maternity/ANC + partograph, Newborn, Theatre/procedure notes, SOAP-structured consultation (diagnosis + free-text notes only), diagnosis types (provisional/final/secondary), lab test catalogue/panels/specimen tracking and result **verification** step, cashier shift open/close with expected-vs-actual cash for the hospital, refund/void **approval** workflow beyond manager PIN, claims lifecycle states (submitted/approved/rejected/resubmitted), patient merge, extra registration fields (county, alt phone, email, ID/SHA no.), triage respiratory rate/pain/glucose, appointment SMS reminders, patient portal, per-branch clinical reports.

**Not applicable here:** multi-tenant SQL, `/api/v1/...` REST resources, DB migrations — the suite uses per-shop KV/D1 + `/api/*` functions.

## 4. Suggested order
1. Per-record sync for clinical collections (safety) 2. SOAP consultation + diagnosis types + patient merge 3. Lab catalogue/verification/critical-result alert 4. Maternity/ANC + newborn 5. Radiology + theatre 6. Hospital cashier shifts + approvals 7. Signed-role server-side write filters.

## Zip 88 update
Done: SOAP consultation notes + diagnosis type (provisional/final/secondary/differential); lab **verification** step and **critical-result banner** (stays until the clinician is marked notified); **patient merge** (records re-pointed, allergies kept, duplicate tombstoned, audited).
Still open: maternity/ANC + newborn, radiology, theatre, hospital cashier shifts + approvals, claims lifecycle, extra registration/triage fields, SMS reminders, server-side role enforcement.

## Zip 89 update
Done: **Maternity/ANC** (G/P, LMP -> EDD, gestation, risk flags, ANC visits with BP/Hb/fundal height/FHR/urine protein alerts), **labour** observations with partograph alert line (advisory) and FHR/contraction/BP alerts, **delivery** record (mode, blood loss, complications, haemorrhage alert), **newborn** registered as its own linked patient (mother's id, birth weight, APGAR, gestation, low-APGAR/low-weight alerts, twins), all in the patient timeline.
Still open: postpartum monitoring, newborn feeding/immunisation/NICU, radiology, theatre, hospital cashier shifts + approvals, claims statuses, extra registration/triage fields, SMS reminders, server-side role enforcement.

## Zip 90 update
Done: **Cashier shifts** (new tab): open with cash float, live totals (cash / M-Pesa / card) from the sales ledger, count-and-close with expected vs actual cash and variance, mandatory explanation for any variance, Admin/Manager **approval** for variances over KES 100 (constant CASH_VARIANCE_APPROVAL_KES), frozen closing figures, corrections only as signed **adjustments** with a reason, audit entries, per-record sync (`cashShifts`).
Limits: expected cash uses the sales ledger (salesLog) only; cash refunds/returns and petty-cash payouts are not yet deducted; approval relies on the browser session (Admin or manager staff), not a server check.
Still open: refund/void approval queue, postpartum, newborn feeding/immunisation/NICU, radiology, theatre, claims statuses, extra registration/triage fields, SMS reminders, server-side role enforcement.

## Zip 91 update
Done: **Refund requests with approval** (in the Cashier Shift tab): cashier requests against a paid sale reference (amount capped at what is left after approved + pending refunds, method cash/M-Pesa/card, reason required); Admin/Manager approves or rejects (requester cannot approve their own unless Admin; rejection needs a reason); approval posts a NEGATIVE ledger entry (same 'payment' line convention as Pay-Later payments) attributed to the requesting cashier, so daily sales, reports and that cashier's shift expected cash fall by the refund. Fully audited; synced per record (`approvalRequests`).
Correction to the zip-90 note: the app has no cash-refund path elsewhere (returns are exchange/store credit), so there was no missing deduction - refunds now go through this workflow. Voids keep their existing management-password gate; a request-based void/discount queue is not built.
Still open: postpartum, newborn feeding/immunisation/NICU, radiology, theatre, claims statuses, extra registration/triage fields, SMS reminders, server-side role enforcement.

## Zip 92 update
Done: **Claims lifecycle** in Insurance / Institutions: claim numbers (CLM-YYMMDD-XXXX), statuses submitted -> under review -> approved / partially approved / rejected -> resubmitted -> paid with validated transitions (rejection reason, partial amount + shortfall reason, "paid" only after approval, paid is final), claimed / approved / rejected / paid amounts and a per-claim history, summary cards (claimed, awaiting payer, approved, rejected/short). Legacy "adjudicated" claims still move on. `institutions` and `institutionCharges` now sync per record.
Limits: a rejected or short-paid amount stays on the institution's balance until resolved there (no automatic write-off / bill-to-patient); no electronic submission to SHA or other payers (no adapter yet); no pre-submission validation rules.
Still open: postpartum, newborn feeding/immunisation/NICU, radiology, theatre, extra registration/triage fields, SMS reminders, server-side role enforcement.

## Zip 93 update
Done: **Registration fields** (all optional, under "More details"): date of birth (age derived), alternative phone, email, county, sub-county, address, national ID / passport no., SHA / insurance member no., next-of-kin relationship; validation (email format, DOB not in future, Kenyan mobile format asks to confirm); registry search and duplicate detection now also use national ID, SHA no., alternative phone, email; merge carries the new fields. **Triage fields**: respiratory rate, pain score, blood glucose, pregnancy status, with critical flags (RR >=30 / <=8, glucose <3 / >=20 mmol/L, pain >=8) and summary display.
Data-protection note: national ID and SHA numbers are personal data - collect only where needed; they are stored with the patient record and searchable by staff who can open the Reception tab.
Still open: postpartum, newborn feeding/immunisation/NICU, radiology, theatre, SMS reminders, server-side role enforcement, e-claims adapters.

## Zip 94 update
Done: **Radiology / imaging** (new tab): X-ray, ultrasound, CT, MRI, mammography, other; order numbers (RAD-YYMMDD-XXXX), clinical indication + priority (emergency first), request -> scheduled -> performed -> reported -> verified & released (steps cannot be skipped), findings + impression, critical-finding banner until the clinician is marked notified, corrections keep the original (reason required, needs re-verification), external image/accession reference, charge added to the patient's bill (price from a matching Service if one exists, otherwise flagged "price needed"), cancel with reason (unpaid charge cancelled), timeline + audit, per-record sync (`radiologyOrders`).
Not built / not claimed: no image storage, viewer, PACS or DICOM; no attachments; no worklist integration with imaging machines.
Fixed in zip 132: a cancelled (or not-carried) charge is shown as cancelled and no longer makes the bill "Unpaid" or adds to its total.
Still open: theatre, postpartum, newborn feeding/immunisation/NICU, SMS reminders, server-side role enforcement, e-claims adapters.

## Zip 95 update
Done: **Theatre / procedures** (new tab): case numbers (THE-YYMMDD-XXXX), elective/emergency, procedure + indication, scheduling with **room double-booking prevention** (overlapping window in the same room refused), surgical team (surgeon, anaesthetist, scrub, circulating), **consent** (who consented + witness, or a documented emergency justification), **pre-op assessment** (ASA 1-6, notes, checklist: fasting, allergies reviewed, site marked, blood available), READY gate (consent + pre-op + surgeon + allergies reviewed), start gate (emergency may start without full pre-op only with a documented override reason - audited and flagged on the timeline), **append-only** procedure / anaesthesia / post-op notes, recovery needs a procedure note, discharge from theatre needs a post-op note, **consumables** charged to the patient's bill, procedure charge at request, cancel with reason (unpaid charges cancelled), allergy banner in the case view, timeline + audit, per-record sync (`theatreCases`).
Limits: consumables are billed but NOT deducted from stock; no anaesthesia chart / vitals monitoring, WHO surgical safety checklist beyond the four pre-op ticks, instrument counts or theatre utilisation reports.
Still open: postpartum monitoring, newborn feeding/immunisation/NICU, SMS reminders, server-side role enforcement, e-claims adapters.

## Zip 96 update
Done: **Patient notifications** using the facility's existing SMS provider (Settings -> SMS, any provider behind /api/sms-send) or WhatsApp click-to-chat: per-appointment SMS / WhatsApp reminder buttons, "remind all appointments in the next 36 hours" (only scheduled, has a valid Kenyan mobile, not already reminded), and a Notify button on VERIFIED lab results ("your results are ready" - a critical result needs clinician acknowledgement first). Kenyan numbers are normalised to +254; every send/failure is logged on the record (who, when, channel, outcome) and audited; a reminder sent in the last 12 hours asks before repeating; not-configured / provider errors / missing numbers are reported, never silently dropped.
Privacy: messages are generic - never the reason for the visit, diagnosis, test name or result value (tested).
Limits: reminders are sent when a staff member presses the button (no background/scheduled sending in this offline-first app); WhatsApp needs the user to press send in WhatsApp (no WhatsApp Business API adapter); no prescription-ready, payment-received or outstanding-balance messages yet; SMS cost is billed by your own provider account.
Still open: postpartum monitoring, newborn feeding/immunisation/NICU, server-side role enforcement, e-claims adapters, patient portal.

## Zip 97 update
Done: **Postpartum monitoring** (mother's panel, after a delivery): BP, pulse, temperature, bleeding, uterus (contracted/boggy), lochia, notes; alerts for hypertension, fever, fast pulse, heavy bleeding, boggy uterus, offensive lochia; due-check tracker (first 24 h, day 3, day 6-7, 6 weeks). **Newborn care** (baby's panel): observations (temp, breathing, heart rate, SpO2, weight, jaundice, cord) with alerts incl. >10% weight loss from birth; feeding log; **immunisation** with a default Kenya schedule (BCG, OPV 0-3, Pentavalent 1-3, PCV 1-3, Rotavirus 1-2, IPV, Measles-Rubella 1-2) showing given / due / overdue, batch number required, no duplicates, no future or pre-birth dates; **NICU** admit (reason) / notes / discharge (summary). All in the patient timeline, audited, synced with the per-record patient sync.
IMPORTANT: alert thresholds are screening defaults and the immunisation list is a default schedule - the facility must confirm both against current Ministry of Health guidance (schedules change) before relying on them.
Limits: no growth charts / percentiles, no newborn screening or hearing tests, no vaccine stock deduction, no NICU charting beyond notes.
Still open: server-side role enforcement, e-claims adapters (SHA), patient portal, prescription-ready / balance messages.

## Zip 98 update
Decision recorded: role enforcement stays as it is (tab-level, in the browser; audit log records who did what). Server-side enforcement is NOT implemented - see the note on the hybrid signed-role design if a client ever needs it.
Done: **Operations snapshot** at the top of the Hospital Report ("Needs attention now"): critical results not acknowledged (lab + imaging), emergency patients waiting, queue by stage, appointments today, lab pending / unverified + 30-day average turnaround, imaging open / to verify, theatre today / in theatre, admitted inpatients (+ NICU babies), unpaid patient bills + amount, claims awaiting payer + rejected/short amount, open cashier shifts + variances/refunds awaiting approval. Cards jump to the relevant tab.
Still open: SHA e-claims adapter, patient portal, prescription-ready / balance messages, real-device testing.

## Zip 99 update
Done: **SHA / DHA eClaims credentials, per hospital** — Settings -> Insurance / Institutions -> SHA. Each facility pastes its own client ID, client secret, facility code and API base URL (issued after SHA registration + DHA certification), exactly like the existing M-Pesa Daraja panel: same storage pattern (functions/api/_sha-config.js, sha-config.js), scoped per client link, secret never sent back to the browser, Save / Test Connection / Remove Credentials.
**Test Connection** (sha-test.js) does a real OAuth2 client_credentials exchange against the facility's own base URL - this part is standard and reliable.
**Submit to SHA** button on any not-yet-paid claim in Insurance / Institutions (sha-claim-submit.js): builds a best-effort FHIR R4 Claim inside a Bundle from the Kenya eClaims Implementation Guide and POSTs it. IMPORTANT CAVEAT, and shown in the UI itself: this payload has NOT been validated against a live DHA sandbox or gone through DHA's mandatory certification - the endpoint only ever reports exactly what SHA's API returned (including the raw response) and NEVER changes the claim's status itself; the existing "Update status" flow still requires a human decision, unchanged.
11 server tests (tests/sha-integration.test.mjs) + 4 client tests (in hmis-integrity.test.mjs) — credential scoping/isolation, partial-save behaviour, connection test success/failure, claim payload shape, acceptance/rejection/network-failure handling, no-SHA-number warning, and confirming claimStatus is never auto-changed.
Still open: getting a real facility through DHA certification and validating the payload against their actual sandbox (only the facility can do this — it needs their own SHA-issued sandbox access); prescription-ready/balance SMS messages; real-device testing.

## Correction (this session)
Two items I'd listed as "still open" turned out not to be:
- **Outstanding-balance SMS reminders already existed** in the shared codebase before this session (the 🔔 Remind button on Patient Bills, `sendBillReminderSms()` — sends a generic "you owe KES X" text). Not new work, just mislabeled as a gap.
- **Prescription-ready notifications don't fit this app's design.** The Dispense / Bill tab IS the pharmacy counter — a patient's medication is billed and handed over in the same motion at the cashier, the same single-counter model every app in this suite uses. There is no separate "prescription filled, waiting for pickup" state to notify about, so building that notification would be adding a workflow state the app doesn't have, not closing a real gap.

## Zip 100 update — least-privilege station split (Reception / Diagnosis) + no forced roles
Done, per explicit user request: the hospital module now separates "search for the one patient you're handling" from
"browse the whole registry" for the walk-in journey.
- **New "Reception" tab**: search-first (name, patient no., phone) lookup + registration form. Shows only identity,
  phone, next-of-kin and a routing hint (has an appointment today / returning patient) — no allergies, diagnosis,
  timeline, merge or maternity tools. A found patient can be sent straight to Triage.
- **New "Diagnosis" tab**, positioned between Queue/Triage and Laboratory: search-first (name, patient no., phone, OR
  a visit reference), and only once a patient is found does the doctor see full clinical context — allergies banner,
  queue/triage status, a "Full History" (timeline) button and "Open Consultation" (the existing visit modal:
  diagnosis, SOAP, medications, lab/institution billing). Nothing is listed until a search is run.
- **Old full-registry tab relabelled "Patient Records"**, moved to the admin area (next to Staff) — kept fully intact
  (edit, merge, timeline, maternity/newborn) for admin/records use; day-to-day stations no longer default there.
- **Tab order** now follows the walk-in journey: Reception -> Appointments -> Queue/Triage -> Diagnosis -> Laboratory
  -> Radiology -> Theatre -> Pharmacy & Cashier (still one combined counter, see limits) -> Pharmacy Stock -> rest.
- **Queue, Laboratory, Radiology and Theatre "pick a patient to request/add" dropdowns converted** from a full
  <select> listing every patient to the same search-first widget (shared `renderPatientSearchPicker`).
- **Sales Counter access is no longer ever forced.** Found and removed a one-time migration that unconditionally
  pushed 'sales-tab' into any staff member's roles lacking a migration flag — including brand-new staff — which
  silently overrode an admin's explicit "Lab only" assignment. New-staff invites now start with nothing pre-checked;
  every tab, Sales Counter included, is the admin's deliberate choice and nothing is auto-added.
- Existing per-tab role-visibility system (already in the app) picked up the two new tabs automatically once added
  to LOCKABLE_TABS/ROLE_TABS — no new access-control mechanism needed.
Limits / known simplification, stated plainly: Pharmacy dispensing and Cashier billing remain ONE combined counter
("Pharmacy & Cashier") as in the rest of this app suite — splitting them into two separate stations/queue states
was judged too large a change for this pass and was not attempted. Appointments' own patient-select dropdown and
this sales-tab/cashier split were left out of scope; flag if you want either addressed next.
7 new tests (search matching, visit-ref search, Reception's minimal card, Diagnosis's full-context card, the picker
widget itself, the converted Queue/Lab pickers, and the no-forced-role guarantee) — all passing, alongside the full
81-file suite with zero failures.

## Zip 102 update — prescribe medicine not in stock + carry/not-carry ticking at dispensing
Done, per explicit user request: a doctor can now prescribe a medicine this facility does NOT stock —
each medication row in the visit form has a "Not stocked here — prescribe only" checkbox that swaps the
inventory dropdown for a free-text name field. These entries save with dosage on the visit record but are
NEVER charged and never touch stock. At the cashier, loading a bill that includes a stocked medication now
shows a carry-checklist (ticked by default, dosage shown) before it enters the cart; unticking one asks for
a reason (cost / unavailable), marks that specific charge "declined" (not left dangling as unpaid forever),
audits it, and excludes it from the sale. A "Print slip" button (on the visit history, and automatically
after declining anything) prints every not-stocked and declined medicine together — name, quantity, dosage,
and why — for the patient to take to an outside chemist. Dosage now shows at every step: the visit form,
visit history, patient timeline, the carry-checklist, and the printed slip.
Regression caught and fixed: `loadPatientBill()` behavior change required updating tests/patient-billing.test.mjs
(6 call sites) to also call the new confirmMedicationCarry() step — all 9 of its tests pass again.
6 new tests in hmis-integrity.test.mjs (free-text prescribing, the empty-row edge case, history/timeline
display, the full decline flow, the all-ticked-normal-path case, and the print function) — all passing.


## Zip 132 update — the open items
Done:
* **Pharmacy and Cashier are separate stations.** 💳 Cashier / Counter takes payment (stock comes off then, as before). 💊 Pharmacy (Dispensing) has its own queue and a worklist of paid prescriptions: ✔ Dispensed (who / when, in the journey and the audit) or ✖ Not collected (reason). Unpaid medicines are sent to the Cashier first; after paying, "Send to…" suggests the Pharmacy.
* **Appointments** use the search-first patient picker.
* **Void and discount requests:** a cashier requests, a manager approves or rejects (with a reason) in 💵 Cashier Shift ▸ Approvals, on any device. An approved discount applies only to the unchanged cart it was asked for, and only once.
* **Radiology images:** added from the device, compressed before upload (JPEG, at most 1600 px and ~350 KB), kept on the device until uploaded (retried offline), and viewable on any device. Still not a PACS / DICOM viewer.
