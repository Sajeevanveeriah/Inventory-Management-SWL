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
$officialSourceUrl = 'https://go.microsoft.com/fwlink/?linkid=2124701'
$officialX64FileName = 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe'
$officialDeliveryHost = 'msedge.sf.dl.delivery.mp.microsoft.com'
$architectureDocumentationUrl = 'https://learn.microsoft.com/en-us/microsoft-edge/webview2/samples/wv2deploymentvsinstallersample'
$architectureEvidence = 'official Microsoft x64 Evergreen standalone endpoint, resolved X64 filename and valid Microsoft signature'
$resolvedSource = [Uri]$prevalidationEvidence.resolvedSourceUrl
if ($prevalidationEvidence.verification -ne 'pre-bundle-official-download' -or
    $prevalidationEvidence.officialSourceUrl -ne $officialSourceUrl -or
    $prevalidationEvidence.distributionArchitecture -ne 'x64' -or
    $prevalidationEvidence.fileName -ne $officialX64FileName -or
    $prevalidationEvidence.architectureEvidence -ne $architectureEvidence -or
    $prevalidationEvidence.architectureDocumentationUrl -ne $architectureDocumentationUrl -or
    $resolvedSource.Scheme -ne 'https' -or
    $resolvedSource.DnsSafeHost.ToLowerInvariant() -ne $officialDeliveryHost -or
    [IO.Path]::GetFileName($resolvedSource.AbsolutePath) -ne $officialX64FileName -or
    $prevalidationEvidence.signatureStatus -ne 'Valid' -or
    $prevalidationEvidence.signerSubject -notmatch '(?:^|,\s*)(?:CN|O)=Microsoft Corporation(?:,|$)') {
  throw 'The prevalidation evidence does not identify the official Microsoft x64 Evergreen standalone installer.'
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

function Get-CompatibleOuterPeMachine([string]$Path) {
  $machine = Get-PeMachine $Path
  if ($machine -ne 0x014c -and $machine -ne 0x8664) {
    throw ('The embedded WebView2 x64 installer outer executable is not compatible with Windows x64 ' +
      ('(observed PE machine 0x{0:x4}).' -f $machine))
  }
  return [ordered]@{
    code = ('0x{0:x4}' -f $machine)
    name = $(if ($machine -eq 0x014c) { 'x86 outer setup launcher' } else { 'x86_64 outer setup launcher' })
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
  $outerPe = Get-CompatibleOuterPeMachine $candidate.FullName
  if ($outerPe.code -ne $prevalidationEvidence.outerPeMachine) {
    throw 'The embedded WebView2 outer executable identity differs from the prevalidated payload.'
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $candidate.FullName
  if ($signature.Status -ne 'Valid' -or
      $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)(?:CN|O)=Microsoft Corporation(?:,|$)') {
    throw "The embedded WebView2 installer does not have a valid Microsoft Authenticode signature."
  }
  if ($candidate.VersionInfo.ProductName -notmatch 'WebView2') {
    throw 'The embedded Microsoft payload does not identify as WebView2.'
  }
  if ([long]$prevalidationEvidence.bytes -ne $candidate.Length -or
      $prevalidationEvidence.fileVersion -ne $candidate.VersionInfo.FileVersion -or
      $prevalidationEvidence.productVersion -ne $candidate.VersionInfo.ProductVersion -or
      $prevalidationEvidence.productName -ne $candidate.VersionInfo.ProductName -or
      $prevalidationEvidence.originalFileName -ne $candidate.VersionInfo.OriginalFilename -or
      $prevalidationEvidence.signerSubject -ne $signature.SignerCertificate.Subject -or
      $prevalidationEvidence.signerIssuer -ne $signature.SignerCertificate.Issuer -or
      $prevalidationEvidence.signerThumbprint -ne $signature.SignerCertificate.Thumbprint) {
    throw 'The embedded WebView2 payload metadata differs from the prevalidated Microsoft payload.'
  }

  [ordered]@{
    verification = 'prevalidated-payload-identity-and-embedded-signature'
    verifiedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    officialSourceUrl = $prevalidationEvidence.officialSourceUrl
    resolvedSourceUrl = $prevalidationEvidence.resolvedSourceUrl
    installer = [IO.Path]::GetFileName($installer)
    fileName = $candidate.Name
    distributionArchitecture = 'x64'
    architectureEvidence = $prevalidationEvidence.architectureEvidence
    architectureDocumentationUrl = $prevalidationEvidence.architectureDocumentationUrl
    bytes = $candidate.Length
    sha256 = $embeddedHash
    matchesPrevalidatedPayload = $true
    outerPeMachine = $outerPe.code
    outerPeMachineDescription = $outerPe.name
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
