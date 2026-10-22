param(
  [string]$ZipPath = "",
  [string]$OutputPath = "",
  [string]$PortableVersion = ""
)

# Builds the single-file executable: a small bootstrap with the portable ZIP appended.
# Layout: [bootstrap PE][zip][header JSON][int64 zipLength][int64 headerLength]["PIWEBPK1"]
$ErrorActionPreference = "Stop"
$sourceDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $ZipPath) { $ZipPath = Join-Path $sourceDir "portable\dist\pi-web-portable-win-x64.zip" }
if (-not $OutputPath) { $OutputPath = Join-Path $sourceDir "portable\dist\Pi-Web-Portable-win-x64.exe" }
$ZipPath = [IO.Path]::GetFullPath($ZipPath)
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath $ZipPath)) { throw "Portable ZIP not found: $ZipPath" }

Add-Type -AssemblyName System.IO.Compression.FileSystem
if (-not $PortableVersion) {
  $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    $entry = $zip.GetEntry("portable-manifest.json")
    if (-not $entry) { throw "portable-manifest.json missing from $ZipPath" }
    $reader = New-Object IO.StreamReader($entry.Open())
    try { $PortableVersion = ($reader.ReadToEnd() | ConvertFrom-Json).portableVersion } finally { $reader.Dispose() }
  } finally { $zip.Dispose() }
}
if ($PortableVersion -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid portable version: $PortableVersion" }

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path -LiteralPath $csc)) { throw "Windows C# compiler not found: $csc" }
$frameworkDir = Split-Path -Parent $csc

$bootstrap = Join-Path ([IO.Path]::GetTempPath()) ("pi-web-bootstrap-" + [guid]::NewGuid().ToString("N") + ".exe")
$compilerArgs = @(
  "/nologo", "/target:winexe", "/platform:x64", "/optimize+", "/langversion:5", "/out:$bootstrap",
  "/r:$(Join-Path $frameworkDir 'System.dll')",
  "/r:$(Join-Path $frameworkDir 'System.Core.dll')",
  "/r:$(Join-Path $frameworkDir 'System.IO.Compression.dll')",
  "/r:$(Join-Path $frameworkDir 'System.IO.Compression.FileSystem.dll')",
  "/r:$(Join-Path $frameworkDir 'System.Drawing.dll')",
  "/r:$(Join-Path $frameworkDir 'System.Windows.Forms.dll')"
)
$iconPath = Join-Path $sourceDir "portable\assets\pi-agent-icon.ico"
if (Test-Path -LiteralPath $iconPath) { $compilerArgs += "/win32icon:$iconPath" }
$compilerArgs += (Join-Path $sourceDir "portable\bootstrap\SingleExe.cs")
& $csc @compilerArgs
if ($LASTEXITCODE -ne 0) { throw "Single-exe bootstrap compilation failed: $LASTEXITCODE" }
$global:LASTEXITCODE = 0

$zipHash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$zipLength = (Get-Item -LiteralPath $ZipPath).Length
$header = [Text.Encoding]::UTF8.GetBytes((@{ portableVersion = $PortableVersion; sha256 = $zipHash } | ConvertTo-Json -Compress))

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
$pending = $OutputPath + ".pending.exe"
$out = [IO.File]::Create($pending)
try {
  foreach ($part in @($bootstrap, $ZipPath)) {
    $in = [IO.File]::OpenRead($part)
    try { $in.CopyTo($out, 1MB) } finally { $in.Dispose() }
  }
  $out.Write($header, 0, $header.Length)
  $writer = New-Object IO.BinaryWriter($out)
  $writer.Write([int64]$zipLength)
  $writer.Write([int64]$header.Length)
  $writer.Write([Text.Encoding]::ASCII.GetBytes("PIWEBPK1"))
  $writer.Flush()
} finally { $out.Dispose() }
Remove-Item -LiteralPath $bootstrap -Force

$check = Start-Process -FilePath $pending -ArgumentList @("--payload-version", "--non-interactive") -Wait -PassThru -WindowStyle Hidden
if ($check.ExitCode -ne 0) { throw "Single-exe payload check failed: $($check.ExitCode)" }
if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
Move-Item -LiteralPath $pending -Destination $OutputPath
$exeName = Split-Path -Leaf $OutputPath
$exeHash = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath ($OutputPath + ".sha256") -Value ("$exeHash  $exeName") -Encoding ASCII

[pscustomobject]@{
  Executable = $OutputPath
  PortableVersion = $PortableVersion
  Size = (Get-Item -LiteralPath $OutputPath).Length
  Sha256 = $exeHash
} | Format-List
$global:LASTEXITCODE = 0
