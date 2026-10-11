# One-time deploy of the paid feed to Cloudflare Workers (free tier).
# Run from C:\dev\earner\feed-worker in PowerShell:   .\setup.ps1
# You will be asked to log in to Cloudflare in your browser once.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "1/4  Log in to Cloudflare (a browser window opens)..." -ForegroundColor Cyan
npx wrangler login

Write-Host "2/4  Creating the KV store for the feed..." -ForegroundColor Cyan
$out = npx wrangler kv namespace create FEED 2>&1 | Out-String
$m = [regex]::Match($out, '"id"\s*:\s*"([0-9a-f]{32})"')
if (-not $m.Success) { $m = [regex]::Match($out, 'id\s*=\s*"([0-9a-f]{32})"') }
if (-not $m.Success) { Write-Host $out; throw "Could not read the KV namespace id from wrangler output." }
$kvId = $m.Groups[1].Value
(Get-Content wrangler.jsonc -Raw) -replace 'REPLACE_WITH_KV_ID', $kvId | Set-Content wrangler.jsonc -Encoding utf8
Write-Host "     KV namespace id: $kvId"

Write-Host "3/4  Deploying the worker..." -ForegroundColor Cyan
npx wrangler deploy --minify

$acct = (npx wrangler whoami 2>&1 | Out-String)
$a = [regex]::Match($acct, '([0-9a-f]{32})')
Write-Host ""
Write-Host "4/4  Let the agent publish to it:" -ForegroundColor Cyan
Write-Host "     a) Cloudflare dashboard -> My Profile -> API Tokens -> Create Token -> Custom token,"
Write-Host "        permission: Account / Workers KV Storage / Edit  (nothing else)."
Write-Host "     b) Add these three lines to C:\dev\earner\.env :"
Write-Host "        CF_ACCOUNT_ID=$($a.Groups[1].Value)"
Write-Host "        CF_KV_NAMESPACE_ID=$kvId"
Write-Host "        CF_API_TOKEN=<the token you just created>"
Write-Host ""
Write-Host "Done. The next autopilot cycle publishes the feed. Check: <your-worker-url>/health" -ForegroundColor Green
