param(
  [Parameter(Mandatory = $true)][string]$ApplicationPath,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
  [Parameter(Mandatory = $true)][string]$EdgeDriverPath
)

$ErrorActionPreference = 'Stop'
$application = (Resolve-Path -LiteralPath $ApplicationPath).Path
$evidenceRoot = [IO.Path]::GetFullPath($EvidenceDirectory)
New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
$monitorEvidencePath = Join-Path $evidenceRoot 'OFFLINE-PROCESS-NETWORK.json'
$firewallEvidencePath = Join-Path $evidenceRoot 'OFFLINE-FIREWALL.json'
$stopSentinel = Join-Path $env:RUNNER_TEMP ("swl-network-monitor-stop-" + [Guid]::NewGuid().ToString('N'))
$rulePrefix = "SWL desktop CI offline " + [Guid]::NewGuid().ToString('N')
$ruleNames = [Collections.Generic.List[string]]::new()
$monitor = $null
$profilesBefore = @()
$testExitCode = 1

function Get-BoundedEdgeDriverVersion {
  param([string]$FilePath)

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  [void]$startInfo.ArgumentList.Add('--version')
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (!$process.Start()) { throw 'The exact EdgeDriver version probe did not start.' }
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    if (!$process.WaitForExit(10000)) {
      try { $process.Kill($true) } catch {}
      [void]$process.WaitForExit(5000)
      throw 'The exact EdgeDriver version probe timed out.'
    }
    $standardOutput = $outputTask.GetAwaiter().GetResult()
    $standardError = $errorTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
  }
  finally {
    $process.Dispose()
  }
  $outputBytes = [Text.Encoding]::UTF8.GetByteCount($standardOutput) +
    [Text.Encoding]::UTF8.GetByteCount($standardError)
  if ($exitCode -ne 0 -or $outputBytes -gt 8192 -or
      ![string]::IsNullOrEmpty($standardError)) {
    throw 'The exact EdgeDriver returned invalid bounded version-probe output.'
  }
  $match = [regex]::Match(
    $standardOutput.Trim(),
    '^MSEdgeDriver (?<version>\d+(?:\.\d+){3})(?: .*)?$'
  )
  if (!$match.Success) {
    throw 'The exact EdgeDriver did not return the supported MSEdgeDriver version format.'
  }
  return $match.Groups['version'].Value
}

$edgeDriver = Get-Item -LiteralPath (Resolve-Path -LiteralPath $EdgeDriverPath).Path -Force
if ($edgeDriver.PSIsContainer -or
    $edgeDriver.Name -cne 'msedgedriver.exe' -or
    $edgeDriver.Length -le 0 -or
    ($edgeDriver.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'The selected EdgeDriver failed exact regular-file validation.'
}
$edgeDriverSignature = Get-AuthenticodeSignature -LiteralPath $edgeDriver.FullName
if ($edgeDriverSignature.Status -ne 'Valid' -or
    $edgeDriverSignature.SignerCertificate.Subject -notmatch '(?:^|,\s*)(?:CN|O)=Microsoft Corporation(?:,|$)') {
  throw 'The selected EdgeDriver is not validly signed by Microsoft.'
}
$edgeDriverVersion = Get-BoundedEdgeDriverVersion -FilePath $edgeDriver.FullName
if ($edgeDriverVersion -cne $edgeDriver.VersionInfo.ProductVersion -or
    $edgeDriverVersion -cne $edgeDriver.VersionInfo.FileVersion) {
  throw 'The selected EdgeDriver command and file versions differ.'
}

$edgeDriverDirectory = [IO.Path]::GetDirectoryName($edgeDriver.FullName)
$retainedPathEntries = [Collections.Generic.List[string]]::new()
$seenPathEntries = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($rawPathEntry in @($env:PATH -split [regex]::Escape([string][IO.Path]::PathSeparator))) {
  $pathEntry = ([string]$rawPathEntry).Trim().Trim('"')
  if ([string]::IsNullOrWhiteSpace($pathEntry)) { continue }
  $expandedEntry = [Environment]::ExpandEnvironmentVariables($pathEntry)
  try { $expandedEntry = [IO.Path]::GetFullPath($expandedEntry) }
  catch { continue }
  if (Test-Path -LiteralPath (Join-Path $expandedEntry 'msedgedriver.exe') -PathType Leaf) {
    continue
  }
  if ($seenPathEntries.Add($expandedEntry)) {
    [void]$retainedPathEntries.Add($expandedEntry)
  }
}
$env:PATH = (@($edgeDriverDirectory) + @($retainedPathEntries)) -join [IO.Path]::PathSeparator
$whereExecutable = Join-Path $env:SystemRoot 'System32\where.exe'
$resolvedEdgeDriversRaw = @(& $whereExecutable msedgedriver.exe 2>$null)
$whereExitCode = $LASTEXITCODE
$resolvedEdgeDrivers = @($resolvedEdgeDriversRaw | ForEach-Object {
  ([string]$_).Trim()
} | Where-Object { ![string]::IsNullOrWhiteSpace($_) })
if ($whereExitCode -ne 0 -or $resolvedEdgeDrivers.Count -ne 1) {
  throw 'The process-local PATH does not resolve exactly one EdgeDriver.'
}
$resolvedEdgeDriverPath = [IO.Path]::GetFullPath($resolvedEdgeDrivers[0])
if ($resolvedEdgeDriverPath -ine $edgeDriver.FullName) {
  throw 'The process-local PATH does not resolve the exact selected EdgeDriver.'
}
$edgeDriverVersion = Get-BoundedEdgeDriverVersion -FilePath $resolvedEdgeDriverPath
if ($edgeDriverVersion -cne $edgeDriver.VersionInfo.ProductVersion) {
  throw 'The process-local EdgeDriver version changed before desktop acceptance.'
}

function Add-OfflineRule {
  param([string]$Program, [string]$Label)
  $ruleName = "$rulePrefix $Label"
  New-NetFirewallRule -Name $ruleName -DisplayName $ruleName -Direction Outbound -Action Block `
    -Program $Program -RemoteAddress Internet -Profile Any -Enabled True | Out-Null
  [void]$ruleNames.Add($ruleName)
  $rule = Get-NetFirewallRule -Name $ruleName -ErrorAction Stop
  $address = $rule | Get-NetFirewallAddressFilter
  if ($rule.Enabled -ne 'True' -or $rule.Action -ne 'Block' -or
      $address.RemoteAddress -notcontains 'Internet') {
    throw 'The exact outbound-deny firewall rule was not active.'
  }
}

try {
  if (!(Get-Command New-NetFirewallRule -ErrorAction Stop) -or
      !(Get-Command Get-NetTCPConnection -ErrorAction Stop)) {
    throw 'Windows Firewall and TCP inspection commands are required for offline desktop acceptance.'
  }
  $profilesBefore = @(Get-NetFirewallProfile | Select-Object Name, Enabled)
  foreach ($profile in $profilesBefore) {
    if ($profile.Enabled.ToString() -cne 'True') {
      Set-NetFirewallProfile -Name $profile.Name -Enabled True
    }
  }

  $webViewClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  $webViewRegistryPaths = @(
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$webViewClientId",
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\EdgeUpdate\Clients\$webViewClientId",
    "Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\EdgeUpdate\Clients\$webViewClientId"
  )
  $activeWebViewVersionCandidates = [Collections.Generic.List[string]]::new()
  foreach ($registryPath in $webViewRegistryPaths) {
    if (Test-Path -LiteralPath $registryPath -PathType Container) {
      $properties = Get-ItemProperty -LiteralPath $registryPath -Name 'pv'
      if ($null -ne $properties.pv) {
        [void]$activeWebViewVersionCandidates.Add(([string]$properties.pv).Trim())
      }
    }
  }
  $activeWebViewVersions = @($activeWebViewVersionCandidates | Sort-Object -Unique)
  if ($activeWebViewVersions.Count -ne 1 -or
      $activeWebViewVersions[0] -cnotmatch '^\d+(?:\.\d+){3}$' -or
      $activeWebViewVersions[0] -cne $edgeDriverVersion) {
    throw 'The selected EdgeDriver does not match one registry-selected active WebView2 version.'
  }
  $activeWebViewVersion = [string]$activeWebViewVersions[0]

  $webViewRoots = @(
    "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application",
    "$env:ProgramFiles\Microsoft\EdgeWebView\Application"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }
  $webViewExecutables = @($webViewRoots | ForEach-Object {
    Get-ChildItem -LiteralPath $_ -Recurse -File -Filter 'msedgewebview2.exe'
  } | Select-Object -ExpandProperty FullName -Unique)
  if ($webViewExecutables.Count -eq 0) {
    throw 'No installed Microsoft WebView2 executable was available for the offline boundary.'
  }

  $activeWebViewCount = 0
  $webViewEvidence = foreach ($webViewPath in $webViewExecutables) {
    $webView = Get-Item -LiteralPath $webViewPath -Force
    $signature = Get-AuthenticodeSignature -LiteralPath $webView.FullName
    if ($webView.PSIsContainer -or
        ($webView.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $signature.Status -ne 'Valid' -or
        $signature.SignerCertificate.Subject -notmatch 'Microsoft') {
      throw 'An installed WebView2 executable was not validly signed by Microsoft.'
    }
    $matchesActiveVersion = (
      $webView.VersionInfo.ProductVersion -ceq $activeWebViewVersion -and
      $webView.Directory.Name -ceq $activeWebViewVersion
    )
    if ($matchesActiveVersion) {
      $activeWebViewCount += 1
    }
    [ordered]@{
      fileName = $webView.Name
      version = $webView.VersionInfo.ProductVersion
      matchesRegistrySelectedActiveVersion = $matchesActiveVersion
      sha256 = (Get-FileHash -LiteralPath $webView.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      signatureStatus = $signature.Status.ToString()
      signerSubject = $signature.SignerCertificate.Subject
    }
  }
  if ($activeWebViewCount -ne 1) {
    throw 'Expected exactly one signed executable for the registry-selected active WebView2 runtime.'
  }

  Add-OfflineRule -Program $application -Label 'application'
  Add-OfflineRule -Program $edgeDriver.FullName -Label 'edge-webdriver'
  for ($index = 0; $index -lt $webViewExecutables.Count; $index += 1) {
    Add-OfflineRule -Program $webViewExecutables[$index] -Label "webview-$index"
  }

  [ordered]@{
    scope = 'Exact production application, selected Microsoft EdgeDriver and installed Microsoft WebView2 executables; outbound Internet denied for the complete WDIO run'
    applicationFileName = [IO.Path]::GetFileName($application)
    applicationSha256 = (Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash.ToLowerInvariant()
    edgeDriver = [ordered]@{
      fileName = $edgeDriver.Name
      version = $edgeDriverVersion
      sha256 = (Get-FileHash -LiteralPath $edgeDriver.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      signatureStatus = $edgeDriverSignature.Status.ToString()
      signerSubject = $edgeDriverSignature.SignerCertificate.Subject
      processLocalPathResolutionCount = $resolvedEdgeDrivers.Count
      automaticDownloadDisabled = $true
    }
    firewallProfilesEnabledDuringRun = $true
    remoteAddressScope = 'Internet'
    activeRuleCount = $ruleNames.Count
    registrySelectedActiveWebViewVersion = $activeWebViewVersion
    webViewExecutables = @($webViewEvidence)
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $firewallEvidencePath -Encoding utf8

  $monitor = Start-Job -ScriptBlock {
    param($Application, $StopSentinel, $EvidencePath)
    $ErrorActionPreference = 'Stop'
    $tracked = [Collections.Generic.HashSet[int]]::new()
    $processNames = [Collections.Generic.HashSet[string]]::new()
    $loopbackListeners = [Collections.Generic.HashSet[string]]::new()
    $otherListeners = [Collections.Generic.HashSet[string]]::new()
    $remoteConnections = [Collections.Generic.HashSet[string]]::new()
    $samples = 0
    $applicationSamples = 0
    $monitorErrors = 0
    while (!(Test-Path -LiteralPath $StopSentinel)) {
      try {
        $allProcesses = @(Get-CimInstance Win32_Process)
        foreach ($candidate in $allProcesses) {
          if ($candidate.ExecutablePath -and
              [IO.Path]::GetFullPath($candidate.ExecutablePath) -ieq $Application) {
            [void]$tracked.Add([int]$candidate.ProcessId)
          }
        }
        $changed = $true
        while ($changed) {
          $changed = $false
          foreach ($candidate in $allProcesses) {
            if ($tracked.Contains([int]$candidate.ParentProcessId) -and
                !$tracked.Contains([int]$candidate.ProcessId)) {
              [void]$tracked.Add([int]$candidate.ProcessId)
              $changed = $true
            }
          }
        }
        $liveTracked = @($allProcesses | Where-Object {
          $tracked.Contains([int]$_.ProcessId)
        })
        if ($liveTracked.Count -gt 0) { $applicationSamples += 1 }
        foreach ($candidate in $liveTracked) {
          [void]$processNames.Add($candidate.Name.ToLowerInvariant())
        }
        foreach ($connection in @(Get-NetTCPConnection -ErrorAction Stop | Where-Object {
          $tracked.Contains([int]$_.OwningProcess)
        })) {
          if ($connection.State -eq 'Listen') {
            $listener = "$($connection.OwningProcess):$($connection.LocalAddress):$($connection.LocalPort)"
            if ($connection.LocalAddress -in @('127.0.0.1', '::1')) {
              [void]$loopbackListeners.Add($listener)
            } else {
              [void]$otherListeners.Add($listener)
            }
          }
          if ($connection.State -eq 'Established' -and
              $connection.RemoteAddress -notin @('127.0.0.1', '::1')) {
            [void]$remoteConnections.Add("$($connection.OwningProcess):$($connection.RemoteAddress):$($connection.RemotePort)")
          }
        }
        $samples += 1
      }
      catch {
        $monitorErrors += 1
      }
      Start-Sleep -Milliseconds 100
    }
    [ordered]@{
      scope = 'Continuous process-tree TCP sampling during production-binary WDIO; exact outbound Internet rules active separately'
      sampleIntervalMilliseconds = 100
      samples = $samples
      applicationSamples = $applicationSamples
      observedProcessNames = @($processNames | Sort-Object)
      testInfrastructureLoopbackListenerCount = $loopbackListeners.Count
      nonLoopbackListenerCount = $otherListeners.Count
      unexpectedRemoteConnectionCount = $remoteConnections.Count
      monitorErrorCount = $monitorErrors
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
  } -ArgumentList $application, $stopSentinel, $monitorEvidencePath

  & npm run e2e:desktop 2>&1 | Tee-Object -FilePath (Join-Path $evidenceRoot 'WDIO.log')
  $testExitCode = $LASTEXITCODE
}
finally {
  $cleanupFailures = [Collections.Generic.List[string]]::new()

  try {
    New-Item -ItemType File -Path $stopSentinel -Force -ErrorAction Stop | Out-Null
  }
  catch {
    [void]$cleanupFailures.Add('network-monitor-stop-signal')
  }

  if ($null -ne $monitor) {
    try {
      $stoppedMonitor = Wait-Job -Job $monitor -Timeout 30 -ErrorAction Stop
      if ($null -eq $stoppedMonitor) {
        [void]$cleanupFailures.Add('network-monitor-cleanup')
      }
    }
    catch {
      [void]$cleanupFailures.Add('network-monitor-cleanup')
    }
    try {
      Receive-Job -Job $monitor -ErrorAction Stop | Out-Null
    }
    catch {
      [void]$cleanupFailures.Add('network-monitor-cleanup')
    }
    try {
      Remove-Job -Job $monitor -Force -ErrorAction Stop
    }
    catch {
      [void]$cleanupFailures.Add('network-monitor-cleanup')
    }
  }

  foreach ($ruleName in $ruleNames) {
    try {
      Remove-NetFirewallRule -Name $ruleName -ErrorAction Stop
    }
    catch {
      [void]$cleanupFailures.Add('firewall-rule-remove')
    }
  }

  try {
    $remainingTaskRules = @(Get-NetFirewallRule -ErrorAction Stop | Where-Object {
      $_.Name -like "$rulePrefix*"
    })
    if ($remainingTaskRules.Count -ne 0) {
      [void]$cleanupFailures.Add('firewall-rule-verify')
    }
  }
  catch {
    [void]$cleanupFailures.Add('firewall-rule-verify')
  }

  foreach ($profile in $profilesBefore) {
    try {
      Set-NetFirewallProfile -Name $profile.Name -Enabled $profile.Enabled -ErrorAction Stop
    }
    catch {
      [void]$cleanupFailures.Add('firewall-profile-restore')
    }
    try {
      $restoredProfiles = @(Get-NetFirewallProfile -Name $profile.Name -ErrorAction Stop)
      if ($restoredProfiles.Count -ne 1 -or
          $restoredProfiles[0].Enabled.ToString() -cne $profile.Enabled.ToString()) {
        [void]$cleanupFailures.Add('firewall-profile-verify')
      }
    }
    catch {
      [void]$cleanupFailures.Add('firewall-profile-verify')
    }
  }

  try {
    if (Test-Path -LiteralPath $stopSentinel -ErrorAction Stop) {
      Remove-Item -LiteralPath $stopSentinel -Force -ErrorAction Stop
    }
  }
  catch {
    [void]$cleanupFailures.Add('network-monitor-sentinel-remove')
  }
  try {
    if (Test-Path -LiteralPath $stopSentinel -ErrorAction Stop) {
      [void]$cleanupFailures.Add('network-monitor-sentinel-verify')
    }
  }
  catch {
    [void]$cleanupFailures.Add('network-monitor-sentinel-verify')
  }

  if ($cleanupFailures.Count -ne 0) {
    $cleanupFailureLabels = @($cleanupFailures | Sort-Object -Unique)
    throw "Offline desktop cleanup failed: $($cleanupFailureLabels -join ', ')."
  }
}

if (!(Test-Path -LiteralPath $monitorEvidencePath -PathType Leaf)) {
  throw 'The continuous desktop network monitor produced no evidence.'
}
$networkEvidence = Get-Content -LiteralPath $monitorEvidencePath -Raw | ConvertFrom-Json
if ($networkEvidence.samples -le 0 -or $networkEvidence.applicationSamples -le 0) {
  throw 'The continuous desktop network monitor did not observe the application.'
}
$forbiddenDescendants = @($networkEvidence.observedProcessNames | Where-Object {
  $_ -match '^(?:node|cmd|powershell|pwsh|conhost)\.exe$'
})
if ($forbiddenDescendants.Count -ne 0) {
  throw 'The production desktop workflow launched a forbidden Node, command or terminal descendant.'
}
if ($networkEvidence.monitorErrorCount -ne 0 -or
    $networkEvidence.testInfrastructureLoopbackListenerCount -ne 0 -or
    $networkEvidence.nonLoopbackListenerCount -ne 0 -or
    $networkEvidence.unexpectedRemoteConnectionCount -ne 0) {
  throw 'The production desktop workflow violated the fail-closed process/network boundary.'
}
if ($testExitCode -ne 0) { exit $testExitCode }
