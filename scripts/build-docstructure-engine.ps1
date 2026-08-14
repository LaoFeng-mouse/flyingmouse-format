param(
  [switch]$PrepareModels,
  [switch]$WriteLock,
  [string]$ModelsSource = $env:FLYINGMOUSE_DOCSTRUCTURE_MODELS_SOURCE,
  [string]$PythonPath = $env:FLYINGMOUSE_DOCSTRUCTURE_PYTHON,
  [string]$StagingRoot = $env:FLYINGMOUSE_DOCSTRUCTURE_STAGING_ROOT
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$toolsRoot = Join-Path $projectRoot "tools\docstructure-engine"
$publishRoot = Join-Path $projectRoot "bin\docstructure"
$runtimeLock = Join-Path $toolsRoot "requirements-win-x64.lock"
$buildLock = Join-Path $toolsRoot "requirements-build.lock"
$engineLock = Join-Path $projectRoot "docstructure-engine-lock.json"
$lockScript = Join-Path $projectRoot "scripts\lock-docstructure-engine.js"
$requiredModelDirectories = @(
  "layout_detection", "doc_orientation_classification", "doc_unwarping",
  "text_detection", "text_recognition", "table_classification",
  "wired_table_structure", "wireless_table_structure", "wired_table_cells",
  "wireless_table_cells", "seal_text_detection"
)

function Assert-Contained([string]$Root, [string]$Candidate) {
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $candidatePath = [IO.Path]::GetFullPath($Candidate)
  if (-not $candidatePath.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe document engine path: $candidatePath"
  }
}

function Assert-NoReparseTree([string]$Root) {
  $entries = @((Get-Item -LiteralPath $Root -Force)) + @(Get-ChildItem -LiteralPath $Root -Force -Recurse)
  foreach ($entry in $entries) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Document engine input must not contain reparse points: $($entry.FullName)"
    }
  }
}

function Assert-ExactStageChild([string]$Root, [string]$Child, [string]$ExpectedName) {
  if ($ExpectedName -notmatch '^[0-9a-f]{32}$') { throw "Invalid document engine staging child name." }
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $childPath = [IO.Path]::GetFullPath($Child)
  $expectedPath = Join-Path $rootPath $ExpectedName
  if (-not $childPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe document engine staging child: $childPath"
  }
  Assert-Contained $rootPath $childPath
}

function Assert-HashedRequirementsLock([string]$LockPath) {
  if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
    throw "Missing hashed dependency lock: $LockPath. Run pip-compile --allow-unsafe --generate-hashes first."
  }
  $content = Get-Content -LiteralPath $LockPath -Raw
  if ($content -match '(?im)^\s*#.*(?:WARNING|unpinned)' -or $content -match '(?im)^\s*(?:-e\s+|[^#\s]+\s+@\s+)') {
    throw "Requirements lock contains a warning or unpinned entry: $LockPath"
  }
  $lines = @(Get-Content -LiteralPath $LockPath)
  $requirements = @()
  for ($index = 0; $index -lt $lines.Count; $index += 1) {
    $line = [string]$lines[$index]
    if ($line -match '^([A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_,.-]+\])?)==([^\s\\]+)\s*(?:\\)?$') {
      $requirements += [PSCustomObject]@{ Index = $index; Name = $Matches[1] }
    } elseif ($line -match '^[^#\s].*(?:>=|<=|~=|!=|===|(?<![=])>(?!=)|(?<![=])<(?!=))') {
      throw "Requirement must be pinned with == in $LockPath at line $($index + 1)."
    }
  }
  if ($requirements.Count -eq 0) { throw "Requirements lock contains no pinned entries: $LockPath" }
  for ($position = 0; $position -lt $requirements.Count; $position += 1) {
    $start = $requirements[$position].Index
    $end = if ($position + 1 -lt $requirements.Count) { $requirements[$position + 1].Index - 1 } else { $lines.Count - 1 }
    $block = ($lines[$start..$end] -join "`n")
    if ($block -notmatch '--hash=sha256:[0-9a-f]{64}') {
      throw "Unhashed requirement $($requirements[$position].Name) in $LockPath."
    }
  }
}

function Resolve-Python311([string]$RequestedPath) {
  $candidate = $RequestedPath
  if (-not $candidate) {
    $candidate = Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"
  }
  if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "Python 3.11 x64 was not found. Pass -PythonPath or set FLYINGMOUSE_DOCSTRUCTURE_PYTHON."
  }
  $resolved = (Resolve-Path -LiteralPath $candidate).Path
  $version = & $resolved -c "import sys; print('.'.join(map(str, sys.version_info[:2])))" 2>$null
  if ($LASTEXITCODE -ne 0 -or ([string]$version).Trim() -ne "3.11") {
    throw "Document engine builds require exactly Python 3.11; got $version."
  }
  return $resolved
}

function Copy-ReviewedModels([string]$SourceRoot, [string]$DestinationRoot) {
  if (-not $SourceRoot -or -not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
    throw "Set -ModelsSource or FLYINGMOUSE_DOCSTRUCTURE_MODELS_SOURCE to the reviewed PP-StructureV3 model directory."
  }
  $resolvedSource = (Resolve-Path -LiteralPath $SourceRoot).Path
  Assert-NoReparseTree $resolvedSource
  $topLevel = @(Get-ChildItem -LiteralPath $resolvedSource -Force)
  $unexpected = @($topLevel | Where-Object { -not $_.PSIsContainer -or $requiredModelDirectories -notcontains $_.Name })
  if ($unexpected.Count -ne 0 -or $topLevel.Count -ne $requiredModelDirectories.Count) {
    throw "Reviewed model root must contain exactly the eleven required logical directories."
  }
  New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
  foreach ($name in $requiredModelDirectories) {
    $source = Join-Path $resolvedSource $name
    if (-not (Test-Path -LiteralPath $source -PathType Container) -or @(Get-ChildItem -LiteralPath $source -File -Recurse).Count -eq 0) {
      throw "Reviewed model directory is missing or empty: $name"
    }
    Copy-Item -LiteralPath $source -Destination $DestinationRoot -Recurse
    if (-not (Test-Path -LiteralPath (Join-Path $DestinationRoot $name) -PathType Container)) {
      throw "Model copy produced an invalid nested layout for $name."
    }
  }
}

function ConvertTo-PrivateNativeArgument([string]$Value) {
  if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

function Invoke-PrivateProbe {
  param(
    [string]$Executable,
    [string[]]$Arguments = @(),
    [int]$ExpectedExitCode,
    [string]$ExpectedCode
  )
  $maximumPrivateBytes = 16 * 1024
  $probeId = [Guid]::NewGuid().ToString("N")
  $stdoutPath = Join-Path $stage ("probe-" + $probeId + ".stdout")
  $stderrPath = Join-Path $stage ("probe-" + $probeId + ".stderr")
  Assert-ExactStageChild $stagingRootPath $stage $stageName
  Assert-Contained $stage $stdoutPath
  Assert-Contained $stage $stderrPath
  $reason = "missing-stream"
  $process = $null
  try {
    [IO.File]::WriteAllBytes($stdoutPath, [byte[]]@())
    [IO.File]::WriteAllBytes($stderrPath, [byte[]]@())
    $encoding = [Text.UTF8Encoding]::new($false, $false)
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable
    $start.Arguments = (($Arguments | ForEach-Object { ConvertTo-PrivateNativeArgument ([string]$_) }) -join " ")
    $start.WorkingDirectory = $stage
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = $encoding
    $start.StandardErrorEncoding = $encoding
    $start.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    $reason = "start"
    if (-not $process.Start()) { throw "Private probe process did not start." }
    $reason = "missing-stream"
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdoutTask, $stderrTask))
    $process.Refresh()
    $stdoutText = $stdoutTask.Result
    $stderrText = $stderrTask.Result
    $stdoutBytes = $encoding.GetByteCount($stdoutText)
    $stderrBytes = $encoding.GetByteCount($stderrText)
    $reason = "stdout"
    if ($stdoutBytes -ne 0) { throw "Private probe stdout was not empty." }
    $reason = "stderr-bound"
    if ($stderrBytes -le 0 -or $stderrBytes -gt $maximumPrivateBytes) {
      throw "Private probe stderr was outside the allowed bound."
    }
    $reason = "missing-stream"
    [IO.File]::WriteAllText($stderrPath, $stderrText, $encoding)
    if ((Get-Item -LiteralPath $stdoutPath).Length -ne 0 -or
        (Get-Item -LiteralPath $stderrPath).Length -ne $stderrBytes) {
      throw "Private probe stream capture failed."
    }
    $reason = "line-count"
    if ($stderrText -notmatch '^[^\r\n]+(?:\r?\n)?$') {
      throw "Private probe did not emit exactly one status line."
    }
    $privateLines = @($stderrText -split '\r?\n' | Where-Object { $_.Length -gt 0 })
    if ($privateLines.Count -ne 1) { throw "Private probe did not emit exactly one status line." }
    $reason = "json"
    $payload = $privateLines[0] | ConvertFrom-Json -ErrorAction Stop
    $reason = "exit"
    if ($process.ExitCode -ne $ExpectedExitCode) { throw "Private probe exit code did not match." }
    $reason = "code"
    if (-not $payload.PSObject.Properties["code"] -or [string]$payload.code -ne $ExpectedCode) {
      throw "Private probe status code did not match."
    }
    return $payload
  } catch {
    throw "Document engine private probe failed: $reason"
  } finally {
    if ($null -ne $process) { $process.Dispose() }
  }
}

function Remove-Stage {
  if (-not $stage -or -not (Test-Path -LiteralPath $stage)) { return }
  $resolved = (Resolve-Path -LiteralPath $stage).Path
  Assert-ExactStageChild $stagingRootPath $resolved $stageName
  if (-not $resolved.Equals($expectedStage, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe document engine staging path: $resolved"
  }
  Assert-NoReparseTree $resolved
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

Assert-HashedRequirementsLock $runtimeLock
Assert-HashedRequirementsLock $buildLock
$resolvedPython = Resolve-Python311 $PythonPath
if (Test-Path -LiteralPath $publishRoot) {
  throw "Refusing to overwrite existing ignored engine directory: $publishRoot"
}

if (-not $StagingRoot) {
  if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA is required unless -StagingRoot is supplied." }
  $StagingRoot = Join-Path $env:LOCALAPPDATA "FlyingMouseFormat\docstructure-build"
}
$stagingRootPath = [IO.Path]::GetFullPath($StagingRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
New-Item -ItemType Directory -Path $stagingRootPath -Force | Out-Null
$resolvedStagingRoot = (Resolve-Path -LiteralPath $stagingRootPath).Path
if (-not $resolvedStagingRoot.Equals($stagingRootPath, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Document engine staging root did not resolve to the requested canonical path."
}
$stagingRootPath = $resolvedStagingRoot
Assert-NoReparseTree $stagingRootPath
$stageName = [Guid]::NewGuid().ToString("N")
$stage = Join-Path $stagingRootPath $stageName
Assert-ExactStageChild $stagingRootPath $stage $stageName
$expectedStage = [IO.Path]::GetFullPath($stage)

New-Item -ItemType Directory -Path $stage -Force | Out-Null
Assert-NoReparseTree $stage
try {
  $venv = Join-Path $stage "venv"
  & $resolvedPython -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw "Unable to create isolated Python environment." }
  $python = Join-Path $venv "Scripts\python.exe"
  & $python -m pip install --disable-pip-version-check --require-hashes -r $buildLock
  if ($LASTEXITCODE -ne 0) { throw "Unable to install hashed build dependencies." }
  & $python -m pip install --disable-pip-version-check --require-hashes -r $runtimeLock
  if ($LASTEXITCODE -ne 0) { throw "Unable to install hashed runtime dependencies." }

  Push-Location $toolsRoot
  try {
    & $python -m unittest discover -s tests -v
    if ($LASTEXITCODE -ne 0) { throw "Document engine Python tests failed." }
    & $python -m PyInstaller --clean --noconfirm docstructure-engine.spec --distpath (Join-Path $stage "dist") --workpath (Join-Path $stage "pyinstaller")
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed." }
  } finally { Pop-Location }

  $builtRoot = Join-Path $stage "dist\docstructure-engine"
  $builtExe = Join-Path $builtRoot "docstructure-engine.exe"
  if (-not (Test-Path -LiteralPath $builtExe -PathType Leaf)) { throw "PyInstaller output is missing docstructure-engine.exe." }

  $models = Join-Path $builtRoot "models"
  if (-not $PrepareModels) { throw "-PrepareModels is required for a publishable document engine build." }
  Copy-ReviewedModels $ModelsSource $models
  if ((Get-ChildItem -LiteralPath $models -Directory).Count -ne $requiredModelDirectories.Count) {
    throw "Packaged model directory is not the required flat eleven-directory layout."
  }

  $null = Invoke-PrivateProbe -Executable $builtExe -ExpectedExitCode 20 -ExpectedCode "MODEL_MISSING"

  $probePdf = Join-Path $stage "blank-probe.pdf"
  $probeOutput = Join-Path $stage "blank-probe-output"
  & $python -c "import fitz,sys; doc=fitz.open(); doc.new_page(); doc.save(sys.argv[1]); doc.close()" $probePdf
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $probePdf -PathType Leaf)) {
    throw "Unable to generate the private blank-PDF probe."
  }
  New-Item -ItemType Directory -Path $probeOutput -Force | Out-Null
  $offlineVariables = @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")
  $savedEnvironment = @{}
  foreach ($name in $offlineVariables) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }
  try {
    foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")) {
      [Environment]::SetEnvironmentVariable($name, "http://127.0.0.1:9", "Process")
    }
    foreach ($name in @("NO_PROXY", "no_proxy")) { [Environment]::SetEnvironmentVariable($name, "", "Process") }
    foreach ($name in @("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")) { [Environment]::SetEnvironmentVariable($name, "1", "Process") }
    $null = Invoke-PrivateProbe -Executable $builtExe `
      -Arguments @("parse", "--input", $probePdf, "--output", $probeOutput, "--models", $models, "--language", "ch") `
      -ExpectedExitCode 0 -ExpectedCode "OK"
  } finally {
    foreach ($name in $offlineVariables) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process") }
  }
  $probeManifest = Join-Path $probeOutput "manifest.json"
  if (-not (Test-Path -LiteralPath $probeManifest -PathType Leaf)) {
    throw "Packaged document engine could not construct the local pipeline and parse the private blank PDF offline."
  }
  $manifest = Get-Content -LiteralPath $probeManifest -Raw | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or @($manifest.pages).Count -ne 1) { throw "Private blank-PDF probe returned an invalid manifest." }

  if ($WriteLock) {
    & node $lockScript --root $builtRoot --lock $engineLock --engine-version "3.7.0"
    if ($LASTEXITCODE -ne 0) { throw "Unable to write document engine lock." }
  }
  if (-not (Test-Path -LiteralPath $engineLock -PathType Leaf)) { throw "Document engine lock is missing." }
  & node $lockScript --verify --root $builtRoot --lock $engineLock
  if ($LASTEXITCODE -ne 0) { throw "Document engine lock verification failed." }

  Assert-Contained $projectRoot $publishRoot
  Move-Item -LiteralPath $builtRoot -Destination $publishRoot
  if (-not (Test-Path -LiteralPath (Join-Path $publishRoot "docstructure-engine.exe") -PathType Leaf)) {
    throw "Published one-folder engine is missing its executable."
  }
  Write-Host "Published locked document engine to bin\docstructure."
} finally {
  Remove-Stage
}
