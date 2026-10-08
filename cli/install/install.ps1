# Installs the `trama` CLI on Windows. Verifies the download against the release's SHA256SUMS.
#
#   irm https://raw.githubusercontent.com/alessandrobrunoh/trama/main/cli/install/install.ps1 | iex
#
# Environment:
#   TRAMA_VERSION      version to install, e.g. 0.1.0 (default: the latest stable CLI release)
#   TRAMA_INSTALL_DIR  where to put trama.exe (default: %LOCALAPPDATA%\Programs\trama)
#   TRAMA_REPO         GitHub repository (default: alessandrobrunoh/trama)
#   TRAMA_RELEASE_BASE URL of a directory that holds the release assets (mirrors, testing)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail($message) { Write-Error "install: $message"; exit 1 }

$repo = if ($env:TRAMA_REPO) { $env:TRAMA_REPO } else { 'alessandrobrunoh/trama' }
$installDir = if ($env:TRAMA_INSTALL_DIR) { $env:TRAMA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\trama' }

$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
switch ($arch) {
  'X64'   { $archPart = 'x86_64' }
  'Arm64' { $archPart = 'aarch64' }
  default { Fail "unsupported CPU '$arch'" }
}
$target = "$archPart-pc-windows-msvc"
$asset = "trama-$target.exe"

$version = $env:TRAMA_VERSION
if (-not $version) {
  Write-Host 'Looking for the latest release...'
  $releases = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=50"
  # Stable CLI tags only: cli-v1.2.3 (no -rc suffixes).
  $latest = $releases | Where-Object { $_.tag_name -match '^cli-v\d+\.\d+\.\d+$' -and -not $_.draft } | Select-Object -First 1
  if (-not $latest) { Fail "could not find a CLI release in $repo (set TRAMA_VERSION)" }
  $version = $latest.tag_name.Substring(5)
}
$version = $version.TrimStart('v')

$base = if ($env:TRAMA_RELEASE_BASE) { $env:TRAMA_RELEASE_BASE } else { "https://github.com/$repo/releases/download/cli-v$version" }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("trama-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading trama ${version} for ${target}..."
  try { Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $tmp $asset) } catch { Fail "no build for $target in release $version" }
  try { Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS') } catch { Fail "release $version has no SHA256SUMS; refusing to install an unverified binary" }

  $line = Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match "\s\*?$([regex]::Escape($asset))$" } | Select-Object -First 1
  if (-not $line) { Fail "SHA256SUMS does not list $asset" }
  $expected = ($line -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { Fail "checksum mismatch (expected $expected, got $actual); nothing was installed" }

  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  $dest = Join-Path $installDir 'trama.exe'
  # A running trama.exe can be renamed but not overwritten.
  if (Test-Path $dest) { Move-Item $dest "$dest.old" -Force }
  Move-Item (Join-Path $tmp $asset) $dest -Force
  Remove-Item "$dest.old" -Force -ErrorAction SilentlyContinue
}
finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Installed $dest"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $installDir) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $installDir), 'User')
  Write-Host "Added $installDir to your PATH. Open a new terminal to use it."
}
Write-Host 'Next:  trama login      (then `trama skill install` so your coding agent learns it)'
