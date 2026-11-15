function Write-HealthNote($message) {
    Add-Content -LiteralPath (Join-Path $runtime 'supervisor.log') -Value ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $message)
}
function Stop-OwnedHealthTunnel($state) {
    if ($state.Tunnel) {
        try {
            if (-not $state.Tunnel.HasExited) {
                $state.Tunnel.Kill()
                if (-not $state.Tunnel.WaitForExit(5000)) { throw 'Owned health SSH did not stop' }
            }
        } finally { $state.Tunnel.Dispose(); $state.Tunnel=$null }
    }
}
function Invoke-RemoteHealth($mode) {
    $command = 'python3 /opt/aufsetzen/vf-custom/home-health-tunnel/remote.py ' + $mode + ' ' + $remoteGroup
    $args = @('-T', '-i', $key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3', 'root@YOUR.SERVER.IP', ('"' + $command + '"'))
    $process = Start-Process -FilePath ssh.exe -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $runtime ($mode + '.stderr.log')) -RedirectStandardOutput (Join-Path $runtime ($mode + '.stdout.log'))
    try {
        # Windows PowerShell loses redirected child exit codes without a cached handle.
        $null = $process.Handle
        if (-not $process.WaitForExit(30000)) { $process.Kill(); $process.WaitForExit(); throw 'Health SSH preparation timed out' }
        if ($process.ExitCode -ne 0) { throw ('Health SSH ' + $mode + ' failed: ' + $process.ExitCode) }
    } finally { $process.Dispose() }
}
function Start-HealthTunnel {
    $a = @('-N', '-T', '-i', $key, '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3', '-o', 'StreamLocalBindMask=0117')
    foreach ($forward in $healthForwards) { $a += @('-R', $forward) }
    $a += 'root@YOUR.SERVER.IP'
    return Start-Process -FilePath ssh.exe -ArgumentList $a -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $runtime 'tunnel.stderr.log')
}
function Invoke-HealthChannelCycle($state) {
    if ($state.Tunnel -and -not $state.Tunnel.HasExited) { return }
    try {
        Stop-OwnedHealthTunnel $state
        Invoke-RemoteHealth 'prepare'
        $state.Tunnel = Start-HealthTunnel
        Start-Sleep -Seconds 3
        if ($state.Tunnel.HasExited) { throw 'Health SSH exited before ready' }
        Invoke-RemoteHealth 'verify'
        Write-HealthNote ('connected pid=' + $state.Tunnel.Id)
    } catch {
        $reason = $_.Exception.Message
        Stop-OwnedHealthTunnel $state
        Write-HealthNote ('retrying after: ' + $reason)
    }
}
