// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(
  join(repositoryRoot, "scripts", "windows-upgrade-smoke.ps1"),
  "utf8",
).replace(/\r\n?/g, "\n");
const workflow = readFileSync(
  join(repositoryRoot, ".github", "workflows", "windows-desktop.yml"),
  "utf8",
).replace(/\r\n?/g, "\n");
const desktopE2eSource = readFileSync(
  join(repositoryRoot, "scripts", "run-windows-desktop-e2e.ps1"),
  "utf8",
).replace(/\r\n?/g, "\n");

describe("Windows upgrade startup diagnostics", () => {
  it("keeps exact readiness while reporting only bounded phase-aware startup evidence", () => {
    expect(source).toContain("[ValidateSet('legacy', 'current')]");
    expect(source).toContain("-LaunchPhase 'legacy'");
    expect(source).toContain("-LaunchPhase 'current'");
    expect(source).toContain("-RedirectStandardOutput $standardOutput");
    expect(source).toContain("-RedirectStandardError $standardError");
    expect(source).toContain('"swl-upgrade-$LaunchPhase-$captureId.stdout"');
    expect(source).toContain('"swl-upgrade-$LaunchPhase-$captureId.stderr"');
    expect(source).toContain("$maxStartupCaptureBytes = 32 * 1024");
    expect(source).toContain("Get-SanitisedStartupStage");
    expect(source).toContain("Remove-StartupCaptureFiles");
    expect(source.match(/Remove-StartupCaptureFiles -Paths/g)).toHaveLength(5);
    expect(source).toContain('startup stage $startupStage)."');
    expect(source).not.toMatch(/Write-(?:Host|Output).*\$diagnostic/);
    expect(source).not.toMatch(
      /throw[^\r\n]*\$(?:standardOutput|standardError|diagnostic)/,
    );
    const earlyExitStart = source.indexOf("if (!$nativeProcess)");
    const earlyExitStop = source.indexOf(
      "Stop-ExactProcessTree -RootProcessId $process.Id",
      earlyExitStart,
    );
    const earlyExitRead = source.indexOf(
      "Get-SanitisedStartupStage -Paths",
      earlyExitStart,
    );
    expect(earlyExitStart).toBeGreaterThan(-1);
    expect(earlyExitStop).toBeGreaterThan(earlyExitStart);
    expect(earlyExitRead).toBeGreaterThan(earlyExitStop);
    expect(source.indexOf("$process.WaitForExit()")).toBeLessThan(
      source.indexOf("$failure.Data['swlProcessExited'] = $true"),
    );
    expect(source).toContain(
      "throw 'A task-created startup capture could not be removed.'",
    );

    const exactTitleComparisons = source.match(
      /\$windowTitle -cne \$ExpectedWindowTitle/g,
    );
    expect(exactTitleComparisons).toHaveLength(2);
    expect(source).toContain(
      "Wait-ForAcceptanceEvidence `\n    -RootProcessId $currentLaunch.ProcessId",
    );
  });

  it("persists only allowlisted post-exit database state", () => {
    const classificationFunction = source.match(
      /function Write-PostExitDatabaseClassification \{[\s\S]*?\n\}\n\n\$emptyFormerAssertion/,
    )?.[0];
    expect(classificationFunction).toBeDefined();
    expect(classificationFunction).toContain("-Binary 'swl-db-acceptance'");
    expect(classificationFunction).toContain("'v1-present'");
    expect(classificationFunction).toContain("'v3-migrated'");
    expect(classificationFunction).toContain("'unreadable'");
    expect(classificationFunction).toContain(
      "verifiedMigrationBackupCount = $migrationBackupCount",
    );
    expect(classificationFunction).toContain(
      "[Text.Encoding]::UTF8.GetByteCount($json) -gt 8192",
    );
    expect(classificationFunction).not.toMatch(
      /catalogueItemIds|approvalIds|priceHistoryIds|sha256|FullName/,
    );
    expect(source).toContain("$_.Exception.Data['swlProcessExited'] -eq $true");
    expect(source).toContain("'-Startup-Failure.json'");
  });

  it("prebuilds and invokes exact helpers without Cargo inside readiness", () => {
    const helperBuildStep = workflow.match(
      / {6}- name: Build exact test-only desktop acceptance helpers[\s\S]*?(?=\n {6}- name:)/,
    )?.[0];
    expect(helperBuildStep).toBeDefined();
    expect(helperBuildStep).toContain(
      "cargo build --locked --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target --features acceptance-tools --bin swl-db-acceptance --bin swl-legacy-seed\n          if ($LASTEXITCODE -ne 0)",
    );
    expect(helperBuildStep).toContain("SWL_DB_ACCEPTANCE_BINARY");
    expect(helperBuildStep).toContain("SWL_LEGACY_SEED_BINARY");
    expect(helperBuildStep).toContain(
      "($helperDirectoryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0",
    );
    expect(helperBuildStep).toContain(
      "@(Get-ChildItem -LiteralPath $helperDirectory -Force).Count -eq 0",
    );
    expect(workflow).toContain(
      '-DatabaseAcceptanceBinaryPath "$env:SWL_DB_ACCEPTANCE_BINARY"',
    );
    expect(source).toContain("$DatabaseAcceptanceBinaryPath");
    expect(source).toContain("$LegacySeedBinaryPath");
    expect(source).toContain("../src-tauri/target/debug");
    expect(source).toContain(
      "($acceptanceDirectoryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0",
    );
    expect(source).toContain(
      "@(Get-ChildItem -LiteralPath $acceptanceDirectory -Force).Count -eq 0",
    );
    expect(source).toContain("$helper.Name -cne $candidate.Value.name");
    expect(source).toContain("-FilePath $helper.FullName");
    expect(source).not.toContain("Get-Command cargo");
    expect(source).not.toContain("cargo run");
    expect(source).not.toMatch(/['"]run['"][\s\S]*?Cargo\.toml/);
    expect(source).toContain(
      "Get-Process -Id $ApplicationProcessId -ErrorAction SilentlyContinue",
    );
    expect(source).toContain("$probeDeadline = (Get-Date).AddMilliseconds");
    expect(source).toContain("$waitSlice = [Math]::Min(250");
    expect(source).toContain(
      "$probeTimeoutMilliseconds = [Math]::Min(5000, $remainingMilliseconds)",
    );
    expect(source).toContain(
      'throw "The installed $Phase upgrade-test application exited before acceptance evidence could be verified."',
    );
    expect(
      source.match(
        /Get-Process -Id \$ApplicationProcessId -ErrorAction SilentlyContinue/g,
      ),
    ).toHaveLength(3);
    expect(source).toContain(
      'throw "The scoped $Phase $Binary acceptance helper timed out."',
    );
    expect(source).toContain("-Phase 'legacy' `");
    expect(source).toContain("-Phase 'current' `");
    expect(source).toContain(
      'throw "The installed $Phase upgrade-test application exited before its database became ready."',
    );
    expect(source).toContain(
      'throw "The installed $Phase upgrade-test application database did not become ready in time. Last readiness failure: $lastFailure"',
    );
    const readinessFunction = source.match(
      /function Wait-ForAcceptanceEvidence \{[\s\S]*?\n\}\n\nfunction Write-PostExitDatabaseClassification/,
    )?.[0];
    expect(readinessFunction).toBeDefined();
    expect(readinessFunction).not.toContain(
      "The installed upgrade-test application",
    );
    expect(source).toContain("$deadline = (Get-Date).AddSeconds(30)");
  });

  it("pins and validates the exact external Tauri driver without an unsupported version probe", () => {
    const installStep = workflow.match(
      / {6}- name: Install exact external Tauri WebDriver[\s\S]*?(?=\n {6}- name:)/,
    )?.[0];
    expect(installStep).toBeDefined();
    expect(installStep).toContain(
      "$driverRoot = [IO.Path]::GetFullPath((Join-Path $env:GITHUB_WORKSPACE '.tools/tauri-driver'))",
    );
    expect(installStep).toContain(
      "cargo install tauri-driver --registry crates-io --version 2.0.6 --locked --root $driverRoot\n          if ($LASTEXITCODE -ne 0)",
    );
    expect(installStep).toContain(
      "($driverRootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0",
    );
    expect(installStep).toContain(
      "@(& cargo install --list --root $driverRoot --color never 2>&1)",
    );
    expect(installStep).toContain("$installListingExitCode = $LASTEXITCODE");
    expect(installStep).toContain("$installListing.Count -ne 2");
    expect(installStep).toContain(
      "$installListing[0] -cne 'tauri-driver v2.0.6:'",
    );
    expect(installStep).toContain(
      "$installListing[1] -cne '    tauri-driver.exe'",
    );
    expect(installStep).not.toContain(".crates2.json");
    expect(installStep).not.toContain("ConvertFrom-Json");
    expect(installStep).toContain(
      "$driverExecutable.FullName -ine $driverExecutablePath",
    );
    expect(installStep).toContain("$driverExecutable.PSIsContainer");
    expect(installStep).toContain("$driverExecutable.Length -le 0");
    expect(installStep).toContain(
      "($driverExecutable.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0",
    );
    expect(installStep).toContain("$driverHelpTimeoutMilliseconds = 10000");
    expect(installStep).toContain("$maxDriverHelpBytes = 8 * 1024");
    expect(installStep).toContain("$driverHelpProcess.WaitForExit");
    expect(installStep).toContain("$driverHelpProcess.Kill($true)");
    expect(installStep).toContain("[Text.Encoding]::UTF8.GetByteCount");
    expect(installStep).toContain("'USAGE: tauri-driver [FLAGS] [OPTIONS]'");
    expect(installStep).not.toMatch(
      /& \$driverExecutable(?:\.FullName)? --version/,
    );
    expect(installStep).toContain("SWL_TAURI_DRIVER_BINARY");
    expect(installStep).toContain("$env:GITHUB_PATH");
    const evidenceBlock = installStep?.match(
      /\[ordered\]@\{[\s\S]*?\}\s*\| ConvertTo-Json/,
    )?.[0];
    expect(evidenceBlock).toBeDefined();
    expect(evidenceBlock).toContain(
      "boundary = 'external project-local CI executable; never bundled'",
    );
    expect(evidenceBlock).toContain(
      "sha256Purpose = 'observational executable identity only; not a signature or provenance claim'",
    );
    expect(evidenceBlock).not.toMatch(/(?:fullName|path|helpOutput)\s*=/i);

    const driveStep = workflow.match(
      / {6}- name: Drive the production desktop executable with outbound networking denied[\s\S]*?(?=\n {6}- name:)/,
    )?.[0];
    expect(driveStep).toBeDefined();
    expect(driveStep).toContain(
      "@(Get-Command tauri-driver.exe -All -ErrorAction SilentlyContinue)",
    );
    expect(driveStep).toContain("$resolvedDrivers.Count -ne 1");
    expect(driveStep).toContain(
      "$resolvedDrivers[0].Source -ine $env:SWL_TAURI_DRIVER_BINARY",
    );
  });
});

describe("Windows desktop offline cleanup", () => {
  it("restores and verifies every task-created firewall resource before reporting fixed cleanup labels", () => {
    const cleanupStart = desktopE2eSource.lastIndexOf("\nfinally {");
    const cleanupEnd = desktopE2eSource.indexOf(
      "\n\nif (!(Test-Path -LiteralPath $monitorEvidencePath",
      cleanupStart,
    );
    expect(cleanupStart).toBeGreaterThan(-1);
    expect(cleanupEnd).toBeGreaterThan(cleanupStart);
    const cleanup = desktopE2eSource.slice(cleanupStart, cleanupEnd);

    expect(cleanup).toContain(
      "Remove-NetFirewallRule -Name $ruleName -ErrorAction Stop",
    );
    expect(cleanup).toContain("Get-NetFirewallRule -ErrorAction Stop");
    expect(cleanup).toContain('$_.Name -like "$rulePrefix*"');
    expect(cleanup).toContain(
      "Set-NetFirewallProfile -Name $profile.Name -Enabled $profile.Enabled -ErrorAction Stop",
    );
    expect(cleanup).not.toContain("[bool]$profile.Enabled");
    expect(cleanup).toContain(
      "@(Get-NetFirewallProfile -Name $profile.Name -ErrorAction Stop)",
    );
    expect(cleanup).toContain(
      "$restoredProfiles[0].Enabled.ToString() -cne $profile.Enabled.ToString()",
    );
    expect(cleanup).toContain(
      "Remove-Item -LiteralPath $stopSentinel -Force -ErrorAction Stop",
    );
    expect(cleanup).toContain(
      "Test-Path -LiteralPath $stopSentinel -ErrorAction Stop",
    );

    for (const label of [
      "network-monitor-stop-signal",
      "network-monitor-cleanup",
      "firewall-rule-remove",
      "firewall-rule-verify",
      "firewall-profile-restore",
      "firewall-profile-verify",
      "network-monitor-sentinel-remove",
      "network-monitor-sentinel-verify",
    ]) {
      expect(cleanup).toContain(`$cleanupFailures.Add('${label}')`);
    }
    expect(cleanup).toContain(
      "$cleanupFailureLabels = @($cleanupFailures | Sort-Object -Unique)",
    );
    expect(cleanup.match(/\bthrow\b/g)).toHaveLength(1);
    const cleanupThrow = cleanup.indexOf(
      "throw \"Offline desktop cleanup failed: $($cleanupFailureLabels -join ', ').\"",
    );
    expect(cleanupThrow).toBeGreaterThan(
      cleanup.lastIndexOf(
        "Test-Path -LiteralPath $stopSentinel -ErrorAction Stop",
      ),
    );

    expect(desktopE2eSource).toContain("$testExitCode = $LASTEXITCODE");
    expect(desktopE2eSource).toContain(
      "if ($testExitCode -ne 0) { exit $testExitCode }",
    );
  });
});
