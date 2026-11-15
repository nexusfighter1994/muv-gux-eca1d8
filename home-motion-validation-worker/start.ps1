$ErrorActionPreference = 'Stop'
$runtime = 'E:/VidForgeHomeBoost/home-motion-validation'
$root = Join-Path $runtime 'worker'
$python = 'E:/VidForgeHomeBoost/home-ocr/.venv312/Scripts/python.exe'
$tokenFile = 'E:/VidForgeHomeBoost/vf-speed-20261002/private/pc-boost-token.txt'
$key = 'C:/Users/user/.ssh/server_ed25519'
$remoteSocket = '/var/lib/docker/volumes/aufsetzen-apps_vidforge-data/_data/runtime/home-motion-validation.sock'
$mutex = [Threading.Mutex]::new($false, 'Local\VidForgeHomeMotionValidation20261031')
if (-not $mutex.WaitOne(0)) { exit 0 }
$worker = $null
$state = [pscustomobject]@{Tunnel=$null}
$remoteGroup = 'validation'
$healthForwards = @(($remoteSocket+':127.0.0.1:18197'))
. 'E:/VidForgeHomeBoost/vf-custom/home-health-tunnel/supervisor.ps1'
try {
    $token = [IO.File]::ReadAllText($tokenFile).Trim()
    while ($true) {
        $health = $null
        try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18197/health' -Headers @{Authorization="Bearer $token"} -TimeoutSec 3 } catch { }
        if ($null -eq $health) {
            if ($worker -and -not $worker.HasExited) { Start-Sleep -Seconds 5; continue }
            if (Get-NetTCPConnection -State Listen -LocalPort 18197 -ErrorAction SilentlyContinue) { throw 'Validation port occupied; refusing replacement' }
            $worker = Start-Process -FilePath $python -ArgumentList @('-u', ('"'+$root+'/service.py"'), '--token-file', ('"'+$tokenFile+'"'), '--config', ('"'+$runtime+'/runtime.json"')) -WindowStyle Hidden -PassThru -WorkingDirectory $root -RedirectStandardOutput ($runtime+'/stdout.log') -RedirectStandardError ($runtime+'/stderr.log')
            Start-Sleep -Seconds 5; continue
        }
        if ($health.contract -ne 'vf-native-motion-validation-20261031-v1') { throw 'Validation contract mismatch' }
        Invoke-HealthChannelCycle $state
        Start-Sleep -Seconds 5
    }
} finally {
    Stop-OwnedHealthTunnel $state
    $mutex.ReleaseMutex();$mutex.Dispose()
}
