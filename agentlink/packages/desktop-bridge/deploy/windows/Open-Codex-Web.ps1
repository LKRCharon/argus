param([switch]$NoBrowser, [string]$Relay = 'myten')
$ErrorActionPreference = 'Stop'
if ($Relay -notmatch '^[a-zA-Z0-9_.@-]+$') { throw 'Use a configured SSH alias or user@host.' }
$webUrl = 'http://127.0.0.1:18943/'
function Test-DesktopWeb {
    try { return (Invoke-RestMethod -Uri ($webUrl + 'api/status') -TimeoutSec 2).service -eq 'argus-desktop-web' } catch { return $false }
}
if (-not (Test-DesktopWeb)) {
    $worker = Join-Path $PSScriptRoot 'Keep-Connection.ps1'
    $workerArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $worker + '"'),'-Relay',$Relay)
    Start-Process -FilePath 'powershell.exe' -ArgumentList $workerArgs -WindowStyle Hidden | Out-Null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-DesktopWeb) { break }
        Start-Sleep -Milliseconds 500
    }
}
if (-not (Test-DesktopWeb)) { throw ('Connection is not ready. See ' + (Join-Path $env:LOCALAPPDATA 'ArgusDesktopWeb')) }
if (-not $NoBrowser) { Start-Process $webUrl }
Write-Host 'Mac conversations are ready:' $webUrl
