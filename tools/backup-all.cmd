@echo off
rem tools\backup-all.cmd - zip 186. Backs up EVERY table of the D1 database EXCEPT the data of ledger_audit (the runaway table), one file per table.
rem Run from the project folder (the one with wrangler.toml):   tools\backup-all.cmd            (database name: mydukapos-ledger)
rem Another database:                                            tools\backup-all.cmd other-db-name
rem Output: backup\schema.sql (schema of ALL tables, no data - ledger_audit's schema included) and backup\<table>.sql (schema + data) per table.
rem A table that fails is logged in backup\backup-log.txt and the loop CONTINUES; the summary at the end lists every failure. READ-ONLY: nothing is changed in the database.
rem Note: while an export runs D1 may refuse other queries for that database (it is already down for writes in this incident).
rem Tables not in the database any more (e.g. crm_* after migration 0008) simply log as failed: that is expected after the CRM is dropped.
setlocal EnableExtensions EnableDelayedExpansion
set "DB=mydukapos-ledger"
if not "%~1"=="" set "DB=%~1"
if not exist "wrangler.toml" (
  echo Run this from the project folder that holds wrangler.toml, for example: cd C:\dev\mydukapos
  exit /b 2
)
if not exist "backup" mkdir "backup"
set "LOG=backup\backup-log.txt"
echo Backup of %DB% started %DATE% %TIME% > "%LOG%"
set /a OKS=0
set /a FAILS=0
set "FAILED="

rem 1. the schema of every table first (no data)
echo [1] schema (no data)
call npx wrangler d1 export %DB% --remote --no-data --output=backup\schema.sql >> "%LOG%" 2>&1
call :check schema backup\schema.sql

rem 2. every table except ledger_audit: ledger_*, store_*, qr_*, shop_write_fence, mpesa_code_claims, then the CRM tables (dropped by 0008)
for %%T in (
  ledger_meta ledger_records ledger_sales ledger_sale_items ledger_payments ledger_bills ledger_gateway ledger_batches
  store_items store_movements
  qr_locations qr_orders qr_order_items qr_order_payments qr_order_requests qr_order_events
  shop_write_fence mpesa_code_claims
  crm_meta crm_settings crm_users crm_roles crm_user_perms crm_invitations crm_statuses crm_classifications crm_sources crm_lost_reasons crm_products
  crm_campaigns crm_adsets crm_ads crm_spend crm_imports crm_import_rows crm_leads crm_lead_products crm_lead_owners crm_activities crm_contact_attempts
  crm_followups crm_meetings crm_conversations crm_messages crm_customers crm_sales crm_attribution_events crm_notifications crm_audit crm_events
  d1_migrations
) do (
  echo [table] %%T
  call npx wrangler d1 export %DB% --remote --table=%%T --output=backup\%%T.sql >> "%LOG%" 2>&1
  call :check %%T backup\%%T.sql
)

echo.
echo ============================================================
echo Backup finished: !OKS! file(s) written, !FAILS! failed.
if !FAILS! GTR 0 echo FAILED: !FAILED!
echo Log: %LOG%
echo ledger_audit DATA was deliberately NOT exported (use tools\archive-audit.mjs for the rows that will be pruned).
echo ============================================================
if !FAILS! GTR 0 (
  echo Check each failed table: crm_* tables that no longer exist are fine; anything else must be fixed or retried before pruning or dropping.
  exit /b 1
)
exit /b 0

:check
rem %1 = table name, %2 = file. An export that wrote no file, or an empty one, counts as a failure.
if exist "%~2" (
  for %%S in ("%~2") do set "SZ=%%~zS"
  if !SZ! GTR 0 (
    set /a OKS+=1
    echo    ok  %~1  !SZ! bytes
    echo OK %~1 >> "%LOG%"
    goto :eof
  )
)
set /a FAILS+=1
set "FAILED=!FAILED! %~1"
echo    FAILED  %~1
echo FAILED %~1 >> "%LOG%"
goto :eof
