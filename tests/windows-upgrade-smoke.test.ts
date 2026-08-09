// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(
  join(repositoryRoot, "scripts", "windows-upgrade-smoke.ps1"),
  "utf8",
);

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
});
