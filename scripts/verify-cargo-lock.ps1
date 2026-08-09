param(
  [Parameter(Mandatory = $true)][string]$DiagnosticDirectory
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$manifestPath = 'src-tauri/Cargo.toml'
$lockPath = 'src-tauri/Cargo.lock'
$diagnosticRoot = [IO.Path]::GetFullPath($DiagnosticDirectory)
New-Item -ItemType Directory -Path $diagnosticRoot -Force | Out-Null

$metadataOutput = @(& cargo metadata --locked --manifest-path $manifestPath --format-version 1 2>&1)
$metadataExitCode = $LASTEXITCODE
if ($metadataExitCode -eq 0) {
  return
}

if ($env:GITHUB_OUTPUT) {
  'diagnostic=true' | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}

$committedCopy = Join-Path $diagnosticRoot 'Cargo.lock.committed'
$generatedCopy = Join-Path $diagnosticRoot 'Cargo.lock.generated'
$generationLog = Join-Path $diagnosticRoot 'cargo-generate-lockfile.log'
$hadCommittedLock = Test-Path -LiteralPath $lockPath -PathType Leaf
$committedHash = $null
if ($hadCommittedLock) {
  Copy-Item -LiteralPath $lockPath -Destination $committedCopy
  $committedHash = (Get-FileHash -LiteralPath $committedCopy -Algorithm SHA256).Hash.ToLowerInvariant()
}
$manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()

$generationOutput = @(& cargo generate-lockfile --manifest-path $manifestPath 2>&1)
$generateExitCode = $LASTEXITCODE
$generationOutput | Set-Content -LiteralPath $generationLog -Encoding utf8
$generatedHash = $null
if ($generateExitCode -eq 0 -and (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
  Copy-Item -LiteralPath $lockPath -Destination $generatedCopy
  $generatedHash = (Get-FileHash -LiteralPath $generatedCopy -Algorithm SHA256).Hash.ToLowerInvariant()
}

# The generated lock is review-only evidence. Restore the checkout exactly before failing.
if ($hadCommittedLock) {
  Copy-Item -LiteralPath $committedCopy -Destination $lockPath -Force
}
elseif (Test-Path -LiteralPath $lockPath) {
  Remove-Item -LiteralPath $lockPath -Force
}

[ordered]@{
  purpose = 'Review-only Cargo lock diagnostic; never apply this candidate automatically'
  sourceCommit = $env:SWL_SOURCE_SHA
  rustc = (& rustc --version).Trim()
  cargo = (& cargo --version).Trim()
  manifestSha256 = $manifestHash
  committedLockSha256 = $committedHash
  generatedLockSha256 = $generatedHash
  metadataExitCode = $metadataExitCode
  generateLockExitCode = $generateExitCode
  metadataErrorLineCount = @($metadataOutput).Count
} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $diagnosticRoot 'LOCK-DIAGNOSTIC.json') -Encoding utf8

throw 'Cargo.lock is missing or inconsistent with src-tauri/Cargo.toml. A review-only package-manager diagnostic was captured.'
