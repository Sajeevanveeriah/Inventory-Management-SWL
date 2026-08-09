// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readSource(...segments: string[]) {
  const sourcePath = join(repositoryRoot, ...segments);
  return existsSync(sourcePath)
    ? readFileSync(sourcePath, "utf8").replace(/\r\n?/g, "\n")
    : "";
}

const preparation = readSource("scripts", "prepare-edge-webdriver.ps1");
const workflow = readSource(".github", "workflows", "windows-desktop.yml");
const desktopRunner = readSource("scripts", "run-windows-desktop-e2e.ps1");
const wdio = readSource("wdio.conf.ts");

describe("exact WebView2 EdgeDriver preparation", () => {
  it("downloads only the exact installed signed WebView2 version through a bounded Microsoft route", () => {
    expect(preparation).not.toBe("");
    expect(preparation).toContain("{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}");
    expect(preparation).toContain("'^\\d+(?:\\.\\d+){3}$'");
    expect(preparation).toContain("$runtimeSignature.Status -ne 'Valid'");
    expect(preparation).toContain(
      "https://msedgedriver.microsoft.com/$runtimeVersion/edgedriver_win64.zip",
    );
    expect(preparation).toContain(
      "$allowedHosts = @('msedgedriver.microsoft.com')",
    );
    expect(preparation).toContain("$handler.AllowAutoRedirect = $false");
    expect(preparation).toContain(
      "for ($attempt = 0; $attempt -lt 6; $attempt += 1)",
    );
    expect(preparation).not.toMatch(/LATEST_(?:RELEASE|STABLE)/);
    expect(preparation).toContain(
      "$driverDirectory -ine (Join-Path $runnerTemp 'swl-edgedriver')",
    );
  });

  it("extracts one bounded x64 Microsoft executable and verifies all version surfaces", () => {
    expect(preparation).toContain(
      "[IO.Compression.ZipFile]::OpenRead($archivePath)",
    );
    expect(preparation).toContain("$archive.Entries.Count -gt 64");
    expect(preparation).toContain(
      "$aggregateUncompressedBytes += $entry.Length",
    );
    expect(preparation).toContain("$aggregateUncompressedBytes -gt 200MB");
    expect(preparation).toContain("$unixFileType -eq 0xA000");
    expect(preparation).toContain(
      "$entry.ExternalAttributes -band [int][IO.FileAttributes]::ReparsePoint",
    );
    expect(preparation).toContain("$normalisedEntryName -match");
    expect(preparation).toContain(
      "[IO.Path]::GetExtension($_.FullName) -ieq '.exe'",
    );
    expect(preparation).toContain(
      "$driverEntries.Count -ne 1 -or $driverEntries[0].FullName -cne 'msedgedriver.exe'",
    );
    expect(preparation).toContain("$driverEntry.Length -lt 5MB");
    expect(preparation).toContain("$copiedDriverBytes += $driverRead");
    expect(preparation).toContain("$copiedDriverBytes -ne $driverEntry.Length");
    expect(preparation).toContain("$driverMachine -ne 0x8664");
    expect(preparation).toContain("$driverSignature.Status -ne 'Valid'");
    expect(preparation).toContain(
      "$driverInfo.VersionInfo.FileVersion -cne $runtimeVersion",
    );
    expect(preparation).toContain(
      "$driverInfo.VersionInfo.ProductVersion -cne $runtimeVersion",
    );
    expect(preparation).toContain("$driverVersion -cne $runtimeVersion");
    expect(preparation).toContain("$driverProcess.WaitForExit(10000)");
    expect(preparation).toContain("$driverOutputBytes -gt 8192");
    expect(preparation).toContain(
      "'^(?:MSEdgeDriver|Microsoft Edge WebDriver) (?<version>\\d+(?:\\.\\d+){3})(?: .*)?
    expect(preparation).toContain(
      "verification = 'exact-installed-webview2-driver'",
    );
    expect(preparation).toContain("archiveSha256 = $archiveHash");
    expect(preparation).toContain(
      "downloadCompletedBeforeOfflineBoundary = $true",
    );
    expect(preparation).toContain("automaticDownloadDisabled = $true");
    expect(preparation).toContain(
      "Remove-Item -LiteralPath $driverDirectory -Recurse -Force -ErrorAction Stop",
    );
    expect(preparation).toContain(
      "if (Test-Path -LiteralPath $driverDirectory) {",
    );
    expect(preparation).not.toContain(
      "Remove-Item -LiteralPath $driverDirectory -Recurse -Force -ErrorAction SilentlyContinue",
    );
    expect(preparation).toContain("$preparationFailure = $_");
    expect(preparation).toContain("throw $preparationFailure");
    expect(preparation).toContain(
      "Exact EdgeDriver preparation failed and its task-created directory could not be removed.",
    );
  });
});

describe("production WDIO driver boundary", () => {
  it("prepares the driver after upgrade and passes its exact path without a global PATH append", () => {
    const upgradeIndex = workflow.indexOf(
      "- name: Prove genuine 1.0.0 to 1.1.0 migration, backup and preservation",
    );
    const prepareIndex = workflow.indexOf(
      "- name: Prepare exact EdgeDriver for the installed WebView2 runtime",
    );
    const driveIndex = workflow.indexOf(
      "- name: Drive the production desktop executable with outbound networking denied",
    );

    expect(prepareIndex).toBeGreaterThan(upgradeIndex);
    expect(driveIndex).toBeGreaterThan(prepareIndex);
    expect(workflow).toContain(
      './scripts/prepare-edge-webdriver.ps1 -DriverPath "$edgeDriverPath" -EvidencePath "$env:RUNNER_TEMP/swl-diagnostics/Microsoft-EdgeDriver-Evidence.json"',
    );
    expect(workflow).toContain(
      '"EDGEWEBDRIVER=$edgeDriverPath" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append',
    );
    expect(workflow).toContain("-EdgeDriverPath $env:EDGEWEBDRIVER");
    expect(workflow).not.toContain(
      "[IO.Path]::GetDirectoryName($driverPath) | Out-File -FilePath $env:GITHUB_PATH",
    );
    expect(wdio).toContain("autoDownloadEdgeDriver: false");
  });

  it("makes one validated driver visible process-locally and blocks its Internet access", () => {
    expect(desktopRunner).toContain(
      "[Parameter(Mandatory = $true)][string]$EdgeDriverPath",
    );
    expect(desktopRunner).toContain(
      "Test-Path -LiteralPath (Join-Path $expandedEntry 'msedgedriver.exe') -PathType Leaf",
    );
    expect(desktopRunner).toContain(
      "$env:PATH = (@($edgeDriverDirectory) + @($retainedPathEntries)) -join [IO.Path]::PathSeparator",
    );
    expect(desktopRunner).toContain("& $whereExecutable msedgedriver.exe");
    expect(desktopRunner).toContain("$resolvedEdgeDrivers.Count -ne 1");
    expect(desktopRunner).toContain(
      "$resolvedEdgeDriverPath -ine $edgeDriver.FullName",
    );
    expect(desktopRunner).toContain(
      "$edgeDriverVersion -cne $edgeDriver.VersionInfo.ProductVersion",
    );
    expect(desktopRunner).toContain(
      "Add-OfflineRule -Program $edgeDriver.FullName -Label 'edge-webdriver'",
    );
    expect(desktopRunner).toContain("$activeWebViewCount += 1");
    expect(desktopRunner).toContain("if ($activeWebViewCount -ne 1)");
    expect(desktopRunner).toContain(
      "$activeWebViewVersions[0] -cne $edgeDriverVersion",
    );
    expect(desktopRunner).toContain("$profile.Enabled.ToString() -cne 'True'");

    const offlineRule = desktopRunner.match(
      /function Add-OfflineRule \{[\s\S]*?\n\}/,
    )?.[0];
    expect(offlineRule).toBeDefined();
    const trackedRuleIndex =
      offlineRule?.indexOf("$ruleNames.Add($ruleName)") ?? -1;
    const validatedRuleIndex =
      offlineRule?.indexOf("Get-NetFirewallRule -Name $ruleName") ?? -1;
    expect(trackedRuleIndex).toBeGreaterThan(-1);
    expect(validatedRuleIndex).toBeGreaterThan(-1);
    expect(trackedRuleIndex).toBeLessThan(validatedRuleIndex);
  });
});
",
    );
    expect(preparation).not.toContain(
      "'^MSEdgeDriver (?<version>\\d+(?:\\.\\d+){3})(?: .*)?
    expect(preparation).toContain(
      "verification = 'exact-installed-webview2-driver'",
    );
    expect(preparation).toContain("archiveSha256 = $archiveHash");
    expect(preparation).toContain(
      "downloadCompletedBeforeOfflineBoundary = $true",
    );
    expect(preparation).toContain("automaticDownloadDisabled = $true");
    expect(preparation).toContain(
      "Remove-Item -LiteralPath $driverDirectory -Recurse -Force -ErrorAction Stop",
    );
    expect(preparation).toContain(
      "if (Test-Path -LiteralPath $driverDirectory) {",
    );
    expect(preparation).not.toContain(
      "Remove-Item -LiteralPath $driverDirectory -Recurse -Force -ErrorAction SilentlyContinue",
    );
    expect(preparation).toContain("$preparationFailure = $_");
    expect(preparation).toContain("throw $preparationFailure");
    expect(preparation).toContain(
      "Exact EdgeDriver preparation failed and its task-created directory could not be removed.",
    );
  });
});

describe("production WDIO driver boundary", () => {
  it("prepares the driver after upgrade and passes its exact path without a global PATH append", () => {
    const upgradeIndex = workflow.indexOf(
      "- name: Prove genuine 1.0.0 to 1.1.0 migration, backup and preservation",
    );
    const prepareIndex = workflow.indexOf(
      "- name: Prepare exact EdgeDriver for the installed WebView2 runtime",
    );
    const driveIndex = workflow.indexOf(
      "- name: Drive the production desktop executable with outbound networking denied",
    );

    expect(prepareIndex).toBeGreaterThan(upgradeIndex);
    expect(driveIndex).toBeGreaterThan(prepareIndex);
    expect(workflow).toContain(
      './scripts/prepare-edge-webdriver.ps1 -DriverPath "$edgeDriverPath" -EvidencePath "$env:RUNNER_TEMP/swl-diagnostics/Microsoft-EdgeDriver-Evidence.json"',
    );
    expect(workflow).toContain(
      '"EDGEWEBDRIVER=$edgeDriverPath" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append',
    );
    expect(workflow).toContain("-EdgeDriverPath $env:EDGEWEBDRIVER");
    expect(workflow).not.toContain(
      "[IO.Path]::GetDirectoryName($driverPath) | Out-File -FilePath $env:GITHUB_PATH",
    );
    expect(wdio).toContain("autoDownloadEdgeDriver: false");
  });

  it("makes one validated driver visible process-locally and blocks its Internet access", () => {
    expect(desktopRunner).toContain(
      "[Parameter(Mandatory = $true)][string]$EdgeDriverPath",
    );
    expect(desktopRunner).toContain(
      "Test-Path -LiteralPath (Join-Path $expandedEntry 'msedgedriver.exe') -PathType Leaf",
    );
    expect(desktopRunner).toContain(
      "$env:PATH = (@($edgeDriverDirectory) + @($retainedPathEntries)) -join [IO.Path]::PathSeparator",
    );
    expect(desktopRunner).toContain("& $whereExecutable msedgedriver.exe");
    expect(desktopRunner).toContain("$resolvedEdgeDrivers.Count -ne 1");
    expect(desktopRunner).toContain(
      "$resolvedEdgeDriverPath -ine $edgeDriver.FullName",
    );
    expect(desktopRunner).toContain(
      "$edgeDriverVersion -cne $edgeDriver.VersionInfo.ProductVersion",
    );
    expect(desktopRunner).toContain(
      "Add-OfflineRule -Program $edgeDriver.FullName -Label 'edge-webdriver'",
    );
    expect(desktopRunner).toContain("$activeWebViewCount += 1");
    expect(desktopRunner).toContain("if ($activeWebViewCount -ne 1)");
    expect(desktopRunner).toContain(
      "$activeWebViewVersions[0] -cne $edgeDriverVersion",
    );
    expect(desktopRunner).toContain("$profile.Enabled.ToString() -cne 'True'");

    const offlineRule = desktopRunner.match(
      /function Add-OfflineRule \{[\s\S]*?\n\}/,
    )?.[0];
    expect(offlineRule).toBeDefined();
    const trackedRuleIndex =
      offlineRule?.indexOf("$ruleNames.Add($ruleName)") ?? -1;
    const validatedRuleIndex =
      offlineRule?.indexOf("Get-NetFirewallRule -Name $ruleName") ?? -1;
    expect(trackedRuleIndex).toBeGreaterThan(-1);
    expect(validatedRuleIndex).toBeGreaterThan(-1);
    expect(trackedRuleIndex).toBeLessThan(validatedRuleIndex);
  });
});
",
    );
    expect(preparation).toContain(
      "verification = 'exact-installed-webview2-driver'",
    );
    expect(preparation).toContain("archiveSha256 = $archiveHash");
    expect(preparation).toContain(
      "downloadCompletedBeforeOfflineBoundary = $true",
    );
    expect(preparation).toContain("automaticDownloadDisabled = $true");
    expect(preparation).toContain(
      "Remove-Item -LiteralPath $driverDirectory -Recurse -Force -ErrorAction Stop",
    );
    expect(preparation).toContain(
      "if (Test-Path -LiteralPath $driverDirectory) {",
    );
    expect(preparation).not.toContain(
      "Remove-Item -LiteralPath $driverDirectory -Recurse -Force -ErrorAction SilentlyContinue",
    );
    expect(preparation).toContain("$preparationFailure = $_");
    expect(preparation).toContain("throw $preparationFailure");
    expect(preparation).toContain(
      "Exact EdgeDriver preparation failed and its task-created directory could not be removed.",
    );
  });
});

describe("production WDIO driver boundary", () => {
  it("prepares the driver after upgrade and passes its exact path without a global PATH append", () => {
    const upgradeIndex = workflow.indexOf(
      "- name: Prove genuine 1.0.0 to 1.1.0 migration, backup and preservation",
    );
    const prepareIndex = workflow.indexOf(
      "- name: Prepare exact EdgeDriver for the installed WebView2 runtime",
    );
    const driveIndex = workflow.indexOf(
      "- name: Drive the production desktop executable with outbound networking denied",
    );

    expect(prepareIndex).toBeGreaterThan(upgradeIndex);
    expect(driveIndex).toBeGreaterThan(prepareIndex);
    expect(workflow).toContain(
      './scripts/prepare-edge-webdriver.ps1 -DriverPath "$edgeDriverPath" -EvidencePath "$env:RUNNER_TEMP/swl-diagnostics/Microsoft-EdgeDriver-Evidence.json"',
    );
    expect(workflow).toContain(
      '"EDGEWEBDRIVER=$edgeDriverPath" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append',
    );
    expect(workflow).toContain("-EdgeDriverPath $env:EDGEWEBDRIVER");
    expect(workflow).not.toContain(
      "[IO.Path]::GetDirectoryName($driverPath) | Out-File -FilePath $env:GITHUB_PATH",
    );
    expect(wdio).toContain("autoDownloadEdgeDriver: false");
  });

  it("makes one validated driver visible process-locally and blocks its Internet access", () => {
    expect(desktopRunner).toContain(
      "[Parameter(Mandatory = $true)][string]$EdgeDriverPath",
    );
    expect(desktopRunner).toContain(
      "Test-Path -LiteralPath (Join-Path $expandedEntry 'msedgedriver.exe') -PathType Leaf",
    );
    expect(desktopRunner).toContain(
      "$env:PATH = (@($edgeDriverDirectory) + @($retainedPathEntries)) -join [IO.Path]::PathSeparator",
    );
    expect(desktopRunner).toContain("& $whereExecutable msedgedriver.exe");
    expect(desktopRunner).toContain("$resolvedEdgeDrivers.Count -ne 1");
    expect(desktopRunner).toContain(
      "$resolvedEdgeDriverPath -ine $edgeDriver.FullName",
    );
    expect(desktopRunner).toContain(
      "$edgeDriverVersion -cne $edgeDriver.VersionInfo.ProductVersion",
    );
    expect(desktopRunner).toContain(
      "Add-OfflineRule -Program $edgeDriver.FullName -Label 'edge-webdriver'",
    );
    expect(desktopRunner).toContain("$activeWebViewCount += 1");
    expect(desktopRunner).toContain("if ($activeWebViewCount -ne 1)");
    expect(desktopRunner).toContain(
      "$activeWebViewVersions[0] -cne $edgeDriverVersion",
    );
    expect(desktopRunner).toContain("$profile.Enabled.ToString() -cne 'True'");

    const offlineRule = desktopRunner.match(
      /function Add-OfflineRule \{[\s\S]*?\n\}/,
    )?.[0];
    expect(offlineRule).toBeDefined();
    const trackedRuleIndex =
      offlineRule?.indexOf("$ruleNames.Add($ruleName)") ?? -1;
    const validatedRuleIndex =
      offlineRule?.indexOf("Get-NetFirewallRule -Name $ruleName") ?? -1;
    expect(trackedRuleIndex).toBeGreaterThan(-1);
    expect(validatedRuleIndex).toBeGreaterThan(-1);
    expect(trackedRuleIndex).toBeLessThan(validatedRuleIndex);
  });
});
