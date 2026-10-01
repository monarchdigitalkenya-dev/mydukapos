# CI helper: finds the installed MyDukaPOS.exe, starts it, checks it keeps running for 15 s, stops it and (unless -NoUninstaller)
# runs its uninstaller silently. Every wait has a time limit.
param([switch]$NoUninstaller)
$exe = $null
for ($i = 0; $i -lt 45 -and -not $exe; $i++) {
  $exe = (Get-ChildItem "$env:LOCALAPPDATA\Programs", "$env:ProgramFiles", "${env:ProgramFiles(x86)}" -Recurse -Depth 2 -Filter 'MyDukaPOS.exe' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
  if (-not $exe) { Start-Sleep -Seconds 2 }
}
if (-not $exe) { Get-ChildItem "$env:LOCALAPPDATA\Programs" -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "Programs: $($_.Name)" }; throw 'not installed: MyDukaPOS.exe not found' }
$dir = Split-Path $exe
Write-Host "installed: $exe  version: $((Get-Item $exe).VersionInfo.ProductVersion)"
Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($dir) } | Stop-Process -Force -ErrorAction SilentlyContinue
$app = Start-Process $exe -PassThru
Start-Sleep -Seconds 15
$running = @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($dir) })
if ($running.Count -eq 0) { throw 'the app did not stay running' }
Write-Host "OK: MyDukaPOS is running ($($running.Count) processes, first pid $($app.Id)), window title: $((Get-Process -Id $app.Id -ErrorAction SilentlyContinue).MainWindowTitle)"
$running | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
if (-not $NoUninstaller) {
  $un = Get-ChildItem $dir -Filter 'Uninstall*.exe' | Select-Object -First 1
  if ($un) {
    $u = Start-Process $un.FullName -ArgumentList '/S' -PassThru
    if ($u.WaitForExit(120000)) { Write-Host "uninstaller exit code: $($u.ExitCode)" } else { Write-Host 'WARNING: the uninstaller did not finish within 2 minutes' }
    # zip 173: the NSIS uninstaller hands the work to a copy of itself and returns at once - wait until the folder is really gone
    for ($i = 0; $i -lt 45 -and (Test-Path $dir); $i++) { Start-Sleep -Seconds 2; if ($i -ge 20) { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue } }
  }
}
