# Zip 165 — Owner Console + CRM fixes
1. Removing staff in the Owner Console now sticks (tombstone, not delete) — they no longer come back after refresh.
2. Duplicate staff: removed/duplicate records are hidden everywhere in the console.
3. CRM sign-in accepts the Owner Console email/phone + password (no need to "Continue as owner" first).
4. CRM sources: new "App sign-up / demo" source. Website-form leads stay "website"; WhatsApp ad leads stay "whatsapp". Existing sign-up leads are re-labelled automatically once.
5. CRM leads: "Hide won" and "Hide lost" filters.
6. ONE money rule (`saleReceived`): voided = 0, unpaid = 0, otherwise the amount actually received. Dashboard, Daily Sales, Profits, printed reports and per-day revenue all use it. "♻️ Reset ALL Sales, Bills & Link Income to 0" (Settings > Danger zone, management password) also zeroes every permanent link's recorded money and the per-person ledger. Then tick each link's 💰 toggle: agreed / paid / left (the balance becomes a bill).
7. Staff with the 🔗 Generate Link tab generate links by typing their own PIN (server checks it against the staff record, the tab permission, and rate-limits). No owner session needed. Staff cannot do anything else owner-only.
8. CRM: "Owner Console" button (sidebar + account menu) for owners.
9. Permanent links: "🕐 Convert to demo" (fresh demo window, recorded income on the link cleared).
10. Sweep: printed profit report now excludes unpaid sales like the screen; cash/M-Pesa split can no longer exceed the revenue figure.
