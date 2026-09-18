[CmdletBinding()]
param(
    [string]$DownloadUrl = $env:ROWCALL_DOWNLOAD_URL,
    [string]$InstallDir = $env:ROWCALL_INSTALL_DIR,
    [string]$Version = $env:ROWCALL_VERSION,
    [string]$ReleaseBase = $env:ROWCALL_RELEASE_BASE
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'This installer requires Windows.' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Rowcall requires 64-bit Windows.' }
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Rowcall\bin' }
if (-not $Version) { $Version = 'latest' }
if (-not $ReleaseBase) { $ReleaseBase = 'https://releases.rowcall.io' }
$asset = 'rowcall-windows-x64.exe'
if (-not $DownloadUrl) { $DownloadUrl = "$($ReleaseBase.TrimEnd('/'))/$Version/$asset" }
Write-Host 'Rowcall Windows x64 beta requires Python 3.10 or newer.'
Write-Host 'Close Rowcall before installing or updating. Open only Python documents you trust.'

function Download-File([string]$Url, [string]$Destination) {
    $uri = [Uri]$Url
    if ($uri.IsFile) { Copy-Item -LiteralPath $uri.LocalPath -Destination $Destination }
    else {
        if ($uri.Scheme -ne 'https') { throw 'Downloads must use HTTPS.' }
        Invoke-WebRequest -Uri $uri -OutFile $Destination -UseBasicParsing
    }
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ('rowcall-install-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $download = Join-Path $temp $asset
    Download-File $DownloadUrl $download
    Download-File "$DownloadUrl.sha256" "$download.sha256"
    $checksum = (Get-Content -LiteralPath "$download.sha256" -Raw).Trim()
    if ($checksum -notmatch '^([a-fA-F0-9]{64})\s+\*?rowcall-windows-x64\.exe$') { throw 'Invalid checksum file.' }
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $Matches[1]) { throw 'Checksum mismatch.' }
    & $download --version
    if ($LASTEXITCODE -ne 0) { throw 'Downloaded Rowcall failed its version check.' }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $destination = Join-Path $InstallDir 'rowcall.exe'
    Copy-Item -LiteralPath $download -Destination $destination -Force
    Write-Host "Installed Rowcall to $destination"
    # Do not silently change the user's persistent PATH.
    Write-Host "Run with: & '$destination' example my-work --open"
    Write-Host "To use 'rowcall' from any terminal, add $InstallDir to your user PATH."
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force
}
