// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readSource(...segments: string[]) {
  const sourcePath = join(repositoryRoot, ...segments);
  return existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8').replace(/\r\n?/g, '\n') : '';
}

const preparation = readSource('scripts', 'prepare-edge-webdriver.ps1');
const workflow = readSource('.github', 'workflows', 'windows-desktop.yml');
const desktopRunner = readSource('scripts', 'run-windows-desktop-e2e.ps1');
const localBrowserRunner = readSource('scripts', 'run-local-e2e.mjs');
const wdio = readSource('wdio.conf.ts');
const tauriServicePatch = readSource('scripts', 'patch-tauri-service-edge-driver-label.mjs');
const supportedDriverBanner =
  /^Microsoft Edge WebDriver (?<version>\d+(?:\.\d+){3}) \([0-9a-f]{40}\)$/;
const supportedDriverBannerSource =
  "'^Microsoft Edge WebDriver (?<version>\\d+(?:\\.\\d+){3}) \\([0-9a-f]{40}\\)$'";

describe('locked Tauri service EdgeDriver compatibility', () => {
  it('revalidates the workflow-selected Edge path in the bounded local runner', () => {
    expect(workflow).toContain('"CHROMIUM_PATH=$edgePath"');
    expect(workflow).toContain('"SWL_VERIFIED_BROWSER_SHA256=$edgeSha256"');
    expect(localBrowserRunner).toContain('process.env.CHROMIUM_PATH');
    expect(localBrowserRunner).toContain('process.env.SWL_VERIFIED_BROWSER_SHA256');
    expect(localBrowserRunner).toContain("createHash('sha256')");
    expect(localBrowserRunner).toContain('/^[0-9a-f]{64}$/u');
    expect(localBrowserRunner).toContain('Get-AuthenticodeSignature');
    expect(localBrowserRunner).toContain("ProductName -notlike '*Microsoft Edge*'");
    expect(localBrowserRunner).toContain('const resolved = realpathSync(selected)');
    expect(localBrowserRunner).toContain('metadata.isSymbolicLink()');
  });

  it('patches only reviewed 1.3.0 dependency bytes after npm ci', () => {
    expect(tauriServicePatch).toContain('packageMetadata.version !== "1.3.0"');
    expect(tauriServicePatch).toContain(
      '9f40744cff59af6adfc7d324064de1493aafaa32e88827e1dec5e8f11439b593',
    );
    expect(tauriServicePatch).toContain(
      '34c47d9b676c0f73870889c49f8ccc612591f42b9a221c9ec305497ac94bfe10',
    );
    expect(tauriServicePatch).toContain(
      '27ff45e1807cd8be99a9b8410b903be036e4aba0d76afb03fa6d97ea4ca9a1ff',
    );
    expect(tauriServicePatch).toContain(
      'e5cf999920b1eb105e84593c784f177b01dbcdb09a4f354eb1c2a6da9db11be6',
    );
    expect(tauriServicePatch).toContain('versionOutput.trim().match(/^Microsoft Edge WebDriver');
    expect(workflow.indexOf('npm ci')).toBeLessThan(
      workflow.indexOf('node scripts/patch-tauri-service-edge-driver-label.mjs'),
    );
    expect(wdio).toContain('autoDownloadEdgeDriver: false');
  });
});

describe('exact WebView2 EdgeDriver preparation', () => {
  it('downloads only the exact installed signed WebView2 version through a bounded Microsoft route', () => {
    expect(preparation).not.toBe('');
    expect(preparation).toContain('{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}');
    expect(preparation).toContain("'^\\d+(?:\\.\\d+){3}$'");
    expect(preparation).toContain("$runtimeSignature.Status -ne 'Valid'");
    expect(preparation).toContain(
      'https://msedgedriver.microsoft.com/$runtimeVersion/edgedriver_win64.zip',
    );
    expect(preparation).toContain("$allowedHosts = @('msedgedriver.microsoft.com')");
    expect(preparation).toContain('$handler.AllowAutoRedirect = $false');
    expect(preparation).toContain('for ($attempt = 0; $attempt -lt 6; $attempt += 1)');
    expect(preparation).not.toMatch(/LATEST_(?:RELEASE|STABLE)/);
    expect(preparation).toContain("$driverDirectory -ine (Join-Path $runnerTemp 'swl-edgedriver')");
  });

  it('extracts one bounded x64 Microsoft executable and verifies all version surfaces', () => {
    expect(preparation).toContain('[IO.Compression.ZipFile]::OpenRead($archivePath)');
    expect(preparation).toContain('$archive.Entries.Count -gt 64');
    expect(preparation).toContain('$aggregateUncompressedBytes += $entry.Length');
    expect(preparation).toContain('$aggregateUncompressedBytes -gt 200MB');
    expect(preparation).toContain('$unixFileType -eq 0xA000');
    expect(preparation).toContain(
      '$entry.ExternalAttributes -band [int][IO.FileAttributes]::ReparsePoint',
    );
    expect(preparation).toContain('$normalisedEntryName -match');
    expect(preparation).toContain("[IO.Path]::GetExtension($_.FullName) -ieq '.exe'");
    expect(preparation).toContain(
      "$driverEntries.Count -ne 1 -or $driverEntries[0].FullName -cne 'msedgedriver.exe'",
    );
    expect(preparation).toContain('$driverEntry.Length -lt 5MB');
    expect(preparation).toContain('$copiedDriverBytes += $driverRead');
    expect(preparation).toContain('$copiedDriverBytes -ne $driverEntry.Length');
    expect(preparation).toContain('$driverMachine -ne 0x8664');
    expect(preparation).toContain("$driverSignature.Status -ne 'Valid'");
    expect(preparation).toContain('$driverInfo.VersionInfo.FileVersion -cne $runtimeVersion');
    expect(preparation).toContain('$driverInfo.VersionInfo.ProductVersion -cne $runtimeVersion');
    expect(preparation).toContain('$driverVersion -cne $runtimeVersion');
    expect(preparation).toContain('$driverProcess.WaitForExit(10000)');
    expect(preparation).toContain('$driverOutputBytes -gt 8192');
    expect(preparation).toContain(supportedDriverBannerSource);
    expect(desktopRunner).toContain(supportedDriverBannerSource);
    expect(preparation).toContain("verification = 'exact-installed-webview2-driver'");
    expect(preparation).toContain('archiveSha256 = $archiveHash');
    expect(preparation).toContain('downloadCompletedBeforeOfflineBoundary = $true');
    expect(preparation).toContain('automaticDownloadDisabled = $true');
    expect(preparation).toContain(
      'Remove-Item -LiteralPath $driverDirectory -Recurse -Force -ErrorAction Stop',
    );
    expect(preparation).toContain('if (Test-Path -LiteralPath $driverDirectory) {');
    expect(preparation).not.toContain(
      'Remove-Item -LiteralPath $driverDirectory -Recurse -Force -ErrorAction SilentlyContinue',
    );
    expect(preparation).toContain('$preparationFailure = $_');
    expect(preparation).toContain('throw $preparationFailure');
    expect(preparation).toContain(
      'Exact EdgeDriver preparation failed and its task-created directory could not be removed.',
    );
  });

  it('accepts only the exact Microsoft product and revision banner', () => {
    expect(
      'Microsoft Edge WebDriver 150.0.4078.105 (a88426f15a576daa13d1ba28f3c8b24228186d7f)'.match(
        supportedDriverBanner,
      )?.groups?.version,
    ).toBe('150.0.4078.105');

    for (const rejected of [
      'MSEdgeDriver 150.0.4078.105 (a88426f15a576daa13d1ba28f3c8b24228186d7f)',
      'ChromeDriver 150.0.4078.105',
      'microsoft edge webdriver 150.0.4078.105',
      'Microsoft Edge WebDriver 150.0.4078',
      'Microsoft Edge WebDriver 150.0.4078.105',
      'Microsoft Edge WebDriver 150.0.4078.105 (A88426F15A576DAA13D1BA28F3C8B24228186D7F)',
      'Microsoft Edge WebDriver 150.0.4078.105 (a88426f15a576daa13d1ba28f3c8b24228186d7)',
      'Microsoft Edge WebDriver 150.0.4078.105 (not-a-revision)',
      'Microsoft Edge WebDriver 150.0.4078.105 (a88426f15a576daa13d1ba28f3c8b24228186d7f)\nextra',
      'prefix Microsoft Edge WebDriver 150.0.4078.105',
    ]) {
      expect(supportedDriverBanner.test(rejected)).toBe(false);
    }
  });
});

describe('isolated release-profile desktop acceptance binary', () => {
  it('enables DevTools only in a temporary unbundled target and preserves production bytes', () => {
    expect(workflow).toContain(
      'Build isolated unbundled release-profile desktop acceptance binary',
    );
    expect(workflow).toContain('$env:CARGO_TARGET_DIR = $acceptanceTarget');
    expect(workflow).toContain('--features tauri/devtools');
    expect(workflow).toContain('$productionHashAfter -cne $productionHashBefore');
    expect(workflow).toContain('distributed = $false');
    expect(workflow).toContain('-ApplicationPath $env:SWL_DESKTOP_ACCEPTANCE_BINARY');
    expect(workflow).not.toContain('-ApplicationPath $env:SWL_DESKTOP_BINARY');
    expect(desktopRunner).toContain('Exact unbundled release-profile acceptance application');
    const resolvedApplication = desktopRunner.indexOf(
      '$application = (Resolve-Path -LiteralPath $ApplicationPath).Path',
    );
    const wdioApplication = desktopRunner.indexOf('$env:SWL_DESKTOP_BINARY = $application');
    const desktopTest = desktopRunner.indexOf('& npm run e2e:desktop');
    expect(resolvedApplication).toBeGreaterThan(-1);
    expect(wdioApplication).toBeGreaterThan(resolvedApplication);
    expect(desktopTest).toBeGreaterThan(wdioApplication);
    expect(desktopRunner).not.toContain('$env:SWL_DESKTOP_BINARY = $ApplicationPath');
  });
});

describe('production WDIO driver boundary', () => {
  it('prepares the driver after upgrade and passes its exact path without a global PATH append', () => {
    const upgradeIndex = workflow.indexOf(
      '- name: Prove genuine 1.0.0 to 1.2.0 migration, backup and preservation',
    );
    const prepareIndex = workflow.indexOf(
      '- name: Prepare exact EdgeDriver for the installed WebView2 runtime',
    );
    const driveIndex = workflow.indexOf(
      '- name: Drive the isolated release-profile desktop acceptance binary with outbound networking denied',
    );

    expect(prepareIndex).toBeGreaterThan(upgradeIndex);
    expect(driveIndex).toBeGreaterThan(prepareIndex);
    expect(workflow).toContain(
      './scripts/prepare-edge-webdriver.ps1 -DriverPath "$edgeDriverPath" -EvidencePath "$env:RUNNER_TEMP/swl-diagnostics/Microsoft-EdgeDriver-Evidence.json"',
    );
    expect(workflow).toContain(
      '"EDGEWEBDRIVER=$edgeDriverPath" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append',
    );
    expect(workflow).toContain('-EdgeDriverPath $env:EDGEWEBDRIVER');
    expect(workflow).not.toContain(
      '[IO.Path]::GetDirectoryName($driverPath) | Out-File -FilePath $env:GITHUB_PATH',
    );
    expect(wdio).toContain('autoDownloadEdgeDriver: false');
  });

  it('makes one validated driver visible process-locally and blocks its Internet access', () => {
    expect(desktopRunner).toContain('[Parameter(Mandatory = $true)][string]$EdgeDriverPath');
    expect(desktopRunner).toContain(
      "Test-Path -LiteralPath (Join-Path $expandedEntry 'msedgedriver.exe') -PathType Leaf",
    );
    expect(desktopRunner).toContain(
      '$env:PATH = (@($edgeDriverDirectory) + @($retainedPathEntries)) -join [IO.Path]::PathSeparator',
    );
    expect(desktopRunner).toContain('& $whereExecutable msedgedriver.exe');
    expect(desktopRunner).toContain('$resolvedEdgeDrivers.Count -ne 1');
    expect(desktopRunner).toContain('$resolvedEdgeDriverPath -ine $edgeDriver.FullName');
    expect(desktopRunner).toContain(
      '$edgeDriverVersion -cne $edgeDriver.VersionInfo.ProductVersion',
    );
    expect(desktopRunner).toContain(
      "Add-OfflineRule -Program $edgeDriver.FullName -Label 'edge-webdriver'",
    );
    expect(desktopRunner).toContain('$activeWebViewCount += 1');
    expect(desktopRunner).toContain('if ($activeWebViewCount -ne 1)');
    expect(desktopRunner).toContain('$activeWebViewVersions[0] -cne $edgeDriverVersion');
    expect(desktopRunner).toContain("$profile.Enabled.ToString() -cne 'True'");

    const offlineRule = desktopRunner.match(/function Add-OfflineRule \{[\s\S]*?\n\}/)?.[0];
    expect(offlineRule).toBeDefined();
    const trackedRuleIndex = offlineRule?.indexOf('$ruleNames.Add($ruleName)') ?? -1;
    const validatedRuleIndex = offlineRule?.indexOf('Get-NetFirewallRule -Name $ruleName') ?? -1;
    expect(trackedRuleIndex).toBeGreaterThan(-1);
    expect(validatedRuleIndex).toBeGreaterThan(-1);
    expect(trackedRuleIndex).toBeLessThan(validatedRuleIndex);
  });
});
