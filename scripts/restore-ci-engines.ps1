param(
  [string]$BundlePath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $projectRoot "ci-engines-v1.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$outputRoot = Join-Path $projectRoot "output"
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

if (-not $BundlePath) {
  $BundlePath = Join-Path $outputRoot $manifest.assetName
  if (-not (Test-Path -LiteralPath $BundlePath -PathType Leaf)) {
    & gh release download $manifest.releaseTag --repo $manifest.repository --pattern $manifest.assetName --dir $outputRoot
    if ($LASTEXITCODE -ne 0) { throw "Unable to download $($manifest.assetName)." }
  }
}

$resolvedBundle = (Resolve-Path -LiteralPath $BundlePath).Path
$actualHash = (Get-FileHash -LiteralPath $resolvedBundle -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedHash = [string]$manifest.sha256
if ($expectedHash -notmatch '^[0-9a-f]{64}$') { throw "ci-engines-v1.json contains an invalid SHA-256." }
if ($actualHash -ne $expectedHash.ToLowerInvariant()) {
  throw "Engine bundle SHA-256 mismatch. Expected $expectedHash, got $actualHash."
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
  & tar -xf $resolvedBundle -C $stage
  if ($LASTEXITCODE -ne 0) { throw "Unable to extract the fixed engine bundle." }
  foreach ($relativePath in $manifest.requiredFiles) {
    $candidate = Join-Path $stage ([string]$relativePath).Replace('/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      throw "Engine bundle is missing $relativePath."
    }
  }
  $binRoot = Join-Path $projectRoot "bin"
  New-Item -ItemType Directory -Path $binRoot -Force | Out-Null
  foreach ($directory in @("ffmpeg", "poppler", "libreoffice", "tessdata", "dcraw", "docengine")) {
    $destination = Join-Path $binRoot $directory
    if (Test-Path -LiteralPath $destination) {
      throw "Engine destination already exists: $destination"
    }
    Move-Item -LiteralPath (Join-Path $stage $directory) -Destination $destination
  }
  Write-Host "Restored $($manifest.version) ($actualHash)."
} finally {
  Remove-EngineStage
}
