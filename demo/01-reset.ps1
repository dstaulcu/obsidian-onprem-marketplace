# Resets the demo to a clean starting state: new registry folder, new signing key, fresh vault with the
# marketplace plugin installed and the public key pinned (require-signed). Run from the repo root.
# Stop the web server first (Ctrl+C in its window) so the registry folder can be deleted.
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
Write-Host "Resetting demo state..." -ForegroundColor Cyan

foreach ($d in @("demo\registry", "demo\keys", "demo\vault", "demo\tamper-backup")) {
  if (Test-Path $d) { Remove-Item $d -Recurse -Force }
}
New-Item -ItemType Directory -Force "demo\vault\.obsidian" | Out-Null
"# Demo vault`n" | Set-Content "demo\vault\Welcome.md"

node packages\sync\dist\cli.js keygen demo\keys
node scripts\bootstrap-vault.mjs demo\vault http://127.0.0.1:8080 demo\keys\public-key.txt require-signed

Write-Host ""
Write-Host "Done. Next: .\demo\02-start-servers.ps1, then open demo\vault in Obsidian (Open folder as vault)" -ForegroundColor Green
Write-Host "and turn Restricted mode off (Settings > Community plugins) once, before you record." -ForegroundColor Green
