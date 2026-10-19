$runtime = Join-Path $env:LOCALAPPDATA 'ArgusAppView'
New-Item -ItemType Directory -Force $runtime | Out-Null
Set-Content -LiteralPath (Join-Path $runtime 'stop') -Value 'stop' -Encoding ascii
Write-Host 'The saved encrypted connection will stop. You can reopen it with Open-Mac-Window.cmd.'
