param(
  [Parameter(Mandatory = $true)][string]$PackageDir,
  [Parameter(Mandatory = $true)][string]$ArchivePath,
  [Parameter(Mandatory = $true)][string]$ChecksumPath,
  [string]$PreviousArchive = "",
  [ValidateRange(1, 65535)][int]$Port = 30143
)

$ErrorActionPreference = "Stop"
$package = (Resolve-Path -LiteralPath $PackageDir).Path
$archive = (Resolve-Path -LiteralPath $ArchivePath).Path
$checksum = (Resolve-Path -LiteralPath $ChecksumPath).Path
$expectedHash = [regex]::Match((Get-Content -Raw -LiteralPath $checksum), '[a-fA-F0-9]{64}').Value
if (-not $expectedHash -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $expectedHash) {
  throw "Release checksum failed before the update test"
}

# Short paths exercise .NET's real extraction/copy path without MAX_PATH noise
# caused by the test harness itself. This directory is always uniquely ours.
$testRoot = Join-Path ([IO.Path]::GetPathRoot($package)) ("pwu-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
$target = Join-Path $testRoot "old"
$helper = Join-Path $testRoot "updater.exe"
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $sourceArchive = if ($PreviousArchive) { (Resolve-Path -LiteralPath $PreviousArchive).Path } else { $archive }
  [IO.Compression.ZipFile]::ExtractToDirectory($sourceArchive, $target)
  New-Item -ItemType Directory -Force -Path (Join-Path $target "data"), (Join-Path $target "logs") | Out-Null
  $userData = Join-Path $target "data\update-test-user-data.txt"
  Set-Content -LiteralPath $userData -Value "keep-this-user-data" -Encoding ASCII
  $oldOnly = Join-Path $target "app\obsolete-update-test.txt"
  Set-Content -LiteralPath $oldOnly -Value "must-not-survive-replacement" -Encoding ASCII
  $oldManifest = Get-Content -LiteralPath (Join-Path $target "portable-manifest.json") -Raw | ConvertFrom-Json
  $oldManifest.portableVersion = "1.2.0"
  $oldManifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target "portable-manifest.json") -Encoding UTF8
  Copy-Item -LiteralPath (Join-Path $package "Pi-Web-Portable.exe") -Destination $helper
  $arguments = '--apply-update --target "{0}" --archive "{1}" --preserve-archive --non-interactive --port {2}' -f $target, $archive, $Port
  $update = Start-Process -FilePath $helper -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if (-not $update.WaitForExit(180000)) {
    Stop-Process -Id $update.Id -Force
    throw "Updater timed out"
  }
  if ($update.ExitCode -ne 0) {
    $details = Get-Content -LiteralPath (Join-Path $target "logs\launcher.log") -Tail 30 -ErrorAction SilentlyContinue
    throw "Updater failed with exit $($update.ExitCode): $details"
  }
  $installed = Get-Content -LiteralPath (Join-Path $target "portable-manifest.json") -Raw | ConvertFrom-Json
  $expected = Get-Content -LiteralPath (Join-Path $package "portable-manifest.json") -Raw | ConvertFrom-Json
  if ($installed.portableVersion -ne $expected.portableVersion -or $installed.appVersion -ne $expected.appVersion) {
    throw "Installed versions do not match the release"
  }
  if ((Get-Content -LiteralPath $userData -Raw).Trim() -ne "keep-this-user-data") { throw "Update changed user data" }
  if (Test-Path -LiteralPath $oldOnly) { throw "Obsolete application files survived replacement" }
  $launcher = Join-Path $target "Pi-Web-Portable.exe"
  $selfTest = Start-Process -FilePath $launcher -ArgumentList @("--self-test", "--non-interactive") -WindowStyle Hidden -Wait -PassThru
  if ($selfTest.ExitCode -ne 0) { throw "Updated package self-test failed" }
  & (Join-Path $PSScriptRoot "test-portable.ps1") -PackageDir $target -Port $Port
  Write-Host "Portable upgrade passed: $($oldManifest.portableVersion) -> $($installed.portableVersion), app $($installed.appVersion), user data preserved."
}
finally {
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $expectedParent = [IO.Path]::GetPathRoot($package)
  if ([IO.Path]::GetDirectoryName($resolvedTestRoot).TrimEnd('\') -ine $expectedParent.TrimEnd('\') -or
      [IO.Path]::GetFileName($resolvedTestRoot) -notmatch '^pwu-[a-f0-9]{6}$') {
    throw "Refusing to remove unexpected test directory"
  }
  Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
}
