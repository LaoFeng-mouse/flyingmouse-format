[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$OutputPath,
    [string]$PythonPath,
    [string]$WinUnpackedPath,
    [string]$MakeAppxPath = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe',
    [string]$MinVersion = '10.0.19041.0',
    [string]$MaxVersionTested = '10.0.26100.0'
)

# Every run owns a new layout under dist. Existing APPX packages, source engines
# and previous layouts are preserved. Reserved OPC names are changed in the copy
# only; app.asar is never replaced inside a previously built Electron executable.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'APPX packaging requires Windows and the Windows SDK.'
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packageJsonPath = Join-Path $repoRoot 'package.json'
$package = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$releaseVersion = [string]$package.version
if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'package.json version must be x.y.z.' }
$appxVersion = "$releaseVersion.0"
foreach ($versionValue in @($appxVersion, $MinVersion, $MaxVersionTested)) {
    if ($versionValue -notmatch '^\d+\.\d+\.\d+\.\d+$' -or
        @($versionValue.Split('.') | Where-Object { [long]$_ -gt 65535 }).Count) {
        throw "Invalid Windows package version: $versionValue"
    }
}
$appxConfig = $package.build.appx
$productName = [string]$package.build.productName
if ([string]::IsNullOrWhiteSpace($productName) -or $productName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
    throw 'Invalid build.productName in package.json.'
}
$executableName = "$productName.exe"
$distRoot = Join-Path $repoRoot 'dist'
if (-not $OutputPath) { $OutputPath = Join-Path $distRoot "$productName-$releaseVersion-x64-unsigned.appx" }
if (-not [IO.Path]::IsPathRooted($OutputPath)) { $OutputPath = Join-Path $repoRoot $OutputPath }
$finalOutput = [IO.Path]::GetFullPath($OutputPath)
if ([IO.Path]::GetExtension($finalOutput) -ne '.appx') { throw 'OutputPath must end in .appx.' }
if (Test-Path -LiteralPath $finalOutput) { throw "Output already exists; choose another OutputPath: $finalOutput" }
if (-not (Test-Path -LiteralPath $MakeAppxPath -PathType Leaf)) { throw "MakeAppx was not found: $MakeAppxPath" }
if (-not $PythonPath) {
    foreach ($candidate in @('python', 'python3')) {
        $pythonCommand = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($pythonCommand -and $pythonCommand.Source -notlike '*\Microsoft\WindowsApps\*') {
            $PythonPath = $pythonCommand.Source; break
        }
    }
}
if (-not $PythonPath -or -not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw 'Python was not found. Pass -PythonPath with a working Python executable.'
}

function Invoke-CheckedNative {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed with exit ${LASTEXITCODE}: $Executable" }
}

function Escape-XmlValue {
    param([string]$Value)
    return [Security.SecurityElement]::Escape($Value)
}

function Assert-RealDirectory {
    param([string]$Directory)
    $item = Get-Item -LiteralPath $Directory -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Expected a real directory, not a reparse point: $Directory"
    }
}

[IO.Directory]::CreateDirectory($distRoot) | Out-Null
Assert-RealDirectory $distRoot
$stageId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ([Guid]::NewGuid().ToString('N').Substring(0, 8))
$stageRoot = Join-Path $distRoot "appx-stage-$stageId"
if (Test-Path -LiteralPath $stageRoot) { throw "Stage path already exists: $stageRoot" }
[IO.Directory]::CreateDirectory($stageRoot) | Out-Null
$layoutRoot = Join-Path $stageRoot 'layout'
$appRoot = Join-Path $layoutRoot 'app'
$assetRoot = Join-Path $layoutRoot 'Assets'
[IO.Directory]::CreateDirectory($layoutRoot) | Out-Null
[IO.Directory]::CreateDirectory($assetRoot) | Out-Null
Write-Host "APPX_STAGE=$stageRoot"

if (-not $SkipBuild) {
    if ($WinUnpackedPath) { throw 'WinUnpackedPath requires -SkipBuild; a normal run builds a fresh Electron application.' }
    $nodeCommand = Get-Command node -ErrorAction Stop
    $builderPath = Join-Path $repoRoot 'node_modules\electron-builder\cli.js'
    if (-not (Test-Path -LiteralPath $builderPath -PathType Leaf)) { throw 'Run npm ci before packaging.' }
    $buildOutput = Join-Path $stageRoot 'electron-build'
    Push-Location $repoRoot
    try {
        Invoke-CheckedNative $nodeCommand.Source @($builderPath, '--win', '--dir', '--x64', '--publish', 'never', "--config.directories.output=$buildOutput")
    } finally { Pop-Location }
    $WinUnpackedPath = Join-Path $buildOutput 'win-unpacked'
} elseif (-not $WinUnpackedPath) {
    $WinUnpackedPath = Join-Path $distRoot 'win-unpacked'
}
if (-not [IO.Path]::IsPathRooted($WinUnpackedPath)) { $WinUnpackedPath = Join-Path $repoRoot $WinUnpackedPath }
$unpackedRoot = [IO.Path]::GetFullPath($WinUnpackedPath)
Assert-RealDirectory $unpackedRoot
$asarReference = Join-Path $unpackedRoot 'resources\app.asar'
$exeReference = Join-Path $unpackedRoot $executableName
foreach ($required in @($asarReference, $exeReference)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Incomplete win-unpacked: $required" }
}
$exeVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($exeReference).ProductVersion
if ($exeVersion -ne $releaseVersion -and $exeVersion -ne $appxVersion) {
    throw "Executable version $exeVersion differs from package.json $releaseVersion. Rebuild the whole application."
}
# Node's filesystem APIs handle long packaged Python paths that PowerShell's
# recursive provider can reject with DirectoryNotFound above MAX_PATH.
$treeCheck = @'
const fs = require("node:fs");
const path = require("node:path");
let checked = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`Package tree contains a symlink or junction: ${full}`);
    if (stat.isDirectory()) walk(full);
    else if (!stat.isFile()) throw new Error(`Unexpected package filesystem entry: ${full}`);
    checked++;
  }
}
walk(process.argv[1]);
console.log(`Package tree verified: ${checked} entries, no symlinks or junctions`);
'@
$treeNode = Get-Command node -ErrorAction Stop
Invoke-CheckedNative $treeNode.Source @('-e', $treeCheck, $unpackedRoot)

# Robocopy supports long runtime paths. Codes 0 through 7 are documented success
# states; /XJ is an additional guard after rejecting every source reparse point.
& robocopy.exe $unpackedRoot $appRoot /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XJ /NFL /NDL /NJH /NJS
if ($LASTEXITCODE -ge 8) { throw "Copying win-unpacked failed with exit $LASTEXITCODE" }
# The Store owns updates. This package has no electron-updater consumer and must
# not carry a stale GitHub update configuration from electron-builder.
$updateConfig = Join-Path $appRoot 'resources\app-update.yml'
if (Test-Path -LiteralPath $updateConfig -PathType Leaf) { Remove-Item -LiteralPath $updateConfig }
$logoNames = @('Square150x150Logo.png', 'Square44x44Logo.png', 'StoreLogo.png', 'Wide310x150Logo.png')
foreach ($logoName in $logoNames) {
    $sourceLogo = Join-Path (Join-Path $repoRoot 'build\appx') $logoName
    $targetLogo = Join-Path $assetRoot $logoName
    Copy-Item -LiteralPath $sourceLogo -Destination $targetLogo -ErrorAction Stop
    if ((Get-FileHash -LiteralPath $sourceLogo -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $targetLogo -Algorithm SHA256).Hash) {
        throw "APPX logo copy differs from build/appx: $logoName"
    }
}

$identity = Escape-XmlValue ([string]$appxConfig.identityName)
$publisher = Escape-XmlValue ([string]$appxConfig.publisher)
$publisherDisplayName = Escape-XmlValue ([string]$appxConfig.publisherDisplayName)
$displayName = Escape-XmlValue ([string]$appxConfig.displayName)
$applicationId = Escape-XmlValue ([string]$appxConfig.applicationId)
$description = Escape-XmlValue ([string]$package.description)
$executable = Escape-XmlValue "app\$executableName"
foreach ($requiredValue in @($identity, $publisher, $publisherDisplayName, $displayName, $applicationId)) {
    if ([string]::IsNullOrWhiteSpace($requiredValue)) { throw 'Missing Microsoft Store identity configuration in package.json.' }
}
$languages = @($appxConfig.languages | ForEach-Object { '    <Resource Language="{0}" />' -f (Escape-XmlValue ([string]$_)) }) -join "`n"
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap rescap">
  <Identity Name="$identity" Publisher="$publisher" Version="$appxVersion" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>$displayName</DisplayName>
    <PublisherDisplayName>$publisherDisplayName</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
    <Description>$description</Description>
  </Properties>
  <Resources>
$languages
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="$MinVersion" MaxVersionTested="$MaxVersionTested" />
  </Dependencies>
  <Applications>
    <Application Id="$applicationId" Executable="$executable" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="$displayName" Description="$description" BackgroundColor="transparent"
          Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\Wide310x150Logo.png" />
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
"@
[IO.File]::WriteAllText((Join-Path $layoutRoot 'AppxManifest.xml'), $manifest, [Text.UTF8Encoding]::new($false))

Invoke-CheckedNative $PythonPath @('-X', 'utf8', (Join-Path $PSScriptRoot 'rename-opc-reserved.py'), $appRoot)
Invoke-CheckedNative $PythonPath @('-X', 'utf8', (Join-Path $PSScriptRoot 'scan-pe-cert-dangling.py'), $layoutRoot)
$stagedPackage = Join-Path $stageRoot "$productName-$releaseVersion-x64-unsigned.appx"
Invoke-CheckedNative $MakeAppxPath @('pack', '/d', $layoutRoot, '/p', $stagedPackage)
Invoke-CheckedNative $PythonPath @('-X', 'utf8', (Join-Path $PSScriptRoot 'check-appx.py'), $stagedPackage, $asarReference,
    '--version', $appxVersion, '--identity', [string]$appxConfig.identityName, '--publisher', [string]$appxConfig.publisher)

# Publish through a unique file in the destination directory, so cross-volume
# OutputPath values still get a complete, same-volume, no-overwrite final move.
$finalDirectory = [IO.Path]::GetDirectoryName($finalOutput)
[IO.Directory]::CreateDirectory($finalDirectory) | Out-Null
$temporaryOutput = Join-Path $finalDirectory ('.fm-appx-{0}.partial' -f [Guid]::NewGuid().ToString('N'))
[IO.File]::Copy($stagedPackage, $temporaryOutput, $false)
$packageHash = (Get-FileHash -LiteralPath $stagedPackage -Algorithm SHA256).Hash
if ((Get-FileHash -LiteralPath $temporaryOutput -Algorithm SHA256).Hash -ne $packageHash) {
    throw "Final package copy hash mismatch; retained evidence at $temporaryOutput"
}
[IO.File]::Move($temporaryOutput, $finalOutput)
$evidence = [ordered]@{
    version = $releaseVersion; appxVersion = $appxVersion; identity = [string]$appxConfig.identityName
    publisher = [string]$appxConfig.publisher; architecture = 'x64'; unsigned = $true
    package = $finalOutput; sha256 = $packageHash; stage = $stageRoot
    rebuiltApplication = $unpackedRoot; asarSha256 = (Get-FileHash -LiteralPath $asarReference -Algorithm SHA256).Hash
}
[IO.File]::WriteAllText((Join-Path $stageRoot 'build-evidence.json'), ($evidence | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
Write-Host "APPX_PATH=$finalOutput"
Write-Host "APPX_SHA256=$packageHash"
Write-Host "APPX_EVIDENCE=$(Join-Path $stageRoot 'build-evidence.json')"
