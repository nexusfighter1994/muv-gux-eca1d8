$ErrorActionPreference = 'Stop'
$key = 'C:/Users/user/.ssh/server_ed25519'
$runtime = 'E:/VidForgeHomeBoost/home-health-tunnel'
$remoteRoot = '/var/lib/docker/volumes/aufsetzen-apps_vidforge-data/_data/runtime'
$mutex = [Threading.Mutex]::new($false, 'Local\VidForgeHomeHealth20261101')
if (-not $mutex.WaitOne(0)) { exit 0 }
$state = [pscustomobject]@{Tunnel=$null}
$remoteGroup = 'health'
$healthForwards = @(($remoteRoot + '/home-health-ffmpeg.sock:127.0.0.1:18191'), ($remoteRoot + '/home-health-siglip.sock:127.0.0.1:18194'))
. (Join-Path $PSScriptRoot 'supervisor.ps1')
try {
    [IO.Directory]::CreateDirectory($runtime) | Out-Null
    while ($true) {
        Invoke-HealthChannelCycle $state
        Start-Sleep -Seconds 5
    }
} finally {
    # Only this status-only tunnel is owned here; media workers and tunnels stay alive.
    Stop-OwnedHealthTunnel $state
    $mutex.ReleaseMutex();$mutex.Dispose()
}
