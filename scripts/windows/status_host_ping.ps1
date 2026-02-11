param(
  [Parameter(Mandatory = $false)]
  [string]$PidFile = "$PSScriptRoot\host_side_ping.pid"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PidFile)) {
  Write-Output "stopped"
  exit 0
}

$pidRaw = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
$targetPid = 0
if (-not [int]::TryParse($pidRaw, [ref]$targetPid) -or $targetPid -le 0) {
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Write-Output "stopped reason=invalid_pid_file"
  exit 0
}

$proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if ($proc) {
  Write-Output "running pid=$targetPid"
  exit 0
}

Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
Write-Output "stopped reason=stale_pid_file"
exit 0
