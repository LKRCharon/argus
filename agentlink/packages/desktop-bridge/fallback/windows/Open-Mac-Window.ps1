param([switch]$NoBrowser, [string]$Relay = 'myten')
$ErrorActionPreference = 'Stop'
if ($Relay -notmatch '^[a-zA-Z0-9_.@-]+$') { throw 'Use a configured SSH alias or user@host.' }
$viewUrl = 'http://127.0.0.1:18942/'
$sshExe = (Get-Command ssh.exe -ErrorAction Stop).Source
$runtime = Join-Path $env:LOCALAPPDATA 'ArgusAppView'
New-Item -ItemType Directory -Force $runtime | Out-Null
function Test-AppView {
    try { return (Invoke-RestMethod -Uri ($viewUrl + 'api/status') -TimeoutSec 2).service -eq 'argus-app-view' } catch { return $false }
}
if (Test-AppView) {
    if (-not $NoBrowser) { Start-Process $viewUrl }
    Write-Host 'Mac App View is ready:' $viewUrl
    exit 0
}
Write-Host 'Connecting to the Mac through myten...'
$worker = Join-Path $PSScriptRoot 'Keep-Connection.ps1'
$workerArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $worker + '"'),'-Relay',$Relay)
Start-Process -FilePath 'powershell.exe' -ArgumentList $workerArgs -WindowStyle Hidden | Out-Null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Test-AppView) {
        if (-not $NoBrowser) { Start-Process $viewUrl }
        Write-Host 'Mac App View is ready:' $viewUrl
        exit 0
    }
    Start-Sleep -Milliseconds 500
}
throw ('The encrypted connection is not ready. See logs in ' + $runtime)
