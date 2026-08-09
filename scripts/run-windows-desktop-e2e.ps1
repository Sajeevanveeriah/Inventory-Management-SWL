param(
  [Parameter(Mandatory = $true)][string]$ApplicationPath,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory
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

function Add-OfflineRule {
  param([string]$Program, [string]$Label)
  $ruleName = "$rulePrefix $Label"
  New-NetFirewallRule -Name $ruleName -DisplayName $ruleName -Direction Outbound -Action Block `
    -Program $Program -RemoteAddress Internet -Profile Any -Enabled True | Out-Null
  $rule = Get-NetFirewallRule -Name $ruleName -ErrorAction Stop
  $address = $rule | Get-NetFirewallAddressFilter
  if ($rule.Enabled -ne 'True' -or $rule.Action -ne 'Block' -or
      $address.RemoteAddress -notcontains 'Internet') {
    throw 'The exact outbound-deny firewall rule was not active.'
  }
  $ruleNames.Add($ruleName)
}

try {
  if (!(Get-Command New-NetFirewallRule -ErrorAction Stop) -or
      !(Get-Command Get-NetTCPConnection -ErrorAction Stop)) {
    throw 'Windows Firewall and TCP inspection commands are required for offline desktop acceptance.'
  }
  $profilesBefore = @(Get-NetFirewallProfile | Select-Object Name, Enabled)
  foreach ($profile in $profilesBefore) {
    if (!$profile.Enabled) {
      Set-NetFirewallProfile -Name $profile.Name -Enabled True
    }
  }

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

  $webViewEvidence = foreach ($webView in $webViewExecutables) {
    $signature = Get-AuthenticodeSignature -LiteralPath $webView
    if ($signature.Status -ne 'Valid' -or
        $signature.SignerCertificate.Subject -notmatch 'Microsoft') {
      throw 'An installed WebView2 executable was not validly signed by Microsoft.'
    }
    [ordered]@{
      fileName = [IO.Path]::GetFileName($webView)
      version = (Get-Item -LiteralPath $webView).VersionInfo.ProductVersion
      sha256 = (Get-FileHash -LiteralPath $webView -Algorithm SHA256).Hash.ToLowerInvariant()
      signatureStatus = $signature.Status.ToString()
      signerSubject = $signature.SignerCertificate.Subject
    }
  }

  Add-OfflineRule -Program $application -Label 'application'
  for ($index = 0; $index -lt $webViewExecutables.Count; $index += 1) {
    Add-OfflineRule -Program $webViewExecutables[$index] -Label "webview-$index"
  }

  [ordered]@{
    scope = 'Exact production application and installed Microsoft WebView2 executables; outbound Internet denied for the complete WDIO run'
    applicationFileName = [IO.Path]::GetFileName($application)
    applicationSha256 = (Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash.ToLowerInvariant()
    firewallProfilesEnabledDuringRun = $true
    remoteAddressScope = 'Internet'
    activeRuleCount = $ruleNames.Count
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
  New-Item -ItemType File -Path $stopSentinel -Force | Out-Null
  if ($null -ne $monitor) {
    Wait-Job -Job $monitor -Timeout 30 | Out-Null
    Receive-Job -Job $monitor -ErrorAction SilentlyContinue | Out-Null
    Remove-Job -Job $monitor -Force -ErrorAction SilentlyContinue
  }
  foreach ($ruleName in $ruleNames) {
    Remove-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
  }
  foreach ($profile in $profilesBefore) {
    Set-NetFirewallProfile -Name $profile.Name -Enabled ([bool]$profile.Enabled)
  }
  Remove-Item -LiteralPath $stopSentinel -Force -ErrorAction SilentlyContinue
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
