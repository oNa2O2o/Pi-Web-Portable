param(
  [Parameter(Mandatory = $true)][string]$PreviousArchive,
  [string]$ExpectedVersion = "1.3.0",
  [ValidateRange(1, 65535)][int]$Port = 30147,
  [string]$ResultPath = ""
)

# Run with Windows PowerShell 5.1: the released launcher uses .NET Framework.
# Invoke the shipping launcher's unchanged discovery/download methods directly
# to bypass only the confirmation dialog. Installation uses its actual EXE.
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSEdition -ne "Desktop") {
  throw "Run this test with powershell.exe (.NET Framework), not pwsh.exe."
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  throw "Test port $Port is occupied."
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$testRoot = Join-Path $env:SystemDrive ("pue-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$target = Join-Path $testRoot "installed"
$helper = Join-Path $testRoot "legacy-updater.exe"
$agentDir = Join-Path $testRoot "agent"
$download = $null
$oldServer = $null
$newLauncher = $null
$installer = $null
$passed = $false
$environmentNames = @("PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_WEB_SKIP_VERSION_CHECK", "PI_WEB_NO_OPEN", "NEXT_TELEMETRY_DISABLED")
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

function Wait-ForApplication([Diagnostics.Process]$process, [string]$version) {
  $deadline = [DateTime]::UtcNow.AddSeconds(180)
  do {
    if ($process.HasExited) { throw "Test server exited: $($process.ExitCode)" }
    try {
      $page = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 3
      $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/app-update" -TimeoutSec 3
      if ($page.StatusCode -eq 200 -and $status.currentVersion -eq $version) { return }
    } catch {}
    Start-Sleep -Milliseconds 400
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Expected app $version did not become healthy on port $Port."
}

try {
  New-Item -ItemType Directory -Path $testRoot, $agentDir | Out-Null
  [IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path -LiteralPath $PreviousArchive).Path, $target)
  $oldManifest = Get-Content -LiteralPath (Join-Path $target "portable-manifest.json") -Raw | ConvertFrom-Json
  if ($oldManifest.portableVersion -eq $ExpectedVersion) { throw "The test requires an older real release." }
  $legacyExe = Join-Path $target "Pi-Web-Portable.exe"
  Copy-Item -LiteralPath $legacyExe -Destination $helper
  $legacyHash = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
  New-Item -ItemType Directory -Path (Join-Path $target "data") -Force | Out-Null
  $marker = Join-Path $target "data\preserve-during-online-update.txt"
  [IO.File]::WriteAllText($marker, "portable-user-data-must-survive")
  $markerHash = (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash

  $env:PI_CODING_AGENT_DIR = $agentDir
  $env:PI_OFFLINE = "1"
  $env:PI_WEB_SKIP_VERSION_CHECK = "1"
  $env:PI_WEB_NO_OPEN = "1"
  $env:NEXT_TELEMETRY_DISABLED = "1"
  $oldServer = Start-Process -FilePath (Join-Path $target "runtime\node.exe") `
    -ArgumentList ('"{0}" --port {1} --hostname 127.0.0.1 --no-open' -f (Join-Path $target "app\bin\pi-web.js"), $Port) `
    -WorkingDirectory (Join-Path $target "app") -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $testRoot "old.stdout.log") `
    -RedirectStandardError (Join-Path $testRoot "old.stderr.log")
  [IO.File]::WriteAllText((Join-Path $target "data\pi-web.pid"), [string]$oldServer.Id)
  Wait-ForApplication $oldServer $oldManifest.appVersion
  Write-Output "Original release is running: portable $($oldManifest.portableVersion), app $($oldManifest.appVersion)."

  $assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($helper))
  $program = $assembly.GetType("Program", $true)
  $flags = [Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static
  $manifestType = $program.GetNestedType("Manifest", [Reflection.BindingFlags]::NonPublic)
  $manifest = [Activator]::CreateInstance($manifestType, $true)
  foreach ($field in @("PortableVersion", "AppVersion", "Repository", "AssetName")) {
    $property = $field.Substring(0, 1).ToLowerInvariant() + $field.Substring(1)
    $manifestType.GetField($field).SetValue($manifest, [string]$oldManifest.$property)
  }
  $release = $program.GetMethod("GetLatestRelease", $flags).Invoke($null, @($manifest))
  if (-not $release) { throw "The original updater did not discover a published release." }
  $releaseType = $release.GetType()
  $releaseVersion = [string]$releaseType.GetField("Version").GetValue($release)
  if ($releaseVersion -ne $ExpectedVersion) {
    throw "Original updater found $releaseVersion; expected $ExpectedVersion."
  }
  $releaseUrl = [string]$releaseType.GetField("ArchiveUrl").GetValue($release)
  $download = [string]$program.GetMethod("DownloadVerifiedArchive", $flags).Invoke($null, @($release))
  $downloadHash = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
  $zip = [IO.Compression.ZipFile]::OpenRead($download)
  try {
    $entry = $zip.GetEntry("Pi-Web-Portable.exe")
    if (-not $entry) { throw "Published archive has no launcher." }
    $stream = $entry.Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $expectedLauncherHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
  }
  finally { $zip.Dispose() }
  Write-Output "Original updater downloaded and verified the published $releaseVersion archive."
  $recordedPid = [IO.File]::ReadAllText((Join-Path $target "data\pi-web.pid")).Trim()
  if ($recordedPid -ne [string]$oldServer.Id) { throw "Old server PID changed before installation: $recordedPid" }

  $installer = Start-Process -FilePath $helper `
    -ArgumentList ('--apply-update --target "{0}" --archive "{1}" --port {2} --non-interactive' -f $target, $download, $Port) `
    -WindowStyle Hidden -PassThru
  if (-not $installer.WaitForExit(300000)) { throw "Original updater did not finish installation." }
  if ($installer.ExitCode -ne 0) { throw "Original updater installation failed: $($installer.ExitCode)" }
  if (-not $oldServer.WaitForExit(10000)) {
    $remaining = Get-CimInstance Win32_Process -Filter "ProcessId=$($oldServer.Id)"
    if ($remaining) { throw "Original updater left the old server running (PID $($oldServer.Id))." }
  }
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Original updater left a process listening on port $Port."
  }
  $installed = Get-Content -LiteralPath (Join-Path $target "portable-manifest.json") -Raw | ConvertFrom-Json
  if ($installed.portableVersion -ne $ExpectedVersion) { throw "Installed portable version is wrong." }
  $installedLauncherHash = (Get-FileHash -LiteralPath $legacyExe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($installedLauncherHash -eq $legacyHash -or $installedLauncherHash -ne $expectedLauncherHash) {
    throw "Installed launcher was not replaced with the published executable."
  }
  if ((Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash -ne $markerHash) { throw "User data changed." }

  $newLauncher = Start-Process -FilePath $legacyExe `
    -ArgumentList @("--no-update", "--no-open", "--non-interactive", "--port", [string]$Port) `
    -WindowStyle Hidden -PassThru
  Wait-ForApplication $newLauncher $installed.appVersion
  $running = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/agent/running" -TimeoutSec 5
  if (@($running.runningSessionIds).Count -ne 0) { throw "Unexpected active test conversation." }
  $result = [ordered]@{
    passed = $true
    testedAt = [DateTime]::UtcNow.ToString("o")
    oldPortableVersion = $oldManifest.portableVersion
    oldAppVersion = $oldManifest.appVersion
    oldUpdaterSha256 = $legacyHash
    newPortableVersion = $installed.portableVersion
    newAppVersion = $installed.appVersion
    publishedArchive = $releaseUrl
    publishedArchiveSha256 = $downloadHash
    discovery = "original released updater"
    downloadAndChecksum = "original released updater"
    installation = "original released updater EXE"
    installedLauncherMatchesRelease = $true
    previousServerStopped = $true
    userDataPreserved = $true
    updatedApplicationHttpStatus = 200
  }
  $json = $result | ConvertTo-Json
  if ($ResultPath) { [IO.File]::WriteAllText([IO.Path]::GetFullPath($ResultPath), $json) }
  $passed = $true
  Write-Output $json
}
catch {
  Write-Output "Failed test evidence: $testRoot"
  foreach ($log in @("logs\launcher.log", "installed\logs\launcher.log", "old.stderr.log", "old.stdout.log")) {
    $path = Join-Path $testRoot $log
    if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Tail 15 }
  }
  throw
}
finally {
  if ($newLauncher) {
    $stop = Start-Process -FilePath (Join-Path $target "Pi-Web-Portable.exe") `
      -ArgumentList @("--stop", "--non-interactive") -WindowStyle Hidden -PassThru
    $stop.WaitForExit(15000) | Out-Null
    $newLauncher.WaitForExit(10000) | Out-Null
  }
  foreach ($process in @($installer, $oldServer, $newLauncher)) {
    if ($process -and -not $process.HasExited) {
      & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
    }
  }
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
  }
  if ($download -and (Test-Path -LiteralPath $download)) {
    if ([IO.Path]::GetFileName($download) -notmatch '^pi-web-portable-[a-f0-9]{32}\.zip$') {
      throw "Refusing to delete an unexpected downloaded archive."
    }
    Remove-Item -LiteralPath $download -Force
  }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  if ([IO.Path]::GetDirectoryName($resolved).TrimEnd('\') -ine $env:SystemDrive.TrimEnd('\') -or
      [IO.Path]::GetFileName($resolved) -notmatch '^pue-[a-f0-9]{8}$') {
    throw "Refusing to delete an unexpected test directory."
  }
  if ($passed -and (Test-Path -LiteralPath $resolved)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
