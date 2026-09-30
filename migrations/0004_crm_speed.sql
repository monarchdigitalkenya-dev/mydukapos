-- GENERATED from CRM_SPEED_SCHEMA in functions/api/_crm/schema.js by tools/gen-migration.mjs — do not edit by hand.
-- Indexes only (zip 161). Safe to run more than once (IF NOT EXISTS) and never drops or changes existing data.

CREATE INDEX IF NOT EXISTS ix_crm_leads_owner_created ON crm_leads (owner_id, created_at);

CREATE INDEX IF NOT EXISTS ix_crm_leads_updated ON crm_leads (updated_at);

CREATE INDEX IF NOT EXISTS ix_crm_leads_status_created ON crm_leads (status_key, created_at);

CREATE INDEX IF NOT EXISTS ix_crm_followups_lead_open ON crm_followups (lead_id, status, due_at);

CREATE INDEX IF NOT EXISTS ix_crm_notif_created ON crm_notifications (user_id, created_at);

CREATE INDEX IF NOT EXISTS ix_crm_conv_unread ON crm_conversations (last_message_at) WHERE unread_count > 0;
