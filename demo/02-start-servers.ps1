# Starts the two local servers in their own windows:
#   fake GitHub (port 9090)  - serves demo\fixtures as GitHub releases
#   registry    (port 8080)  - serves demo\registry as static files (no caching)
# Run from the repo root. Close the windows (or Ctrl+C) to stop them.
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
New-Item -ItemType Directory -Force "demo\registry" | Out-Null
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; `$Host.UI.RawUI.WindowTitle='fake GitHub :9090'; node demo\fake-github.mjs 9090"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; `$Host.UI.RawUI.WindowTitle='registry :8080'; npx http-server demo\registry -p 8080 --cors -c-1"
Write-Host "Started. Registry: http://127.0.0.1:8080/index.json (empty until you run sync)" -ForegroundColor Green
