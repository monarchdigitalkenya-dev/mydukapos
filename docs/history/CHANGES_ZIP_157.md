# Zip 157 — MyDuka CRM
- New separate app at `/crm/` (WhatsApp-inspired, mobile first): dashboard, inbox, leads (+ pool/claim, duplicates, bulk actions), CSV import wizard, lead detail, follow-ups, calendar, products, campaigns, sales, reports, team, settings, audit, notifications.
- Server: `/api/crm/*` (D1 `crm_*` tables, migrations/0002_crm.sql), role + per-user permissions enforced on every request, atomic claim, audit log, response-time tracking, revenue attribution to campaign/ad/staff, public `/api/crm-lead`, Meta lead-ads webhook, WhatsApp inbound into CRM conversations.
- Owner Console: Leads tab, its code and `/api/leads` removed after a verified migration path (CRM -> Settings -> Import previous leads; old KV data untouched). New "CRM" link in the console.
- Web sign-ups (demo registrations) now flow into the CRM as website leads.
- Also fixed: Aqua stock-take test timing, chaos-test unhandled rejection guard (zip 156 follow-ups).
See CRM_ARCHITECTURE.md, CRM_MIGRATION.md.
