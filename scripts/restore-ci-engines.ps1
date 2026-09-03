param(
  [string]$BundlePath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $projectRoot "ci-engines-v1.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$outputRoot = Join-Path $projectRoot "output"
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

# win32-x64 引擎资产拆分为多分卷（core + docstructure），各自 < 2GB 以适配 GitHub Release 单资产上限。
# darwin-* 为单资产（mac 版不含 docstructure 引擎）。
$key = "win32-x64"
$entry = $manifest.assets.$key
if (-not $entry) { throw "No manifest entry for $key" }

# 收集要下载的分卷清单（允许 $BundlePath 覆盖第一个分卷路径，兼容本地测试）
$parts = @()
if ($entry.parts) {
  for ($i = 0; $i -lt $entry.parts.Count; $i += 1) {
    $part = $entry.parts[$i]
    $assetName = [string]$part.assetName
    $expectedHash = [string]$part.sha256
    if ($expectedHash -notmatch '^[0-9a-f]{64}$') { throw "Invalid SHA-256 for $assetName" }
    $parts += @{
      Index        = $i
      AssetName    = $assetName
      ExpectedHash = $expectedHash
      RequiredFiles = @($part.requiredFiles)
    }
  }
} else {
  throw "win32-x64 manifest entry must declare parts (multi-volume bundle)."
}

# 下载分卷（若未提供本地路径）
$downloads = @()
foreach ($p in $parts) {
  $bundle = Join-Path $outputRoot $p.AssetName
  if ($p.Index -eq 0 -and $BundlePath) { $bundle = (Resolve-Path -LiteralPath $BundlePath).Path }
  if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) {
    Write-Host "Downloading $($p.AssetName) ..."
    & gh release download $manifest.releaseTag --repo $manifest.repository --pattern $p.AssetName --dir $outputRoot
    if ($LASTEXITCODE -ne 0) { throw "Unable to download $($p.AssetName)." }
  }
  $resolved = (Resolve-Path -LiteralPath $bundle).Path
  $actualHash = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $p.ExpectedHash.ToLowerInvariant()) {
    throw "Engine bundle SHA-256 mismatch for $($p.AssetName). Expected $($p.ExpectedHash), got $actualHash."
  }
  $downloads += @{ Path = $resolved; RequiredFiles = $p.RequiredFiles }
}

$stage = Join-Path $outputRoot ("ci-engines-v1-stage-" + [Guid]::NewGuid().ToString("N"))
$expectedStage = [IO.Path]::GetFullPath($stage)
function Remove-EngineStage {
  for ($attempt = 1; $attempt -le 5; $attempt += 1) {
    if (-not (Test-Path -LiteralPath $stage)) { return }
    try {
      $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
      if (-not $resolvedStage.Equals($expectedStage, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe engine staging path: $resolvedStage"
      }
      Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($attempt -eq 5) { throw }
      Start-Sleep -Milliseconds (200 * $attempt)
    }
  }
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null

try {
  foreach ($d in $downloads) {
    & tar -xf $d.Path -C $stage
    if ($LASTEXITCODE -ne 0) { throw "Unable to extract $($d.Path)." }
  }
  # 合并验证全部 requiredFiles
  foreach ($d in $downloads) {
    foreach ($relativePath in $d.RequiredFiles) {
      $candidate = Join-Path $stage ([string]$relativePath).Replace('/', [IO.Path]::DirectorySeparatorChar)
      if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "Engine bundle is missing $relativePath."
      }
    }
  }
  $docstructureRoot = Join-Path $stage "docstructure"
  if (Test-Path -LiteralPath $docstructureRoot -PathType Container) {
    $docstructureLock = Join-Path $projectRoot "docstructure-engine-lock.json"
    if (-not (Test-Path -LiteralPath $docstructureLock -PathType Leaf)) {
      throw "docstructure-engine-lock.json is required for the bundled document engine."
    }
    & node (Join-Path $projectRoot "scripts\lock-docstructure-engine.js") --verify --root $docstructureRoot --lock $docstructureLock
    if ($LASTEXITCODE -ne 0) { throw "Document structure engine lock verification failed." }
  }
  $binRoot = Join-Path $projectRoot "bin"
  New-Item -ItemType Directory -Path $binRoot -Force | Out-Null
  $directories = @("ffmpeg", "poppler", "libreoffice", "tessdata", "dcraw", "docengine", "avs3", "qpdf")
  if (Test-Path -LiteralPath $docstructureRoot -PathType Container) { $directories += "docstructure" }
  foreach ($directory in $directories) {
    $destination = Join-Path $binRoot $directory
    if (Test-Path -LiteralPath $destination) {
      # bin/avs3 因 .gitignore 例外被 git 跟踪，CI checkout 自带；其内容与引擎 bundle 一致
      # （bundle 由本机 bin/ 打包），直接复用，避免 Move-Item 冲突。
      Write-Host "Skipping existing engine directory: $directory (already present)"
      continue
    }
    Move-Item -LiteralPath (Join-Path $stage $directory) -Destination $destination
  }
  Write-Host "Restored $($manifest.version) ($($downloads.Count) volumes)."
} finally {
  Remove-EngineStage
}
