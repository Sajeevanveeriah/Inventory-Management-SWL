import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runLauncher(autoStopMilliseconds = 100) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        'scripts/local-test-platform.mjs',
        '--no-build',
        '--no-open',
        '--auto-stop-ms',
        String(autoStopMilliseconds),
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          SERPAPI_KEY: 'fixture-secret-must-not-be-forwarded',
          SWL_HTTP_FEED_BEARER_TOKEN: 'fixture-token-must-not-be-forwarded',
          SWL_PAID_CALLS_ENABLED: 'true',
          SWL_PROVIDER_COST_CEILING_CENTS: '999999',
          SWL_PROVIDER_COST_PER_CALL_CENTS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function readySummary(stdout: string) {
  const marker = stdout.split(/\r?\n/u).find((line) => line.startsWith('LOCAL_TEST_READY '));
  expect(marker).toBeDefined();
  return JSON.parse(marker!.slice('LOCAL_TEST_READY '.length));
}

describe('no-install local testing platform', () => {
  it('starts an isolated fixture-only server and removes its temporary store', async () => {
    const result = await runLauncher();
    expect(result.code, result.stderr).toBe(0);
    const summary = readySummary(result.stdout);
    expect(summary).toMatchObject({
      provider: 'fixture',
      fixtureMode: true,
      paidCallsEnabled: false,
      repositoryEnvironmentFilesLoaded: false,
      forwardedSensitiveKeys: [],
    });
    expect(summary.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(summary.liveDataDirectory).toContain(summary.dataDirectory);
    expect(summary.seedDataDirectory).toContain(summary.dataDirectory);
    expect(existsSync(summary.dataDirectory)).toBe(false);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      'fixture-secret-must-not-be-forwarded',
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      'fixture-token-must-not-be-forwarded',
    );
  }, 30_000);

  it('keeps simultaneous browser testers on distinct ports and disposable stores', async () => {
    const [first, second] = await Promise.all([runLauncher(300), runLauncher(300)]);
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    const firstSummary = readySummary(first.stdout);
    const secondSummary = readySummary(second.stdout);
    expect(firstSummary.url).not.toBe(secondSummary.url);
    expect(firstSummary.dataDirectory).not.toBe(secondSummary.dataDirectory);
    expect(existsSync(firstSummary.dataDirectory)).toBe(false);
    expect(existsSync(secondSummary.dataDirectory)).toBe(false);
  }, 30_000);

  it('keeps the portable tester separate from production identity and bundling', () => {
    const configuration = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'src-tauri', 'tauri.local-test.conf.json'), 'utf8'),
    );
    expect(configuration.identifier).toBe('au.com.stanwoottonlocksmiths.swl-pricing.local-test');
    expect(configuration.identifier).not.toBe('au.com.stanwoottonlocksmiths.swl-pricing');
    expect(configuration.bundle.active).toBe(false);

    const source = readFileSync(path.join(repositoryRoot, 'scripts', 'portable-test.mjs'), 'utf8');
    expect(source).toContain("'--no-bundle'");
    expect(source).toContain("'--frozen'");
    expect(source).toContain("environment.CARGO_NET_OFFLINE = 'true'");
    expect(source).toContain("environment.SWL_LOCAL_TEST = '1'");
    expect(source).toContain("environment.SWL_DESKTOP_LOCAL_TEST_PROFILE = '1'");
    expect(source).not.toContain("environment.SWL_DESKTOP_ACCEPTANCE_FIXTURES = '1'");
    expect(source).toContain('fixtureMode: false');
    expect(source).toContain('liveProviderCapable: true');
    expect(source).toContain('paidCallsEnabledByDefault: false');
    expect(source).toContain('credentialsLoadedFromEnvironment: false');
    expect(source).toContain("? 'PORTABLE_TEST_READY'");
    expect(source).toContain(": 'PORTABLE_TEST_BUILT'");
    expect(source).toContain("const PORTABLE_READY_TITLE = 'SWL Pricing and Inventory Control'");
    expect(source).toContain('waitForNativeWindow(processId)');
    expect(source).toContain("['/PID', String(processId), '/T', '/F']");
    expect(source).toContain('The failed portable tester could not be confirmed stopped.');
    expect(source).not.toContain('--bundles');

    const backend = readFileSync(
      path.join(repositoryRoot, 'src-tauri', 'src', 'backend.rs'),
      'utf8',
    );
    expect(backend).toContain(
      'au.com.stanwoottonlocksmiths.swl-pricing.local-test/provider/serpapi',
    );
    expect(backend).toContain('credential_target_for_build_settings(');
    expect(backend).toContain('LOCAL_TEST_PROFILE_BUILD_SETTING');
  });

  it('never installs dependencies or loads environment files from either launcher', () => {
    for (const file of [
      'scripts/local-test-platform.mjs',
      'scripts/portable-test.mjs',
      'scripts/run-local-e2e.mjs',
      'test-swl-locally.cmd',
      'test-swl-portable.cmd',
    ]) {
      const source = readFileSync(path.join(repositoryRoot, file), 'utf8');
      expect(source).not.toMatch(/\bcall\s+npm(?:\.cmd)?\s+(?:ci|install)\b/iu);
      expect(source).not.toContain("['ci']");
      expect(source).not.toContain("['install']");
      expect(source).not.toContain('--env-file');
    }
    for (const file of [
      'scripts/local-test-platform.mjs',
      'scripts/portable-test.mjs',
      'scripts/run-local-e2e.mjs',
    ]) {
      const source = readFileSync(path.join(repositoryRoot, file), 'utf8');
      expect(source).toContain("key.startsWith('VITE_')");
      expect(source).toContain("environment.VITE_STATIC_DEMO = 'false'");
      expect(source).toContain("environment.VITE_BASE = '/'");
    }
  });

  it('lets the local E2E runner own readiness and cleanup instead of Playwright webServer', () => {
    const configuration = readFileSync(
      path.join(repositoryRoot, 'playwright.local.config.ts'),
      'utf8',
    );
    expect(configuration).toContain('process.env.SWL_LOCAL_TEST_URL');
    expect(configuration).not.toContain('webServer:');

    const runner = readFileSync(path.join(repositoryRoot, 'scripts', 'run-local-e2e.mjs'), 'utf8');
    expect(runner).toContain("'scripts/local-test-platform.mjs', '--no-open'");
    expect(runner).toContain("stdio: ['ignore', 'pipe', 'pipe', 'ipc']");
    expect(runner).toContain("await stopOwnedProcess(launcher, 'Local fixture launcher', true)");
    expect(runner).not.toContain('process.env.LOCALAPPDATA');
    expect(runner).toContain('process.env.CHROMIUM_PATH');
    expect(runner).toContain('SWL_LOCAL_TEST_LIVE_DATA_DIR: liveDataDirectory');
    expect(runner).toContain('SWL_LOCAL_TEST_SEED_DATA_DIR: seedDataDirectory');
    expect(runner).toContain('Get-AuthenticodeSignature');
    expect(runner).toContain("['/PID', String(child.pid), '/T', '/F']");
  });
});
