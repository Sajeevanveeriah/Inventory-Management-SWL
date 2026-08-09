param(
  [Parameter(Mandatory = $true)][string]$DriverPath,
  [Parameter(Mandatory = $true)][string]$EvidencePath
)

$ErrorActionPreference = 'Stop'
$webViewClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$registryPaths = @(
  "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$webViewClientId",
  "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\EdgeUpdate\Clients\$webViewClientId",
  "Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\EdgeUpdate\Clients\$webViewClientId"
)
$runtimeVersionCandidates = [Collections.Generic.List[string]]::new()
foreach ($registryPath in $registryPaths) {
  if (Test-Path -LiteralPath $registryPath -PathType Container) {
    $properties = Get-ItemProperty -LiteralPath $registryPath -Name 'pv'
    if ($null -ne $properties.pv) {
      [void]$runtimeVersionCandidates.Add(([string]$properties.pv).Trim())
    }
  }
}
$runtimeVersions = @($runtimeVersionCandidates | Sort-Object -Unique)
if ($runtimeVersions.Count -ne 1) {
  throw "Expected exactly one installed WebView2 runtime version; found $($runtimeVersions.Count)."
}
$runtimeVersion = [string]$runtimeVersions[0]
if ($runtimeVersion -cnotmatch '^\d+(?:\.\d+){3}$') {
  throw 'The installed WebView2 runtime does not expose an exact numeric four-part version.'
}

$webViewRoots = @(
  "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application",
  "$env:ProgramFiles\Microsoft\EdgeWebView\Application"
) | Where-Object { ![string]::IsNullOrWhiteSpace($_) }
$runtimeExecutables = @($webViewRoots | ForEach-Object {
  $candidate = Join-Path $_ "$runtimeVersion\msedgewebview2.exe"
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    Get-Item -LiteralPath $candidate -Force
  }
})
if ($runtimeExecutables.Count -ne 1) {
  throw "Expected exactly one executable for WebView2 runtime $runtimeVersion; found $($runtimeExecutables.Count)."
}
$runtimeExecutable = $runtimeExecutables[0]
if ($runtimeExecutable.PSIsContainer -or
    $runtimeExecutable.Length -le 0 -or
    ($runtimeExecutable.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    $runtimeExecutable.VersionInfo.ProductVersion -cne $runtimeVersion) {
  throw 'The installed WebView2 runtime executable failed exact regular-file and version validation.'
}
$runtimeSignature = Get-AuthenticodeSignature -LiteralPath $runtimeExecutable.FullName
if ($runtimeSignature.Status -ne 'Valid' -or
    $runtimeSignature.SignerCertificate.Subject -notmatch '(?:^|,\s*)(?:CN|O)=Microsoft Corporation(?:,|$)') {
  throw 'The installed WebView2 runtime executable is not validly signed by Microsoft.'
}

if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  throw 'RUNNER_TEMP is required for exact EdgeDriver preparation.'
}
$runnerTemp = [IO.Path]::TrimEndingDirectorySeparator(
  [IO.Path]::GetFullPath(([string]$env:RUNNER_TEMP).Trim())
)
$runnerTempInfo = Get-Item -LiteralPath $runnerTemp -Force
if (!$runnerTempInfo.PSIsContainer -or
    ($runnerTempInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    $runnerTempInfo.FullName -ine $runnerTemp) {
  throw 'RUNNER_TEMP must be an existing canonical ordinary directory.'
}

$driverPath = [IO.Path]::GetFullPath($DriverPath)
$driverDirectory = [IO.Path]::GetDirectoryName($driverPath)
$evidencePath = [IO.Path]::GetFullPath($EvidencePath)
if ([IO.Path]::GetFileName($driverPath) -cne 'msedgedriver.exe' -or
    [string]::IsNullOrWhiteSpace($driverDirectory) -or
    $driverDirectory -ine (Join-Path $runnerTemp 'swl-edgedriver') -or
    $driverPath -ine (Join-Path $driverDirectory 'msedgedriver.exe')) {
  throw 'The EdgeDriver output must be the exact task-owned RUNNER_TEMP child path.'
}
if (Test-Path -LiteralPath $driverDirectory) {
  throw 'The exact EdgeDriver output directory was not clean before preparation.'
}

function Get-PeMachine([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $reader = [IO.BinaryReader]::new($stream)
  try {
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'The EdgeDriver is not a PE executable.' }
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) {
      throw 'The EdgeDriver has an invalid PE header offset.'
    }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw 'The EdgeDriver has an invalid PE signature.' }
    return $reader.ReadUInt16()
  }
  finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

$sourceUrl = [Uri]"https://msedgedriver.microsoft.com/$runtimeVersion/edgedriver_win64.zip"
$allowedHosts = @('msedgedriver.microsoft.com')
$archivePath = Join-Path $driverDirectory 'edgedriver_win64.zip'
$current = $sourceUrl
$redirects = [Collections.Generic.List[string]]::new()
$response = $null
$driverDirectoryCreated = $false

try {
  $createdDriverDirectory = New-Item -ItemType Directory -Path $driverDirectory -ErrorAction Stop
  $driverDirectoryCreated = $true
  $driverDirectoryInfo = Get-Item -LiteralPath $driverDirectory -Force
  if (!$driverDirectoryInfo.PSIsContainer -or
      ($driverDirectoryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $driverDirectoryInfo.FullName -ine $createdDriverDirectory.FullName -or
      $driverDirectoryInfo.FullName -ine $driverDirectory -or
      @(Get-ChildItem -LiteralPath $driverDirectory -Force).Count -ne 0) {
    throw 'The exact EdgeDriver output directory failed clean ordinary-directory validation.'
  }
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($evidencePath)) -Force | Out-Null

  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromMinutes(5)
  try {
    for ($attempt = 0; $attempt -lt 6; $attempt += 1) {
      if ($current.Scheme -cne 'https' -or
          $allowedHosts -notcontains $current.DnsSafeHost.ToLowerInvariant()) {
        throw 'The EdgeDriver download escaped the reviewed Microsoft HTTPS hosts.'
      }
      $response = $client.GetAsync(
        $current,
        [Net.Http.HttpCompletionOption]::ResponseHeadersRead
      ).GetAwaiter().GetResult()
      $status = [int]$response.StatusCode
      if ($status -ge 300 -and $status -lt 400) {
        $location = $response.Headers.Location
        if ($null -eq $location) { throw 'The EdgeDriver download returned a redirect without a location.' }
        $next = if ($location.IsAbsoluteUri) { $location } else { [Uri]::new($current, $location) }
        if ($next.Scheme -cne 'https' -or
            $allowedHosts -notcontains $next.DnsSafeHost.ToLowerInvariant()) {
          throw 'The EdgeDriver download redirect escaped the reviewed Microsoft HTTPS hosts.'
        }
        [void]$redirects.Add($next.GetLeftPart([UriPartial]::Path))
        $response.Dispose()
        $response = $null
        $current = $next
        continue
      }
      if (!$response.IsSuccessStatusCode) {
        throw "The exact Microsoft EdgeDriver download failed with HTTP status $status."
      }
      break
    }
    if ($null -eq $response -or !$response.IsSuccessStatusCode) {
      throw 'The exact Microsoft EdgeDriver download exceeded the redirect limit.'
    }
    if ($current.AbsolutePath -cne "/$runtimeVersion/edgedriver_win64.zip") {
      throw 'The EdgeDriver download resolved to an unexpected version or archive name.'
    }
    $declaredLength = $response.Content.Headers.ContentLength
    if ($null -ne $declaredLength -and ($declaredLength -lt 5MB -or $declaredLength -gt 100MB)) {
      throw 'The declared EdgeDriver archive length is outside the reviewed range.'
    }

    $input = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $output = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $buffer = [byte[]]::new(64KB)
      $downloadedBytes = 0L
      while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $downloadedBytes += $read
        if ($downloadedBytes -gt 100MB) {
          throw 'The EdgeDriver archive exceeded the reviewed maximum while downloading.'
        }
        $output.Write($buffer, 0, $read)
      }
      $output.Flush($true)
    }
    finally {
      $output.Dispose()
      $input.Dispose()
    }
    if ($downloadedBytes -lt 5MB) {
      throw 'The downloaded EdgeDriver archive is below the reviewed minimum length.'
    }
    if ($null -ne $declaredLength -and $downloadedBytes -ne $declaredLength) {
      throw 'The downloaded EdgeDriver archive length differs from its declared length.'
    }
  }
  finally {
    if ($null -ne $response) { $response.Dispose() }
    $client.Dispose()
    $handler.Dispose()
  }

  $archiveInfo = Get-Item -LiteralPath $archivePath -Force
  if ($archiveInfo.PSIsContainer -or
      $archiveInfo.Length -lt 5MB -or
      $archiveInfo.Length -gt 100MB -or
      ($archiveInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The downloaded EdgeDriver archive failed bounded regular-file validation.'
  }
  $archiveBytes = $archiveInfo.Length
  $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()

  $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    if ($archive.Entries.Count -le 0 -or $archive.Entries.Count -gt 64) {
      throw 'The EdgeDriver archive entry count is outside the reviewed range.'
    }
    $aggregateUncompressedBytes = 0L
    foreach ($entry in $archive.Entries) {
      $normalisedEntryName = $entry.FullName.Replace('\', '/')
      $aggregateUncompressedBytes += $entry.Length
      $unixFileType = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if ([IO.Path]::IsPathRooted($entry.FullName) -or
          $normalisedEntryName -match '(?:^|/)\.\.(?:/|$)' -or
          $normalisedEntryName -match '^[A-Za-z]:' -or
          $entry.Length -gt 100MB -or
          $aggregateUncompressedBytes -gt 200MB -or
          $unixFileType -eq 0xA000 -or
          ($entry.ExternalAttributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The EdgeDriver archive contains an unsafe entry.'
      }
    }
    $driverEntries = @($archive.Entries | Where-Object {
      [IO.Path]::GetExtension($_.FullName) -ieq '.exe'
    })
    if ($driverEntries.Count -ne 1 -or $driverEntries[0].FullName -cne 'msedgedriver.exe') {
      throw 'The EdgeDriver archive does not contain only one root msedgedriver.exe executable.'
    }
    $driverEntry = $driverEntries[0]
    if ($driverEntry.Length -lt 5MB -or $driverEntry.Length -gt 100MB) {
      throw 'The archived EdgeDriver executable length is outside the reviewed range.'
    }
    $driverInput = $driverEntry.Open()
    $driverOutput = [IO.File]::Open($driverPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $driverBuffer = [byte[]]::new(64KB)
      $copiedDriverBytes = 0L
      while (($driverRead = $driverInput.Read($driverBuffer, 0, $driverBuffer.Length)) -gt 0) {
        $copiedDriverBytes += $driverRead
        if ($copiedDriverBytes -gt $driverEntry.Length -or $copiedDriverBytes -gt 100MB) {
          throw 'The extracted EdgeDriver exceeded its declared bounded length.'
        }
        $driverOutput.Write($driverBuffer, 0, $driverRead)
      }
      $driverOutput.Flush($true)
    }
    finally {
      $driverOutput.Dispose()
      $driverInput.Dispose()
    }
    if ($copiedDriverBytes -ne $driverEntry.Length) {
      throw 'The extracted EdgeDriver byte count differs from its archive entry.'
    }
  }
  finally {
    $archive.Dispose()
  }
  Remove-Item -LiteralPath $archivePath -Force

  $driverInfo = Get-Item -LiteralPath $driverPath -Force
  if ($driverInfo.PSIsContainer -or
      $driverInfo.Length -lt 5MB -or
      $driverInfo.Length -gt 100MB -or
      ($driverInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $driverInfo.FullName -ine $driverPath -or
      [IO.Path]::GetDirectoryName($driverInfo.FullName) -ine $driverDirectory -or
      @(Get-ChildItem -LiteralPath $driverDirectory -Force).Count -ne 1) {
    throw 'The extracted EdgeDriver failed exact regular-file validation.'
  }
  $driverMachine = Get-PeMachine $driverInfo.FullName
  if ($driverMachine -ne 0x8664) {
    throw ('The exact EdgeDriver is not x64 ' + ('(observed PE machine 0x{0:x4}).' -f $driverMachine))
  }
  $driverSignature = Get-AuthenticodeSignature -LiteralPath $driverInfo.FullName
  if ($driverSignature.Status -ne 'Valid' -or
      $driverSignature.SignerCertificate.Subject -notmatch '(?:^|,\s*)(?:CN|O)=Microsoft Corporation(?:,|$)') {
    throw 'The exact EdgeDriver is not validly signed by Microsoft.'
  }
  if ($driverInfo.VersionInfo.FileVersion -cne $runtimeVersion -or
      $driverInfo.VersionInfo.ProductVersion -cne $runtimeVersion) {
    throw 'The exact EdgeDriver file metadata does not match the installed WebView2 runtime.'
  }

  $driverStartInfo = [Diagnostics.ProcessStartInfo]::new()
  $driverStartInfo.FileName = $driverInfo.FullName
  [void]$driverStartInfo.ArgumentList.Add('--version')
  $driverStartInfo.UseShellExecute = $false
  $driverStartInfo.CreateNoWindow = $true
  $driverStartInfo.RedirectStandardOutput = $true
  $driverStartInfo.RedirectStandardError = $true
  $driverProcess = [Diagnostics.Process]::new()
  $driverProcess.StartInfo = $driverStartInfo
  try {
    if (!$driverProcess.Start()) { throw 'The exact EdgeDriver version probe did not start.' }
    $driverOutputTask = $driverProcess.StandardOutput.ReadToEndAsync()
    $driverErrorTask = $driverProcess.StandardError.ReadToEndAsync()
    if (!$driverProcess.WaitForExit(10000)) {
      try { $driverProcess.Kill($true) } catch {}
      [void]$driverProcess.WaitForExit(5000)
      throw 'The exact EdgeDriver version probe timed out.'
    }
    $driverStandardOutput = $driverOutputTask.GetAwaiter().GetResult()
    $driverStandardError = $driverErrorTask.GetAwaiter().GetResult()
    $driverExitCode = $driverProcess.ExitCode
  }
  finally {
    $driverProcess.Dispose()
  }
  $driverOutputBytes = [Text.Encoding]::UTF8.GetByteCount($driverStandardOutput) +
    [Text.Encoding]::UTF8.GetByteCount($driverStandardError)
  if ($driverExitCode -ne 0 -or
      $driverOutputBytes -gt 8192 -or
      ![string]::IsNullOrEmpty($driverStandardError)) {
    throw 'The exact EdgeDriver returned invalid bounded version-probe output.'
  }
  $driverMatch = [regex]::Match(
    $driverStandardOutput.Trim(),
    '^MSEdgeDriver (?<version>\d+(?:\.\d+){3})(?: .*)?$'
  )
  if (!$driverMatch.Success) {
    throw 'The exact EdgeDriver did not return the supported MSEdgeDriver version format.'
  }
  $driverVersion = $driverMatch.Groups['version'].Value
  if ($driverVersion -cne $runtimeVersion) {
    throw 'The exact EdgeDriver command version does not match the installed WebView2 runtime.'
  }

  $runtimeHash = (Get-FileHash -LiteralPath $runtimeExecutable.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $driverHash = (Get-FileHash -LiteralPath $driverInfo.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  [ordered]@{
    verification = 'exact-installed-webview2-driver'
    verifiedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    sourceUrl = $sourceUrl.AbsoluteUri
    resolvedSourceUrl = $current.GetLeftPart([UriPartial]::Path)
    redirectChain = @($redirects)
    selection = 'official exact-version x64 download derived from the installed signed WebView2 runtime'
    archiveBytes = $archiveBytes
    archiveSha256 = $archiveHash
    downloadCompletedBeforeOfflineBoundary = $true
    automaticDownloadDisabled = $true
    runtime = [ordered]@{
      fileName = $runtimeExecutable.Name
      version = $runtimeVersion
      bytes = $runtimeExecutable.Length
      sha256 = $runtimeHash
      signatureStatus = $runtimeSignature.Status.ToString()
      signerSubject = $runtimeSignature.SignerCertificate.Subject
      signerIssuer = $runtimeSignature.SignerCertificate.Issuer
      signerThumbprint = $runtimeSignature.SignerCertificate.Thumbprint
    }
    driver = [ordered]@{
      fileName = $driverInfo.Name
      architecture = 'x64'
      peMachine = ('0x{0:x4}' -f $driverMachine)
      bytes = $driverInfo.Length
      sha256 = $driverHash
      fileVersion = $driverInfo.VersionInfo.FileVersion
      productVersion = $driverInfo.VersionInfo.ProductVersion
      commandVersion = $driverVersion
      signatureStatus = $driverSignature.Status.ToString()
      signerSubject = $driverSignature.SignerCertificate.Subject
      signerIssuer = $driverSignature.SignerCertificate.Issuer
      signerThumbprint = $driverSignature.SignerCertificate.Thumbprint
      signerValidFromUtc = $driverSignature.SignerCertificate.NotBefore.ToUniversalTime().ToString('o')
      signerValidToUtc = $driverSignature.SignerCertificate.NotAfter.ToUniversalTime().ToString('o')
      timestampSubject = $(if ($driverSignature.TimeStamperCertificate) {
        $driverSignature.TimeStamperCertificate.Subject
      } else { $null })
    }
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $evidencePath -Encoding utf8
}
catch {
  $preparationFailure = $_
  $cleanupFailed = $false
  if ($driverDirectoryCreated) {
    try {
      if (Test-Path -LiteralPath $driverDirectory) {
        Remove-Item -LiteralPath $driverDirectory -Recurse -Force -ErrorAction Stop
      }
      if (Test-Path -LiteralPath $driverDirectory) {
        $cleanupFailed = $true
      }
    }
    catch {
      $cleanupFailed = $true
    }
  }
  if ($cleanupFailed) {
    throw 'Exact EdgeDriver preparation failed and its task-created directory could not be removed.'
  }
  throw $preparationFailure
}
