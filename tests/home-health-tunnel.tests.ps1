$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '../home-health-tunnel/supervisor.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'PowerShell syntax errors' }
$functions = $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]}, $true)
$cycle = $functions | Where-Object Name -eq 'Invoke-HealthChannelCycle'
if (-not $cycle) { throw 'Missing retryable health-channel cycle' }
. ([scriptblock]::Create($cycle.Extent.Text))
function Assert($ok, $message) { if (-not $ok) { throw $message } }
$script:calls = [Collections.Generic.List[string]]::new()
$script:failPrepare = $false; $script:failVerify = $false; $script:exited = $false
function Invoke-RemoteHealth($mode) {
    $script:calls.Add($mode)
    if (($mode -eq 'prepare' -and $script:failPrepare) -or ($mode -eq 'verify' -and $script:failVerify)) { throw 'temporary SSH failure' }
}
function Start-HealthTunnel { $script:calls.Add('start'); return [pscustomobject]@{HasExited=$script:exited;Id=123} }
function Stop-OwnedHealthTunnel($state) { $script:calls.Add('stop'); $state.Tunnel=$null }
function Write-HealthNote($message) { $script:calls.Add('log') }
function Start-Sleep { }

$s = [pscustomobject]@{Tunnel=$null}
$script:failPrepare=$true
Invoke-HealthChannelCycle $s
Assert ($null -eq $s.Tunnel) 'Preflight error must remain retryable'
$script:failPrepare=$false
Invoke-HealthChannelCycle $s
Assert ($null -ne $s.Tunnel) 'Next cycle must reconnect after a transient error'
Assert (($script:calls | Where-Object {$_ -eq 'start'}).Count -eq 1) 'No duplicate start'
$count=$script:calls.Count
Invoke-HealthChannelCycle $s
Assert ($script:calls.Count -eq $count) 'Live owned tunnel must not be replaced'

$s.Tunnel=$null; $script:failVerify=$true
Invoke-HealthChannelCycle $s
Assert ($null -eq $s.Tunnel) 'Failed permission verification must clean up owned child'
$script:failVerify=$false
Invoke-HealthChannelCycle $s
Assert ($null -ne $s.Tunnel) 'Verification failure must not terminate supervisor'

$s.Tunnel=$null; $script:exited=$true
Invoke-HealthChannelCycle $s
Assert ($null -eq $s.Tunnel) 'Exited SSH child must not be accepted'
. ([scriptblock]::Create(($functions | Where-Object Name -eq 'Invoke-RemoteHealth').Extent.Text))
function Start-Process {
    Microsoft.PowerShell.Management\Start-Process -FilePath 'C:/Windows/System32/cmd.exe' -ArgumentList '/c exit 0' -PassThru -WindowStyle Hidden -RedirectStandardOutput ($runtime+'/vf-health-process-test-'+$PID+'.stdout') -RedirectStandardError ($runtime+'/vf-health-process-test-'+$PID+'.stderr')
}
$runtime=$env:TEMP; $key='unused-test-key'; $remoteGroup='health'
try { Invoke-RemoteHealth 'prepare' }
finally {
    Remove-Item -LiteralPath ($runtime+'/vf-health-process-test-'+$PID+'.stdout'),($runtime+'/vf-health-process-test-'+$PID+'.stderr') -ErrorAction SilentlyContinue
}
Write-Output 'PASS: 7 health-channel retry/ownership/real-process assertions'
