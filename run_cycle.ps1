# One autopilot cycle. Registered as scheduled task "earner-autopilot" (every 2 hours, while logged in).
# Pause:   schtasks /Change /TN "earner-autopilot" /DISABLE
# Remove:  schtasks /Delete /TN "earner-autopilot" /F
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force logs | Out-Null
$env:PYTHONUTF8 = "1"
# cmd redirection keeps the log UTF-8 (PowerShell 5.1 would write UTF-16)
cmd /c "`"$PSScriptRoot\.venv\Scripts\python.exe`" -m earner run >> logs\autopilot.log 2>&1"
