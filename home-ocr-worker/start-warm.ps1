$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$runtime = 'E:/VidForgeHomeBoost/home-ocr'
$python = Join-Path $runtime '.venv312/Scripts/python.exe'
$tokenFile = 'E:/VidForgeHomeBoost/vf-speed-20261002/private/pc-boost-token.txt'
$mutex = [Threading.Mutex]::new($false, 'Local\VidForgeHomeOcrWarm20261101')
try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
if (-not $ownsMutex) { exit 0 }
$warmProcess = $null
try {
    $token = [IO.File]::ReadAllText($tokenFile).Trim()
    while ($true) {
        if (Test-Path -LiteralPath (Join-Path $root 'warm-disabled')) { Start-Sleep -Seconds 3; continue }
        $primary = $null
        try { $primary = Invoke-RestMethod -Uri 'http://127.0.0.1:18196/health' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 3 } catch { }
        if ($primary.contract -ne 'vf-home-ocr-native-v1-20261029') { Start-Sleep -Seconds 3; continue }
        $warmHealth = $null
        try { $warmHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:18208/health' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 3 } catch { }
        if ($warmHealth) {
            if ($warmHealth.contract -ne 'vf-home-ocr-warm-v1-20261101') { throw 'Warm OCR contract mismatch' }
        } elseif (-not $warmProcess -or $warmProcess.HasExited) {
            $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
            if ($listeners.Port -contains 18208) { throw 'Warm OCR port occupied' }
            $warmProcess = Start-Process -FilePath $python -ArgumentList @('-u', ('"' + $root + '/warm_pool.py"'), '--token-file', ('"' + $tokenFile + '"'), '--owner-port', '18196') -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'warm.stdout.log') -RedirectStandardError (Join-Path $runtime 'warm.stderr.log')
        }
        Start-Sleep -Seconds 3
    }
} catch {
    [IO.File]::AppendAllText((Join-Path $runtime 'warm-supervisor.log'), ([DateTime]::UtcNow.ToString('o') + ' ' + $_.Exception.Message + [Environment]::NewLine))
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
