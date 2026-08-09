param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$PrevalidatedPayloadPath,
  [Parameter(Mandatory = $true)][string]$PrevalidationEvidencePath,
  [Parameter(Mandatory = $true)][string]$EvidencePath
)

$ErrorActionPreference = 'Stop'
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$prevalidatedPayload = (Resolve-Path -LiteralPath $PrevalidatedPayloadPath).Path
$prevalidationEvidence = Get-Content -LiteralPath (Resolve-Path -LiteralPath $PrevalidationEvidencePath).Path -Raw | ConvertFrom-Json
$evidence = [IO.Path]::GetFullPath($EvidencePath)
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($evidence)) -Force | Out-Null
$expectedHash = (Get-FileHash -LiteralPath $prevalidatedPayload -Algorithm SHA256).Hash.ToLowerInvariant()
if ($prevalidationEvidence.sha256 -ne $expectedHash) {
  throw "The prevalidated WebView2 payload no longer matches its evidence."
}
$sevenZip = Get-Command 7z -ErrorAction Stop
$extractRoot = Join-Path $env:RUNNER_TEMP ("swl-webview-evidence-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $extractRoot | Out-Null

function Get-PeMachine([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $reader = [IO.BinaryReader]::new($stream)
  try {
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'The embedded WebView2 payload is not a PE executable.' }
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) {
      throw 'The embedded WebView2 payload has an invalid PE header offset.'
    }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw 'The embedded WebView2 payload has an invalid PE signature.' }
    return $reader.ReadUInt16()
  }
  finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

try {
  & $sevenZip.Source x -y "-o$extractRoot" $installer | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "7-Zip could not inspect the task-created NSIS installer."
  }

  $expectedNames = @('MicrosoftEdgeWebView2RuntimeInstaller.exe', 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe')
  $candidates = @(Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter '*.exe' | Where-Object {
    $expectedNames -contains $_.Name
  })
  if ($candidates.Count -ne 1) {
    throw "Expected exactly one embedded WebView2 offline installer; found $($candidates.Count)."
  }

  $candidate = $candidates[0]
  $embeddedHash = (Get-FileHash -LiteralPath $candidate.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($embeddedHash -ne $expectedHash) {
    throw 'The embedded WebView2 payload is not byte-identical to the prevalidated official payload.'
  }
  if ((Get-PeMachine $candidate.FullName) -ne 0x8664) {
    throw 'The embedded WebView2 payload is not x64.'
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $candidate.FullName
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:CN|O)=Microsoft Corporation') {
    throw "The embedded WebView2 installer does not have a valid Microsoft Authenticode signature."
  }
  if ($candidate.VersionInfo.ProductName -notmatch 'WebView2') {
    throw 'The embedded Microsoft payload does not identify as WebView2.'
  }

  [ordered]@{
    verification = 'prevalidated-payload-identity-and-embedded-signature'
    verifiedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    officialSourceUrl = $prevalidationEvidence.officialSourceUrl
    resolvedSourceUrl = $prevalidationEvidence.resolvedSourceUrl
    installer = [IO.Path]::GetFileName($installer)
    fileName = $candidate.Name
    bytes = $candidate.Length
    sha256 = $embeddedHash
    matchesPrevalidatedPayload = $true
    peMachine = 'x86_64 (0x8664)'
    fileVersion = $candidate.VersionInfo.FileVersion
    productVersion = $candidate.VersionInfo.ProductVersion
    productName = $candidate.VersionInfo.ProductName
    originalFileName = $candidate.VersionInfo.OriginalFilename
    signatureStatus = $signature.Status.ToString()
    signerSubject = $signature.SignerCertificate.Subject
    signerIssuer = $signature.SignerCertificate.Issuer
    signerThumbprint = $signature.SignerCertificate.Thumbprint
    signerValidFromUtc = $signature.SignerCertificate.NotBefore.ToUniversalTime().ToString('o')
    signerValidToUtc = $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString('o')
    timestampSubject = $(if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null })
    extractionTool = $sevenZip.Source
    extractionToolVersion = (Get-Item -LiteralPath $sevenZip.Source).VersionInfo.FileVersion
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $evidence -Encoding utf8
}
finally {
  if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
  }
}
