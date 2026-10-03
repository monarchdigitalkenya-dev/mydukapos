@echo off
rem tools\prune-audit.cmd - wrapper for tools\prune-audit.mjs (zip 186). Run from the project folder (the one with wrangler.toml).
rem   tools\prune-audit.cmd --measure          read-only: where the audit rows are
rem   tools\prune-audit.cmd --dry-run          read-only: what --run would delete
rem   tools\prune-audit.cmd --run              deletes retry duplicates (asks you to type YES). Resume: --from-id N
setlocal
if not exist "%~dp0prune-audit.mjs" (echo prune-audit.mjs not found next to this file & exit /b 2)
pushd "%~dp0.."
node "tools\prune-audit.mjs" %*
set RC=%ERRORLEVEL%
popd
exit /b %RC%
