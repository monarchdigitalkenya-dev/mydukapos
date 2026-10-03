# Zip 169 — only real website leads are "Website"
- demo-account.js (app account sign-up / demo request) now creates client records with source 'signup' instead of 'website'; owner console shows "📲 App sign-up".
- Only the website contact form (/api/crm-lead) and the anonymous public demo are 'website'.
- CRM seed version 4: one more pass moves any leftover sign-up leads (legacy id demo:*) from Website to "App sign-up / demo"; never touches a lead you re-tagged by hand.
- Test: tests/zip169-signup-source.test.mjs. Workflows and native/ unchanged. No new migration file.
