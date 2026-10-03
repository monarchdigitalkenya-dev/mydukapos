-- ############################################################################################################################
-- #  !!!  APPLY ONLY AFTER A BACKUP (tools\backup-all.cmd) AND AFTER SPACE HAS BEEN FREED ON mydukapos-ledger  !!!           #
-- ############################################################################################################################
-- zip 186: the CRM module is removed. This DROPS every crm_* table created by 0002_crm.sql and 0004_crm_speed.sql (leads,
-- sales, staff, audit, events, messages ...). THE DATA IN THEM IS GONE FOR GOOD: take the backup first (it must contain the crm_* tables).
--
-- Idempotent: every statement is DROP ... IF EXISTS, so running it twice (or on a database that never had the CRM) is harmless.
-- Order: triggers, views, indexes, tables. (SQLite would also drop a table's own triggers and indexes with the table; they are
-- listed on purpose. DROP TABLE does not fire the "never deleted" triggers.) 0002 and 0004 are applied history and stay as they are.
-- Touches no ledger_*, store_*, shop_* or qr_* object.
--   npx wrangler d1 migrations apply mydukapos-ledger --remote

-- zip 189: the tables below reference each other (e.g. crm_attribution_events -> crm_ads). Dropping a parent that still has child rows failed with
-- FOREIGN KEY constraint failed [7500] on real data. Deferring the check to the end of the migration (by then every crm_* table is gone) fixes it.
PRAGMA defer_foreign_keys = ON;

-- triggers
DROP TRIGGER IF EXISTS no_delete_crm_activities;
DROP TRIGGER IF EXISTS no_delete_crm_audit;
DROP TRIGGER IF EXISTS no_delete_crm_contact_attempts;
DROP TRIGGER IF EXISTS no_delete_crm_events;
DROP TRIGGER IF EXISTS no_delete_crm_lead_owners;
DROP TRIGGER IF EXISTS no_delete_crm_leads;
DROP TRIGGER IF EXISTS no_delete_crm_sales;
DROP TRIGGER IF EXISTS no_delete_crm_users;
DROP TRIGGER IF EXISTS no_rewrite_crm_events;
DROP TRIGGER IF EXISTS no_update_crm_audit;

-- views: the CRM created none.

-- indexes
DROP INDEX IF EXISTS ix_crm_activities_lead;
DROP INDEX IF EXISTS ix_crm_activities_user;
DROP INDEX IF EXISTS ix_crm_ads_adset;
DROP INDEX IF EXISTS ix_crm_adsets_campaign;
DROP INDEX IF EXISTS ix_crm_attr_ad;
DROP INDEX IF EXISTS ix_crm_attr_lead;
DROP INDEX IF EXISTS ix_crm_attr_unresolved;
DROP INDEX IF EXISTS ix_crm_audit_at;
DROP INDEX IF EXISTS ix_crm_audit_entity;
DROP INDEX IF EXISTS ix_crm_audit_user;
DROP INDEX IF EXISTS ix_crm_contacts_lead;
DROP INDEX IF EXISTS ix_crm_contacts_user;
DROP INDEX IF EXISTS ix_crm_conv_last;
DROP INDEX IF EXISTS ix_crm_conv_lead;
DROP INDEX IF EXISTS ix_crm_conv_unread;
DROP INDEX IF EXISTS ix_crm_customers_lead;
DROP INDEX IF EXISTS ix_crm_events_lead;
DROP INDEX IF EXISTS ix_crm_events_name;
DROP INDEX IF EXISTS ix_crm_events_pending;
DROP INDEX IF EXISTS ix_crm_followups_due;
DROP INDEX IF EXISTS ix_crm_followups_lead;
DROP INDEX IF EXISTS ix_crm_followups_lead_open;
DROP INDEX IF EXISTS ix_crm_followups_user;
DROP INDEX IF EXISTS ix_crm_import_rows_status;
DROP INDEX IF EXISTS ix_crm_inv_user;
DROP INDEX IF EXISTS ix_crm_lead_owners_lead;
DROP INDEX IF EXISTS ix_crm_lead_owners_user;
DROP INDEX IF EXISTS ix_crm_leads_ad;
DROP INDEX IF EXISTS ix_crm_leads_campaign;
DROP INDEX IF EXISTS ix_crm_leads_created;
DROP INDEX IF EXISTS ix_crm_leads_email;
DROP INDEX IF EXISTS ix_crm_leads_lastcontact;
DROP INDEX IF EXISTS ix_crm_leads_owner;
DROP INDEX IF EXISTS ix_crm_leads_owner_created;
DROP INDEX IF EXISTS ix_crm_leads_phone;
DROP INDEX IF EXISTS ix_crm_leads_source;
DROP INDEX IF EXISTS ix_crm_leads_status;
DROP INDEX IF EXISTS ix_crm_leads_status_created;
DROP INDEX IF EXISTS ix_crm_leads_updated;
DROP INDEX IF EXISTS ix_crm_leads_wa;
DROP INDEX IF EXISTS ix_crm_meetings_lead;
DROP INDEX IF EXISTS ix_crm_meetings_start;
DROP INDEX IF EXISTS ix_crm_meetings_user;
DROP INDEX IF EXISTS ix_crm_messages_conv;
DROP INDEX IF EXISTS ix_crm_notif_created;
DROP INDEX IF EXISTS ix_crm_notif_user;
DROP INDEX IF EXISTS ix_crm_sales_ad;
DROP INDEX IF EXISTS ix_crm_sales_campaign;
DROP INDEX IF EXISTS ix_crm_sales_lead;
DROP INDEX IF EXISTS ix_crm_sales_product;
DROP INDEX IF EXISTS ix_crm_sales_sold;
DROP INDEX IF EXISTS ix_crm_sales_staff;
DROP INDEX IF EXISTS ix_crm_spend_ad;
DROP INDEX IF EXISTS ix_crm_spend_campaign;
DROP INDEX IF EXISTS ix_crm_spend_date;
DROP INDEX IF EXISTS ix_crm_users_status;
DROP INDEX IF EXISTS uq_crm_ad_ext;
DROP INDEX IF EXISTS uq_crm_adset_ext;
DROP INDEX IF EXISTS uq_crm_campaign_ext;
DROP INDEX IF EXISTS uq_crm_lead_one_owner;

-- tables
DROP TABLE IF EXISTS crm_activities;
DROP TABLE IF EXISTS crm_ads;
DROP TABLE IF EXISTS crm_adsets;
DROP TABLE IF EXISTS crm_attribution_events;
DROP TABLE IF EXISTS crm_audit;
DROP TABLE IF EXISTS crm_campaigns;
DROP TABLE IF EXISTS crm_classifications;
DROP TABLE IF EXISTS crm_contact_attempts;
DROP TABLE IF EXISTS crm_conversations;
DROP TABLE IF EXISTS crm_customers;
DROP TABLE IF EXISTS crm_events;
DROP TABLE IF EXISTS crm_followups;
DROP TABLE IF EXISTS crm_import_rows;
DROP TABLE IF EXISTS crm_imports;
DROP TABLE IF EXISTS crm_invitations;
DROP TABLE IF EXISTS crm_lead_owners;
DROP TABLE IF EXISTS crm_lead_products;
DROP TABLE IF EXISTS crm_leads;
DROP TABLE IF EXISTS crm_lost_reasons;
DROP TABLE IF EXISTS crm_meetings;
DROP TABLE IF EXISTS crm_messages;
DROP TABLE IF EXISTS crm_meta;
DROP TABLE IF EXISTS crm_notifications;
DROP TABLE IF EXISTS crm_products;
DROP TABLE IF EXISTS crm_roles;
DROP TABLE IF EXISTS crm_sales;
DROP TABLE IF EXISTS crm_settings;
DROP TABLE IF EXISTS crm_sources;
DROP TABLE IF EXISTS crm_spend;
DROP TABLE IF EXISTS crm_statuses;
DROP TABLE IF EXISTS crm_user_perms;
DROP TABLE IF EXISTS crm_users;

-- the OPTIONAL full-text search table (old migrations-optional/0005_crm_search.sql, applied by hand only if at all; no-op otherwise)
DROP TABLE IF EXISTS crm_leads_fts;
DROP TABLE IF EXISTS crm_search;
