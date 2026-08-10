param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$ProductionBinaryPath,
  [Parameter(Mandatory = $true)][string]$EvidencePath
)

$ErrorActionPreference = 'Stop'
$productName = 'SWL Pricing and Inventory Control'
$applicationIdentifier = 'au.com.stanwoottonlocksmiths.swl-pricing'
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$productionBinary = (Resolve-Path -LiteralPath $ProductionBinaryPath).Path
$productionBinarySha256 = (Get-FileHash -LiteralPath $productionBinary -Algorithm SHA256).Hash.ToLowerInvariant()
$evidence = [IO.Path]::GetFullPath($EvidencePath)
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($evidence)) -Force | Out-Null

function Get-SwlStartMenuLinks {
  param([string]$Root)
  if (!(Test-Path -LiteralPath $Root -PathType Container)) { return @() }
  return @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter '*.lnk' | Where-Object {
    $_.BaseName -match 'SWL Pricing|Stan Wootton'
  })
}

function Get-SwlUninstallEntries {
  $root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  if (!(Test-Path -LiteralPath $root)) { return @() }
  return @(Get-ChildItem -LiteralPath $root | ForEach-Object {
    $entry = Get-ItemProperty -LiteralPath $_.PSPath
    if ($entry.DisplayName -eq $productName) {
      [pscustomobject]@{
        RegistryPath = $_.PSPath
        InstallLocation = [string]$entry.InstallLocation
      }
    }
  })
}

function Get-DataManifest {
  param([string]$Root)
  if (!(Test-Path -LiteralPath $Root -PathType Container)) { return @() }
  return @(Get-ChildItem -LiteralPath $Root -Recurse -File | Sort-Object FullName | ForEach-Object {
    [ordered]@{
      relativePath = [IO.Path]::GetRelativePath($Root, $_.FullName)
      bytes = $_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  })
}

function Test-LoopbackAddress {
  param([string]$Address)
  return $Address -in @('127.0.0.1', '::1', '0.0.0.0', '::')
}

function Get-SwlDatabaseEvidence {
  $output = @(& cargo run --quiet --locked --manifest-path src-tauri/Cargo.toml --features acceptance-tools --bin swl-db-acceptance 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw 'The scoped database acceptance helper failed.'
  }
  try {
    return ($output -join [Environment]::NewLine) | ConvertFrom-Json
  }
  catch {
    throw 'The scoped database acceptance helper returned invalid evidence.'
  }
}

function Assert-RepresentativeSyntheticEvidence {
  param($Evidence)
  if ($Evidence.integrity -ne 'ok' -or
      $Evidence.catalogueItems -le 0 -or
      $Evidence.approvals -le 0 -or
      $Evidence.priceHistory -le 0) {
    throw 'Representative synthetic catalogue, approval and price-history records are required.'
  }
  $catalogueIds = @($Evidence.catalogueItemIds)
  $approvalIds = @($Evidence.approvalIds)
  $approvalItemIds = @($Evidence.approvalItemIds)
  $historyIds = @($Evidence.priceHistoryIds)
  $historyItemIds = @($Evidence.priceHistoryItemIds)
  $historyApprovalIds = @($Evidence.priceHistoryApprovalIds)
  if ($catalogueIds.Count -ne $Evidence.catalogueItems -or
      $approvalIds.Count -ne $Evidence.approvals -or
      $approvalItemIds.Count -ne $Evidence.approvals -or
      $historyIds.Count -ne $Evidence.priceHistory -or
      $historyItemIds.Count -ne $Evidence.priceHistory -or
      $historyApprovalIds.Count -ne $Evidence.priceHistory) {
    throw 'The acceptance helper record counts do not match its exact synthetic identifier lists.'
  }
  if (@($catalogueIds | Sort-Object -Unique).Count -ne $catalogueIds.Count -or
      @($approvalIds | Sort-Object -Unique).Count -ne $approvalIds.Count -or
      @($historyIds | Sort-Object -Unique).Count -ne $historyIds.Count) {
    throw 'The acceptance helper found duplicate catalogue, approval or price-history identifiers.'
  }
  foreach ($itemId in @($approvalItemIds + $historyItemIds)) {
    if ($catalogueIds -notcontains $itemId) {
      throw 'Approval or price-history evidence references a missing catalogue identifier.'
    }
  }
  foreach ($approvalId in $historyApprovalIds) {
    if ($approvalIds -notcontains $approvalId) {
      throw 'Price-history evidence references a missing approval identifier.'
    }
  }
}

$installerSignature = Get-AuthenticodeSignature -LiteralPath $installer
if ($installerSignature.Status -ne 'NotSigned') {
  throw "The internal-evaluation installer must be unsigned; actual status: $($installerSignature.Status)."
}
if (!(Get-Command Get-NetTCPConnection -ErrorAction Stop)) {
  throw 'Get-NetTCPConnection is required for the installed-process network boundary check.'
}

$startMenuRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$linksBefore = @(Get-SwlStartMenuLinks -Root $startMenuRoot | ForEach-Object { $_.FullName })
$uninstallEntriesBefore = @(Get-SwlUninstallEntries | ForEach-Object { $_.RegistryPath })
$dataRoot = Join-Path $env:LOCALAPPDATA $applicationIdentifier
if (!(Test-Path -LiteralPath $dataRoot -PathType Container)) {
  throw 'The production-binary workflow did not leave its task-created synthetic data profile.'
}
$preinstallDataManifest = @(Get-DataManifest -Root $dataRoot)
if ($preinstallDataManifest.Count -eq 0) {
  throw 'The pre-install synthetic application-data manifest is empty.'
}
$preinstallDataManifestJson = $preinstallDataManifest | ConvertTo-Json -Depth 5 -Compress
$preinstallDatabaseEvidence = Get-SwlDatabaseEvidence
Assert-RepresentativeSyntheticEvidence -Evidence $preinstallDatabaseEvidence
$preinstallDatabaseEvidenceJson = $preinstallDatabaseEvidence | ConvertTo-Json -Depth 7 -Compress

$installRoot = Join-Path $env:RUNNER_TEMP ("swl-installed-" + [Guid]::NewGuid().ToString('N'))
# NSIS requires /D to be the final, unquoted argument. RUNNER_TEMP paths on the
# hosted runner contain no spaces; reject rather than silently changing syntax.
if ($installRoot.Contains(' ')) { throw 'The scripted NSIS destination contains a space.' }
$install = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installRoot") -Wait -PassThru
if ($install.ExitCode -ne 0) throw "Silent current-user installation failed with exit code $($install.ExitCode)."
$manifestImmediatelyAfterInstall = @(Get-DataManifest -Root $dataRoot) | ConvertTo-Json -Depth 5 -Compress
if ($manifestImmediatelyAfterInstall -ne $preinstallDataManifestJson) {
  throw 'Installation changed the existing synthetic application-data manifest before launch.'
}

$applicationExecutables = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Filter '*.exe' | Where-Object {
  $_.Name -notmatch '^unins|uninstall|WebView2|MicrosoftEdge'
})
if ($applicationExecutables.Count -ne 1) {
  throw "Expected exactly one installed application executable; found $($applicationExecutables.Count)."
}
$application = $applicationExecutables[0]
$installedApplicationSha256 = (Get-FileHash -LiteralPath $application.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($installedApplicationSha256 -ne $productionBinarySha256) {
  throw 'The installed executable is not byte-identical to the production binary driven by WDIO.'
}
$applicationSignature = Get-AuthenticodeSignature -LiteralPath $application.FullName
if ($applicationSignature.Status -ne 'NotSigned') {
  throw "The internal-evaluation application executable must be unsigned; actual status: $($applicationSignature.Status)."
}

$forbiddenPayload = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File | Where-Object {
  $relative = [IO.Path]::GetRelativePath($installRoot, $_.FullName)
  $parts = $relative -split '[\\/]'
  $parts -contains 'server' -or $parts -contains 'node_modules' -or
  $_.Extension -in @('.cmd', '.bat', '.ps1') -or
  $_.Name -match '^(?:node|npm|npx)(?:\.exe|\.cmd)?$' -or
  $_.Name -match 'wdio|webdriver|tauri-driver|swl-db-acceptance|swl-legacy-seed'
})
if ($forbiddenPayload.Count -ne 0) {
  throw 'The installed production payload contains a command file, Node/server payload or test driver.'
}
$applicationBytes = [IO.File]::ReadAllBytes($application.FullName)
$applicationAscii = [Text.Encoding]::ASCII.GetString($applicationBytes)
$applicationUnicode = [Text.Encoding]::Unicode.GetString($applicationBytes)
foreach ($driverMarker in @('tauri-plugin-wdio-webdriver', 'tauri-plugin-wdio', 'tauri-driver', '@wdio/', 'webdriverio')) {
  if ($applicationAscii.Contains($driverMarker, [StringComparison]::OrdinalIgnoreCase) -or
      $applicationUnicode.Contains($driverMarker, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The installed production executable contains a test-driver marker.'
  }
}

$linksAfter = @(Get-SwlStartMenuLinks -Root $startMenuRoot | Where-Object {
  $linksBefore -notcontains $_.FullName
})
$shell = New-Object -ComObject WScript.Shell
$matchingLinks = @($linksAfter | Where-Object {
  $shortcut = $shell.CreateShortcut($_.FullName)
  [IO.Path]::GetFullPath($shortcut.TargetPath) -ieq [IO.Path]::GetFullPath($application.FullName)
})
if ($matchingLinks.Count -ne 1) {
  throw "Expected exactly one new Start Menu link targeting the application; found $($matchingLinks.Count)."
}
$startMenuLink = $matchingLinks[0]

$uninstallEntriesAfter = @(Get-SwlUninstallEntries | Where-Object {
  $uninstallEntriesBefore -notcontains $_.RegistryPath
})
if ($uninstallEntriesAfter.Count -ne 1) {
  throw "Expected exactly one new current-user uninstall registration; found $($uninstallEntriesAfter.Count)."
}
$uninstallRegistryPath = $uninstallEntriesAfter[0].RegistryPath
if ([string]::IsNullOrWhiteSpace($uninstallEntriesAfter[0].InstallLocation) -or
    [IO.Path]::GetFullPath($uninstallEntriesAfter[0].InstallLocation) -ine [IO.Path]::GetFullPath($installRoot)) {
  throw 'The current-user uninstall registration does not identify the exact installation directory.'
}

$processesBeforeLaunch = @(Get-CimInstance Win32_Process)
$applicationIdsBefore = @($processesBeforeLaunch | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath -ieq $application.FullName
} | ForEach-Object { [int]$_.ProcessId })
$externalBrowserNames = @('chrome.exe', 'firefox.exe', 'msedge.exe', 'brave.exe', 'opera.exe')
$browserIdsBefore = @($processesBeforeLaunch | Where-Object {
  $externalBrowserNames -contains $_.Name.ToLowerInvariant()
} | ForEach-Object { [int]$_.ProcessId })

# Launch the installed application through the exact Start Menu link.
Start-Process -FilePath $startMenuLink.FullName | Out-Null
$launchDeadline = (Get-Date).AddSeconds(30)
$rootProcess = $null
do {
  Start-Sleep -Milliseconds 250
  $rootProcess = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath -ieq $application.FullName -and
    $applicationIdsBefore -notcontains [int]$_.ProcessId
  }) | Select-Object -First 1
} while ($null -eq $rootProcess -and (Get-Date) -lt $launchDeadline)
if ($null -eq $rootProcess) { throw 'The Start Menu link did not launch the installed desktop executable.' }

$rootProcessId = [int]$rootProcess.ProcessId
$trackedIds = [Collections.Generic.HashSet[int]]::new()
$observedProcesses = @{}
$forbiddenProcesses = [Collections.Generic.HashSet[string]]::new()
$newExternalBrowsers = [Collections.Generic.HashSet[string]]::new()
$listenerEvidence = [Collections.Generic.List[object]]::new()
$remoteEvidence = [Collections.Generic.List[object]]::new()
$windowTitle = $null
$sampleCount = 80
$sampleIntervalMilliseconds = 250

for ($sample = 0; $sample -lt $sampleCount; $sample += 1) {
  $allProcesses = @(Get-CimInstance Win32_Process)
  [void]$trackedIds.Add($rootProcessId)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($candidate in $allProcesses) {
      if ($trackedIds.Contains([int]$candidate.ParentProcessId) -and !$trackedIds.Contains([int]$candidate.ProcessId)) {
        [void]$trackedIds.Add([int]$candidate.ProcessId)
        $changed = $true
      }
    }
  }

  foreach ($candidate in $allProcesses) {
    $candidateProcessId = [int]$candidate.ProcessId
    if ($trackedIds.Contains($candidateProcessId)) {
      $observedProcesses[$candidateProcessId] = $candidate.Name
      if ($candidate.Name -match '^(?:node|cmd|powershell|pwsh|conhost)\.exe$') {
        [void]$forbiddenProcesses.Add($candidate.Name.ToLowerInvariant())
      }
    }
    if ($externalBrowserNames -contains $candidate.Name.ToLowerInvariant() -and $browserIdsBefore -notcontains $candidateProcessId) {
      [void]$newExternalBrowsers.Add($candidate.Name.ToLowerInvariant())
    }
  }

  $connections = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object {
    $trackedIds.Contains([int]$_.OwningProcess)
  })
  foreach ($connection in $connections) {
    if ($connection.State -eq 'Listen') {
      $listenerEvidence.Add([ordered]@{
        processId = [int]$connection.OwningProcess
        localAddress = $connection.LocalAddress
        localPort = $connection.LocalPort
      })
    }
    if ($connection.State -eq 'Established' -and !(Test-LoopbackAddress $connection.RemoteAddress)) {
      $remoteEvidence.Add([ordered]@{
        processId = [int]$connection.OwningProcess
        remoteAddress = $connection.RemoteAddress
        remotePort = $connection.RemotePort
      })
    }
  }

  $nativeProcess = Get-Process -Id $rootProcessId -ErrorAction SilentlyContinue
  if (!$nativeProcess) {
    throw 'The installed application exited during launch sampling.'
  }
  if ($nativeProcess.MainWindowHandle -ne 0) {
    $windowTitle = $nativeProcess.MainWindowTitle
  }
  Start-Sleep -Milliseconds $sampleIntervalMilliseconds
}

if ($windowTitle -cne $productName) {
  throw 'The installed process did not expose the expected native application window.'
}
if ($forbiddenProcesses.Count -ne 0) {
  throw 'The installed application launched a forbidden Node, command or terminal child process.'
}
if ($newExternalBrowsers.Count -ne 0) {
  throw 'The installed application launched an external browser without an operator link action.'
}
if ($listenerEvidence.Count -ne 0) {
  throw 'The installed application or one of its descendants opened a TCP listener.'
}
if ($remoteEvidence.Count -ne 0) {
  throw 'The installed application made an unexpected non-loopback connection during launch sampling.'
}

$database = Join-Path $dataRoot 'swl-pricing.sqlite3'
if (!(Test-Path -LiteralPath $database -PathType Leaf)) {
  throw 'The installed application did not create its SQLite database in the stable local-data directory.'
}

foreach ($trackedId in @($trackedIds)) {
  Stop-Process -Id $trackedId -Force -ErrorAction SilentlyContinue
}
$stopDeadline = (Get-Date).AddSeconds(30)
do {
  $stillRunning = @($trackedIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  if ($stillRunning.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $stopDeadline)
if ($stillRunning.Count -ne 0) { throw 'An installed application process did not stop before uninstall.' }

$dataManifestBefore = @(Get-DataManifest -Root $dataRoot)
if ($dataManifestBefore.Count -eq 0) { throw 'The application local-data manifest is unexpectedly empty.' }
$dataManifestBeforeJson = $dataManifestBefore | ConvertTo-Json -Depth 5 -Compress
$databaseEvidenceBefore = Get-SwlDatabaseEvidence
$databaseEvidenceBeforeJson = $databaseEvidenceBefore | ConvertTo-Json -Depth 7 -Compress
Assert-RepresentativeSyntheticEvidence -Evidence $databaseEvidenceBefore
if ($databaseEvidenceBeforeJson -ne $preinstallDatabaseEvidenceJson) {
  throw 'First installed launch changed the exact synthetic identifiers, schema or record counts.'
}

$uninstallers = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Filter '*.exe' | Where-Object {
  $_.Name -match '^unins|uninstall'
})
if ($uninstallers.Count -ne 1) throw "Expected one uninstaller; found $($uninstallers.Count)."
$uninstall = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList '/S' -Wait -PassThru
if ($uninstall.ExitCode -ne 0) throw "Silent uninstall failed with exit code $($uninstall.ExitCode)."

$uninstallDeadline = (Get-Date).AddSeconds(45)
do {
  $linkRemains = Test-Path -LiteralPath $startMenuLink.FullName
  $registrationRemains = Test-Path -LiteralPath $uninstallRegistryPath
  $installRemains = Test-Path -LiteralPath $installRoot
  if (!$linkRemains -and !$registrationRemains -and !$installRemains) { break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $uninstallDeadline)
if ($installRemains) { throw 'Uninstall left application binaries or its installation directory behind.' }
if ($linkRemains) { throw 'Uninstall left the application Start Menu entry behind.' }
if ($registrationRemains) { throw 'Uninstall left the current-user uninstall registration behind.' }

if (!(Test-Path -LiteralPath $dataRoot -PathType Container)) {
  throw 'Uninstall removed the application business-data directory.'
}
$dataManifestAfter = @(Get-DataManifest -Root $dataRoot)
$dataManifestAfterJson = $dataManifestAfter | ConvertTo-Json -Depth 5 -Compress
if ($dataManifestAfterJson -ne $dataManifestBeforeJson) {
  throw 'Uninstall changed the preserved application-data manifest.'
}
$databaseEvidenceAfterUninstall = Get-SwlDatabaseEvidence
if (($databaseEvidenceAfterUninstall | ConvertTo-Json -Depth 7 -Compress) -ne $databaseEvidenceBeforeJson) {
  throw 'Uninstall changed the exact database schema or record counts.'
}

# Reinstall the same current build and prove that installer registration and the
# complete application-data byte manifest survive launch and a second uninstall.
$linksBeforeReinstall = @(Get-SwlStartMenuLinks -Root $startMenuRoot | ForEach-Object { $_.FullName })
$entriesBeforeReinstall = @(Get-SwlUninstallEntries | ForEach-Object { $_.RegistryPath })
$reinstall = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installRoot") -Wait -PassThru
if ($reinstall.ExitCode -ne 0) throw "Silent reinstall failed with exit code $($reinstall.ExitCode)."

$reinstalledExecutables = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Filter '*.exe' | Where-Object {
  $_.Name -notmatch '^unins|uninstall|WebView2|MicrosoftEdge'
})
if ($reinstalledExecutables.Count -ne 1) {
  throw "Expected exactly one reinstalled application executable; found $($reinstalledExecutables.Count)."
}
$reinstalledApplication = $reinstalledExecutables[0]
$reinstalledApplicationSha256 = (Get-FileHash -LiteralPath $reinstalledApplication.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($reinstalledApplicationSha256 -ne $productionBinarySha256) {
  throw 'The reinstalled executable is not byte-identical to the production binary driven by WDIO.'
}
$reinstalledSignature = Get-AuthenticodeSignature -LiteralPath $reinstalledApplication.FullName
if ($reinstalledSignature.Status -ne 'NotSigned') {
  throw "The reinstalled internal-evaluation executable must be unsigned; actual status: $($reinstalledSignature.Status)."
}
$reinstalledForbiddenPayload = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File | Where-Object {
  $relative = [IO.Path]::GetRelativePath($installRoot, $_.FullName)
  $parts = $relative -split '[\\/]'
  $parts -contains 'server' -or $parts -contains 'node_modules' -or
  $_.Extension -in @('.cmd', '.bat', '.ps1') -or
  $_.Name -match '^(?:node|npm|npx)(?:\.exe|\.cmd)?$' -or
  $_.Name -match 'wdio|webdriver|tauri-driver|swl-db-acceptance|swl-legacy-seed'
})
if ($reinstalledForbiddenPayload.Count -ne 0) {
  throw 'The reinstalled production payload contains a command file, Node/server payload or test driver.'
}

$reinstalledBytes = [IO.File]::ReadAllBytes($reinstalledApplication.FullName)
$reinstalledAscii = [Text.Encoding]::ASCII.GetString($reinstalledBytes)
$reinstalledUnicode = [Text.Encoding]::Unicode.GetString($reinstalledBytes)
foreach ($driverMarker in @('tauri-plugin-wdio-webdriver', 'tauri-plugin-wdio', 'tauri-driver', '@wdio/', 'webdriverio')) {
  if ($reinstalledAscii.Contains($driverMarker, [StringComparison]::OrdinalIgnoreCase) -or
      $reinstalledUnicode.Contains($driverMarker, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The reinstalled production executable contains a test-driver marker.'
  }
}

$reinstalledLinks = @(Get-SwlStartMenuLinks -Root $startMenuRoot | Where-Object {
  $linksBeforeReinstall -notcontains $_.FullName
})
$matchingReinstalledLinks = @($reinstalledLinks | Where-Object {
  $shortcut = $shell.CreateShortcut($_.FullName)
  [IO.Path]::GetFullPath($shortcut.TargetPath) -ieq [IO.Path]::GetFullPath($reinstalledApplication.FullName)
})
if ($matchingReinstalledLinks.Count -ne 1) {
  throw "Expected one recreated Start Menu link; found $($matchingReinstalledLinks.Count)."
}
$reinstalledLink = $matchingReinstalledLinks[0]
$reinstalledEntries = @(Get-SwlUninstallEntries | Where-Object {
  $entriesBeforeReinstall -notcontains $_.RegistryPath
})
if ($reinstalledEntries.Count -ne 1) {
  throw "Expected one recreated current-user uninstall registration; found $($reinstalledEntries.Count)."
}
$reinstalledRegistryPath = $reinstalledEntries[0].RegistryPath
if ([string]::IsNullOrWhiteSpace($reinstalledEntries[0].InstallLocation) -or
    [IO.Path]::GetFullPath($reinstalledEntries[0].InstallLocation) -ine [IO.Path]::GetFullPath($installRoot)) {
  throw 'The recreated current-user registration has the wrong installation directory.'
}

$manifestImmediatelyAfterReinstall = @(Get-DataManifest -Root $dataRoot) | ConvertTo-Json -Depth 5 -Compress
if ($manifestImmediatelyAfterReinstall -ne $dataManifestBeforeJson) {
  throw 'Reinstall changed the preserved application-data manifest before launch.'
}

$processesBeforeReopen = @(Get-CimInstance Win32_Process)
$reinstalledIdsBefore = @($processesBeforeReopen | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath -ieq $reinstalledApplication.FullName
} | ForEach-Object { [int]$_.ProcessId })
$browserIdsBeforeReopen = @($processesBeforeReopen | Where-Object {
  $externalBrowserNames -contains $_.Name.ToLowerInvariant()
} | ForEach-Object { [int]$_.ProcessId })
Start-Process -FilePath $reinstalledLink.FullName | Out-Null
$reopenDeadline = (Get-Date).AddSeconds(30)
$reopenedRoot = $null
do {
  Start-Sleep -Milliseconds 250
  $reopenedRoot = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath -ieq $reinstalledApplication.FullName -and
    $reinstalledIdsBefore -notcontains [int]$_.ProcessId
  }) | Select-Object -First 1
} while ($null -eq $reopenedRoot -and (Get-Date) -lt $reopenDeadline)
if ($null -eq $reopenedRoot) { throw 'The recreated Start Menu link did not launch the application.' }

$reopenedRootId = [int]$reopenedRoot.ProcessId
$reopenedTrackedIds = [Collections.Generic.HashSet[int]]::new()
$reopenedProcesses = @{}
$reopenedForbiddenProcesses = [Collections.Generic.HashSet[string]]::new()
$reopenedExternalBrowsers = [Collections.Generic.HashSet[string]]::new()
$reopenedListeners = [Collections.Generic.List[object]]::new()
$reopenedRemoteConnections = [Collections.Generic.List[object]]::new()
$reopenedWindowTitle = $null
for ($sample = 0; $sample -lt $sampleCount; $sample += 1) {
  $allProcesses = @(Get-CimInstance Win32_Process)
  [void]$reopenedTrackedIds.Add($reopenedRootId)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($candidate in $allProcesses) {
      if ($reopenedTrackedIds.Contains([int]$candidate.ParentProcessId) -and !$reopenedTrackedIds.Contains([int]$candidate.ProcessId)) {
        [void]$reopenedTrackedIds.Add([int]$candidate.ProcessId)
        $changed = $true
      }
    }
  }
  foreach ($candidate in $allProcesses) {
    $candidateProcessId = [int]$candidate.ProcessId
    if ($reopenedTrackedIds.Contains($candidateProcessId)) {
      $reopenedProcesses[$candidateProcessId] = $candidate.Name
      if ($candidate.Name -match '^(?:node|cmd|powershell|pwsh|conhost)\.exe$') {
        [void]$reopenedForbiddenProcesses.Add($candidate.Name.ToLowerInvariant())
      }
    }
    if ($externalBrowserNames -contains $candidate.Name.ToLowerInvariant() -and $browserIdsBeforeReopen -notcontains $candidateProcessId) {
      [void]$reopenedExternalBrowsers.Add($candidate.Name.ToLowerInvariant())
    }
  }
  $connections = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object {
    $reopenedTrackedIds.Contains([int]$_.OwningProcess)
  })
  foreach ($connection in $connections) {
    if ($connection.State -eq 'Listen') { $reopenedListeners.Add($connection) }
    if ($connection.State -eq 'Established' -and !(Test-LoopbackAddress $connection.RemoteAddress)) {
      $reopenedRemoteConnections.Add($connection)
    }
  }
  $nativeProcess = Get-Process -Id $reopenedRootId -ErrorAction SilentlyContinue
  if (!$nativeProcess) {
    throw 'The reinstalled application exited during launch sampling.'
  }
  if ($nativeProcess.MainWindowHandle -ne 0) {
    $reopenedWindowTitle = $nativeProcess.MainWindowTitle
  }
  Start-Sleep -Milliseconds $sampleIntervalMilliseconds
}
if ($reopenedWindowTitle -cne $productName) {
  throw 'The reinstalled process did not expose the expected native application window.'
}
if ($reopenedForbiddenProcesses.Count -ne 0 -or $reopenedExternalBrowsers.Count -ne 0 -or
    $reopenedListeners.Count -ne 0 -or $reopenedRemoteConnections.Count -ne 0) {
  throw 'The reinstalled application violated a process, browser, listener or network boundary.'
}
foreach ($trackedId in @($reopenedTrackedIds)) {
  Stop-Process -Id $trackedId -Force -ErrorAction SilentlyContinue
}
$reopenStopDeadline = (Get-Date).AddSeconds(30)
do {
  $reopenedStillRunning = @($reopenedTrackedIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  if ($reopenedStillRunning.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $reopenStopDeadline)
if ($reopenedStillRunning.Count -ne 0) { throw 'A reinstalled application process did not stop.' }

$dataManifestAfterReopen = @(Get-DataManifest -Root $dataRoot)
if ($dataManifestAfterReopen.Count -eq 0) {
  throw 'Opening the reinstalled application left an empty application-data directory.'
}
$dataManifestAfterReopenJson = $dataManifestAfterReopen | ConvertTo-Json -Depth 5 -Compress
$databaseEvidenceAfterReopen = Get-SwlDatabaseEvidence
if (($databaseEvidenceAfterReopen | ConvertTo-Json -Depth 7 -Compress) -ne $databaseEvidenceBeforeJson) {
  throw 'Reinstall or reopen changed the exact database schema or record counts.'
}

$secondUninstallers = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Filter '*.exe' | Where-Object {
  $_.Name -match '^unins|uninstall'
})
if ($secondUninstallers.Count -ne 1) { throw "Expected one reinstalled uninstaller; found $($secondUninstallers.Count)." }
$secondUninstall = Start-Process -FilePath $secondUninstallers[0].FullName -ArgumentList '/S' -Wait -PassThru
if ($secondUninstall.ExitCode -ne 0) throw "Second silent uninstall failed with exit code $($secondUninstall.ExitCode)."
$secondUninstallDeadline = (Get-Date).AddSeconds(45)
do {
  $reinstalledLinkRemains = Test-Path -LiteralPath $reinstalledLink.FullName
  $reinstalledRegistrationRemains = Test-Path -LiteralPath $reinstalledRegistryPath
  $reinstalledInstallRemains = Test-Path -LiteralPath $installRoot
  if (!$reinstalledLinkRemains -and !$reinstalledRegistrationRemains -and !$reinstalledInstallRemains) { break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $secondUninstallDeadline)
if ($reinstalledLinkRemains -or $reinstalledRegistrationRemains -or $reinstalledInstallRemains) {
  throw 'Second uninstall did not remove all binaries, Start Menu and current-user registration state.'
}
$finalDataManifestJson = @(Get-DataManifest -Root $dataRoot) | ConvertTo-Json -Depth 5 -Compress
if ($finalDataManifestJson -ne $dataManifestAfterReopenJson) {
  throw 'Second uninstall changed the preserved application-data manifest.'
}
$databaseEvidenceAfterSecondUninstall = Get-SwlDatabaseEvidence
if (($databaseEvidenceAfterSecondUninstall | ConvertTo-Json -Depth 7 -Compress) -ne $databaseEvidenceBeforeJson) {
  throw 'Second uninstall changed the exact database schema or record counts.'
}

[ordered]@{
  scope = 'GitHub-hosted Windows Server scripted smoke; not interactive Windows 10/11 acceptance'
  runnerPrincipalIsAdministrator = [Security.Principal.WindowsPrincipal]::new(
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  sampleIntervalMilliseconds = $sampleIntervalMilliseconds
  sampleCount = $sampleCount
  installerSignature = $installerSignature.Status.ToString()
  installedExecutableSignature = $applicationSignature.Status.ToString()
  installedExecutable = $application.Name
  productionBinarySha256 = $productionBinarySha256
  installedExecutableSha256 = $installedApplicationSha256
  reinstalledExecutableSha256 = $reinstalledApplicationSha256
  installedExecutableMatchesWdioProductionBinary = $true
  reinstalledExecutableMatchesWdioProductionBinary = $true
  launchedFromStartMenu = $true
  startMenuLink = [IO.Path]::GetRelativePath($startMenuRoot, $startMenuLink.FullName)
  currentUserUninstallRegistration = $true
  installedDriverMarkerCount = 0
  nativeWindowTitle = $windowTitle
  observedProcessNames = @($observedProcesses.Values | Sort-Object -Unique)
  forbiddenChildProcessCount = $forbiddenProcesses.Count
  automaticExternalBrowserCount = $newExternalBrowsers.Count
  tcpListenerCount = $listenerEvidence.Count
  unexpectedRemoteConnectionCount = $remoteEvidence.Count
  localDataIdentifier = $applicationIdentifier
  representativeSyntheticData = $true
  preinstallLocalDataFileManifest = $preinstallDataManifest
  preinstallDatabaseIntegrityCountsAndIds = $preinstallDatabaseEvidence
  installPreservedExactDataManifestBeforeLaunch = $true
  firstLaunchPreservedExactDatabaseCountsAndIds = $true
  localDataFileManifest = $dataManifestBefore
  databaseIntegrityAndCounts = $databaseEvidenceBefore
  uninstallRemovedInstallDirectory = $true
  uninstallRemovedStartMenuEntry = $true
  uninstallRemovedCurrentUserRegistration = $true
  uninstallPreservedDataManifest = $true
  reinstallSucceeded = $true
  reinstallRecreatedStartMenuEntry = $true
  reinstallRecreatedCurrentUserRegistration = $true
  reinstallNativeWindowTitle = $reopenedWindowTitle
  reinstallObservedProcessNames = @($reopenedProcesses.Values | Sort-Object -Unique)
  reinstallForbiddenChildProcessCount = $reopenedForbiddenProcesses.Count
  reinstallAutomaticExternalBrowserCount = $reopenedExternalBrowsers.Count
  reinstallTcpListenerCount = $reopenedListeners.Count
  reinstallUnexpectedRemoteConnectionCount = $reopenedRemoteConnections.Count
  reinstallPreservedExactDataManifestBeforeLaunch = $true
  reinstallRetainedNonemptyApplicationDataAfterLaunch = $true
  reinstallPreservedExactDatabaseCountsAndHistory = $true
  secondUninstallPreservedExactDataManifest = $true
  secondUninstallPreservedExactDatabaseCountsAndHistory = $true
} | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $evidence -Encoding utf8
