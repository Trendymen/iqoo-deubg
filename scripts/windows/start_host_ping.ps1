param(
  [Parameter(Mandatory = $true)]
  [string]$TargetIp,

  [Parameter(Mandatory = $false)]
  [int]$IntervalMs = 200,

  [Parameter(Mandatory = $true)]
  [string]$LogFile,

  [Parameter(Mandatory = $true)]
  [string]$PidFile,

  [Parameter(Mandatory = $false)]
  [string]$TzOffset = "+08:00"
)

$ErrorActionPreference = "Stop"

function Ensure-ParentDirectory {
  param([string]$PathValue)
  $parent = Split-Path -Parent $PathValue
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
}

function Stop-ProcessGracefully {
  param(
    [int]$ProcessId,
    [int]$TimeoutSec = 5
  )

  if ($ProcessId -le 0) { return }
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) { return }

  try {
    $null = $proc.CloseMainWindow()
  } catch {
    # ignore
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $alive = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $alive) { return }
    Start-Sleep -Milliseconds 200
  }

  Stop-Process -Id $ProcessId -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300

  $stillAlive = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($stillAlive) {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Get-Command nping -ErrorAction SilentlyContinue)) {
  throw "nping not found. Install Nmap first."
}

Ensure-ParentDirectory -PathValue $LogFile
Ensure-ParentDirectory -PathValue $PidFile

if (-not (Test-Path -LiteralPath $LogFile)) {
  New-Item -ItemType File -Path $LogFile -Force | Out-Null
}

if ($IntervalMs -lt 50) {
  $IntervalMs = 50
}

if (Test-Path -LiteralPath $PidFile) {
  $existingPidRaw = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $existingPid = 0
  if ([int]::TryParse($existingPidRaw, [ref]$existingPid) -and $existingPid -gt 0) {
    Stop-ProcessGracefully -ProcessId $existingPid -TimeoutSec 5
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

$workerPath = Join-Path (Split-Path -Parent $PidFile) "host_ping_worker.ps1"
$workerContent = @'
param(
  [Parameter(Mandatory = $true)]
  [string]$TargetIp,
  [Parameter(Mandatory = $true)]
  [int]$IntervalMs,
  [Parameter(Mandatory = $true)]
  [string]$LogFile
)

$ErrorActionPreference = "Continue"
$tz = [TimeZoneInfo]::FindSystemTimeZoneById("China Standard Time")

function Write-PingLine {
  param([string]$RawLine)
  if ([string]::IsNullOrWhiteSpace($RawLine)) { return }

  $nowUtc = [DateTimeOffset]::UtcNow
  $local = [TimeZoneInfo]::ConvertTime($nowUtc, $tz)
  $tsLocal = $local.ToString("yyyy-MM-dd HH:mm:ss.fff") + " +08:00"
  $epochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $line = "[ts_local=$tsLocal][epoch_ms=$epochMs][source=host_side_ping] $RawLine"
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

Write-PingLine "worker_started target=$TargetIp interval_ms=$IntervalMs"

try {
  # Keep a single long-running nping process so seq is monotonic and timing is stable.
  & nping --icmp --count 2147483647 --delay "$($IntervalMs)ms" $TargetIp 2>&1 | ForEach-Object {
    Write-PingLine $_
  }
} catch {
  Write-PingLine ("worker_error: " + $_.Exception.Message)
}
'@
Set-Content -LiteralPath $workerPath -Value $workerContent -Encoding UTF8

$child = Start-Process -FilePath "powershell.exe" -ArgumentList @(
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy", "Bypass",
  "-File", $workerPath,
  "-TargetIp", $TargetIp,
  "-IntervalMs", "$IntervalMs",
  "-LogFile", $LogFile
) -WindowStyle Hidden -PassThru

Set-Content -LiteralPath $PidFile -Value "$($child.Id)" -Encoding ASCII
Write-Output "started pid=$($child.Id) target=$TargetIp interval_ms=$IntervalMs tz_fixed=+08:00 requested_tz=$TzOffset"

try {
  Get-Content -LiteralPath $LogFile -Wait -Tail 0
} catch {
  Write-Output "tail_stopped reason=$($_.Exception.Message)"
}
