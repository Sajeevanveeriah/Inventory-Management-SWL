param(
  [Parameter(Mandatory = $true)][string]$PayloadPath,
  [Parameter(Mandatory = $true)][string]$EvidencePath
)

$ErrorActionPreference = 'Stop'
$sourceUrl = [Uri]'https://go.microsoft.com/fwlink/?linkid=2124701'
$allowedHosts = @('go.microsoft.com', 'msedge.sf.dl.delivery.mp.microsoft.com')
$payload = [IO.Path]::GetFullPath($PayloadPath)
$evidence = [IO.Path]::GetFullPath($EvidencePath)
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($payload)) -Force | Out-Null
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($evidence)) -Force | Out-Null

function Get-PeMachine([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $reader = [IO.BinaryReader]::new($stream)
  try {
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'The WebView2 payload is not a PE executable.' }
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) {
      throw 'The WebView2 payload has an invalid PE header offset.'
    }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw 'The WebView2 payload has an invalid PE signature.' }
    return $reader.ReadUInt16()
  }
  finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

$handler = [Net.Http.HttpClientHandler]::new()
$handler.AllowAutoRedirect = $false
$client = [Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromMinutes(10)
$current = $sourceUrl
$redirects = [Collections.Generic.List[string]]::new()
$response = $null

try {
  for ($attempt = 0; $attempt -lt 6; $attempt += 1) {
    if ($current.Scheme -ne 'https' -or $allowedHosts -notcontains $current.DnsSafeHost.ToLowerInvariant()) {
      throw 'The WebView2 download escaped the reviewed Microsoft HTTPS hosts.'
    }
    $response = $client.GetAsync($current, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $status = [int]$response.StatusCode
    if ($status -ge 300 -and $status -lt 400) {
      $location = $response.Headers.Location
      if ($null -eq $location) { throw 'The WebView2 download returned a redirect without a location.' }
      $next = if ($location.IsAbsoluteUri) { $location } else { [Uri]::new($current, $location) }
      if ($next.Scheme -ne 'https' -or $allowedHosts -notcontains $next.DnsSafeHost.ToLowerInvariant()) {
        throw 'The WebView2 download redirect escaped the reviewed Microsoft HTTPS hosts.'
      }
      $redirects.Add($next.GetLeftPart([UriPartial]::Path))
      $response.Dispose()
      $response = $null
      $current = $next
      continue
    }
    if (!$response.IsSuccessStatusCode) {
      throw "The official WebView2 download failed with HTTP status $status."
    }
    break
  }

  if ($null -eq $response -or !$response.IsSuccessStatusCode) {
    throw 'The official WebView2 download exceeded the redirect limit.'
  }
  if ($current.DnsSafeHost -ne 'msedge.sf.dl.delivery.mp.microsoft.com') {
    throw 'The WebView2 download did not resolve to the reviewed Microsoft delivery host.'
  }
  if ([IO.Path]::GetFileName($current.AbsolutePath) -ne 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe') {
    throw 'The WebView2 download did not resolve to the x64 Evergreen standalone installer.'
  }
  $declaredLength = $response.Content.Headers.ContentLength
  if ($null -ne $declaredLength -and ($declaredLength -lt 50MB -or $declaredLength -gt 300MB)) {
    throw 'The WebView2 payload length is outside the reviewed range.'
  }

  $output = [IO.File]::Create($payload)
  try {
    $response.Content.CopyToAsync($output).GetAwaiter().GetResult()
    $output.Flush($true)
  }
  finally {
    $output.Dispose()
  }
}
finally {
  if ($null -ne $response) { $response.Dispose() }
  $client.Dispose()
  $handler.Dispose()
}

$payloadInfo = Get-Item -LiteralPath $payload
if ($payloadInfo.Length -lt 50MB -or $payloadInfo.Length -gt 300MB) {
  throw 'The downloaded WebView2 payload length is outside the reviewed range.'
}
$machine = Get-PeMachine $payload
if ($machine -ne 0x8664) { throw 'The downloaded WebView2 payload is not x64.' }
$signature = Get-AuthenticodeSignature -LiteralPath $payload
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:CN|O)=Microsoft Corporation') {
  throw 'The downloaded WebView2 payload does not have a valid Microsoft Authenticode signature.'
}
$version = $payloadInfo.VersionInfo
if ($version.ProductName -notmatch 'WebView2' -or $version.FileVersion -notmatch '^\d+(?:\.\d+){3}') {
  throw 'The downloaded Microsoft payload does not identify as a versioned WebView2 installer.'
}
$hash = (Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant()

[ordered]@{
  verification = 'pre-bundle-official-download'
  verifiedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  officialSourceUrl = $sourceUrl.AbsoluteUri
  resolvedSourceUrl = $current.GetLeftPart([UriPartial]::Path)
  redirectChain = @($redirects)
  fileName = $payloadInfo.Name
  bytes = $payloadInfo.Length
  sha256 = $hash
  peMachine = 'x86_64 (0x8664)'
  fileVersion = $version.FileVersion
  productVersion = $version.ProductVersion
  productName = $version.ProductName
  originalFileName = $version.OriginalFilename
  signatureStatus = $signature.Status.ToString()
  signerSubject = $signature.SignerCertificate.Subject
  signerIssuer = $signature.SignerCertificate.Issuer
  signerThumbprint = $signature.SignerCertificate.Thumbprint
  signerValidFromUtc = $signature.SignerCertificate.NotBefore.ToUniversalTime().ToString('o')
  signerValidToUtc = $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString('o')
  timestampSubject = $(if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null })
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $evidence -Encoding utf8
