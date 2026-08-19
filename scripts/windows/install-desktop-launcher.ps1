[CmdletBinding()]
param(
  [string]$CodexProRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$WorkspaceRoot = 'D:\work',
  [Parameter(Mandatory = $true)]
  [string]$Hostname,
  [ValidateRange(1, 65535)]
  [int]$Port = 8788,
  [string]$TailscaleExe = 'C:\Program Files\Tailscale\tailscale.exe',
  [string]$DesktopRoot = [Environment]::GetFolderPath('Desktop'),
  [switch]$StartNow
)

$ErrorActionPreference = 'Stop'

$CodexProRoot = (Resolve-Path -LiteralPath $CodexProRoot).Path
$WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$entry = Join-Path $CodexProRoot 'scripts\codexpro.mjs'
if (-not (Test-Path -LiteralPath $entry)) {
  throw "CodexPro CLI entry not found: $entry"
}
if (-not (Test-Path -LiteralPath $TailscaleExe)) {
  throw "Tailscale executable not found: $TailscaleExe"
}
if ($Hostname -notmatch '^[A-Za-z0-9.-]+$') {
  throw 'Hostname may contain only letters, digits, dots, and hyphens.'
}

$installRoot = Join-Path $env:USERPROFILE '.codexpro'
$binRoot = Join-Path $installRoot 'bin'
$configRoot = Join-Path $installRoot 'config'
$secretRoot = Join-Path $installRoot 'secrets'
$runtimeRoot = Join-Path $installRoot 'runtime'
$backupRoot = Join-Path $installRoot 'backups'
$tokenFile = Join-Path $secretRoot 'codexpro-tailscale-token.txt'

New-Item -ItemType Directory -Force -Path $binRoot, $configRoot, $secretRoot, $runtimeRoot, $backupRoot | Out-Null

if (-not (Test-Path -LiteralPath $tokenFile)) {
  $secureToken = Read-Host 'Enter a stable CodexPro token (input is hidden)' -AsSecureString
  $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  try {
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    if ([string]::IsNullOrWhiteSpace($plainToken) -or $plainToken.Length -lt 16) {
      throw 'CodexPro token must contain at least 16 non-whitespace characters.'
    }
    Set-Content -LiteralPath $tokenFile -Value $plainToken.Trim() -Encoding ASCII -NoNewline
  } finally {
    if ($tokenPointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    }
    $plainToken = $null
  }
  Write-Host "Created token file: $tokenFile"
} else {
  Write-Host "Reusing existing token file: $tokenFile"
}

function Write-Setting([string]$Name, [string]$Value) {
  Set-Content -LiteralPath (Join-Path $configRoot "$Name.txt") -Value $Value -Encoding UTF8
}

Write-Setting 'codexpro-root' $CodexProRoot
Write-Setting 'workspace-root' $WorkspaceRoot
Write-Setting 'hostname' $Hostname.ToLowerInvariant()
Write-Setting 'port' ([string]$Port)
Write-Setting 'tailscale-exe' $TailscaleExe

$launcherScriptSource = Join-Path $PSScriptRoot 'start-codexprov4-tailscale.ps1'
$launcherSource = Join-Path $PSScriptRoot 'CodexProLauncher.cs'
$launcherScriptTarget = Join-Path $binRoot 'start-codexprov4-tailscale.ps1'
$launcherTarget = Join-Path $binRoot 'CodexProLauncher.cs'
Copy-Item -LiteralPath $launcherScriptSource -Destination $launcherScriptTarget -Force
Copy-Item -LiteralPath $launcherSource -Destination $launcherTarget -Force

$iconSource = Join-Path $PSScriptRoot 'codexpro-logo.ico'
$iconTarget = Join-Path $binRoot 'codexpro-logo.ico'
if (Test-Path -LiteralPath $iconSource) {
  Copy-Item -LiteralPath $iconSource -Destination $iconTarget -Force
}

$compilerCandidates = @(
  'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
  'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) {
  throw 'Windows C# compiler (csc.exe) was not found.'
}

$candidateExe = Join-Path $runtimeRoot 'CodexPro.exe'
if (Test-Path -LiteralPath $candidateExe) {
  Remove-Item -LiteralPath $candidateExe -Force
}
$compilerArgs = @(
  '/nologo',
  '/target:winexe',
  '/codepage:65001',
  "/out:$candidateExe",
  '/reference:System.Windows.Forms.dll',
  $launcherTarget
)
if (Test-Path -LiteralPath $iconTarget) {
  $compilerArgs = @('/nologo', '/target:winexe', '/codepage:65001', "/out:$candidateExe", "/win32icon:$iconTarget", '/reference:System.Windows.Forms.dll', $launcherTarget)
}

& $compiler @compilerArgs
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $candidateExe)) {
  throw "Desktop launcher compilation failed with exit code $LASTEXITCODE."
}

$desktopExe = Join-Path $DesktopRoot 'CodexPro.exe'
if (Test-Path -LiteralPath $desktopExe) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupDir = Join-Path $backupRoot "desktop-launcher-$stamp"
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Copy-Item -LiteralPath $desktopExe -Destination (Join-Path $backupDir 'CodexPro.exe')
  Write-Host "Backed up the previous desktop launcher to: $backupDir"
}
Copy-Item -LiteralPath $candidateExe -Destination $desktopExe -Force

Write-Host ''
Write-Host 'CodexProV4 desktop launcher installed.'
Write-Host "Desktop executable: $desktopExe"
Write-Host "Project root: $CodexProRoot"
Write-Host "Workspace root: $WorkspaceRoot"
Write-Host "Local port: $Port"
Write-Host "MCP URL: https://$($Hostname.ToLowerInvariant())/mcp?codexpro_token=<private-token>"

if ($StartNow) {
  Start-Process -FilePath $desktopExe
}
