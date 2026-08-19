[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:USERPROFILE '.codexpro')
)

$ErrorActionPreference = 'Stop'

$configRoot = Join-Path $InstallRoot 'config'
$tokenFile = Join-Path $InstallRoot 'secrets\codexpro-tailscale-token.txt'
$logRoot = Join-Path $InstallRoot 'logs'
$logFile = Join-Path $logRoot 'codexpro-tailscale-autostart.log'

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

function Read-RequiredSetting([string]$Name) {
  $path = Join-Path $configRoot "$Name.txt"
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing launcher setting: $path"
  }
  $value = (Get-Content -Raw -LiteralPath $path).Trim()
  if (-not $value) {
    throw "Launcher setting is empty: $path"
  }
  return $value
}

function Write-StartupLog([string]$Message) {
  Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "$(Get-Date -Format o) $Message"
}

$codexProRoot = Read-RequiredSetting 'codexpro-root'
$workspaceRoot = Read-RequiredSetting 'workspace-root'
$hostname = Read-RequiredSetting 'hostname'
$tailscaleExe = Read-RequiredSetting 'tailscale-exe'
$port = [int](Read-RequiredSetting 'port')
$codexProEntry = Join-Path $codexProRoot 'scripts\codexpro.mjs'

$launcherMutex = [Threading.Mutex]::new($false, "Global\CodexProV4TailscaleLauncher-$port")
if (-not $launcherMutex.WaitOne(0, $false)) {
  exit 0
}

function Test-CodexProListener {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

function Stop-CodexProProcessTree([int]$ProcessId) {
  try {
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
  } catch {
    Write-StartupLog "Process-tree cleanup warning for PID ${ProcessId}: $($_.Exception.Message)"
  }
}

while ($true) {
  try {
    if (-not (Test-Path -LiteralPath $codexProEntry)) {
      throw "CodexPro entry not found: $codexProEntry"
    }
    if (-not (Test-Path -LiteralPath $tailscaleExe)) {
      throw "Tailscale executable not found: $tailscaleExe"
    }
    if (-not (Test-Path -LiteralPath $tokenFile)) {
      throw "CodexPro token file not found: $tokenFile"
    }

    $tailscaleIp = & $tailscaleExe ip -4 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $tailscaleIp) {
      Write-StartupLog 'Waiting for Tailscale to become online.'
      Start-Sleep -Seconds 10
      continue
    }

    if (Test-CodexProListener) {
      Write-StartupLog "Port $port is already in use; retrying later."
      Start-Sleep -Seconds 15
      continue
    }

    $token = (Get-Content -Raw -LiteralPath $tokenFile).Trim()
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdoutLog = Join-Path $logRoot "codexprov4-$stamp.out.log"
    $stderrLog = Join-Path $logRoot "codexprov4-$stamp.err.log"
    $arguments = @(
      "`"$codexProEntry`""
      'tailscale'
      "--root=$workspaceRoot"
      "--port=$port"
      "--hostname=$hostname"
      "--token=$token"
      "--tailscale=`"$tailscaleExe`""
      '--bash=full'
    )

    Write-StartupLog "Starting CodexProV4 on port $port with Tailscale Funnel."
    $codexProProcess = Start-Process `
      -FilePath $nodeExe `
      -ArgumentList $arguments `
      -WorkingDirectory $codexProRoot `
      -NoNewWindow `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog `
      -PassThru

    $startupDeadline = (Get-Date).AddSeconds(45)
    while (-not $codexProProcess.HasExited -and -not (Test-CodexProListener) -and (Get-Date) -lt $startupDeadline) {
      Start-Sleep -Seconds 1
      $codexProProcess.Refresh()
    }

    if (-not (Test-CodexProListener)) {
      $reason = if ($codexProProcess.HasExited) {
        "launcher exited with code $($codexProProcess.ExitCode)"
      } else {
        'startup timed out before the HTTP listener appeared'
      }
      Write-StartupLog "CodexProV4 failed to start: $reason. stdout=$stdoutLog stderr=$stderrLog"
      if (-not $codexProProcess.HasExited) {
        Stop-CodexProProcessTree $codexProProcess.Id
      }
      Start-Sleep -Seconds 10
      continue
    }

    Write-StartupLog "CodexProV4 is listening on port $port (launcher PID $($codexProProcess.Id))."
    $missedListenerChecks = 0
    $restartRequested = $false
    while (-not $codexProProcess.HasExited) {
      Start-Sleep -Seconds 3
      $codexProProcess.Refresh()
      if (Test-CodexProListener) {
        $missedListenerChecks = 0
      } else {
        $missedListenerChecks += 1
        if ($missedListenerChecks -ge 3) {
          Write-StartupLog "Port $port disappeared while the launcher was still running; restarting its process tree."
          Stop-CodexProProcessTree $codexProProcess.Id
          $restartRequested = $true
          break
        }
      }
    }

    if (-not $restartRequested -and $codexProProcess.HasExited) {
      Write-StartupLog "CodexProV4 launcher exited with code $($codexProProcess.ExitCode); retrying."
    }
  } catch {
    Write-StartupLog "Startup error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 10
}
