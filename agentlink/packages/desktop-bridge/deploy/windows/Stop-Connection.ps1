$runtime = Join-Path $env:LOCALAPPDATA 'ArgusDesktopWeb'
New-Item -ItemType Directory -Force $runtime | Out-Null
Set-Content -LiteralPath (Join-Path $runtime 'stop') -Value 'stop' -Encoding ascii
Write-Host 'The Argus Desktop Web tunnel will stop. Mac tasks continue running.'
