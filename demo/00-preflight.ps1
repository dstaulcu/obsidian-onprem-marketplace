# Checks everything the demo needs. Run from the repo root:  .\demo\00-preflight.ps1
# Prints only OK/FAIL, never secret values.
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$script:ok = $true
function Check($name, $cond, $hint) {
  if ($cond) { Write-Host ("  OK    " + $name) -ForegroundColor Green }
  else { Write-Host ("  FAIL  " + $name + "   -> " + $hint) -ForegroundColor Red; $script:ok = $false }
}
function PortFree($p) { return -not (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }

$cfg = Get-Content "demo\registry.config.json" -Raw | ConvertFrom-Json
Write-Host "Demo preflight" -ForegroundColor Cyan
Check "node 20+"                       ((node -p "process.versions.node.split('.')[0]") -ge 20) "install Node 20 or newer"
Check "sync CLI built"                 (Test-Path "packages\sync\dist\cli.js") "run: npm run build"
Check "marketplace plugin built"       (Test-Path "packages\plugin\main.js") "run: npm run build"
Check "Claude Code present"            (Test-Path $cfg.review.claudePath) ("fix review.claudePath in demo\registry.config.json (now: " + $cfg.review.claudePath + ")")
Check "ANTHROPIC_API_KEY set"          ([bool]$env:ANTHROPIC_API_KEY) "set it in THIS window before recording, then run Clear-Host"
Check "port 8080 free (registry)"      (PortFree 8080) "stop whatever is using 8080, or run .\demo\02-start-servers.ps1 only once"
Check "port 9090 free (fake GitHub)"   (PortFree 9090) "stop whatever is using 9090"
Check "signing key exists"             (Test-Path "demo\keys\signing-key.pem") "run: .\demo\01-reset.ps1"
Check "demo vault exists"              (Test-Path "demo\vault\.obsidian\plugins\onprem-marketplace\main.js") "run: .\demo\01-reset.ps1"
Check "fixtures present"               ((Test-Path "demo\fixtures\demo\hello-notes\1.0.0\main.js") -and (Test-Path "demo\fixtures\demo\shady-sync\1.0.0\main.js")) "git checkout demo\fixtures"
Write-Host ""
if ($script:ok) { Write-Host "All good. Open demo\vault in Obsidian once, turn Restricted mode off, then start recording." -ForegroundColor Green }
else { Write-Host "Fix the FAIL lines above, then run this again." -ForegroundColor Yellow }
