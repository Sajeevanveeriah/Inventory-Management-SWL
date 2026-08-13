param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$WebViewEvidencePath,
  [Parameter(Mandatory = $true)][string]$SmokeEvidencePath,
  [Parameter(Mandatory = $true)][string]$UpgradeEvidencePath,
  [Parameter(Mandatory = $true)][string]$DesktopRenderScopePath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Get-TomlPackageVersion([string]$Content) {
  $section = [regex]::Match($Content, '(?ms)^\[package\]\s*(.*?)(?=^\[|\z)')
  if (!$section.Success) { return $null }
  $version = [regex]::Match($section.Groups[1].Value, '(?m)^version\s*=\s*"([^"]+)"')
  if ($version.Success) { return $version.Groups[1].Value }
  return $null
}

function Invoke-Checked([scriptblock]$Command, [string]$Label) {
  $output = @(& $Command 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "$Label failed." }
  return ($output -join [Environment]::NewLine).Trim()
}

$installer = Get-Item -LiteralPath (Resolve-Path -LiteralPath $InstallerPath).Path
$webViewEvidence = Get-Item -LiteralPath (Resolve-Path -LiteralPath $WebViewEvidencePath).Path
$smokeEvidence = Get-Item -LiteralPath (Resolve-Path -LiteralPath $SmokeEvidencePath).Path
$upgradeEvidence = Get-Item -LiteralPath (Resolve-Path -LiteralPath $UpgradeEvidencePath).Path
$desktopRenderScope = Get-Item -LiteralPath (Resolve-Path -LiteralPath $DesktopRenderScopePath).Path
$output = New-Item -ItemType Directory -Path $OutputDirectory -Force
$hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
if ($signature.Status -ne 'NotSigned') {
  throw "The internal-evaluation installer must be unsigned; actual status: $($signature.Status)."
}

$packageRaw = Get-Content -LiteralPath 'package.json' -Raw
$package = $packageRaw | ConvertFrom-Json
# npm lockfiles key the root package under an empty-string property, which
# ConvertFrom-Json only accepts as a hashtable.
$packageLock = Get-Content -LiteralPath 'package-lock.json' -Raw | ConvertFrom-Json -AsHashtable
$cargoRaw = Get-Content -LiteralPath 'src-tauri/Cargo.toml' -Raw
$cargoLockRaw = Get-Content -LiteralPath 'src-tauri/Cargo.lock' -Raw
$tauri = Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json
$auditRaw = Get-Content -LiteralPath 'src/core/audit.ts' -Raw
$lockRoot = $packageLock['packages']['']
$cargoLockVersionMatch = [regex]::Match(
  $cargoLockRaw,
  '(?ms)^\[\[package\]\]\s*name\s*=\s*"swl-pricing-desktop"\s*version\s*=\s*"([^"]+)"'
)
$auditVersionMatch = [regex]::Match($auditRaw, 'APP_VERSION\s*=\s*[''"]([^''"]+)[''"]')
$versions = [ordered]@{
  packageJson = $package.version
  packageLock = $lockRoot.version
  cargoToml = Get-TomlPackageVersion $cargoRaw
  cargoLock = $(if ($cargoLockVersionMatch.Success) { $cargoLockVersionMatch.Groups[1].Value } else { $null })
  tauriConfig = $tauri.version
  audit = $(if ($auditVersionMatch.Success) { $auditVersionMatch.Groups[1].Value } else { $null })
}
foreach ($entry in $versions.GetEnumerator()) {
  if ([string]::IsNullOrWhiteSpace([string]$entry.Value) -or $entry.Value -ne $package.version) {
    throw "Application version mismatch at $($entry.Key)."
  }
}

$nodeToolchain = (Get-Content -LiteralPath '.nvmrc' -Raw).Trim()
if ($package.engines.node -ne $nodeToolchain) {
  throw 'The package engine and .nvmrc Node versions differ.'
}
$cargoMetadataRaw = Invoke-Checked {
  cargo metadata --locked --manifest-path src-tauri/Cargo.toml --format-version 1 --no-deps
} 'Locked Cargo metadata'
$cargoMetadata = $cargoMetadataRaw | ConvertFrom-Json
$rootPackage = @($cargoMetadata.packages | Where-Object { $_.name -eq 'swl-pricing-desktop' })
if ($rootPackage.Count -ne 1 -or $rootPackage[0].version -ne $package.version) {
  throw 'Locked Cargo metadata does not identify the coherent application version.'
}

$rustcVerbose = Invoke-Checked { rustc --version --verbose } 'rustc version'
$cargoVersion = Invoke-Checked { cargo --version } 'Cargo version'
$rustfmtVersion = Invoke-Checked { cargo fmt --version } 'rustfmt version'
$clippyVersion = Invoke-Checked { cargo clippy --version } 'Clippy version'
$nodeVersion = Invoke-Checked { node --version } 'Node version'
$npmVersion = Invoke-Checked { npm --version } 'npm version'

"$hash  $($installer.Name)" | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding ascii
[ordered]@{
  product = 'SWL Pricing and Inventory Control'
  version = $package.version
  coherentVersionSources = $versions
  installer = $installer.Name
  bytes = $installer.Length
  sha256 = $hash
  authenticodeStatus = $signature.Status.ToString()
  signing = 'Unsigned internal evaluation only'
  sourceCommit = $env:SWL_SOURCE_SHA
  workflowRunId = $env:GITHUB_RUN_ID
  runner = $env:RUNNER_NAME
  runnerOS = $env:RUNNER_OS
  runnerImage = $env:ImageOS
  osDescription = [Runtime.InteropServices.RuntimeInformation]::OSDescription
  processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
  node = $nodeVersion
  npm = $npmVersion
  expectedNode = $nodeToolchain
  rustcVerbose = $rustcVerbose
  cargo = $cargoVersion
  rustfmt = $rustfmtVersion
  clippy = $clippyVersion
  tauriApi = $package.dependencies.'@tauri-apps/api'
  tauriCli = $package.devDependencies.'@tauri-apps/cli'
  tauriDriver = '2.0.6 (external, test-only)'
  packageLockSha256 = (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash.ToLowerInvariant()
  cargoLockSha256 = (Get-FileHash -LiteralPath 'src-tauri/Cargo.lock' -Algorithm SHA256).Hash.ToLowerInvariant()
  artifactRetentionDays = 14
  webView2Evidence = $webViewEvidence.Name
  installerSmokeEvidence = $smokeEvidence.Name
  upgradeSmokeEvidence = $upgradeEvidence.Name
  desktopRenderScope = $desktopRenderScope.Name
  installedAppEvidenceScope = 'GitHub-hosted Windows Server 2025 scripted smoke; not interactive Windows 10/11 acceptance'
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'BUILD-METADATA.json') -Encoding utf8

Copy-Item -LiteralPath $webViewEvidence.FullName -Destination (Join-Path $output $webViewEvidence.Name)
Copy-Item -LiteralPath $smokeEvidence.FullName -Destination (Join-Path $output $smokeEvidence.Name)
Copy-Item -LiteralPath $upgradeEvidence.FullName -Destination (Join-Path $output $upgradeEvidence.Name)
Copy-Item -LiteralPath $desktopRenderScope.FullName -Destination (Join-Path $output $desktopRenderScope.Name)
@'
Browser Playwright screenshots and Windows Server 2025 production-binary WebView screenshots are
separate evidence classes. Neither is interactive Windows 10/11 DPI/scaling acceptance.
The hosted driver does not control Windows IFileDialog. Real native picker selection/cancel,
same-file conflict UI, opening all five outputs in a spreadsheet, Windows restart, interactive
Windows 10/11 lower-version upgrade and offline installation with WebView2 initially absent remain
separate disposable Windows 10/11 acceptance gates. The scripted immutable former 1.0.0 application
source plus its reviewed hash-bound Cargo lock repair to 1.2.0 upgrade
evidence is Windows Server 2025 evidence only.
'@ | Set-Content -LiteralPath (Join-Path $output 'RENDER-EVIDENCE-SCOPE.txt') -Encoding utf8
