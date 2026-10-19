param([string]$Relay = 'myten')
$ErrorActionPreference = 'Stop'
if ($Relay -notmatch '^[a-zA-Z0-9_.@-]+$') { throw 'Use a configured SSH alias or user@host.' }
$runtime = Join-Path $env:LOCALAPPDATA 'ArgusDesktopWeb'
New-Item -ItemType Directory -Force $runtime | Out-Null
$mutex = New-Object Threading.Mutex($false, 'Local\ArgusDesktopWebTunnel')
if (-not $mutex.WaitOne(0)) { exit 0 }
$sshExe = (Get-Command ssh.exe -ErrorAction Stop).Source
$workerFile = Join-Path $runtime 'supervisor.pid'
$sshPidFile = Join-Path $runtime 'ssh.pid'
$stopFile = Join-Path $runtime 'stop'
if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile -Force }
$PID | Set-Content -LiteralPath $workerFile -Encoding ascii
$sshProcess = $null
try {
    while (-not (Test-Path -LiteralPath $stopFile)) {
        $sshArgs = @('-NT','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-L','127.0.0.1:18943:127.0.0.1:18943',$Relay)
        $sshProcess = Start-Process -FilePath $sshExe -ArgumentList $sshArgs -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $runtime 'ssh-error.log') -RedirectStandardOutput (Join-Path $runtime 'ssh-output.log')
        $sshProcess.Id | Set-Content -LiteralPath $sshPidFile -Encoding ascii
        while (-not $sshProcess.WaitForExit(1000)) {
            if (Test-Path -LiteralPath $stopFile) { Stop-Process -Id $sshProcess.Id -ErrorAction SilentlyContinue; break }
        }
        if (-not (Test-Path -LiteralPath $stopFile)) { Start-Sleep -Seconds 3 }
    }
} finally {
    if ($sshProcess -and -not $sshProcess.HasExited) { Stop-Process -Id $sshProcess.Id -ErrorAction SilentlyContinue }
    foreach ($path in @($workerFile,$sshPidFile)) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
