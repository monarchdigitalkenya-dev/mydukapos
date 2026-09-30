-- GENERATED from CRM_FTS_SCHEMA in functions/api/_crm/schema.js by tools/gen-migration.mjs — do not edit by hand.
-- OPTIONAL fast lead search (zip 161). The CRM works without it (search falls back to LIKE). Apply it BY HAND (it is deliberately NOT in migrations/, so `wrangler d1 migrations apply` never applies it): npx wrangler d1 execute <db> --remote --file=migrations-optional/0005_crm_search.sql. Only if you accept that `wrangler d1 export` cannot dump a database that
-- contains a virtual table (a documented D1 limitation). Needs the FTS5 trigram tokenizer; if your D1 refuses it, skip this file: nothing else depends on it.
-- Safe to run more than once (IF NOT EXISTS, and the back-fill only adds leads that are missing).

CREATE VIRTUAL TABLE IF NOT EXISTS crm_leads_fts USING fts5(name, business_name, email, location, phones, tokenize = 'trigram');

CREATE TRIGGER IF NOT EXISTS crm_leads_fts_ai AFTER INSERT ON crm_leads BEGIN INSERT INTO crm_leads_fts (rowid, name, business_name, email, location, phones) VALUES (new.rowid, new.name, new.business_name, new.email, new.location, COALESCE(new.phone_norm, '') || ' ' || COALESCE(new.whatsapp_norm, '')); END;

CREATE TRIGGER IF NOT EXISTS crm_leads_fts_au AFTER UPDATE OF name, business_name, email, location, phone_norm, whatsapp_norm ON crm_leads BEGIN DELETE FROM crm_leads_fts WHERE rowid = old.rowid; INSERT INTO crm_leads_fts (rowid, name, business_name, email, location, phones) VALUES (new.rowid, new.name, new.business_name, new.email, new.location, COALESCE(new.phone_norm, '') || ' ' || COALESCE(new.whatsapp_norm, '')); END;

INSERT INTO crm_leads_fts (rowid, name, business_name, email, location, phones) SELECT l.rowid, l.name, l.business_name, l.email, l.location, COALESCE(l.phone_norm, '') || ' ' || COALESCE(l.whatsapp_norm, '') FROM crm_leads l WHERE l.rowid NOT IN (SELECT rowid FROM crm_leads_fts);
