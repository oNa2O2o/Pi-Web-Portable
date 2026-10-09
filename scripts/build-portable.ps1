param(
  [string]$OutputDir = "",
  [string]$Repository = "oNa2O2o/Pi-Web-Portable",
  [string]$PortableVersion = "1.2.0",
  [string]$RuntimeDir = "",
  [string]$ArchiveDir = "",
  [switch]$SkipBuild,
  [switch]$SkipInstall,
  [switch]$ReuseStage
)

$ErrorActionPreference = "Stop"

$sourceDir = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $sourceDir "portable\dist\Pi-web-portable"
}
if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) { throw "Node.js was not found. Pass -RuntimeDir explicitly." }
  $RuntimeDir = Split-Path -Parent $nodeCommand.Source
}
if ([string]::IsNullOrWhiteSpace($ArchiveDir)) {
  $ArchiveDir = Join-Path $sourceDir "portable\dist"
}
$runtimeDir = $RuntimeDir
$nodeExe = Join-Path $runtimeDir "node.exe"
$npmCmd = Join-Path $runtimeDir "npm.cmd"
$stageDir = Join-Path $sourceDir "portable\.build-stage"
$stageApp = Join-Path $stageDir "app"
$launcherSource = Join-Path $sourceDir "portable\launcher\Program.cs"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $csc)) {
  $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
$frameworkDir = Split-Path -Parent $csc
$portableExeName = "Pi-Web-Portable.exe"
$assetName = "pi-web-portable-win-x64.zip"

function Invoke-Robocopy([string]$from, [string]$to, [string[]]$extra) {
  & robocopy.exe $from $to /E /NFL /NDL /NJH /NJS /NP @extra | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "robocopy failed: $from -> $to (exit $LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
}

function Remove-ExactDirectory([string]$path) {
  if (Test-Path -LiteralPath $path) {
    $resolved = (Resolve-Path -LiteralPath $path).Path
    $allowedStage = [IO.Path]::GetFullPath((Join-Path $sourceDir "portable\.build-stage"))
    $allowedLogs = [IO.Path]::GetFullPath((Join-Path $OutputDir "logs"))
    $allowedStageBuild = [IO.Path]::GetFullPath((Join-Path $stageApp ".next"))
    if ($resolved -ine $allowedStage -and $resolved -ine $allowedLogs -and $resolved -ine $allowedStageBuild) { throw "Refusing to remove unexpected directory: $resolved" }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

if (-not (Test-Path -LiteralPath $nodeExe)) { throw "Bundled Node.js not found: $nodeExe" }
if (-not (Test-Path -LiteralPath $csc)) { throw "Windows C# compiler not found: $csc" }
if (-not (Test-Path -LiteralPath $launcherSource)) { throw "Launcher source not found: $launcherSource" }
if ((-not $SkipBuild -or (-not $ReuseStage -and -not $SkipInstall)) -and -not (Test-Path -LiteralPath $npmCmd)) {
  throw "npm.cmd not found: $npmCmd"
}
if ($PortableVersion -notmatch '^\d+\.\d+\.\d+$') { throw "PortableVersion must use x.y.z format: $PortableVersion" }
if ($Repository -notmatch '^[^/]+/[^/]+$') { throw "Repository must use owner/name format: $Repository" }

$package = Get-Content -Raw -LiteralPath (Join-Path $sourceDir "package.json") | ConvertFrom-Json
$appVersion = [string]$package.version

if (-not $SkipBuild) {
  $tempDir = Join-Path $sourceDir ".build-home\portable-tmp"
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
  $env:PATH = "$runtimeDir;$env:PATH"
  $env:TEMP = $tempDir
  $env:TMP = $tempDir
  $env:NEXT_TELEMETRY_DISABLED = "1"
  $env:NODE_OPTIONS = "--max-old-space-size=6144"
  & $npmCmd run build:portable
  if ($LASTEXITCODE -ne 0) { throw "Portable production build failed: $LASTEXITCODE" }
}

$buildMarker = Join-Path $sourceDir ".next\BUILD_ID"
if (-not (Test-Path -LiteralPath $buildMarker)) { throw "Production build marker missing: $buildMarker" }

if (-not $ReuseStage) {
  Remove-ExactDirectory $stageDir
  New-Item -ItemType Directory -Force -Path $stageApp | Out-Null

  foreach ($name in @("package.json", "package-lock.json", "next.config.ts")) {
    Copy-Item -LiteralPath (Join-Path $sourceDir $name) -Destination (Join-Path $stageApp $name) -Force
  }
  Invoke-Robocopy (Join-Path $sourceDir "bin") (Join-Path $stageApp "bin") @()
  Invoke-Robocopy (Join-Path $sourceDir "scripts") (Join-Path $stageApp "scripts") @()
  Invoke-Robocopy (Join-Path $sourceDir "public") (Join-Path $stageApp "public") @()
  $nextDir = Join-Path $sourceDir ".next"
  Invoke-Robocopy $nextDir (Join-Path $stageApp ".next") @(
    "/XD",
    (Join-Path $nextDir "cache"),
    (Join-Path $nextDir "dev")
  )

  if (-not $SkipInstall) {
    Push-Location $stageApp
    try {
      $env:PATH = "$runtimeDir;$env:PATH"
      & $npmCmd ci --omit=dev --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "Portable production dependency install failed: $LASTEXITCODE" }
    }
    finally { Pop-Location }
  }
}
elseif (-not (Test-Path -LiteralPath (Join-Path $stageApp "node_modules"))) {
  throw "Cannot reuse stage because production dependencies are missing: $stageApp"
}
else {
  # Reuse dependency installation, but always package the current build.
  Remove-ExactDirectory (Join-Path $stageApp ".next")
  foreach ($name in @("package.json", "package-lock.json", "next.config.ts")) {
    Copy-Item -LiteralPath (Join-Path $sourceDir $name) -Destination (Join-Path $stageApp $name) -Force
  }
  foreach ($name in @("bin", "scripts", "public")) {
    Invoke-Robocopy (Join-Path $sourceDir $name) (Join-Path $stageApp $name) @()
  }
  $nextDir = Join-Path $sourceDir ".next"
  Invoke-Robocopy $nextDir (Join-Path $stageApp ".next") @("/XD", (Join-Path $nextDir "cache"), (Join-Path $nextDir "dev"))
}

New-Item -ItemType Directory -Force -Path (Join-Path $stageDir "runtime") | Out-Null
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $stageDir "runtime\node.exe") -Force
$sourceIcon = Join-Path $sourceDir "portable\assets\pi-agent-icon.ico"
if (Test-Path -LiteralPath $sourceIcon) {
  Copy-Item -LiteralPath $sourceIcon -Destination (Join-Path $stageDir "pi-agent-icon.ico") -Force
}

$manifest = [ordered]@{
  portableVersion = $PortableVersion
  appVersion = $appVersion
  repository = $Repository
  assetName = $assetName
  autoUpdate = $true
  updateCheckHours = 6
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stageDir "portable-manifest.json") -Encoding UTF8

@"
Pi Web Windows 便携版

双击 Pi-Web-Portable.exe 即可启动本地服务并打开浏览器。
用户设置、API Key 和会话仍保存在 Windows 的 Pi 用户目录，不会打包进便携版。
启动器会从 GitHub Releases 检查更新，并在 SHA256 校验通过后才安装。
设置 > 常规 > 会话命名：从已有模型列表选择独立的命名模型。
首条实际需求只自动命名一次，最多 12 字符，并保留 KR/EN/JP 等地区标注。

命令：
  Pi-Web-Portable.exe --self-test
  Pi-Web-Portable.exe --check-update
  Pi-Web-Portable.exe --verify-update
  Pi-Web-Portable.exe --stop
"@ | Set-Content -LiteralPath (Join-Path $stageDir "README.txt") -Encoding UTF8

$launcherOutput = Join-Path $stageDir $portableExeName
$compilerArgs = @(
  "/nologo",
  "/target:winexe",
  "/platform:x64",
  "/optimize+",
  "/langversion:5",
  "/out:$launcherOutput",
  "/r:$(Join-Path $frameworkDir 'System.dll')",
  "/r:$(Join-Path $frameworkDir 'System.Core.dll')",
  "/r:$(Join-Path $frameworkDir 'System.Net.Http.dll')",
  "/r:$(Join-Path $frameworkDir 'System.IO.Compression.dll')",
  "/r:$(Join-Path $frameworkDir 'System.IO.Compression.FileSystem.dll')",
  "/r:$(Join-Path $frameworkDir 'System.Web.Extensions.dll')",
  "/r:$(Join-Path $frameworkDir 'System.Windows.Forms.dll')"
)
$iconPath = Join-Path $stageDir "pi-agent-icon.ico"
if (Test-Path -LiteralPath $iconPath) { $compilerArgs += "/win32icon:$iconPath" }
$compilerArgs += $launcherSource
& $csc @compilerArgs
if ($LASTEXITCODE -ne 0) { throw "Portable launcher compilation failed: $LASTEXITCODE" }
$global:LASTEXITCODE = 0

if (Test-Path -LiteralPath $OutputDir) {
  $existing = Get-ChildItem -LiteralPath $OutputDir -Force -ErrorAction SilentlyContinue
  if ($existing) {
    $backup = "$OutputDir.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
    $resolvedOutput = (Resolve-Path -LiteralPath $OutputDir).Path
    $expectedOutput = [IO.Path]::GetFullPath($OutputDir)
    if ($resolvedOutput -ine $expectedOutput -or $resolvedOutput -ieq $sourceDir -or $resolvedOutput -ieq [IO.Path]::GetPathRoot($resolvedOutput)) { throw "Unsafe package output path" }
    Move-Item -LiteralPath $resolvedOutput -Destination $backup
    Write-Host "Existing package moved to $backup"
  }
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
Invoke-Robocopy $stageDir $OutputDir @()

$outputExe = Join-Path $OutputDir $portableExeName
$selfTestProcess = Start-Process -FilePath $outputExe -ArgumentList @("--self-test") -WindowStyle Hidden -Wait -PassThru
if ($selfTestProcess.ExitCode -ne 0) { throw "Portable self-test failed: $($selfTestProcess.ExitCode)" }
Remove-ExactDirectory (Join-Path $OutputDir "logs")

New-Item -ItemType Directory -Force -Path $ArchiveDir | Out-Null
$zipPath = Join-Path $ArchiveDir $assetName
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $OutputDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath ($zipPath + ".sha256") -Value ("$hash  $assetName") -Encoding ASCII

[pscustomobject]@{
  OutputDir = $OutputDir
  Executable = $outputExe
  AppVersion = $appVersion
  PortableVersion = $PortableVersion
  Zip = $zipPath
  Sha256 = $hash
} | Format-List
$global:LASTEXITCODE = 0
