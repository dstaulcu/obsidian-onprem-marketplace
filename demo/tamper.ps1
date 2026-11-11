# Simulates an attacker (or a bad deploy) changing a plugin file on the registry web server.
#   .\demo\tamper.ps1          appends a line to hello-notes 1.1.0 main.js on the server
#   .\demo\tamper.ps1 -Undo    restores the original
param([switch]$Undo)
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$target = "demo\registry\plugins\hello-notes\1.1.0\main.js"
$backup = "demo\tamper-backup\main.js"
if ($Undo) {
  if (-not (Test-Path $backup)) { Write-Host "Nothing to restore." -ForegroundColor Yellow; exit 0 }
  Copy-Item $backup $target -Force
  Remove-Item "demo\tamper-backup" -Recurse -Force
  Write-Host "Restored original main.js." -ForegroundColor Green
  exit 0
}
if (-not (Test-Path $target)) { Write-Host "Run sync first: $target not found." -ForegroundColor Red; exit 1 }
New-Item -ItemType Directory -Force "demo\tamper-backup" | Out-Null
if (-not (Test-Path $backup)) { Copy-Item $target $backup }
Add-Content $target "`n// injected by an attacker after approval"
Write-Host "Tampered: $target now differs from what was reviewed and approved." -ForegroundColor Yellow
