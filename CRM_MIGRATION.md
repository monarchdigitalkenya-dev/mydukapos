# Migrating the old Owner Console "Leads" tab into the CRM

The migration is **one-way, idempotent and read-only on the old data**. Nothing in KV (`leads-sheet:*`, `leads-meetings`, `leads-staff-list`, `leads-whatsapp-inbox`, `demo-account-index:v1`, `demo-account:<email>`) is ever deleted or modified, so the old tab can keep being used and the migration can be re-run at any time.

## How to run it (owner token only)
1. `POST /api/crm/legacy/migrate {"dryRun": true}` -> counts of what would be created / skipped, plus warnings. Writes nothing.
2. `POST /api/crm/legacy/migrate {}` -> does it. Safe to repeat: rows already migrated are found by `legacy_id` and skipped; CRM edits made since are never overwritten. Leads added to the old tab later are picked up by the next run.
3. `GET /api/crm/legacy/verify` -> compares old vs CRM (leads, website signups, won, lost, meetings, staff names, agreed and paid totals) and lists anything missing. `ok:false` means at least one number differs or a lead is missing; the CRM count may legitimately be higher after new leads are added directly in the CRM.

Only after `verify` says `ok: true` should the old tab be retired. Even then the KV data stays.

## Mapping
| Old (KV) | New (D1) | Notes |
|---|---|---|
| `leads-sheet:<date>` records | `crm_leads` | The old tab **carried uncontacted leads forward under a new id every day**, so one person appears on many sheets. Records are folded into ONE lead by the last 9 digits of the phone (`legacy_id = lead:p:<9 digits>`); a record with no phone keeps its own id (`lead:i:<id>`). The original records are stored verbatim in `crm_leads.legacy_json`. |
| name / phone / notes | name, phone (+ normalised), notes | The latest record wins for name and notes; an unusable phone is kept in the notes as "Legacy phone (not a valid number)" and the lead has no phone. |
| `product` | `crm_lead_products` | Products seen on any record. |
| `contacted`, `contactedBy`, `updatedAt` | status `contacted`, `first_contact_at`, one `crm_contact_attempts` row | The exact contact time was never recorded; the record's `updatedAt` is used. |
| `scheduled` / `dead` / `closed` | status `meeting` / `lost` / `won` | `dead` becomes lost with reason "other" (the old tab had no reason). |
| `assignedTo` | owner (`crm_lead_owners`, kind `legacy`) | Only when the name matches a staff name. |
| `closed` + `agreedAmount` + `paidAmount` + `clientId/clientLink` | `crm_sales` (+ `crm_customers`) | Sale total = agreed amount, `amount_paid` = paid (capped at agreed); payment status paid / partial / unpaid. Closed by `contactedBy` (else `assignedTo`). The MyDuka client id and link are kept on the customer row. |
| `adId`, `adHeadline`, WhatsApp-ad markers | attribution (`meta_ads` ad entity) + source `whatsapp` | Campaign and ad set were never stored, so those stay empty until the ad is filed under an ad set (`PATCH /ads/:id`). |
| `leads-staff-list` (+ names found on leads) | `crm_users` | **Archived, login-disabled** users (`legacy_id = staff:<name>`) so history keeps real names. They can never sign in; give people real accounts with an invitation. "admin" maps to the owner user. |
| `leads-meetings` | `crm_meetings` | Matched to the lead by lead id or phone; a meeting whose lead is gone gets a lead of its own. A date without a time becomes 09:00 Nairobi with a note saying so. Status: `done` -> completed, otherwise scheduled. |
| `demo-account-index:v1` (+ `demo-account:<email>`) — the old "Website leads / Web signups" sub-view | `crm_leads`, source `website`, status New | **Every** index entry becomes one lead, `legacy_id = demo:<lowercased email>` (no email: `demo:tel:<9 digits>`; an entry with neither is skipped with a warning). "Website leads" = `demoStatus` other than `none` (active / expired / deleted, as the old tab counted them); accounts that registered but never generated a demo (`none`) are imported too with the note "registered, no demo yet" and counted separately (`websiteLeads.registeredOnly`). Name, phone, email, business (= branch name) are mapped; the product key maps to `crm_products` when it matches (otherwise it stays in the notes); product key, branch name, demo status, generated / expiry dates go into the notes; created / updated times are the account's `createdAt` / `generatedAt`. The index entry and the account record are kept verbatim in `legacy_json` (password hash and salt are never copied). An unusable phone / email is kept in the notes. Leads are NOT merged with day-sheet leads of the same phone: nothing is dropped. The demo-account API and all its KV data stay as they are. |
| `leads-whatsapp-inbox` + last WhatsApp message of each ad lead | `crm_conversations` + `crm_messages` | Deduplicated by WhatsApp message id. Un-merged ad chats create an `inboxlead:` lead. |

## Website signups going forward
`functions/api/demo-account.js` also files every NEW registration / demo request (`register`, `generate-demo`) in the CRM as a `website` lead, best-effort: only when the D1 binding exists, after the response is decided (`waitUntil`), every error swallowed, so a signup can never be delayed or broken by it (no D1 = no CRM push, signup unchanged). A person already in the CRM (same phone / WhatsApp / email) gets an attribution touch and the demo product instead of a duplicate. New leads carry `legacy_id = demo:<email>`, so the migration never creates them a second time.

## What cannot be migrated (and why)
- **Exact history**: the old tab overwrote records, so who did what and when before the migration is only as good as `updatedAt`. Migrated leads show one activity "Migrated from the old Leads tab" and the raw records in `legacy_json`; there is no per-change audit trail for the past.
- **Individual timestamps** of contact, close and assignment are approximated by the record's last update.
- **Older WhatsApp message bodies**: only the last message of each lead survives (the old tab kept nothing else); earlier text exists only in notes.
- **Lost reasons, classifications, follow-ups, source/campaign/ad set, response times**: never captured by the old tab, so they start empty (no invented values).
- **Real staff accounts and permissions**: names only; passwords and roles must be created in the CRM.
- **Web signup history**: only the current state of each account (status, dates) exists; earlier demos of an account that the owner reset are not recorded.
- **Deleted-in-KV data**: a lead removed from a sheet before migration is gone.
- **Staff attribution of carried-forward days**: a lead contacted on day 3 is credited to the person on the record that shows the contact.
