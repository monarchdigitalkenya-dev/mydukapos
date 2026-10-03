@echo off
rem tools\audit-monthly.cmd - zip 188. Monthly: archive audit rows older than 90 days to backup\audit-monthly\<YYYY-MM>, verify, then delete them from mydukapos-audit.
rem   tools\audit-monthly.cmd          = dry run (shows the count, changes nothing)
rem   tools\audit-monthly.cmd run      = archive + verify + prune
setlocal
if not exist "wrangler.toml" ( echo Run this from the project folder that holds wrangler.toml & exit /b 2 )
if /I "%~1"=="run" ( node tools\audit-monthly.mjs --run ) else ( node tools\audit-monthly.mjs )
exit /b %ERRORLEVEL%
