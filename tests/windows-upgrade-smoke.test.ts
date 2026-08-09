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
});
