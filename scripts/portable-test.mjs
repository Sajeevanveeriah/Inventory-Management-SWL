#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIGURATION = join('src-tauri', 'tauri.local-test.conf.json');
const TARGET_DIRECTORY = resolve(REPOSITORY_ROOT, 'src-tauri', 'target', 'local-test');
const TEST_EXECUTABLE = join(TARGET_DIRECTORY, 'release', 'swl-pricing-desktop.exe');
const PRODUCTION_EXECUTABLE = resolve(
  REPOSITORY_ROOT,
  'src-tauri',
  'target',
  'release',
  'swl-pricing-desktop.exe',
);
const TAURI_CLI = resolve(REPOSITORY_ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const FORBIDDEN_ENVIRONMENT_KEYS = [
  'SERPAPI_KEY',
  'SWL_HTTP_FEED_BEARER_TOKEN',
  'SWL_PAID_CALLS_ENABLED',
  'SWL_PROVIDER_COST_CEILING_CENTS',
  'SWL_PROVIDER_COST_PER_CALL_CENTS',
  'SWL_SEARCH_PROVIDER',
  'SWL_DESKTOP_ACCEPTANCE_FIXTURES',
  'SWL_DESKTOP_LOCAL_TEST_PROFILE',
];
const LOCAL_TEST_CREDENTIAL_TARGET =
  'au.com.stanwoottonlocksmiths.swl-pricing.local-test/provider/serpapi';
const PORTABLE_READY_TITLE = 'SWL Pricing and Inventory Control';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertPrerequisites() {
  const expectedNode = readFileSync(join(REPOSITORY_ROOT, '.nvmrc'), 'utf8').trim();
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const supportedLocalRuntime =
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) || major === 24;
  if (!supportedLocalRuntime) {
    throw new Error(
      `Node.js ${expectedNode} or the supported Node 24 LTS runtime is required; this terminal is using ${process.versions.node}.`,
    );
  }
  if (process.versions.node !== expectedNode) {
    console.warn(
      `Local-test compatibility mode: using Node.js ${process.versions.node}; release verification still uses ${expectedNode}.`,
    );
  }
  if (!existsSync(TAURI_CLI)) {
    throw new Error(
      'Locked development dependencies are missing. Run npm ci once before building the portable tester; this launcher never installs dependencies.',
    );
  }
  const configuration = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, CONFIGURATION), 'utf8'));
  if (
    configuration.identifier !== 'au.com.stanwoottonlocksmiths.swl-pricing.local-test' ||
    configuration.bundle?.active !== false
  ) {
    throw new Error('The portable tester is not confined to its reviewed local-test identity.');
  }
}

function scrubbedEnvironment() {
  const environment = { ...process.env };
  for (const key of FORBIDDEN_ENVIRONMENT_KEYS) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (key.startsWith('VITE_')) delete environment[key];
  }
  delete environment.NODE_OPTIONS;
  return environment;
}

function buildEnvironment() {
  const environment = scrubbedEnvironment();
  environment.CARGO_TARGET_DIR = TARGET_DIRECTORY;
  environment.CARGO_NET_OFFLINE = 'true';
  environment.SWL_DESKTOP_LOCAL_TEST_PROFILE = '1';
  environment.SWL_LOCAL_TEST = '1';
  environment.VITE_BASE = '/';
  environment.VITE_STATIC_DEMO = 'false';
  return environment;
}

function buildPortableTester() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [TAURI_CLI, 'build', '--no-bundle', '--config', CONFIGURATION, '--', '--frozen'],
      {
        cwd: REPOSITORY_ROOT,
        env: buildEnvironment(),
        stdio: 'inherit',
        windowsHide: true,
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        reject(
          new Error(
            `The portable desktop tester build failed${signal ? ` after ${signal}` : ` with exit code ${code ?? 'unknown'}`}.`,
          ),
        );
      }
    });
  });
}

function verifyExecutable() {
  if (!existsSync(TEST_EXECUTABLE)) {
    throw new Error('The portable desktop tester executable was not created.');
  }
  const metadata = lstatSync(TEST_EXECUTABLE);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    throw new Error('The portable desktop tester is not a non-empty regular file.');
  }
  if (realpathSync(TEST_EXECUTABLE) !== resolve(TEST_EXECUTABLE)) {
    throw new Error('The portable desktop tester resolved outside its reviewed output path.');
  }
  return {
    path: TEST_EXECUTABLE,
    bytes: statSync(TEST_EXECUTABLE).size,
    sha256: sha256(TEST_EXECUTABLE),
    applicationIdentifier: 'au.com.stanwoottonlocksmiths.swl-pricing.local-test',
    credentialTarget: LOCAL_TEST_CREDENTIAL_TARGET,
    fixtureMode: false,
    liveProviderCapable: true,
    paidCallsEnabledByDefault: false,
    credentialsLoadedFromEnvironment: false,
    bundledInstaller: false,
  };
}

function waitForNativeWindow(processId) {
  const environment = scrubbedEnvironment();
  environment.SWL_PORTABLE_PROCESS_ID = String(processId);
  environment.SWL_PORTABLE_READY_TITLE = PORTABLE_READY_TITLE;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$deadline=(Get-Date).AddSeconds(60); do { $process=Get-Process -Id ([int]$env:SWL_PORTABLE_PROCESS_ID) -ErrorAction SilentlyContinue; if($null -eq $process){exit 2}; $process.Refresh(); if($process.MainWindowHandle -ne 0 -and $process.MainWindowTitle -eq $env:SWL_PORTABLE_READY_TITLE){exit 0}; Start-Sleep -Milliseconds 250 } while((Get-Date) -lt $deadline); exit 3',
    ],
    { env: environment, stdio: 'ignore', timeout: 65_000, windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `The portable desktop tester did not reach its native readiness title (status ${result.status ?? 'unknown'}).`,
    );
  }
}

function stopLaunchedTester(processId) {
  const terminated = spawnSync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const environment = scrubbedEnvironment();
  environment.SWL_PORTABLE_PROCESS_ID = String(processId);
  const verified = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'if(Get-Process -Id ([int]$env:SWL_PORTABLE_PROCESS_ID) -ErrorAction SilentlyContinue){exit 1}; exit 0',
    ],
    { env: environment, stdio: 'ignore', timeout: 5_000, windowsHide: true },
  );
  if (terminated.error || verified.error || verified.status !== 0) {
    throw new Error('The failed portable tester could not be confirmed stopped.');
  }
}

function launchTester() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(TEST_EXECUTABLE, [], {
      cwd: REPOSITORY_ROOT,
      detached: true,
      env: scrubbedEnvironment(),
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', (error) => {
      reject(error);
    });
    child.once('spawn', () => {
      const processId = child.pid;
      try {
        waitForNativeWindow(processId);
        child.unref();
        resolvePromise({
          launched: true,
          processId,
          nativeWindowReady: true,
          windowTitle: PORTABLE_READY_TITLE,
        });
      } catch (error) {
        try {
          stopLaunchedTester(processId);
          reject(error);
        } catch (cleanupError) {
          reject(
            new AggregateError(
              [error, cleanupError],
              'The portable tester failed readiness and cleanup could not be confirmed.',
            ),
          );
        }
      }
    });
  });
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('The current portable tester target is Windows x64 only.');
  }
  assertPrerequisites();
  const productionHashBefore = existsSync(PRODUCTION_EXECUTABLE)
    ? sha256(PRODUCTION_EXECUTABLE)
    : null;
  console.log(
    'Building an unbundled local-test executable without loading repository environment files...',
  );
  await buildPortableTester();
  const productionHashAfter = existsSync(PRODUCTION_EXECUTABLE)
    ? sha256(PRODUCTION_EXECUTABLE)
    : null;
  if (productionHashAfter !== productionHashBefore) {
    throw new Error(
      'The isolated portable-test build changed the canonical production executable.',
    );
  }
  const evidence = verifyExecutable();
  const launchEvidence = process.argv.includes('--build-only')
    ? { launched: false, processId: null, nativeWindowReady: false, windowTitle: null }
    : await launchTester();
  const readyEvidence = { ...evidence, ...launchEvidence };
  console.log('');
  console.log(
    launchEvidence.nativeWindowReady ? 'SWL PORTABLE TESTER READY' : 'SWL PORTABLE TESTER BUILT',
  );
  console.log(`Executable: ${evidence.path}`);
  console.log(`SHA-256: ${evidence.sha256}`);
  console.log(
    'Profile: isolated local-test application data and credential target; production desktop data and credentials are untouched.',
  );
  console.log(
    'Provider: live-capable, but no credential is loaded from the environment and paid calls remain disabled until explicitly configured, validated, budgeted and enabled in the tester.',
  );
  console.log('Boundary: this is an unsigned local test executable, not the NSIS release package.');
  const evidenceMarker = launchEvidence.nativeWindowReady
    ? 'PORTABLE_TEST_READY'
    : 'PORTABLE_TEST_BUILT';
  console.log(`${evidenceMarker} ${JSON.stringify(readyEvidence)}`);
}

main().catch((error) => {
  console.error(
    `Portable test platform failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
