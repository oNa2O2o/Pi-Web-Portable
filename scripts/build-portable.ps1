param(
  [string]$OutputDir = "",
  [string]$Repository = "oNa2O2o/Pi-Web-Portable",
  [string]$PortableVersion = "1.6.0",
  [string]$RuntimeDir = "",
  [string]$ArchiveDir = "",
  [switch]$SkipBuild,
  [switch]$SkipInstall,
  [switch]$ReuseStage,
  [switch]$CheckRuntimeOnly
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
    $allowedStagePlugins = [IO.Path]::GetFullPath((Join-Path $stageApp "plugins"))
    $allowedVoiceExtract = [IO.Path]::GetFullPath((Join-Path $sourceDir "portable\.voice-cache\extract"))
    if ($resolved -ine $allowedStage -and $resolved -ine $allowedLogs -and $resolved -ine $allowedStageBuild -and $resolved -ine $allowedStagePlugins -and $resolved -ine $allowedVoiceExtract) { throw "Refusing to remove unexpected directory: $resolved" }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

function Get-ExactNodeVersion([string]$path) {
  $versionText = (& $path --version 2>&1 | Out-String).Trim()
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { throw "Unable to read bundled Node.js version from ${path}: exit $exitCode" }
  if ($versionText -notmatch '^v?(\d+\.\d+\.\d+)(?:[-+].*)?$') {
    throw "Unable to parse bundled Node.js version from ${path}: $versionText"
  }
  return [version]$Matches[1]
}

function Get-MinimumNodeVersion([string]$engine) {
  if ($engine -notmatch '^\s*>=\s*(\d+\.\d+\.\d+)\s*$') {
    throw "Unsupported package.json engines.node range for portable packaging: $engine"
  }
  return [version]$Matches[1]
}

if (-not (Test-Path -LiteralPath $nodeExe)) { throw "Bundled Node.js not found: $nodeExe" }
$package = Get-Content -Raw -LiteralPath (Join-Path $sourceDir "package.json") | ConvertFrom-Json
$appVersion = [string]$package.version
$nodeEngine = [string]$package.engines.node
$minimumNodeVersion = Get-MinimumNodeVersion $nodeEngine
$runtimeNodeVersion = Get-ExactNodeVersion $nodeExe
if ($runtimeNodeVersion -lt $minimumNodeVersion) {
  throw "Bundled Node.js $runtimeNodeVersion does not satisfy package.json engines.node $nodeEngine. Pass -RuntimeDir with Node.js $minimumNodeVersion or newer. Runtime: $nodeExe"
}
Write-Host "Portable runtime check passed: Node.js $runtimeNodeVersion ($nodeExe)"
if ($CheckRuntimeOnly) {
  $global:LASTEXITCODE = 0
  return
}

if (-not (Test-Path -LiteralPath $csc)) { throw "Windows C# compiler not found: $csc" }
if (-not (Test-Path -LiteralPath $launcherSource)) { throw "Launcher source not found: $launcherSource" }
if ((-not $SkipBuild -or (-not $ReuseStage -and -not $SkipInstall)) -and -not (Test-Path -LiteralPath $npmCmd)) {
  throw "npm.cmd not found: $npmCmd"
}
if ($PortableVersion -notmatch '^\d+\.\d+\.\d+$') { throw "PortableVersion must use x.y.z format: $PortableVersion" }
if ($Repository -notmatch '^[^/]+/[^/]+$') { throw "Repository must use owner/name format: $Repository" }

if ($SkipBuild) {
  # Reusing compiled output must not bypass the compatibility release gate.
  & $nodeExe --test (Join-Path $sourceDir "lib\anthropic-adaptive-thinking.test.mjs") (Join-Path $sourceDir "lib\anthropic-system-docs.test.mjs") (Join-Path $sourceDir "lib\anthropic-tool-ids.test.mjs") (Join-Path $sourceDir "lib\anthropic-tool-ids.integration.test.mjs") (Join-Path $sourceDir "lib\resend-model.integration.test.mjs") (Join-Path $sourceDir "hooks\resend-model.test.mjs")
  if ($LASTEXITCODE -ne 0) { throw "Model compatibility and resend checks failed: $LASTEXITCODE" }
}

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
  $stageLockPath = Join-Path $stageApp "package-lock.json"
  $sourceLockHash = (Get-FileHash -LiteralPath (Join-Path $sourceDir "package-lock.json") -Algorithm SHA256).Hash
  $stageLockHash = if (Test-Path -LiteralPath $stageLockPath) { (Get-FileHash -LiteralPath $stageLockPath -Algorithm SHA256).Hash } else { "" }
  $dependenciesChanged = $stageLockHash -ne $sourceLockHash
  if ($dependenciesChanged -and $SkipInstall) {
    throw "Cannot reuse outdated production dependencies with -SkipInstall. package-lock.json changed."
  }
  Remove-ExactDirectory (Join-Path $stageApp ".next")
  foreach ($name in @("package.json", "package-lock.json", "next.config.ts")) {
    Copy-Item -LiteralPath (Join-Path $sourceDir $name) -Destination (Join-Path $stageApp $name) -Force
  }
  foreach ($name in @("bin", "scripts", "public")) {
    Invoke-Robocopy (Join-Path $sourceDir $name) (Join-Path $stageApp $name) @()
  }
  $nextDir = Join-Path $sourceDir ".next"
  Invoke-Robocopy $nextDir (Join-Path $stageApp ".next") @("/XD", (Join-Path $nextDir "cache"), (Join-Path $nextDir "dev"))
  if ($dependenciesChanged) {
    Push-Location $stageApp
    try {
      $env:PATH = "$runtimeDir;$env:PATH"
      & $npmCmd ci --omit=dev --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "Refreshing portable dependencies failed: $LASTEXITCODE" }
    }
    finally { Pop-Location }
  }
}

# Browser plugins (long-press voice input + local streaming speech recognition).
# Source lives in portable\plugins; the sherpa-onnx model is downloaded once into
# portable\.voice-cache and verified by SHA256 before it is packaged.
$voiceModelName = "sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05"
$voiceModelUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$voiceModelName.tar.bz2"
$voiceModelFiles = [ordered]@{
  "encoder.int8.onnx" = "908596dcc137a73b95be908ca55e88caa1b3dbbe8027c171615f4b0609c5eb1e"
  "decoder.onnx" = "a1cbc9eac2d5e3fb6617a218c67ad6daaa7f4e0fd225f08b2c22ab0413c8c257"
  "joiner.int8.onnx" = "aedb7fa697b2ab43f20499826fff7c997eea7d67db77be97769aeeeb726e63b3"
  "tokens.txt" = "b818a60878b9aae978cbb8ad594acbd403d76d1af2e31ef4197c84e2dbdba27c"
  "bpe.model" = "f87a38025a5fdd1e4e9591f6a44bb81295097ce0b80df6f4ab9f44e52c64ca5f"
  "README.md" = ""
}

function Test-VoiceModel([string]$dir) {
  foreach ($name in $voiceModelFiles.Keys) {
    $file = Join-Path $dir $name
    if (-not (Test-Path -LiteralPath $file)) { return $false }
    $expected = $voiceModelFiles[$name]
    if ($expected -and (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { return $false }
  }
  return $true
}

function Get-VoiceModel {
  $cacheDir = Join-Path $sourceDir "portable\.voice-cache"
  $modelDir = Join-Path $cacheDir $voiceModelName
  if (Test-VoiceModel $modelDir) { return $modelDir }
  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  $archive = Join-Path $cacheDir "$voiceModelName.tar.bz2"
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    & curl.exe -sSfL --retry 3 -C - -o $archive $voiceModelUrl
    if ($LASTEXITCODE -eq 0) { break }
    Write-Warning "Voice model download attempt $attempt failed (curl exit $LASTEXITCODE)."
  }
  if ($LASTEXITCODE -ne 0) { throw "Voice model download failed: $voiceModelUrl" }
  $extractDir = Join-Path $cacheDir "extract"
  Remove-ExactDirectory $extractDir
  New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
  & tar.exe -xjf $archive -C $extractDir
  if ($LASTEXITCODE -ne 0) { throw "Voice model extraction failed: $archive" }
  $extracted = Join-Path $extractDir $voiceModelName
  if (-not (Test-VoiceModel $extracted)) {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    throw "Voice model files are missing or failed SHA256 verification: $extracted"
  }
  New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
  foreach ($name in $voiceModelFiles.Keys) { Copy-Item -LiteralPath (Join-Path $extracted $name) -Destination (Join-Path $modelDir $name) -Force }
  Remove-ExactDirectory $extractDir
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  return $modelDir
}

$stagePlugins = Join-Path $stageApp "plugins"
Remove-ExactDirectory $stagePlugins
Invoke-Robocopy (Join-Path $sourceDir "portable\plugins") $stagePlugins @("/XD", "node_modules", "models")
$voiceServiceDir = Join-Path $stagePlugins "server\voice-asr"
Push-Location $voiceServiceDir
try {
  $env:PATH = "$runtimeDir;$env:PATH"
  # npm ci rejects this lockfile because sherpa-onnx-node lists an optional
  # sherpa-onnx-win-arm64@2.0.0 that was never published; npm install still
  # follows the lockfile's exact versions.
  & $npmCmd install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "Installing voice recognition dependencies failed: $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath (Join-Path $voiceServiceDir "node_modules\sherpa-onnx-win-x64"))) { throw "sherpa-onnx-win-x64 was not installed." }
}
finally { Pop-Location }
$voiceModelDir = Get-VoiceModel
Invoke-Robocopy $voiceModelDir (Join-Path $voiceServiceDir "models\$voiceModelName") @()
Remove-Item -LiteralPath (Join-Path $voiceServiceDir "package-lock.json") -Force -ErrorAction SilentlyContinue

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
语音输入：在聊天输入框上长按鼠标左键约 0.45 秒开始说话，文字边说边写入输入框，松开结束，Esc 取消。
按住 Alt 再长按可选择麦克风。识别在本机离线完成（app\plugins\server\voice-asr），不上传声音。

命令：
  Pi-Web-Portable.exe --self-test
  Pi-Web-Portable.exe --check-update
  Pi-Web-Portable.exe --verify-update
  Pi-Web-Portable.exe --stop
  Pi-Web-Portable.exe --apply-local-update --archive <zip> --checksum <sha256> --non-interactive
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
$selfTestProcess = Start-Process -FilePath $outputExe -ArgumentList @("--self-test", "--non-interactive") -WindowStyle Hidden -Wait -PassThru
if ($selfTestProcess.ExitCode -ne 0) { throw "Portable self-test failed: $($selfTestProcess.ExitCode)" }
Remove-ExactDirectory (Join-Path $OutputDir "logs")

New-Item -ItemType Directory -Force -Path $ArchiveDir | Out-Null
$zipPath = Join-Path $ArchiveDir $assetName
$pendingZip = Join-Path $ArchiveDir ("pending-" + [guid]::NewGuid().ToString("N") + ".zip")
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($OutputDir, $pendingZip, [IO.Compression.CompressionLevel]::Optimal, $false)
$hash = (Get-FileHash -LiteralPath $pendingZip -Algorithm SHA256).Hash.ToLowerInvariant()
if (Test-Path -LiteralPath $zipPath) {
  Move-Item -LiteralPath $zipPath -Destination ($zipPath + ".backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}
Move-Item -LiteralPath $pendingZip -Destination $zipPath
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
