param(
  [Parameter(Mandatory = $false)]
  [string]$PidFile = "$PSScriptRoot\host_side_ping.pid",

  [Parameter(Mandatory = $false)]
  [int]$TimeoutSec = 5
)

$ErrorActionPreference = "Stop"

function Stop-ProcessGracefully {
  param(
    [int]$ProcessId,
    [int]$TimeoutSec = 5
  )

  if ($ProcessId -le 0) { return $false }
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }

  try {
    $null = $proc.CloseMainWindow()
  } catch {
    # ignore
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $alive = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $alive) { return $true }
    Start-Sleep -Milliseconds 200
  }

  Stop-Process -Id $ProcessId -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
  $stillAlive = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($stillAlive) {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }

  return -not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

if (-not (Test-Path -LiteralPath $PidFile)) {
  Write-Output "stopped reason=no_pid_file"
  exit 0
}

$pidRaw = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
$targetPid = 0
if (-not [int]::TryParse($pidRaw, [ref]$targetPid) -or $targetPid -le 0) {
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Write-Output "stopped reason=invalid_pid_file"
  exit 0
}

$stopped = Stop-ProcessGracefully -ProcessId $targetPid -TimeoutSec $TimeoutSec
Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue

if ($stopped) {
  Write-Output "stopped pid=$targetPid"
  exit 0
}

Write-Output "stopped reason=process_not_found pid=$targetPid"
exit 0
