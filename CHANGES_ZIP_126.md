# Zip 126 — Hospital: Kenyan patient flow, station tabs, queues with NOW SERVING + NEXT 5

Builds on zips 118–125. **Nothing was rebuilt.** The existing queue, patient registry, consultation, laboratory, pharmacy counter,
billing / SHA, referrals and maternity module are used as they are, connected into one patient flow.

## 1. Audit — what existed, and why maternity was "hidden"
| Area | Found in the code | Now |
|---|---|---|
| Patients | `patients` (one record per person, merged per record on sync) | unchanged, never duplicated |
| Visits / encounters | `visits` (consultation: SOAP, ICD-10, meds, services, referrals) | unchanged; each consultation is linked to the patient's visit today |
| Queue | `queue`: one entry per patient visit today; `stage` = station; `stageHistory` | **the backbone of every station** (extended, not replaced) |
| Stations | a fixed list `PIPELINE_STAGES` (12 positions) + one Triage table | **configurable stations**; the old ids stay valid |
| Reception | search / register, then one button: "Send to Triage" | **"Where are you going today?"** → any configured service |
| Triage | vitals with critical alerts | vitals, then **choose the next station** |
| Consultation | the Diagnosis tab (search, then consultation) | **🩺 Clinic / Consultation** tab with a queue per clinic |
| Laboratory | requests, results, verification | + its own queue; results send the patient back to the clinician |
| Pharmacy / Cashier | one counter loading unpaid charges by visit reference (stock, M-Pesa, SHA / insurance) | + Pharmacy and Cashier queues that open the counter |
| ANC, labour, delivery, postnatal, newborn | **complete** (profile, EDD, risk flags, partograph alert, delivery, newborn linked to the mother, immunisations, NICU), but only reachable from a pop-up on a patient's record: no tab, no station, no queue — **that is why it was hidden** | **4 station tabs** with queues and worklists; the same records |
| Referrals | internal / external on the visit, letter, status tracking | + a **Referrals** tab; an internal referral also puts the patient in that queue |
| Roles | tab permissions per staff member, clinical presets | + the new tabs and a **Midwife / Maternity** preset |
| Audit | `logAudit` | every placement, call, move, priority change, out-of-turn call and completion |
| Offline | every record is kept on the device and synced per record | unchanged: stations work offline |

## 2. Station tabs (navigation grouped)
* **Patient services:** 🛎️ Reception · 📅 Appointments · 🚦 Triage · 🩺 Clinic / Consultation · 🚑 Emergency
* **Maternity & child health:** 🤰 ANC / Maternity · ⏱️ Labour & Delivery · 🤱 Postnatal · 👶 Newborn / Child Health
* **Diagnostics & procedures:** 🧪 Laboratory · 🩻 Radiology · 🩹 Procedures / Theatre
* **Medication & billing:** 💊 Pharmacy & Cashier (Pharmacy + Cashier queues), stock, patient bills, cashier shift
* **Operations:** ➡️ Referrals · 🏁 Discharge · 🗂️ Patient Records · 📊 Hospital Report · 🔍 Audit · ⚙️ Settings

## 3. Every station board (one design)
* **NOW SERVING:** ticket, name, age/sex, priority, service, who called them, how long they waited, vitals from triage.
* **NEXT 5** in order: ticket, name, waiting time, priority, service, and where they came from.
* **📢 CALL NEXT PATIENT.**
* **Station statistics:** waiting, serving, completed today, average wait, priority count.
* **The full queue, completed today, and patient search** (name, number, phone, visit reference or **ticket**, e.g. G-012).
* **📺 Display:** a numbers-only screen for the waiting room, with **no names**.
* **Buttons that match the station:**
  * Triage: record vitals.
  * Clinics: open the consultation.
  * ANC, Labour, Postnatal: the maternity record.
  * Labour: admit to labour.
  * Lab: tests and results.
  * Pharmacy / Cashier: open the patient's bill at the counter.
  * Every station: ➡️ Send to…, 🏁 Finish visit, 🧭 Journey, ⏸ Not here.

**Queue rules**
* **Statuses:** at a station a patient is Waiting, Called or In service. A visit ends as Completed, Referred out, Cancelled or No show.
* **Moves are recorded:** each move is kept as transferred or internal referral, with who, when, from where and why.
* **Order:** Emergency, then Priority, then Routine, then arrival time at that station.
* **Priority changes** need a reason. So does serving someone out of turn. Both go to the audit log.
* **Tickets** are per station per day (G-001, A-001, CH-001 …).
* **Nothing is ever deleted.** "Remove" now cancels the visit with a reason.

## 4. Flow — no fixed path
**Placing a patient**
* Reception, Triage, or any station's search sends the patient to the station chosen. A patient already on today's list is
  **moved**, never added twice.
* If two devices put the same patient on the list while offline, one entry stays and the other is closed as a duplicate. Every
  device picks the same one.

**Suggested next station** (highlighted in the "Send to…" dialog)
* A pending lab test suggests Laboratory; the patient comes back to the same clinic for review.
* Medicines suggest Pharmacy; unpaid charges suggest Cashier; otherwise Discharge.
* After triage: emergency suggests Emergency, a pregnant woman suggests ANC, a child under 5 suggests Child Health, otherwise
  General Clinic.

**Along the visit**
* **Consultation:** saving a consultation no longer ends the visit. The patient is sent on.
* **Delivery:** recording a delivery registers the baby (its own record, linked to the mother) and puts the baby in the
  **Newborn care** queue. The mother's record carries ANC → labour → delivery → postnatal.
* **Finish visit:** the options are discharged home, follow-up (**books the appointment**), admitted, referred out, left before
  being seen, or died.
* **Journey:** the patient's journey, built from what actually happened, is on every board and on the patient's Full History.

## 5. Configuration (Settings ▸ 🏥 Stations & Services)
* Switch stations on or off, rename them, and set their ticket letters.
* Choose which stations Reception offers.
* Add your own clinics (ENT, Physiotherapy, Nutrition …). Each gets its own queue and board.
* Optionally announce called tickets out loud on a device.
* The configuration syncs to every device.
* Payments stay as configured: cash, M-Pesa, and SHA / insurance / institutions.

## 6. Hospital Report
A new **Patient flow today** section shows each station's waiting, serving, done today, average wait and priority counts, and
how visits ended.

## Acceptance checklist
| Criterion | Status | Evidence |
|---|---|---|
| Reception asks for the destination and sends the patient to that queue | ✅ | Reception test |
| Triage routes the patient | ✅ | TEST 1 |
| Every major station has a visible tab | ✅ | navigation test |
| Currently serving and next 5 on every station | ✅ | TEST 7 checks the DOM |
| CALL NEXT works and positions update | ✅ | TEST 7 |
| Queue history is preserved | ✅ | TEST 7: every entry kept, event log |
| Clinic, ANC, Maternity, Labour & Delivery, Postnatal and Newborn/Child each visible | ✅ | TESTs 2–4 |
| ANC → Labour → Delivery → Postnatal → Newborn connected | ✅ | TEST 3 |
| Lab and Pharmacy each have a workflow and a queue | ✅ | TEST 1: result entered, dispensed from the one stock, paid |
| Billing stays connected | ✅ | TEST 1 |
| Referrals work internally and externally | ✅ | TEST 6 |
| No forced path; no duplicate patients or visits | ✅ | Reception test, TEST 1, two-device test |
| Existing records, authentication, offline use and integrations intact | ✅ | full test suite, including the existing HMIS and billing suites |
| Role permissions enforced | ✅ | navigation / roles test |
| Audit trail of movements | ✅ | TEST 7 |
| Phone, tablet and desktop | ✅ | real-browser scans: no screen wider than the phone at 360 / 390 px, every tab works on the first tap at 360 and 1280 px |

## Tests added
`tests/hmis-patient-flow.test.mjs` has 11 tests:
* Reception;
* TEST 1 (general outpatient);
* TEST 2 (ANC);
* TEST 3 (maternity);
* TEST 4 (child health);
* TEST 5 (emergency);
* TEST 6 (referral);
* TEST 7 (7 patients in one queue);
* two devices syncing, including duplicates made offline;
* configurable stations;
* the navigation and roles.

One existing test was narrowed. `hmis-integrity`'s Reception check forbade the word "Maternity" on the Reception card, and its
pattern also matched "E*merge*ncy". Reception now legitimately offers ANC / Maternity and Emergency as destinations, so the
check now forbids the clinical **tools** (maternity record, timeline, merge, allergies), which is what it was protecting.
