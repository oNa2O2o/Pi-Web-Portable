param(
  [Parameter(Mandatory = $true)]
  [string]$PackageDir,
  [int]$TimeoutSeconds = 180,
  [ValidateRange(1, 65535)]
  [int]$Port = 30141
)

$ErrorActionPreference = "Stop"

$packageDir = (Resolve-Path -LiteralPath $PackageDir).Path
$launcherPath = Join-Path $packageDir "Pi-Web-Portable.exe"
$pidPath = Join-Path $packageDir "data\pi-web.pid"
$expectedNodePath = [IO.Path]::GetFullPath((Join-Path $packageDir "runtime\node.exe"))
$packageJsonPath = Join-Path $packageDir "app\package.json"
$url = "http://127.0.0.1:$Port/"

if (-not (Test-Path -LiteralPath $launcherPath)) { throw "Portable launcher not found: $launcherPath" }
if (-not (Test-Path -LiteralPath $expectedNodePath)) { throw "Portable Node.js runtime not found: $expectedNodePath" }
if (-not (Test-Path -LiteralPath $packageJsonPath)) { throw "Portable package.json not found: $packageJsonPath" }

$package = Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json
$nodeEngine = [string]$package.engines.node
if ($nodeEngine -notmatch '^\s*>=\s*(\d+\.\d+\.\d+)\s*$') {
  throw "Unsupported package.json engines.node range in portable package: $nodeEngine"
}
$minimumNodeVersion = [version]$Matches[1]
$versionText = (& $expectedNodePath --version 2>&1 | Out-String).Trim()
$versionExitCode = $LASTEXITCODE
if ($versionExitCode -ne 0) { throw "Portable Node.js version check failed with exit code $versionExitCode." }
if ($versionText -notmatch '^v?(\d+\.\d+\.\d+)(?:[-+].*)?$') {
  throw "Unable to parse portable Node.js version: $versionText"
}
$runtimeNodeVersion = [version]$Matches[1]
if ($runtimeNodeVersion -lt $minimumNodeVersion) {
  throw "Portable Node.js $runtimeNodeVersion does not satisfy package.json engines.node $nodeEngine."
}

$existingListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $existingListener) {
  throw "Port $Port is already in use by PID $($existingListener.OwningProcess). Refusing to run a smoke test that could stop an active Pi Web service."
}

$launcher = $null
$statusCode = $null
try {
  $launcher = Start-Process -FilePath $launcherPath -ArgumentList @("--no-update", "--no-open", "--non-interactive", "--port", "$Port") -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  do {
    Start-Sleep -Milliseconds 500
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
      $statusCode = $response.StatusCode
    }
    catch { $statusCode = $null }
  } while ($statusCode -ne 200 -and -not $launcher.HasExited -and (Get-Date) -lt $deadline)

  if ($statusCode -ne 200) {
    $stderrPath = Join-Path $packageDir "logs\pi-web.stderr.log"
    $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -Tail 100 -LiteralPath $stderrPath | Out-String } else { "" }
    throw "Portable HTTP smoke test failed.`n$stderr"
  }

  if (-not (Test-Path -LiteralPath $pidPath)) { throw "Portable PID file was not created." }
  $nodePid = [int](Get-Content -Raw -LiteralPath $pidPath).Trim()
  $nodeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$nodePid"
  if ($null -eq $nodeProcess) { throw "Portable Node.js process is not running." }
  if ([IO.Path]::GetFullPath($nodeProcess.ExecutablePath) -ne $expectedNodePath) {
    throw "Portable launcher used the wrong Node.js runtime: $($nodeProcess.ExecutablePath)"
  }

  Write-Host "Portable smoke test passed: HTTP $statusCode, Node.js $runtimeNodeVersion, PID $nodePid"
}
finally {
  if ($null -ne $launcher) {
    $stop = Start-Process -FilePath $launcherPath -ArgumentList @("--stop") -WindowStyle Hidden -Wait -PassThru
    if ($stop.ExitCode -ne 0) { Write-Warning "Portable stop command exited with code $($stop.ExitCode)." }
  }

  if ($null -ne $launcher -and -not $launcher.WaitForExit(10000)) {
    Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
  }
}
