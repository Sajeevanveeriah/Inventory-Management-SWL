param(
  [Parameter(Mandatory = $true)][string]$LegacyInstallerPath,
  [Parameter(Mandatory = $true)][string]$CurrentInstallerPath,
  [Parameter(Mandatory = $true)][string]$EvidencePath
)

$ErrorActionPreference = 'Stop'
$applicationIdentifier = 'au.com.stanwoottonlocksmiths.swl-pricing'
$productName = 'SWL Pricing and Inventory Control'
$legacyVersion = '1.0.0'
$currentVersion = '1.1.0'
$legacyInstaller = Get-Item -LiteralPath (Resolve-Path -LiteralPath $LegacyInstallerPath).Path
$currentInstaller = Get-Item -LiteralPath (Resolve-Path -LiteralPath $CurrentInstallerPath).Path
$evidence = [IO.Path]::GetFullPath($EvidencePath)
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($evidence)) -Force | Out-Null

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

function Start-ApplicationAndWaitForWindow {
  param([IO.FileInfo]$Application, [string]$ExpectedWindowTitle)
  $process = Start-Process -FilePath $Application.FullName -PassThru
  $deadline = (Get-Date).AddSeconds(30)
  $windowTitle = $null
  do {
    Start-Sleep -Milliseconds 250
    $nativeProcess = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
    if (!$nativeProcess) {
      throw 'The installed upgrade-test application exited before becoming ready.'
    }
    if ($nativeProcess -and $nativeProcess.MainWindowHandle -ne 0) {
      $windowTitle = $nativeProcess.MainWindowTitle
    }
  } while ($windowTitle -cne $ExpectedWindowTitle -and (Get-Date) -lt $deadline)
  if ($windowTitle -cne $ExpectedWindowTitle) {
    Stop-ExactProcessTree -RootProcessId $process.Id
    throw 'The installed upgrade-test application did not expose the expected native window.'
  }
  return [pscustomobject]@{
    ProcessId = $process.Id
    WindowTitle = $windowTitle
  }
}

function Invoke-JsonAcceptanceBinary {
  param(
    [string]$Binary,
    [switch]$DisposableMarker,
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
      $cargo = Get-Command cargo -CommandType Application -ErrorAction Stop
      $process = Start-Process -FilePath $cargo.Source -ArgumentList @(
        'run',
        '--quiet',
        '--locked',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        '--features',
        'acceptance-tools',
        '--bin',
        $Binary
      ) -NoNewWindow -RedirectStandardOutput $standardOutput -RedirectStandardError $standardError -PassThru
    }
    catch {
      throw "The scoped $Binary acceptance helper could not be started."
    }
    if (!$process.WaitForExit($TimeoutMilliseconds)) {
      Stop-ExactProcessTree -RootProcessId $process.Id
      throw "The scoped $Binary acceptance helper timed out."
    }
    if ($process.ExitCode -ne 0) { throw "The scoped $Binary acceptance helper failed." }
    if (!(Test-Path -LiteralPath $standardOutput -PathType Leaf) -or
        (Get-Item -LiteralPath $standardOutput).Length -gt 65536 -or
        (Test-Path -LiteralPath $standardError -PathType Leaf) -and
        (Get-Item -LiteralPath $standardError).Length -gt 65536) {
      throw "The scoped $Binary acceptance helper returned invalid output."
    }
    try { return (Get-Content -LiteralPath $standardOutput -Raw) | ConvertFrom-Json }
    catch { throw "The scoped $Binary acceptance helper returned invalid JSON." }
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
    [scriptblock]$Assertion,
    [switch]$DisposableMarker
  )
  $deadline = (Get-Date).AddSeconds(30)
  $lastFailure = 'The scoped readiness probe did not return evidence.'
  do {
    if (!(Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) {
      throw 'The installed upgrade-test application exited before its database became ready.'
    }
    if (Test-RegularDatabaseReady -Path $DatabasePath) {
      $remainingMilliseconds = [int][Math]::Floor(($deadline - (Get-Date)).TotalMilliseconds)
      if ($remainingMilliseconds -le 0) { break }
      try {
        $candidate = Invoke-JsonAcceptanceBinary -Binary $Binary -DisposableMarker:$DisposableMarker -TimeoutMilliseconds $remainingMilliseconds
        & $Assertion $candidate
        return $candidate
      }
      catch {
        # A configured Tauri window is created before the application setup hook.
        # Keep the genuine application alive while its transactional setup finishes.
        $message = $_.Exception.Message
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
  throw "The installed upgrade-test application database did not become ready in time. Last readiness failure: $lastFailure"
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
if ($legacyApplication.VersionInfo.ProductVersion -notmatch '^1\.0\.0(?:\.0)?$') {
  throw 'The installed former application does not identify as version 1.0.0.'
}
$legacyApplicationSha256 = (Get-FileHash -LiteralPath $legacyApplication.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$databasePath = Join-Path $dataRoot 'swl-pricing.sqlite3'
$legacyLaunch = Start-ApplicationAndWaitForWindow -Application $legacyApplication -ExpectedWindowTitle $productName
$legacyWindowTitle = $legacyLaunch.WindowTitle
try {
  [void](Wait-ForAcceptanceEvidence `
    -RootProcessId $legacyLaunch.ProcessId `
    -DatabasePath $databasePath `
    -Binary 'swl-db-acceptance' `
    -Assertion $emptyFormerAssertion)
}
finally {
  Stop-ExactProcessTree -RootProcessId $legacyLaunch.ProcessId
  Start-Sleep -Seconds 1
}
if (!(Test-RegularDatabaseReady -Path $databasePath)) {
  throw 'The genuine former application did not create its regular stable database.'
}
$legacySeed = Invoke-JsonAcceptanceBinary -Binary 'swl-legacy-seed' -DisposableMarker
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
if ($currentApplication.VersionInfo.ProductVersion -notmatch '^1\.1\.0(?:\.0)?$') {
  throw 'The upgraded application does not identify as version 1.1.0.'
}
$currentLaunch = Start-ApplicationAndWaitForWindow -Application $currentApplication -ExpectedWindowTitle $productName
$currentWindowTitle = $currentLaunch.WindowTitle
try {
  $migrated = Wait-ForAcceptanceEvidence `
    -RootProcessId $currentLaunch.ProcessId `
    -DatabasePath $databasePath `
    -Binary 'swl-db-acceptance' `
    -Assertion $migratedAssertion
}
finally {
  Stop-ExactProcessTree -RootProcessId $currentLaunch.ProcessId
  Start-Sleep -Seconds 1
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
  scope = 'Immutable former 1.0.0 application source with its reviewed hash-bound Cargo lock repair upgraded to 1.1.0 on disposable GitHub-hosted Windows Server 2025; not interactive Windows 10/11 acceptance'
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
