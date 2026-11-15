$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$runtime = 'E:/VidForgeHomeBoost/home-ocr'
$python = Join-Path $runtime '.venv312/Scripts/python.exe'
$tokenFile = 'E:/VidForgeHomeBoost/vf-speed-20261002/private/pc-boost-token.txt'
$key = 'C:/Users/user/.ssh/server_ed25519'
$remoteSocket = '/var/lib/docker/volumes/aufsetzen-apps_vidforge-data/_data/runtime/home-ocr.sock'
$mutex = [Threading.Mutex]::new($false, 'Local\VidForgeHomeOcr20261029')
if (-not $mutex.WaitOne(0)) { exit 0 }
$worker = $null
$state = [pscustomobject]@{Tunnel=$null}
$remoteGroup = 'ocr'
$healthForwards = @(($remoteSocket + ':127.0.0.1:18196'))
. 'E:/VidForgeHomeBoost/vf-custom/home-health-tunnel/supervisor.ps1'
try {
    if (-not (Test-Path -LiteralPath $python)) { throw 'OCR runtime missing' }
    Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-File', ('"' + $root + '/start-warm.ps1"')) -WindowStyle Hidden | Out-Null
    $token = [IO.File]::ReadAllText($tokenFile).Trim()
    while ($true) {
        $health = $null
        try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18196/health' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 3 } catch { }
        if ($null -eq $health) {
            if ($worker -and -not $worker.HasExited) { Start-Sleep -Seconds 5; continue }
            if (Get-NetTCPConnection -State Listen -LocalPort 18196 -ErrorAction SilentlyContinue) { throw 'OCR port occupied; refusing replacement' }
            $worker = Start-Process -FilePath $python -ArgumentList @('-u', ('"' + $root + '/service.py"'), '--token-file', ('"' + $tokenFile + '"')) -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'service.stdout.log') -RedirectStandardError (Join-Path $runtime 'service.stderr.log')
            Start-Sleep -Seconds 5
            continue
        }
        if ($health.contract -ne 'vf-home-ocr-native-v1-20261029') { throw 'OCR contract mismatch' }
        Invoke-HealthChannelCycle $state
        Start-Sleep -Seconds 5
    }
} finally {
    # Only this dedicated forward is ours; active media/SigLIP tunnels are never touched.
    Stop-OwnedHealthTunnel $state
    $mutex.ReleaseMutex();$mutex.Dispose()
}
