param(
  [Parameter(Mandatory = $true)][string]$LegacyInstallerPath,
  [Parameter(Mandatory = $true)][string]$CurrentInstallerPath,
  [Parameter(Mandatory = $true)][string]$DatabaseAcceptanceBinaryPath,
  [Parameter(Mandatory = $true)][string]$LegacySeedBinaryPath,
  [Parameter(Mandatory = $true)][string]$EvidencePath
)

$ErrorActionPreference = 'Stop'
$applicationIdentifier = 'au.com.stanwoottonlocksmiths.swl-pricing'
$productName = 'SWL Pricing and Inventory Control'
$legacyVersion = '1.0.0'
$currentVersion = '1.2.0'
# Derive the identity patterns from the versions above. Writing the version a
# second time as a literal regex is how a bump silently half-lands: the message
# said 1.2.0 while the pattern still demanded 1.1.0, and the mismatch only
# surfaced fifty minutes into a Windows CI job.
$legacyVersionPattern = '^' + [regex]::Escape($legacyVersion) + '(?:\.0)?$'
$currentVersionPattern = '^' + [regex]::Escape($currentVersion) + '(?:\.0)?$'
$legacyInstaller = Get-Item -LiteralPath (Resolve-Path -LiteralPath $LegacyInstallerPath).Path
$currentInstaller = Get-Item -LiteralPath (Resolve-Path -LiteralPath $CurrentInstallerPath).Path
$evidence = [IO.Path]::GetFullPath($EvidencePath)
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($evidence)) -Force | Out-Null
$acceptanceDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src-tauri/target/debug'))
$acceptanceDirectoryInfo = Get-Item -LiteralPath $acceptanceDirectory
if (!$acceptanceDirectoryInfo.PSIsContainer -or
    ($acceptanceDirectoryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    @(Get-ChildItem -LiteralPath $acceptanceDirectory -Force).Count -eq 0) {
  throw 'The prebuilt desktop acceptance helper directory failed validation.'
}
$acceptanceBinaries = [ordered]@{}
$acceptanceCandidates = [ordered]@{
  'swl-db-acceptance' = [ordered]@{ path = $DatabaseAcceptanceBinaryPath; name = 'swl-db-acceptance.exe' }
  'swl-legacy-seed' = [ordered]@{ path = $LegacySeedBinaryPath; name = 'swl-legacy-seed.exe' }
}
foreach ($candidate in $acceptanceCandidates.GetEnumerator()) {
  try {
    $helper = Get-Item -LiteralPath (Resolve-Path -LiteralPath $candidate.Value.path).Path
  }
  catch {
    throw 'A required prebuilt desktop acceptance helper is unavailable.'
  }
  if ($helper.PSIsContainer -or
      $helper.Name -cne $candidate.Value.name -or
      $helper.Length -le 0 -or
      ($helper.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($helper.FullName)) -ine $acceptanceDirectory) {
    throw 'A required prebuilt desktop acceptance helper failed exact path validation.'
  }
  $acceptanceBinaries[$candidate.Key] = $helper
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

function Install-UnsignedPackage {
  param([IO.FileInfo]$Installer, [string]$Destination)
  $signature = Get-AuthenticodeSignature -LiteralPath $Installer.FullName
  if ($signature.Status -ne 'NotSigned') {
    throw "The internal upgrade-test installer must be unsigned; actual status: $($signature.Status)."
  }
  $process = Start-Process -FilePath $Installer.FullName -ArgumentList @('/S', "/D=$Destination") -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Silent current-user installation failed with exit code $($process.ExitCode)."
  }
}

function Get-ApplicationExecutable {
  param([string]$InstallRoot)
  $executables = @(Get-ChildItem -LiteralPath $InstallRoot -Recurse -File -Filter '*.exe' | Where-Object {
    $_.Name -notmatch '^unins|uninstall|WebView2|MicrosoftEdge'
  })
  if ($executables.Count -ne 1) {
    throw "Expected exactly one installed application executable; found $($executables.Count)."
  }
  return $executables[0]
}

function Stop-ExactProcessTree {
  param([int]$RootProcessId)
  $all = @(Get-CimInstance Win32_Process)
  $tracked = [Collections.Generic.HashSet[int]]::new()
  [void]$tracked.Add($RootProcessId)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($candidate in $all) {
      if ($tracked.Contains([int]$candidate.ParentProcessId) -and !$tracked.Contains([int]$candidate.ProcessId)) {
        [void]$tracked.Add([int]$candidate.ProcessId)
        $changed = $true
      }
    }
  }
  foreach ($processId in @($tracked | Sort-Object -Descending)) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $remaining = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $tracked.Contains([int]$_.Id) })
    if ($remaining.Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw 'The installed application process tree did not stop.'
}

function Remove-StartupCaptureFiles {
  param([string[]]$Paths)
  $runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar)
  foreach ($path in $Paths) {
    if ([string]::IsNullOrWhiteSpace($path)) { continue }
    $fullPath = [IO.Path]::GetFullPath($path)
    $validName = [IO.Path]::GetFileName($fullPath) -match '^swl-upgrade-(?:legacy|current)-[0-9a-f]{32}\.(?:stdout|stderr)$'
    if ([IO.Path]::GetDirectoryName($fullPath).TrimEnd([IO.Path]::DirectorySeparatorChar) -ine $runnerTemp -or !$validName) {
      throw 'A task-created startup capture path failed validation.'
    }
    Remove-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $fullPath) {
      throw 'A task-created startup capture could not be removed.'
    }
  }
}

function Get-SanitisedStartupStage {
  param([string[]]$Paths)
  $maxStartupCaptureBytes = 32 * 1024
  $captured = [Collections.Generic.List[string]]::new()
  try {
    foreach ($path in $Paths) {
      if (!(Test-Path -LiteralPath $path -PathType Leaf)) { continue }
      $metadata = Get-Item -LiteralPath $path
      if (($metadata.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
          $metadata.Length -gt $maxStartupCaptureBytes) {
        return 'capture-rejected'
      }
      $captured.Add([IO.File]::ReadAllText($metadata.FullName))
    }
  }
  catch {
    return 'capture-unreadable'
  }
  if ($captured.Count -eq 0) { return 'no-diagnostic-output' }
  $diagnostic = [string]::Join("`n", $captured)
  $stageMarkers = [ordered]@{
    'restore-recovery' = @('restore recovery', 'interrupted restore', 'restore rollback')
    'temporary-export-cleanup' = @('selected output folder', 'temporary output')
    'database-migration' = @('database', 'migration', 'backup')
    'main-window' = @('main application window')
    'ready-title' = @('window title')
  }
  foreach ($stage in $stageMarkers.Keys) {
    foreach ($marker in $stageMarkers[$stage]) {
      if ($diagnostic.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $stage
      }
    }
  }
  return 'unknown'
}

function Start-ApplicationAndWaitForWindow {
  param(
    [IO.FileInfo]$Application,
    [string]$ExpectedWindowTitle,
    [ValidateSet('legacy', 'current')][string]$LaunchPhase
  )
  $captureId = [Guid]::NewGuid().ToString('N')
  $standardOutput = Join-Path $env:RUNNER_TEMP "swl-upgrade-$LaunchPhase-$captureId.stdout"
  $standardError = Join-Path $env:RUNNER_TEMP "swl-upgrade-$LaunchPhase-$captureId.stderr"
  try {
    $process = Start-Process `
      -FilePath $Application.FullName `
      -RedirectStandardOutput $standardOutput `
      -RedirectStandardError $standardError `
      -PassThru
  }
  catch {
    Remove-StartupCaptureFiles -Paths @($standardOutput, $standardError)
    throw "The installed $LaunchPhase upgrade-test application could not be started."
  }
  $deadline = (Get-Date).AddSeconds(30)
  $windowTitle = $null
  do {
    Start-Sleep -Milliseconds 250
    $nativeProcess = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
    if (!$nativeProcess) {
      $exitCode = -1
      try {
        # The root may exit while WebView descendants still inherit its redirected
        # handles. Stop and verify that exact tree before reading or deleting any
        # bounded diagnostic capture.
        Stop-ExactProcessTree -RootProcessId $process.Id
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        $startupStage = Get-SanitisedStartupStage -Paths @($standardOutput, $standardError)
      }
      finally {
        Remove-StartupCaptureFiles -Paths @($standardOutput, $standardError)
      }
      $failure = [InvalidOperationException]::new(
        "The installed $LaunchPhase upgrade-test application exited before becoming ready (exit code $exitCode; startup stage $startupStage)."
      )
      $failure.Data['swlLaunchPhase'] = $LaunchPhase
      $failure.Data['swlProcessExited'] = $true
      $failure.Data['swlExitCode'] = $exitCode
      $failure.Data['swlStartupStage'] = $startupStage
      throw $failure
    }
    if ($nativeProcess -and $nativeProcess.MainWindowHandle -ne 0) {
      $windowTitle = $nativeProcess.MainWindowTitle
    }
  } while ($windowTitle -cne $ExpectedWindowTitle -and (Get-Date) -lt $deadline)
  if ($windowTitle -cne $ExpectedWindowTitle) {
    try {
      Stop-ExactProcessTree -RootProcessId $process.Id
    }
    finally {
      Remove-StartupCaptureFiles -Paths @($standardOutput, $standardError)
    }
    throw "The installed $LaunchPhase upgrade-test application did not expose the expected native window."
  }
  return [pscustomobject]@{
    ProcessId = $process.Id
    WindowTitle = $windowTitle
    StandardOutputPath = $standardOutput
    StandardErrorPath = $standardError
  }
}

function Invoke-JsonAcceptanceBinary {
  param(
    [ValidateSet('swl-db-acceptance', 'swl-legacy-seed')][string]$Binary,
    [ValidateSet('legacy', 'current', 'legacy-seed', 'post-exit')][string]$Phase,
    [switch]$DisposableMarker,
    [int]$ApplicationProcessId = 0,
    [ValidateRange(1, 60000)][int]$TimeoutMilliseconds = 30000
  )
  $priorMarker = $env:SWL_DISPOSABLE_ACCEPTANCE
  $captureId = [Guid]::NewGuid().ToString('N')
  $standardOutput = Join-Path $env:RUNNER_TEMP "swl-acceptance-$captureId.stdout"
  $standardError = Join-Path $env:RUNNER_TEMP "swl-acceptance-$captureId.stderr"
  try {
    if ($DisposableMarker) { $env:SWL_DISPOSABLE_ACCEPTANCE = 'YES' }
    else { Remove-Item Env:SWL_DISPOSABLE_ACCEPTANCE -ErrorAction SilentlyContinue }
    try {
      $helper = $acceptanceBinaries[$Binary]
      $process = Start-Process -FilePath $helper.FullName -NoNewWindow -RedirectStandardOutput $standardOutput -RedirectStandardError $standardError -PassThru
    }
    catch {
      throw "The scoped $Phase $Binary acceptance helper could not be started."
    }
    $probeDeadline = (Get-Date).AddMilliseconds($TimeoutMilliseconds)
    $finished = $false
    do {
      $remainingMilliseconds = [int][Math]::Ceiling(($probeDeadline - (Get-Date)).TotalMilliseconds)
      if ($remainingMilliseconds -le 0) { break }
      $waitSlice = [Math]::Min(250, $remainingMilliseconds)
      if ($process.WaitForExit($waitSlice)) {
        $finished = $true
        break
      }
      if ($ApplicationProcessId -gt 0 -and
          !(Get-Process -Id $ApplicationProcessId -ErrorAction SilentlyContinue)) {
        Stop-ExactProcessTree -RootProcessId $process.Id
        throw "The installed $Phase upgrade-test application exited while its acceptance helper was running."
      }
    } while ((Get-Date) -lt $probeDeadline)
    if (!$finished) {
      Stop-ExactProcessTree -RootProcessId $process.Id
      throw "The scoped $Phase $Binary acceptance helper timed out."
    }
    $process.WaitForExit()
    if ($ApplicationProcessId -gt 0 -and
        !(Get-Process -Id $ApplicationProcessId -ErrorAction SilentlyContinue)) {
      throw "The installed $Phase upgrade-test application exited before acceptance evidence could be verified."
    }
    if ($process.ExitCode -ne 0) { throw "The scoped $Phase $Binary acceptance helper failed." }
    if (!(Test-Path -LiteralPath $standardOutput -PathType Leaf) -or
        (Get-Item -LiteralPath $standardOutput).Length -gt 65536 -or
        (Test-Path -LiteralPath $standardError -PathType Leaf) -and
        (Get-Item -LiteralPath $standardError).Length -gt 65536) {
      throw "The scoped $Phase $Binary acceptance helper returned invalid output."
    }
    try { $result = (Get-Content -LiteralPath $standardOutput -Raw) | ConvertFrom-Json }
    catch { throw "The scoped $Phase $Binary acceptance helper returned invalid JSON." }
    if ($ApplicationProcessId -gt 0 -and
        !(Get-Process -Id $ApplicationProcessId -ErrorAction SilentlyContinue)) {
      throw "The installed $Phase upgrade-test application exited before acceptance evidence could be verified."
    }
    return $result
  }
  finally {
    Remove-Item -LiteralPath $standardOutput -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $standardError -Force -ErrorAction SilentlyContinue
    if ($null -eq $priorMarker) { Remove-Item Env:SWL_DISPOSABLE_ACCEPTANCE -ErrorAction SilentlyContinue }
    else { $env:SWL_DISPOSABLE_ACCEPTANCE = $priorMarker }
  }
}

function Assert-ExactLegacyEvidence {
  param($Value)
  if ($Value.seeded -ne $true -or
      $Value.catalogueItemId -ne 'item-legacy' -or
      $Value.approvalId -ne 'approval-legacy' -or
      $Value.priceHistoryId -ne 'history-legacy') {
    throw 'The former-version seeder did not create the exact reviewed synthetic records.'
  }
}

function Assert-EmptyFormerDatabaseEvidence {
  param($Value)
  if ($Value.integrity -ne 'ok' -or $Value.schemaVersion -ne 1 -or
      $Value.catalogueItems -ne 0 -or $Value.approvals -ne 0 -or $Value.priceHistory -ne 0 -or
      $Value.competitorReferences -ne 0 -or $Value.sources -ne 0 -or $Value.profiles -ne 0 -or
      $Value.aliases -ne 0 -or $Value.settings -ne 0 -or
      @($Value.catalogueItemIds).Count -ne 0 -or @($Value.approvalIds).Count -ne 0 -or
      @($Value.approvalItemIds).Count -ne 0 -or @($Value.priceHistoryIds).Count -ne 0 -or
      @($Value.priceHistoryItemIds).Count -ne 0 -or @($Value.priceHistoryApprovalIds).Count -ne 0 -or
      @($Value.verifiedMigrationBackups).Count -ne 0) {
    throw 'The genuine former application database is not the exact empty version-one schema.'
  }
}

function Assert-ExactMigratedEvidence {
  param($Value)
  if ($Value.integrity -ne 'ok' -or $Value.schemaVersion -ne 3 -or
      $Value.catalogueItems -ne 1 -or $Value.approvals -ne 1 -or $Value.priceHistory -ne 1 -or
      $Value.competitorReferences -ne 0 -or $Value.sources -ne 0 -or $Value.profiles -ne 0 -or
      $Value.aliases -ne 0 -or $Value.settings -ne 0) {
    throw 'The migrated live database does not contain the exact expected record counts.'
  }
  if (@($Value.catalogueItemIds).Count -ne 1 -or $Value.catalogueItemIds[0] -ne 'item-legacy' -or
      @($Value.approvalIds).Count -ne 1 -or $Value.approvalIds[0] -ne 'approval-legacy' -or
      @($Value.approvalItemIds).Count -ne 1 -or $Value.approvalItemIds[0] -ne 'item-legacy' -or
      @($Value.priceHistoryIds).Count -ne 1 -or $Value.priceHistoryIds[0] -ne 'history-legacy' -or
      @($Value.priceHistoryItemIds).Count -ne 1 -or $Value.priceHistoryItemIds[0] -ne 'item-legacy' -or
      @($Value.priceHistoryApprovalIds).Count -ne 1 -or $Value.priceHistoryApprovalIds[0] -ne 'approval-legacy') {
    throw 'The migrated live database did not preserve the exact legacy relationships.'
  }
  $migrationBackups = @($Value.verifiedMigrationBackups)
  if ($migrationBackups.Count -ne 1) {
    throw 'The clean upgrade profile did not contain exactly one verified migration backup.'
  }
  $backup = $migrationBackups[0]
  if ($backup.schemaVersion -ne 1 -or $backup.sha256Verified -ne $true -or $backup.integrity -ne 'ok' -or
      $backup.recordCounts.catalogueItems -ne 1 -or $backup.recordCounts.approvals -ne 1 -or
      $backup.recordCounts.priceHistory -ne 1 -or $backup.recordCounts.competitorReferences -ne 0 -or
      $backup.recordCounts.sources -ne 0 -or $backup.recordCounts.profiles -ne 0 -or
      $backup.recordCounts.aliases -ne 0 -or $backup.recordCounts.settings -ne 0 -or
      @($backup.catalogueItemIds).Count -ne 1 -or $backup.catalogueItemIds[0] -ne 'item-legacy' -or
      @($backup.approvalIds).Count -ne 1 -or $backup.approvalIds[0] -ne 'approval-legacy' -or
      @($backup.approvalItemIds).Count -ne 1 -or $backup.approvalItemIds[0] -ne 'item-legacy' -or
      @($backup.priceHistoryIds).Count -ne 1 -or $backup.priceHistoryIds[0] -ne 'history-legacy' -or
      @($backup.priceHistoryItemIds).Count -ne 1 -or $backup.priceHistoryItemIds[0] -ne 'item-legacy' -or
      @($backup.priceHistoryApprovalIds).Count -ne 1 -or $backup.priceHistoryApprovalIds[0] -ne 'approval-legacy') {
    throw 'The verified pre-migration backup does not preserve the exact legacy records.'
  }
}

function Test-RegularDatabaseReady {
  param([string]$Path)
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $attributes = (Get-Item -LiteralPath $Path).Attributes
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The stable database path is a reparse point.'
  }
  return $true
}

function Wait-ForAcceptanceEvidence {
  param(
    [int]$RootProcessId,
    [string]$DatabasePath,
    [string]$Binary,
    [ValidateSet('legacy', 'current')][string]$Phase,
    [scriptblock]$Assertion,
    [switch]$DisposableMarker
  )
  $deadline = (Get-Date).AddSeconds(30)
  $lastFailure = 'The scoped readiness probe did not return evidence.'
  do {
    if (!(Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) {
      throw "The installed $Phase upgrade-test application exited before its database became ready."
    }
    try {
      $databaseReady = Test-RegularDatabaseReady -Path $DatabasePath
    }
    catch {
      throw "The installed $Phase upgrade-test application database path failed validation."
    }
    if ($databaseReady) {
      $remainingMilliseconds = [int][Math]::Floor(($deadline - (Get-Date)).TotalMilliseconds)
      if ($remainingMilliseconds -le 0) { break }
      $probeTimeoutMilliseconds = [Math]::Min(5000, $remainingMilliseconds)
      try {
        $candidate = Invoke-JsonAcceptanceBinary -Binary $Binary -Phase $Phase -DisposableMarker:$DisposableMarker -ApplicationProcessId $RootProcessId -TimeoutMilliseconds $probeTimeoutMilliseconds
        & $Assertion $candidate
        return $candidate
      }
      catch {
        # A configured Tauri window is created before the application setup hook.
        # Keep the genuine application alive while its transactional setup finishes.
        $message = $_.Exception.Message
        if ($message -match '^The installed (?:legacy|current) upgrade-test application exited (?:while its acceptance helper was running|before acceptance evidence could be verified)\.$') {
          throw
        }
        $lastFailure = if ($message -match '^The (?:scoped .+ acceptance helper|genuine former application database|migrated live database|clean upgrade profile|verified pre-migration backup)') {
          $message
        }
        else {
          'The scoped readiness probe returned an unexpected error.'
        }
      }
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "The installed $Phase upgrade-test application database did not become ready in time. Last readiness failure: $lastFailure"
}

function Write-PostExitDatabaseClassification {
  param(
    [string]$DatabasePath,
    [string]$Path,
    [int]$ProcessExitCode,
    [string]$StartupStage
  )
  $classification = 'unreadable'
  $schemaVersion = $null
  $recordCounts = $null
  $migrationBackupCount = $null
  try {
    if (Test-RegularDatabaseReady -Path $DatabasePath) {
      $databaseEvidence = Invoke-JsonAcceptanceBinary `
        -Binary 'swl-db-acceptance' `
        -Phase 'post-exit' `
        -TimeoutMilliseconds 30000
      [long]$verifiedSchemaVersion = 0
      $counts = [ordered]@{}
      $countProperties = [ordered]@{
        catalogueItems = 'catalogueItems'
        approvals = 'approvals'
        priceHistory = 'priceHistory'
        competitorReferences = 'competitorReferences'
        sources = 'sources'
        profiles = 'profiles'
        aliases = 'aliases'
        settings = 'settings'
      }
      $validCounts = $true
      foreach ($entry in $countProperties.GetEnumerator()) {
        [long]$count = 0
        if (![long]::TryParse([string]$databaseEvidence.($entry.Value), [ref]$count) -or
            $count -lt 0 -or $count -gt 1000000) {
          $validCounts = $false
          break
        }
        $counts[$entry.Key] = $count
      }
      $verifiedBackupCount = @($databaseEvidence.verifiedMigrationBackups).Count
      if ($databaseEvidence.integrity -eq 'ok' -and
          [long]::TryParse([string]$databaseEvidence.schemaVersion, [ref]$verifiedSchemaVersion) -and
          $verifiedSchemaVersion -in @(1, 3) -and
          $validCounts -and
          $verifiedBackupCount -ge 0 -and $verifiedBackupCount -le 100) {
        $classification = if ($verifiedSchemaVersion -eq 1) { 'v1-present' } else { 'v3-migrated' }
        $schemaVersion = $verifiedSchemaVersion
        $recordCounts = $counts
        $migrationBackupCount = $verifiedBackupCount
      }
    }
  }
  catch {
    $classification = 'unreadable'
    $schemaVersion = $null
    $recordCounts = $null
    $migrationBackupCount = $null
  }
  $payload = [ordered]@{
    phase = 'current'
    processExitCode = $ProcessExitCode
    startupStage = $StartupStage
    databaseClassification = $classification
    schemaVersion = $schemaVersion
    recordCounts = $recordCounts
    verifiedMigrationBackupCount = $migrationBackupCount
  }
  $json = $payload | ConvertTo-Json -Depth 4 -Compress
  if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 8192) {
    throw 'The sanitised post-exit database classification exceeded its size limit.'
  }
  Set-Content -LiteralPath $Path -Value $json -Encoding utf8
}

$emptyFormerAssertion = (Get-Command Assert-EmptyFormerDatabaseEvidence -CommandType Function).ScriptBlock
$migratedAssertion = (Get-Command Assert-ExactMigratedEvidence -CommandType Function).ScriptBlock
$dataRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA $applicationIdentifier))
$expectedParent = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd([IO.Path]::DirectorySeparatorChar)
if ([IO.Path]::GetDirectoryName($dataRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) -ine $expectedParent) {
  throw 'The disposable application-data path is outside LOCALAPPDATA.'
}
if (Test-Path -LiteralPath $dataRoot) {
  throw 'The upgrade gate requires a clean disposable SWL application-data path.'
}
$installRoot = Join-Path $env:RUNNER_TEMP ('swl-upgrade-installed-' + [Guid]::NewGuid().ToString('N'))
if ($installRoot.Contains(' ')) { throw 'The scripted NSIS destination contains a space.' }

Install-UnsignedPackage -Installer $legacyInstaller -Destination $installRoot
$legacyApplication = Get-ApplicationExecutable -InstallRoot $installRoot
if ($legacyApplication.VersionInfo.ProductVersion -notmatch $legacyVersionPattern) {
  throw "The installed former application does not identify as version $legacyVersion."
}
$legacyApplicationSha256 = (Get-FileHash -LiteralPath $legacyApplication.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$databasePath = Join-Path $dataRoot 'swl-pricing.sqlite3'
$legacyLaunch = Start-ApplicationAndWaitForWindow `
  -Application $legacyApplication `
  -ExpectedWindowTitle $productName `
  -LaunchPhase 'legacy'
$legacyWindowTitle = $legacyLaunch.WindowTitle
try {
  [void](Wait-ForAcceptanceEvidence `
    -RootProcessId $legacyLaunch.ProcessId `
    -DatabasePath $databasePath `
    -Binary 'swl-db-acceptance' `
    -Phase 'legacy' `
    -Assertion $emptyFormerAssertion)
}
finally {
  try {
    Stop-ExactProcessTree -RootProcessId $legacyLaunch.ProcessId
    Start-Sleep -Seconds 1
  }
  finally {
    Remove-StartupCaptureFiles -Paths @($legacyLaunch.StandardOutputPath, $legacyLaunch.StandardErrorPath)
  }
}
if (!(Test-RegularDatabaseReady -Path $databasePath)) {
  throw 'The genuine former application did not create its regular stable database.'
}
$legacySeed = Invoke-JsonAcceptanceBinary -Binary 'swl-legacy-seed' -Phase 'legacy-seed' -DisposableMarker
Assert-ExactLegacyEvidence -Value $legacySeed
$formerDatabaseSha256 = (Get-FileHash -LiteralPath $databasePath -Algorithm SHA256).Hash.ToLowerInvariant()
$beforeUpgradeManifest = @(Get-DataManifest -Root $dataRoot)

Install-UnsignedPackage -Installer $currentInstaller -Destination $installRoot
$beforeCurrentLaunchManifest = @(Get-DataManifest -Root $dataRoot)
if (($beforeCurrentLaunchManifest | ConvertTo-Json -Depth 5 -Compress) -ne
    ($beforeUpgradeManifest | ConvertTo-Json -Depth 5 -Compress)) {
  throw 'Installing the current package changed former-version data before migration launch.'
}
$currentApplication = Get-ApplicationExecutable -InstallRoot $installRoot
if ($currentApplication.VersionInfo.ProductVersion -notmatch $currentVersionPattern) {
  throw "The upgraded application does not identify as version $currentVersion."
}
$startupFailureEvidence = Join-Path `
  ([IO.Path]::GetDirectoryName($evidence)) `
  (([IO.Path]::GetFileNameWithoutExtension($evidence)) + '-Startup-Failure.json')
try {
  $currentLaunch = Start-ApplicationAndWaitForWindow `
    -Application $currentApplication `
    -ExpectedWindowTitle $productName `
    -LaunchPhase 'current'
}
catch {
  if ($_.Exception.Data['swlLaunchPhase'] -eq 'current' -and
      $_.Exception.Data['swlProcessExited'] -eq $true) {
    Write-PostExitDatabaseClassification `
      -DatabasePath $databasePath `
      -Path $startupFailureEvidence `
      -ProcessExitCode ([int]$_.Exception.Data['swlExitCode']) `
      -StartupStage ([string]$_.Exception.Data['swlStartupStage'])
  }
  throw
}
$currentWindowTitle = $currentLaunch.WindowTitle
try {
  $migrated = Wait-ForAcceptanceEvidence `
    -RootProcessId $currentLaunch.ProcessId `
    -DatabasePath $databasePath `
    -Binary 'swl-db-acceptance' `
    -Phase 'current' `
    -Assertion $migratedAssertion
}
finally {
  try {
    Stop-ExactProcessTree -RootProcessId $currentLaunch.ProcessId
    Start-Sleep -Seconds 1
  }
  finally {
    Remove-StartupCaptureFiles -Paths @($currentLaunch.StandardOutputPath, $currentLaunch.StandardErrorPath)
  }
}
Assert-ExactMigratedEvidence -Value $migrated
$afterMigrationManifest = @(Get-DataManifest -Root $dataRoot)
if ($afterMigrationManifest.Count -le $beforeUpgradeManifest.Count) {
  throw 'The current application did not leave verified pre-migration backup evidence.'
}
$afterMigrationManifestJson = $afterMigrationManifest | ConvertTo-Json -Depth 5 -Compress

$uninstallers = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Filter '*.exe' | Where-Object {
  $_.Name -match '^unins|uninstall'
})
if ($uninstallers.Count -ne 1) {
  throw "Expected exactly one current uninstaller; found $($uninstallers.Count)."
}
$uninstall = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList '/S' -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw "Upgrade-test uninstall failed with exit code $($uninstall.ExitCode)." }
if ((@(Get-DataManifest -Root $dataRoot) | ConvertTo-Json -Depth 5 -Compress) -ne $afterMigrationManifestJson) {
  throw 'Uninstall changed the migrated application-data manifest.'
}

[ordered]@{
  scope = 'Immutable former 1.0.0 application source with its reviewed hash-bound Cargo lock repair upgraded to 1.2.0 on disposable GitHub-hosted Windows Server 2025; not interactive Windows 10/11 acceptance'
  legacy = [ordered]@{
    sourceCommit = 'e36ec72ae8c53b0f9af7eeb0ef3f605b9f5dab9a'
    version = $legacyVersion
    installer = $legacyInstaller.Name
    installerSha256 = (Get-FileHash -LiteralPath $legacyInstaller.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    applicationSha256 = $legacyApplicationSha256
    windowTitle = $legacyWindowTitle
    formerDatabaseSha256 = $formerDatabaseSha256
    syntheticSeed = $legacySeed
  }
  current = [ordered]@{
    version = $currentVersion
    installer = $currentInstaller.Name
    installerSha256 = (Get-FileHash -LiteralPath $currentInstaller.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    windowTitle = $currentWindowTitle
    migratedDatabase = $migrated
  }
  preUpgradeDataManifest = $beforeUpgradeManifest
  postMigrationDataManifest = $afterMigrationManifest
  preMigrationBackupVerified = $true
  exactRecordsAndRelationshipsPreserved = $true
  uninstallPreservedMigratedData = $true
} | ConvertTo-Json -Depth 9 | Set-Content -LiteralPath $evidence -Encoding utf8

# The profile is task-created in a disposable runner. Remove this exact, validated profile only
# after preservation evidence so the independent production-binary workflow starts clean.
Remove-Item -LiteralPath $dataRoot -Recurse -Force
if (Test-Path -LiteralPath $dataRoot) {
  throw 'The task-created upgrade profile could not be cleared for the independent desktop test.'
}
